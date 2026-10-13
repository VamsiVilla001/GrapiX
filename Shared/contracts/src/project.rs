//! What a project declares about every scene in it (build plan 3.15).
//!
//! Until 11.43 gives a project one `.gpx` file, a project is a folder of
//! scene documents, and these settings live beside them as
//! [`PROJECT_SETTINGS_FILE`]. The Editor service owns the file; the type is
//! here so every surface reads the same declaration (invariant 22).

use serde::{Deserialize, Serialize};

use crate::color::WorkingColorSpace;

/// The settings document inside a project folder.
pub const PROJECT_SETTINGS_FILE: &str = "project.json";

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
}

impl ProjectSettings {
    /// What a newly created project declares.
    pub const fn new_project() -> Self {
        Self { working_color_space: WorkingColorSpace::NEW_PROJECT }
    }

    /// What a project created before 3.15 meant. Such a project has no
    /// settings file; every scene in it composited in linear light.
    pub const fn before_3_15() -> Self {
        Self { working_color_space: WorkingColorSpace::BEFORE_3_15 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_refuse_what_they_do_not_carry() {
        let settings = ProjectSettings::new_project();
        let wire = serde_json::to_value(settings).unwrap();
        assert_eq!(wire, serde_json::json!({ "workingColorSpace": "srgb" }));
        assert_eq!(serde_json::from_value::<ProjectSettings>(wire).unwrap(), settings);
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
