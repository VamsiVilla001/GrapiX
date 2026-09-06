//! Engine configuration.
//!
//! One binary covers every deployment mode — local embedded, local external,
//! remote network, dedicated GPU, headless server, render node — because mode is
//! configuration rather than a code path.
//!
//! Precedence, applied in this order:
//!
//! > **CLI argument > environment variable > TOML file > built-in default**
//!
//! That order is what makes an engine.toml a *baseline* rather than a
//! straitjacket: a deployment ships one file and overrides the port or the bind
//! address per node without editing it.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const ENGINE_ENV_PREFIX: &str = "GRAPIX_ENGINE_";
pub const DEFAULT_PORT: u16 = 4400;
pub const DEFAULT_BIND: &str = "127.0.0.1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct EngineIdentityConfig {
    /// Operator-facing name. Shown in every diagnostic panel.
    pub name: String,
    /// Stable unique id. Generated and persisted on first run if absent.
    pub engine_id: Option<String>,
}

impl Default for EngineIdentityConfig {
    fn default() -> Self {
        Self {
            name: "GrapiX Render Engine".to_string(),
            engine_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct NetworkConfig {
    pub bind_address: String,
    pub websocket_port: u16,
    /// Local IPC endpoint: a named pipe on Windows, a socket path elsewhere.
    pub ipc_endpoint: Option<String>,
    /// Empty means loopback only, which is the safe default.
    pub allowed_origins: Vec<String>,
    /// Client addresses permitted to connect. Empty means any that authenticate.
    pub client_allowlist: Vec<String>,
    /// Path to a TLS certificate. Transport is TLS-ready but not yet terminated
    /// in-process; a reverse proxy is the supported path today.
    pub tls_certificate_path: Option<String>,
    pub tls_private_key_path: Option<String>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            bind_address: DEFAULT_BIND.to_string(),
            websocket_port: DEFAULT_PORT,
            ipc_endpoint: None,
            allowed_origins: Vec::new(),
            client_allowlist: Vec::new(),
            tls_certificate_path: None,
            tls_private_key_path: None,
        }
    }
}

impl NetworkConfig {
    /// True when the engine is reachable from outside this machine.
    ///
    /// Drives the security requirements: a non-loopback bind demands a token.
    pub fn is_remote_reachable(&self) -> bool {
        !(self.bind_address == "127.0.0.1"
            || self.bind_address == "localhost"
            || self.bind_address == "::1")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct AuthConfig {
    /// Require a valid access token on every connection, on every transport, including
    /// loopback and the local pipe. Forced on for any non-loopback bind. This is the
    /// production switch: with it set, the engine issues no authority to anyone who cannot
    /// name themselves.
    pub required: bool,
    /// The HMAC key access tokens are signed with, shared with whichever service mints them.
    ///
    /// Inline for development only; prefer `signing_secret_file`, because an inline secret
    /// ends up in git, and a signing key in git is every account in the facility.
    pub signing_secret: Option<String>,
    pub signing_secret_file: Option<String>,
    /// Projects this engine will serve. Empty means any.
    pub allowed_projects: Vec<String>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            required: true,
            signing_secret: None,
            signing_secret_file: None,
            allowed_projects: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct GpuConfig {
    /// Substring matched against adapter names, e.g. "RTX". Empty means any.
    pub preferred_gpu: Option<String>,
    /// `vulkan`, `dx12`, `metal`, `gl`, or unset for automatic.
    pub preferred_backend: Option<String>,
    /// No window and no surface. Required on a server.
    pub headless: bool,
    /// Advisory VRAM ceiling. wgpu cannot enforce it, so it bounds our own caches.
    pub memory_budget_bytes: u64,
    /// Refuse to start without a discrete GPU.
    pub require_discrete_gpu: bool,
}

impl Default for GpuConfig {
    fn default() -> Self {
        Self {
            preferred_gpu: None,
            preferred_backend: None,
            headless: true,
            memory_budget_bytes: 2 * 1024 * 1024 * 1024,
            require_discrete_gpu: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct StageLimitsConfig {
    pub max_logical_canvas_width: f64,
    pub max_logical_canvas_height: f64,
    pub default_tile_width: u32,
    pub default_tile_height: u32,
    pub default_overscan: u32,
    pub tile_cache_budget_bytes: u64,
    pub max_resident_tiles: u32,
    pub max_active_scenes: u32,
    pub max_surfaces: u32,
    pub max_outputs: u32,
}

impl Default for StageLimitsConfig {
    fn default() -> Self {
        Self {
            max_logical_canvas_width: 50_000.0,
            max_logical_canvas_height: 50_000.0,
            default_tile_width: 1024,
            default_tile_height: 1024,
            default_overscan: 32,
            tile_cache_budget_bytes: 512 * 1024 * 1024,
            max_resident_tiles: 256,
            max_active_scenes: 8,
            max_surfaces: 64,
            max_outputs: 8,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct PreviewConfig {
    /// Hard pixel ceiling for one preview image.
    ///
    /// The engine refuses a request over this rather than allocating. A
    /// full-resolution 50,000 x 50,000 preview would be 10 GB.
    pub max_pixels: u64,
    pub default_encoding: String,
    pub default_quality: u8,
    pub max_streams: u32,
    pub max_stream_fps: u32,
}

impl Default for PreviewConfig {
    fn default() -> Self {
        Self {
            max_pixels: 1920 * 1080,
            default_encoding: "jpeg".to_string(),
            default_quality: 80,
            max_streams: 4,
            max_stream_fps: 30,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct AssetConfig {
    /// Directories assets may be read from.
    ///
    /// A remote client supplies a *relative* path resolved inside one of these and
    /// nothing else. This is the boundary that stops a client naming
    /// `/etc/passwd`.
    pub roots: Vec<String>,
    pub cache_directory: String,
    pub max_upload_bytes: u64,
    pub max_chunk_bytes: u64,
    pub cpu_cache_budget_bytes: u64,
    pub gpu_cache_budget_bytes: u64,
    pub disk_cache_budget_bytes: u64,
    /// Allow fetching assets over HTTP(S). Off by default: an engine that fetches
    /// arbitrary URLs is a proxy.
    pub allow_http_fetch: bool,
    pub http_allowlist: Vec<String>,
}

impl Default for AssetConfig {
    fn default() -> Self {
        Self {
            roots: vec!["assets".to_string()],
            cache_directory: "cache".to_string(),
            max_upload_bytes: 2 * 1024 * 1024 * 1024,
            max_chunk_bytes: 4 * 1024 * 1024,
            cpu_cache_budget_bytes: 1024 * 1024 * 1024,
            gpu_cache_budget_bytes: 1024 * 1024 * 1024,
            disk_cache_budget_bytes: 8 * 1024 * 1024 * 1024,
            allow_http_fetch: false,
            http_allowlist: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct SecurityConfig {
    pub max_message_bytes: u64,
    /// Token-bucket capacity per connection.
    pub rate_limit_burst: u32,
    pub rate_limit_per_second: u32,
    pub max_connections: u32,
    /// Append an audit line for every state-changing command.
    pub audit_log_enabled: bool,
    pub audit_log_path: Option<String>,
    /// Reject shaders that are not in the shader library.
    pub shader_allowlist_only: bool,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            max_message_bytes: 8 * 1024 * 1024,
            rate_limit_burst: 64,
            rate_limit_per_second: 32,
            max_connections: 8,
            audit_log_enabled: true,
            audit_log_path: None,
            shader_allowlist_only: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct DiagnosticsConfig {
    pub enabled: bool,
    /// Include the per-tile table in diagnostics. Can be thousands of rows.
    pub include_tile_detail: bool,
    pub log_level: String,
    pub heartbeat_interval_ms: u64,
    pub heartbeat_timeout_ms: u64,
}

impl Default for DiagnosticsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            include_tile_detail: false,
            log_level: "info".to_string(),
            heartbeat_interval_ms: 2_000,
            heartbeat_timeout_ms: 8_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct OutputsConfig {
    /// Adapter ids this engine will expose. Anything absent is not offered.
    pub enabled_adapters: Vec<String>,
    /// Fixed number of preallocated NDI readback slabs per configured output.
    ///
    /// The NDI handoff is bounded by design: values outside 3–4 are clamped
    /// during validation rather than allowing a client to grow its queue.
    pub ndi_frame_pool_slots: u8,
}

impl Default for OutputsConfig {
    fn default() -> Self {
        Self {
            // Adapters that need no vendor SDK and cannot reach air. The virtual
            // output is included deliberately: an operator should always be able to
            // confirm a take renders correctly without any risk of going live.
            enabled_adapters: vec![
                "null".to_string(),
                "virtual".to_string(),
                "recording".to_string(),
            ],
            ndi_frame_pool_slots: 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "kebab-case")]
pub struct EngineConfig {
    pub identity: EngineIdentityConfig,
    pub network: NetworkConfig,
    pub auth: AuthConfig,
    pub gpu: GpuConfig,
    pub stage: StageLimitsConfig,
    pub preview: PreviewConfig,
    pub assets: AssetConfig,
    pub security: SecurityConfig,
    pub diagnostics: DiagnosticsConfig,
    pub outputs: OutputsConfig,
    /// Path the config was loaded from. Reported in diagnostics; never serialised.
    #[serde(skip)]
    pub source_path: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read config {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse config {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("{0} is not a valid value for {1}")]
    InvalidValue(String, String),
    #[error("{0}")]
    Invalid(String),
}

impl EngineConfig {
    /// Load a TOML file. Absent keys take their documented default.
    pub fn from_file(path: &Path) -> Result<Self, ConfigError> {
        let text = fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_path_buf(),
            source,
        })?;

        let mut config: EngineConfig =
            toml::from_str(&text).map_err(|source| ConfigError::Parse {
                path: path.to_path_buf(),
                source,
            })?;
        config.source_path = Some(path.to_path_buf());
        Ok(config)
    }

    /// Apply `GRAPIX_ENGINE_*` overrides.
    ///
    /// Only keys that are genuinely deployment-varying are exposed. Every asset
    /// root and cache budget through the environment would be a second, undocumented
    /// configuration surface.
    pub fn apply_env(&mut self, env: &BTreeMap<String, String>) -> Result<(), ConfigError> {
        let get = |key: &str| env.get(&format!("{ENGINE_ENV_PREFIX}{key}"));

        if let Some(value) = get("NAME") {
            self.identity.name = value.clone();
        }
        if let Some(value) = get("ID") {
            self.identity.engine_id = Some(value.clone());
        }
        if let Some(value) = get("BIND") {
            self.network.bind_address = value.clone();
        }
        if let Some(value) = get("PORT") {
            self.network.websocket_port = value
                .parse()
                .map_err(|_| ConfigError::InvalidValue(value.clone(), "PORT".to_string()))?;
        }
        if let Some(value) = get("IPC") {
            self.network.ipc_endpoint = Some(value.clone());
        }
        if let Some(value) = get("AUTH_SECRET") {
            self.auth.signing_secret = Some(value.clone());
            self.auth.required = true;
        }
        if let Some(value) = get("AUTH_SECRET_FILE") {
            self.auth.signing_secret_file = Some(value.clone());
        }
        if let Some(value) = get("HEADLESS") {
            self.gpu.headless = parse_bool(value, "HEADLESS")?;
        }
        if let Some(value) = get("PREFERRED_GPU") {
            self.gpu.preferred_gpu = Some(value.clone());
        }
        if let Some(value) = get("PREFERRED_BACKEND") {
            self.gpu.preferred_backend = Some(value.clone());
        }
        if let Some(value) = get("TILE_SIZE") {
            let size: u32 = value
                .parse()
                .map_err(|_| ConfigError::InvalidValue(value.clone(), "TILE_SIZE".to_string()))?;
            self.stage.default_tile_width = size;
            self.stage.default_tile_height = size;
        }
        if let Some(value) = get("TILE_CACHE_BYTES") {
            self.stage.tile_cache_budget_bytes = value.parse().map_err(|_| {
                ConfigError::InvalidValue(value.clone(), "TILE_CACHE_BYTES".to_string())
            })?;
        }
        if let Some(value) = get("GPU_BUDGET_BYTES") {
            self.gpu.memory_budget_bytes = value.parse().map_err(|_| {
                ConfigError::InvalidValue(value.clone(), "GPU_BUDGET_BYTES".to_string())
            })?;
        }
        if let Some(value) = get("ASSET_CACHE_DIR") {
            self.assets.cache_directory = value.clone();
        }
        if let Some(value) = get("ASSET_ROOTS") {
            self.assets.roots = value
                .split(';')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect();
        }
        if let Some(value) = get("LOG_LEVEL") {
            self.diagnostics.log_level = value.clone();
        }
        if let Some(value) = get("PREVIEW_MAX_PIXELS") {
            self.preview.max_pixels = value.parse().map_err(|_| {
                ConfigError::InvalidValue(value.clone(), "PREVIEW_MAX_PIXELS".to_string())
            })?;
        }
        if let Some(value) = get("ENABLED_ADAPTERS") {
            self.outputs.enabled_adapters = value
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect();
        }

        Ok(())
    }

    /// Apply CLI overrides. Highest precedence.
    pub fn apply_cli(&mut self, cli: &CliOptions) {
        if let Some(value) = &cli.bind {
            self.network.bind_address = value.clone();
        }
        if let Some(value) = cli.port {
            self.network.websocket_port = value;
        }
        if let Some(value) = &cli.engine_id {
            self.identity.engine_id = Some(value.clone());
        }
        if let Some(value) = &cli.name {
            self.identity.name = value.clone();
        }
        if let Some(value) = cli.headless {
            self.gpu.headless = value;
        }
        if let Some(value) = &cli.preferred_gpu {
            self.gpu.preferred_gpu = Some(value.clone());
        }
        if let Some(value) = &cli.preferred_backend {
            self.gpu.preferred_backend = Some(value.clone());
        }
        if let Some(value) = &cli.signing_secret_file {
            self.auth.signing_secret_file = Some(value.clone());
        }
        if let Some(value) = &cli.ipc {
            self.network.ipc_endpoint = Some(value.clone());
        }
        if let Some(value) = &cli.log_level {
            self.diagnostics.log_level = value.clone();
        }
        if let Some(value) = cli.tile_size {
            self.stage.default_tile_width = value;
            self.stage.default_tile_height = value;
        }
    }

    /// Clamp to safe ranges and reject genuinely unsafe combinations.
    ///
    /// A remote-reachable engine with no token is refused rather than clamped:
    /// silently binding an unauthenticated renderer to a venue network is the one
    /// mistake that must not be recoverable by a default.
    pub fn validate(&mut self) -> Result<Vec<String>, ConfigError> {
        let mut warnings = Vec::new();

        self.stage.max_logical_canvas_width = self
            .stage
            .max_logical_canvas_width
            .clamp(1.0, crate::stage::MAX_LOGICAL_CANVAS_DIMENSION);
        self.stage.max_logical_canvas_height = self
            .stage
            .max_logical_canvas_height
            .clamp(1.0, crate::stage::MAX_LOGICAL_CANVAS_DIMENSION);

        self.stage.default_tile_width = self
            .stage
            .default_tile_width
            .clamp(crate::stage::MIN_TILE_SIZE, crate::stage::MAX_TILE_SIZE);
        self.stage.default_tile_height = self
            .stage
            .default_tile_height
            .clamp(crate::stage::MIN_TILE_SIZE, crate::stage::MAX_TILE_SIZE);
        self.stage.default_overscan = self.stage.default_overscan.min(1024);
        self.stage.max_resident_tiles = self.stage.max_resident_tiles.clamp(1, 65_536);
        self.stage.max_active_scenes = self.stage.max_active_scenes.clamp(1, 256);

        self.preview.max_pixels = self.preview.max_pixels.clamp(1024, 64 * 1024 * 1024);
        self.preview.default_quality = self.preview.default_quality.clamp(1, 100);
        self.preview.max_streams = self.preview.max_streams.min(64);
        self.preview.max_stream_fps = self.preview.max_stream_fps.clamp(1, 120);

        self.security.max_message_bytes = self
            .security
            .max_message_bytes
            .clamp(4 * 1024, 256 * 1024 * 1024);
        self.security.max_connections = self.security.max_connections.clamp(1, 256);
        self.outputs.ndi_frame_pool_slots = self.outputs.ndi_frame_pool_slots.clamp(3, 4);
        self.security.rate_limit_burst = self.security.rate_limit_burst.clamp(1, 10_000);

        self.assets.max_chunk_bytes = self
            .assets
            .max_chunk_bytes
            .clamp(1024, self.security.max_message_bytes);

        if self.assets.roots.is_empty() {
            return Err(ConfigError::Invalid(
                "assets.roots must name at least one directory; with none, no asset can be resolved"
                    .to_string(),
            ));
        }

        if self.network.is_remote_reachable() {
            self.auth.required = true;
            if self.auth.signing_secret.is_none() && self.auth.signing_secret_file.is_none() {
                return Err(ConfigError::Invalid(format!(
                    "engine binds {} which is reachable from the network, but no token signing secret is configured. Set auth.signing-secret-file, or bind 127.0.0.1.",
                    self.network.bind_address
                )));
            }
            if self.network.tls_certificate_path.is_none() {
                warnings.push(format!(
                    "engine binds {} without TLS; terminate TLS at a reverse proxy before exposing it beyond a trusted network",
                    self.network.bind_address
                ));
            }
            if self.network.client_allowlist.is_empty() {
                warnings.push(
                    "network.client-allowlist is empty, so any client that presents a valid token may connect"
                        .to_string(),
                );
            }
        }

        if !self.gpu.headless {
            warnings.push(
                "gpu.headless is false; a server or render node should run headless".to_string(),
            );
        }

        if self.assets.allow_http_fetch && self.assets.http_allowlist.is_empty() {
            warnings.push(
                "assets.allow-http-fetch is on with an empty allowlist, which lets a client make the engine fetch any URL"
                    .to_string(),
            );
        }

        // An adapter needing a vendor SDK that was not compiled in cannot work.
        for adapter in &self.outputs.enabled_adapters {
            if adapter == "ndi" && !cfg!(feature = "ndi") {
                warnings.push(
                    "outputs.enabled-adapters lists \"ndi\" but the engine was built without --features ndi; the adapter will report itself unavailable"
                        .to_string(),
                );
            }
            if adapter == "decklink" || adapter == "aja" {
                warnings.push(format!(
                    "outputs.enabled-adapters lists \"{adapter}\", which is declared but not implemented; it will report itself unavailable"
                ));
            }
        }

        let tile_footprint = self
            .stage
            .default_tile_width
            .max(self.stage.default_tile_height)
            + self.stage.default_overscan * 2;
        if tile_footprint > 8192 {
            warnings.push(format!(
                "default tile plus overscan is {tile_footprint}px, which exceeds the texture limit of many GPUs"
            ));
        }

        Ok(warnings)
    }

    /// Resolve the token signing key from `signing_secret` or `signing_secret_file`.
    ///
    /// Returns the raw key bytes. The engine only ever *verifies* with this - it has no code
    /// path that mints a token, so a compromised engine cannot issue authority to itself.
    pub fn resolve_signing_key(&self) -> Result<Option<Vec<u8>>, ConfigError> {
        if let Some(secret) = &self.auth.signing_secret {
            return Ok(Some(validate_signing_secret(secret)?.into_bytes()));
        }
        if let Some(path) = &self.auth.signing_secret_file {
            let text = fs::read_to_string(path).map_err(|source| ConfigError::Read {
                path: PathBuf::from(path),
                source,
            })?;
            return Ok(Some(validate_signing_secret(text.trim())?.into_bytes()));
        }
        Ok(None)
    }

    /// Render the effective configuration, for `--print-config`.
    ///
    /// Exists so an operator can confirm what the layered precedence actually
    /// produced rather than reasoning about it.
    pub fn to_toml(&self) -> String {
        toml::to_string_pretty(self).unwrap_or_else(|error| {
            let mut text = String::new();
            let _ = writeln!(&mut text, "# failed to serialise config: {error}");
            text
        })
    }
}

/// A signing key shorter than this is not worth the HMAC around it.
///
/// 32 characters matches the minimum the TypeScript issuer enforces, so a secret that works
/// on one side cannot be silently rejected on the other.
fn validate_signing_secret(secret: &str) -> Result<String, ConfigError> {
    let trimmed = secret.trim();
    if trimmed.len() < 32 {
        return Err(ConfigError::Invalid(
            "the auth signing secret must be at least 32 characters".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn parse_bool(value: &str, key: &str) -> Result<bool, ConfigError> {
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(ConfigError::InvalidValue(
            value.to_string(),
            key.to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CliOptions {
    pub config_path: Option<PathBuf>,
    pub bind: Option<String>,
    pub port: Option<u16>,
    pub engine_id: Option<String>,
    pub name: Option<String>,
    pub headless: Option<bool>,
    pub preferred_gpu: Option<String>,
    pub preferred_backend: Option<String>,
    pub signing_secret_file: Option<String>,
    pub ipc: Option<String>,
    pub log_level: Option<String>,
    pub tile_size: Option<u32>,
    pub print_config: bool,
    pub help: bool,
    pub version: bool,
}

pub const USAGE: &str = "\
grapix-render-engine — GrapiX standalone render engine

USAGE:
    grapix-render-engine --config engine.toml [OPTIONS]

OPTIONS:
    -c, --config <PATH>        Configuration file (TOML)
        --bind <ADDRESS>       Bind address (default 127.0.0.1)
        --port <PORT>          WebSocket port (default 4400)
        --ipc <ENDPOINT>       Local IPC endpoint for an embedded engine
        --engine-id <ID>       Override the engine id
        --name <NAME>          Override the operator-facing engine name
        --headless <BOOL>      Run without a window or surface (default true)
        --preferred-gpu <STR>  Adapter name substring to prefer
        --preferred-backend <B> vulkan | dx12 | metal | gl
        --signing-secret-file <PATH>  File containing the token signing secret
        --tile-size <PIXELS>   Default tile edge length
        --log-level <LEVEL>    error | warn | info | debug | trace
        --print-config         Print the effective configuration and exit
    -h, --help                 Print this help and exit
    -V, --version              Print the version and exit

PRECEDENCE:
    CLI argument > environment variable > TOML file > built-in default

ENVIRONMENT:
    GRAPIX_ENGINE_BIND, GRAPIX_ENGINE_PORT, GRAPIX_ENGINE_AUTH_SECRET,
    GRAPIX_ENGINE_AUTH_SECRET_FILE, GRAPIX_ENGINE_HEADLESS, GRAPIX_ENGINE_ID,
    GRAPIX_ENGINE_NAME, GRAPIX_ENGINE_IPC, GRAPIX_ENGINE_PREFERRED_GPU,
    GRAPIX_ENGINE_PREFERRED_BACKEND, GRAPIX_ENGINE_TILE_SIZE,
    GRAPIX_ENGINE_TILE_CACHE_BYTES, GRAPIX_ENGINE_GPU_BUDGET_BYTES,
    GRAPIX_ENGINE_ASSET_ROOTS, GRAPIX_ENGINE_ASSET_CACHE_DIR,
    GRAPIX_ENGINE_PREVIEW_MAX_PIXELS, GRAPIX_ENGINE_ENABLED_ADAPTERS,
    GRAPIX_ENGINE_LOG_LEVEL
";

/// Parse arguments.
///
/// Hand-rolled rather than pulling in a parser crate: the surface is small, and
/// unknown flags must be a hard error so a typo in a deployment script does not
/// silently start an engine with the wrong port.
pub fn parse_cli(args: &[String]) -> Result<CliOptions, ConfigError> {
    let mut options = CliOptions::default();
    let mut index = 0;

    while index < args.len() {
        let argument = args[index].as_str();

        let mut take_value = |name: &str| -> Result<String, ConfigError> {
            index += 1;
            args.get(index)
                .cloned()
                .ok_or_else(|| ConfigError::Invalid(format!("{name} requires a value")))
        };

        match argument {
            "-h" | "--help" => options.help = true,
            "-V" | "--version" => options.version = true,
            "--print-config" => options.print_config = true,
            "-c" | "--config" => options.config_path = Some(PathBuf::from(take_value(argument)?)),
            "--bind" => options.bind = Some(take_value(argument)?),
            "--port" => {
                let value = take_value(argument)?;
                options.port =
                    Some(value.parse().map_err(|_| {
                        ConfigError::InvalidValue(value.clone(), "--port".to_string())
                    })?);
            }
            "--ipc" => options.ipc = Some(take_value(argument)?),
            "--engine-id" => options.engine_id = Some(take_value(argument)?),
            "--name" => options.name = Some(take_value(argument)?),
            "--headless" => {
                let value = take_value(argument)?;
                options.headless = Some(parse_bool(&value, "--headless")?);
            }
            "--preferred-gpu" => options.preferred_gpu = Some(take_value(argument)?),
            "--preferred-backend" => options.preferred_backend = Some(take_value(argument)?),
            "--signing-secret-file" => options.signing_secret_file = Some(take_value(argument)?),
            "--log-level" => options.log_level = Some(take_value(argument)?),
            "--tile-size" => {
                let value = take_value(argument)?;
                options.tile_size = Some(value.parse().map_err(|_| {
                    ConfigError::InvalidValue(value.clone(), "--tile-size".to_string())
                })?);
            }
            other => {
                return Err(ConfigError::Invalid(format!(
                    "unknown argument {other}. Run --help for usage."
                )));
            }
        }

        index += 1;
    }

    Ok(options)
}

/// Load configuration through the full precedence chain.
///
/// The one entry point, so no code path can accidentally skip a layer.
pub fn load(
    cli: &CliOptions,
    env: &BTreeMap<String, String>,
) -> Result<(EngineConfig, Vec<String>), ConfigError> {
    let mut config = match &cli.config_path {
        Some(path) => EngineConfig::from_file(path)?,
        None => EngineConfig::default(),
    };

    config.apply_env(env)?;
    config.apply_cli(cli);
    let warnings = config.validate()?;

    Ok((config, warnings))
}

/// Read the process environment into the map `apply_env` expects.
pub fn process_env() -> BTreeMap<String, String> {
    std::env::vars()
        .filter(|(key, _)| key.starts_with(ENGINE_ENV_PREFIX))
        .collect()
}
