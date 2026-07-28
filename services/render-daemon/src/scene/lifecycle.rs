//! Prepared-scene registry with explicit Preview/Program ownership and a
//! bounded least-recently-used warm cache.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;

#[cfg(test)]
use super::PreparedGradient;
use super::{PreparedMeshVertex, PreparedRect, PreparedScene, SceneDiagnostic};

pub const DEFAULT_MAX_WARM_SCENES: usize = 3;
pub const DEFAULT_MAX_PREPARED_CACHE_BYTES: u64 = 768 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SceneLifecycle {
    Unloaded,
    MetadataOnly,
    Loading,
    Warm,
    Preview,
    Program,
    Evictable,
    Failed,
}

#[derive(Debug, Clone)]
pub struct SceneLifecycleStatus {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub lifecycle: SceneLifecycle,
    pub object_count: usize,
    pub rect_count: usize,
    pub mesh_count: usize,
    pub diagnostics: Vec<SceneDiagnostic>,
    pub warnings: Vec<String>,
    pub take_blockers: Vec<String>,
    pub estimated_bytes: u64,
    pub last_used: u64,
}

struct SceneCacheEntry {
    scene: Arc<PreparedScene>,
    lifecycle: SceneLifecycle,
    estimated_bytes: u64,
    last_used: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SceneRegistryError {
    #[error("scene {0:?} is not loaded")]
    UnknownScene(String),
    #[error("scene {scene_id:?} revision mismatch: expected {expected:?}, loaded {actual:?}")]
    RevisionMismatch {
        scene_id: String,
        expected: String,
        actual: String,
    },
    #[error("scene {0:?} is active on Preview or Program and cannot be released")]
    ActiveScene(String),
    #[error("scene {scene_id:?} is not ready for Take: {blockers}")]
    NotReady { scene_id: String, blockers: String },
}

pub struct SceneRegistry {
    entries: HashMap<String, SceneCacheEntry>,
    program_scene_id: Option<String>,
    preview_scene_id: Option<String>,
    max_warm_scenes: usize,
    max_cache_bytes: u64,
    usage_clock: u64,
}

impl SceneRegistry {
    pub fn new(max_warm_scenes: usize, max_cache_bytes: u64) -> Self {
        Self {
            entries: HashMap::new(),
            program_scene_id: None,
            preview_scene_id: None,
            max_warm_scenes,
            max_cache_bytes,
            usage_clock: 0,
        }
    }

    /// Insert or replace a prepared scene. Active channel ownership survives
    /// a full revision update; an inactive scene becomes WARM.
    pub fn insert(&mut self, scene: Arc<PreparedScene>) -> Vec<String> {
        let scene_id = scene.scene_id.clone();
        let lifecycle = self.lifecycle_for(&scene_id);
        let last_used = self.tick();
        let estimated_bytes = estimate_prepared_scene_bytes(&scene);

        self.entries.insert(
            scene_id,
            SceneCacheEntry {
                scene,
                lifecycle,
                estimated_bytes,
                last_used,
            },
        );

        self.evict_excess_warm_scenes()
    }

    pub fn set_preview(
        &mut self,
        scene_id: &str,
        revision: &str,
    ) -> Result<Vec<String>, SceneRegistryError> {
        self.validate_revision(scene_id, revision)?;
        self.preview_scene_id = Some(scene_id.to_string());
        self.refresh_lifecycles();
        self.touch(scene_id);
        Ok(self.evict_excess_warm_scenes())
    }

    pub fn take_program(
        &mut self,
        scene_id: &str,
        revision: &str,
    ) -> Result<(Arc<PreparedScene>, Vec<String>), SceneRegistryError> {
        self.validate_revision(scene_id, revision)?;
        let blockers = &self
            .entries
            .get(scene_id)
            .expect("validated scene must remain loaded")
            .scene
            .take_blockers;
        if !blockers.is_empty() {
            return Err(SceneRegistryError::NotReady {
                scene_id: scene_id.to_string(),
                blockers: blockers.join("; "),
            });
        }
        self.program_scene_id = Some(scene_id.to_string());
        self.refresh_lifecycles();
        self.touch(scene_id);
        let scene = Arc::clone(
            &self
                .entries
                .get(scene_id)
                .expect("validated scene must remain loaded")
                .scene,
        );
        let evicted = self.evict_excess_warm_scenes();
        Ok((scene, evicted))
    }

    pub fn release(&mut self, scene_id: &str, revision: &str) -> Result<(), SceneRegistryError> {
        self.validate_revision(scene_id, revision)?;
        if self.program_scene_id.as_deref() == Some(scene_id)
            || self.preview_scene_id.as_deref() == Some(scene_id)
        {
            return Err(SceneRegistryError::ActiveScene(scene_id.to_string()));
        }
        self.entries
            .remove(scene_id)
            .map(|_| ())
            .ok_or_else(|| SceneRegistryError::UnknownScene(scene_id.to_string()))
    }

    pub fn contains(&self, scene_id: &str) -> bool {
        self.entries.contains_key(scene_id)
    }

    pub fn program_scene(&self) -> Option<Arc<PreparedScene>> {
        self.program_scene_id
            .as_deref()
            .and_then(|id| self.entries.get(id))
            .map(|entry| Arc::clone(&entry.scene))
    }

    pub fn scene(
        &self,
        scene_id: &str,
        revision: &str,
    ) -> Result<Arc<PreparedScene>, SceneRegistryError> {
        self.validate_revision(scene_id, revision)?;
        Ok(Arc::clone(
            &self
                .entries
                .get(scene_id)
                .expect("validated scene must remain loaded")
                .scene,
        ))
    }

    pub fn program_scene_id(&self) -> Option<&str> {
        self.program_scene_id.as_deref()
    }

    pub fn preview_scene_id(&self) -> Option<&str> {
        self.preview_scene_id.as_deref()
    }

    pub fn max_warm_scenes(&self) -> usize {
        self.max_warm_scenes
    }

    pub fn max_cache_bytes(&self) -> u64 {
        self.max_cache_bytes
    }

    pub fn set_limits(&mut self, max_warm_scenes: usize, max_cache_bytes: u64) -> Vec<String> {
        self.max_warm_scenes = max_warm_scenes;
        self.max_cache_bytes = max_cache_bytes;
        self.evict_excess_warm_scenes()
    }

    pub fn warm_scene_count(&self) -> usize {
        self.entries
            .values()
            .filter(|entry| entry.lifecycle == SceneLifecycle::Warm)
            .count()
    }

    pub fn estimated_cache_bytes(&self) -> u64 {
        self.entries
            .values()
            .map(|entry| entry.estimated_bytes)
            .sum()
    }

    pub fn statuses(&self) -> Vec<SceneLifecycleStatus> {
        let mut statuses: Vec<_> = self
            .entries
            .values()
            .map(|entry| SceneLifecycleStatus {
                id: entry.scene.scene_id.clone(),
                name: entry.scene.name.clone(),
                revision: entry.scene.revision.clone(),
                lifecycle: entry.lifecycle,
                object_count: entry.scene.object_count,
                rect_count: entry.scene.rects.len(),
                mesh_count: entry.scene.meshes.len(),
                diagnostics: entry.scene.diagnostics.clone(),
                warnings: entry.scene.warnings.clone(),
                take_blockers: entry.scene.take_blockers.clone(),
                estimated_bytes: entry.estimated_bytes,
                last_used: entry.last_used,
            })
            .collect();
        statuses.sort_by(|left, right| left.id.cmp(&right.id));
        statuses
    }

    fn validate_revision(&self, scene_id: &str, revision: &str) -> Result<(), SceneRegistryError> {
        let entry = self
            .entries
            .get(scene_id)
            .ok_or_else(|| SceneRegistryError::UnknownScene(scene_id.to_string()))?;
        if entry.scene.revision != revision {
            return Err(SceneRegistryError::RevisionMismatch {
                scene_id: scene_id.to_string(),
                expected: revision.to_string(),
                actual: entry.scene.revision.clone(),
            });
        }
        Ok(())
    }

    fn lifecycle_for(&self, scene_id: &str) -> SceneLifecycle {
        if self.program_scene_id.as_deref() == Some(scene_id) {
            SceneLifecycle::Program
        } else if self.preview_scene_id.as_deref() == Some(scene_id) {
            SceneLifecycle::Preview
        } else {
            SceneLifecycle::Warm
        }
    }

    fn refresh_lifecycles(&mut self) {
        let program = self.program_scene_id.as_deref();
        let preview = self.preview_scene_id.as_deref();
        for (scene_id, entry) in &mut self.entries {
            entry.lifecycle = if program == Some(scene_id.as_str()) {
                SceneLifecycle::Program
            } else if preview == Some(scene_id.as_str()) {
                SceneLifecycle::Preview
            } else {
                SceneLifecycle::Warm
            };
        }
    }

    fn touch(&mut self, scene_id: &str) {
        let last_used = self.tick();
        if let Some(entry) = self.entries.get_mut(scene_id) {
            entry.last_used = last_used;
        }
    }

    fn tick(&mut self) -> u64 {
        self.usage_clock = self.usage_clock.saturating_add(1);
        self.usage_clock
    }

    fn evict_excess_warm_scenes(&mut self) -> Vec<String> {
        let mut evicted = Vec::new();
        while self.warm_scene_count() > self.max_warm_scenes
            || self.estimated_cache_bytes() > self.max_cache_bytes
        {
            let candidate = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.lifecycle == SceneLifecycle::Warm)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(scene_id, _)| scene_id.clone());

            let Some(scene_id) = candidate else {
                break;
            };
            if let Some(entry) = self.entries.get_mut(&scene_id) {
                entry.lifecycle = SceneLifecycle::Evictable;
            }
            self.entries.remove(&scene_id);
            evicted.push(scene_id);
        }
        evicted
    }
}

pub fn estimate_prepared_scene_bytes(scene: &PreparedScene) -> u64 {
    let rect_bytes = scene.rects.len() * std::mem::size_of::<PreparedRect>();
    let light_bytes = scene.lights.len() * std::mem::size_of::<super::PreparedLight>();
    let mesh_bytes: usize = scene
        .meshes
        .iter()
        .flat_map(|mesh| &mesh.surfaces)
        .map(|surface| {
            surface.vertices.len() * std::mem::size_of::<PreparedMeshVertex>()
                + surface.indices.len() * std::mem::size_of::<u32>()
                + surface
                    .material
                    .texture
                    .as_ref()
                    .map(|texture| texture.rgba8.len())
                    .unwrap_or_default()
        })
        .sum();
    let warning_bytes: usize = scene.warnings.iter().map(String::len).sum();
    let source_bytes = serde_json::to_vec(&scene.source_document)
        .map(|bytes| bytes.len())
        .unwrap_or_default();
    (std::mem::size_of::<PreparedScene>()
        + rect_bytes
        + light_bytes
        + mesh_bytes
        + warning_bytes
        + source_bytes) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(id: &str, revision: &str) -> Arc<PreparedScene> {
        Arc::new(PreparedScene {
            scene_id: id.to_string(),
            name: id.to_string(),
            revision: revision.to_string(),
            canvas_width: 1920.0,
            canvas_height: 1080.0,
            background_linear_premultiplied: [0.0; 4],
            background_gradient: PreparedGradient::default(),
            rects: Vec::new(),
            meshes: Vec::new(),
            lights: Vec::new(),
            object_count: 0,
            warnings: Vec::new(),
            diagnostics: Vec::new(),
            take_blockers: Vec::new(),
            source_document: serde_json::json!({
                "id": id,
                "updatedAt": revision
            }),
        })
    }

    #[test]
    fn owns_one_program_one_preview_and_bounded_warm_lru() {
        let mut registry = SceneRegistry::new(2, u64::MAX);
        registry.insert(scene("program", "r1"));
        registry
            .take_program("program", "r1")
            .expect("program scene must activate");
        registry.insert(scene("preview", "r1"));
        registry
            .set_preview("preview", "r1")
            .expect("preview scene must activate");

        registry.insert(scene("warm_1", "r1"));
        registry.insert(scene("warm_2", "r1"));
        let evicted = registry.insert(scene("warm_3", "r1"));

        assert_eq!(evicted, vec!["warm_1"]);
        assert!(registry.contains("program"));
        assert!(registry.contains("preview"));
        assert!(registry.contains("warm_2"));
        assert!(registry.contains("warm_3"));
        assert_eq!(registry.warm_scene_count(), 2);
        assert_eq!(registry.program_scene_id(), Some("program"));
        assert_eq!(registry.preview_scene_id(), Some("preview"));
    }

    #[test]
    fn rejects_stale_revision_and_active_release() {
        let mut registry = SceneRegistry::new(3, u64::MAX);
        registry.insert(scene("s1", "r2"));
        let revision_error = registry
            .set_preview("s1", "r1")
            .expect_err("stale revision must fail");
        assert!(matches!(
            revision_error,
            SceneRegistryError::RevisionMismatch { .. }
        ));

        registry
            .take_program("s1", "r2")
            .expect("scene must activate");
        assert_eq!(
            registry.release("s1", "r2"),
            Err(SceneRegistryError::ActiveScene("s1".to_string()))
        );
    }

    #[test]
    fn updating_an_active_scene_preserves_channel_ownership() {
        let mut registry = SceneRegistry::new(3, u64::MAX);
        registry.insert(scene("s1", "r1"));
        registry
            .take_program("s1", "r1")
            .expect("scene must activate");
        registry.insert(scene("s1", "r2"));

        let status = registry
            .statuses()
            .into_iter()
            .find(|status| status.id == "s1")
            .expect("scene status");
        assert_eq!(status.revision, "r2");
        assert_eq!(status.lifecycle, SceneLifecycle::Program);
    }

    #[test]
    fn tighter_limits_evict_only_warm_scenes() {
        let mut registry = SceneRegistry::new(3, u64::MAX);
        registry.insert(scene("program", "r1"));
        registry
            .take_program("program", "r1")
            .expect("program activation");
        registry.insert(scene("preview", "r1"));
        registry
            .set_preview("preview", "r1")
            .expect("preview activation");
        registry.insert(scene("warm", "r1"));

        let evicted = registry.set_limits(0, u64::MAX);
        assert_eq!(evicted, vec!["warm"]);
        assert!(registry.contains("program"));
        assert!(registry.contains("preview"));
    }
}
