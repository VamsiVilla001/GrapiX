//! The recent-projects list (build plan 11.43): the projects File > Open Recent offers, newest
//! first, as XPression, Viz and After Effects keep one.
//!
//! It is a convenience, not a record of work, so it is **disposable**: a file that is missing or
//! does not read is an empty list (the next project opened writes a good one), and a project
//! whose `.gpx` has since been moved or deleted stays listed until the user forgets it, so it can
//! be shown as missing rather than vanishing without a word. Optional thumbnails are kept in a
//! separate per-user cache, so older recent lists still load without a migration.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use gx_contracts::Refusal;

use serde::{Deserialize, Serialize};

use crate::project::EditorError;

/// How many projects are remembered.
pub const RECENT_LIMIT: usize = 12;
const MAX_THUMBNAIL_BYTES: usize = 256 * 1024;
const MAX_THUMBNAIL_DIMENSION: u32 = 512;

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
    identity(a) == identity(b)
}

fn identity(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/").to_lowercase()
    } else {
        path.to_owned()
    }
}

fn validate_thumbnail(bytes: &[u8]) -> Result<(), Refusal> {
    let invalid = |detail: &str| Refusal::SceneParseFailed {
        detail: format!("project thumbnail {detail}"),
    };
    if bytes.len() > MAX_THUMBNAIL_BYTES {
        return Err(invalid("exceeds 256 KiB"));
    }
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_limits(png::Limits {
        bytes: 4 * 1024 * 1024,
    });
    let mut reader = decoder
        .read_info()
        .map_err(|_| invalid("must be a readable PNG"))?;
    let dimensions = reader.info();
    if dimensions.width > MAX_THUMBNAIL_DIMENSION || dimensions.height > MAX_THUMBNAIL_DIMENSION {
        return Err(invalid("exceeds 512 × 512 pixels"));
    }
    if dimensions.animation_control.is_some() {
        return Err(invalid("must be a still PNG"));
    }
    let mut pixels = vec![0; reader.output_buffer_size()];
    reader
        .next_frame(&mut pixels)
        .map_err(|_| invalid("PNG pixels could not be decoded"))?;
    reader.finish().map_err(|_| invalid("PNG is incomplete"))?;
    Ok(())
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

    fn lock(&self) -> Result<gx_fs::FileLock, EditorError> {
        let mut name = self.file.as_os_str().to_os_string();
        name.push(".lock");
        let path = PathBuf::from(name);
        gx_fs::FileLock::exclusive(&path).map_err(|source| EditorError::Io { path, source })
    }

    fn graphic_history_path(&self, gpx: &Path) -> PathBuf {
        let key = gx_asset_plane::content_hash(identity(&gpx.to_string_lossy()).as_bytes());
        self.file.with_extension("graphics").join(format!("{}.json", key.0))
    }

    pub fn graphic_open_times(&self, gpx: &Path) -> BTreeMap<String, u64> {
        std::fs::read(self.graphic_history_path(gpx))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn record_graphic_open(
        &self,
        gpx: &Path,
        scene_id: &str,
        opened_ms: u64,
    ) -> Result<(), EditorError> {
        let path = self.graphic_history_path(gpx);
        let directory = path.parent().expect("graphic history directory");
        std::fs::create_dir_all(directory).map_err(|source| EditorError::Io {
            path: directory.to_path_buf(),
            source,
        })?;
        let _held = self.lock()?;
        let mut history = self.graphic_open_times(gpx);
        let previous = history.entry(scene_id.to_owned()).or_default();
        *previous = (*previous).max(opened_ms);
        let bytes = serde_json::to_vec(&history).map_err(EditorError::Serialize)?;
        gx_fs::write_atomic(&path, &bytes).map_err(EditorError::Write)
    }

    fn thumbnail_path(&self, gpx: &str) -> PathBuf {
        let key = gx_asset_plane::content_hash(identity(gpx).as_bytes());
        self.file
            .with_extension("thumbnails")
            .join(format!("{}.png", key.0))
    }

    /// Read a cached thumbnail for a listed project. A damaged cache is a miss.
    pub fn thumbnail(&self, gpx: &str) -> Option<Vec<u8>> {
        if !self.list().iter().any(|item| same(&item.gpx, gpx)) {
            return None;
        }
        let path = self.thumbnail_path(gpx);
        if !std::fs::symlink_metadata(&path).ok()?.file_type().is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .ok()?
            .take((MAX_THUMBNAIL_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        validate_thumbnail(&bytes).ok()?;
        Some(bytes)
    }

    /// Cache a small PNG for a listed project. The caller never selects the cache path.
    pub fn store_thumbnail(&self, gpx: &str, bytes: &[u8]) -> Result<(), EditorError> {
        validate_thumbnail(bytes).map_err(EditorError::Refused)?;
        let _held = self.lock()?;
        if !self.list().iter().any(|item| same(&item.gpx, gpx)) {
            return Err(EditorError::Refused(Refusal::ProjectNotFound {
                project: gpx.to_owned(),
            }));
        }
        let path = self.thumbnail_path(gpx);
        let directory = path.parent().expect("thumbnail cache directory");
        std::fs::create_dir_all(directory).map_err(|source| EditorError::Io {
            path: directory.to_path_buf(),
            source,
        })?;
        gx_fs::write_atomic(&path, bytes).map_err(EditorError::Write)
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
        let _held = self.lock()?;
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
        let evicted = recent.split_off(recent.len().min(RECENT_LIMIT));
        self.write(recent)?;
        for item in evicted {
            let _ = std::fs::remove_file(self.thumbnail_path(&item.gpx));
        }
        Ok(())
    }

    /// Take a project off the list. The project itself is not touched.
    pub fn forget(&self, gpx: &str) -> Result<(), EditorError> {
        let _held = self.lock()?;
        let mut recent = self.list();
        let before = recent.len();
        recent.retain(|r| !same(&r.gpx, gpx));
        if recent.len() == before {
            return Ok(());
        }
        self.write(recent)?;
        let _ = std::fs::remove_file(self.thumbnail_path(gpx));
        Ok(())
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod graphic_history_tests {
    use super::*;

    #[test]
    fn opens_are_per_project_and_survive_reopening_the_cache() {
        let root = std::env::temp_dir().join(format!(
            "gx-graphic-history-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let file = root.join("recent.json");
        let first = root.join("first/news.gpx");
        let second = root.join("second/news.gpx");
        let history = RecentProjects::at(&file);
        assert!(history.graphic_open_times(&first).is_empty());
        history.record_graphic_open(&first, "headline", 20).unwrap();
        history.record_graphic_open(&first, "headline", 10).unwrap();
        history.record_graphic_open(&second, "headline", 30).unwrap();
        let reopened = RecentProjects::at(&file);
        assert_eq!(reopened.graphic_open_times(&first)["headline"], 20);
        assert_eq!(reopened.graphic_open_times(&second)["headline"], 30);
        assert!(!first.exists() && !second.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
