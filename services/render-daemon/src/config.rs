//! Daemon and output configuration, including broadcast format validation.

use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Daemon process configuration, sourced from environment variables.
#[derive(Clone)]
pub struct DaemonConfig {
    pub host: String,
    pub port: u16,
    pub auth_token: String,
    pub allowed_origins: Vec<String>,
}

impl DaemonConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let host =
            std::env::var("GRAPIX_RENDER_DAEMON_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = match std::env::var("GRAPIX_RENDER_DAEMON_PORT") {
            Ok(raw) => raw
                .parse::<u16>()
                .map_err(|_| ConfigError::InvalidEnv("GRAPIX_RENDER_DAEMON_PORT", raw))?,
            Err(_) => 4200,
        };
        let auth_token = load_or_create_auth_token()?;
        let allowed_origins = comma_separated_env("GRAPIX_RENDER_DAEMON_ALLOWED_ORIGINS");

        Ok(Self {
            host,
            port,
            auth_token,
            allowed_origins,
        })
    }
}

fn load_or_create_auth_token() -> Result<String, ConfigError> {
    if let Ok(token) = std::env::var("GRAPIX_RENDER_DAEMON_TOKEN") {
        return validate_auth_token(token, "GRAPIX_RENDER_DAEMON_TOKEN");
    }

    let path = std::env::var_os("GRAPIX_RENDER_DAEMON_TOKEN_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(default_auth_token_path);

    match fs::read_to_string(&path) {
        Ok(token) => validate_auth_token(token, path.display().to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_auth_token(&path),
        Err(source) => Err(ConfigError::AuthTokenFile {
            action: "read",
            path,
            source,
        }),
    }
}

fn create_auth_token(path: &Path) -> Result<String, ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| ConfigError::AuthTokenFile {
            action: "create parent directory for",
            path: path.to_path_buf(),
            source,
        })?;
    }

    let mut random_bytes = [0u8; 32];
    getrandom::fill(&mut random_bytes).map_err(ConfigError::AuthTokenGeneration)?;
    let mut token = String::with_capacity(random_bytes.len() * 2);

    for byte in random_bytes {
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    match options.open(path) {
        Ok(mut file) => {
            file.write_all(token.as_bytes())
                .and_then(|()| file.write_all(b"\n"))
                .map_err(|source| ConfigError::AuthTokenFile {
                    action: "write",
                    path: path.to_path_buf(),
                    source,
                })?;
            Ok(token)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let token = fs::read_to_string(path).map_err(|source| ConfigError::AuthTokenFile {
                action: "read",
                path: path.to_path_buf(),
                source,
            })?;
            validate_auth_token(token, path.display().to_string())
        }
        Err(source) => Err(ConfigError::AuthTokenFile {
            action: "create",
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn default_auth_token_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/render-daemon.token")
}

fn validate_auth_token(
    token: String,
    token_source: impl Into<String>,
) -> Result<String, ConfigError> {
    let token = token.trim().to_string();
    let valid = token.len() >= 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'));

    if !valid {
        return Err(ConfigError::InvalidAuthToken {
            token_source: token_source.into(),
        });
    }

    Ok(token)
}

fn comma_separated_env(name: &'static str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

/// Exact rational frame rate. 59.94 fps is `60000/1001`, never a float.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

impl FrameRate {
    /// Duration of one frame in nanoseconds, rounded down.
    pub fn frame_duration_nanos(&self) -> u128 {
        1_000_000_000u128 * u128::from(self.denominator) / u128::from(self.numerator)
    }

    /// Nanosecond timestamp (relative to a start instant) of frame `index`,
    /// computed with integer math so 60000/1001 never drifts.
    pub fn frame_deadline_nanos(&self, index: u64) -> u128 {
        u128::from(index) * 1_000_000_000u128 * u128::from(self.denominator)
            / u128::from(self.numerator)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanMode {
    /// Progressive — the only mode the v1 renderer produces.
    #[serde(rename = "p")]
    Progressive,
    /// Interlaced — accepted by the protocol, rejected by validation until
    /// field rendering exists. Kept in the model so 1080i50 etc. are
    /// representable.
    #[serde(rename = "i")]
    Interlaced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlphaMode {
    /// The shader contract renders premultiplied; see
    /// packages/render-shaders/docs/shader-contract.md.
    Premultiplied,
    /// Straight alpha would require an un-premultiply pass; rejected in v1.
    Straight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColorFormat {
    /// 8-bit BGRA, sRGB-encoded bytes — matches the render target and NDI BGRA.
    #[serde(rename = "bgra8")]
    Bgra8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorSpace {
    /// sRGB primaries + transfer. Rec.709 handling is future contract work.
    Srgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputBackend {
    Ndi,
    Null,
}

/// Validated broadcast output configuration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputConfig {
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
    pub scan_mode: ScanMode,
    pub alpha_mode: AlphaMode,
    pub color_format: ColorFormat,
    pub color_space: ColorSpace,
    pub ndi_source_name: String,
    pub backend: OutputBackend,
}

/// Raw `output.configure` payload before validation. Field names match the
/// wire protocol (camelCase JSON).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputConfigMessage {
    pub width: u32,
    pub height: u32,
    pub frame_rate_numerator: u32,
    pub frame_rate_denominator: u32,
    #[serde(default = "default_scan_mode")]
    pub scan_mode: ScanMode,
    #[serde(default = "default_alpha_mode")]
    pub alpha_mode: AlphaMode,
    #[serde(default = "default_color_format")]
    pub color_format: ColorFormat,
    #[serde(default = "default_color_space")]
    pub color_space: ColorSpace,
    #[serde(default = "default_ndi_source_name")]
    pub ndi_source_name: String,
    #[serde(default)]
    pub backend: Option<OutputBackend>,
}

fn default_scan_mode() -> ScanMode {
    ScanMode::Progressive
}

fn default_alpha_mode() -> AlphaMode {
    AlphaMode::Premultiplied
}

fn default_color_format() -> ColorFormat {
    ColorFormat::Bgra8
}

fn default_color_space() -> ColorSpace {
    ColorSpace::Srgb
}

fn default_ndi_source_name() -> String {
    "GrapiX Output".to_string()
}

/// Largest dimension the v1 readback path is sized for (covers UHD).
pub const MAX_DIMENSION: u32 = 4320;
/// Practical output clock range. This keeps control operations responsive and
/// rejects abusive rates while covering broadcast, preview, and slow diagnostics.
pub const MIN_FRAME_RATE: u32 = 1;
pub const MAX_FRAME_RATE: u32 = 240;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("environment variable {0} has invalid value {1:?}")]
    InvalidEnv(&'static str, String),
    #[error("render daemon authentication token from {token_source} must be at least 32 characters and contain only URL-safe characters")]
    InvalidAuthToken { token_source: String },
    #[error("failed to {action} render daemon authentication token file {path}: {source}")]
    AuthTokenFile {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to generate render daemon authentication token: {0}")]
    AuthTokenGeneration(getrandom::Error),
    #[error("width and height must be positive (got {width}x{height})")]
    InvalidDimensions { width: u32, height: u32 },
    #[error("width and height must not exceed {MAX_DIMENSION} (got {width}x{height})")]
    DimensionsTooLarge { width: u32, height: u32 },
    #[error(
        "frame rate must have positive numerator and denominator (got {numerator}/{denominator})"
    )]
    InvalidFrameRate { numerator: u32, denominator: u32 },
    #[error("frame rate must be between {MIN_FRAME_RATE} and {MAX_FRAME_RATE} fps (got {numerator}/{denominator})")]
    FrameRateOutOfRange { numerator: u32, denominator: u32 },
    #[error(
        "interlaced output is not supported yet; only progressive (\"p\") scan mode renders in v1"
    )]
    InterlacedUnsupported,
    #[error("straight alpha is not supported yet; the v1 pipeline is premultiplied end-to-end")]
    StraightAlphaUnsupported,
    #[error("ndiSourceName must not be empty")]
    EmptyNdiSourceName,
    #[error("NDI backend requested but this daemon was compiled without the `ndi` feature; rebuild with `cargo build --features ndi` (requires the NDI SDK)")]
    NdiUnavailable,
}

impl OutputConfig {
    /// Validate a raw protocol message into a usable configuration.
    ///
    /// Unsupported broadcast modes are rejected with explicit errors rather
    /// than silently coerced — 1080i50 must fail loudly, not render as 1080p50.
    pub fn from_message(message: OutputConfigMessage) -> Result<Self, ConfigError> {
        if message.width == 0 || message.height == 0 {
            return Err(ConfigError::InvalidDimensions {
                width: message.width,
                height: message.height,
            });
        }

        if message.width > MAX_DIMENSION || message.height > MAX_DIMENSION {
            return Err(ConfigError::DimensionsTooLarge {
                width: message.width,
                height: message.height,
            });
        }

        if message.frame_rate_numerator == 0 || message.frame_rate_denominator == 0 {
            return Err(ConfigError::InvalidFrameRate {
                numerator: message.frame_rate_numerator,
                denominator: message.frame_rate_denominator,
            });
        }

        let numerator = u128::from(message.frame_rate_numerator);
        let denominator = u128::from(message.frame_rate_denominator);
        if numerator < denominator * u128::from(MIN_FRAME_RATE)
            || numerator > denominator * u128::from(MAX_FRAME_RATE)
        {
            return Err(ConfigError::FrameRateOutOfRange {
                numerator: message.frame_rate_numerator,
                denominator: message.frame_rate_denominator,
            });
        }

        if message.scan_mode == ScanMode::Interlaced {
            return Err(ConfigError::InterlacedUnsupported);
        }

        if message.alpha_mode == AlphaMode::Straight {
            return Err(ConfigError::StraightAlphaUnsupported);
        }

        if message.ndi_source_name.trim().is_empty() {
            return Err(ConfigError::EmptyNdiSourceName);
        }

        let backend = match message.backend {
            Some(backend) => backend,
            None => {
                if cfg!(feature = "ndi") {
                    OutputBackend::Ndi
                } else {
                    OutputBackend::Null
                }
            }
        };

        if backend == OutputBackend::Ndi && !cfg!(feature = "ndi") {
            return Err(ConfigError::NdiUnavailable);
        }

        Ok(Self {
            width: message.width,
            height: message.height,
            frame_rate: FrameRate {
                numerator: message.frame_rate_numerator,
                denominator: message.frame_rate_denominator,
            },
            scan_mode: message.scan_mode,
            alpha_mode: message.alpha_mode,
            color_format: message.color_format,
            color_space: message.color_space,
            ndi_source_name: message.ndi_source_name,
            backend,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_message() -> OutputConfigMessage {
        OutputConfigMessage {
            width: 1920,
            height: 1080,
            frame_rate_numerator: 50,
            frame_rate_denominator: 1,
            scan_mode: ScanMode::Progressive,
            alpha_mode: AlphaMode::Premultiplied,
            color_format: ColorFormat::Bgra8,
            color_space: ColorSpace::Srgb,
            ndi_source_name: "GrapiX Output".to_string(),
            backend: Some(OutputBackend::Null),
        }
    }

    #[test]
    fn accepts_1080p50() {
        let config = OutputConfig::from_message(base_message()).expect("1080p50 must validate");
        assert_eq!(config.width, 1920);
        assert_eq!(
            config.frame_rate,
            FrameRate {
                numerator: 50,
                denominator: 1
            }
        );
    }

    #[test]
    fn accepts_1080p5994_as_rational() {
        let message = OutputConfigMessage {
            frame_rate_numerator: 60000,
            frame_rate_denominator: 1001,
            ..base_message()
        };
        let config =
            OutputConfig::from_message(message).expect("59.94 must validate as 60000/1001");
        // 60000/1001 -> 16_683_333ns per frame; exact integer math, no float.
        assert_eq!(config.frame_rate.frame_duration_nanos(), 16_683_333);
        // 60000 frames land exactly on 1001 seconds — the rational clock must not drift.
        assert_eq!(
            config.frame_rate.frame_deadline_nanos(60000),
            1001 * 1_000_000_000
        );
    }

    #[test]
    fn rejects_interlaced() {
        let message = OutputConfigMessage {
            scan_mode: ScanMode::Interlaced,
            ..base_message()
        };
        assert!(matches!(
            OutputConfig::from_message(message),
            Err(ConfigError::InterlacedUnsupported)
        ));
    }

    #[test]
    fn rejects_straight_alpha() {
        let message = OutputConfigMessage {
            alpha_mode: AlphaMode::Straight,
            ..base_message()
        };
        assert!(matches!(
            OutputConfig::from_message(message),
            Err(ConfigError::StraightAlphaUnsupported)
        ));
    }

    #[test]
    fn rejects_zero_dimensions() {
        let message = OutputConfigMessage {
            width: 0,
            ..base_message()
        };
        assert!(matches!(
            OutputConfig::from_message(message),
            Err(ConfigError::InvalidDimensions { .. })
        ));
    }

    #[test]
    fn rejects_zero_frame_rate() {
        let message = OutputConfigMessage {
            frame_rate_numerator: 0,
            ..base_message()
        };
        assert!(matches!(
            OutputConfig::from_message(message),
            Err(ConfigError::InvalidFrameRate { .. })
        ));
    }

    #[test]
    fn rejects_frame_rate_below_one_fps() {
        let message = OutputConfigMessage {
            frame_rate_numerator: 1,
            frame_rate_denominator: 10,
            ..base_message()
        };
        assert!(matches!(
            OutputConfig::from_message(message),
            Err(ConfigError::FrameRateOutOfRange { .. })
        ));
    }

    #[test]
    fn rejects_frame_rate_above_240_fps() {
        let message = OutputConfigMessage {
            frame_rate_numerator: 241,
            frame_rate_denominator: 1,
            ..base_message()
        };
        assert!(matches!(
            OutputConfig::from_message(message),
            Err(ConfigError::FrameRateOutOfRange { .. })
        ));
    }

    #[test]
    fn validates_auth_tokens() {
        assert!(validate_auth_token("a".repeat(32), "test").is_ok());
        assert!(matches!(
            validate_auth_token("too-short".to_string(), "test"),
            Err(ConfigError::InvalidAuthToken { .. })
        ));
        assert!(matches!(
            validate_auth_token(format!("{}!", "a".repeat(32)), "test"),
            Err(ConfigError::InvalidAuthToken { .. })
        ));
    }

    #[test]
    fn rejects_empty_ndi_name() {
        let message = OutputConfigMessage {
            ndi_source_name: "  ".to_string(),
            ..base_message()
        };
        assert!(matches!(
            OutputConfig::from_message(message),
            Err(ConfigError::EmptyNdiSourceName)
        ));
    }

    #[test]
    fn ndi_backend_requires_feature() {
        let message = OutputConfigMessage {
            backend: Some(OutputBackend::Ndi),
            ..base_message()
        };
        let result = OutputConfig::from_message(message);

        if cfg!(feature = "ndi") {
            assert!(result.is_ok());
        } else {
            assert!(matches!(result, Err(ConfigError::NdiUnavailable)));
        }
    }
}
