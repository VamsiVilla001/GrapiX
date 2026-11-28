//! Operator Cue IDs on the durable rundown.
use gx_control_plane::status::ProgramLayerPhase;

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RundownCue {
    pub entry_id: String,
    pub cue_id: Option<CueId>,
    pub on_air: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RundownCueView {
    pub cursor: usize,
    pub entries: Vec<RundownCue>,
}

pub(super) fn on_air(scene: &PublishedScene, status: &EngineStatus) -> bool {
    let matches =
        |take_id: &TakeId, revision| scene.take_id == *take_id && scene.revision == revision;
    status
        .program
        .as_ref()
        .is_some_and(|item| matches(&item.take_id, item.revision))
        || status.layers.iter().flatten().any(|item| {
            item.state != ProgramLayerPhase::Queued && matches(&item.take_id, item.revision)
        })
}

impl RundownCue {
    fn for_entry(entry: &RundownEntry, status: &EngineStatus) -> Self {
        Self {
            entry_id: entry.id.clone(),
            cue_id: entry.cue_id.clone(),
            on_air: on_air(&entry.scene, status),
        }
    }
}

impl RundownStore {
    /// Read fresh durable rows in rundown order, annotated by the engine's status.
    pub fn read_cue_ids(&self, status: &EngineStatus) -> Result<RundownCueView, RundownStoreError> {
        let current = Self::load(&self.path)?.rundown;
        current.cue_table(status)?;
        Ok(RundownCueView {
            cursor: current.cursor,
            entries: current
                .entries
                .iter()
                .map(|entry| RundownCue::for_entry(entry, status))
                .collect(),
        })
    }

    /// Assign or rename one entry under the show lock. The caller names the Cue ID
    /// it last saw, including an unassigned entry, to avoid losing a newer edit.
    pub fn set_cue_id(
        &mut self,
        entry_id: &str,
        expected: Option<&CueId>,
        typed: &str,
        status: &EngineStatus,
    ) -> Result<RundownCue, RundownStoreError> {
        let _lock = self.lock()?;
        let mut proposed = Self::load(&self.path)?.rundown;
        let mut table = proposed.cue_table(status)?;
        let mut matches = proposed
            .entries
            .iter_mut()
            .filter(|entry| entry.id == entry_id);
        let entry = matches.next().ok_or_else(|| Refusal::RundownEntryUnknown {
            entry_id: entry_id.to_owned(),
        })?;
        if matches.next().is_some() {
            return Err(Refusal::SceneParseFailed {
                detail: format!("ambiguous rundown entry {entry_id:?}"),
            }
            .into());
        }
        if entry.cue_id.as_ref() != expected {
            return Err(RundownStoreError::Stale {
                path: self.path.clone(),
            });
        }
        let assigned = match &entry.cue_id {
            Some(cue) => table.rename(cue.as_str(), typed)?,
            None => {
                if on_air(&entry.scene, status) {
                    return Err(Refusal::CueIdLockedOnAir {
                        cue_id: CueId::parse(typed)?.to_string(),
                    }
                    .into());
                }
                table.assign(typed, entry.scene.take_id.clone())?
            }
        };
        let changed = entry.cue_id.as_ref() != Some(&assigned);
        entry.cue_id = Some(assigned);
        let result = RundownCue::for_entry(entry, status);
        if changed {
            self.persist(&proposed)?;
        }
        self.rundown = proposed;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::{ClockSource, DeviceTier, Epoch, RationalRate, ReferenceState};
    use gx_control_plane::status::ProgramState;

    #[test]
    fn cue_edit_persists_one_entry_and_refuses_duplicate_stale_and_live_edits() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gx-cue-edit-{}-{stamp}", std::process::id()));
        let path = root.join("rundown.json");
        let mut library = PublishedLibrary::default();
        let scene = library.publish("score", serde_json::json!({"name":"Score"}), None);
        let mut store = RundownStore::create(
            &path,
            Rundown::new(vec![
                RundownEntry {
                    id: "first".into(),
                    scene: scene.clone(),
                    cue_id: None,
                },
                RundownEntry {
                    id: "second".into(),
                    scene: scene.clone(),
                    cue_id: None,
                },
            ]),
        )
        .unwrap();
        let mut other = RundownStore::load(&path).unwrap();
        let mut status = EngineStatus {
            epoch: Epoch(1),
            current_frame: 1,
            timebase: RationalRate::P50,
            clock: ClockSource::FreeRun,
            reference: ReferenceState::NotPresent,
            device_tier: DeviceTier::T0,
            live_allowed: false,
            program: None,
            layers: None,
            degradations: Vec::new(),
        };
        let opening = store
            .set_cue_id("first", None, "Opening", &status)
            .unwrap()
            .cue_id
            .unwrap();
        assert!(matches!(
            other.set_cue_id("first", None, "Another", &status),
            Err(RundownStoreError::Stale { .. })
        ));
        assert!(matches!(
            other.set_cue_id("second", None, "OPENING", &status),
            Err(RundownStoreError::Refused {
                refusal: Refusal::CueIdDuplicate { .. }
            })
        ));
        assert!(matches!(
            store.set_cue_id("missing", None, "Missing", &status),
            Err(RundownStoreError::Refused {
                refusal: Refusal::RundownEntryUnknown { .. }
            })
        ));
        let renamed = store
            .set_cue_id("first", Some(&opening), "Score", &status)
            .unwrap()
            .cue_id
            .unwrap();
        status.program = Some(ProgramState {
            take_id: scene.take_id,
            revision: scene.revision,
            committed_frame: 1,
            scene_frame: 0,
            playing: true,
            phase: None,
            stop_frame: None,
        });
        let before = std::fs::read(&path).unwrap();
        for (id, expected) in [("first", Some(&renamed)), ("second", None)] {
            assert!(matches!(
                other.set_cue_id(id, expected, "Locked", &status),
                Err(RundownStoreError::Refused {
                    refusal: Refusal::CueIdLockedOnAir { .. }
                })
            ));
        }
        let view = other.read_cue_ids(&status).unwrap();
        assert_eq!(view.cursor, 0);
        assert_eq!(
            view.entries,
            vec![
                RundownCue {
                    entry_id: "first".into(),
                    cue_id: Some(renamed),
                    on_air: true
                },
                RundownCue {
                    entry_id: "second".into(),
                    cue_id: None,
                    on_air: true
                },
            ]
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(root.join("rundown.json.lock")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
