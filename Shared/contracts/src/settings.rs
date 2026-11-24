//! Application settings (build plan 2.28): what the Editor and Playout read, typed, with defaults,
//! ranges and a schema version.
//!
//! Three scopes, decided from how Ross XPression's Preferences and the Windows settings guidance
//! group things (research, 23 Nov 2026):
//!
//! - **User** ([`UserSettings`]): what follows a person between machines (language, confirmations,
//!   the defaults a new animation starts with, what Start does). Kept in the roaming data folder.
//! - **Machine** ([`MachineSettings`]): what belongs to this computer (GPU adapter, caches, process
//!   priority, log level, where the control server listens). Kept in the local data folder.
//! - **Project**: everything that changes what a graphic *renders as* (mode, colour space, bit
//!   depth, fonts, safe areas) stays in the project's `.gpx` ([`crate::project::ProjectSettings`]),
//!   never here: a Preferences change must not be able to change a graphic on air.
//!
//! Unknown fields refuse rather than drop (a setting written by a newer build and read by an older
//! one would vanish on the next save), and a value outside its range refuses by name with the key.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The settings document schema this build writes and reads.
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// Which file a setting lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SettingsScope {
    User,
    Machine,
}

impl SettingsScope {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Machine => "machine",
        }
    }
}

/// What the Editor does at start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StartupBehaviour {
    /// Show Start, which lists the recent projects.
    ShowStart,
    /// Open the project that was open last, if its `.gpx` is still there.
    ReopenLast,
}

/// The easing a new keyframe starts with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DefaultInterpolation {
    Linear,
    EaseInOut,
    Bezier,
}

/// The priority the engine's process runs at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProcessPriority {
    Normal,
    AboveNormal,
    High,
}

/// How much the logs say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

/// What follows a person: the Editor's and Playout's own behaviour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserSettings {
    /// The interface language as a BCP 47 tag (`en`, `en-GB`, `hi`). Which translations exist is
    /// 11.91; the tag is validated, not looked up.
    pub language: String,
    /// Ask before deleting objects, scenes or projects' scenes.
    pub confirm_deletes: bool,
    /// The length a new scene's timeline starts with, in frames.
    pub default_animation_frames: u32,
    pub default_interpolation: DefaultInterpolation,
    pub startup: StartupBehaviour,
    /// The folder the last file picker was in, so the next one opens there. Empty for none.
    pub last_used_folder: String,
    /// The step Shift holds the Pen's points and handles to, in degrees (11.116): 15 as After
    /// Effects does, 45 as Illustrator does, or any whole number from 1 to 90.
    #[serde(default = "default_pen_angle_step")]
    pub pen_angle_step: u32,
    /// How near, in screen pixels, the pointer must be to take a vertex, a handle or a curve (11.116).
    #[serde(default = "default_pen_pick_radius")]
    pub pen_pick_radius: u32,
    /// Whether a double click ends the path the Pen is drawing (11.116); Enter and Escape always do.
    #[serde(default = "default_pen_double_click_ends")]
    pub pen_double_click_ends: bool,
    /// Whether the Pen and the path tools snap points to the canvas, other layers and other vertices (11.110);
    /// holding Ctrl turns it off for a gesture.
    #[serde(default = "default_pen_snap")]
    pub pen_snap: bool,
    /// How far, in path pixels, Remove Point Keep Shape may let the curve move from the old shape (11.113). 1 pixel.
    #[serde(default = "default_pen_fit_tolerance")]
    pub pen_fit_tolerance: u32,
}

fn default_pen_fit_tolerance() -> u32 {
    1
}

fn default_pen_snap() -> bool {
    true
}

fn default_pen_angle_step() -> u32 {
    15
}

fn default_pen_pick_radius() -> u32 {
    8
}

fn default_pen_double_click_ends() -> bool {
    true
}

/// What belongs to this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineSettings {
    /// The GPU adapter to render on, by name; empty lets the engine choose.
    pub gpu_adapter: String,
    pub anti_alias: bool,
    /// The texture and image cache's memory limit, in MiB.
    pub texture_cache_mb: u32,
    /// Where the on-disk cache lives; empty is the platform cache folder.
    pub disk_cache_path: String,
    /// The on-disk cache's size limit, in MiB.
    pub disk_cache_max_mb: u32,
    pub process_priority: ProcessPriority,
    pub log_level: LogLevel,
    /// Where the control server (6.7) listens. The credential is not a setting: it is a token
    /// the operator holds (2.9), never written into a settings file.
    pub control_address: String,
    pub control_port: u16,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            language: "en".to_owned(),
            confirm_deletes: true,
            default_animation_frames: 250,
            default_interpolation: DefaultInterpolation::EaseInOut,
            startup: StartupBehaviour::ShowStart,
            last_used_folder: String::new(),
            pen_angle_step: default_pen_angle_step(),
            pen_pick_radius: default_pen_pick_radius(),
            pen_double_click_ends: default_pen_double_click_ends(),
            pen_snap: default_pen_snap(),
            pen_fit_tolerance: default_pen_fit_tolerance(),
        }
    }
}

impl Default for MachineSettings {
    fn default() -> Self {
        Self {
            gpu_adapter: String::new(),
            anti_alias: true,
            texture_cache_mb: 1024,
            disk_cache_path: String::new(),
            disk_cache_max_mb: 2048,
            process_priority: ProcessPriority::Normal,
            log_level: LogLevel::Info,
            control_address: "127.0.0.1".to_owned(),
            control_port: 7788,
        }
    }
}

/// Why a value is not acceptable: the setting's key, as it is written in the JSON (`textureCacheMb`),
/// and what is wrong, ready to show as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingProblem {
    pub key: String,
    pub detail: String,
}

fn problem(key: &str, detail: impl Into<String>) -> SettingProblem {
    SettingProblem {
        key: key.to_owned(),
        detail: detail.into(),
    }
}

/// A BCP 47 tag, loosely: letters, digits and hyphens, subtags of 1 to 8 characters, the first
/// two or three letters. It is not looked up in any registry.
fn valid_language_tag(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&first.len()) || !first.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

impl UserSettings {
    pub fn validate(&self) -> Result<(), SettingProblem> {
        if !valid_language_tag(&self.language) {
            return Err(problem(
                "language",
                format!(
                    "{:?} is not a language tag such as en or en-GB",
                    self.language
                ),
            ));
        }
        if !(1..=1_000_000).contains(&self.default_animation_frames) {
            return Err(problem(
                "defaultAnimationFrames",
                format!(
                    "{} is outside 1 to 1000000 frames",
                    self.default_animation_frames
                ),
            ));
        }
        if !(1..=90).contains(&self.pen_angle_step) {
            return Err(problem(
                "penAngleStep",
                format!("{} is outside 1 to 90 degrees", self.pen_angle_step),
            ));
        }
        if !(3..=24).contains(&self.pen_pick_radius) {
            return Err(problem(
                "penPickRadius",
                format!("{} is outside 3 to 24 pixels", self.pen_pick_radius),
            ));
        }
        if !(1..=100).contains(&self.pen_fit_tolerance) {
            return Err(problem(
                "penFitTolerance",
                format!("{} is outside 1 to 100 pixels", self.pen_fit_tolerance),
            ));
        }
        if self.last_used_folder.len() > 4096 || self.last_used_folder.contains('\0') {
            return Err(problem("lastUsedFolder", "is not a usable folder path"));
        }
        Ok(())
    }
}

impl MachineSettings {
    pub fn validate(&self) -> Result<(), SettingProblem> {
        if self.gpu_adapter.len() > 256 || self.gpu_adapter.contains('\0') {
            return Err(problem("gpuAdapter", "is not an adapter name"));
        }
        if !(64..=65_536).contains(&self.texture_cache_mb) {
            return Err(problem(
                "textureCacheMb",
                format!("{} is outside 64 to 65536 MiB", self.texture_cache_mb),
            ));
        }
        if self.disk_cache_path.len() > 4096 || self.disk_cache_path.contains('\0') {
            return Err(problem("diskCachePath", "is not a usable folder path"));
        }
        if self.disk_cache_max_mb > 4_194_304 {
            return Err(problem(
                "diskCacheMaxMb",
                format!("{} is outside 0 to 4194304 MiB", self.disk_cache_max_mb),
            ));
        }
        if self.control_address.parse::<std::net::IpAddr>().is_err() {
            return Err(problem(
                "controlAddress",
                format!("{:?} is not an IP address", self.control_address),
            ));
        }
        if self.control_port < 1024 {
            return Err(problem(
                "controlPort",
                format!(
                    "{} is below 1024, which is for the system",
                    self.control_port
                ),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_valid_and_new_projects_never_read_them() {
        UserSettings::default().validate().unwrap();
        MachineSettings::default().validate().unwrap();
        // Nothing that changes how a graphic renders is here: those live in the project.
        let user = serde_json::to_value(UserSettings::default()).unwrap();
        let machine = serde_json::to_value(MachineSettings::default()).unwrap();
        for forbidden in [
            "colorDepth",
            "workingColorSpace",
            "fonts",
            "safeAreas",
            "frameRate",
        ] {
            assert!(user.get(forbidden).is_none() && machine.get(forbidden).is_none());
        }
    }

    #[test]
    fn each_range_refuses_the_value_one_past_it_and_names_the_key() {
        let mut user = UserSettings {
            default_animation_frames: 0,
            ..UserSettings::default()
        };
        assert_eq!(user.validate().unwrap_err().key, "defaultAnimationFrames");
        user.default_animation_frames = 1_000_001;
        assert_eq!(user.validate().unwrap_err().key, "defaultAnimationFrames");
        user.default_animation_frames = 1_000_000;
        user.validate().unwrap();
        user.pen_angle_step = 0;
        assert_eq!(user.validate().unwrap_err().key, "penAngleStep");
        user.pen_angle_step = 91;
        assert_eq!(user.validate().unwrap_err().key, "penAngleStep");
        user.pen_angle_step = 45;
        user.pen_pick_radius = 2;
        assert_eq!(user.validate().unwrap_err().key, "penPickRadius");
        user.pen_pick_radius = 25;
        assert_eq!(user.validate().unwrap_err().key, "penPickRadius");
        user.pen_pick_radius = 8;
        user.validate().unwrap();
        // A settings file written before these keys existed still reads, with the defaults.
        let old: UserSettings = serde_json::from_str(
            r#"{"language":"en","confirmDeletes":true,"defaultAnimationFrames":250,"defaultInterpolation":"easeInOut","startup":"showStart","lastUsedFolder":""}"#,
        )
        .unwrap();
        assert_eq!((old.pen_angle_step, old.pen_pick_radius, old.pen_double_click_ends, old.pen_snap), (15, 8, true, true));
        user.language = "e".into();
        assert_eq!(user.validate().unwrap_err().key, "language");
        user.language = "en-GB".into();
        user.validate().unwrap();

        let mut machine = MachineSettings {
            texture_cache_mb: 63,
            ..MachineSettings::default()
        };
        assert_eq!(machine.validate().unwrap_err().key, "textureCacheMb");
        machine.texture_cache_mb = 64;
        machine.validate().unwrap();
        machine.control_port = 1023;
        assert_eq!(machine.validate().unwrap_err().key, "controlPort");
        machine.control_port = 1024;
        machine.control_address = "localhost".into();
        assert_eq!(machine.validate().unwrap_err().key, "controlAddress");
        machine.control_address = "::1".into();
        machine.validate().unwrap();
    }

    #[test]
    fn a_setting_a_newer_build_wrote_is_refused_not_dropped() {
        let mut value = serde_json::to_value(UserSettings::default()).unwrap();
        value["fromTheFuture"] = serde_json::json!(true);
        assert!(serde_json::from_value::<UserSettings>(value).is_err());
    }
}
