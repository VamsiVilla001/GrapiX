//! Engine identity, state, and capability reporting.
//!
//! Requirement 9: report real hardware limits at connection time so the Editor
//! and Playout can warn the operator *before* publishing content the engine
//! cannot render.
//!
//! The distinction from protocol v2's capabilities, which were feature booleans:
//! these are numbers. "Supports tiling" does not tell you whether a 50,000-wide
//! stage will load; `max_logical_canvas_width` and `max_texture_dimension_2d` do.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::EngineConfig;
use crate::stage::EngineStageLimits;

pub const ENGINE_SOFTWARE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const ENGINE_PROTOCOL_VERSION: u32 = 3;
pub const SUPPORTED_SCENE_DOCUMENT_VERSIONS: &[u32] = &[1];
pub const SUPPORTED_STAGE_DOCUMENT_VERSIONS: &[u32] = &[1];

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// Generate a stable engine id.
///
/// Every engine needs a unique id for multi-engine routing, mirroring, and
/// failover, so it is generated once and persisted rather than being regenerated
/// on each start — a node that changes identity on restart cannot be a backup.
pub fn generate_engine_id() -> String {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        // Randomness failing is not a reason to refuse to start; a
        // process-unique-enough fallback keeps the engine usable and the operator
        // can pin an id in config.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes.copy_from_slice(&(nanos as u64).to_le_bytes());
    }

    let mut hex = String::with_capacity(16);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    format!("engine_{hex}")
}

/// Read a persisted engine id, or create and persist one.
pub fn resolve_engine_id(config: &EngineConfig, state_directory: &Path) -> String {
    if let Some(configured) = &config.identity.engine_id {
        if !configured.trim().is_empty() {
            return configured.trim().to_string();
        }
    }

    let path = state_directory.join("engine-id");
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let generated = generate_engine_id();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(&path, format!("{generated}\n")) {
        tracing::warn!(
            path = %path.display(),
            %error,
            "could not persist engine id; a restart will generate a new one, so this engine cannot act as a stable backup"
        );
    }
    generated
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

/// The eleven states from requirement 8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineState {
    Offline,
    Discovering,
    Connecting,
    Authenticating,
    Synchronising,
    Preparing,
    Ready,
    OnAir,
    Warning,
    Error,
    Recovering,
}

impl EngineState {
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineState::Offline => "offline",
            EngineState::Discovering => "discovering",
            EngineState::Connecting => "connecting",
            EngineState::Authenticating => "authenticating",
            EngineState::Synchronising => "synchronising",
            EngineState::Preparing => "preparing",
            EngineState::Ready => "ready",
            EngineState::OnAir => "on-air",
            EngineState::Warning => "warning",
            EngineState::Error => "error",
            EngineState::Recovering => "recovering",
        }
    }

    /// States in which the engine is usable for rendering.
    pub fn is_operational(&self) -> bool {
        matches!(
            self,
            EngineState::Ready | EngineState::OnAir | EngineState::Warning
        )
    }

    /// Whether a Take should be permitted. The Program safety gate.
    pub fn can_accept_take(&self) -> bool {
        self.is_operational()
    }

    /// Permitted transitions.
    ///
    /// `Recovering` is reachable from every state that owns GPU resources,
    /// including `OnAir`: a device loss does not wait for a convenient moment, and
    /// an engine that could not leave `OnAir` to recover would report itself
    /// healthy while rendering nothing.
    pub fn can_transition_to(&self, next: EngineState) -> bool {
        use EngineState::*;

        if *self == next {
            return true;
        }

        let allowed: &[EngineState] = match self {
            Offline => &[Discovering, Connecting, Error],
            Discovering => &[Connecting, Offline, Error],
            Connecting => &[Authenticating, Synchronising, Offline, Error],
            Authenticating => &[Synchronising, Offline, Error],
            Synchronising => &[Preparing, Ready, Offline, Error, Warning, Recovering],
            Preparing => &[Ready, Offline, Error, Warning, Recovering],
            Ready => &[
                OnAir,
                Synchronising,
                Preparing,
                Warning,
                Error,
                Recovering,
                Offline,
            ],
            OnAir => &[Ready, Warning, Error, Recovering, Offline],
            Warning => &[
                Ready,
                OnAir,
                Synchronising,
                Preparing,
                Recovering,
                Error,
                Offline,
            ],
            Error => &[Recovering, Offline, Connecting],
            Recovering => &[Connecting, Synchronising, Preparing, Ready, Error, Offline],
        };

        allowed.contains(&next)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChange {
    pub from: EngineState,
    pub to: EngineState,
    pub reason: String,
    pub at_ms: u64,
    pub rejected: bool,
}

/// Guarded state holder with a bounded history.
pub struct EngineStateMachine {
    current: EngineState,
    history: Vec<StateChange>,
    limit: usize,
}

impl EngineStateMachine {
    pub fn new(initial: EngineState) -> Self {
        Self {
            current: initial,
            history: Vec::new(),
            limit: 64,
        }
    }

    pub fn state(&self) -> EngineState {
        self.current
    }

    /// Attempt a transition. Refuses rather than panicking on an illegal one.
    pub fn transition(
        &mut self,
        next: EngineState,
        reason: impl Into<String>,
        at_ms: u64,
    ) -> StateChange {
        let allowed = self.current.can_transition_to(next);
        let change = StateChange {
            from: self.current,
            to: next,
            reason: reason.into(),
            at_ms,
            rejected: !allowed,
        };

        if allowed {
            self.current = next;
        } else {
            tracing::warn!(
                from = self.current.as_str(),
                to = next.as_str(),
                "refused an illegal engine state transition"
            );
        }

        self.push(change.clone());
        change
    }

    /// Force a state regardless of the table.
    ///
    /// For the one legitimate case: something external making the previous state
    /// untrue whatever the table says.
    pub fn force(
        &mut self,
        next: EngineState,
        reason: impl Into<String>,
        at_ms: u64,
    ) -> StateChange {
        let change = StateChange {
            from: self.current,
            to: next,
            reason: reason.into(),
            at_ms,
            rejected: false,
        };
        self.current = next;
        self.push(change.clone());
        change
    }

    pub fn recent_history(&self, limit: usize) -> Vec<StateChange> {
        let start = self.history.len().saturating_sub(limit.max(1));
        self.history[start..].to_vec()
    }

    fn push(&mut self, change: StateChange) {
        self.history.push(change);
        if self.history.len() > self.limit {
            self.history.remove(0);
        }
    }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub platform: String,
    pub release: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub model: String,
    pub logical_cores: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub adapter: String,
    pub backend: String,
    pub device_type: String,
    pub driver: String,
    pub driver_info: String,
    pub vendor_id: u32,
    pub device_id: u32,
    /// Best-effort VRAM estimate.
    ///
    /// wgpu does not expose VRAM portably, so this is the configured budget
    /// rather than a measurement. Zero means unknown, never "none".
    pub memory_bytes_estimate: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLimits {
    pub max_texture_dimension_2d: u32,
    pub max_texture_dimension_3d: u32,
    pub max_texture_array_layers: u32,
    pub max_buffer_size: u64,
    pub max_bind_groups: u32,
    /// Largest logical canvas this engine accepts. Not a texture limit.
    pub max_logical_canvas_width: f64,
    pub max_logical_canvas_height: f64,
    pub max_tile_size: u32,
    pub max_active_scenes: u32,
    pub max_warm_scenes: u32,
    /// Pixel ceiling for one preview image.
    pub max_preview_pixels: u64,
    pub max_message_bytes: u64,
    pub max_upload_bytes: u64,
    pub max_outputs: u32,
    pub max_surfaces: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputAdapterCapability {
    pub adapter_id: String,
    pub name: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub supports_alpha: bool,
    pub supports_interlaced: bool,
    pub color_formats: Vec<String>,
    /// Whether this adapter has been certified against real hardware.
    ///
    /// Never set from a compile-time feature flag. Compiling an SDK in is not the
    /// same as having run it on a device.
    pub hardware_certified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineFeatures {
    pub tile_rendering: bool,
    pub headless_rendering: bool,
    pub virtual_canvas: bool,
    pub multi_surface_mapping: bool,
    pub scene_patching: bool,
    pub preview_streaming: bool,
    pub shared_memory_preview: bool,
    pub native_text_render: bool,
    pub packaged_font_files: bool,
    pub native_video_decode: bool,
    pub native_3d_render: bool,
    pub hardware_encoding: bool,
    /// Warp and edge-blend maths. False in this phase; the data model exists.
    pub surface_warp_compositing: bool,
    pub edge_blend_compositing: bool,
    /// Distributed rendering across nodes. Designed for, not shipped.
    pub distributed_rendering: bool,
    pub device_loss_recovery: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    pub engine_id: String,
    pub engine_name: String,
    pub software_version: String,
    pub protocol_version: u32,
    pub scene_document_versions: Vec<u32>,
    pub stage_document_versions: Vec<u32>,
    pub os: OsInfo,
    pub cpu: CpuInfo,
    pub gpu: GpuInfo,
    pub limits: EngineLimits,
    pub supported_texture_formats: Vec<String>,
    pub supported_video_formats: Vec<String>,
    pub supported_shader_features: Vec<String>,
    pub output_adapters: Vec<OutputAdapterCapability>,
    pub features: EngineFeatures,
    /// Transitions actually implemented. Anything absent is refused, not faked.
    pub supported_transitions: Vec<String>,
    pub supported_quality_profiles: Vec<String>,
    /// Object types the native renderer draws. Others are reported unsupported.
    pub rendered_object_types: Vec<String>,
    pub transports: Vec<String>,
}

impl EngineCapabilities {
    /// Build the report from the GPU's actual limits and the engine's config.
    pub fn build(
        engine_id: &str,
        config: &EngineConfig,
        adapter_info: &wgpu::AdapterInfo,
        limits: &wgpu::Limits,
    ) -> Self {
        Self {
            engine_id: engine_id.to_string(),
            engine_name: config.identity.name.clone(),
            software_version: ENGINE_SOFTWARE_VERSION.to_string(),
            protocol_version: ENGINE_PROTOCOL_VERSION,
            scene_document_versions: SUPPORTED_SCENE_DOCUMENT_VERSIONS.to_vec(),
            stage_document_versions: SUPPORTED_STAGE_DOCUMENT_VERSIONS.to_vec(),
            os: OsInfo {
                platform: std::env::consts::OS.to_string(),
                release: std::env::consts::FAMILY.to_string(),
                arch: std::env::consts::ARCH.to_string(),
            },
            cpu: CpuInfo {
                model: adapter_info.driver.clone(),
                logical_cores: std::thread::available_parallelism()
                    .map(|value| value.get() as u32)
                    .unwrap_or(1),
            },
            gpu: GpuInfo {
                adapter: adapter_info.name.clone(),
                backend: format!("{:?}", adapter_info.backend).to_lowercase(),
                device_type: format!("{:?}", adapter_info.device_type),
                driver: adapter_info.driver.clone(),
                driver_info: adapter_info.driver_info.clone(),
                vendor_id: adapter_info.vendor,
                device_id: adapter_info.device,
                memory_bytes_estimate: config.gpu.memory_budget_bytes,
            },
            limits: EngineLimits {
                max_texture_dimension_2d: limits.max_texture_dimension_2d,
                max_texture_dimension_3d: limits.max_texture_dimension_3d,
                max_texture_array_layers: limits.max_texture_array_layers,
                max_buffer_size: limits.max_buffer_size,
                max_bind_groups: limits.max_bind_groups,
                max_logical_canvas_width: config.stage.max_logical_canvas_width,
                max_logical_canvas_height: config.stage.max_logical_canvas_height,
                // A tile plus its overscan must fit one texture.
                max_tile_size: limits
                    .max_texture_dimension_2d
                    .saturating_sub(config.stage.default_overscan * 2)
                    .min(crate::stage::MAX_TILE_SIZE),
                max_active_scenes: config.stage.max_active_scenes,
                max_warm_scenes: config.stage.max_active_scenes.saturating_sub(2).max(1),
                max_preview_pixels: config.preview.max_pixels,
                max_message_bytes: config.security.max_message_bytes,
                max_upload_bytes: config.assets.max_upload_bytes,
                max_outputs: config.stage.max_outputs,
                max_surfaces: config.stage.max_surfaces,
            },
            supported_texture_formats: vec![
                "rgba8unorm".to_string(),
                "rgba8unorm-srgb".to_string(),
                "bgra8unorm".to_string(),
                "bgra8unorm-srgb".to_string(),
            ],
            // Empty until native decode exists. Declaring formats we cannot decode
            // would make the Editor's pre-publish check useless.
            supported_video_formats: Vec::new(),
            supported_shader_features: vec!["wgsl".to_string()],
            output_adapters: output_adapter_capabilities(config),
            features: EngineFeatures {
                tile_rendering: true,
                headless_rendering: true,
                virtual_canvas: true,
                multi_surface_mapping: true,
                // True since incremental patch application landed: revision-gated,
                // atomic, and with per-object tile invalidation.
                scene_patching: true,
                // JPEG streams at a configured cadence, addressed to the subscribing
                // client. Raw and WebRTC encodings are declared in the protocol and
                // still refused, so a client asking for those is told rather than being
                // handed JPEG bytes it would decode as garbage.
                preview_streaming: true,
                shared_memory_preview: false,
                native_text_render: true,
                packaged_font_files: true,
                native_video_decode: false,
                native_3d_render: true,
                hardware_encoding: false,
                surface_warp_compositing: false,
                edge_blend_compositing: false,
                distributed_rendering: false,
                device_loss_recovery: true,
            },
            // Only the cut is implemented. The engine refuses anything else rather
            // than silently substituting a cut.
            supported_transitions: vec!["cut".to_string()],
            supported_quality_profiles: vec![
                "EDITOR_PREVIEW".to_string(),
                "REMOTE_PREVIEW".to_string(),
                "PROGRAM_HD".to_string(),
                "PROGRAM_UHD".to_string(),
                "HUGE_STAGE_REGION".to_string(),
                "LOW_LATENCY".to_string(),
                "DIAGNOSTIC".to_string(),
            ],
            rendered_object_types: vec![
                "rect".to_string(),
                "ellipse".to_string(),
                "text".to_string(),
                "image".to_string(),
                "mesh".to_string(),
                "layer".to_string(),
                "group".to_string(),
                "camera".to_string(),
                "light".to_string(),
            ],
            transports: vec!["websocket".to_string(), "ipc".to_string()],
        }
    }

    /// Limits a stage is validated against.
    pub fn stage_limits(&self) -> EngineStageLimits {
        EngineStageLimits {
            max_logical_canvas_width: self.limits.max_logical_canvas_width,
            max_logical_canvas_height: self.limits.max_logical_canvas_height,
            max_texture_dimension: self.limits.max_texture_dimension_2d,
            tile_rendering: self.features.tile_rendering,
            max_surfaces: self.limits.max_surfaces as usize,
            max_outputs: self.limits.max_outputs as usize,
        }
    }
}

/// Report the enabled output adapters, honestly.
///
/// An adapter whose SDK is not compiled in, or which is declared but not
/// implemented, reports itself unavailable with a reason. Nothing here reports
/// `hardware_certified: true` unless it has genuinely been run against a device —
/// and only null and recording have.
fn output_adapter_capabilities(config: &EngineConfig) -> Vec<OutputAdapterCapability> {
    config
        .outputs
        .enabled_adapters
        .iter()
        .map(|adapter_id| match adapter_id.as_str() {
            "null" => OutputAdapterCapability {
                adapter_id: "null".to_string(),
                name: "Null output".to_string(),
                available: true,
                unavailable_reason: None,
                supports_alpha: true,
                supports_interlaced: false,
                color_formats: vec!["bgra8".to_string()],
                hardware_certified: true,
            },
            "virtual" => OutputAdapterCapability {
                adapter_id: "virtual".to_string(),
                name: "Windowed virtual output (never live)".to_string(),
                available: true,
                unavailable_reason: None,
                supports_alpha: true,
                supports_interlaced: false,
                color_formats: vec!["bgra8".to_string()],
                // No hardware involved, so there is nothing to certify against.
                hardware_certified: true,
            },
            "recording" => OutputAdapterCapability {
                adapter_id: "recording".to_string(),
                name: "Deterministic recording".to_string(),
                available: true,
                unavailable_reason: None,
                supports_alpha: true,
                supports_interlaced: false,
                color_formats: vec!["bgra8".to_string()],
                hardware_certified: true,
            },
            "ndi" => OutputAdapterCapability {
                adapter_id: "ndi".to_string(),
                name: "NDI".to_string(),
                available: cfg!(feature = "ndi"),
                unavailable_reason: if cfg!(feature = "ndi") {
                    None
                } else {
                    Some("engine was built without --features ndi".to_string())
                },
                supports_alpha: true,
                supports_interlaced: false,
                color_formats: vec!["bgra8".to_string()],
                // Compiling the SDK in is not certification.
                hardware_certified: false,
            },
            other => OutputAdapterCapability {
                adapter_id: other.to_string(),
                name: other.to_string(),
                available: false,
                unavailable_reason: Some(
                    "declared in configuration but not implemented in this engine".to_string(),
                ),
                supports_alpha: false,
                supports_interlaced: false,
                color_formats: Vec::new(),
                hardware_certified: false,
            },
        })
        .collect()
}
