//! Animated paths (plan row 11.112; Pen spec v2 section 11, Masking spec v2
//! section 8): a shape's path, one of its compound subpaths or a mask's path
//! whose vertices and handles move over time.
//!
//! A [`PathChannel`] holds whole paths as keys. Every path carries a stable id
//! per vertex (`BezierPath::vertex_ids`), so two keys correspond by id and
//! never by index:
//!
//! - between two keys of the same topology (open or closed alike, the same ids
//!   in the same order) each vertex and each handle interpolates, the easing
//!   being the one the earlier key leaves by;
//! - between keys of different topology the earlier key HOLDS, and the
//!   evaluation says so by name; nothing is ever interpolated by index across
//!   a changed topology, which would silently distort the shape;
//! - before the first key and after the last the path is held, never
//!   extrapolated.
//!
//! Inserting a vertex on an animated path splits the curve exactly in every
//! key (the same new id in each), so the shape at every key is unchanged. The
//! edits that do this are `setPathKey`, `removePathKey` and `editPath` with a
//! frame (`render_edit`); this module is what they and every renderer share.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::animation::{ease_at, CubicBezier, SceneEasing};
use crate::path_geometry::{effective, has_auto, ids_of, same_topology, PathTarget, Why};
use crate::scene::{BezierPath, SceneDocument, SceneObject, Vec2};
use crate::Refusal;

/// One key of a path channel: the whole path at a frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathKey {
    /// Absolute frame at the scene canvas rate.
    pub frame: u64,
    /// The path at that frame. Carries vertex ids (the Editor adds them when
    /// it makes the first key).
    pub path: BezierPath,
    /// Outgoing easing toward the next key.
    #[serde(default)]
    pub easing: SceneEasing,
    /// Custom bezier control points, present exactly when easing is custom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bezier: Option<CubicBezier>,
}

/// The keys of one path of one object, sorted by frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathChannel {
    pub object_id: String,
    /// Which path: a shape's subpath or one of the object's masks.
    pub target: PathTarget,
    #[serde(default)]
    pub keys: Vec<PathKey>,
}

impl PathChannel {
    /// The channel's name in refusals: `path`, `compoundPaths[i]` or `masks[i].path`.
    pub fn field(&self) -> String {
        target_field(self.target)
    }
}

/// The field name of a path target.
pub fn target_field(target: PathTarget) -> String {
    match target {
        PathTarget::Shape { subpath: 0 } => "path".to_owned(),
        PathTarget::Shape { subpath } => format!("compoundPaths[{}]", subpath - 1),
        PathTarget::Mask { index } => format!("masks[{index}].path"),
    }
}

/// A channel's path at a frame.
#[derive(Debug, Clone, PartialEq)]
pub struct PathValue {
    pub path: BezierPath,
    /// Set when two neighbouring keys differ in topology and the earlier one is
    /// held: the frames, and what differs.
    pub held: Option<String>,
}

/// Two paths of the same topology blended: `t` of the way from `a` to `b`.
/// The ids, kinds and tension stay `a`'s.
pub fn lerp_paths(a: &BezierPath, b: &BezierPath, t: f64) -> Result<BezierPath, Why> {
    if !same_topology(a, b) {
        return Err("the two paths do not have the same vertices");
    }
    let mix = |x: Vec2, y: Vec2| Vec2 {
        x: x.x + (y.x - x.x) * t,
        y: x.y + (y.y - x.y) * t,
    };
    let list = |p: &[Vec2], q: &[Vec2]| p.iter().zip(q).map(|(x, y)| mix(*x, *y)).collect();
    Ok(BezierPath {
        closed: a.closed,
        vertices: list(&a.vertices, &b.vertices),
        in_tangents: list(&a.in_tangents, &b.in_tangents),
        out_tangents: list(&a.out_tangents, &b.out_tangents),
        vertex_ids: a.vertex_ids.clone(),
        vertex_kinds: a.vertex_kinds.clone(),
        auto_tension: a.auto_tension,
    })
}

/// What differs between two keys that cannot be interpolated.
fn mismatch(a: &BezierPath, b: &BezierPath) -> &'static str {
    if a.closed != b.closed {
        "one is open and the other closed"
    } else if a.vertices.len() != b.vertices.len() {
        "they have different numbers of vertices"
    } else {
        "their vertices have different ids"
    }
}

/// The path a channel holds at a frame; `None` when the channel has no key.
/// Between keys of different topology the earlier key holds (see the module
/// doc) and `held` says why. A custom easing with no control points refuses
/// by name, as a numeric channel's does.
pub fn evaluate_path_channel(channel: &PathChannel, frame: u64) -> Result<Option<PathValue>, Refusal> {
    let keys = &channel.keys;
    let (Some(first), Some(last)) = (keys.first(), keys.last()) else {
        return Ok(None);
    };
    let plain = |path: &BezierPath| PathValue { path: path.clone(), held: None };
    if frame <= first.frame {
        return Ok(Some(plain(&first.path)));
    }
    if frame >= last.frame {
        return Ok(Some(plain(&last.path)));
    }
    let upper = keys.partition_point(|key| key.frame <= frame);
    let from = &keys[upper - 1];
    let to = &keys[upper];
    let span = to.frame.saturating_sub(from.frame);
    if span == 0 {
        return Ok(Some(plain(&from.path)));
    }
    if !same_topology(&from.path, &to.path) {
        return Ok(Some(PathValue {
            path: from.path.clone(),
            held: Some(format!(
                "the keys at frames {} and {} of {} cannot be interpolated: {}; the earlier one holds",
                from.frame,
                to.frame,
                channel.field(),
                mismatch(&from.path, &to.path)
            )),
        }));
    }
    let t = (frame - from.frame) as f64 / span as f64;
    let eased = ease_at(from.easing, from.bezier, t).ok_or_else(|| Refusal::InvalidKeyframeEasing {
        object: channel.object_id.clone(),
        property: channel.field(),
        detail: "custom-bezier has no control points".to_owned(),
    })?;
    let path = lerp_paths(&from.path, &to.path, eased).map_err(|_| Refusal::InvalidKeyframeEasing {
        object: channel.object_id.clone(),
        property: channel.field(),
        detail: "the keys do not have the same vertices".to_owned(),
    })?;
    Ok(Some(PathValue { path, held: None }))
}

/// The path a target names, if the object and the target exist.
pub fn target_path(scene: &SceneDocument, object_id: &str, target: PathTarget) -> Option<BezierPath> {
    let object = scene.objects.iter().find(|o| o.base().id == object_id)?;
    match target {
        PathTarget::Shape { subpath } => {
            let SceneObject::Shape(shape) = object else { return None };
            if subpath == 0 {
                Some(shape.path.clone())
            } else {
                shape.compound_paths.as_ref()?.get(subpath - 1).cloned()
            }
        }
        PathTarget::Mask { index } => object.base().masks().get(index).map(|m| m.path.clone()),
    }
}

/// Put `path` where the target names. `false` when there is no such target.
pub fn put_target_path(scene: &mut SceneDocument, object_id: &str, target: PathTarget, path: BezierPath) -> bool {
    let Some(object) = scene.objects.iter_mut().find(|o| o.base().id == object_id) else {
        return false;
    };
    match target {
        PathTarget::Shape { subpath } => {
            let SceneObject::Shape(shape) = object else { return false };
            if subpath == 0 {
                shape.path = path;
                true
            } else if let Some(slot) = shape.compound_paths.as_mut().and_then(|c| c.get_mut(subpath - 1)) {
                *slot = path;
                true
            } else {
                false
            }
        }
        PathTarget::Mask { index } => {
            match object.base_mut().masks.as_mut().and_then(|m| m.get_mut(index)) {
                Some(mask) => {
                    mask.path = path;
                    true
                }
                None => false,
            }
        }
    }
}

/// One channel that could not interpolate at a frame.
#[derive(Debug, Clone, PartialEq)]
pub struct PathHold {
    pub object_id: String,
    pub detail: String,
}

/// Put every path channel's value at `frame` into `scene`, in place. Returns
/// the channels that held a key because their neighbours differ in topology.
pub fn apply_path_channels(scene: &mut SceneDocument, frame: u64) -> Result<Vec<PathHold>, Refusal> {
    // Every channel is evaluated before any path is put back, so the keys are never copied.
    let values = scene
        .timeline
        .path_channels
        .iter()
        .map(|channel| evaluate_path_channel(channel, frame))
        .collect::<Result<Vec<_>, _>>()?;
    let mut held = Vec::new();
    for (index, value) in values.into_iter().enumerate() {
        let Some(value) = value else { continue };
        let (object_id, target) = {
            let channel = &scene.timeline.path_channels[index];
            (channel.object_id.clone(), channel.target)
        };
        if let Some(detail) = value.held {
            held.push(PathHold { object_id: object_id.clone(), detail });
        }
        // An auto vertex's handles are derived from the vertices of THIS frame.
        put_target_path(scene, &object_id, target, effective(&value.path));
    }
    Ok(held)
}

/// Whether the scene animates any path.
pub fn has_path_animation(scene: &SceneDocument) -> bool {
    scene.timeline.path_channels.iter().any(|c| !c.keys.is_empty())
}

/// Every shape path and mask path of `scene` with its `auto` vertices' handles
/// written out (11.113): what every renderer draws. A scene with none is
/// untouched.
pub fn resolve_auto_paths(scene: &mut SceneDocument) {
    for object in &mut scene.objects {
        if let SceneObject::Shape(shape) = object {
            if has_auto(&shape.path) {
                shape.path = effective(&shape.path);
            }
            for sub in shape.compound_paths.iter_mut().flatten() {
                if has_auto(sub) {
                    *sub = effective(sub);
                }
            }
        }
        for mask in object.base_mut().masks.iter_mut().flatten() {
            if has_auto(&mask.path) {
                mask.path = effective(&mask.path);
            }
        }
    }
    // The keys keep their auto vertices as authored: the handles are derived
    // from the vertices of each frame when a channel is applied.
}

/// The union of every key's vertex box (vertices only, as an object's box is), `None` with no key.
pub fn key_box(channel: &PathChannel) -> Option<(f64, f64, f64, f64)> {
    let mut low = (f64::MAX, f64::MAX);
    let mut high = (f64::MIN, f64::MIN);
    let mut any = false;
    for v in channel.keys.iter().flat_map(|k| &k.path.vertices) {
        low = (low.0.min(v.x), low.1.min(v.y));
        high = (high.0.max(v.x), high.1.max(v.y));
        any = true;
    }
    any.then_some((low.0, low.1, high.0, high.1))
}

/// A channel's own consistency: its object and target exist, its keys are
/// ordered by frame, each key is a valid path, and an easing carries what it
/// names. A key whose topology differs from its neighbour is allowed (it
/// holds); a key list that is out of order or has a frame twice is not.
pub fn validate_path_channels(scene: &SceneDocument) -> Result<(), Refusal> {
    let mut seen = std::collections::BTreeSet::new();
    for channel in &scene.timeline.path_channels {
        let field = channel.field();
        if !scene.objects.iter().any(|o| o.base().id == channel.object_id) {
            return Err(Refusal::SceneObjectUnknown { object_id: channel.object_id.clone() });
        }
        if target_path(scene, &channel.object_id, channel.target).is_none() {
            return Err(Refusal::AnimationChannelUnknown {
                object: channel.object_id.clone(),
                property: field,
            });
        }
        if !seen.insert((channel.object_id.as_str(), field.clone())) {
            return Err(Refusal::DuplicateAnimationChannel {
                object: channel.object_id.clone(),
                property: field,
            });
        }
        for key in &channel.keys {
            crate::drawability::bezier_arrays_match(&channel.object_id, &key.path)?;
            if key.path.vertices.len() < 2 {
                return Err(Refusal::ObjectFieldValueInvalid {
                    field: format!("timeline.pathChannels.{field}"),
                    detail: "a path key needs at least two vertices".into(),
                });
            }
            let finite = key
                .path
                .vertices
                .iter()
                .chain(&key.path.in_tangents)
                .chain(&key.path.out_tangents)
                .all(|p| p.x.is_finite() && p.y.is_finite());
            if !finite {
                return Err(Refusal::ObjectFieldValueInvalid {
                    field: format!("timeline.pathChannels.{field}"),
                    detail: "a path key's points must be finite".into(),
                });
            }
            if (key.easing == SceneEasing::CustomBezier) != key.bezier.is_some() {
                return Err(Refusal::InvalidKeyframeEasing {
                    object: channel.object_id.clone(),
                    property: field.clone(),
                    detail: "custom-bezier and its control points go together".into(),
                });
            }
            if key.frame > scene.timeline.duration_frames {
                return Err(Refusal::KeyframeOutOfRange {
                    object: channel.object_id.clone(),
                    property: field.clone(),
                    frame: key.frame,
                    duration_frames: scene.timeline.duration_frames,
                });
            }
        }
        for pair in channel.keys.windows(2) {
            if pair[0].frame == pair[1].frame {
                return Err(Refusal::DuplicateKeyframeFrame {
                    object: channel.object_id.clone(),
                    property: field,
                    frame: pair[1].frame,
                });
            }
            if pair[0].frame > pair[1].frame {
                return Err(Refusal::AnimationKeyOrderInvalid {
                    object: channel.object_id.clone(),
                    property: field,
                    previous: pair[0].frame,
                    frame: pair[1].frame,
                });
            }
        }
    }
    Ok(())
}

/// Every id used by the base path and every key of a channel, so a vertex
/// inserted in all of them takes one no key has.
pub fn fresh_channel_id(base: &BezierPath, channel: Option<&PathChannel>) -> u32 {
    let mut max = ids_of(base).into_iter().max();
    if let Some(channel) = channel {
        for key in &channel.keys {
            max = max.max(ids_of(&key.path).into_iter().max());
        }
    }
    max.map_or(0, |m| m + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_geometry::{cubic_of, point_at, PathOp};

    const Z: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn tri(dx: f64, ids: Vec<u32>) -> BezierPath {
        BezierPath {
            closed: true,
            vertices: vec![v(0.0 + dx, 0.0), v(100.0 + dx, 0.0), v(50.0 + dx, 80.0)],
            in_tangents: vec![Z; 3],
            out_tangents: vec![Z; 3],
            vertex_ids: Some(ids),
            vertex_kinds: None,
            auto_tension: None,
        }
    }

    fn key(frame: u64, path: BezierPath) -> PathKey {
        PathKey { frame, path, easing: SceneEasing::Linear, bezier: None }
    }

    fn channel(keys: Vec<PathKey>) -> PathChannel {
        PathChannel { object_id: "s".into(), target: PathTarget::Shape { subpath: 0 }, keys }
    }

    #[test]
    fn two_keys_of_one_topology_interpolate_per_vertex() {
        let c = channel(vec![key(0, tri(0.0, vec![5, 6, 7])), key(10, tri(100.0, vec![5, 6, 7]))]);
        let mid = evaluate_path_channel(&c, 5).unwrap().unwrap();
        assert_eq!(mid.held, None);
        assert_eq!(mid.path.vertices[0], v(50.0, 0.0));
        assert_eq!(mid.path.vertices[2], v(100.0, 80.0));
        assert_eq!(mid.path.vertex_ids, Some(vec![5, 6, 7]));
        // Held before the first key and after the last, never extrapolated.
        assert_eq!(evaluate_path_channel(&c, 0).unwrap().unwrap().path.vertices[0], v(0.0, 0.0));
        assert_eq!(evaluate_path_channel(&c, 99).unwrap().unwrap().path.vertices[0], v(100.0, 0.0));
        assert_eq!(evaluate_path_channel(&channel(vec![]), 3).unwrap(), None);
    }

    #[test]
    fn the_easing_belongs_to_the_key_it_leaves() {
        let mut first = key(0, tri(0.0, vec![0, 1, 2]));
        first.easing = SceneEasing::Hold;
        let c = channel(vec![first, key(10, tri(100.0, vec![0, 1, 2]))]);
        assert_eq!(evaluate_path_channel(&c, 9).unwrap().unwrap().path.vertices[0], v(0.0, 0.0));
        let mut first = key(0, tri(0.0, vec![0, 1, 2]));
        first.easing = SceneEasing::CustomBezier;
        let c = channel(vec![first, key(10, tri(100.0, vec![0, 1, 2]))]);
        assert!(matches!(evaluate_path_channel(&c, 5), Err(Refusal::InvalidKeyframeEasing { .. })));
    }

    #[test]
    fn a_different_topology_holds_the_earlier_key_and_says_so() {
        // Same count, different ids: interpolating by index would swap vertices.
        let c = channel(vec![key(0, tri(0.0, vec![0, 1, 2])), key(10, tri(100.0, vec![0, 2, 1]))]);
        let got = evaluate_path_channel(&c, 5).unwrap().unwrap();
        assert_eq!(got.path.vertices[0], v(0.0, 0.0));
        assert!(got.held.unwrap().contains("different ids"));
        // A different count.
        let mut four = tri(100.0, vec![0, 1, 2]);
        four = crate::path_geometry::insert_vertex(&four, 0, 0.5).unwrap();
        let c = channel(vec![key(0, tri(0.0, vec![0, 1, 2])), key(10, four)]);
        assert!(evaluate_path_channel(&c, 5).unwrap().unwrap().held.unwrap().contains("numbers of vertices"));
        // Open against closed.
        let mut open = tri(100.0, vec![0, 1, 2]);
        open.closed = false;
        let c = channel(vec![key(0, tri(0.0, vec![0, 1, 2])), key(10, open)]);
        assert!(evaluate_path_channel(&c, 5).unwrap().unwrap().held.unwrap().contains("open"));
        // Old paths without ids correspond by index, which is all they have: equal counts interpolate.
        let mut a = tri(0.0, vec![]);
        a.vertex_ids = None;
        let mut b = tri(100.0, vec![]);
        b.vertex_ids = None;
        let got = evaluate_path_channel(&channel(vec![key(0, a), key(10, b)]), 5).unwrap().unwrap();
        assert_eq!(got.held, None);
    }

    #[test]
    fn an_insert_in_every_key_splits_each_exactly_and_the_keys_still_interpolate() {
        let a = tri(0.0, vec![0, 1, 2]);
        let mut b = tri(100.0, vec![0, 1, 2]);
        b.out_tangents[0] = v(20.0, -30.0);
        let c = channel(vec![key(0, a.clone()), key(10, b.clone())]);
        let id = fresh_channel_id(&a, Some(&c));
        assert_eq!(id, 3);
        let op = PathOp::InsertVertex { segment: 0, t: 0.4 };
        let (a2, b2) = (op.apply_with(&a, Some(id)).unwrap(), op.apply_with(&b, Some(id)).unwrap());
        assert_eq!(a2.vertex_ids, Some(vec![0, 3, 1, 2]));
        assert_eq!(b2.vertex_ids, Some(vec![0, 3, 1, 2]));
        // The drawn curve of every key is unchanged by the split: the two new segments are the old one's halves.
        for (before, after) in [(&a, &a2), (&b, &b2)] {
            let (whole, left, right) = (cubic_of(before, 0), cubic_of(after, 0), cubic_of(after, 1));
            for k in 0..=20 {
                let u = k as f64 / 20.0;
                let (on_left, on_right) = (point_at(&left, u), point_at(&right, u));
                let (want_left, want_right) = (point_at(&whole, 0.4 * u), point_at(&whole, 0.4 + 0.6 * u));
                assert!((on_left.x - want_left.x).abs() < 1e-9 && (on_left.y - want_left.y).abs() < 1e-9);
                assert!((on_right.x - want_right.x).abs() < 1e-9 && (on_right.y - want_right.y).abs() < 1e-9);
            }
        }
        let c2 = channel(vec![key(0, a2), key(10, b2)]);
        let mid = evaluate_path_channel(&c2, 5).unwrap().unwrap();
        assert_eq!(mid.held, None);
        assert_eq!(mid.path.vertices.len(), 4);
    }

    #[test]
    fn reverse_and_first_vertex_carry_ids_so_keys_stay_comparable() {
        let a = tri(0.0, vec![10, 11, 12]);
        let rev = PathOp::Reverse.apply(&a).unwrap();
        assert_eq!(rev.vertex_ids, Some(vec![10, 12, 11]));
        let first = PathOp::SetFirstVertex { index: 2 }.apply(&a).unwrap();
        assert_eq!(first.vertex_ids, Some(vec![12, 10, 11]));
        let del = PathOp::DeleteVertices { indices: vec![] };
        assert!(del.apply(&a).is_err());
        let open = PathOp::SetClosed { closed: false }.apply(&a).unwrap();
        assert_eq!(open.vertex_ids, a.vertex_ids);
    }

    #[test]
    fn deleting_keeps_the_ids_of_the_vertices_left() {
        let mut p = tri(0.0, vec![4, 5, 6]);
        p.vertices.push(v(0.0, 80.0));
        p.in_tangents.push(Z);
        p.out_tangents.push(Z);
        p.vertex_ids = Some(vec![4, 5, 6, 9]);
        let got = PathOp::DeleteVertices { indices: vec![1] }.apply(&p).unwrap();
        assert_eq!(got.vertex_ids, Some(vec![4, 6, 9]));
    }

    #[test]
    fn validation_names_what_is_wrong() {
        use crate::color::WorkingColorSpace;
        use crate::scene::{new_scene, FillRule, ObjectBase, ShapeObject};
        let mut scene = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        scene.timeline.duration_frames = 50;
        scene.objects.push(SceneObject::Shape(ShapeObject {
            base: ObjectBase::new("s", "S"),
            path: tri(0.0, vec![0, 1, 2]),
            compound_paths: None,
            fill_enabled: true,
            stroke_enabled: false,
            fill_rule: FillRule::Nonzero,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
            contour_ids: None,
        }));
        scene.timeline.path_channels = vec![channel(vec![key(0, tri(0.0, vec![0, 1, 2])), key(10, tri(9.0, vec![0, 1, 2]))])];
        assert_eq!(validate_path_channels(&scene), Ok(()));
        // Out of order.
        scene.timeline.path_channels[0].keys.swap(0, 1);
        assert!(matches!(validate_path_channels(&scene), Err(Refusal::AnimationKeyOrderInvalid { .. })));
        // A frame twice.
        scene.timeline.path_channels[0].keys[0].frame = 0;
        scene.timeline.path_channels[0].keys[1].frame = 0;
        assert!(matches!(validate_path_channels(&scene), Err(Refusal::DuplicateKeyframeFrame { .. })));
        // Past the timeline.
        scene.timeline.path_channels[0].keys[1].frame = 99;
        assert!(matches!(validate_path_channels(&scene), Err(Refusal::KeyframeOutOfRange { .. })));
        // A target that is not there.
        scene.timeline.path_channels[0].keys[1].frame = 10;
        scene.timeline.path_channels[0].target = PathTarget::Mask { index: 3 };
        assert!(matches!(validate_path_channels(&scene), Err(Refusal::AnimationChannelUnknown { .. })));
        // Two channels on one path.
        scene.timeline.path_channels[0].target = PathTarget::Shape { subpath: 0 };
        let again = scene.timeline.path_channels[0].clone();
        scene.timeline.path_channels.push(again);
        assert!(matches!(validate_path_channels(&scene), Err(Refusal::DuplicateAnimationChannel { .. })));
        // Duplicate ids inside a key.
        scene.timeline.path_channels.pop();
        scene.timeline.path_channels[0].keys[1].path.vertex_ids = Some(vec![1, 1, 2]);
        assert!(validate_path_channels(&scene).is_err());
    }
}
