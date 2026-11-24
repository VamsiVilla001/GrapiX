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
    compound_paths: &[BezierPath],
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
    for (i, sub) in compound_paths.iter().enumerate() {
        shape_path_valid(&id, sub, &format!("compoundPaths[{i}]"))?;
    }
    let (width, height) = path_box(std::iter::once(path).chain(compound_paths));
    let mut base = crate::scene::ObjectBase::new(id.clone(), name.to_owned());
    base.width = width;
    base.height = height;
    base.fill = Some(default_fill());
    let before = scene.clone();
    scene.objects.push(SceneObject::Shape(ShapeObject {
        base,
        path: path.clone(),
        compound_paths: (!compound_paths.is_empty()).then(|| compound_paths.to_vec()),
        fill_enabled: true,
        stroke_enabled: false,
        fill_rule: FillRule::Nonzero,
        trim_start: None,
        trim_end: None,
        trim_offset: None,
        contour_ids: None,
    }));
    refuse_what_cannot_be_drawn(before, scene, &[(&id, &["path", "compoundPaths"])])?;
    Ok(EditEffect::ObjectCreated { object_id: id })
}

/// Whether `object` draws pixels of its own, so a blend mode, an anchor or an
/// effect stack on it changes what is drawn. A group, a layer, a marker, a
/// camera and a light draw nothing themselves; setting one there would be
/// stored and never seen (invariant 18), so the edits below refuse it by name.
fn draws_itself(object: &SceneObject) -> bool {
    !matches!(
        object,
        SceneObject::Group(_)
            | SceneObject::Layer(_)
            | SceneObject::Marker(_)
            | SceneObject::Camera(_)
            | SceneObject::Light(_)
    )
}

/// The indices of `object_ids`, each of which must exist and draw itself.
fn drawing_targets(
    scene: &SceneDocument,
    object_ids: &[String],
    field: &str,
) -> Result<Vec<usize>, Refusal> {
    if object_ids.is_empty() {
        return Err(Refusal::EditTargetsEmpty);
    }
    let indices = object_ids
        .iter()
        .map(|id| object_index(scene, id))
        .collect::<Result<Vec<_>, _>>()?;
    let inapplicable: Vec<&SceneObject> = indices
        .iter()
        .map(|&i| &scene.objects[i])
        .filter(|object| !draws_itself(object))
        .collect();
    if !inapplicable.is_empty() {
        return Err(not_applicable(field, &inapplicable));
    }
    Ok(indices)
}

/// Set every listed object's layer blend mode (3.20); absent clears it to
/// `normal`. Every one of the 38 modes is drawn, so the only refusals are an
/// unknown object, a kind that draws nothing itself, and no change.
pub fn set_blend_mode(
    scene: &mut SceneDocument,
    object_ids: &[String],
    blend_mode: Option<crate::material::BlendMode>,
) -> Result<EditEffect, Refusal> {
    let indices = drawing_targets(scene, object_ids, "blendMode")?;
    let changing: Vec<usize> = indices
        .into_iter()
        .filter(|&i| scene.objects[i].base().blend_mode != blend_mode)
        .collect();
    if changing.is_empty() {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "blendMode".into(),
        });
    }
    let before = scene.clone();
    let mut ids = Vec::with_capacity(changing.len());
    for &i in &changing {
        scene.objects[i].base_mut().blend_mode = blend_mode;
        ids.push(scene.objects[i].base().id.clone());
    }
    let edited: Vec<(&str, &[&str])> = ids
        .iter()
        .map(|id| (id.as_str(), &["blendMode"][..]))
        .collect();
    refuse_what_cannot_be_drawn(before, scene, &edited)?;
    Ok(changed(ids))
}

/// Set every listed object's pivot (3.13): the object-local point it rotates
/// and scales about; absent puts it back at the object's origin.
pub fn set_anchor(
    scene: &mut SceneDocument,
    object_ids: &[String],
    anchor: Option<crate::scene::Vec2>,
) -> Result<EditEffect, Refusal> {
    if let Some(anchor) = anchor {
        if !anchor.x.is_finite() || !anchor.y.is_finite() {
            return Err(Refusal::ObjectFieldValueInvalid {
                field: "anchor".into(),
                detail: "x and y must be finite".into(),
            });
        }
    }
    let indices = drawing_targets(scene, object_ids, "anchor")?;
    let changing: Vec<usize> = indices
        .into_iter()
        .filter(|&i| scene.objects[i].base().anchor != anchor)
        .collect();
    if changing.is_empty() {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "anchor".into(),
        });
    }
    let before = scene.clone();
    let mut ids = Vec::with_capacity(changing.len());
    for &i in &changing {
        scene.objects[i].base_mut().anchor = anchor;
        ids.push(scene.objects[i].base().id.clone());
    }
    let edited: Vec<(&str, &[&str])> = ids
        .iter()
        .map(|id| (id.as_str(), &["anchor"][..]))
        .collect();
    refuse_what_cannot_be_drawn(before, scene, &edited)?;
    Ok(changed(ids))
}

/// Replace one object's ordered effect stack (3.22); an empty list clears it.
/// Each effect is checked by the same `validate_effects` the validator and
/// the engine use, so an unknown parameter or an out-of-range value refuses
/// `effectInvalid` naming the effect.
pub fn set_effects(
    scene: &mut SceneDocument,
    object_id: &str,
    effects: &[crate::effect::EffectInstance],
) -> Result<EditEffect, Refusal> {
    let index = drawing_targets(scene, &[object_id.to_owned()], "effects")?[0];
    crate::effect::validate_effects(object_id, effects)?;
    if scene.objects[index].base().effects() == effects {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "effects".into(),
        });
    }
    let before = scene.clone();
    scene.objects[index].base_mut().effects = (!effects.is_empty()).then(|| effects.to_vec());
    refuse_what_cannot_be_drawn(before, scene, &[(object_id, &["effects"])])?;
    Ok(changed(vec![object_id.to_owned()]))
}

/// Check one bezier path of a shape the way `createShape` does.
fn shape_path_valid(id: &str, path: &BezierPath, field: &str) -> Result<(), Refusal> {
    let invalid = |detail: &str| Refusal::ObjectFieldValueInvalid {
        field: field.into(),
        detail: detail.into(),
    };
    if path.vertices.len() < 2 {
        return Err(invalid("a shape path needs at least two vertices"));
    }
    if !path
        .vertices
        .iter()
        .chain(&path.in_tangents)
        .chain(&path.out_tangents)
        .all(|p| p.x.is_finite() && p.y.is_finite())
    {
        return Err(invalid("a shape path's points must be finite"));
    }
    bezier_arrays_match(id, path)
}

/// Replace a shape's geometry: its primary path and all of its additional
/// subpaths (a compound path, drawn with the shape's fill rule). An empty
/// `compound_paths` leaves a single path. The box follows the vertex bounds of
/// every subpath, as `createShape` sets it.
pub fn set_shape_path(
    scene: &mut SceneDocument,
    shape_id: &str,
    path: &BezierPath,
    compound_paths: &[BezierPath],
    fill_rule: Option<FillRule>,
) -> Result<EditEffect, Refusal> {
    let index = object_index(scene, shape_id)?;
    if !matches!(scene.objects[index], SceneObject::Shape(_)) {
        return Err(not_applicable("path", &[&scene.objects[index]]));
    }
    shape_path_valid(shape_id, path, "path")?;
    for (i, sub) in compound_paths.iter().enumerate() {
        shape_path_valid(shape_id, sub, &format!("compoundPaths[{i}]"))?;
    }
    let compound = (!compound_paths.is_empty()).then(|| compound_paths.to_vec());
    if let SceneObject::Shape(shape) = &scene.objects[index] {
        if shape.path == *path
            && shape.compound_paths == compound
            && fill_rule.is_none_or(|rule| rule == shape.fill_rule)
        {
            return Err(Refusal::ObjectFieldUnchanged {
                field: "path".into(),
            });
        }
    }
    let before = scene.clone();
    let (width, height) = path_box(std::iter::once(path).chain(compound_paths));
    if let SceneObject::Shape(shape) = &mut scene.objects[index] {
        // Contour ids stay with the subpaths that stay: a count that changes keeps the first ids and gives new ones to what is added.
        if let Some(ids) = &mut shape.contour_ids {
            let want = 1 + compound.as_ref().map_or(0, Vec::len);
            ids.truncate(want);
            while ids.len() < want {
                let fresh = ids.iter().copied().max().map_or(0, |m| m + 1);
                ids.push(fresh);
            }
        }
        shape.path = path.clone();
        shape.compound_paths = compound;
        if let Some(rule) = fill_rule {
            shape.fill_rule = rule;
        }
        shape.base.width = width;
        shape.base.height = height;
    }
    refuse_what_cannot_be_drawn(
        before,
        scene,
        &[(shape_id, &["path", "compoundPaths", "fillRule"])],
    )?;
    Ok(changed(vec![shape_id.to_owned()]))
}

/// Put a guide on the canvas (11.44). Refused by name for a position that is not a finite number, or one that already has a guide.
pub fn add_guide(scene: &mut SceneDocument, axis: crate::scene::GuideAxis, position: f64) -> Result<EditEffect, Refusal> {
    if !position.is_finite() {
        return Err(Refusal::ObjectFieldValueInvalid { field: "guides".into(), detail: "a guide's position must be a finite number".into() });
    }
    if scene.guides.iter().any(|g| g.axis == axis && g.position == position) {
        return Err(Refusal::ObjectFieldUnchanged { field: "guides".into() });
    }
    let id = (1..).find(|n| !scene.guides.iter().any(|g| g.id == *n)).expect("an unbounded range has a free id");
    scene.guides.push(crate::scene::Guide { id, axis, position });
    Ok(EditEffect::None)
}

/// Move a guide to another position.
pub fn move_guide(scene: &mut SceneDocument, id: u32, position: f64) -> Result<EditEffect, Refusal> {
    if !position.is_finite() {
        return Err(Refusal::ObjectFieldValueInvalid { field: "guides".into(), detail: "a guide's position must be a finite number".into() });
    }
    let Some(guide) = scene.guides.iter_mut().find(|g| g.id == id) else {
        return Err(Refusal::ObjectFieldValueInvalid { field: "guides".into(), detail: format!("there is no guide {id}") });
    };
    if guide.position == position {
        return Err(Refusal::ObjectFieldUnchanged { field: "guides".into() });
    }
    guide.position = position;
    Ok(EditEffect::None)
}

/// Take a guide off the canvas.
pub fn remove_guide(scene: &mut SceneDocument, id: u32) -> Result<EditEffect, Refusal> {
    let Some(at) = scene.guides.iter().position(|g| g.id == id) else {
        return Err(Refusal::ObjectFieldValueInvalid { field: "guides".into(), detail: format!("there is no guide {id}") });
    };
    scene.guides.remove(at);
    Ok(EditEffect::None)
}

/// Take one subpath out of a compound shape (11.112). The others keep their contour ids (given ids first if the shape had none), the
/// path channels and links of the shape follow them to their new places, and those of the subpath taken out end with it.
pub fn remove_subpath(scene: &mut SceneDocument, shape_id: &str, subpath: usize) -> Result<EditEffect, Refusal> {
    use crate::path_geometry::PathTarget;
    let index = object_index(scene, shape_id)?;
    let SceneObject::Shape(shape) = &scene.objects[index] else {
        return Err(not_applicable("path", &[&scene.objects[index]]));
    };
    let mut paths = vec![shape.path.clone()];
    paths.extend(shape.compound_paths.clone().unwrap_or_default());
    if paths.len() < 2 {
        return Err(Refusal::ObjectFieldValueInvalid {
            field: "compoundPaths".into(),
            detail: "a shape keeps at least one path".into(),
        });
    }
    if subpath >= paths.len() {
        return Err(Refusal::ObjectFieldValueInvalid {
            field: crate::path_anim::target_field(PathTarget::Shape { subpath }),
            detail: "the shape has no such subpath".into(),
        });
    }
    let mut ids = shape.contour_ids.clone().unwrap_or_else(|| (0..paths.len() as u32).collect());
    let before = scene.clone();
    paths.remove(subpath);
    ids.remove(subpath);
    let (width, height) = path_box(paths.iter());
    let main = paths.remove(0);
    if let SceneObject::Shape(shape) = &mut scene.objects[index] {
        shape.path = main;
        shape.compound_paths = (!paths.is_empty()).then_some(paths);
        shape.contour_ids = Some(ids);
        shape.base.width = width;
        shape.base.height = height;
    }
    // Channels of the subpath end with it; those of later subpaths move up one place.
    scene.timeline.path_channels.retain(|c| !(c.object_id == shape_id && c.target == PathTarget::Shape { subpath }));
    for channel in &mut scene.timeline.path_channels {
        if channel.object_id == shape_id {
            if let PathTarget::Shape { subpath: at } = &mut channel.target {
                if *at > subpath {
                    *at -= 1;
                }
            }
        }
    }
    // Links: the user in the subpath goes, later ones move up; a link left with fewer than two users ends.
    for link in &mut scene.path_links {
        link.users.retain(|u| !(u.object_id == shape_id && u.subpath == Some(subpath)));
        for user in &mut link.users {
            if user.object_id == shape_id {
                if let Some(at) = &mut user.subpath {
                    if *at > subpath {
                        *at -= 1;
                    }
                }
            }
        }
    }
    scene.path_links.retain(|link| link.users.len() >= 2);
    refuse_what_cannot_be_drawn(before, scene, &[(shape_id, &["path", "compoundPaths", "contourIds"])])?;
    Ok(changed(vec![shape_id.to_owned()]))
}

/// One semantic path operation (plan row 11.107) on a shape's path or
/// subpath, or on one of an object's masks. The shape goes through
/// [`set_shape_path`] and the mask through [`set_object_masks`], so the box,
/// the drawability check and the refusals are theirs; an operation the path
/// cannot take is refused by name (`objectFieldValueInvalid`).
///
/// 11.112: with a `frame`, or on a path that already has a channel, the edit
/// is an edit of an animated path (see [`edit_animated_path`]).
pub fn edit_path(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    op: &crate::path_geometry::PathOp,
    frame: Option<u64>,
    base_revision: Option<u64>,
) -> Result<EditEffect, Refusal> {
    use crate::path_geometry::PathTarget;
    let index = object_index(scene, object_id)?;
    let invalid = |field: String, detail: &str| Refusal::ObjectFieldValueInvalid {
        field,
        detail: detail.into(),
    };
    // A linked path is one path in several places, keys included: the edit lands in all of them (11.112).
    let linked = crate::path_link::link_at(scene, &crate::path_link::PathAddress { object_id: object_id.to_owned(), target }).is_some();
    let animated_edit = path_channel_index(scene, object_id, target).is_some() || (frame.is_some() && !op.changes_topology());
    if linked && animated_edit {
        return through_link(scene, object_id, target, base_revision, |scene, gate| {
            edit_animated_path(scene, object_id, target, op, frame, gate)?
                .ok_or(Refusal::ObjectFieldUnchanged { field: crate::path_anim::target_field(target) })
        });
    }
    if let Some(effect) = edit_linked_path(scene, object_id, target, op, base_revision)? {
        return Ok(effect);
    }
    if let Some(effect) = edit_animated_path(scene, object_id, target, op, frame, true)? {
        return Ok(effect);
    }
    match target {
        PathTarget::Shape { subpath } => {
            let SceneObject::Shape(shape) = &scene.objects[index] else {
                return Err(not_applicable("path", &[&scene.objects[index]]));
            };
            let mut paths = vec![shape.path.clone()];
            paths.extend(shape.compound_paths.clone().unwrap_or_default());
            let field = if subpath == 0 {
                "path".to_owned()
            } else {
                format!("compoundPaths[{}]", subpath - 1)
            };
            let Some(current) = paths.get(subpath) else {
                return Err(invalid(field, "the shape has no such subpath"));
            };
            paths[subpath] = op.apply(current).map_err(|why| invalid(field, why))?;
            let main = paths.remove(0);
            set_shape_path(scene, object_id, &main, &paths, None)
        }
        PathTarget::Mask { index: mask } => {
            let mut masks = scene.objects[index].base().masks().to_vec();
            let field = format!("masks[{mask}].path");
            let Some(current) = masks.get(mask) else {
                return Err(invalid(field, "the object has no such mask"));
            };
            masks[mask].path = op.apply(&current.path).map_err(|why| invalid(field, why))?;
            set_object_masks(scene, object_id, &masks)
        }
    }
}

/// An edit of a still linked path (11.112): the path every user shares is changed, written to all of them and its revision goes up by one.
/// `Ok(None)` when the path is not linked. An edit made on an older revision than the path has is refused by name.
fn edit_linked_path(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    op: &crate::path_geometry::PathOp,
    base_revision: Option<u64>,
) -> Result<Option<EditEffect>, Refusal> {
    use crate::path_anim::{put_target_path, target_field, target_path};
    use crate::path_link::{link_at, objects_of, PathAddress};
    let address = PathAddress { object_id: object_id.to_owned(), target };
    let Some(link_index) = link_at(scene, &address) else {
        if base_revision.is_some() {
            return Err(Refusal::ObjectFieldValueInvalid {
                field: target_field(target),
                detail: "a revision was named, but this path is not linked".into(),
            });
        }
        return Ok(None);
    };
    let field = target_field(target);
    let invalid = |detail: String| Refusal::ObjectFieldValueInvalid { field: field.clone(), detail };
    let link = scene.path_links[link_index].clone();
    if let Some(named) = base_revision {
        if named != link.revision {
            return Err(invalid(format!(
                "the shared path {} was changed since revision {named}; it is revision {} now. Look at it again, then edit",
                link.id, link.revision
            )));
        }
    }
    let Some(current) = target_path(scene, object_id, target) else {
        return Err(invalid("there is no such path".into()));
    };
    let next = op.apply(&current).map_err(|why| invalid(why.into()))?;
    if next == current {
        return Err(Refusal::ObjectFieldUnchanged { field });
    }
    let before = scene.clone();
    for user in &link.users {
        if let Some(place) = user.target(scene) {
            put_target_path(scene, &user.object_id, place, next.clone());
        }
    }
    scene.path_links[link_index].revision += 1;
    let objects = objects_of(&link);
    for id in &objects {
        refresh_shape_box(scene, id);
    }
    let edited: Vec<(&str, &[&str])> = objects.iter().map(|id| (id.as_str(), &["path", "compoundPaths", "masks"][..])).collect();
    refuse_what_cannot_be_drawn(before, scene, &edited)?;
    Ok(Some(changed(objects)))
}

/// Make `destination`'s path the same path as `source`'s (11.112): the numbers are copied in and the two are one linked path from then
/// on. A mask is given an id when it has none. Refused by name when a path is not there, either is animated, they are the same path,
/// or `destination` is linked already.
pub fn link_paths(
    scene: &mut SceneDocument,
    source: &crate::path_link::PathAddress,
    destination: &crate::path_link::PathAddress,
) -> Result<EditEffect, Refusal> {
    use crate::path_anim::{put_target_path, target_field, target_path};
    use crate::path_link::{ensure_mask_id, link_at, next_link_id, user_at, PathLink};
    let words = |a: &crate::path_link::PathAddress| format!("{} ({})", a.object_id, target_field(a.target));
    let invalid = |detail: String| Refusal::ObjectFieldValueInvalid { field: "pathLinks".into(), detail };
    object_index(scene, &source.object_id)?;
    object_index(scene, &destination.object_id)?;
    if source == destination {
        return Err(invalid("a path cannot be linked to itself".into()));
    }
    let Some(shared) = target_path(scene, &source.object_id, source.target) else {
        return Err(invalid(format!("{} has no such path", words(source))));
    };
    let Some(existing) = target_path(scene, &destination.object_id, destination.target) else {
        return Err(invalid(format!("{} has no such path", words(destination))));
    };
    // The destination takes the source's path and keys; one that has keys of its own would lose them, so it is refused by name.
    if scene.timeline.path_channels.iter().any(|c| c.object_id == destination.object_id && c.target == destination.target && !c.keys.is_empty()) {
        return Err(invalid(format!("{} is animated: remove its path keys first, or link the other way round", words(destination))));
    }
    if link_at(scene, destination).is_some() {
        return Err(invalid(format!("{} is linked already: unlink it first", words(destination))));
    }
    let before = scene.clone();
    for address in [source, destination] {
        if let crate::path_geometry::PathTarget::Mask { index } = address.target {
            ensure_mask_id(scene, &address.object_id, index);
        }
    }
    let (Some(source_user), Some(destination_user)) = (user_at(scene, source), user_at(scene, destination)) else {
        return Err(invalid("a path to link is not there".into()));
    };
    let link_index = match scene.path_links.iter().position(|l| l.users.contains(&source_user)) {
        Some(i) => i,
        None => {
            let id = next_link_id(scene);
            scene.path_links.push(PathLink { id, revision: 1, users: vec![source_user] });
            scene.path_links.len() - 1
        }
    };
    put_target_path(scene, &destination.object_id, destination.target, shared.clone());
    scene.path_links[link_index].users.push(destination_user);
    if existing != shared {
        scene.path_links[link_index].revision += 1;
    }
    // The keys of the source go to the destination too.
    crate::path_link::sync_channels(scene, link_index, source);
    refresh_shape_box(scene, &source.object_id);
    refresh_shape_box(scene, &destination.object_id);
    let mut edited: Vec<(&str, &[&str])> = vec![(source.object_id.as_str(), &["path", "compoundPaths", "masks"][..])];
    if destination.object_id != source.object_id {
        edited.push((destination.object_id.as_str(), &["path", "compoundPaths", "masks"][..]));
    }
    refuse_what_cannot_be_drawn(before, scene, &edited)?;
    let mut ids = vec![source.object_id.clone()];
    if destination.object_id != source.object_id {
        ids.push(destination.object_id.clone());
    }
    Ok(changed(ids))
}

/// Take one path out of its link (11.112): it keeps the path it has and is independent from then on. A link left with one user ends.
pub fn unlink_path(scene: &mut SceneDocument, address: &crate::path_link::PathAddress) -> Result<EditEffect, Refusal> {
    use crate::path_link::{link_at, user_at};
    object_index(scene, &address.object_id)?;
    let (Some(link_index), Some(user)) = (link_at(scene, address), user_at(scene, address)) else {
        return Err(Refusal::ObjectFieldUnchanged { field: "pathLinks".into() });
    };
    scene.path_links[link_index].users.retain(|u| u != &user);
    if scene.path_links[link_index].users.len() < 2 {
        scene.path_links.remove(link_index);
    }
    Ok(changed(vec![address.object_id.clone()]))
}

/// Run a path-key edit of `object_id`'s `target`; when that path is linked, the edit is made on it, then the rest path and the keys go to
/// every other user of the link and the revision goes up (11.112). `run` is told whether to check drawability itself (it does not when the
/// users are about to be brought in line). `base_revision`, when named, must be the link's.
fn through_link(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    base_revision: Option<u64>,
    run: impl FnOnce(&mut SceneDocument, bool) -> Result<EditEffect, Refusal>,
) -> Result<EditEffect, Refusal> {
    use crate::path_anim::{put_target_path, target_field, target_path};
    use crate::path_link::{link_at, objects_of, sync_channels, PathAddress};
    let address = PathAddress { object_id: object_id.to_owned(), target };
    let Some(link_index) = link_at(scene, &address) else {
        if base_revision.is_some() {
            return Err(Refusal::ObjectFieldValueInvalid {
                field: target_field(target),
                detail: "a revision was named, but this path is not linked".into(),
            });
        }
        return run(scene, true);
    };
    let link = scene.path_links[link_index].clone();
    if let Some(named) = base_revision {
        if named != link.revision {
            return Err(Refusal::ObjectFieldValueInvalid {
                field: target_field(target),
                detail: format!(
                    "the shared path {} was changed since revision {named}; it is revision {} now. Look at it again, then edit",
                    link.id, link.revision
                ),
            });
        }
    }
    let before = scene.clone();
    if let Err(refusal) = run(scene, false) {
        *scene = before;
        return Err(refusal);
    }
    // The rest path and the keys of the edited user go to the others.
    if let Some(rest) = target_path(scene, object_id, target) {
        for user in &link.users {
            if let Some(place) = user.target(scene) {
                if !(user.object_id == object_id && place == target) {
                    put_target_path(scene, &user.object_id, place, rest.clone());
                }
            }
        }
    }
    sync_channels(scene, link_index, &address);
    scene.path_links[link_index].revision += 1;
    let objects = objects_of(&link);
    for id in &objects {
        refresh_shape_box(scene, id);
    }
    let edited: Vec<(&str, &[&str])> = objects.iter().map(|id| (id.as_str(), &["path", "compoundPaths", "masks"][..])).collect();
    if let Err(refusal) = refuse_what_cannot_be_drawn(before.clone(), scene, &edited) {
        *scene = before;
        return Err(refusal);
    }
    Ok(changed(objects))
}

/// The index of the channel of one target, if it has one.
fn path_channel_index(
    scene: &SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
) -> Option<usize> {
    scene
        .timeline
        .path_channels
        .iter()
        .position(|c| c.object_id == object_id && c.target == target)
}

/// The vertex box of one shape: its path, its subpaths and every key of its
/// channels (11.112), so an animated shape's box holds all its keys.
fn refresh_shape_box(scene: &mut SceneDocument, object_id: &str) {
    let Ok(index) = object_index(scene, object_id) else {
        return;
    };
    let SceneObject::Shape(shape) = &scene.objects[index] else {
        return;
    };
    let keys: Vec<BezierPath> = scene
        .timeline
        .path_channels
        .iter()
        .filter(|c| c.object_id == object_id)
        .flat_map(|c| c.keys.iter().map(|k| k.path.clone()))
        .collect();
    let (width, height) = path_box(
        std::iter::once(&shape.path)
            .chain(shape.compound_paths.iter().flatten())
            .chain(keys.iter()),
    );
    if let SceneObject::Shape(shape) = &mut scene.objects[index] {
        shape.base.width = width;
        shape.base.height = height;
    }
}

/// The object fields a path edit of `target` may change, for the drawability gate.
fn path_fields(target: crate::path_geometry::PathTarget) -> &'static [&'static str] {
    if matches!(target, crate::path_geometry::PathTarget::Mask { .. }) {
        &["masks"]
    } else {
        &["path", "compoundPaths"]
    }
}

/// An edit of a path that is, or is becoming, animated (11.112). `Ok(None)` when
/// the path is static and the edit is one of the plain static edits.
///
/// - an edit of WHICH vertices there are (insert, delete, keep-shape delete,
///   reverse, first vertex, close) lands in every key and the rest path at
///   once; an inserted vertex takes the same new id in each and splits each
///   curve exactly, so the shape at every key is unchanged;
/// - any other edit needs a `frame` and sets the key there (made from the
///   path as it is at that frame when the frame has no key yet);
/// - a geometry edit with a frame on a static path starts its channel.
fn edit_animated_path(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    op: &crate::path_geometry::PathOp,
    frame: Option<u64>,
    gate: bool,
) -> Result<Option<EditEffect>, Refusal> {
    use crate::path_anim::{
        evaluate_path_channel, fresh_channel_id, put_target_path, target_field, target_path,
        PathChannel, PathKey,
    };
    use crate::path_geometry::{same_topology, with_ids};
    let field = target_field(target);
    let invalid = |detail: &str| Refusal::ObjectFieldValueInvalid {
        field: field.clone(),
        detail: detail.into(),
    };
    let channel_at = path_channel_index(scene, object_id, target);
    let topology = op.changes_topology();
    match (channel_at, frame) {
        (None, None) => return Ok(None),
        (None, Some(_)) if topology => return Ok(None),
        (Some(_), None) if !topology => {
            return Err(invalid("this path is animated: say at which frame the edit is made"));
        }
        _ => {}
    }
    object_index(scene, object_id)?;
    let Some(base) = target_path(scene, object_id, target) else {
        return Err(invalid("there is no such path"));
    };
    let before = scene.clone();
    if topology {
        let channel_index = channel_at.expect("a topology edit reaches here only with a channel");
        let channel = scene.timeline.path_channels[channel_index].clone();
        // Every key must be the same vertices as the rest path, or "vertex 3"
        // would mean different vertices in different keys.
        let base = with_ids(&base);
        let keys: Vec<PathKey> = channel
            .keys
            .iter()
            .map(|k| PathKey { path: with_ids(&k.path), ..k.clone() })
            .collect();
        if let Some(odd) = keys.iter().find(|k| !same_topology(&base, &k.path)) {
            return Err(invalid(&format!(
                "the key at frame {} does not have the same vertices as the others; make them agree first",
                odd.frame
            )));
        }
        let fresh = fresh_channel_id(&base, Some(&PathChannel { keys: keys.clone(), ..channel.clone() }));
        let apply = |path: &BezierPath, at: Option<u64>| {
            op.apply_with(path, Some(fresh)).map_err(|why| {
                invalid(&match at {
                    Some(frame) => format!("at frame {frame}: {why}"),
                    None => why.to_owned(),
                })
            })
        };
        let new_base = apply(&base, None)?;
        let mut new_keys = Vec::with_capacity(keys.len());
        for key in &keys {
            new_keys.push(PathKey { path: apply(&key.path, Some(key.frame))?, ..key.clone() });
        }
        put_target_path(scene, object_id, target, new_base);
        scene.timeline.path_channels[channel_index].keys = new_keys;
    } else {
        let frame = frame.expect("a geometry edit reaches here only with a frame");
        let base = with_ids(&base);
        let (current, easing, bezier, at_key) = match channel_at {
            Some(i) => {
                let channel = &scene.timeline.path_channels[i];
                let at = channel.keys.iter().find(|k| k.frame == frame);
                let previous = channel.keys.iter().rev().find(|k| k.frame < frame);
                let path = match at {
                    Some(key) => key.path.clone(),
                    None => evaluate_path_channel(channel, frame)?
                        .map(|v| v.path)
                        .unwrap_or_else(|| base.clone()),
                };
                let (easing, bezier) = at
                    .or(previous)
                    .map_or((crate::animation::SceneEasing::Linear, None), |k| (k.easing, k.bezier));
                (with_ids(&path), easing, bezier, at.is_some())
            }
            None => (base.clone(), crate::animation::SceneEasing::Linear, None, false),
        };
        let edited = op.apply(&current).map_err(invalid)?;
        if edited == current && at_key {
            return Err(Refusal::ObjectFieldUnchanged { field });
        }
        if channel_at.is_none() {
            // The rest path takes the ids, so its keys and it correspond.
            put_target_path(scene, object_id, target, base);
            scene.timeline.path_channels.push(PathChannel {
                object_id: object_id.to_owned(),
                target,
                keys: Vec::new(),
            });
        }
        let i = path_channel_index(scene, object_id, target).expect("the channel exists now");
        let keys = &mut scene.timeline.path_channels[i].keys;
        let key = PathKey { frame, path: edited, easing, bezier };
        match keys.iter().position(|k| k.frame >= frame) {
            Some(at) if keys[at].frame == frame => keys[at] = key,
            Some(at) => keys.insert(at, key),
            None => keys.push(key),
        }
    }
    refresh_shape_box(scene, object_id);
    if gate {
        refuse_what_cannot_be_drawn(before, scene, &[(object_id, path_fields(target))])?;
    }
    Ok(Some(changed(vec![object_id.to_owned()])))
}

/// Put a whole path key on a path channel (11.112), creating the channel with
/// its first key. A key already at that frame is replaced; the same path and
/// easing again is refused by name. A path with no ids takes the vertex index
/// as the id, so keys of the same shape correspond.
pub fn set_path_key(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    frame: u64,
    path: &BezierPath,
    easing: crate::animation::SceneEasing,
    bezier: Option<crate::animation::CubicBezier>,
) -> Result<EditEffect, Refusal> {
    through_link(scene, object_id, target, None, |scene, gate| {
        set_path_key_inner(scene, object_id, target, frame, path, easing, bezier, gate)
    })
}

#[allow(clippy::too_many_arguments)]
fn set_path_key_inner(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    frame: u64,
    path: &BezierPath,
    easing: crate::animation::SceneEasing,
    bezier: Option<crate::animation::CubicBezier>,
    gate: bool,
) -> Result<EditEffect, Refusal> {
    use crate::path_anim::{put_target_path, target_field, target_path, PathChannel, PathKey};
    use crate::path_geometry::with_ids;
    object_index(scene, object_id)?;
    let field = target_field(target);
    let Some(base) = target_path(scene, object_id, target) else {
        return Err(Refusal::ObjectFieldValueInvalid {
            field,
            detail: "there is no such path".into(),
        });
    };
    if (easing == crate::animation::SceneEasing::CustomBezier) != bezier.is_some() {
        return Err(Refusal::InvalidKeyframeEasing {
            object: object_id.to_owned(),
            property: field,
            detail: "custom-bezier and its control points go together".into(),
        });
    }
    let path = with_ids(path);
    let before = scene.clone();
    if path_channel_index(scene, object_id, target).is_none() {
        put_target_path(scene, object_id, target, with_ids(&base));
        scene.timeline.path_channels.push(PathChannel {
            object_id: object_id.to_owned(),
            target,
            keys: Vec::new(),
        });
    }
    let i = path_channel_index(scene, object_id, target).expect("the channel exists now");
    let keys = &mut scene.timeline.path_channels[i].keys;
    let key = PathKey { frame, path, easing, bezier };
    match keys.iter().position(|k| k.frame >= frame) {
        Some(at) if keys[at].frame == frame => {
            if keys[at] == key {
                *scene = before;
                return Err(Refusal::ObjectFieldUnchanged { field });
            }
            keys[at] = key;
        }
        Some(at) => keys.insert(at, key),
        None => keys.push(key),
    }
    refresh_shape_box(scene, object_id);
    if gate {
        refuse_what_cannot_be_drawn(before, scene, &[(object_id, path_fields(target))])?;
    }
    Ok(changed(vec![object_id.to_owned()]))
}

/// Move one key of a path channel to another frame (11.112). The new frame must be inside the timeline and
/// free, as for a numeric key.
pub fn move_path_key(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    from: u64,
    to: u64,
) -> Result<EditEffect, Refusal> {
    through_link(scene, object_id, target, None, |scene, _| move_path_key_inner(scene, object_id, target, from, to))
}

fn move_path_key_inner(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    from: u64,
    to: u64,
) -> Result<EditEffect, Refusal> {
    use crate::path_anim::target_field;
    object_index(scene, object_id)?;
    let field = target_field(target);
    let Some(i) = path_channel_index(scene, object_id, target) else {
        return Err(Refusal::AnimationChannelUnknown { object: object_id.to_owned(), property: field });
    };
    let Some(at) = scene.timeline.path_channels[i].keys.iter().position(|k| k.frame == from) else {
        return Err(Refusal::KeyframeUnknown { object: object_id.to_owned(), property: field, frame: from });
    };
    if from == to {
        return Err(Refusal::ObjectFieldUnchanged { field });
    }
    if to > scene.timeline.duration_frames {
        return Err(Refusal::KeyframeOutOfRange {
            object: object_id.to_owned(),
            property: field,
            frame: to,
            duration_frames: scene.timeline.duration_frames,
        });
    }
    if scene.timeline.path_channels[i].keys.iter().any(|k| k.frame == to) {
        return Err(Refusal::DuplicateKeyframeFrame { object: object_id.to_owned(), property: field, frame: to });
    }
    let keys = &mut scene.timeline.path_channels[i].keys;
    let mut key = keys.remove(at);
    key.frame = to;
    let place = keys.partition_point(|k| k.frame < to);
    keys.insert(place, key);
    Ok(changed(vec![object_id.to_owned()]))
}

/// Take one key off a path channel (11.112). Removing the last key ends the
/// channel; the path then stays as that key had it, so nothing jumps.
pub fn remove_path_key(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    frame: u64,
) -> Result<EditEffect, Refusal> {
    through_link(scene, object_id, target, None, |scene, gate| remove_path_key_inner(scene, object_id, target, frame, gate))
}

fn remove_path_key_inner(
    scene: &mut SceneDocument,
    object_id: &str,
    target: crate::path_geometry::PathTarget,
    frame: u64,
    gate: bool,
) -> Result<EditEffect, Refusal> {
    use crate::path_anim::{put_target_path, target_field};
    object_index(scene, object_id)?;
    let field = target_field(target);
    let Some(i) = path_channel_index(scene, object_id, target) else {
        return Err(Refusal::AnimationChannelUnknown { object: object_id.to_owned(), property: field });
    };
    let Some(at) = scene.timeline.path_channels[i].keys.iter().position(|k| k.frame == frame) else {
        return Err(Refusal::KeyframeUnknown { object: object_id.to_owned(), property: field, frame });
    };
    let before = scene.clone();
    let removed = scene.timeline.path_channels[i].keys.remove(at);
    if scene.timeline.path_channels[i].keys.is_empty() {
        scene.timeline.path_channels.remove(i);
        put_target_path(scene, object_id, target, removed.path);
    }
    refresh_shape_box(scene, object_id);
    if gate {
        refuse_what_cannot_be_drawn(before, scene, &[(object_id, path_fields(target))])?;
    }
    Ok(changed(vec![object_id.to_owned()]))
}

/// The width and height of the vertex bounds of `paths`.
fn path_box<'a>(paths: impl Iterator<Item = &'a BezierPath>) -> (f64, f64) {
    let (mut low, mut high) = ((f64::MAX, f64::MAX), (f64::MIN, f64::MIN));
    for vertex in paths.flat_map(|path| &path.vertices) {
        low = (low.0.min(vertex.x), low.1.min(vertex.y));
        high = (high.0.max(vertex.x), high.1.max(vertex.y));
    }
    (high.0 - low.0, high.1 - low.1)
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
    // A mask taken away leaves its link: the link ends with fewer than two users (11.112).
    crate::path_link::prune_path_links(scene);
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
    // A matte is set to a source that is there; one that goes later passes through with a warning (3.30).
    if let Some(matte) = matte {
        if !scene.objects.iter().any(|o| o.base().id == matte.source_id) {
            return Err(Refusal::TrackMatteInvalid {
                object: object_id.to_owned(),
                detail: format!("the track matte source {} is not in the scene", matte.source_id),
            });
        }
    }
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

/// Turn Preserve Underlying Transparency on or off for one layer (3.28).
/// Refuses by name when it is already so.
pub fn set_preserve_transparency(
    scene: &mut SceneDocument,
    object_id: &str,
    preserve: bool,
) -> Result<EditEffect, Refusal> {
    let index = object_index(scene, object_id)?;
    if scene.objects[index].base().preserves_underlying_transparency() == preserve {
        return Err(Refusal::ObjectFieldUnchanged {
            field: "preserveUnderlyingTransparency".into(),
        });
    }
    scene.objects[index].base_mut().preserve_underlying_transparency = preserve.then_some(true);
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
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        }
    }

    fn mask(mode: MaskMode) -> Mask {
        Mask {
            id: None,
            path: triangle(),
            mode,
            feather: 0.0,
            feather_y: None,
            falloff: Default::default(),
            feather_points: None,
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
                vertex_ids: None,
                vertex_kinds: None,
                auto_tension: None,
            },
            compound_paths: None,
            fill_enabled: true,
            stroke_enabled: false,
            fill_rule: FillRule::Nonzero,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
            contour_ids: None,
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
        // 3.30: `disc` is `card`'s matte source and may take a matte of its own: a matte reads its source before the source's matte.
        assert!(set_track_matte(&mut s, "disc", Some(&matte("path"))).is_ok());
        assert!(s.objects[1].base().track_matte().is_some());
        assert!(set_track_matte(&mut s, "disc", None).is_ok());
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
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        let Ok(EditEffect::ObjectCreated { object_id }) =
            create_shape(&mut s, " Wipe ", &line, &[])
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
            create_shape(&mut s, "Again", &line, &[]),
            Ok(EditEffect::ObjectCreated { object_id }) if object_id == "shape-2"
        ));
        let mut short = line.clone();
        short.vertices.truncate(1);
        short.in_tangents.truncate(1);
        short.out_tangents.truncate(1);
        assert!(matches!(
            create_shape(&mut s, "Short", &short, &[]),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "path"
        ));
        let mut skewed = line.clone();
        skewed.in_tangents.pop();
        assert!(matches!(
            create_shape(&mut s, "Skewed", &skewed, &[]),
            Err(Refusal::VectorTessellationFailed { .. })
        ));
        let mut nan = line.clone();
        nan.vertices[0].x = f64::NAN;
        assert!(matches!(
            create_shape(&mut s, "Nan", &nan, &[]),
            Err(Refusal::ObjectFieldValueInvalid { .. })
        ));
        assert!(matches!(
            create_shape(&mut s, "  ", &line, &[]),
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

    // --- the MCP gaps (16 Nov 2026) -------------------------------------------

    fn exposure(stops: f64) -> crate::effect::EffectInstance {
        crate::effect::EffectInstance::new(
            "exposure",
            crate::effect::Effect::Exposure(crate::effect::Exposure {
                exposure: stops,
                offset: 0.0,
                gamma_correction: 1.0,
            }),
        )
    }

    fn square(x: f64, y: f64, side: f64) -> BezierPath {
        BezierPath {
            closed: true,
            vertices: vec![
                v(x, y),
                v(x + side, y),
                v(x + side, y + side),
                v(x, y + side),
            ],
            in_tangents: vec![v(0.0, 0.0); 4],
            out_tangents: vec![v(0.0, 0.0); 4],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        }
    }

    #[test]
    fn blend_mode_anchor_and_effects_refuse_what_draws_nothing_and_restore() {
        use crate::material::BlendMode;
        let mut s = scene();
        let before = s.clone();
        // A group draws nothing itself: refused by name, nothing changed.
        assert_eq!(
            set_blend_mode(&mut s, &ids(&["card", "stack"]), Some(BlendMode::Multiply)),
            Err(Refusal::ObjectFieldNotApplicable {
                field: "blendMode".into(),
                kinds: vec!["group".into()],
            })
        );
        assert_eq!(s, before);
        assert!(matches!(
            set_blend_mode(&mut s, &ids(&["ghost"]), None),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
        assert_eq!(
            set_blend_mode(&mut s, &[], Some(BlendMode::Screen)),
            Err(Refusal::EditTargetsEmpty)
        );
        // Set, unchanged, cleared.
        set_blend_mode(&mut s, &ids(&["card", "disc"]), Some(BlendMode::Multiply)).unwrap();
        assert_eq!(s.objects[0].base().blend_mode, Some(BlendMode::Multiply));
        assert_eq!(s.objects[1].base().blend_mode, Some(BlendMode::Multiply));
        assert!(matches!(
            set_blend_mode(&mut s, &ids(&["card"]), Some(BlendMode::Multiply)),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        set_blend_mode(&mut s, &ids(&["card"]), None).unwrap();
        assert_eq!(s.objects[0].base().blend_mode, None);

        // The anchor must be finite, and a group has no pivot of its own.
        assert!(matches!(
            set_anchor(&mut s, &ids(&["card"]), Some(v(f64::NAN, 0.0))),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "anchor"
        ));
        assert!(matches!(
            set_anchor(&mut s, &ids(&["stack"]), Some(v(1.0, 1.0))),
            Err(Refusal::ObjectFieldNotApplicable { .. })
        ));
        set_anchor(&mut s, &ids(&["card"]), Some(v(50.0, 40.0))).unwrap();
        assert_eq!(s.objects[0].base().anchor, Some(v(50.0, 40.0)));
        set_anchor(&mut s, &ids(&["card"]), None).unwrap();
        assert_eq!(s.objects[0].base().anchor, None);

        // Effects are checked by the one validator, and replace the stack.
        let held = s.clone();
        assert!(matches!(
            set_effects(&mut s, "card", &[exposure(99.0)]),
            Err(Refusal::EffectInvalid { effect_id, .. }) if effect_id == "exposure"
        ));
        assert_eq!(s, held, "a refused effect changed nothing");
        assert!(matches!(
            set_effects(&mut s, "stack", &[exposure(1.0)]),
            Err(Refusal::ObjectFieldNotApplicable { .. })
        ));
        set_effects(&mut s, "card", &[exposure(1.0)]).unwrap();
        assert_eq!(s.objects[0].base().effects(), &[exposure(1.0)]);
        assert!(matches!(
            set_effects(&mut s, "card", &[exposure(1.0)]),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        set_effects(&mut s, "card", &[]).unwrap();
        assert_eq!(s.objects[0].base().effects, None, "an empty list clears");
    }

    #[test]
    fn a_shape_takes_compound_subpaths_at_creation_and_by_replacement() {
        let mut s = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        let Ok(EditEffect::ObjectCreated { object_id }) = create_shape(
            &mut s,
            "Pair",
            &square(0.0, 0.0, 50.0),
            &[square(100.0, 0.0, 50.0)],
        ) else {
            panic!("a compound shape is created");
        };
        let SceneObject::Shape(created) = &s.objects[0] else {
            panic!("a shape");
        };
        assert_eq!(
            created.compound_paths.as_deref(),
            Some(&[square(100.0, 0.0, 50.0)][..])
        );
        assert_eq!((created.base.width, created.base.height), (150.0, 50.0));
        // A broken subpath is refused at its index, and nothing is created.
        let held = s.clone();
        let short = BezierPath {
            closed: false,
            vertices: vec![v(0.0, 0.0)],
            in_tangents: vec![v(0.0, 0.0)],
            out_tangents: vec![v(0.0, 0.0)],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        assert!(matches!(
            create_shape(&mut s, "Bad", &square(0.0, 0.0, 10.0), std::slice::from_ref(&short)),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "compoundPaths[0]"
        ));
        assert_eq!(s, held);

        // Replacement: the path and every subpath, the box following them.
        set_shape_path(&mut s, &object_id, &square(0.0, 0.0, 80.0), &[], None).unwrap();
        let SceneObject::Shape(replaced) = &s.objects[0] else {
            panic!("a shape");
        };
        assert_eq!(replaced.path, square(0.0, 0.0, 80.0));
        assert_eq!(replaced.compound_paths, None, "an empty list is one path");
        assert_eq!((replaced.base.width, replaced.base.height), (80.0, 80.0));
        assert!(matches!(
            set_shape_path(&mut s, &object_id, &square(0.0, 0.0, 80.0), &[], None),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        // The fill rule alone is a change; the same rule again is not.
        set_shape_path(
            &mut s,
            &object_id,
            &square(0.0, 0.0, 80.0),
            &[],
            Some(FillRule::Evenodd),
        )
        .unwrap();
        let SceneObject::Shape(ruled) = &s.objects[0] else {
            panic!("a shape");
        };
        assert_eq!(ruled.fill_rule, FillRule::Evenodd);
        assert!(matches!(
            set_shape_path(
                &mut s,
                &object_id,
                &square(0.0, 0.0, 80.0),
                &[],
                Some(FillRule::Evenodd)
            ),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        assert!(matches!(
            set_shape_path(&mut s, &object_id, &square(0.0, 0.0, 80.0), &[short], None),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "compoundPaths[0]"
        ));
        let mut r = scene();
        assert!(matches!(
            set_shape_path(&mut r, "card", &square(0.0, 0.0, 10.0), &[], None),
            Err(Refusal::ObjectFieldNotApplicable { .. })
        ));
    }

    #[test]
    fn width_height_and_draw_order_are_inspector_fields() {
        use crate::object_edit::{set_object_field, ObjectField};
        let mut s = scene();
        set_object_field(&mut s, &ids(&["card", "disc"]), &ObjectField::Width(300.0)).unwrap();
        assert_eq!(
            (s.objects[0].base().width, s.objects[1].base().width),
            (300.0, 300.0)
        );
        set_object_field(&mut s, &ids(&["card"]), &ObjectField::Height(10.0)).unwrap();
        assert_eq!(s.objects[0].base().height, 10.0);
        for bad in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(matches!(
                set_object_field(&mut s, &ids(&["card"]), &ObjectField::Width(bad)),
                Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "width"
            ));
        }
        // A shape's box follows its path, a line's its points, a group has none.
        assert!(matches!(
            set_object_field(&mut s, &ids(&["path", "rule", "stack"]), &ObjectField::Width(5.0)),
            Err(Refusal::ObjectFieldNotApplicable { field, kinds })
                if field == "width" && kinds == ["shape", "line", "group"]
        ));
        set_object_field(&mut s, &ids(&["disc"]), &ObjectField::ZIndex(3)).unwrap();
        assert_eq!(s.objects[1].base().z_index, 3);
        assert!(matches!(
            set_object_field(&mut s, &ids(&["stack"]), &ObjectField::ZIndex(1)),
            Err(Refusal::ObjectFieldNotApplicable { .. })
        ));
        assert!(matches!(
            set_object_field(&mut s, &ids(&["disc"]), &ObjectField::ZIndex(3)),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
    }
    #[test]
    fn edit_path_changes_a_shape_subpath_or_a_mask_by_name() {
        use crate::path_geometry::{HandleCoupling, HandleSide, PathOp, PathTarget};
        let mut s = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        let Ok(EditEffect::ObjectCreated { object_id }) = create_shape(
            &mut s,
            "Pair",
            &square(0.0, 0.0, 50.0),
            &[square(100.0, 0.0, 50.0)],
        ) else {
            panic!("a compound shape is created");
        };
        // The main path takes an insert and keeps its curve (a square's side is straight).
        edit_path(
            &mut s,
            &object_id,
            PathTarget::Shape { subpath: 0 },
            &PathOp::InsertVertex { segment: 0, t: 0.5 }, None, None
        )
        .unwrap();
        let SceneObject::Shape(shape) = &s.objects[0] else {
            panic!("a shape");
        };
        assert_eq!(shape.path.vertices.len(), 5);
        assert_eq!(shape.path.vertices[1].x, 25.0);
        assert_eq!(
            shape.compound_paths.as_ref().unwrap()[0],
            square(100.0, 0.0, 50.0)
        );
        // A subpath is reached by its place, and the box follows the vertices.
        edit_path(
            &mut s,
            &object_id,
            PathTarget::Shape { subpath: 1 },
            &PathOp::MoveVertices {
                indices: vec![0, 1, 2, 3],
                delta: Vec2 { x: 200.0, y: 0.0 },
            }, None, None
        )
        .unwrap();
        assert_eq!(s.objects[0].base().width, 350.0);
        let one_handle = PathOp::SetHandle {
            index: 0,
            side: HandleSide::Out,
            vector: Vec2 { x: 5.0, y: 5.0 },
            coupling: HandleCoupling::Mirror,
        };
        edit_path(
            &mut s,
            &object_id,
            PathTarget::Shape { subpath: 0 },
            &one_handle, None, None
        )
        .unwrap();
        // Refused by name: a subpath that is not there, a path that cannot take it, an unchanged result.
        assert!(matches!(
            edit_path(&mut s, &object_id, PathTarget::Shape { subpath: 5 }, &PathOp::Reverse, None, None),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "compoundPaths[4]"
        ));
        assert!(matches!(
            edit_path(
                &mut s,
                &object_id,
                PathTarget::Shape { subpath: 0 },
                &PathOp::DeleteVertices { indices: vec![9] }, None, None
            ),
            Err(Refusal::ObjectFieldValueInvalid { field, detail }) if field == "path" && detail == "there is no such vertex"
        ));
        assert!(matches!(
            edit_path(
                &mut s,
                &object_id,
                PathTarget::Shape { subpath: 0 },
                &PathOp::SetClosed { closed: true }, None, None
            ),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        assert!(matches!(
            edit_path(&mut s, &object_id, PathTarget::Mask { index: 0 }, &PathOp::Reverse, None, None),
            Err(Refusal::ObjectFieldValueInvalid { field, .. }) if field == "masks[0].path"
        ));
        assert!(matches!(
            edit_path(
                &mut s,
                "nope",
                PathTarget::Shape { subpath: 0 },
                &PathOp::Reverse, None, None
            ),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
    }

    fn animated_shape() -> (SceneDocument, String) {
        let mut s = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        s.timeline.duration_frames = 100;
        let Ok(EditEffect::ObjectCreated { object_id }) =
            create_shape(&mut s, "Box", &square(0.0, 0.0, 50.0), &[])
        else {
            panic!("a shape");
        };
        (s, object_id)
    }

    fn shape_path(s: &SceneDocument) -> BezierPath {
        let SceneObject::Shape(shape) = &s.objects[0] else { panic!("a shape") };
        shape.path.clone()
    }

    #[test]
    fn a_geometry_edit_at_a_frame_makes_keys_and_the_path_moves_between_them() {
        use crate::path_anim::evaluate_path_channel;
        use crate::path_geometry::{PathOp, PathTarget};
        let (mut s, id) = animated_shape();
        let target = PathTarget::Shape { subpath: 0 };
        let move_all = |dx: f64| PathOp::MoveVertices { indices: vec![0, 1, 2, 3], delta: Vec2 { x: dx, y: 0.0 } };
        // No frame, no channel: a plain static edit, as before.
        edit_path(&mut s, &id, target, &move_all(1.0), None, None).unwrap();
        assert!(s.timeline.path_channels.is_empty());
        // A frame on a geometry edit starts the channel with that key; the rest path takes ids.
        // (A key set at the value the path has is a key: Set Keyframe at the current value.)
        edit_path(&mut s, &id, target, &move_all(0.0), Some(0), None).unwrap();
        assert_eq!(s.timeline.path_channels[0].keys.len(), 1);
        edit_path(&mut s, &id, target, &move_all(10.0), Some(0), None).unwrap();
        assert_eq!(s.timeline.path_channels.len(), 1);
        assert_eq!(shape_path(&s).vertex_ids, Some(vec![0, 1, 2, 3]));
        edit_path(&mut s, &id, target, &move_all(100.0), Some(20), None).unwrap();
        let channel = &s.timeline.path_channels[0];
        assert_eq!(channel.keys.iter().map(|k| k.frame).collect::<Vec<_>>(), vec![0, 20]);
        let mid = evaluate_path_channel(channel, 10).unwrap().unwrap().path;
        assert_eq!(mid.vertices[0].x, (11.0 + 111.0) / 2.0);
        // The box holds every key, so the layer source is big enough for all of them.
        assert_eq!(s.objects[0].base().width, 160.0); // x from 1 (the rest path) to 161 (the last key)
        // Editing at a frame that has a key changes that key; an edit that changes nothing is refused by name.
        edit_path(&mut s, &id, target, &move_all(5.0), Some(20), None).unwrap();
        assert!(matches!(
            edit_path(&mut s, &id, target, &move_all(0.0), Some(20), None),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        // An animated path refuses a geometry edit that names no frame, and a frame past the timeline.
        assert!(matches!(
            edit_path(&mut s, &id, target, &move_all(3.0), None, None),
            Err(Refusal::ObjectFieldValueInvalid { detail, .. }) if detail.contains("which frame")
        ));
        assert!(matches!(
            edit_path(&mut s, &id, target, &move_all(3.0), Some(101), None),
            Err(Refusal::KeyframeOutOfRange { .. })
        ));
    }

    #[test]
    fn a_topology_edit_lands_in_every_key_with_one_new_id_and_the_shape_at_each_key_is_unchanged() {
        use crate::path_geometry::{cubic_of, point_at, PathOp, PathTarget};
        let (mut s, id) = animated_shape();
        let target = PathTarget::Shape { subpath: 0 };
        let move_all = |dx: f64| PathOp::MoveVertices { indices: vec![0, 1, 2, 3], delta: Vec2 { x: dx, y: 0.0 } };
        edit_path(&mut s, &id, target, &move_all(10.0), Some(0), None).unwrap();
        edit_path(&mut s, &id, target, &PathOp::SetHandle {
            index: 0,
            side: crate::path_geometry::HandleSide::Out,
            vector: Vec2 { x: 5.0, y: 12.0 },
            coupling: crate::path_geometry::HandleCoupling::None,
        }, Some(20), None).unwrap();
        let before: Vec<BezierPath> = s.timeline.path_channels[0].keys.iter().map(|k| k.path.clone()).collect();
        // No frame needed: which vertices there are is the same at every frame.
        edit_path(&mut s, &id, target, &PathOp::InsertVertex { segment: 0, t: 0.25 }, None, None).unwrap();
        let channel = &s.timeline.path_channels[0];
        for (key, old) in channel.keys.iter().zip(&before) {
            assert_eq!(key.path.vertex_ids, Some(vec![0, 4, 1, 2, 3]), "the same new id in every key");
            let (whole, left, right) = (cubic_of(old, 0), cubic_of(&key.path, 0), cubic_of(&key.path, 1));
            for k in 0..=10 {
                let u = k as f64 / 10.0;
                let (a, b) = (point_at(&left, u), point_at(&whole, 0.25 * u));
                assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9);
                let (a, b) = (point_at(&right, u), point_at(&whole, 0.25 + 0.75 * u));
                assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9);
            }
        }
        assert_eq!(shape_path(&s).vertex_ids, Some(vec![0, 4, 1, 2, 3]));
        // Delete follows its stated policy: the vertex goes from every key and the rest path.
        edit_path(&mut s, &id, target, &PathOp::DeleteVertices { indices: vec![1] }, None, None).unwrap();
        for key in &s.timeline.path_channels[0].keys {
            assert_eq!(key.path.vertex_ids, Some(vec![0, 1, 2, 3]));
        }
        // Reverse and first vertex keep keys corresponding.
        edit_path(&mut s, &id, target, &PathOp::SetFirstVertex { index: 2 }, None, None).unwrap();
        for key in &s.timeline.path_channels[0].keys {
            assert_eq!(key.path.vertex_ids, Some(vec![2, 3, 0, 1]));
        }
        // A key that does not share the vertices stops a topology edit, by name and frame.
        s.timeline.path_channels[0].keys[1].path = crate::path_geometry::reverse_path(&s.timeline.path_channels[0].keys[1].path);
        let err = edit_path(&mut s, &id, target, &PathOp::Reverse, None, None).unwrap_err();
        assert!(matches!(&err, Refusal::ObjectFieldValueInvalid { detail, .. } if detail.contains("frame 20")), "{err:?}");
    }

    #[test]
    fn a_mask_path_animates_the_same_way_and_a_key_can_be_set_and_removed_whole() {
        use crate::animation::SceneEasing;
        use crate::path_geometry::{PathOp, PathTarget};
        use crate::scene::{Mask, MaskMode};
        let (mut s, id) = animated_shape();
        let mask = Mask {
            id: Some("m1".into()),
            mode: MaskMode::Add,
            path: square(0.0, 0.0, 30.0),
            feather: 0.0,
            feather_y: None,
            falloff: None,
            feather_points: None,
            expansion: 0.0,
            opacity: 1.0,
            inverted: false,
        };
        set_object_masks(&mut s, &id, &[mask]).unwrap();
        let target = PathTarget::Mask { index: 0 };
        let op = PathOp::MoveVertices { indices: vec![0, 1, 2, 3], delta: Vec2 { x: 40.0, y: 0.0 } };
        edit_path(&mut s, &id, target, &op, Some(10), None).unwrap();
        assert_eq!(s.timeline.path_channels[0].target, target);
        // A whole key by value, with an easing; the same again is refused by name.
        let mut far = square(0.0, 0.0, 30.0);
        far.vertices[2].y += 40.0;
        set_path_key(&mut s, &id, target, 30, &far, SceneEasing::Linear, None).unwrap();
        assert!(matches!(
            set_path_key(&mut s, &id, target, 30, &far, SceneEasing::Linear, None),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));
        assert!(matches!(
            set_path_key(&mut s, &id, target, 31, &far, SceneEasing::CustomBezier, None),
            Err(Refusal::InvalidKeyframeEasing { .. })
        ));
        assert!(matches!(
            set_path_key(&mut s, &id, PathTarget::Mask { index: 4 }, 3, &far, SceneEasing::Linear, None),
            Err(Refusal::ObjectFieldValueInvalid { .. })
        ));
        // A key moves to a free frame inside the timeline; an occupied or out-of-range frame is refused by name.
        move_path_key(&mut s, &id, target, 10, 12).unwrap();
        assert_eq!(s.timeline.path_channels[0].keys.iter().map(|k| k.frame).collect::<Vec<_>>(), vec![12, 30]);
        move_path_key(&mut s, &id, target, 30, 5).unwrap();
        assert_eq!(s.timeline.path_channels[0].keys.iter().map(|k| k.frame).collect::<Vec<_>>(), vec![5, 12]);
        assert!(matches!(move_path_key(&mut s, &id, target, 5, 12), Err(Refusal::DuplicateKeyframeFrame { frame: 12, .. })));
        assert!(matches!(move_path_key(&mut s, &id, target, 5, 500), Err(Refusal::KeyframeOutOfRange { .. })));
        assert!(matches!(move_path_key(&mut s, &id, target, 5, 5), Err(Refusal::ObjectFieldUnchanged { .. })));
        assert!(matches!(move_path_key(&mut s, &id, target, 6, 7), Err(Refusal::KeyframeUnknown { frame: 6, .. })));
        move_path_key(&mut s, &id, target, 5, 30).unwrap();
        move_path_key(&mut s, &id, target, 12, 10).unwrap();
        // Removing keys: the last one's removal ends the channel and the mask keeps that key's path.
        assert!(matches!(
            remove_path_key(&mut s, &id, target, 5),
            Err(Refusal::KeyframeUnknown { frame: 5, .. })
        ));
        remove_path_key(&mut s, &id, target, 10).unwrap();
        remove_path_key(&mut s, &id, target, 30).unwrap();
        assert!(s.timeline.path_channels.is_empty());
        assert_eq!(s.objects[0].base().masks()[0].path.vertices[2], far.vertices[2]);
        assert!(matches!(
            remove_path_key(&mut s, &id, target, 30),
            Err(Refusal::AnimationChannelUnknown { .. })
        ));
    }

    fn linked_scene() -> (SceneDocument, String) {
        use crate::scene::{Mask, MaskMode};
        let (mut s, id) = animated_shape();
        let mut card = rect("card");
        card.base_mut().masks = Some(vec![Mask {
            id: None,
            path: square(0.0, 0.0, 30.0),
            mode: MaskMode::Add,
            feather: 0.0,
            feather_y: None,
            falloff: None,
            feather_points: None,
            expansion: 0.0,
            opacity: 1.0,
            inverted: false,
        }]);
        s.objects.push(card);
        (s, id)
    }

    fn address(object: &str, target: crate::path_geometry::PathTarget) -> crate::path_link::PathAddress {
        crate::path_link::PathAddress { object_id: object.into(), target }
    }

    #[test]
    fn a_linked_path_is_one_path_in_two_places_and_an_edit_names_the_revision_it_was_made_on() {
        use crate::path_geometry::{PathOp, PathTarget};
        let (mut s, id) = linked_scene();
        let (shape, mask) = (address(&id, PathTarget::Shape { subpath: 0 }), address("card", PathTarget::Mask { index: 0 }));
        // Nothing is shared until the author links: a copy stays independent.
        edit_path(&mut s, &id, shape.target, &PathOp::MoveVertices { indices: vec![0, 1, 2, 3], delta: Vec2 { x: 1.0, y: 0.0 } }, None, None).unwrap();
        assert_ne!(s.objects[1].base().masks()[0].path, shape_path(&s));
        link_paths(&mut s, &shape, &mask).unwrap();
        // The mask took the shape's numbers, got an id, and the two are one link at revision 2 (the path changed).
        assert_eq!(s.objects[1].base().masks()[0].path, shape_path(&s));
        assert_eq!(s.objects[1].base().masks()[0].id.as_deref(), Some("mask-1"));
        assert_eq!(s.path_links.len(), 1);
        assert_eq!((s.path_links[0].revision, s.path_links[0].users.len()), (2, 2));
        assert_eq!(crate::path_link::validate_path_links(&s), Ok(()));
        // An edit of the shape changes the mask, and the revision goes up; so does an edit of the mask.
        let by = |dx: f64| PathOp::MoveVertices { indices: vec![0, 1, 2, 3], delta: Vec2 { x: dx, y: 0.0 } };
        edit_path(&mut s, &id, shape.target, &by(5.0), None, Some(2)).unwrap();
        assert_eq!(s.objects[1].base().masks()[0].path, shape_path(&s));
        assert_eq!(s.path_links[0].revision, 3);
        edit_path(&mut s, "card", mask.target, &by(7.0), None, Some(3)).unwrap();
        assert_eq!(s.objects[1].base().masks()[0].path, shape_path(&s));
        assert_eq!(s.path_links[0].revision, 4);
        // An edit made on an older revision is refused by name, and the path is as it was.
        let before = s.clone();
        let stale = edit_path(&mut s, &id, shape.target, &by(1.0), None, Some(2)).unwrap_err();
        assert!(matches!(&stale, Refusal::ObjectFieldValueInvalid { detail, .. } if detail.contains("since revision 2") && detail.contains("revision 4")), "{stale:?}");
        assert_eq!(s, before);
        // A revision named for a path that is not linked is refused, and an edit that changes nothing is too.
        let mut loose = linked_scene().0;
        assert!(matches!(edit_path(&mut loose, "card", mask.target, &by(1.0), None, Some(1)), Err(Refusal::ObjectFieldValueInvalid { detail, .. }) if detail.contains("not linked")));
        assert!(matches!(edit_path(&mut s, &id, shape.target, &by(0.0), None, None), Err(Refusal::ObjectFieldUnchanged { .. })));
        // Anything that would make the two differ by another route is refused: the validator holds them to one path.
        let mut other = square(0.0, 0.0, 60.0);
        other.vertex_ids = None;
        let off_route = set_shape_path(&mut s, &id, &other, &[], None).unwrap_err();
        assert!(matches!(&off_route, Refusal::ObjectFieldValueInvalid { detail, .. } | Refusal::VectorTessellationFailed { detail, .. } if detail.contains("linked paths differ")), "{off_route:?}");
    }

    #[test]
    fn linking_refuses_by_name_and_a_link_ends_when_a_mask_goes_or_the_author_unlinks() {
        use crate::path_geometry::{PathOp, PathTarget};
        use crate::scene::{Mask, MaskMode};
        let (mut s, id) = linked_scene();
        let (shape, mask) = (address(&id, PathTarget::Shape { subpath: 0 }), address("card", PathTarget::Mask { index: 0 }));
        let text = |r: Result<EditEffect, Refusal>| match r {
            Err(Refusal::ObjectFieldValueInvalid { detail, .. }) => detail,
            other => format!("{other:?}"),
        };
        assert!(text(link_paths(&mut s, &shape, &shape)).contains("itself"));
        assert!(text(link_paths(&mut s, &shape, &address("card", PathTarget::Mask { index: 4 }))).contains("no such path"));
        assert!(matches!(link_paths(&mut s, &shape, &address("nope", PathTarget::Shape { subpath: 0 })), Err(Refusal::SceneObjectUnknown { .. })));
        // A linked path animates as one (11.112): an animated path may be linked, its keys go to the other user, a key set on either
        // user is on both, and a destination that has keys of its own is refused by name.
        let nudge = PathOp::MoveVertices { indices: vec![0], delta: Vec2 { x: 1.0, y: 1.0 } };
        edit_path(&mut s, &id, shape.target, &nudge, Some(0), None).unwrap();
        let masked = s.objects[1].base().masks()[0].path.clone();
        link_paths(&mut s, &shape, &mask).unwrap();
        assert_eq!(s.timeline.path_channels.len(), 2, "the mask took the shape's keys");
        assert_eq!(s.timeline.path_channels[0].keys, s.timeline.path_channels[1].keys);
        assert_ne!(s.objects[1].base().masks()[0].path, masked);
        assert_eq!(crate::path_link::validate_path_links(&s), Ok(()));
        // A key set at another frame on the MASK is on the shape too, and the revision goes up.
        let revision = s.path_links[0].revision;
        edit_path(&mut s, "card", mask.target, &PathOp::MoveVertices { indices: vec![1], delta: Vec2 { x: 9.0, y: 0.0 } }, Some(5), Some(revision)).unwrap();
        assert_eq!(s.timeline.path_channels.iter().map(|c| c.keys.len()).collect::<Vec<_>>(), vec![2, 2]);
        assert_eq!(s.timeline.path_channels[0].keys, s.timeline.path_channels[1].keys);
        assert_eq!(s.path_links[0].revision, revision + 1);
        // An insert lands in every key of both, one new id each.
        edit_path(&mut s, &id, shape.target, &PathOp::InsertVertex { segment: 0, t: 0.5 }, None, None).unwrap();
        for channel in &s.timeline.path_channels {
            assert!(channel.keys.iter().all(|k| k.path.vertices.len() == 5));
        }
        assert_eq!(s.timeline.path_channels[0].keys, s.timeline.path_channels[1].keys);
        assert_eq!(crate::path_link::validate_path_links(&s), Ok(()));
        // The keys move and go together, and one removed from one is removed from both.
        move_path_key(&mut s, &id, shape.target, 5, 7).unwrap();
        assert_eq!(s.timeline.path_channels[1].keys.iter().map(|k| k.frame).collect::<Vec<_>>(), vec![0, 7]);
        remove_path_key(&mut s, "card", mask.target, 7).unwrap();
        assert_eq!(s.timeline.path_channels.iter().map(|c| c.keys.len()).collect::<Vec<_>>(), vec![1, 1]);
        remove_path_key(&mut s, &id, shape.target, 0).unwrap();
        assert!(s.timeline.path_channels.is_empty(), "the last key ends both channels");
        assert_eq!(crate::path_link::validate_path_links(&s), Ok(()));
        // A stale revision on a keyed edit is refused, with nothing changed.
        let before = s.clone();
        assert!(text(edit_path(&mut s, &id, shape.target, &nudge, Some(1), Some(1))).contains("since revision 1"));
        assert_eq!(s, before);
        // A destination with keys of its own is refused; the same two the other way round link.
        unlink_path(&mut s, &mask).unwrap();
        edit_path(&mut s, "card", mask.target, &nudge, Some(2), None).unwrap();
        assert!(text(link_paths(&mut s, &shape, &mask)).contains("is animated"));
        link_paths(&mut s, &mask, &shape).unwrap();
        assert_eq!(s.timeline.path_channels.len(), 2);
        unlink_path(&mut s, &mask).unwrap();
        s.timeline.path_channels.clear();
        // A destination that is linked already must be unlinked first.
        link_paths(&mut s, &shape, &mask).unwrap();
        assert!(text(link_paths(&mut s, &shape, &mask)).contains("linked already"));
        // A second mask on the card keeps the link when masks are reordered or one is added in front: it is held by id.
        let mut masks = s.objects[1].base().masks().to_vec();
        masks.insert(
            0,
            Mask { id: Some("front".into()), path: square(0.0, 0.0, 10.0), mode: MaskMode::Add, feather: 0.0, feather_y: None, falloff: None, feather_points: None, expansion: 0.0, opacity: 1.0, inverted: false },
        );
        set_object_masks(&mut s, "card", &masks).unwrap();
        assert_eq!(s.path_links.len(), 1);
        assert_eq!(crate::path_link::validate_path_links(&s), Ok(()));
        let moved = address("card", PathTarget::Mask { index: 1 });
        edit_path(&mut s, "card", moved.target, &PathOp::MoveVertices { indices: vec![0, 1, 2, 3], delta: Vec2 { x: 2.0, y: 0.0 } }, None, None).unwrap();
        assert_eq!(s.objects[1].base().masks()[1].path, shape_path(&s));
        // Taking the linked mask away ends the link; the shape keeps its path.
        let kept = shape_path(&s);
        let only_front = vec![s.objects[1].base().masks()[0].clone()];
        set_object_masks(&mut s, "card", &only_front).unwrap();
        assert!(s.path_links.is_empty());
        assert_eq!(shape_path(&s), kept);
        // Unlinking: each keeps its path and the two are independent afterwards.
        let (mut t, tid) = linked_scene();
        let (shape, mask) = (address(&tid, PathTarget::Shape { subpath: 0 }), address("card", PathTarget::Mask { index: 0 }));
        link_paths(&mut t, &shape, &mask).unwrap();
        assert!(unlink_path(&mut t, &address("card", PathTarget::Mask { index: 0 })).is_ok());
        assert!(t.path_links.is_empty(), "a link of one user ends");
        let same = shape_path(&t);
        edit_path(&mut t, &tid, shape.target, &PathOp::MoveVertices { indices: vec![0], delta: Vec2 { x: 9.0, y: 0.0 } }, None, None).unwrap();
        assert_eq!(t.objects[1].base().masks()[0].path, same);
        assert!(matches!(unlink_path(&mut t, &mask), Err(Refusal::ObjectFieldUnchanged { .. })));
        // Deleting an object drops what it shared; duplicating one copies no link.
        let (mut u, uid) = linked_scene();
        link_paths(&mut u, &address(&uid, PathTarget::Shape { subpath: 0 }), &address("card", PathTarget::Mask { index: 0 })).unwrap();
        let copy = crate::authoring::duplicate_object(&mut u, "card").unwrap();
        assert_eq!(u.path_links.len(), 1);
        assert_eq!(u.path_links[0].users.len(), 2, "the copy of the card is not a user: {}", copy.new_object_id);
        crate::authoring::delete_object(&mut u, &uid).unwrap();
        assert!(u.path_links.is_empty());
        assert_eq!(crate::path_link::validate_path_links(&u), Ok(()));
    }

    #[test]
    fn taking_a_subpath_out_keeps_the_others_ids_and_moves_their_channels_and_links() {
        use crate::path_geometry::{PathOp, PathTarget};
        let mut s = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        s.timeline.duration_frames = 100;
        let Ok(EditEffect::ObjectCreated { object_id: id }) = create_shape(
            &mut s,
            "Trio",
            &square(0.0, 0.0, 50.0),
            &[square(100.0, 0.0, 50.0), square(200.0, 0.0, 50.0)],
        ) else {
            panic!("a compound shape");
        };
        let mv = PathOp::MoveVertices { indices: vec![0, 1, 2, 3], delta: Vec2 { x: 5.0, y: 0.0 } };
        // The third subpath is animated, and the second is linked to a mask of another layer.
        edit_path(&mut s, &id, PathTarget::Shape { subpath: 2 }, &mv, Some(10), None).unwrap();
        let mut card = rect("card");
        card.base_mut().masks = Some(vec![crate::scene::Mask {
            id: None,
            path: square(0.0, 0.0, 30.0),
            mode: crate::scene::MaskMode::Add,
            feather: 0.0,
            feather_y: None,
            falloff: None,
            feather_points: None,
            expansion: 0.0,
            opacity: 1.0,
            inverted: false,
        }]);
        s.objects.push(card);
        link_paths(&mut s, &address(&id, PathTarget::Shape { subpath: 1 }), &address("card", PathTarget::Mask { index: 0 })).unwrap();
        // The middle one goes: the last moves up to place 1 with its channel, and the link (one user left) ends.
        remove_subpath(&mut s, &id, 1).unwrap();
        let SceneObject::Shape(shape) = &s.objects[0] else { panic!("a shape") };
        assert_eq!(shape.contour_ids, Some(vec![0, 2]), "the ids of the others stay");
        assert_eq!(shape.compound_paths.as_ref().map(Vec::len), Some(1));
        assert_eq!(s.timeline.path_channels.len(), 1);
        assert_eq!(s.timeline.path_channels[0].target, PathTarget::Shape { subpath: 1 });
        assert!(s.path_links.is_empty());
        assert_eq!(crate::path_anim::validate_path_channels(&s), Ok(()));
        // The animated one goes: its channel ends with it. The first goes: the second becomes the main path, ids still 2.
        remove_subpath(&mut s, &id, 1).unwrap();
        assert!(s.timeline.path_channels.is_empty());
        let SceneObject::Shape(shape) = &s.objects[0] else { panic!("a shape") };
        assert_eq!(shape.contour_ids, Some(vec![0]));
        // A shape keeps one path, and there is no subpath past the last.
        assert!(matches!(remove_subpath(&mut s, &id, 0), Err(Refusal::ObjectFieldValueInvalid { detail, .. }) if detail.contains("at least one")));
        assert!(matches!(remove_subpath(&mut s, "card", 0), Err(Refusal::ObjectFieldNotApplicable { .. })));
        // Setting a shape's paths keeps the ids of the subpaths that stay and gives new ones to what is added.
        set_shape_path(&mut s, &id, &square(0.0, 0.0, 60.0), &[square(70.0, 0.0, 10.0), square(90.0, 0.0, 10.0)], None).unwrap();
        let SceneObject::Shape(shape) = &s.objects[0] else { panic!("a shape") };
        assert_eq!(shape.contour_ids, Some(vec![0, 1, 2]));
    }

    #[test]
    fn guides_are_put_moved_and_taken_off_and_refused_by_name() {
        use crate::scene::GuideAxis;
        let mut s = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        add_guide(&mut s, GuideAxis::X, 960.0).unwrap();
        add_guide(&mut s, GuideAxis::Y, 540.0).unwrap();
        assert_eq!(s.guides.iter().map(|g| g.id).collect::<Vec<_>>(), vec![1, 2]);
        // The same line twice, a position that is not a number, and a guide that is not there.
        assert!(matches!(add_guide(&mut s, GuideAxis::X, 960.0), Err(Refusal::ObjectFieldUnchanged { .. })));
        assert!(matches!(add_guide(&mut s, GuideAxis::Y, f64::NAN), Err(Refusal::ObjectFieldValueInvalid { .. })));
        assert!(matches!(move_guide(&mut s, 9, 1.0), Err(Refusal::ObjectFieldValueInvalid { detail, .. }) if detail.contains("no guide 9")));
        move_guide(&mut s, 1, 100.5).unwrap();
        assert!(matches!(move_guide(&mut s, 1, 100.5), Err(Refusal::ObjectFieldUnchanged { .. })));
        // The lowest free id is used again.
        remove_guide(&mut s, 1).unwrap();
        add_guide(&mut s, GuideAxis::X, 10.0).unwrap();
        assert_eq!(s.guides.iter().map(|g| g.id).collect::<Vec<_>>(), vec![2, 1]);
        assert!(matches!(remove_guide(&mut s, 7), Err(Refusal::ObjectFieldValueInvalid { .. })));
        // A scene with none has no field in its JSON, and the validator refuses a hand-made duplicate id.
        assert!(!serde_json::to_string(&new_scene("s", "S", WorkingColorSpace::NEW_PROJECT)).unwrap().contains("guides"));
        s.guides[0].id = s.guides[1].id;
        assert!(!crate::drawability::drawability_refusals(&s).is_empty());
    }

    #[test]
    fn edit_path_reaches_a_mask_of_any_object() {
        use crate::path_geometry::{PathOp, PathTarget};
        use crate::scene::{Mask, MaskMode};
        let mut s = new_scene("s", "S", WorkingColorSpace::NEW_PROJECT);
        let Ok(EditEffect::ObjectCreated { object_id }) =
            create_shape(&mut s, "Host", &square(0.0, 0.0, 80.0), &[])
        else {
            panic!("a shape");
        };
        let mask = Mask {
            id: None,
            path: square(10.0, 10.0, 40.0),
            mode: MaskMode::Add,
            feather: 0.0,
            feather_y: None,
            falloff: Default::default(),
            feather_points: None,
            expansion: 0.0,
            opacity: 1.0,
            inverted: false,
        };
        set_object_masks(&mut s, &object_id, &[mask]).unwrap();
        edit_path(
            &mut s,
            &object_id,
            PathTarget::Mask { index: 0 },
            &PathOp::InsertVertex {
                segment: 1,
                t: 0.25,
            }, None, None
        )
        .unwrap();
        assert_eq!(s.objects[0].base().masks()[0].path.vertices.len(), 5);
    }
}
