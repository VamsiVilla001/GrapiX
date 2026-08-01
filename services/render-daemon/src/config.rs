//! Output configuration and broadcast format validation.
//!
//! The daemon process config that used to live here — bind host, port 4200, auth token and
//! allowed origins — went with the retired binary. Nothing called `DaemonConfig::from_env`
//! once the transport was gone, and leaving it meant the repository still carried a default
//! port for a renderer that must not exist. The engine configures itself from
//! `services/render-engine/engine.toml`.

use serde::{Deserialize, Serialize};

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
    /// Shared/render-shaders/docs/shader-contract.md.
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
    Recording,
    Decklink,
    Aja,
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
    pub recording_name: String,
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
    #[serde(default = "default_recording_name")]
    pub recording_name: String,
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

fn default_recording_name() -> String {
    "grapix-recording".to_string()
}

/// Largest dimension the v1 readback path is sized for (covers UHD).
pub const MAX_DIMENSION: u32 = 4320;
/// Practical output clock range. This keeps control operations responsive and
/// rejects abusive rates while covering broadcast, preview, and slow diagnostics.
pub const MIN_FRAME_RATE: u32 = 1;
pub const MAX_FRAME_RATE: u32 = 240;

/// Every variant is an output-format rejection.
///
/// The environment and authentication-token variants went with the retired daemon binary:
/// output validation is all this crate configures now.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
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
    #[error("recordingName must contain only letters, numbers, underscore, or hyphen")]
    InvalidRecordingName,
    #[error("NDI backend requested but this daemon was compiled without the `ndi` feature; rebuild with `cargo build --features ndi` (requires the NDI SDK)")]
    NdiUnavailable,
    #[error("{0} output requires its vendor SDK/plugin and is not available in this build")]
    VendorOutputUnavailable(&'static str),
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
        if !is_safe_recording_name(&message.recording_name) {
            return Err(ConfigError::InvalidRecordingName);
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
        match backend {
            OutputBackend::Decklink => {
                return Err(ConfigError::VendorOutputUnavailable("DeckLink"));
            }
            OutputBackend::Aja => {
                return Err(ConfigError::VendorOutputUnavailable("AJA"));
            }
            _ => {}
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
            recording_name: message.recording_name,
            backend,
        })
    }
}

fn is_safe_recording_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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
            recording_name: "test-recording".to_string(),
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
