//! Object lifecycle: the four edits that author a document (11.18).
//!
//! Until now the Editor could open a scene and change what was already in it,
//! but it could not make one. Create, duplicate, rename and delete are the
//! edits that turn a reader into an authoring tool, and they are here rather
//! than in the shell because the rules are the document's, not the UI's:
//! every peer that edits a scene has to delete a group the same way.
//!
//! Two disciplines run through all of it:
//!
//! - **A created object must be visible and selectable.** An object with no
//!   size, no fill, or off-canvas is one the author cannot find, and a tool
//!   that produces invisible work is broken in a way no error message covers.
//! - **A refused edit changes nothing.** Every function validates before it
//!   writes, so a scene that refused an edit is the one that was passed in —
//!   never half-applied.
//!
//! Delete carries the third: **the consequence is reported, not assumed.**
//! Deleting a group takes its children, its channels and possibly the scene's
//! active camera with it, so `delete_object` returns what it removed instead
//! of quietly doing more than the author asked.

use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::{ColorValue, Rgba, SourceColorSpace};
use crate::scene::{
    CameraKind, CameraObject, EllipseObject, GroupObject, LayerKind, LayerObject, LineObject,
    ObjectBase, RectObject, SceneDocument, SceneObject, TextObject, Vec2,
};
use crate::Refusal;

/// The kinds the authoring surface can complete on its own, in the order a
/// menu should offer them.
///
/// The catalogue (1.2) is larger than this on purpose. `image`, `mesh`,
/// `shape` and `paint` each need something only the caller has — an asset, a
/// path, brush points — and `marker` belongs to the timeline, not the object
/// list. A `light` needs a mesh bound to a PBR material to light, and meshes
/// are not drawn until 11.48 (a lone light refuses at publish as
/// `LightHasNoResponsiveMaterial`). Creating any of those blank would produce
/// an object that refuses the moment it is published, so they are refused
/// here instead, by name and with what they need.
pub const CREATABLE_KINDS: &[&str] = &[
    "rect", "ellipse", "text", "line", "group", "layer", "camera",
];

/// What a kind needs before it can be created, for the kinds that cannot be
/// completed from nothing. `None` means the kind is creatable.
fn missing_prerequisite(kind: &str) -> Option<&'static str> {
    match kind {
        "image" => Some("an image asset in the scene's asset library"),
        "mesh" => Some("a model asset in the scene's asset library"),
        "shape" => Some("a bezier path"),
        "paint" => Some("brush points"),
        "marker" => Some("a timeline frame; markers are created on the timeline"),
        "light" => Some("a mesh bound to a PBR material for it to light, which step 11.48 draws"),
        _ => None,
    }
}

/// Default size in scene units, per kind. A created object is given a box big
/// enough to see and click; zero-sized objects are not authorable.
fn default_size(kind: &str) -> (f64, f64) {
    match kind {
        "ellipse" => (200.0, 200.0),
        "text" => (480.0, 120.0),
        "line" => (240.0, 0.0),
        // Containers have no box of their own; they take their extent from
        // their children, and a non-zero size would be a lie about that.
        "group" | "layer" | "camera" => (0.0, 0.0),
        _ => (200.0, 120.0),
    }
}

/// Mid grey, opaque, in the scene's authoring space. A created shape needs a
/// fill for the same reason it needs a size: an unfilled rectangle is an
/// object the author cannot see or hit-test.
fn default_fill() -> ColorValue {
    ColorValue::Solid {
        color: Rgba::new(0.5, 0.5, 0.5, 1.0, SourceColorSpace::Srgb),
    }
}

/// The smallest `kind-n` (n from 1) that no object in the scene already uses.
///
/// Deterministic rather than random so a created id is reproducible in a test
/// and readable in a diff.
fn next_object_id(scene: &SceneDocument, kind: &str) -> String {
    let taken: BTreeSet<&str> = scene.objects.iter().map(|o| o.base().id.as_str()).collect();
    (1..)
        .map(|n| format!("{kind}-{n}"))
        .find(|candidate| !taken.contains(candidate.as_str()))
        .expect("an unbounded sequence always contains a free id")
}

/// Build the object itself, centred in the canvas so it lands where the author
/// is looking.
fn build_object(scene: &SceneDocument, kind: &str, id: String, name: String) -> SceneObject {
    let (width, height) = default_size(kind);
    let mut base = ObjectBase::new(id, name);
    base.width = width;
    base.height = height;
    base.x = (f64::from(scene.canvas.width) - width) / 2.0;
    base.y = (f64::from(scene.canvas.height) - height) / 2.0;

    match kind {
        "rect" => {
            base.fill = Some(default_fill());
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        }
        "ellipse" => {
            base.fill = Some(default_fill());
            SceneObject::Ellipse(EllipseObject { base })
        }
        "text" => {
            base.fill = Some(default_fill());
            SceneObject::Text(TextObject {
                // The caller guarantees a font exists; `create_object` refuses
                // before reaching here when the scene's font list is empty.
                font_id: scene.fonts[0].font_id.clone(),
                base,
                text: "Text".to_owned(),
                size: 64.0,
                layout: Default::default(),
                auto_fit: Default::default(),
                writing_mode: Default::default(),
                vertical_align: Default::default(),
                direction: Default::default(),
                text_case: Default::default(),
                decoration: Default::default(),
                overflow: Default::default(),
                align: Default::default(),
                line_height: None,
                letter_spacing: 0.0,
                word_spacing: 0.0,
                paragraph_spacing: 0.0,
                text_indent: 0.0,
            })
        }
        "line" => {
            // A line is its stroke; without one it draws nothing.
            base.stroke = Some(default_fill());
            base.stroke_width = 2.0;
            SceneObject::Line(LineObject {
                base,
                points: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: width, y: 0.0 }],
            })
        }
        "group" => SceneObject::Group(GroupObject {
            base,
            child_ids: Vec::new(),
        }),
        "layer" => SceneObject::Layer(LayerObject {
            base,
            layer_kind: LayerKind::Object,
            child_ids: Vec::new(),
        }),
        "camera" => SceneObject::Camera(CameraObject {
            base,
            camera_kind: CameraKind::Perspective,
            fov: 50.0,
            zoom: 1.0,
            near: None,
            far: None,
            target: None,
            up: None,
        }),
        // `CREATABLE_KINDS` gates the set, so an unmatched name here is a
        // catalogue that grew without a constructor — a bug, not input.
        other => unreachable!("kind {other} is advertised as creatable but has no constructor"),
    }
}

/// Create an object of `kind` and return its generated id.
///
/// The object is appended in scene order and centred in the canvas. It is not
/// claimed by any container: parenting is a separate, explicit edit, because a
/// creation that silently joined whatever was selected is the kind of guess
/// invariant 18 forbids.
pub fn create_object(scene: &mut SceneDocument, kind: &str, name: &str) -> Result<String, Refusal> {
    refuse_duplicate_object_ids(scene)?;

    if let Some(needs) = missing_prerequisite(kind) {
        return Err(Refusal::SceneObjectKindNotCreatable {
            kind: kind.to_owned(),
            needs: needs.to_owned(),
        });
    }
    if !CREATABLE_KINDS.contains(&kind) {
        return Err(Refusal::SceneObjectKindNotCreatable {
            kind: kind.to_owned(),
            needs: format!("a kind the catalogue knows: {}", CREATABLE_KINDS.join(", ")),
        });
    }
    if kind == "text" && scene.fonts.is_empty() {
        return Err(Refusal::SceneObjectKindNotCreatable {
            kind: kind.to_owned(),
            needs: "a font in the scene's font list".to_owned(),
        });
    }

    let name = name.trim();
    if name.is_empty() {
        return Err(Refusal::SceneObjectNameEmpty);
    }

    let id = next_object_id(scene, kind);
    let object = build_object(scene, kind, id.clone(), name.to_owned());
    scene.objects.push(object);
    Ok(id)
}

/// What a delete removed. Returned rather than logged so the caller can tell
/// the author the whole consequence in one sentence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDeletion {
    /// Every object removed, in scene order: the target first, then the
    /// descendants it claimed.
    pub removed_object_ids: Vec<String>,
    /// Animation channels removed with them. A channel for an object that no
    /// longer exists is an orphan the timeline would draw forever.
    pub removed_channel_count: usize,
    /// Set when the scene's active camera was among the removed. The scene
    /// falls back to the documented synthetic camera, which is a real change
    /// to what Program renders and so is never left unsaid.
    pub cleared_active_camera: bool,
    /// The container that claimed the deleted object, if one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detached_from: Option<String>,
}

/// Every object reachable from `root_id` through container `child_ids`, in
/// scene order, including the root.
///
/// A `visited` set bounds the walk: the resolver tolerates cyclic edges (1.2),
/// so this has to as well, rather than looping forever on a scene that is mid
/// repair.
fn descendants(scene: &SceneDocument, root_id: &str) -> Vec<String> {
    let by_id: HashMap<&str, &SceneObject> = scene
        .objects
        .iter()
        .map(|o| (o.base().id.as_str(), o))
        .collect();

    let mut ordered: Vec<String> = Vec::new();
    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<String> = vec![root_id.to_owned()];

    while let Some(id) = queue.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        if let Some(object) = by_id.get(id.as_str()) {
            // Reversed so `pop` yields children in scene order.
            for child in object.child_ids().iter().rev() {
                queue.push(child.clone());
            }
        }
        ordered.push(id);
    }
    ordered
}

/// Delete an object, the descendants it claims, and everything that referred
/// to them.
///
/// Deleting a container takes its children: that is what every authoring tool
/// means by deleting a group, and leaving orphans behind would make the
/// document's hierarchy depend on the order things were removed.
pub fn delete_object(
    scene: &mut SceneDocument,
    object_id: &str,
) -> Result<ObjectDeletion, Refusal> {
    refuse_duplicate_object_ids(scene)?;
    require_object(scene, object_id)?;

    let removed = descendants(scene, object_id);
    let removed_set: BTreeSet<String> = removed.iter().cloned().collect();

    let detached_from = scene
        .objects
        .iter()
        .find(|object| {
            !removed_set.contains(object.base().id.as_str())
                && object.child_ids().iter().any(|child| child == object_id)
        })
        .map(|object| object.base().id.clone());

    let channels_before = scene.timeline.channels.len();
    scene
        .timeline
        .channels
        .retain(|channel| !removed_set.contains(channel.object_id.as_str()));
    let removed_channel_count = channels_before - scene.timeline.channels.len();

    let cleared_active_camera = scene
        .active_camera_id
        .as_deref()
        .is_some_and(|id| removed_set.contains(id));
    if cleared_active_camera {
        scene.active_camera_id = None;
    }

    scene
        .objects
        .retain(|object| !removed_set.contains(object.base().id.as_str()));

    // Surviving containers must stop claiming children that no longer exist,
    // or the resolver reports a MissingChild diagnostic for an edit that was
    // deliberate.
    for object in &mut scene.objects {
        if let Some(children) = child_ids_mut(object) {
            children.retain(|child| !removed_set.contains(child.as_str()));
        }
    }

    Ok(ObjectDeletion {
        removed_object_ids: removed,
        removed_channel_count,
        cleared_active_camera,
        detached_from,
    })
}

/// What a duplicate created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDuplication {
    /// The copy of the object that was asked for; what the editor selects.
    pub new_object_id: String,
    /// Every object created, in scene order.
    pub created_object_ids: Vec<String>,
    /// Animation channels copied onto the new objects. A duplicate that
    /// dropped the animation would look right and play wrong.
    pub copied_channel_count: usize,
}

/// Duplicate an object and everything it claims, animation included.
///
/// The copy is inserted directly after the original in scene order and joins
/// the same parent, so a duplicate appears next to what it came from rather
/// than at the end of the document.
pub fn duplicate_object(
    scene: &mut SceneDocument,
    object_id: &str,
) -> Result<ObjectDuplication, Refusal> {
    refuse_duplicate_object_ids(scene)?;
    require_object(scene, object_id)?;

    let sources = descendants(scene, object_id);

    // Reserve every new id before copying, so a group and its children cannot
    // be handed the same generated id.
    let mut taken: BTreeSet<String> =
        scene.objects.iter().map(|o| o.base().id.clone()).collect();
    let mut remap: HashMap<String, String> = HashMap::new();
    for source in &sources {
        let Some(object) = find_object(scene, source) else {
            continue;
        };
        let kind = object.kind();
        let fresh = (1..)
            .map(|n| format!("{kind}-{n}"))
            .find(|candidate| !taken.contains(candidate))
            .expect("an unbounded sequence always contains a free id");
        taken.insert(fresh.clone());
        remap.insert(source.clone(), fresh);
    }

    let mut copies: Vec<SceneObject> = Vec::with_capacity(remap.len());
    for source in &sources {
        let Some(object) = find_object(scene, source) else {
            continue;
        };
        let mut copy = object.clone();
        copy.base_mut().id = remap[source].clone();
        copy.base_mut().name = format!("{} copy", object.base().name);
        if let Some(children) = child_ids_mut(&mut copy) {
            // A copied container claims the copies, never the originals.
            children.retain(|child| remap.contains_key(child));
            for child in children.iter_mut() {
                *child = remap[child.as_str()].clone();
            }
        }
        copies.push(copy);
    }

    let mut copied_channels = Vec::new();
    for channel in &scene.timeline.channels {
        if let Some(new_id) = remap.get(&channel.object_id) {
            let mut copy = channel.clone();
            copy.object_id = new_id.clone();
            copied_channels.push(copy);
        }
    }
    let copied_channel_count = copied_channels.len();
    scene.timeline.channels.extend(copied_channels);

    let created_object_ids: Vec<String> = copies.iter().map(|c| c.base().id.clone()).collect();
    let new_object_id = remap[object_id].clone();

    let insert_at = scene
        .objects
        .iter()
        .position(|object| object.base().id == object_id)
        .map_or(scene.objects.len(), |index| index + 1);
    scene.objects.splice(insert_at..insert_at, copies);

    // The copy joins the original's parent, directly after it.
    let parent = scene
        .objects
        .iter()
        .position(|object| object.child_ids().iter().any(|child| child == object_id));
    if let Some(index) = parent {
        if let Some(children) = child_ids_mut(&mut scene.objects[index]) {
            let after = children
                .iter()
                .position(|child| child == object_id)
                .map_or(children.len(), |at| at + 1);
            children.insert(after, new_object_id.clone());
        }
    }

    Ok(ObjectDuplication {
        new_object_id,
        created_object_ids,
        copied_channel_count,
    })
}

/// Rename an object. The name is what the author reads in every panel, so an
/// empty one is refused rather than stored.

pub fn rename_object(
    scene: &mut SceneDocument,
    object_id: &str,
    name: &str,
) -> Result<(), Refusal> {
    refuse_duplicate_object_ids(scene)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(Refusal::SceneObjectNameEmpty);
    }
    let index = object_index(scene, object_id)?;
    scene.objects[index].base_mut().name = name.to_owned();
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared helpers. Kept private: the document's rules are the public surface,
// not the ways of reaching into it.
// ---------------------------------------------------------------------------

fn refuse_duplicate_object_ids(scene: &SceneDocument) -> Result<(), Refusal> {
    let mut seen = BTreeSet::new();
    for object in &scene.objects {
        if !seen.insert(object.base().id.as_str()) {
            return Err(Refusal::SceneDuplicateObjectId {
                object_id: object.base().id.clone(),
            });
        }
    }
    Ok(())
}

fn object_index(scene: &SceneDocument, object_id: &str) -> Result<usize, Refusal> {
    scene
        .objects
        .iter()
        .position(|object| object.base().id == object_id)
        .ok_or_else(|| Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        })
}

fn require_object(scene: &SceneDocument, object_id: &str) -> Result<(), Refusal> {
    object_index(scene, object_id).map(|_| ())
}

fn find_object<'a>(scene: &'a SceneDocument, object_id: &str) -> Option<&'a SceneObject> {
    scene
        .objects
        .iter()
        .find(|object| object.base().id == object_id)
}

/// Mutable access to a container's children. `None` for kinds that claim none,
/// which is how the callers above stay free of a per-kind match.
fn child_ids_mut(object: &mut SceneObject) -> Option<&mut Vec<String>> {
    match object {
        SceneObject::Layer(o) => Some(&mut o.child_ids),
        SceneObject::Group(o) => Some(&mut o.child_ids),
        _ => None,
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use crate::scene::{SceneCanvas, SceneTimeline};
    use crate::{RationalRate, Revision};

    fn scene() -> SceneDocument {
        SceneDocument {
            working_color_space: crate::color::WorkingColorSpace::LinearSrgb,
            id: "authoring".into(),
            name: "Authoring".into(),
            version: crate::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 100,
                ..Default::default()
            },
            data_context: Default::default(),
            assets: vec![],
            fonts: vec![],
            materials: vec![],
            controls: vec![],
            text_styles: vec![],
            objects: vec![],
        }
    }

    fn group(id: &str, children: &[&str]) -> SceneObject {
        SceneObject::Group(GroupObject {
            base: ObjectBase::new(id, id),
            child_ids: children.iter().map(|c| (*c).to_owned()).collect(),
        })
    }

    fn channel(object_id: &str, property: &str) -> KeyframeChannel {
        KeyframeChannel {
            object_id: object_id.into(),
            property: property.into(),
            keys: vec![SceneKeyframe {
                frame: 0,
                value: 0.0,
                easing: SceneEasing::Linear,
                bezier: None,
            }],
        }
    }

    #[test]
    fn a_created_object_is_visible_selectable_and_centred() {
        // The whole point of the defaults: an author who clicks "rect" gets
        // something they can see and hit, not a zero-sized invisible object.
        let mut s = scene();
        let id = create_object(&mut s, "rect", "Card").unwrap();
        assert_eq!(id, "rect-1");

        let base = s.objects[0].base();
        assert!(base.width > 0.0 && base.height > 0.0, "must have a box");
        assert!(base.visible && !base.locked);
        assert!(base.fill.is_some(), "an unfilled rect cannot be seen");
        // Centred in a 1920x1080 canvas.
        assert_eq!(base.x, (1920.0 - base.width) / 2.0);
        assert_eq!(base.y, (1080.0 - base.height) / 2.0);
    }

    #[test]
    fn generated_ids_are_the_lowest_free_slot_and_never_collide() {
        let mut s = scene();
        assert_eq!(create_object(&mut s, "rect", "A").unwrap(), "rect-1");
        assert_eq!(create_object(&mut s, "rect", "B").unwrap(), "rect-2");
        // Freeing the middle id reuses it rather than counting on for ever.
        delete_object(&mut s, "rect-1").unwrap();
        assert_eq!(create_object(&mut s, "rect", "C").unwrap(), "rect-1");
        // Kinds count independently.
        assert_eq!(create_object(&mut s, "ellipse", "D").unwrap(), "ellipse-1");
    }

    #[test]
    fn kinds_that_cannot_be_completed_refuse_with_what_they_need() {
        let mut s = scene();
        // An image with no asset would refuse the moment it rendered.
        assert!(matches!(
            create_object(&mut s, "image", "Logo"),
            Err(Refusal::SceneObjectKindNotCreatable { ref kind, .. }) if kind == "image"
        ));
        // Text needs a font, and this scene carries none.
        assert!(matches!(
            create_object(&mut s, "text", "Name"),
            Err(Refusal::SceneObjectKindNotCreatable { ref needs, .. })
                if needs.contains("font")
        ));
        // A light has nothing to light until meshes draw (11.48); offered
        // now, every light would refuse at publish.
        assert!(matches!(
            create_object(&mut s, "light", "Key"),
            Err(Refusal::SceneObjectKindNotCreatable { ref kind, ref needs })
                if kind == "light" && needs.contains("PBR")
        ));
        assert!(!CREATABLE_KINDS.contains(&"light"));
        assert!(matches!(
            create_object(&mut s, "sprite", "?"),
            Err(Refusal::SceneObjectKindNotCreatable { .. })
        ));
        assert!(matches!(
            create_object(&mut s, "rect", "   "),
            Err(Refusal::SceneObjectNameEmpty)
        ));
        // Every refusal left the scene alone.
        assert!(s.objects.is_empty(), "a refused create must write nothing");
    }

    #[test]
    fn deleting_a_group_takes_its_children_channels_and_camera() {
        let mut s = scene();
        s.objects = vec![
            group("g-1", &["rect-1", "g-2"]),
            SceneObject::Rect(RectObject {
                base: ObjectBase::new("rect-1", "Rect"),
                radius: 0.0,
            }),
            group("g-2", &["camera-1"]),
        ];
        create_object(&mut s, "camera", "Cam").unwrap();
        s.active_camera_id = Some("camera-1".into());
        s.timeline.channels = vec![channel("rect-1", "x"), channel("camera-1", "y")];

        let removed = delete_object(&mut s, "g-1").unwrap();

        assert_eq!(
            removed.removed_object_ids,
            vec!["g-1", "rect-1", "g-2", "camera-1"]
        );
        assert_eq!(removed.removed_channel_count, 2);
        assert!(removed.cleared_active_camera);
        assert!(s.objects.is_empty());
        assert!(s.timeline.channels.is_empty(), "no orphan channels");
        assert_eq!(s.active_camera_id, None);
    }

    #[test]
    fn deleting_a_child_detaches_it_from_the_parent_that_claimed_it() {
        let mut s = scene();
        s.objects = vec![
            group("g-1", &["rect-1"]),
            SceneObject::Rect(RectObject {
                base: ObjectBase::new("rect-1", "Rect"),
                radius: 0.0,
            }),
        ];
        let removed = delete_object(&mut s, "rect-1").unwrap();
        assert_eq!(removed.detached_from.as_deref(), Some("g-1"));
        // The surviving container must stop claiming it, or the resolver
        // reports MissingChild for an edit that was deliberate.
        assert!(s.objects[0].child_ids().is_empty());
    }

    #[test]
    fn deleting_an_unknown_object_refuses_and_changes_nothing() {
        let mut s = scene();
        create_object(&mut s, "rect", "A").unwrap();
        let before = s.clone();
        assert!(matches!(
            delete_object(&mut s, "nope"),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
        assert_eq!(s, before);
    }

    #[test]
    fn duplicating_a_group_copies_children_and_animation_under_fresh_ids() {
        let mut s = scene();
        s.objects = vec![
            group("g-1", &["rect-1"]),
            SceneObject::Rect(RectObject {
                base: ObjectBase::new("rect-1", "Rect"),
                radius: 0.0,
            }),
        ];
        s.timeline.channels = vec![channel("rect-1", "x")];

        let copy = duplicate_object(&mut s, "g-1").unwrap();

        assert_eq!(copy.new_object_id, "group-1");
        assert_eq!(copy.created_object_ids, vec!["group-1", "rect-2"]);
        assert_eq!(copy.copied_channel_count, 1);

        // The copied container claims the copies, never the originals — the
        // bug that makes a duplicate move its source.
        let copied_group = s.objects.iter().find(|o| o.base().id == "group-1").unwrap();
        assert_eq!(copied_group.child_ids(), ["rect-2"]);
        let original = s.objects.iter().find(|o| o.base().id == "g-1").unwrap();
        assert_eq!(original.child_ids(), ["rect-1"]);

        // Animation followed the copy, addressed to the new object.
        assert!(s
            .timeline
            .channels
            .iter()
            .any(|c| c.object_id == "rect-2" && c.property == "x"));
        // The copy sits next to what it came from, not at the end.
        assert_eq!(s.objects[1].base().id, "group-1");
    }

    #[test]
    fn a_duplicated_child_joins_its_parent_next_to_the_original() {
        let mut s = scene();
        s.objects = vec![
            group("g-1", &["rect-1", "rect-9"]),
            SceneObject::Rect(RectObject {
                base: ObjectBase::new("rect-1", "Rect"),
                radius: 0.0,
            }),
            SceneObject::Rect(RectObject {
                base: ObjectBase::new("rect-9", "Other"),
                radius: 0.0,
            }),
        ];
        let copy = duplicate_object(&mut s, "rect-1").unwrap();
        assert_eq!(copy.new_object_id, "rect-2");
        assert_eq!(s.objects[0].child_ids(), ["rect-1", "rect-2", "rect-9"]);
    }

    #[test]
    fn a_cyclic_hierarchy_is_walked_once_rather_than_for_ever() {
        // The resolver tolerates cycles in a scene being repaired (1.2), so
        // delete has to as well: this test hangs if the walk is unbounded.
        let mut s = scene();
        s.objects = vec![group("g-1", &["g-2"]), group("g-2", &["g-1"])];
        let removed = delete_object(&mut s, "g-1").unwrap();
        assert_eq!(removed.removed_object_ids, vec!["g-1", "g-2"]);
        assert!(s.objects.is_empty());
    }

    #[test]
    fn renaming_refuses_a_blank_name_and_an_unknown_object() {
        let mut s = scene();
        create_object(&mut s, "rect", "Card").unwrap();
        rename_object(&mut s, "rect-1", "  Lower third  ").unwrap();
        assert_eq!(s.objects[0].base().name, "Lower third");
        assert!(matches!(
            rename_object(&mut s, "rect-1", "\t"),
            Err(Refusal::SceneObjectNameEmpty)
        ));
        assert_eq!(s.objects[0].base().name, "Lower third", "refused, unchanged");
        assert!(matches!(
            rename_object(&mut s, "nope", "X"),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
    }
}