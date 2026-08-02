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
// Connection authority
// ---------------------------------------------------------------------------

/// Product identity assigned by the transport after it authenticates a connection.
///
/// This is intentionally not deserializable from a protocol `Hello`: a peer may
/// describe itself there for diagnostics, but that description is never authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionRole {
    Editor,
    Playout,
}

impl ConnectionRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Playout => "playout",
        }
    }
}

/// Immutable, credential-derived authority for one connection.
///
/// A loopback session without an operational bearer credential is deliberately an
/// Editor session. A successfully verified bearer credential is the only currently
/// configured way to obtain the Playout authority. Keeping this assignment at the
/// transport boundary makes a forged `clientRole` claim harmless.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionPrincipal {
    role: ConnectionRole,
    connection_id: String,
    authenticated: bool,
}

impl ConnectionPrincipal {
    pub fn loopback_editor(connection_id: impl Into<String>) -> Self {
        Self {
            role: ConnectionRole::Editor,
            connection_id: connection_id.into(),
            authenticated: false,
        }
    }

    pub fn authenticated_playout(connection_id: impl Into<String>) -> Self {
        Self {
            role: ConnectionRole::Playout,
            connection_id: connection_id.into(),
            authenticated: true,
        }
    }

    pub fn role(&self) -> ConnectionRole {
        self.role
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    /// Closed capability matrix. New request types are denied until deliberately
    /// classified here; no role receives authority merely because it connected.
    pub fn allows(&self, request: crate::protocol::RequestType) -> bool {
        use crate::protocol::RequestType::*;

        match self.role {
            ConnectionRole::Editor => matches!(
                request,
                Hello
                    | Authenticate
                    | Heartbeat
                    | Capabilities
                    | Disconnect
                    | StageLoad
                    | StageUnload
                    | SceneLoad
                    | SceneUnload
                    | SceneFullSync
                    | SceneApplyPatch
                    | SceneValidate
                    | ScenePrepare
                    | AssetRegister
                    | AssetUpload
                    | AssetValidate
                    | AssetPreload
                    | AssetRelease
                    | GetStatus
                    | GetDiagnostics
                    | GetCapabilities
                    | OutputList
                    | EditorViewRequest
            ),
            ConnectionRole::Playout => matches!(
                request,
                Hello
                    | Authenticate
                    | Heartbeat
                    | Capabilities
                    | Disconnect
                    | Cue
                    | TakeOnline
                    | TakeOffline
                    | Continue
                    | Update
                    | Stop
                    | Clear
                    | Replace
                    | Transition
                    | PreviewRequest
                    | PreviewStreamStart
                    | PreviewStreamStop
                    | PreviewSetViewport
                    | GetStatus
                    | GetDiagnostics
                    | GetCapabilities
                    | SetConfiguration
                    | RestartRenderer
                    | OutputList
                    | OutputConfigure
                    | OutputStart
                    | OutputStop
                    | OutputRemove
            ),
        }
    }
}

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

// ---------------------------------------------------------------------------
// Engine-owned resource admission and render-frame storage
// ---------------------------------------------------------------------------

/// The byte categories the engine owns.  These are deliberately not allocator
/// statistics: the governor counts resources whose lifetime it controls, so its
/// limits are portable across wgpu backends and operating systems.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OwnedBytes {
    pub decoded_assets: u64,
    pub staging_buffers: u64,
    pub textures_and_mips: u64,
    pub geometry: u64,
    pub glyph_atlases: u64,
    pub tile_render_targets: u64,
    pub upload_rings: u64,
    pub pipeline_state: u64,
    pub bind_group_data: u64,
    pub frame_pool: u64,
}

impl OwnedBytes {
    pub const fn cpu_bytes(self) -> u64 {
        self.decoded_assets
            .saturating_add(self.staging_buffers)
            .saturating_add(self.frame_pool)
    }

    pub const fn gpu_bytes(self) -> u64 {
        self.textures_and_mips
            .saturating_add(self.geometry)
            .saturating_add(self.glyph_atlases)
            .saturating_add(self.tile_render_targets)
            .saturating_add(self.upload_rings)
            .saturating_add(self.pipeline_state)
            .saturating_add(self.bind_group_data)
    }

    pub const fn total_bytes(self) -> u64 {
        self.cpu_bytes().saturating_add(self.gpu_bytes())
    }

    fn saturating_add(self, other: Self) -> Self {
        Self {
            decoded_assets: self.decoded_assets.saturating_add(other.decoded_assets),
            staging_buffers: self.staging_buffers.saturating_add(other.staging_buffers),
            textures_and_mips: self
                .textures_and_mips
                .saturating_add(other.textures_and_mips),
            geometry: self.geometry.saturating_add(other.geometry),
            glyph_atlases: self.glyph_atlases.saturating_add(other.glyph_atlases),
            tile_render_targets: self
                .tile_render_targets
                .saturating_add(other.tile_render_targets),
            upload_rings: self.upload_rings.saturating_add(other.upload_rings),
            pipeline_state: self.pipeline_state.saturating_add(other.pipeline_state),
            bind_group_data: self.bind_group_data.saturating_add(other.bind_group_data),
            frame_pool: self.frame_pool.saturating_add(other.frame_pool),
        }
    }

    fn saturating_sub(self, other: Self) -> Self {
        Self {
            decoded_assets: self.decoded_assets.saturating_sub(other.decoded_assets),
            staging_buffers: self.staging_buffers.saturating_sub(other.staging_buffers),
            textures_and_mips: self
                .textures_and_mips
                .saturating_sub(other.textures_and_mips),
            geometry: self.geometry.saturating_sub(other.geometry),
            glyph_atlases: self.glyph_atlases.saturating_sub(other.glyph_atlases),
            tile_render_targets: self
                .tile_render_targets
                .saturating_sub(other.tile_render_targets),
            upload_rings: self.upload_rings.saturating_sub(other.upload_rings),
            pipeline_state: self.pipeline_state.saturating_sub(other.pipeline_state),
            bind_group_data: self.bind_group_data.saturating_sub(other.bind_group_data),
            frame_pool: self.frame_pool.saturating_sub(other.frame_pool),
        }
    }
}

/// Scheduling priority. Only unreferenced Warm entries may be evicted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ResourcePriority {
    Warm,
    ActiveEditorView,
    PlayoutPreview,
    Program,
}

/// Hard, deterministic budgets. `resident_scene_target` is an admission target,
/// not a promise that a scene fits: owned-byte budgets remain authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceBudget {
    pub cpu_bytes: u64,
    pub gpu_bytes: u64,
    pub resident_scene_target: u32,
}

impl ResourceBudget {
    /// Hardware profiles intentionally describe an admission range rather than a
    /// magical scene count. A 2 GiB profile starts at 50, and additional GPU
    /// capacity moves the target toward 60; byte accounting decides each scene.
    pub fn from_config(config: &EngineConfig) -> Self {
        let gib = 1024 * 1024 * 1024;
        let additional = config.gpu.memory_budget_bytes.saturating_sub(2 * gib) / gib;
        Self {
            cpu_bytes: config
                .assets
                .cpu_cache_budget_bytes
                .saturating_add(config.stage.tile_cache_budget_bytes),
            gpu_bytes: config.gpu.memory_budget_bytes,
            resident_scene_target: 50u32.saturating_add(additional.min(10) as u32),
        }
    }
}

/// Estimate created from package-manifest metadata before decoding or uploading.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScenePreparationEstimate {
    pub owned: OwnedBytes,
    pub priority: ResourcePriority,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reservation {
    id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservationOutcome {
    pub reservation: Reservation,
    /// Warm LRU entries discarded before preparation. They were unreferenced.
    pub evicted: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionError {
    DuplicateReservation,
    UnknownReservation,
    UploadNotRecorded,
    EstimateExceeded,
    Capacity {
        requested_cpu_bytes: u64,
        requested_gpu_bytes: u64,
        available_cpu_bytes: u64,
        available_gpu_bytes: u64,
    },
}

#[derive(Debug, Clone)]
struct ResidentResource {
    owned: OwnedBytes,
    priority: ResourcePriority,
    referenced: bool,
    last_used_ms: u64,
}

#[derive(Debug, Clone)]
struct PendingReservation {
    owner: String,
    estimate: ScenePreparationEstimate,
    uploaded: bool,
}

/// The sole Engine resource authority. It is deliberately a control/preparation
/// plane object: no render-tick path accesses its maps or performs eviction.
#[derive(Debug)]
pub struct ResourceGovernor {
    budget: ResourceBudget,
    committed: OwnedBytes,
    reserved: OwnedBytes,
    residents: std::collections::BTreeMap<String, ResidentResource>,
    reservations: std::collections::BTreeMap<u64, PendingReservation>,
    next_reservation: u64,
}

impl ResourceGovernor {
    pub fn new(budget: ResourceBudget) -> Self {
        Self {
            budget,
            committed: OwnedBytes::default(),
            reserved: OwnedBytes::default(),
            residents: std::collections::BTreeMap::new(),
            reservations: std::collections::BTreeMap::new(),
            next_reservation: 1,
        }
    }

    pub fn budget(&self) -> ResourceBudget {
        self.budget
    }

    pub fn committed(&self) -> OwnedBytes {
        self.committed
    }

    pub fn reserved(&self) -> OwnedBytes {
        self.reserved
    }

    pub fn resident_count(&self) -> usize {
        self.residents.len()
    }

    /// Estimate -> Reserve. It evicts only cold, unreferenced warm entries,
    /// in deterministic LRU order, before rejecting the preparation.
    pub fn reserve(
        &mut self,
        owner: impl Into<String>,
        estimate: ScenePreparationEstimate,
    ) -> Result<ReservationOutcome, AdmissionError> {
        let owner = owner.into();
        if self
            .reservations
            .values()
            .any(|pending| pending.owner == owner)
        {
            return Err(AdmissionError::DuplicateReservation);
        }

        let mut evicted = Vec::new();
        while !self.fits(estimate.owned)
            || (!self.residents.contains_key(&owner)
                && self.residents.len().saturating_add(self.reservations.len())
                    >= self.budget.resident_scene_target as usize)
        {
            let candidate = self
                .residents
                .iter()
                .filter(|(key, resident)| {
                    key.as_str() != owner
                        && resident.priority == ResourcePriority::Warm
                        && !resident.referenced
                })
                .min_by_key(|(key, resident)| (resident.last_used_ms, *key))
                .map(|(key, _)| key.clone());
            let Some(candidate) = candidate else {
                return Err(self.capacity_error(estimate.owned));
            };
            self.release(&candidate);
            evicted.push(candidate);
        }

        let id = self.next_reservation;
        self.next_reservation = self.next_reservation.saturating_add(1).max(1);
        self.reserved = self.reserved.saturating_add(estimate.owned);
        self.reservations.insert(
            id,
            PendingReservation {
                owner,
                estimate,
                uploaded: false,
            },
        );
        Ok(ReservationOutcome {
            reservation: Reservation { id },
            evicted,
        })
    }

    /// Reserve -> Upload. Call this only after all decode/shape/tessellation and
    /// GPU upload work succeeded off the render thread.
    pub fn uploaded(&mut self, reservation: Reservation) -> Result<(), AdmissionError> {
        let pending = self
            .reservations
            .get_mut(&reservation.id)
            .ok_or(AdmissionError::UnknownReservation)?;
        pending.uploaded = true;
        Ok(())
    }

    /// Upload -> Commit at a frame boundary. Measured bytes must fit the estimate;
    /// underestimation fails closed and leaves no partially committed runtime.
    pub fn commit(
        &mut self,
        reservation: Reservation,
        actual: OwnedBytes,
        referenced: bool,
        last_used_ms: u64,
    ) -> Result<String, AdmissionError> {
        let pending = self
            .reservations
            .get(&reservation.id)
            .cloned()
            .ok_or(AdmissionError::UnknownReservation)?;
        if !pending.uploaded {
            return Err(AdmissionError::UploadNotRecorded);
        }
        if actual.cpu_bytes() > pending.estimate.owned.cpu_bytes()
            || actual.gpu_bytes() > pending.estimate.owned.gpu_bytes()
        {
            return Err(AdmissionError::EstimateExceeded);
        }

        self.reservations.remove(&reservation.id);
        self.reserved = self.reserved.saturating_sub(pending.estimate.owned);
        if let Some(previous) = self.residents.remove(&pending.owner) {
            self.committed = self.committed.saturating_sub(previous.owned);
        }
        self.committed = self.committed.saturating_add(actual);
        self.residents.insert(
            pending.owner.clone(),
            ResidentResource {
                owned: actual,
                priority: pending.estimate.priority,
                referenced,
                last_used_ms,
            },
        );
        Ok(pending.owner)
    }

    /// Rollback is idempotent for callers that lost the device during upload.
    pub fn rollback(&mut self, reservation: Reservation) {
        if let Some(pending) = self.reservations.remove(&reservation.id) {
            self.reserved = self.reserved.saturating_sub(pending.estimate.owned);
        }
    }

    pub fn touch(
        &mut self,
        owner: &str,
        priority: ResourcePriority,
        referenced: bool,
        now_ms: u64,
    ) {
        if let Some(resident) = self.residents.get_mut(owner) {
            resident.priority = priority;
            resident.referenced = referenced;
            resident.last_used_ms = now_ms;
        }
    }

    pub fn release(&mut self, owner: &str) -> Option<OwnedBytes> {
        self.residents.remove(owner).map(|resident| {
            self.committed = self.committed.saturating_sub(resident.owned);
            resident.owned
        })
    }

    fn fits(&self, requested: OwnedBytes) -> bool {
        self.committed
            .cpu_bytes()
            .saturating_add(self.reserved.cpu_bytes())
            .saturating_add(requested.cpu_bytes())
            <= self.budget.cpu_bytes
            && self
                .committed
                .gpu_bytes()
                .saturating_add(self.reserved.gpu_bytes())
                .saturating_add(requested.gpu_bytes())
                <= self.budget.gpu_bytes
    }

    fn capacity_error(&self, requested: OwnedBytes) -> AdmissionError {
        AdmissionError::Capacity {
            requested_cpu_bytes: requested.cpu_bytes(),
            requested_gpu_bytes: requested.gpu_bytes(),
            available_cpu_bytes: self.budget.cpu_bytes.saturating_sub(
                self.committed
                    .cpu_bytes()
                    .saturating_add(self.reserved.cpu_bytes()),
            ),
            available_gpu_bytes: self.budget.gpu_bytes.saturating_sub(
                self.committed
                    .gpu_bytes()
                    .saturating_add(self.reserved.gpu_bytes()),
            ),
        }
    }
}

/// A preallocated output/readback handoff slab. `acquire` and `release` only
/// move indexes inside pre-reserved vectors and never grow the heap on tick.
#[derive(Debug)]
pub struct VideoFramePool {
    slots: Vec<grapix_render_core::output::VideoFrame>,
    free: Vec<usize>,
    leased: Vec<bool>,
}

impl VideoFramePool {
    pub fn new(width: u32, height: u32, slot_count: usize) -> Self {
        let byte_len = (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4);
        let mut slots = Vec::with_capacity(slot_count);
        let mut free = Vec::with_capacity(slot_count);
        let mut leased = Vec::with_capacity(slot_count);
        for index in 0..slot_count {
            slots.push(grapix_render_core::output::VideoFrame {
                width,
                height,
                data: vec![0; byte_len],
                frame_index: 0,
            });
            free.push(slot_count - index - 1);
            leased.push(false);
        }
        Self {
            slots,
            free,
            leased,
        }
    }

    pub fn acquire(&mut self) -> Option<usize> {
        let index = self.free.pop()?;
        self.leased[index] = true;
        Some(index)
    }

    pub fn frame_mut(
        &mut self,
        index: usize,
    ) -> Option<&mut grapix_render_core::output::VideoFrame> {
        self.leased.get(index).copied().filter(|leased| *leased)?;
        self.slots.get_mut(index)
    }

    pub fn release(&mut self, index: usize) -> bool {
        if self.leased.get(index).copied() != Some(true) {
            return false;
        }
        self.leased[index] = false;
        self.free.push(index);
        true
    }

    pub fn available(&self) -> usize {
        self.free.len()
    }

    pub fn bytes(&self) -> u64 {
        self.slots
            .iter()
            .map(|frame| frame.data.capacity() as u64)
            .sum()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendClass {
    Opaque,
    PremultipliedAlpha,
    Blend,
}

/// Resolved during preparation. IDs reference persistent pipelines, materials,
/// textures, geometry and scissor state; they do not own allocations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrawPacket {
    pub pipeline_id: u32,
    pub material_id: u32,
    pub texture_id: u32,
    pub geometry_id: u32,
    pub scissor_id: u32,
    pub painter_order: u32,
    pub blend: BlendClass,
    /// Set only by classification that has proved reordering pixel-identical.
    pub opaque_reorder_proven: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrawBatch {
    pub first_packet: usize,
    pub packet_count: usize,
    pub pipeline_id: u32,
    pub material_id: u32,
    pub texture_id: u32,
    pub geometry_id: u32,
    pub scissor_id: u32,
    pub blend: BlendClass,
}

/// Fixed-capacity packet arena. The render tick calls `clear`, `push`, and
/// `batches_into`; all refuse overflow instead of growing a `Vec`.
#[derive(Debug)]
pub struct DrawPacketArena {
    packets: Vec<DrawPacket>,
}

impl DrawPacketArena {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            packets: Vec::with_capacity(capacity),
        }
    }

    pub fn clear(&mut self) {
        self.packets.clear();
    }

    pub fn push(&mut self, packet: DrawPacket) -> Result<(), DrawPacket> {
        if self.packets.len() == self.packets.capacity() {
            return Err(packet);
        }
        self.packets.push(packet);
        Ok(())
    }

    pub fn packets(&self) -> &[DrawPacket] {
        &self.packets
    }

    /// Batch only contiguous compatible packets in painter order. Opaque
    /// reordering is intentionally not implicit: a caller must invoke the
    /// proof-gated method below during preparation, never on the render tick.
    pub fn batches_into(&self, output: &mut [DrawBatch]) -> Result<usize, ()> {
        let mut count = 0;
        let mut first = 0;
        while first < self.packets.len() {
            let head = self.packets[first];
            let mut end = first + 1;
            while end < self.packets.len() && compatible(head, self.packets[end]) {
                end += 1;
            }
            let Some(slot) = output.get_mut(count) else {
                return Err(());
            };
            *slot = DrawBatch {
                first_packet: first,
                packet_count: end - first,
                pipeline_id: head.pipeline_id,
                material_id: head.material_id,
                texture_id: head.texture_id,
                geometry_id: head.geometry_id,
                scissor_id: head.scissor_id,
                blend: head.blend,
            };
            count += 1;
            first = end;
        }
        Ok(count)
    }

    /// Sorting is legal only in a contiguous opaque partition every packet of
    /// which has an explicit pixel-identical proof. `sort_unstable_by` uses no
    /// heap allocation; callers run it during preparation, never a tick.
    pub fn sort_proven_opaque_partition(&mut self, start: usize, end: usize) -> bool {
        let Some(partition) = self.packets.get_mut(start..end) else {
            return false;
        };
        if partition
            .iter()
            .any(|packet| packet.blend != BlendClass::Opaque || !packet.opaque_reorder_proven)
        {
            return false;
        }
        partition.sort_unstable_by_key(|packet| {
            (
                packet.pipeline_id,
                packet.material_id,
                packet.texture_id,
                packet.geometry_id,
                packet.scissor_id,
            )
        });
        true
    }
}

fn compatible(a: DrawPacket, b: DrawPacket) -> bool {
    a.blend == b.blend
        && a.pipeline_id == b.pipeline_id
        && a.material_id == b.material_id
        && a.texture_id == b.texture_id
        && a.geometry_id == b.geometry_id
        && a.scissor_id == b.scissor_id
}

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
                "shape".to_string(),
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
