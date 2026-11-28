//! Project-local Library folders. Folder identifiers and asset memberships
//! describe the virtual tree and never encode a filesystem path.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryFolder {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryFolders {
    #[serde(default)]
    pub folders: Vec<LibraryFolder>,
    #[serde(default)]
    pub asset_folders: BTreeMap<String, String>,
    #[serde(default)]
    next_folder_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderEntry {
    #[serde(flatten)]
    pub folder: LibraryFolder,
    /// Direct children only. Nested folders report their own counts.
    pub asset_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolderView {
    pub folders: Vec<LibraryFolderEntry>,
    pub asset_folders: BTreeMap<String, String>,
    pub unfiled_count: usize,
}

impl LibraryFolders {
    pub fn create_named(&mut self, name: &str, parent_id: Option<&str>) -> Result<String, String> {
        let mut sequence = self.next_folder_sequence;
        loop {
            sequence = sequence
                .checked_add(1)
                .ok_or("Library folder IDs exhausted")?;
            let id = format!("folder-{sequence}");
            if self.folders.iter().any(|folder| folder.id == id) {
                continue;
            }
            self.create(&id, name, parent_id)?;
            self.next_folder_sequence = sequence;
            return Ok(id);
        }
    }

    pub fn view<'a>(&self, assets: impl IntoIterator<Item = &'a str>) -> LibraryFolderView {
        let mut counts = BTreeMap::new();
        let mut asset_folders = BTreeMap::new();
        let mut unfiled_count = 0;
        let mut seen = HashSet::new();
        for id in assets {
            if !seen.insert(id) {
                continue;
            }
            if let Some(folder) = self.asset_folders.get(id) {
                *counts.entry(folder.as_str()).or_default() += 1;
                asset_folders.insert(id.to_owned(), folder.clone());
            } else {
                unfiled_count += 1;
            }
        }
        let folders = self
            .folders
            .iter()
            .cloned()
            .map(|folder| LibraryFolderEntry {
                asset_count: counts.get(folder.id.as_str()).copied().unwrap_or_default(),
                folder,
            })
            .collect();
        LibraryFolderView {
            folders,
            asset_folders,
            unfiled_count,
        }
    }

    pub fn create(&mut self, id: &str, name: &str, parent_id: Option<&str>) -> Result<(), String> {
        if id.trim().is_empty() || self.folders.iter().any(|folder| folder.id == id) {
            return Err(format!("invalid or duplicate Library folder ID {id:?}"));
        }
        let name = self.check_placement(id, name, parent_id)?;
        self.folders.push(LibraryFolder {
            id: id.into(),
            name: name.into(),
            parent_id: parent_id.map(str::to_owned),
        });
        Ok(())
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
        let index = self.index(id)?;
        let name = self.check_placement(id, name, self.folders[index].parent_id.as_deref())?;
        self.folders[index].name = name.into();
        Ok(())
    }

    pub fn move_folder(&mut self, id: &str, parent_id: Option<&str>) -> Result<(), String> {
        let index = self.index(id)?;
        self.check_placement(id, &self.folders[index].name, parent_id)?;
        self.folders[index].parent_id = parent_id.map(str::to_owned);
        Ok(())
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let index = self.index(id)?;
        if self
            .folders
            .iter()
            .any(|folder| folder.parent_id.as_deref() == Some(id))
            || self.asset_folders.values().any(|folder_id| folder_id == id)
        {
            return Err(format!(
                "Library folder {:?} is not empty",
                self.folders[index].name
            ));
        }
        self.folders.remove(index);
        Ok(())
    }

    /// Set membership after the caller has verified the asset is in this project.
    pub fn move_asset(&mut self, asset_id: &str, folder_id: Option<&str>) -> Result<(), String> {
        if let Some(folder_id) = folder_id {
            self.index(folder_id)?;
            self.asset_folders.insert(asset_id.into(), folder_id.into());
        } else {
            self.asset_folders.remove(asset_id);
        }
        Ok(())
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        let mut ids = HashSet::new();
        for folder in &self.folders {
            if folder.id.trim().is_empty() || !ids.insert(&folder.id) {
                return Err(format!(
                    "invalid or duplicate Library folder ID {:?}",
                    folder.id
                ));
            }
            self.check_placement(&folder.id, &folder.name, folder.parent_id.as_deref())?;
        }
        for folder_id in self.asset_folders.values() {
            self.index(folder_id)?;
        }
        Ok(())
    }

    fn index(&self, id: &str) -> Result<usize, String> {
        self.folders
            .iter()
            .position(|folder| folder.id == id)
            .ok_or_else(|| format!("unknown Library folder {id:?}"))
    }

    fn check_placement<'a>(
        &self,
        id: &str,
        name: &'a str,
        parent_id: Option<&str>,
    ) -> Result<&'a str, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(format!("invalid Library folder name {name:?}"));
        }
        let folded_name = name.to_lowercase();
        if self.folders.iter().any(|folder| {
            folder.id != id
                && folder.parent_id.as_deref() == parent_id
                && folder.name.to_lowercase() == folded_name
        }) {
            return Err(format!(
                "duplicate Library folder name {name:?} under {parent_id:?}"
            ));
        }
        let mut visited = HashSet::new();
        let mut ancestor = parent_id;
        while let Some(parent) = ancestor {
            if parent == id || !visited.insert(parent) {
                return Err(format!(
                    "moving Library folder {name:?} would create a parent cycle"
                ));
            }
            ancestor = self.folders[self.index(parent)?].parent_id.as_deref();
        }
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nesting_and_membership_round_trip_without_creating_a_cycle() {
        let mut library = LibraryFolders::default();
        library.create("parent", "Promos", None).unwrap();
        library.create("child", "Regional", Some("parent")).unwrap();
        library.move_asset("asset", Some("child")).unwrap();

        let before = library.clone();
        assert!(library
            .move_folder("parent", Some("child"))
            .unwrap_err()
            .contains("cycle"));
        assert!(library.delete("parent").unwrap_err().contains("Promos"));
        assert!(library.delete("child").unwrap_err().contains("Regional"));
        assert_eq!(library, before);

        let encoded = serde_json::to_vec(&library).unwrap();
        let mut restored: LibraryFolders = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(restored, library);
        restored.move_asset("asset", None).unwrap();
        restored.move_folder("child", None).unwrap();
        restored.delete("child").unwrap();
        restored.delete("parent").unwrap();
        assert_eq!(restored, LibraryFolders::default());
    }

    #[test]
    fn rename_and_move_refuse_duplicate_sibling_names_without_changes() {
        let mut library = LibraryFolders::default();
        library.create("a", "Graphics", None).unwrap();
        library.create("b", "Graphics", Some("a")).unwrap();
        library.create("c", "Sponsor", None).unwrap();
        let before = library.clone();
        assert!(library.move_folder("b", None).is_err());
        assert!(library.rename("c", " graphics ").is_err());
        assert!(library.move_asset("asset", Some("missing")).is_err());
        assert_eq!(library, before);
        library.rename("c", "Sponsor logos").unwrap();
    }
}
