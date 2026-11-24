//! What a project declares about every scene in it (build plan 3.15).
//!
//! A project is a named `.gpx` document beside its supporting folders
//! (`Images`, `Footage`, `Fonts`), like an XPression project; its settings live in that
//! document ([`ProjectDocument`]). Projects made before it kept them in
//! [`PROJECT_SETTINGS_FILE`] and are upgraded on their first write. The Editor service owns
//! the files; the types are here so every surface reads the same declaration (invariant 22).

use serde::{Deserialize, Serialize};

use crate::color::{ColorDepth, WorkingColorSpace};

/// The settings document inside a project folder, as projects made before the `.gpx` had it.
/// A project now keeps its settings in its [`ProjectDocument`]; this file is only read to
/// upgrade an older project, then removed.
pub const PROJECT_SETTINGS_FILE: &str = "project.json";

/// The extension of a project document: `<Project>/<Project>.gpx`.
pub const GPX_EXTENSION: &str = "gpx";

/// The project document schema this build writes and reads.
pub const PROJECT_SCHEMA_VERSION: u32 = 1;

/// The supporting folders of a project, beside its `.gpx` (the way an XPression, Viz or After
/// Effects project keeps its media), decided by the user on 22 Nov 2026:
///
/// ```text
/// Assets/Images   Assets/Videos   Assets/Audio   Assets/Models      Fonts
/// ```
pub const ASSETS_FOLDER: &str = "Assets";
pub const IMAGES_FOLDER: &str = "Images";
pub const VIDEOS_FOLDER: &str = "Videos";
pub const AUDIO_FOLDER: &str = "Audio";
pub const MODELS_FOLDER: &str = "Models";
pub const FONTS_FOLDER: &str = "Fonts";

/// Where a project keeps what its scenes retain: the sources of imports (a Figma frame, an SVG)
/// and assets adopted by content address. It is not `Assets`: on Windows `assets` and `Assets`
/// are one folder, and what the user sees there is theirs.
pub const SOURCES_FOLDER: &str = "Sources";

/// The formats each folder holds.
pub const IMAGE_EXTENSIONS: [&str; 5] = ["png", "webp", "jpg", "jpeg", "svg"];
pub const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "avi", "webm"];
pub const AUDIO_EXTENSIONS: [&str; 2] = ["wav", "mp3"];
pub const MODEL_EXTENSIONS: [&str; 9] = [
    "gltf", "glb", "obj", "fbx", "stl", "ply", "dae", "usd", "usdz",
];
pub const FONT_EXTENSIONS: [&str; 4] = ["otf", "ttf", "woff", "woff2"];

/// The file name of a project's document.
pub fn project_file_name(project: &str) -> String {
    format!("{project}.{GPX_EXTENSION}")
}

/// A project: the document a named `.gpx` holds (build plan 11.43).
///
/// Unknown fields refuse rather than drop, as [`ProjectSettings`] does: a field written by a
/// newer build and read by an older one would otherwise vanish on the next save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocument {
    pub schema_version: u32,
    /// The project's name, which is also its folder and its `.gpx` file name.
    pub name: String,
    pub settings: ProjectSettings,
}

impl ProjectDocument {
    pub fn new(name: &str, settings: ProjectSettings) -> Self {
        Self {
            schema_version: PROJECT_SCHEMA_VERSION,
            name: name.to_owned(),
            settings,
        }
    }

    /// Whether this build can read the document, and why not if it cannot.
    pub fn check(&self, folder_name: &str) -> Result<(), String> {
        if self.schema_version != PROJECT_SCHEMA_VERSION {
            return Err(format!(
                "schema version {} is not the {} this build reads",
                self.schema_version, PROJECT_SCHEMA_VERSION
            ));
        }
        if self.name != folder_name {
            return Err(format!(
                "the document names the project {:?} but sits in the folder {:?}",
                self.name, folder_name
            ));
        }
        Ok(())
    }
}

/// A project's declarations.
///
/// Unknown fields refuse rather than drop: a setting written by a newer
/// build and read by an older one would otherwise vanish on the next save
/// (invariant 18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettings {
    /// The space every scene in this project composites in.
    pub working_color_space: WorkingColorSpace,
    /// Bits per channel every scene composites at. A file written before
    /// depth existed carries none and reads as [`ColorDepth::BEFORE_DEPTH`],
    /// which is what it meant.
    #[serde(default = "before_depth")]
    pub color_depth: ColorDepth,
}

const fn before_depth() -> ColorDepth {
    ColorDepth::BEFORE_DEPTH
}

impl ProjectSettings {
    /// What a newly created project declares.
    pub const fn new_project() -> Self {
        Self {
            working_color_space: WorkingColorSpace::NEW_PROJECT,
            color_depth: ColorDepth::NEW_PROJECT,
        }
    }

    /// What a project created before 3.15 meant. Such a project has no
    /// settings file; every scene in it composited in linear light.
    pub const fn before_3_15() -> Self {
        Self {
            working_color_space: WorkingColorSpace::BEFORE_3_15,
            color_depth: ColorDepth::BEFORE_DEPTH,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_refuse_what_they_do_not_carry() {
        let settings = ProjectSettings::new_project();
        let wire = serde_json::to_value(settings).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "workingColorSpace": "srgb", "colorDepth": "16" })
        );
        // A file from before depth reads as 32-bit float, as it rendered.
        let old: ProjectSettings =
            serde_json::from_value(serde_json::json!({ "workingColorSpace": "srgb" })).unwrap();
        assert_eq!(old.color_depth, ColorDepth::Bits32);
        assert_eq!(
            serde_json::from_value::<ProjectSettings>(wire).unwrap(),
            settings
        );
        assert_eq!(
            ProjectSettings::before_3_15().working_color_space,
            WorkingColorSpace::LinearSrgb
        );
        let newer = serde_json::json!({ "workingColorSpace": "srgb", "hdr": true });
        assert!(serde_json::from_value::<ProjectSettings>(newer).is_err());
        let unstated = serde_json::json!({});
        assert!(serde_json::from_value::<ProjectSettings>(unstated).is_err());
    }
}
