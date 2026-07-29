//! Incremental scene patches.
//!
//! The alternative is resending the whole document on every keystroke. A 400-object
//! scene with embedded assets is megabytes; at 30 edits a second that is not a network
//! problem so much as a re-prepare problem — the engine would rebuild every text
//! layout and every mesh for a nudged rectangle.
//!
//! Three properties this has to hold, in order of how badly getting them wrong hurts:
//!
//! 1. **Atomic.** A patch that fails half way through would leave the engine rendering
//!    a document that exists nowhere else, which is invisible from the output and
//!    therefore the worst possible failure. Operations are applied to a clone and the
//!    clone replaces the document only if every operation succeeded.
//!
//! 2. **Revision-gated.** `baseRevision` must be exactly what the engine holds. A patch
//!    based on anything else is refused with `REVISION_MISMATCH` and the sender is told
//!    to resync — never merged hopefully.
//!
//! 3. **Precise about what it dirtied.** The point of a patch is to avoid work, so the
//!    outcome reports which objects changed and whether the change was structural. A
//!    moved object dirties the tiles it left and the tiles it entered; a changed
//!    timeline dirties everything.
//!
//! This is the Rust counterpart to `Shared/scene-model/src/patch.ts` and the operation
//! set is deliberately identical: the two are a wire contract, and a divergence between
//! them is a scene that renders differently in the Editor and on air.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenePatch {
    pub scene_id: String,
    /// The revision the sender believed the engine held.
    pub base_revision: u64,
    /// The revision after applying. Must be greater than `base_revision`.
    pub revision: u64,
    #[serde(default)]
    pub timestamp_ms: u64,
    pub operations: Vec<PatchOperation>,
    /// Who produced it, for attribution when several editors are connected.
    #[serde(default)]
    pub origin: Option<String>,
}

/// Fields an `object.transform` operation may carry. All optional: a patch says what
/// changed, not what the object now is.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformDelta {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z_depth: Option<f64>,
    pub rotation: Option<f64>,
    pub rotation_x: Option<f64>,
    pub rotation_y: Option<f64>,
    pub rotation_z: Option<f64>,
    pub scale_x: Option<f64>,
    pub scale_y: Option<f64>,
    pub scale_z: Option<f64>,
    pub opacity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PatchOperation {
    #[serde(rename = "object.created", rename_all = "camelCase")]
    ObjectCreated {
        object: Value,
        /// Insert position; appended when absent.
        #[serde(default)]
        index: Option<usize>,
    },
    #[serde(rename = "object.deleted", rename_all = "camelCase")]
    ObjectDeleted { object_id: String },
    #[serde(rename = "object.transform", rename_all = "camelCase")]
    ObjectTransform {
        object_id: String,
        transform: TransformDelta,
    },
    #[serde(rename = "object.text", rename_all = "camelCase")]
    ObjectText { object_id: String, text: String },
    #[serde(rename = "object.material", rename_all = "camelCase")]
    ObjectMaterial {
        object_id: String,
        slot: String,
        /// Null clears the slot.
        material_id: Option<String>,
    },
    #[serde(rename = "object.animation", rename_all = "camelCase")]
    ObjectAnimation {
        object_id: String,
        channels: Map<String, Value>,
    },
    #[serde(rename = "object.visibility", rename_all = "camelCase")]
    ObjectVisibility { object_id: String, visible: bool },
    #[serde(rename = "object.property", rename_all = "camelCase")]
    ObjectProperty {
        object_id: String,
        /// Dot/bracket path relative to the object.
        path: String,
        value: Value,
    },
    #[serde(rename = "layer.reorder", rename_all = "camelCase")]
    LayerReorder { object_ids: Vec<String> },
    #[serde(rename = "asset.changed", rename_all = "camelCase")]
    AssetChanged { asset: Value },
    #[serde(rename = "material.changed", rename_all = "camelCase")]
    MaterialChanged { material: Value },
    #[serde(rename = "timeline.changed", rename_all = "camelCase")]
    TimelineChanged { timeline: Value },
    #[serde(rename = "dataContext.changed", rename_all = "camelCase")]
    DataContextChanged { path: String, value: Value },
    #[serde(rename = "surface.changed", rename_all = "camelCase")]
    SurfaceChanged { surface_id: String, value: Value },
    #[serde(rename = "outputMapping.changed", rename_all = "camelCase")]
    OutputMappingChanged { mapping_id: String, value: Value },
    #[serde(rename = "scene.published", rename_all = "camelCase")]
    ScenePublished { revision: u64 },
    #[serde(rename = "scene.recalled", rename_all = "camelCase")]
    SceneRecalled { revision: u64 },
}

impl PatchOperation {
    /// The operation name, for diagnostics and error messages.
    pub fn name(&self) -> &'static str {
        match self {
            Self::ObjectCreated { .. } => "object.created",
            Self::ObjectDeleted { .. } => "object.deleted",
            Self::ObjectTransform { .. } => "object.transform",
            Self::ObjectText { .. } => "object.text",
            Self::ObjectMaterial { .. } => "object.material",
            Self::ObjectAnimation { .. } => "object.animation",
            Self::ObjectVisibility { .. } => "object.visibility",
            Self::ObjectProperty { .. } => "object.property",
            Self::LayerReorder { .. } => "layer.reorder",
            Self::AssetChanged { .. } => "asset.changed",
            Self::MaterialChanged { .. } => "material.changed",
            Self::TimelineChanged { .. } => "timeline.changed",
            Self::DataContextChanged { .. } => "dataContext.changed",
            Self::SurfaceChanged { .. } => "surface.changed",
            Self::OutputMappingChanged { .. } => "outputMapping.changed",
            Self::ScenePublished { .. } => "scene.published",
            Self::SceneRecalled { .. } => "scene.recalled",
        }
    }

    /// The object this operation targets, when it targets one.
    pub fn object_id(&self) -> Option<&str> {
        match self {
            Self::ObjectDeleted { object_id }
            | Self::ObjectTransform { object_id, .. }
            | Self::ObjectText { object_id, .. }
            | Self::ObjectMaterial { object_id, .. }
            | Self::ObjectAnimation { object_id, .. }
            | Self::ObjectVisibility { object_id, .. }
            | Self::ObjectProperty { object_id, .. } => Some(object_id),
            Self::ObjectCreated { object, .. } => object.get("id").and_then(Value::as_str),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchFailure {
    SceneIdMismatch,
    RevisionMismatch,
    RevisionNotAdvancing,
    EmptyPatch,
    UnknownObject,
    InvalidOperation,
    /// The scene document is not shaped the way the contract requires.
    MalformedDocument,
}

impl PatchFailure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SceneIdMismatch => "SCENE_ID_MISMATCH",
            Self::RevisionMismatch => "REVISION_MISMATCH",
            Self::RevisionNotAdvancing => "REVISION_NOT_ADVANCING",
            Self::EmptyPatch => "EMPTY_PATCH",
            Self::UnknownObject => "UNKNOWN_OBJECT",
            Self::InvalidOperation => "INVALID_OPERATION",
            Self::MalformedDocument => "MALFORMED_DOCUMENT",
        }
    }

    /// Whether the sender has to resend the whole document to recover.
    ///
    /// Only for the cases where the two sides genuinely disagree about what is held. An
    /// unknown object in an otherwise well-based patch is a bad patch, not a lost
    /// conversation.
    pub fn requires_full_sync(&self) -> bool {
        matches!(
            self,
            Self::RevisionMismatch | Self::RevisionNotAdvancing | Self::MalformedDocument
        )
    }
}

#[derive(Debug, Clone)]
pub struct PatchError {
    pub failure: PatchFailure,
    pub message: String,
    /// Index of the operation that failed, when one did.
    pub operation_index: Option<usize>,
}

impl PatchError {
    fn new(failure: PatchFailure, message: impl Into<String>) -> Self {
        Self {
            failure,
            message: message.into(),
            operation_index: None,
        }
    }

    fn at(failure: PatchFailure, index: usize, message: impl Into<String>) -> Self {
        Self {
            failure,
            message: message.into(),
            operation_index: Some(index),
        }
    }
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct PatchOutcome {
    pub revision: u64,
    /// Objects whose geometry or content changed, so their tiles need redrawing.
    pub touched_objects: Vec<String>,
    /// Objects that no longer exist.
    pub removed_objects: Vec<String>,
    /// True when the change cannot be localised to objects — a timeline change, a
    /// reorder, or a data-context change that any binding might read.
    pub whole_scene_dirty: bool,
    /// True when the stage rather than the scene changed, so the caller reloads it.
    pub stage_changed: bool,
    pub applied_operations: usize,
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/// Apply a patch to a scene document.
///
/// The document is only modified when every operation succeeded; on failure the caller's
/// document is untouched and the error says which operation failed and why.
pub fn apply_patch(document: &mut Value, patch: &ScenePatch) -> Result<PatchOutcome, PatchError> {
    let document_scene_id = document.get("id").and_then(Value::as_str).unwrap_or("");
    if document_scene_id != patch.scene_id {
        return Err(PatchError::new(
            PatchFailure::SceneIdMismatch,
            format!(
                "patch targets scene {} but this document is {document_scene_id}",
                patch.scene_id
            ),
        ));
    }

    let current_revision = document.get("revision").and_then(Value::as_u64).unwrap_or(0);
    if patch.base_revision != current_revision {
        return Err(PatchError::new(
            PatchFailure::RevisionMismatch,
            format!(
                "patch is based on revision {} but the engine holds {current_revision}; resend the scene with scene.fullSync",
                patch.base_revision
            ),
        ));
    }
    if patch.revision <= patch.base_revision {
        return Err(PatchError::new(
            PatchFailure::RevisionNotAdvancing,
            format!(
                "patch revision {} does not advance past {}",
                patch.revision, patch.base_revision
            ),
        ));
    }
    if patch.operations.is_empty() {
        return Err(PatchError::new(
            PatchFailure::EmptyPatch,
            "a patch must carry at least one operation",
        ));
    }

    // Applied to a clone: a half-applied patch would leave the engine rendering a
    // document that exists nowhere else.
    let mut working = document.clone();
    let mut outcome = PatchOutcome {
        revision: patch.revision,
        ..PatchOutcome::default()
    };

    for (index, operation) in patch.operations.iter().enumerate() {
        apply_operation(&mut working, operation, index, &mut outcome)?;
        outcome.applied_operations += 1;
    }

    working["revision"] = Value::from(patch.revision);
    *document = working;

    outcome.touched_objects.sort();
    outcome.touched_objects.dedup();
    outcome.removed_objects.sort();
    outcome.removed_objects.dedup();

    Ok(outcome)
}

fn apply_operation(
    document: &mut Value,
    operation: &PatchOperation,
    index: usize,
    outcome: &mut PatchOutcome,
) -> Result<(), PatchError> {
    match operation {
        PatchOperation::ObjectCreated {
            object,
            index: insert_at,
        } => {
            let object_id = object
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PatchError::at(
                        PatchFailure::InvalidOperation,
                        index,
                        "object.created needs an object with an id",
                    )
                })?
                .to_string();

            let objects = objects_mut(document, index)?;
            // Re-creating an existing id replaces it rather than duplicating: two
            // objects with one id would make every later operation ambiguous.
            if let Some(position) = position_of(objects, &object_id) {
                objects[position] = object.clone();
            } else {
                match insert_at {
                    Some(at) if *at <= objects.len() => objects.insert(*at, object.clone()),
                    _ => objects.push(object.clone()),
                }
            }
            outcome.touched_objects.push(object_id);
        }

        PatchOperation::ObjectDeleted { object_id } => {
            let objects = objects_mut(document, index)?;
            let Some(position) = position_of(objects, object_id) else {
                return Err(PatchError::at(
                    PatchFailure::UnknownObject,
                    index,
                    format!("object.deleted names {object_id}, which this scene does not contain"),
                ));
            };
            objects.remove(position);
            outcome.removed_objects.push(object_id.clone());
        }

        PatchOperation::ObjectTransform {
            object_id,
            transform,
        } => {
            let object = object_mut(document, object_id, index)?;
            // Only the fields present in the delta are written. Writing absent fields as
            // null would erase properties the sender never mentioned.
            set_number(object, "x", transform.x);
            set_number(object, "y", transform.y);
            set_number(object, "zDepth", transform.z_depth);
            set_number(object, "rotation", transform.rotation);
            set_number(object, "rotationX", transform.rotation_x);
            set_number(object, "rotationY", transform.rotation_y);
            set_number(object, "rotationZ", transform.rotation_z);
            set_number(object, "scaleX", transform.scale_x);
            set_number(object, "scaleY", transform.scale_y);
            set_number(object, "scaleZ", transform.scale_z);
            set_number(object, "opacity", transform.opacity);
            outcome.touched_objects.push(object_id.clone());
        }

        PatchOperation::ObjectText { object_id, text } => {
            let object = object_mut(document, object_id, index)?;
            object["text"] = Value::from(text.clone());
            outcome.touched_objects.push(object_id.clone());
        }

        PatchOperation::ObjectMaterial {
            object_id,
            slot,
            material_id,
        } => {
            let object = object_mut(document, object_id, index)?;
            if !object.get("materialSlots").is_some_and(Value::is_object) {
                object["materialSlots"] = Value::Object(Map::new());
            }
            let Some(slots) = object
                .get_mut("materialSlots")
                .and_then(Value::as_object_mut)
            else {
                return Err(PatchError::at(
                    PatchFailure::InvalidOperation,
                    index,
                    format!("object {object_id} has a materialSlots value that is not an object"),
                ));
            };
            match material_id {
                Some(material_id) => {
                    slots.insert(slot.clone(), Value::from(material_id.clone()));
                }
                // Cleared rather than set to null: an absent slot and a null slot mean
                // the same thing to the renderer, and absent is the shape the document
                // uses everywhere else.
                None => {
                    slots.remove(slot);
                }
            }
            outcome.touched_objects.push(object_id.clone());
        }

        PatchOperation::ObjectAnimation {
            object_id,
            channels,
        } => {
            let object = object_mut(document, object_id, index)?;
            // The field is `animation`, not `channels`: the same mistake in the
            // TypeScript twin silently dropped every animated property.
            object["animation"] = Value::Object(channels.clone());
            outcome.touched_objects.push(object_id.clone());
        }

        PatchOperation::ObjectVisibility { object_id, visible } => {
            let object = object_mut(document, object_id, index)?;
            object["visible"] = Value::from(*visible);
            outcome.touched_objects.push(object_id.clone());
        }

        PatchOperation::ObjectProperty {
            object_id,
            path,
            value,
        } => {
            let object = object_mut(document, object_id, index)?;
            set_path(object, path, value.clone()).map_err(|error| {
                PatchError::at(
                    PatchFailure::InvalidOperation,
                    index,
                    format!("object.property on {object_id}: {error}"),
                )
            })?;
            outcome.touched_objects.push(object_id.clone());
        }

        PatchOperation::LayerReorder { object_ids } => {
            let objects = objects_mut(document, index)?;
            let mut reordered: Vec<Value> = Vec::with_capacity(objects.len());

            for object_id in object_ids {
                let Some(position) = position_of(objects, object_id) else {
                    return Err(PatchError::at(
                        PatchFailure::UnknownObject,
                        index,
                        format!("layer.reorder names {object_id}, which this scene does not contain"),
                    ));
                };
                reordered.push(objects[position].clone());
            }

            // Objects the reorder did not mention keep their relative order at the end.
            // Dropping them would delete content through an operation that is supposed
            // to be a reorder.
            for object in objects.iter() {
                let id = object.get("id").and_then(Value::as_str).unwrap_or("");
                if !object_ids.iter().any(|named| named == id) {
                    reordered.push(object.clone());
                }
            }

            *objects = reordered;
            // Draw order changes what covers what, so no per-object invalidation is
            // enough.
            outcome.whole_scene_dirty = true;
        }

        PatchOperation::AssetChanged { asset } => {
            let asset_id = asset
                .get("assetId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PatchError::at(
                        PatchFailure::InvalidOperation,
                        index,
                        "asset.changed needs an asset with an assetId",
                    )
                })?
                .to_string();
            upsert_by_key(document, "assets", "assetId", &asset_id, asset);
            // Any object could reference it, and the document does not carry a reverse
            // index.
            outcome.whole_scene_dirty = true;
        }

        PatchOperation::MaterialChanged { material } => {
            let material_id = material
                .get("materialId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PatchError::at(
                        PatchFailure::InvalidOperation,
                        index,
                        "material.changed needs a material with a materialId",
                    )
                })?
                .to_string();
            upsert_by_key(document, "materials", "materialId", &material_id, material);
            outcome.whole_scene_dirty = true;
        }

        PatchOperation::TimelineChanged { timeline } => {
            document["timeline"] = timeline.clone();
            outcome.whole_scene_dirty = true;
        }

        PatchOperation::DataContextChanged { path, value } => {
            if !document.get("dataContext").is_some_and(Value::is_object) {
                document["dataContext"] = Value::Object(Map::new());
            }
            let context = document
                .get_mut("dataContext")
                .expect("set immediately above");
            set_path(context, path, value.clone()).map_err(|error| {
                PatchError::at(
                    PatchFailure::InvalidOperation,
                    index,
                    format!("dataContext.changed at \"{path}\": {error}"),
                )
            })?;
            // A bound value can be read by any object.
            outcome.whole_scene_dirty = true;
        }

        // Stage-side changes. The engine holds stages separately from scenes, so these
        // are reported rather than applied to the document.
        PatchOperation::SurfaceChanged { .. } | PatchOperation::OutputMappingChanged { .. } => {
            outcome.stage_changed = true;
        }

        // Bookkeeping only: the revision is set from the patch itself.
        PatchOperation::ScenePublished { .. } | PatchOperation::SceneRecalled { .. } => {}
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

fn objects_mut(document: &mut Value, index: usize) -> Result<&mut Vec<Value>, PatchError> {
    document
        .get_mut("objects")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            PatchError::at(
                PatchFailure::MalformedDocument,
                index,
                "the scene document has no objects array",
            )
        })
}

fn position_of(objects: &[Value], object_id: &str) -> Option<usize> {
    objects
        .iter()
        .position(|object| object.get("id").and_then(Value::as_str) == Some(object_id))
}

fn object_mut<'a>(
    document: &'a mut Value,
    object_id: &str,
    index: usize,
) -> Result<&'a mut Value, PatchError> {
    let objects = objects_mut(document, index)?;
    let position = position_of(objects, object_id).ok_or_else(|| {
        PatchError::at(
            PatchFailure::UnknownObject,
            index,
            format!("this scene does not contain an object {object_id}"),
        )
    })?;
    Ok(&mut objects[position])
}

fn set_number(object: &mut Value, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        object[key] = serde_json::Number::from_f64(value)
            .map(Value::Number)
            // A non-finite transform is a bug upstream, but writing null would corrupt
            // the document; leaving the previous value is the lesser harm.
            .unwrap_or_else(|| object.get(key).cloned().unwrap_or(Value::Null));
    }
}

fn upsert_by_key(document: &mut Value, array: &str, key: &str, id: &str, value: &Value) {
    if !document.get(array).is_some_and(Value::is_array) {
        document[array] = Value::Array(Vec::new());
    }
    if let Some(entries) = document.get_mut(array).and_then(Value::as_array_mut) {
        match entries
            .iter()
            .position(|entry| entry.get(key).and_then(Value::as_str) == Some(id))
        {
            Some(position) => entries[position] = value.clone(),
            None => entries.push(value.clone()),
        }
    }
}

/// Write a value at a dot/bracket path, creating intermediate objects.
///
/// `style.fill`, `filters[0].radius`, and `keys[2]` all work. An index past the end of
/// an array appends rather than failing, which is what an editor sending "add a filter"
/// means.
fn set_path(target: &mut Value, path: &str, value: Value) -> Result<(), String> {
    let segments = parse_path(path)?;
    if segments.is_empty() {
        return Err("an empty path cannot be written".to_string());
    }

    let mut cursor = target;
    for position in 0..segments.len() - 1 {
        // The *next* segment decides what an intermediate container has to be: in
        // `filters[0].radius`, "filters" must become an array, not an object.
        let next_is_index = matches!(segments[position + 1], PathSegment::Index(_));
        cursor = descend(cursor, &segments[position], next_is_index)?;
    }

    match &segments[segments.len() - 1] {
        PathSegment::Key(key) => {
            let object = cursor
                .as_object_mut()
                .ok_or_else(|| format!("\"{key}\" is not inside an object"))?;
            object.insert(key.clone(), value);
        }
        PathSegment::Index(at) => {
            let array = cursor
                .as_array_mut()
                .ok_or_else(|| format!("[{at}] is not inside an array"))?;
            if *at < array.len() {
                array[*at] = value;
            } else {
                array.push(value);
            }
        }
    }

    Ok(())
}

fn descend<'a>(
    cursor: &'a mut Value,
    segment: &PathSegment,
    next_is_index: bool,
) -> Result<&'a mut Value, String> {
    let fresh = || {
        if next_is_index {
            Value::Array(Vec::new())
        } else {
            Value::Object(Map::new())
        }
    };

    match segment {
        PathSegment::Key(key) => {
            if !cursor.is_object() {
                if cursor.is_null() {
                    *cursor = Value::Object(Map::new());
                } else {
                    return Err(format!("cannot descend into \"{key}\": not an object"));
                }
            }
            let object = cursor.as_object_mut().expect("checked above");
            // A value already there is kept: overwriting a populated object because the
            // path implies a different shape would delete data the sender never mentioned.
            Ok(object.entry(key.clone()).or_insert_with(fresh))
        }
        PathSegment::Index(at) => {
            if !cursor.is_array() {
                if cursor.is_null() {
                    *cursor = Value::Array(Vec::new());
                } else {
                    return Err(format!("cannot index [{at}]: not an array"));
                }
            }
            let array = cursor.as_array_mut().expect("checked above");
            while array.len() <= *at {
                array.push(fresh());
            }
            Ok(&mut array[*at])
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PathSegment {
    Key(String),
    Index(usize),
}

fn parse_path(path: &str) -> Result<Vec<PathSegment>, String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = path.chars().peekable();

    while let Some(character) = chars.next() {
        match character {
            '.' => {
                if !current.is_empty() {
                    segments.push(PathSegment::Key(std::mem::take(&mut current)));
                }
            }
            '[' => {
                if !current.is_empty() {
                    segments.push(PathSegment::Key(std::mem::take(&mut current)));
                }
                let mut digits = String::new();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next == ']' {
                        break;
                    }
                    digits.push(next);
                }
                let at: usize = digits
                    .trim()
                    .parse()
                    .map_err(|_| format!("\"{digits}\" is not an array index"))?;
                segments.push(PathSegment::Index(at));
            }
            ']' => return Err("unbalanced ] in path".to_string()),
            _ => current.push(character),
        }
    }

    if !current.is_empty() {
        segments.push(PathSegment::Key(current));
    }
    Ok(segments)
}
