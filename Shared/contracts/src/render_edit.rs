//! Authoring edits for what 3.17 to 3.19 draw: masks, clip groups, track
//! mattes, trim, paint and stroke (user decision, 16 November 2026: make the
//! render features reachable through the Editor MCP).
//!
//! Each is a typed [`SceneEdit`](crate::command::SceneEdit), so the Editor and
//! an MCP agent set them through the one command path (invariant 60), with a
//! generated schema, one undo entry per batch and a named refusal for what the
//! engine cannot draw.
//!
//! **No second rule.** An edit does not re-implement what the engine can draw.
//! It applies the change to the candidate scene and runs
//! [`drawability_refusals`] on the scene before and after
//! ([`refuse_what_cannot_be_drawn`]): it refuses on any refusal at the fields
//! it edited, and on any refusal the scene did not have before, which is how
//! setting a track matte on an object that is another layer's matte source
//! refuses at that other layer. The two value rules that lived elsewhere are
//! shared, not copied: a stroke style through [`StrokeStyle::problem`] (which
//! the engine's stroke preparation also calls) and a trim value through
//! [`trim_value_valid`] (which the validator also calls).
//!
//! **Two prerequisites live here too.** A clip group needs a group with
//! children and trim needs a shape, and neither could be authored: the object
//! catalogue refuses `shape` as not creatable without a path, and nothing
//! parented an object. [`create_shape`] and [`set_group_children`] are those
//! two edits; without them an agent could set a clip child only on a scene it
//! was handed. Parenting a child another group already claims refuses
//! `sceneHierarchyInvalid` (`multipleParents`) rather than moving it silently.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::authoring::{default_fill, next_object_id, refuse_duplicate_object_ids};
use crate::color::ColorValue;
use crate::command::EditEffect;
use crate::drawability::{bezier_arrays_match, drawability_refusals, paints};
use crate::scene::{
    resolve_hierarchy, BezierPath, FillRule, Mask, SceneDocument, SceneObject, ShapeObject,
    StrokeStyle, TrackMatte,
};
use crate::Refusal;

/// Which of an object's two paints `SetPaint` sets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PaintSlot {
    Fill,
    Stroke,
}

impl PaintSlot {
    fn name(self) -> &'static str {
        match self {
            Self::Fill => "fill",
            Self::Stroke => "stroke",
        }
    }

    /// Whether `object` draws this paint. The same table the gradient check
    /// reads: a line has no fill, and only a rect, ellipse, shape or text has
    /// one; a group, image, layer and the rest draw neither from `base`.
    fn drawn_by(self, object: &SceneObject) -> bool {
        match self {
            Self::Fill => matches!(
                object,
                SceneObject::Rect(_)
                    | SceneObject::Ellipse(_)
                    | SceneObject::Shape(_)
                    | SceneObject::Text(_)
            ),
            Self::Stroke => matches!(
                object,
                SceneObject::Rect(_)
                    | SceneObject::Ellipse(_)
                    | SceneObject::Line(_)
                    | SceneObject::Shape(_)
                    | SceneObject::Text(_)
            ),
        }
    }
}

/// Whether a trim value lies in its domain (3.13): start and end are
/// percentages from 0 to 100, the offset any finite percentage. The validator
/// and `SetTrim` both ask this.
pub fn trim_value_valid(percentage: bool, value: f64) -> bool {
    value.is_finite() && (!percentage || (0.0..=100.0).contains(&value))
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

fn not_applicable(field: &str, objects: &[&SceneObject]) -> Refusal {
    let mut kinds: Vec<String> = Vec::new();
    for object in objects {
        let kind = object.kind();
        if !kinds.iter().any(|present| present == kind) {
            kinds.push(kind.to_owned());
        }
    }
    Refusal::ObjectFieldNotApplicable {
        field: field.to_owned(),
        kinds,
    }
}

/// Whether `path` is `objects[index].<field>` or something inside it.
fn at_field(path: &str, index: usize, field: &str) -> bool {
    let head = format!("objects[{index}].{field}");
    path.strip_prefix(&head)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['[', '.']))
}

/// Refuse `after` when the edit left something the engine cannot draw: any
/// refusal at one of the edited `fields` of an edited object, or any refusal
/// `before` did not have. A refusal the scene already carried elsewhere does
/// not block an unrelated edit, and an edit never hides one it was meant to
/// fix by leaving the same fault in place. A refused edit puts `before` back,
/// so the scene is as it was.
fn refuse_what_cannot_be_drawn(
    before: SceneDocument,
    after: &mut SceneDocument,
    edited: &[(&str, &[&str])],
) -> Result<(), Refusal> {
    let prior = drawability_refusals(&before);
    let targets: Vec<(usize, &[&str])> = edited
        .iter()
        .filter_map(|(id, fields)| Some((object_index(after, id).ok()?, *fields)))
        .collect();
    let refused = drawability_refusals(after).into_iter().find(|refusal| {
        let here = refusal.field.as_deref().is_some_and(|path| {
            targets
                .iter()
                .any(|(index, fields)| fields.iter().any(|field| at_field(path, *index, field)))
        });
        here || !prior.contains(refusal)
    });
    match refused {
        Some(refusal) => {
            *after = before;
            Err(refusal.code)
        }
        None => Ok(()),
    }
}

fn changed(object_ids: Vec<String>) -> EditEffect {
    EditEffect::ObjectsChanged { object_ids }
}

/// Create a shape from a bezier path (3.13): the prerequisite the object
/// catalogue names for `shape`. It lands at the origin with the path's own
/// coordinates, a grey fill and no stroke, its box the path's vertex bounds.
pub fn create_shape(
    scene: &mut SceneDocument,
    name: &str,
    path: &BezierPath,
) -> Result<EditEffect, Refusal> {
    refuse_duplicate_object_ids(scene)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(Refusal::SceneObjectNameEmpty);
    }
    let invalid = |detail: &str| Refusal::ObjectFieldValueInvalid {
        field: "path".into(),
        detail: detail.into(),
    };
    if path.vertices.len() < 2 {
        return Err(invalid("a shape path needs at least two vertices"));
    }
    let points = || {
        path.vertices
            .iter()
            .chain(&path.in_tangents)
            .chain(&path.out_tangents)
    };
    if !points().all(|p| p.x.is_finite() && p.y.is_finite()) {
        return Err(invalid("a shape path's points must be finite"));
    }
    let id = next_object_id(scene, "shape");
    bezier_arrays_match(&id, path)?;
    let (mut low, mut high) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN));
    for vertex in &path.vertices {
        low = (low.0.min(vertex.x), low.1.min(vertex.y));
        high = (high.0.max(vertex.x), high.1.max(vertex.y));
    }
    let mut base = crate::scene::ObjectBase::new(id.clone(), name.to_owned());
    base.width = high.0 - low.0;
    base.height = high.1 - low.1;
    base.fill = Some(default_fill());
    let before = scene.clone();
    scene.objects.push(SceneObject::Shape(ShapeObject {
        base,
        path: path.clone(),
        compound_paths: None,
        fill_enabled: true,
        stroke_enabled: false,
        fill_rule: FillRule::Nonzero,
        trim_start: None,
        trim_end: None,
        trim_offset: None,
    }));
    refuse_what_cannot_be_drawn(before, scene, &[(&id, &["path"])])?;
    Ok(EditEffect::ObjectCreated { object_id: id })
}

/// Replace a group's ordered children (3.19's prerequisite for a clip group).
/// An edit that leaves the hierarchy with a missing child, a cycle or a child
/// two containers claim refuses `sceneHierarchyInvalid`, as the validator does,
/// and so does one that makes anything else undrawable (a clip child that is
/// no longer a child, say).
pub fn set_group_children(
    scene: &mut SceneDocument,
    group_id: &str,
    child_ids: &[String],
) -> Result<EditEffect, Refusal> {
    let index = object_index(scene, group_id)?;
    let SceneObject::Group(group) = &scene.objects[index] else {
        return Err(not_applicable("childIds", &[&scene.objects[index]]));
    };
    if group.child_ids == child_ids {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "childIds".into(),
        });
    }
    let prior = resolve_hierarchy(&scene.objects).diagnostics;
    let before = scene.clone();
    if let SceneObject::Group(group) = &mut scene.objects[index] {
        group.child_ids = child_ids.to_vec();
    }
    let broken = resolve_hierarchy(&scene.objects)
        .diagnostics
        .into_iter()
        .find(|diagnostic| diagnostic.parent_id == group_id || !prior.contains(diagnostic));
    if let Some(diagnostic) = broken {
        *scene = before;
        return Err(Refusal::SceneHierarchyInvalid {
            parent: diagnostic.parent_id,
            child: diagnostic.child_id,
            problem: diagnostic.code.problem().into(),
        });
    }
    refuse_what_cannot_be_drawn(before, scene, &[(group_id, &["clipChildId"])])?;
    Ok(changed(vec![group_id.to_owned()]))
}

/// Replace one object's mask list; an empty list clears it (3.19).
pub fn set_object_masks(
    scene: &mut SceneDocument,
    object_id: &str,
    masks: &[Mask],
) -> Result<EditEffect, Refusal> {
    let index = object_index(scene, object_id)?;
    if scene.objects[index].base().masks() == masks {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "masks".into(),
        });
    }
    let before = scene.clone();
    scene.objects[index].base_mut().masks = (!masks.is_empty()).then(|| masks.to_vec());
    refuse_what_cannot_be_drawn(before, scene, &[(object_id, &["masks"])])?;
    Ok(changed(vec![object_id.to_owned()]))
}

/// Name, or clear, a group's clip child (3.19).
pub fn set_clip_child(
    scene: &mut SceneDocument,
    group_id: &str,
    clip_child_id: Option<&str>,
) -> Result<EditEffect, Refusal> {
    let index = object_index(scene, group_id)?;
    let SceneObject::Group(group) = &scene.objects[index] else {
        return Err(not_applicable("clipChildId", &[&scene.objects[index]]));
    };
    if group.clip_child_id.as_deref() == clip_child_id {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "clipChildId".into(),
        });
    }
    let before = scene.clone();
    if let SceneObject::Group(group) = &mut scene.objects[index] {
        group.clip_child_id = clip_child_id.map(str::to_owned);
    }
    refuse_what_cannot_be_drawn(before, scene, &[(group_id, &["clipChildId"])])?;
    Ok(changed(vec![group_id.to_owned()]))
}

/// Set, or clear, one object's track matte (3.19).
pub fn set_track_matte(
    scene: &mut SceneDocument,
    object_id: &str,
    matte: Option<&TrackMatte>,
) -> Result<EditEffect, Refusal> {
    let index = object_index(scene, object_id)?;
    if scene.objects[index].base().track_matte() == matte {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "trackMatte".into(),
        });
    }
    let before = scene.clone();
    scene.objects[index].base_mut().track_matte = matte.cloned();
    refuse_what_cannot_be_drawn(before, scene, &[(object_id, &["trackMatte"])])?;
    Ok(changed(vec![object_id.to_owned()]))
}

/// Set one shape's trim window (3.13): start and end in percent of the path,
/// and the offset. An absent value is the default (0, 100, 0), and all three
/// replace what the shape had.
pub fn set_trim(
    scene: &mut SceneDocument,
    object_id: &str,
    start: Option<f64>,
    end: Option<f64>,
    offset: Option<f64>,
) -> Result<EditEffect, Refusal> {
    let index = object_index(scene, object_id)?;
    if !matches!(scene.objects[index], SceneObject::Shape(_)) {
        return Err(not_applicable("trim", &[&scene.objects[index]]));
    }
    for (field, value, percentage) in [
        ("trimStart", start, true),
        ("trimEnd", end, true),
        ("trimOffset", offset, false),
    ] {
        if let Some(value) = value {
            if !trim_value_valid(percentage, value) {
                return Err(Refusal::ShapeTrimInvalid {
                    object: object_id.to_owned(),
                    field: field.to_owned(),
                    value: value.to_string(),
                });
            }
        }
    }
    let SceneObject::Shape(shape) = &mut scene.objects[index] else {
        unreachable!("the kind was checked above");
    };
    if (shape.trim_start, shape.trim_end, shape.trim_offset) == (start, end, offset) {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "trim".into(),
        });
    }
    (shape.trim_start, shape.trim_end, shape.trim_offset) = (start, end, offset);
    Ok(changed(vec![object_id.to_owned()]))
}

/// Set, or clear, one paint of every listed object (3.17). A shape's
/// `fillEnabled` or `strokeEnabled` follows the paint, so the edit always
/// draws what it says: on for a real paint, off for none or `ColorValue::None`.
pub fn set_paint(
    scene: &mut SceneDocument,
    object_ids: &[String],
    slot: PaintSlot,
    paint: Option<&ColorValue>,
) -> Result<EditEffect, Refusal> {
    let field = slot.name();
    if let Some(ColorValue::Solid { color }) = paint {
        let finite = [color.r, color.g, color.b, color.a]
            .iter()
            .all(|v| v.is_finite());
        if !finite || !(0.0..=1.0).contains(&color.a) {
            return Err(Refusal::ObjectFieldValueInvalid {
                field: field.into(),
                detail: "a solid colour needs finite components and alpha from 0 to 1".into(),
            });
        }
    }
    let selected = select(scene, object_ids)?;
    let wrong: Vec<&SceneObject> = selected
        .iter()
        .map(|&i| &scene.objects[i])
        .filter(|object| !slot.drawn_by(object))
        .collect();
    if !wrong.is_empty() {
        return Err(not_applicable(field, &wrong));
    }
    let on = paints(&paint.cloned());
    let differs = |object: &SceneObject| {
        let base = object.base();
        let current = match slot {
            PaintSlot::Fill => &base.fill,
            PaintSlot::Stroke => &base.stroke,
        };
        let flag = match (slot, object) {
            (PaintSlot::Fill, SceneObject::Shape(shape)) => shape.fill_enabled != on,
            (PaintSlot::Stroke, SceneObject::Shape(shape)) => shape.stroke_enabled != on,
            _ => false,
        };
        current.as_ref() != paint || flag
    };
    let moved: Vec<usize> = selected
        .into_iter()
        .filter(|&i| differs(&scene.objects[i]))
        .collect();
    if moved.is_empty() {
        return Err(Refusal::ObjectFieldUnchanged {
            field: field.into(),
        });
    }
    let before = scene.clone();
    let mut ids = Vec::with_capacity(moved.len());
    for &i in &moved {
        let object = &mut scene.objects[i];
        match slot {
            PaintSlot::Fill => object.base_mut().fill = paint.cloned(),
            PaintSlot::Stroke => object.base_mut().stroke = paint.cloned(),
        }
        if let SceneObject::Shape(shape) = object {
            match slot {
                PaintSlot::Fill => shape.fill_enabled = on,
                PaintSlot::Stroke => shape.stroke_enabled = on,
            }
        }
        ids.push(object.base().id.clone());
    }
    let fields = [field];
    let edited: Vec<(&str, &[&str])> = ids.iter().map(|id| (id.as_str(), &fields[..])).collect();
    refuse_what_cannot_be_drawn(before, scene, &edited)?;
    Ok(changed(ids))
}

/// Set the stroke width and style of every listed object (3.17). An absent
/// style is the default (miter joins, butt caps, a solid line).
pub fn set_stroke(
    scene: &mut SceneDocument,
    object_ids: &[String],
    width: f64,
    style: Option<&StrokeStyle>,
) -> Result<EditEffect, Refusal> {
    if !width.is_finite() || width < 0.0 {
        return Err(Refusal::ObjectFieldValueInvalid {
            field: "strokeWidth".into(),
            detail: "must be finite and not negative".into(),
        });
    }
    if let Some(detail) = style.and_then(StrokeStyle::problem) {
        return Err(Refusal::ObjectFieldValueInvalid {
            field: "strokeStyle".into(),
            detail,
        });
    }
    let selected = select(scene, object_ids)?;
    let wrong: Vec<&SceneObject> = selected
        .iter()
        .map(|&i| &scene.objects[i])
        .filter(|object| !PaintSlot::Stroke.drawn_by(object))
        .collect();
    if !wrong.is_empty() {
        return Err(not_applicable("stroke", &wrong));
    }
    let wanted = style.cloned().unwrap_or_default();
    let moved: Vec<usize> = selected
        .into_iter()
        .filter(|&i| {
            let base = scene.objects[i].base();
            base.stroke_width.to_bits() != width.to_bits() || base.stroke_style() != wanted
        })
        .collect();
    if moved.is_empty() {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "stroke".into(),
        });
    }
    let before = scene.clone();
    let mut ids = Vec::with_capacity(moved.len());
    for &i in &moved {
        let base = scene.objects[i].base_mut();
        base.stroke_width = width;
        base.stroke_style = style.cloned();
        ids.push(base.id.clone());
    }
    let fields: &[&str] = &["strokeWidth", "strokeStyle"];
    let edited: Vec<(&str, &[&str])> = ids.iter().map(|id| (id.as_str(), fields)).collect();
    refuse_what_cannot_be_drawn(before, scene, &edited)?;
    Ok(changed(ids))
}

/// The indices of the listed objects, refusing an empty list and the first id
/// the scene does not have.
fn select(scene: &SceneDocument, object_ids: &[String]) -> Result<Vec<usize>, Refusal> {
    if object_ids.is_empty() {
        return Err(Refusal::EditTargetsEmpty);
    }
    let mut indices = Vec::with_capacity(object_ids.len());
    for id in object_ids {
        let index = object_index(scene, id)?;
        if !indices.contains(&index) {
            indices.push(index);
        }
    }
    Ok(indices)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::{
        GradientCoordinateMode, GradientSpread, GradientStop, Rgba, WorkingColorSpace,
    };
    use crate::scene::{
        new_scene, BezierPath, EllipseObject, FillRule, GroupObject, LineObject, MaskMode,
        ObjectBase, RectObject, ShapeObject, StrokeCap, StrokeJoin, TrackMatteMode, Vec2,
    };

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn triangle() -> BezierPath {
        BezierPath {
            closed: true,
            vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(50.0, 80.0)],
            in_tangents: vec![v(0.0, 0.0); 3],
            out_tangents: vec![v(0.0, 0.0); 3],
        }
    }

    fn mask(mode: MaskMode) -> Mask {
        Mask {
            path: triangle(),
            mode,
            feather: 0.0,
            expansion: 0.0,
            opacity: 1.0,
            inverted: false,
        }
    }

    fn sized(id: &str) -> ObjectBase {
        let mut base = ObjectBase::new(id, id);
        base.width = 100.0;
        base.height = 80.0;
        base
    }

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: sized(id),
            radius: 0.0,
        })
    }

    fn ellipse(id: &str) -> SceneObject {
        SceneObject::Ellipse(EllipseObject { base: sized(id) })
    }

    fn shape(id: &str) -> SceneObject {
        SceneObject::Shape(ShapeObject {
            base: sized(id),
            path: BezierPath {
                closed: false,
                vertices: vec![v(0.0, 0.0), v(100.0, 0.0)],
                in_tangents: vec![v(0.0, 0.0); 2],
                out_tangents: vec![v(0.0, 0.0); 2],
            },
            compound_paths: None,
            fill_enabled: true,
            stroke_enabled: false,
            fill_rule: FillRule::Nonzero,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
        })
    }

    fn group(id: &str, children: &[&str]) -> SceneObject {
        SceneObject::Group(GroupObject {
            base: ObjectBase::new(id, id),
            child_ids: children.iter().map(|c| (*c).to_owned()).collect(),
            clip_child_id: None,
        })
    }

    /// A rect `card`, an ellipse `disc`, a shape `path`, a line `rule`, and a
    /// group `stack` holding the rect `stencil` and the ellipse `content`.
    fn scene() -> SceneDocument {
        let mut scene = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        scene.objects = vec![
            rect("card"),
            ellipse("disc"),
            shape("path"),
            SceneObject::Line(LineObject {
                base: sized("rule"),
                points: vec![v(0.0, 0.0), v(50.0, 0.0)],
            }),
            group("stack", &["stencil", "content"]),
            rect("stencil"),
            ellipse("content"),
        ];
        scene
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    fn solid(r: f64) -> ColorValue {
        ColorValue::Solid {
            color: Rgba::srgb(r, 0.0, 0.0, 1.0),
        }
    }

    fn gradient(end_x: f64) -> ColorValue {
        ColorValue::LinearGradient {
            angle: 0.0,
            start_x: 0.0,
            start_y: 0.0,
            end_x,
            end_y: 0.0,
            stops: vec![
                GradientStop {
                    position: 0.0,
                    color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
                },
                GradientStop {
                    position: 1.0,
                    color: Rgba::srgb(0.0, 0.0, 1.0, 1.0),
                },
            ],
            spread: GradientSpread::default(),
            coordinate_mode: GradientCoordinateMode::default(),
        }
    }

    #[test]
    fn masks_replace_the_list_clear_it_and_refuse_by_name() {
        let mut s = scene();
        let masks = vec![mask(MaskMode::Add), mask(MaskMode::Subtract)];
        assert!(matches!(
            set_object_masks(&mut s, "card", &masks),
            Ok(EditEffect::ObjectsChanged { object_ids }) if object_ids == ["card"]
        ));
        assert_eq!(s.objects[0].base().masks(), masks.as_slice());
        // The same list again changes nothing.
        assert!(matches!(
            set_object_masks(&mut s, "card", &masks),
            Err(Refusal::ObjectFieldUnchanged { field }) if field == "masks"
        ));
        // An empty list clears; clearing an empty list is unchanged.
        assert!(set_object_masks(&mut s, "card", &[]).is_ok());
        assert!(s.objects[0].base().masks.is_none());
        assert!(matches!(
            set_object_masks(&mut s, "card", &[]),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        // By name: an unknown object, a group (draws nothing to mask), a
        // feather past the limit, and an open path.
        assert!(matches!(
            set_object_masks(&mut s, "ghost", &masks),
            Err(Refusal::SceneObjectUnknown { object_id }) if object_id == "ghost"
        ));
        assert!(matches!(
            set_object_masks(&mut s, "stack", &masks),
            Err(Refusal::MaskInvalid { index: 0, .. })
        ));
        let mut feathered = mask(MaskMode::Add);
        feathered.feather = 1.0e9;
        assert!(matches!(
            set_object_masks(&mut s, "card", &[mask(MaskMode::Add), feathered]),
            Err(Refusal::MaskInvalid { index: 1, .. })
        ));
        let mut open = mask(MaskMode::Add);
        open.path.closed = false;
        assert!(matches!(
            set_object_masks(&mut s, "card", &[open]),
            Err(Refusal::MaskInvalid { index: 0, .. })
        ));
        // A refused edit leaves the scene as it was.
        assert!(s.objects[0].base().masks.is_none());
    }

    #[test]
    fn a_clip_child_must_be_a_drawing_child_of_the_group() {
        let mut s = scene();
        assert!(set_clip_child(&mut s, "stack", Some("stencil")).is_ok());
        assert!(matches!(
            set_clip_child(&mut s, "stack", Some("stencil")),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        assert!(set_clip_child(&mut s, "stack", None).is_ok());
        assert!(matches!(
            &s.objects[4],
            SceneObject::Group(group) if group.clip_child_id.is_none()
        ));
        assert!(matches!(
            set_clip_child(&mut s, "stack", None),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        assert!(matches!(
            set_clip_child(&mut s, "stack", Some("card")),
            Err(Refusal::ClipGroupInvalid { .. })
        ));
        assert!(matches!(
            set_clip_child(&mut s, "card", Some("stencil")),
            Err(Refusal::ObjectFieldNotApplicable { field, kinds })
                if field == "clipChildId" && kinds == ["rect"]
        ));
        assert!(matches!(
            set_clip_child(&mut s, "ghost", None),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
    }

    #[test]
    fn a_track_matte_names_a_drawing_source_without_a_matte_of_its_own() {
        let mut s = scene();
        let matte = |source: &str| TrackMatte {
            source_id: source.to_owned(),
            mode: TrackMatteMode::Luma,
        };
        assert!(set_track_matte(&mut s, "card", Some(&matte("disc"))).is_ok());
        assert!(matches!(
            set_track_matte(&mut s, "card", Some(&matte("disc"))),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        assert!(matches!(
            set_track_matte(&mut s, "path", Some(&matte("path"))),
            Err(Refusal::TrackMatteInvalid { .. })
        ));
        assert!(matches!(
            set_track_matte(&mut s, "path", Some(&matte("ghost"))),
            Err(Refusal::TrackMatteInvalid { .. })
        ));
        // `disc` is `card`'s matte source, so it cannot take a matte of its
        // own: the refusal is at `card`, which the edit did not name.
        assert!(matches!(
            set_track_matte(&mut s, "disc", Some(&matte("path"))),
            Err(Refusal::TrackMatteInvalid { object, .. }) if object == "card"
        ));
        assert!(s.objects[1].base().track_matte().is_none());
        assert!(set_track_matte(&mut s, "card", None).is_ok());
        assert!(set_track_matte(&mut s, "disc", Some(&matte("path"))).is_ok());
    }

    #[test]
    fn trim_is_a_shape_only_window_in_its_domain() {
        let mut s = scene();
        assert!(set_trim(&mut s, "path", Some(10.0), Some(60.0), Some(25.0)).is_ok());
        let SceneObject::Shape(shape) = &s.objects[2] else {
            panic!("a shape");
        };
        assert_eq!(
            (shape.trim_start, shape.trim_end, shape.trim_offset),
            (Some(10.0), Some(60.0), Some(25.0))
        );
        assert!(matches!(
            set_trim(&mut s, "path", Some(10.0), Some(60.0), Some(25.0)),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        // All three replace: leaving the offset out clears it.
        assert!(set_trim(&mut s, "path", Some(10.0), Some(60.0), None).is_ok());
        assert!(matches!(
            set_trim(&mut s, "path", Some(140.0), None, None),
            Err(Refusal::ShapeTrimInvalid { field, .. }) if field == "trimStart"
        ));
        assert!(matches!(
            set_trim(&mut s, "path", None, Some(-1.0), None),
            Err(Refusal::ShapeTrimInvalid { field, .. }) if field == "trimEnd"
        ));
        assert!(matches!(
            set_trim(&mut s, "path", None, None, Some(f64::NAN)),
            Err(Refusal::ShapeTrimInvalid { field, .. }) if field == "trimOffset"
        ));
        assert!(matches!(
            set_trim(&mut s, "card", Some(0.0), Some(50.0), None),
            Err(Refusal::ObjectFieldNotApplicable { field, kinds })
                if field == "trim" && kinds == ["rect"]
        ));
        // An offset past one turn is a window that wraps, and is allowed.
        assert!(set_trim(&mut s, "path", Some(0.0), Some(50.0), Some(250.0)).is_ok());
    }

    #[test]
    fn paint_sets_the_slot_and_a_shapes_flag_follows_it() {
        let mut s = scene();
        assert!(set_paint(
            &mut s,
            &ids(&["card", "disc"]),
            PaintSlot::Fill,
            Some(&solid(1.0))
        )
        .is_ok());
        assert_eq!(s.objects[0].base().fill, Some(solid(1.0)));
        assert_eq!(s.objects[1].base().fill, Some(solid(1.0)));
        // A stroke paint on a shape turns the shape's stroke on, and none turns it off.
        assert!(set_paint(
            &mut s,
            &ids(&["path"]),
            PaintSlot::Stroke,
            Some(&solid(0.5))
        )
        .is_ok());
        let flags = |s: &SceneDocument| match &s.objects[2] {
            SceneObject::Shape(shape) => (shape.fill_enabled, shape.stroke_enabled),
            _ => unreachable!(),
        };
        assert_eq!(flags(&s), (true, true));
        assert!(set_paint(&mut s, &ids(&["path"]), PaintSlot::Fill, None).is_ok());
        assert_eq!(flags(&s), (false, true));
        assert!(s.objects[2].base().fill.is_none());
        // The same paint again changes nothing.
        assert!(matches!(
            set_paint(&mut s, &ids(&["card"]), PaintSlot::Fill, Some(&solid(1.0))),
            Err(Refusal::ObjectFieldUnchanged { field }) if field == "fill"
        ));
        // A gradient that cannot be drawn refuses by name, an angle beside
        // explicit points among them.
        let mut skewed = gradient(1.0);
        if let ColorValue::LinearGradient { angle, .. } = &mut skewed {
            *angle = 45.0;
        }
        assert!(matches!(
            set_paint(&mut s, &ids(&["card"]), PaintSlot::Fill, Some(&skewed)),
            Err(Refusal::GradientNotDrawable { .. })
        ));
        assert!(set_paint(
            &mut s,
            &ids(&["card"]),
            PaintSlot::Fill,
            Some(&gradient(1.0))
        )
        .is_ok());
        // A line has no fill; a group has neither.
        assert!(matches!(
            set_paint(&mut s, &ids(&["card", "rule"]), PaintSlot::Fill, Some(&solid(0.2))),
            Err(Refusal::ObjectFieldNotApplicable { field, kinds })
                if field == "fill" && kinds == ["line"]
        ));
        assert!(matches!(
            set_paint(
                &mut s,
                &ids(&["stack"]),
                PaintSlot::Stroke,
                Some(&solid(0.2))
            ),
            Err(Refusal::ObjectFieldNotApplicable { .. })
        ));
        assert!(set_paint(
            &mut s,
            &ids(&["rule"]),
            PaintSlot::Stroke,
            Some(&solid(0.2))
        )
        .is_ok());
        // Nothing selected, an unknown id, and a colour that is not finite.
        assert!(matches!(
            set_paint(&mut s, &[], PaintSlot::Fill, Some(&solid(0.2))),
            Err(Refusal::EditTargetsEmpty)
        ));
        assert!(matches!(
            set_paint(
                &mut s,
                &ids(&["card", "ghost"]),
                PaintSlot::Fill,
                Some(&solid(0.3))
            ),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
        assert!(matches!(
            set_paint(&mut s, &ids(&["card"]), PaintSlot::Fill, Some(&solid(f64::NAN))),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "fill"
        ));
    }

    #[test]
    fn stroke_width_and_style_refuse_what_the_engine_would() {
        let mut s = scene();
        let round = StrokeStyle {
            join: StrokeJoin::Round,
            cap: StrokeCap::Round,
            miter_limit: 4.0,
            dash: vec![20.0, 10.0],
            dash_offset: 0.0,
        };
        assert!(set_stroke(&mut s, &ids(&["card", "rule"]), 6.0, Some(&round)).is_ok());
        assert_eq!(s.objects[0].base().stroke_width, 6.0);
        assert_eq!(s.objects[0].base().stroke_style(), round);
        assert!(matches!(
            set_stroke(&mut s, &ids(&["card", "rule"]), 6.0, Some(&round)),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        // The default style is the absent one: asking for it is no change,
        // and a width change with no style clears the style.
        assert!(set_stroke(&mut s, &ids(&["card"]), 2.0, None).is_ok());
        assert!(s.objects[0].base().stroke_style.is_none());
        assert!(matches!(
            set_stroke(&mut s, &ids(&["card"]), 2.0, Some(&StrokeStyle::default())),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        let bad = |style: StrokeStyle| {
            let mut s = scene();
            set_stroke(&mut s, &ids(&["card"]), 2.0, Some(&style))
        };
        assert!(matches!(
            bad(StrokeStyle { miter_limit: 0.5, ..StrokeStyle::default() }),
            Err(Refusal::ObjectFieldValueInvalid { field, detail })
                if field == "strokeStyle" && detail.contains("miterLimit")
        ));
        assert!(matches!(
            bad(StrokeStyle {
                dash: vec![-1.0, 2.0],
                ..StrokeStyle::default()
            }),
            Err(Refusal::ObjectFieldValueInvalid { .. })
        ));
        assert!(matches!(
            bad(StrokeStyle { dash: vec![0.0, 0.0], ..StrokeStyle::default() }),
            Err(Refusal::ObjectFieldValueInvalid { detail, .. }) if detail.contains("no length")
        ));
        assert!(matches!(
            bad(StrokeStyle { dash: vec![1.0; 65], ..StrokeStyle::default() }),
            Err(Refusal::ObjectFieldValueInvalid { detail, .. }) if detail.contains("at most 64")
        ));
        assert!(matches!(
            set_stroke(&mut s, &ids(&["card"]), -1.0, None),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "strokeWidth"
        ));
        assert!(matches!(
            set_stroke(&mut s, &ids(&["stack"]), 2.0, None),
            Err(Refusal::ObjectFieldNotApplicable { field, .. }) if field == "stroke"
        ));
        // A scaled object with a stroke refuses a stroke width, as the engine does.
        assert!(set_paint(
            &mut s,
            &ids(&["disc"]),
            PaintSlot::Stroke,
            Some(&solid(0.9))
        )
        .is_ok());
        s.objects[1].base_mut().scale_x = 2.0;
        assert!(matches!(
            set_stroke(&mut s, &ids(&["disc"]), 4.0, None),
            Err(Refusal::ScenePropertyNotDrawable { .. })
        ));
    }

    #[test]
    fn a_shape_is_created_from_a_path_and_a_group_takes_children() {
        let mut s = scene();
        let line = BezierPath {
            closed: false,
            vertices: vec![v(10.0, 20.0), v(110.0, 60.0)],
            in_tangents: vec![v(0.0, 0.0); 2],
            out_tangents: vec![v(0.0, 0.0); 2],
        };
        let Ok(EditEffect::ObjectCreated { object_id }) = create_shape(&mut s, " Wipe ", &line)
        else {
            panic!("a shape is created");
        };
        assert_eq!(object_id, "shape-1");
        let SceneObject::Shape(created) = s.objects.last().unwrap() else {
            panic!("a shape");
        };
        assert_eq!(created.base.name, "Wipe");
        assert_eq!((created.base.width, created.base.height), (100.0, 40.0));
        assert!(created.fill_enabled && !created.stroke_enabled);
        assert!(created.base.fill.is_some());
        // A second one takes the next id.
        assert!(matches!(
            create_shape(&mut s, "Again", &line),
            Ok(EditEffect::ObjectCreated { object_id }) if object_id == "shape-2"
        ));
        let mut short = line.clone();
        short.vertices.truncate(1);
        short.in_tangents.truncate(1);
        short.out_tangents.truncate(1);
        assert!(matches!(
            create_shape(&mut s, "Short", &short),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "path"
        ));
        let mut skewed = line.clone();
        skewed.in_tangents.pop();
        assert!(matches!(
            create_shape(&mut s, "Skewed", &skewed),
            Err(Refusal::VectorTessellationFailed { .. })
        ));
        let mut nan = line.clone();
        nan.vertices[0].x = f64::NAN;
        assert!(matches!(
            create_shape(&mut s, "Nan", &nan),
            Err(Refusal::ObjectFieldValueInvalid { .. })
        ));
        assert!(matches!(
            create_shape(&mut s, "  ", &line),
            Err(Refusal::SceneObjectNameEmpty)
        ));
        assert_eq!(s.objects.len(), 9, "refused creations add nothing");

        // Children: a group's list is replaced by the two shapes, emptied and
        // refilled.
        let kids = ids(&["shape-1", "shape-2"]);
        assert!(set_group_children(&mut s, "stack", &kids).is_ok());
        assert!(set_group_children(&mut s, "stack", &[]).is_ok());
        assert!(set_group_children(&mut s, "stack", &kids).is_ok());
        assert!(matches!(
            set_group_children(&mut s, "stack", &kids),
            Err(Refusal::ObjectFieldUnchanged { field }) if field == "childIds"
        ));
        // Refused by name: a missing child, itself, a cycle, a child another
        // group claims, and a kind that has no children.
        let mut other = scene();
        other.objects.push(group("outer", &[]));
        assert!(matches!(
            set_group_children(&mut other, "outer", &ids(&["ghost"])),
            Err(Refusal::SceneHierarchyInvalid { problem, .. }) if problem == "missingChild"
        ));
        assert!(matches!(
            set_group_children(&mut other, "outer", &ids(&["outer"])),
            Err(Refusal::SceneHierarchyInvalid { problem, .. }) if problem == "selfReference"
        ));
        assert!(matches!(
            set_group_children(&mut other, "outer", &ids(&["stencil"])),
            Err(Refusal::SceneHierarchyInvalid { problem, .. }) if problem == "multipleParents"
        ));
        assert!(set_group_children(&mut other, "outer", &ids(&["stack"])).is_ok());
        assert!(matches!(
            set_group_children(&mut other, "stack", &ids(&["outer"])),
            Err(Refusal::SceneHierarchyInvalid { problem, .. }) if problem == "cycle"
        ));
        assert!(matches!(
            set_group_children(&mut other, "card", &ids(&["disc"])),
            Err(Refusal::ObjectFieldNotApplicable { field, .. }) if field == "childIds"
        ));
        // Dropping the clip child from the group is refused, not left dangling.
        let mut clipped = scene();
        assert!(set_clip_child(&mut clipped, "stack", Some("stencil")).is_ok());
        assert!(matches!(
            set_group_children(&mut clipped, "stack", &ids(&["content"])),
            Err(Refusal::ClipGroupInvalid { .. })
        ));
        assert_eq!(
            clipped.objects[4].child_ids(),
            ["stencil".to_owned(), "content".to_owned()],
            "a refused edit leaves the group as it was"
        );
    }

    #[test]
    fn an_edit_does_not_hide_a_fault_it_leaves_in_place() {
        // A scene that already carries a bad mask refuses a new bad mask on
        // that object rather than treating the old refusal as "not new".
        let mut s = scene();
        let mut open = mask(MaskMode::Add);
        open.path.closed = false;
        s.objects[0].base_mut().masks = Some(vec![open.clone()]);
        let mut other = open.clone();
        other.feather = 3.0;
        assert!(matches!(
            set_object_masks(&mut s, "card", &[other]),
            Err(Refusal::MaskInvalid { .. })
        ));
        // The same bad mask kept, with a good one added after it: the refusal
        // at the bad mask is exactly the one the scene already had, so only
        // "this edit left the field invalid" can refuse it.
        assert!(matches!(
            set_object_masks(&mut s, "card", &[open.clone(), mask(MaskMode::Subtract)]),
            Err(Refusal::MaskInvalid { index: 0, .. })
        ));
        // And an unrelated edit is not blocked by it.
        assert!(set_paint(&mut s, &ids(&["disc"]), PaintSlot::Fill, Some(&solid(0.4))).is_ok());
        // Fixing it is allowed.
        assert!(set_object_masks(&mut s, "card", &[mask(MaskMode::Add)]).is_ok());
    }
}
