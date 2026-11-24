//! The recent-projects list (build plan 11.43): the projects File > Open Recent offers, newest
//! first, as XPression, Viz and After Effects keep one.
//!
//! It is a convenience, not a record of work, so it is **disposable**: a file that is missing or
//! does not read is an empty list (the next project opened writes a good one), and a project
//! whose `.gpx` has since been moved or deleted stays listed until the user forgets it, so it can
//! be shown as missing rather than vanishing without a word. The list holds paths and names only,
//! never project content.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::project::EditorError;

/// How many projects are remembered.
pub const RECENT_LIMIT: usize = 12;

/// One remembered project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    /// The project's `.gpx`, as an absolute path.
    pub gpx: String,
    pub name: String,
    /// When it was last opened, in milliseconds since the Unix epoch.
    pub opened_ms: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentFile {
    #[serde(default)]
    recent: Vec<RecentProject>,
}

/// The list, kept in one JSON file.
#[derive(Debug, Clone)]
pub struct RecentProjects {
    file: PathBuf,
}

/// Two paths name the same project when they are equal as the platform compares them: case does
/// not matter on Windows, and `\` and `/` are one separator there.
fn same(a: &str, b: &str) -> bool {
    let normal = |s: &str| {
        if cfg!(windows) {
            s.replace('\\', "/").to_lowercase()
        } else {
            s.to_owned()
        }
    };
    normal(a) == normal(b)
}

impl RecentProjects {
    pub fn at(file: impl Into<PathBuf>) -> Self {
        Self { file: file.into() }
    }

    /// The remembered projects, newest first.
    pub fn list(&self) -> Vec<RecentProject> {
        let Ok(bytes) = std::fs::read(&self.file) else {
            return Vec::new();
        };
        let mut recent = serde_json::from_slice::<RecentFile>(&bytes)
            .map(|f| f.recent)
            .unwrap_or_default();
        recent.sort_by(|a, b| b.opened_ms.cmp(&a.opened_ms));
        recent
    }

    fn write(&self, recent: Vec<RecentProject>) -> Result<(), EditorError> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|source| EditorError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let bytes =
            serde_json::to_vec_pretty(&RecentFile { recent }).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&self.file, &bytes).map_err(EditorError::Write)
    }

    /// Remember a project as just opened: it goes to the top, once, and the oldest fall off.
    pub fn record(&self, gpx: &Path, name: &str, now_ms: u64) -> Result<(), EditorError> {
        let gpx = gpx.display().to_string();
        let mut recent = self.list();
        recent.retain(|r| !same(&r.gpx, &gpx));
        recent.insert(
            0,
            RecentProject {
                gpx,
                name: name.to_owned(),
                opened_ms: now_ms,
            },
        );
        recent.truncate(RECENT_LIMIT);
        self.write(recent)
    }

    /// Take a project off the list. The project itself is not touched.
    pub fn forget(&self, gpx: &str) -> Result<(), EditorError> {
        let mut recent = self.list();
        let before = recent.len();
        recent.retain(|r| !same(&r.gpx, gpx));
        if recent.len() == before {
            return Ok(());
        }
        self.write(recent)
    }
}

#[cfg(test)]
mod tests;
