//! Read-only discovery for the Library's Import Folder confirmation.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use gx_asset_plane::{
    import::{prepare_asset_files, AssetFileInput},
    store::AssetStore,
};
use gx_contracts::project::library_folders::LibraryFolders;
use gx_contracts::ContentHash;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::project::{EditorError, Projects};

const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 32;
const MAX_IMPORT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderImportFile {
    pub relative_path: String,
    pub checksum: ContentHash,
    pub duplicate: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderImportPlan {
    pub root_name: String,
    pub folders: Vec<String>,
    pub files: Vec<FolderImportFile>,
    pub skipped: Vec<String>,
    pub plan_fingerprint: ContentHash,
}

/// Read the source without creating any project records or folders.
pub fn plan_folder_import(
    projects: &Projects,
    project: &str,
    directory: &Path,
) -> Result<FolderImportPlan, EditorError> {
    let known = projects
        .project_assets(project)?
        .into_iter()
        .filter_map(|asset| asset.checksum)
        .map(|hash| hash.0)
        .collect::<BTreeSet<_>>();
    let root_name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| invalid(directory, "choose a named Library import folder"))?;
    let metadata = fs::symlink_metadata(directory).map_err(|source| at(directory, source))?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(invalid(directory, "choose a regular directory"));
    }
    let mut scan = Scan::default();
    scan.visit(directory, "", 0)?;

    let mut seen = known;
    let files: Vec<_> = scan
        .files
        .into_iter()
        .map(|(relative_path, checksum)| {
            let duplicate = !seen.insert(checksum.0.clone());
            FolderImportFile {
                relative_path,
                checksum,
                duplicate,
            }
        })
        .collect();
    let source = directory
        .canonicalize()
        .map_err(|source| at(directory, source))?;
    let bytes = serde_json::to_vec(&(
        project,
        source,
        root_name,
        &scan.folders,
        &files,
        &scan.skipped,
    ))
    .map_err(EditorError::Serialize)?;
    Ok(FolderImportPlan {
        root_name: root_name.to_owned(),
        folders: scan.folders,
        files,
        skipped: scan.skipped,
        plan_fingerprint: gx_asset_plane::content_hash(&bytes),
    })
}

/// Apply exactly the reviewed plan. All source files are verified before
/// changing the project; already-present content keeps its existing placement.
pub fn apply_folder_import(
    projects: &Projects,
    project: &str,
    directory: &Path,
    expected: &ContentHash,
    store: &mut AssetStore,
) -> Result<usize, EditorError> {
    projects.update_library_folders(project, |library| {
        let plan =
            plan_folder_import(projects, project, directory).map_err(|error| error.to_string())?;
        if &plan.plan_fingerprint != expected {
            return Err("Library import plan changed; preview the folder again".into());
        }
        let files = plan
            .files
            .iter()
            .filter(|file| !file.duplicate)
            .collect::<Vec<_>>();
        let mut remaining = MAX_IMPORT_BYTES;
        let mut bytes = Vec::with_capacity(files.len());
        for file in &files {
            let path = directory.join(&file.relative_path);
            let mut data = Vec::new();
            fs::File::open(&path)
                .and_then(|source| source.take(remaining + 1).read_to_end(&mut data))
                .map_err(|source| at(&path, source).to_string())?;
            remaining = remaining
                .checked_sub(data.len() as u64)
                .ok_or("Library import exceeds 256 MiB")?;
            if gx_asset_plane::content_hash(&data) != file.checksum {
                return Err(format!(
                    "Library import file {:?} changed; preview the folder again",
                    file.relative_path
                ));
            }
            bytes.push(data);
        }

        let root = find_or_create(library, &plan.root_name, None)?;
        let mut folders = BTreeMap::from([("".to_owned(), root)]);
        for path in &plan.folders {
            let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
            let parent_id = folders
                .get(parent)
                .ok_or("invalid parent in Library import plan")?;
            let id = find_or_create(library, name, Some(parent_id))?;
            folders.insert(path.clone(), id);
        }
        if files.is_empty() {
            return Ok(0);
        }
        let inputs: Vec<_> = files
            .iter()
            .zip(&bytes)
            .map(|(file, bytes)| AssetFileInput {
                file_name: file
                    .relative_path
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .into(),
                bytes,
            })
            .collect();
        let known = projects
            .project_assets(project)
            .map_err(|error| error.to_string())?;
        let batch =
            prepare_asset_files(store, &known, &inputs).map_err(|error| error.to_string())?;
        let new_assets: BTreeMap<_, _> = batch
            .assets
            .iter()
            .filter_map(|item| Some((item.checksum.as_ref()?.0.as_str(), item)))
            .collect();
        for (file, bytes) in files.into_iter().zip(&bytes) {
            let Some(asset) = new_assets.get(file.checksum.0.as_str()) else {
                continue;
            };
            let (parent, _) = file
                .relative_path
                .rsplit_once('/')
                .unwrap_or(("", &file.relative_path));
            let folder_id = folders
                .get(parent)
                .ok_or("invalid destination in Library import plan")?;
            library.move_asset(&asset.asset_id, Some(folder_id))?;
            projects
                .adopt_asset(project, asset, bytes)
                .map_err(|error| error.to_string())?;
        }
        Ok(new_assets.len())
    })
}

fn find_or_create(
    library: &mut LibraryFolders,
    name: &str,
    parent: Option<&str>,
) -> Result<String, String> {
    let folded = name.trim().to_lowercase();
    if let Some(existing) = library.folders.iter().find(|folder| {
        folder.parent_id.as_deref() == parent && folder.name.to_lowercase() == folded
    }) {
        return Ok(existing.id.clone());
    }
    library.create_named(name, parent)
}

#[derive(Default)]
struct Scan {
    folders: Vec<String>,
    files: BTreeMap<String, ContentHash>,
    skipped: Vec<String>,
    entries: usize,
    bytes: u64,
}

impl Scan {
    fn visit(&mut self, directory: &Path, relative: &str, depth: usize) -> Result<(), EditorError> {
        if depth == MAX_DEPTH {
            return Err(invalid(
                directory,
                "Library import folder depth limit exceeded",
            ));
        }
        let entries = fs::read_dir(directory).map_err(|source| at(directory, source))?;
        let mut children = BTreeMap::new();
        for entry in entries {
            self.entries += 1;
            if self.entries > MAX_ENTRIES {
                return Err(invalid(
                    directory,
                    "Library import folder entry limit exceeded",
                ));
            }
            let entry = entry.map_err(|source| at(directory, source))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid(&entry.path(), "Library import requires UTF-8 file names"))?;
            children.insert(name, entry.path());
        }
        for (name, path) in children {
            let relative = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let metadata = fs::symlink_metadata(&path).map_err(|source| at(&path, source))?;
            if is_link(&metadata) {
                self.skipped.push(relative);
            } else if metadata.is_dir() {
                self.folders.push(relative.clone());
                self.visit(&path, &relative, depth + 1)?;
            } else if metadata.is_file() && is_candidate(&path) {
                let (hash, size) = hash_file(&path, MAX_IMPORT_BYTES - self.bytes)?;
                self.bytes += size;
                self.files.insert(relative, hash);
            } else {
                self.skipped.push(relative);
            }
        }
        Ok(())
    }
}

fn is_candidate(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    [
        "png", "jpg", "jpeg", "svg", "glb", "mov", "mp4", "webm", "mkv", "ttf", "otf", "woff",
        "woff2",
    ]
    .iter()
    .any(|candidate| extension.eq_ignore_ascii_case(candidate))
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn hash_file(path: &Path, limit: u64) -> Result<(ContentHash, u64), EditorError> {
    let mut file = fs::File::open(path).map_err(|source| at(path, source))?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 32 * 1024];
    let mut size = 0;
    loop {
        let length = file.read(&mut buffer).map_err(|source| at(path, source))?;
        if length == 0 {
            return Ok((ContentHash(format!("{:x}", hash.finalize())), size));
        }
        size += length as u64;
        if size > limit {
            return Err(invalid(path, "Library import exceeds 256 MiB"));
        }
        hash.update(&buffer[..length]);
    }
}

fn at(path: &Path, source: io::Error) -> EditorError {
    EditorError::Io {
        path: PathBuf::from(path),
        source,
    }
}

fn invalid(path: &Path, detail: &str) -> EditorError {
    at(path, io::Error::new(io::ErrorKind::InvalidInput, detail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_refuses_a_stale_plan_and_imports_nested_assets_once() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gx-library-apply-{}-{suffix}", std::process::id()));
        let source = root.join("source");
        fs::create_dir_all(source.join("nested")).unwrap();
        let projects = Projects::at_root(&root);
        projects.create_project("show").unwrap();
        let mut cache = AssetStore::at_root(root.join("cache"));
        let relative = "nested/logo.svg";
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>"#;
        fs::write(source.join(relative), svg).unwrap();
        let stale = plan_folder_import(&projects, "show", &source).unwrap();
        projects.create_project("other").unwrap();
        assert!(apply_folder_import(
            &projects,
            "other",
            &source,
            &stale.plan_fingerprint,
            &mut cache
        )
        .is_err());
        fs::write(source.join("duplicate.svg"), svg).unwrap();
        assert!(apply_folder_import(
            &projects,
            "show",
            &source,
            &stale.plan_fingerprint,
            &mut cache
        )
        .is_err());
        assert!(projects.library_folders("show").unwrap().folders.is_empty());

        fs::rename(source.join("duplicate.svg"), source.join("z-duplicate.svg")).unwrap();
        let plan = plan_folder_import(&projects, "show", &source).unwrap();
        assert_eq!(
            apply_folder_import(
                &projects,
                "show",
                &source,
                &plan.plan_fingerprint,
                &mut cache
            )
            .unwrap(),
            1
        );
        let view = projects.library_folder_view("show").unwrap();
        assert_eq!(view.folders.len(), 2);
        let nested = view
            .folders
            .iter()
            .find(|entry| entry.folder.name == "nested")
            .unwrap();
        assert_eq!(nested.asset_count, 1);
        assert_eq!(view.unfiled_count, 0);
        assert_eq!(fs::read(source.join(relative)).unwrap(), svg);
        let new_plan = plan_folder_import(&projects, "show", &source).unwrap();
        assert!(new_plan.files.iter().all(|file| file.duplicate));
        assert_eq!(
            apply_folder_import(
                &projects,
                "show",
                &source,
                &new_plan.plan_fingerprint,
                &mut cache
            )
            .unwrap(),
            0
        );
        assert_eq!(projects.library_folder_view("show").unwrap(), view);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn planning_is_read_only_and_fingerprints_duplicate_bytes() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gx-library-import-{}-{suffix}", std::process::id()));
        let directory = root.join("source");
        fs::create_dir_all(directory.join("nested")).unwrap();
        let projects = Projects::at_root(&root);
        projects.create_project("show").unwrap();
        let before = fs::read(projects.gpx_path("show")).unwrap();
        fs::write(directory.join("logo.png"), b"same content").unwrap();
        fs::write(directory.join("nested/duplicate.png"), b"same content").unwrap();
        fs::write(directory.join("notes.txt"), b"not an asset").unwrap();

        let plan = plan_folder_import(&projects, "show", &directory).unwrap();
        assert_eq!(plan.folders, ["nested"]);
        assert_eq!(plan.skipped, ["notes.txt"]);
        assert!(!plan.files[0].duplicate);
        assert!(plan.files[1].duplicate);
        assert_eq!(
            plan,
            plan_folder_import(&projects, "show", &directory).unwrap()
        );
        fs::write(directory.join("nested/duplicate.png"), b"new content").unwrap();
        assert_ne!(
            plan.plan_fingerprint,
            plan_folder_import(&projects, "show", &directory)
                .unwrap()
                .plan_fingerprint
        );
        assert_eq!(fs::read(projects.gpx_path("show")).unwrap(), before);
        assert!(projects.project_assets("show").unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
