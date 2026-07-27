//! Renderer quality profiles and resource-governor limits.

use serde::{Deserialize, Serialize};

use crate::config::OutputConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QualityProfile {
    EditorPreview,
    ProgramHd,
    ProgramUhd,
    LowLatency,
    SafeMode,
}

impl Default for QualityProfile {
    fn default() -> Self {
        Self::ProgramHd
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimits {
    pub max_output_width: u32,
    pub max_output_height: u32,
    pub max_frame_rate: u32,
    pub max_warm_scenes: usize,
    pub max_prepared_scene_bytes: u64,
    pub max_prepared_cache_bytes: u64,
    pub max_decoded_cpu_cache_bytes: u64,
    pub max_gpu_asset_cache_bytes: u64,
    pub max_texture_dimension: u32,
    pub max_video_decoders: usize,
    pub max_render_targets: usize,
    pub max_triangles: usize,
    pub max_meshes: usize,
    pub max_materials: usize,
    pub max_lights: usize,
    pub max_animation_bones: usize,
    pub max_transparent_objects: usize,
    pub preview_scale: f32,
    pub antialiasing: bool,
    pub mipmaps: bool,
    pub shadow_quality: String,
    pub effect_quality: String,
    pub diagnostics_level: String,
    pub thumbnail_rendering: bool,
    pub background_proxy_work: bool,
}

impl QualityProfile {
    pub fn limits(self) -> ResourceLimits {
        const MIB: u64 = 1024 * 1024;
        match self {
            QualityProfile::EditorPreview => ResourceLimits {
                max_output_width: 1280,
                max_output_height: 720,
                max_frame_rate: 60,
                max_warm_scenes: 1,
                max_prepared_scene_bytes: 64 * MIB,
                max_prepared_cache_bytes: 128 * MIB,
                max_decoded_cpu_cache_bytes: 256 * MIB,
                max_gpu_asset_cache_bytes: 256 * MIB,
                max_texture_dimension: 4096,
                max_video_decoders: 1,
                max_render_targets: 4,
                max_triangles: 250_000,
                max_meshes: 128,
                max_materials: 128,
                max_lights: 8,
                max_animation_bones: 256,
                max_transparent_objects: 64,
                preview_scale: 0.5,
                antialiasing: true,
                mipmaps: true,
                shadow_quality: "preview".to_string(),
                effect_quality: "preview".to_string(),
                diagnostics_level: "normal".to_string(),
                thumbnail_rendering: true,
                background_proxy_work: true,
            },
            QualityProfile::ProgramHd => ResourceLimits {
                max_output_width: 1920,
                max_output_height: 1080,
                max_frame_rate: 60,
                max_warm_scenes: 3,
                max_prepared_scene_bytes: 256 * MIB,
                max_prepared_cache_bytes: 768 * MIB,
                max_decoded_cpu_cache_bytes: 1024 * MIB,
                max_gpu_asset_cache_bytes: 1536 * MIB,
                max_texture_dimension: 8192,
                max_video_decoders: 4,
                max_render_targets: 8,
                max_triangles: 1_000_000,
                max_meshes: 256,
                max_materials: 256,
                max_lights: 16,
                max_animation_bones: 512,
                max_transparent_objects: 128,
                preview_scale: 0.5,
                antialiasing: true,
                mipmaps: true,
                shadow_quality: "full".to_string(),
                effect_quality: "full".to_string(),
                diagnostics_level: "normal".to_string(),
                thumbnail_rendering: false,
                background_proxy_work: false,
            },
            QualityProfile::ProgramUhd => ResourceLimits {
                max_output_width: 3840,
                max_output_height: 2160,
                max_frame_rate: 60,
                max_warm_scenes: 1,
                max_prepared_scene_bytes: 512 * MIB,
                max_prepared_cache_bytes: 1024 * MIB,
                max_decoded_cpu_cache_bytes: 1024 * MIB,
                max_gpu_asset_cache_bytes: 2048 * MIB,
                max_texture_dimension: 16384,
                max_video_decoders: 2,
                max_render_targets: 6,
                max_triangles: 500_000,
                max_meshes: 128,
                max_materials: 128,
                max_lights: 8,
                max_animation_bones: 256,
                max_transparent_objects: 64,
                preview_scale: 0.25,
                antialiasing: true,
                mipmaps: true,
                shadow_quality: "reduced".to_string(),
                effect_quality: "full".to_string(),
                diagnostics_level: "normal".to_string(),
                thumbnail_rendering: false,
                background_proxy_work: false,
            },
            QualityProfile::LowLatency => ResourceLimits {
                max_output_width: 1920,
                max_output_height: 1080,
                max_frame_rate: 60,
                max_warm_scenes: 1,
                max_prepared_scene_bytes: 128 * MIB,
                max_prepared_cache_bytes: 384 * MIB,
                max_decoded_cpu_cache_bytes: 512 * MIB,
                max_gpu_asset_cache_bytes: 768 * MIB,
                max_texture_dimension: 8192,
                max_video_decoders: 2,
                max_render_targets: 4,
                max_triangles: 300_000,
                max_meshes: 128,
                max_materials: 128,
                max_lights: 8,
                max_animation_bones: 256,
                max_transparent_objects: 48,
                preview_scale: 0.25,
                antialiasing: false,
                mipmaps: true,
                shadow_quality: "off".to_string(),
                effect_quality: "reduced".to_string(),
                diagnostics_level: "minimal".to_string(),
                thumbnail_rendering: false,
                background_proxy_work: false,
            },
            QualityProfile::SafeMode => ResourceLimits {
                max_output_width: 1280,
                max_output_height: 720,
                max_frame_rate: 30,
                max_warm_scenes: 0,
                max_prepared_scene_bytes: 64 * MIB,
                max_prepared_cache_bytes: 128 * MIB,
                max_decoded_cpu_cache_bytes: 128 * MIB,
                max_gpu_asset_cache_bytes: 256 * MIB,
                max_texture_dimension: 4096,
                max_video_decoders: 1,
                max_render_targets: 2,
                max_triangles: 100_000,
                max_meshes: 64,
                max_materials: 64,
                max_lights: 4,
                max_animation_bones: 128,
                max_transparent_objects: 16,
                preview_scale: 0.25,
                antialiasing: false,
                mipmaps: false,
                shadow_quality: "off".to_string(),
                effect_quality: "safe".to_string(),
                diagnostics_level: "high".to_string(),
                thumbnail_rendering: false,
                background_proxy_work: false,
            },
        }
    }
}

pub struct ResourceGovernor {
    profile: QualityProfile,
}

impl ResourceGovernor {
    pub fn new(profile: QualityProfile) -> Self {
        Self { profile }
    }

    pub fn profile(&self) -> QualityProfile {
        self.profile
    }

    pub fn limits(&self) -> ResourceLimits {
        self.profile.limits()
    }

    pub fn set_profile(&mut self, profile: QualityProfile) -> ResourceLimits {
        self.profile = profile;
        self.limits()
    }

    pub fn validate_output(&self, config: &OutputConfig) -> Result<(), String> {
        let limits = self.limits();
        if config.width > limits.max_output_width || config.height > limits.max_output_height {
            return Err(format!(
                "{:?} limits output to {}x{}, got {}x{}",
                self.profile,
                limits.max_output_width,
                limits.max_output_height,
                config.width,
                config.height
            ));
        }
        if u64::from(config.frame_rate.numerator)
            > u64::from(limits.max_frame_rate) * u64::from(config.frame_rate.denominator)
        {
            return Err(format!(
                "{:?} limits output to {} fps, got {}/{}",
                self.profile,
                limits.max_frame_rate,
                config.frame_rate.numerator,
                config.frame_rate.denominator
            ));
        }
        Ok(())
    }

    pub fn validate_prepared_scene(&self, estimated_bytes: u64) -> Result<(), String> {
        let limit = self.limits().max_prepared_scene_bytes;
        if estimated_bytes > limit {
            return Err(format!(
                "prepared scene estimate {estimated_bytes} bytes exceeds {:?} per-scene limit {limit} bytes",
                self.profile
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::config::{AlphaMode, ColorFormat, ColorSpace, FrameRate, OutputBackend, ScanMode};

    use super::*;

    fn output(width: u32, height: u32, fps: u32) -> OutputConfig {
        OutputConfig {
            width,
            height,
            frame_rate: FrameRate {
                numerator: fps,
                denominator: 1,
            },
            scan_mode: ScanMode::Progressive,
            alpha_mode: AlphaMode::Premultiplied,
            color_format: ColorFormat::Bgra8,
            color_space: ColorSpace::Srgb,
            ndi_source_name: "test".to_string(),
            recording_name: "test-recording".to_string(),
            backend: OutputBackend::Null,
        }
    }

    #[test]
    fn program_hd_rejects_uhd_but_program_uhd_accepts_it() {
        let hd = ResourceGovernor::new(QualityProfile::ProgramHd);
        assert!(hd.validate_output(&output(3840, 2160, 60)).is_err());

        let uhd = ResourceGovernor::new(QualityProfile::ProgramUhd);
        assert!(uhd.validate_output(&output(3840, 2160, 60)).is_ok());
    }

    #[test]
    fn safe_mode_enforces_resolution_and_frame_rate() {
        let safe = ResourceGovernor::new(QualityProfile::SafeMode);
        assert!(safe.validate_output(&output(1280, 720, 30)).is_ok());
        assert!(safe.validate_output(&output(1920, 1080, 30)).is_err());
        assert!(safe.validate_output(&output(1280, 720, 60)).is_err());
    }
}
