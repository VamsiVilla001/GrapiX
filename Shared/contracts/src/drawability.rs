//! What the software reference path cannot draw yet, refused by name (3.13).
//!
//! Invariant 18 forbids a fallback that changes pixels, so an authored kind or
//! property the engine would ignore refuses instead of being dropped. Every
//! refusal names the object, the property and the build-plan step that will
//! draw it, so the answer is also the plan. A property refuses only when it
//! differs from its default: the default draws exactly what the engine
//! already draws.
//!
//! **Why this lives in contracts.** The engine used to hold these checks
//! alone, so the Editor's validator accepted scenes the engine then refused
//! at publish — the laxer-validator failure `validate.rs` exists to prevent.
//! `validate_scene_document` reports every fault from here; the engine runs
//! the same function again over the bound document and takes the first. There
//! is one implementation (invariant 27).
//!
//! The list comes from the 13 October 2026 audit of every authored field
//! (`memory.md`). When a step lands, its check here is deleted with it.

use std::collections::{HashMap, HashSet};

use crate::color::ColorValue;
use crate::material::MaterialKind;
use crate::scene::{
    BezierPath, SceneDocument, SceneObject, TextAlign, TextAutoFit, TextCase, TextLayout,
    TextObject, TextOverflow, VerticalAlign, WritingMode,
};
use crate::{Refusal, StructuredRefusal};

/// Refuse the first authored kind or property the software path cannot draw.
///
/// The engine's form: preparation only needs to know that it cannot proceed.
pub fn refuse_what_the_software_path_cannot_draw(document: &SceneDocument) -> Result<(), Refusal> {
    match drawability_refusals(document).into_iter().next() {
        Some(refusal) => Err(refusal.code),
        None => Ok(()),
    }
}

/// 3.16's prepared-source bridge cannot change source geometry on the frame
/// path. Engine and mock publication use this one rule; CPU reference renders
/// remain available independently. No width/height animation is silently frozen.
pub fn gpu_compositor_animation_refusal(document: &SceneDocument) -> Option<Refusal> {
    document.timeline.channels.iter().enumerate().find_map(|(index, channel)| {
        if channel.keys.is_empty() || !matches!(channel.property.as_str(), "width" | "height") { return None; }
        Some(Refusal::ScenePropertyNotDrawable {
            object: channel.object_id.clone(),
            property: format!("timeline.channels[{index}].property: animated {} needs a GPU source backend", channel.property),
            owner: "3.17/3.18".into(),
        })
    })
}

/// Every authored kind or property the software path cannot draw, each with
/// its JSON path and the offending value. The validator's form.
pub fn drawability_refusals(document: &SceneDocument) -> Vec<StructuredRefusal> {
    let mut found = Found::default();
    if let Some(camera) = &document.active_camera_id {
        found.push(property(&document.id, "activeCameraId", "11.48"), "activeCameraId", serde_json::json!(camera));
    }
    let by_id: HashMap<&str, &SceneObject> = document
        .objects
        .iter()
        .map(|object| (object.base().id.as_str(), object))
        .collect();
    let mut parents: HashMap<&str, &str> = HashMap::new();
    for object in &document.objects {
        for child in object.child_ids() {
            parents.entry(child.as_str()).or_insert(object.base().id.as_str());
        }
    }
    let resolution = crate::scene::resolve_hierarchy(&document.objects);
    let scaled_by_channel = |object: &str| {
        document.timeline.channels.iter().any(|channel| {
            channel.object_id == object && !channel.keys.is_empty()
                && matches!(channel.property.as_str(), "scaleX" | "scaleY")
        })
    };

    for (index, object) in document.objects.iter().enumerate() {
        let base = object.base();
        let id = base.id.as_str();
        let at = |field: &str| format!("objects[{index}].{field}");

        // A non-finite number makes every later check on this object
        // meaningless, so those are reported alone.
        let mut finite = true;
        for (name, value) in [
            ("x", base.x), ("y", base.y), ("width", base.width), ("height", base.height),
            ("rotation", base.rotation), ("rotationX", base.rotation_x),
            ("rotationY", base.rotation_y), ("scaleX", base.scale_x),
            ("scaleY", base.scale_y), ("scaleZ", base.scale_z),
            ("zDepth", base.z_depth), ("opacity", base.opacity),
            ("strokeWidth", base.stroke_width),
        ] {
            if !value.is_finite() {
                finite = false;
                found.push(property(id, name, "3.13"), at(name), serde_json::json!(value.to_string()));
            }
        }
        if !finite {
            continue;
        }
        if !(0.0..=1.0).contains(&base.opacity) {
            found.push(property(id, "opacity", "3.13"), at("opacity"), serde_json::json!(base.opacity));
        }
        if let Some((field, value)) = [("width", base.width), ("height", base.height), ("strokeWidth", base.stroke_width)]
            .into_iter()
            .find(|(_, value)| *value < 0.0)
        {
            found.push(property(id, "negative dimensions or strokeWidth", "3.13"), at(field), serde_json::json!(value));
        }
        if let Some(anchor) = base.anchor.filter(|anchor| !anchor.x.is_finite() || !anchor.y.is_finite()) {
            found.push(
                property(id, "anchor", "3.13"),
                at("anchor"),
                serde_json::json!({ "x": anchor.x.to_string(), "y": anchor.y.to_string() }),
            );
        }
        // A kind the path cannot draw at all is reported alone: its other
        // properties would only restate it.
        let kind_owner = match object {
            SceneObject::Image(_) => Some(("image", "3.17")),
            SceneObject::Mesh(_) => Some(("mesh", "11.48")),
            SceneObject::Paint(_) => Some(("paint", "3.17")),
            _ => None,
        };
        if let Some((name, owner)) = kind_owner {
            found.push(kind(id, name, owner), at("type"), serde_json::json!(name));
            continue;
        }
        match object {
            SceneObject::Rect(rect) if !rect.radius.is_finite() || rect.radius < 0.0 => {
                found.push(property(id, "radius", "3.13"), at("radius"), serde_json::json!(rect.radius.to_string()));
            }
            SceneObject::Text(text) => text_properties(text, &at, &mut found),
            SceneObject::Line(line) if paints(&line.base.fill) => {
                found.push(property(id, "fill", "3.17"), at("fill"), serde_json::to_value(&line.base.fill).unwrap_or_default());
            }
            _ => {}
        }
        // 3.22: the pointwise effects are drawn; the spatial ones (blurs,
        // glow, drop shadow, gradient ramp, wipes) refuse by effect until
        // their kernels land, rather than being skipped.
        for (position, instance) in base.effects().iter().enumerate() {
            if !instance.effect.is_pointwise() {
                found.push(
                    property(id, &format!("effects.{} ({})", instance.effect_id, instance.effect.name()), "3.22"),
                    at(&format!("effects[{position}]")),
                    serde_json::json!(instance.effect.name()),
                );
            }
        }
        if base.material_slots.as_ref().is_some_and(|slots| !slots.is_empty()) {
            found.push(
                property(id, "materialSlots", "11.50"),
                at("materialSlots"),
                serde_json::to_value(&base.material_slots).unwrap_or_default(),
            );
        }
        for (name, set, value) in [
            ("rotationX", base.rotation_x != 0.0, base.rotation_x),
            ("rotationY", base.rotation_y != 0.0, base.rotation_y),
            ("scaleZ", base.scale_z != 1.0, base.scale_z),
            ("zDepth", base.z_depth != 0.0, base.z_depth),
        ] {
            if set {
                found.push(property(id, name, "11.48"), at(name), serde_json::json!(value));
            }
        }
        if !base.layer_id.is_empty() {
            found.push(property(id, "layerId", "3.16"), at("layerId"), serde_json::json!(base.layer_id));
        }
        let ancestors = chain(id, &parents);
        if shears(id, &parents, &by_id) {
            found.push(
                property(id, "rotation under a non-uniformly scaled parent", "3.16"),
                at("rotation"),
                serde_json::json!(base.rotation),
            );
        } else if ancestors.iter().enumerate().any(|(position, ancestor)| {
            let rotates = by_id.get(ancestor).is_some_and(|o| o.base().rotation.rem_euclid(360.0) != 0.0)
                || document.timeline.channels.iter().any(|channel| {
                    channel.object_id == *ancestor && channel.property == "rotation" && !channel.keys.is_empty()
                });
            rotates && ancestors[position + 1..].iter().any(|parent| {
                by_id.get(parent).is_some_and(|o| o.base().scale_x != o.base().scale_y)
                    || scaled_by_channel(parent)
            })
        }) {
            found.push(
                property(id, "animated rotation under a scaled parent", "3.16"),
                at("rotation"),
                serde_json::json!(base.rotation),
            );
        }
        // Strokes are tessellated after the centreline is transformed. Their
        // width therefore cannot follow a scaled object or parent yet.
        if has_stroke(object) {
            let transform = &resolution.effective[index];
            if transform.scale_x.abs() != 1.0 || transform.scale_y.abs() != 1.0
                || ancestors.iter().any(|ancestor| scaled_by_channel(ancestor))
            {
                found.push(
                    property(id, "scaled strokeWidth", "3.17"),
                    at("strokeWidth"),
                    serde_json::json!(base.stroke_width),
                );
            }
        }
        gradients(object, &at, &mut found);
        crate::container_paint::container_paints(object, &at, &mut found);
        if let SceneObject::Shape(shape) = object {
            if let Err(refusal) = bezier_arrays_match(id, &shape.path) {
                found.push(refusal, at("path"), serde_json::Value::Null);
            }
            for (path_index, path) in shape.compound_paths.iter().flatten().enumerate() {
                if let Err(refusal) = bezier_arrays_match(id, path) {
                    found.push(refusal, at(&format!("compoundPaths[{path_index}]")), serde_json::Value::Null);
                }
            }
        }
    }

    if let Some((index, refusal)) = unlit_light(document) {
        found.push(refusal, format!("objects[{index}].type"), serde_json::json!("light"));
    }

    for (index, channel) in document.timeline.channels.iter().enumerate() {
        let owner = match channel.property.as_str() {
            "rotationX" | "rotationY" | "scaleZ" | "zDepth" => Some("11.48"),
            "width" | "height" => match by_id.get(channel.object_id.as_str()) {
                Some(SceneObject::Text(text)) if text.layout == TextLayout::Paragraph => Some("11.51"),
                _ => None,
            },
            _ => None,
        };
        if let Some(owner) = owner {
            found.push(
                property(&channel.object_id, &format!("animated {}", channel.property), owner),
                format!("timeline.channels[{index}].property"),
                serde_json::json!(channel.property),
            );
        }
    }
    found.refusals
}

/// A bezier path whose vertex and tangent arrays differ in length has no
/// shape to draw. The single check, shared by the validator and the
/// tessellator.
pub fn bezier_arrays_match(object: &str, path: &BezierPath) -> Result<(), Refusal> {
    if path.vertices.len() != path.in_tangents.len() || path.vertices.len() != path.out_tangents.len() {
        return Err(Refusal::VectorTessellationFailed {
            object: object.into(),
            detail: "Bezier vertices and tangent arrays differ in length".into(),
        });
    }
    Ok(())
}

/// A light with nothing that responds to it lights nothing, so the scene
/// would draw as if the light were absent. Only a mesh bound to a PBR
/// material responds to light. The single check, shared by the validator and
/// mesh preparation.
pub fn light_without_responsive_material(document: &SceneDocument) -> Result<(), Refusal> {
    match unlit_light(document) {
        Some((_, refusal)) => Err(refusal),
        None => Ok(()),
    }
}

/// The first light, by document index, when no mesh binds a PBR material.
fn unlit_light(document: &SceneDocument) -> Option<(usize, Refusal)> {
    let (index, light) = document.objects.iter().enumerate().find_map(|(index, object)| match object {
        SceneObject::Light(light) => Some((index, light)),
        _ => None,
    })?;
    let pbr: HashSet<&str> = document
        .materials
        .iter()
        .filter(|material| material.kind == MaterialKind::Pbr)
        .map(|material| material.material_id.as_str())
        .collect();
    let responds = document.objects.iter().any(|object| {
        matches!(object, SceneObject::Mesh(_))
            && object.base().material_slots.as_ref().is_some_and(|slots| {
                slots.values().any(|binding| pbr.contains(binding.material_id.as_str()))
            })
    });
    (!responds).then(|| (index, Refusal::LightHasNoResponsiveMaterial { light_id: light.base.id.clone() }))
}

/// Collected refusals. Each check fires at most once per object, and a
/// non-finite number or an undrawable kind ends that object's checks, so no
/// fault is reported twice.
#[derive(Default)]
pub(crate) struct Found {
    refusals: Vec<StructuredRefusal>,
}

impl Found {
    pub(crate) fn push(&mut self, refusal: Refusal, field: impl Into<String>, given: serde_json::Value) {
        self.refusals.push(StructuredRefusal::error(refusal).at(field, given));
    }
}

fn text_properties(text: &TextObject, at: &dyn Fn(&str) -> String, found: &mut Found) {
    let id = text.base.id.as_str();
    let bounded = |value: f64| value.is_finite() && value.abs() <= f64::from(f32::MAX);
    let size_valid = bounded(text.size) && text.size > 0.0;
    if !size_valid {
        found.push(property(id, "size", "3.13"), at("size"), serde_json::json!(text.size.to_string()));
    }
    if let Some(height) = text.line_height {
        // The line advance is lineHeight × size, so it must fit too.
        if !bounded(height) || height <= 0.0 || (size_valid && !bounded(height * text.size)) {
            found.push(property(id, "lineHeight", "3.13"), at("lineHeight"), serde_json::json!(height.to_string()));
        }
    }
    if !bounded(text.letter_spacing) {
        found.push(
            property(id, "letterSpacing", "3.13"),
            at("letterSpacing"),
            serde_json::json!(text.letter_spacing.to_string()),
        );
    }
    for (name, field, set, owner) in [
        ("autoFit", "autoFit", text.auto_fit != TextAutoFit::None, "11.51"),
        ("writingMode", "writingMode", text.writing_mode != WritingMode::HorizontalTb, "11.51"),
        ("verticalAlign", "verticalAlign", text.vertical_align != VerticalAlign::Top, "3.18"),
        ("decoration", "decoration", text.decoration.underline || text.decoration.strikethrough, "3.18"),
        ("overflow", "overflow", text.overflow != TextOverflow::Visible, "3.18"),
        ("textCase", "textCase", text.text_case == TextCase::SmallCaps, "11.51"),
        ("wordSpacing", "wordSpacing", text.word_spacing != 0.0, "11.51"),
        ("paragraphSpacing", "paragraphSpacing", text.paragraph_spacing != 0.0, "11.51"),
        ("textIndent", "textIndent", text.text_indent != 0.0, "11.51"),
        ("stroke", "stroke", paints(&text.base.stroke) && text.base.stroke_width > 0.0, "3.18"),
        ("point text align", "align", text.layout == TextLayout::Point && text.align != TextAlign::Left, "3.18"),
    ] {
        if set {
            let given = serde_json::to_value(text).ok().and_then(|value| value.get(field).cloned());
            found.push(property(id, name, owner), at(field), given.unwrap_or_default());
        }
    }
}

/// The software path fills and strokes with a solid colour. A gradient needs
/// a fill rule it does not implement, so it refuses rather than being
/// flattened to a stop (invariant 18). Only the paints the path would
/// actually draw are checked; hidden objects are included, since showing one
/// is an edit away.
fn gradients(object: &SceneObject, at: &dyn Fn(&str) -> String, found: &mut Found) {
    let base = object.base();
    let (fill, stroke) = match object {
        SceneObject::Rect(_) | SceneObject::Ellipse(_) => (Some("fill"), true),
        SceneObject::Line(_) => (None, true),
        SceneObject::Shape(shape) => (shape.fill_enabled.then_some("fill"), shape.stroke_enabled),
        SceneObject::Text(_) => (Some("text fill"), false),
        _ => (None, false),
    };
    if let Some(paint) = fill {
        if let Some(kind) = gradient_kind(&base.fill) {
            found.push(
                Refusal::UnsupportedPathGradient { object: base.id.clone(), paint: paint.into() },
                at("fill.type"),
                serde_json::json!(kind),
            );
        }
    }
    if stroke {
        if let Some(kind) = gradient_kind(&base.stroke) {
            found.push(
                Refusal::UnsupportedPathGradient { object: base.id.clone(), paint: "stroke".into() },
                at("stroke.type"),
                serde_json::json!(kind),
            );
        }
    }
}

fn gradient_kind(paint: &Option<ColorValue>) -> Option<&'static str> {
    match paint {
        Some(ColorValue::LinearGradient { .. }) => Some("linear-gradient"),
        Some(ColorValue::RadialGradient { .. }) => Some("radial-gradient"),
        _ => None,
    }
}

/// A rotation below a non-uniformly scaled ancestor shears the object. The
/// resolver composes rotation and scale separately, so it would draw the
/// object unsheared.
fn shears(id: &str, parents: &HashMap<&str, &str>, by_id: &HashMap<&str, &SceneObject>) -> bool {
    let mut chain = vec![id];
    let mut current = id;
    while let Some(parent) = parents.get(current) {
        if chain.len() > by_id.len() {
            return false; // a cycle; the validator reports the hierarchy itself
        }
        chain.push(parent);
        current = parent;
    }
    let mut non_uniform_above = false;
    for id in chain.into_iter().rev() {
        let Some(object) = by_id.get(id) else { return false };
        let base = object.base();
        if non_uniform_above && base.rotation.rem_euclid(360.0) != 0.0 {
            return true;
        }
        if (base.scale_x - base.scale_y).abs() > 1e-9 {
            non_uniform_above = true;
        }
    }
    false
}

fn paints(value: &Option<ColorValue>) -> bool {
    !matches!(value, None | Some(ColorValue::None))
}

fn has_stroke(object: &SceneObject) -> bool {
    let enabled = match object {
        SceneObject::Rect(_) | SceneObject::Ellipse(_) | SceneObject::Line(_) => true,
        SceneObject::Shape(shape) => shape.stroke_enabled,
        _ => false,
    };
    enabled && paints(&object.base().stroke) && object.base().stroke_width > 0.0
}

fn chain<'a>(id: &'a str, parents: &HashMap<&'a str, &'a str>) -> Vec<&'a str> {
    let mut result = vec![id];
    while let Some(parent) = parents.get(result.last().unwrap()) {
        if result.contains(parent) { break; }
        result.push(parent);
    }
    result
}

fn kind(object: &str, kind: &str, owner: &str) -> Refusal {
    Refusal::ObjectKindNotDrawable { object: object.into(), kind: kind.into(), owner: owner.into() }
}

fn property(object: &str, property: &str, owner: &str) -> Refusal {
    Refusal::ScenePropertyNotDrawable {
        object: object.into(),
        property: property.into(),
        owner: owner.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::KeyframeChannel;
    use crate::color::{ColorValue, Rgba, WorkingColorSpace};
    use crate::scene::{
        GroupObject, ImageObject, ObjectBase, RectObject, SceneCanvas, SceneTimeline, ShapeObject,
        Vec2,
    };
    use crate::RationalRate;

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        let mut scene = crate::scene::new_scene("scene", "Scene", WorkingColorSpace::Srgb);
        scene.canvas = SceneCanvas { width: 1920, height: 1080, frame_rate: RationalRate::P50 };
        scene.timeline = SceneTimeline { duration_frames: 10, ..Default::default() };
        scene.objects = objects;
        scene
    }

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject { base: ObjectBase::new(id, id), radius: 0.0 })
    }

    fn text(id: &str) -> TextObject {
        match serde_json::from_value::<SceneObject>(serde_json::json!({
            "type": "text", "id": id, "name": id, "text": "Hello", "fontId": "font", "size": 40.0
        }))
        .expect("a minimal text object parses")
        {
            SceneObject::Text(text) => text,
            _ => unreachable!(),
        }
    }

    fn refused(objects: Vec<SceneObject>) -> Option<Refusal> {
        refuse_what_the_software_path_cannot_draw(&document(objects)).err()
    }

    fn property_of(refusal: Option<Refusal>) -> Option<String> {
        match refusal {
            Some(Refusal::ScenePropertyNotDrawable { property, .. }) => Some(property),
            _ => None,
        }
    }

    #[test]
    fn defaults_draw_and_pass() {
        assert_eq!(refused(vec![rect("r"), SceneObject::Text(text("t"))]), None);
    }

    #[test]
    fn kinds_the_software_path_cannot_draw_refuse_with_their_owner() {
        let image = SceneObject::Image(ImageObject {
            base: ObjectBase::new("logo", "logo"),
            asset_id: "a".into(),
            fit: Default::default(),
        });
        assert!(matches!(
            refused(vec![image]),
            Some(Refusal::ObjectKindNotDrawable { object, kind, owner }) if object == "logo" && kind == "image" && owner == "3.17"
        ));
    }

    #[test]
    fn every_text_property_the_path_ignores_refuses_by_name() {
        let cases: Vec<(&str, Box<dyn Fn(&mut TextObject)>)> = vec![
            ("autoFit", Box::new(|t| t.auto_fit = TextAutoFit::Shrink)),
            ("writingMode", Box::new(|t| t.writing_mode = WritingMode::VerticalRl)),
            ("verticalAlign", Box::new(|t| t.vertical_align = VerticalAlign::Middle)),
            ("decoration", Box::new(|t| t.decoration.underline = true)),
            ("overflow", Box::new(|t| t.overflow = TextOverflow::Clip)),
            ("textCase", Box::new(|t| t.text_case = TextCase::SmallCaps)),
            ("wordSpacing", Box::new(|t| t.word_spacing = 4.0)),
            ("paragraphSpacing", Box::new(|t| t.paragraph_spacing = 4.0)),
            ("textIndent", Box::new(|t| t.text_indent = 12.0)),
            ("point text align", Box::new(|t| t.align = TextAlign::Center)),
            ("stroke", Box::new(|t| {
                t.base.stroke = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 0.0, 0.0, 1.0) });
                t.base.stroke_width = 2.0;
            })),
        ];
        for (name, set) in cases {
            let mut object = text("t");
            set(&mut object);
            assert_eq!(property_of(refused(vec![SceneObject::Text(object)])).as_deref(), Some(name));
        }
    }

    #[test]
    fn three_d_layer_and_material_properties_on_2d_objects_refuse() {
        for (name, set) in [
            ("rotationX", Box::new(|b: &mut ObjectBase| b.rotation_x = 10.0) as Box<dyn Fn(&mut ObjectBase)>),
            ("rotationY", Box::new(|b: &mut ObjectBase| b.rotation_y = 10.0)),
            ("scaleZ", Box::new(|b: &mut ObjectBase| b.scale_z = 2.0)),
            ("zDepth", Box::new(|b: &mut ObjectBase| b.z_depth = 5.0)),
            ("layerId", Box::new(|b: &mut ObjectBase| b.layer_id = "layer".into())),
            ("materialSlots", Box::new(|b: &mut ObjectBase| {
                b.material_slots = Some(std::collections::BTreeMap::from([(
                    "fill".to_string(),
                    crate::material::MaterialBinding::new("m"),
                )]));
            })),
        ] {
            let mut base = ObjectBase::new("r", "r");
            set(&mut base);
            let object = SceneObject::Rect(RectObject { base, radius: 0.0 });
            assert_eq!(property_of(refused(vec![object])).as_deref(), Some(name));
        }
    }

    #[test]
    fn a_rotation_under_a_non_uniform_parent_refuses_but_the_reverse_draws() {
        let mut group = GroupObject { base: ObjectBase::new("g", "g"), child_ids: vec!["r".into()] };
        group.base.scale_x = 2.0;
        let mut child = ObjectBase::new("r", "r");
        child.rotation = 30.0;
        let sheared = vec![SceneObject::Group(group.clone()), SceneObject::Rect(RectObject { base: child.clone(), radius: 0.0 })];
        assert_eq!(
            property_of(refused(sheared)).as_deref(),
            Some("rotation under a non-uniformly scaled parent")
        );

        // A rotated parent over a non-uniformly scaled child composes exactly.
        group.base.scale_x = 1.0;
        group.base.rotation = 30.0;
        child.rotation = 0.0;
        child.scale_x = 2.0;
        let exact = vec![SceneObject::Group(group), SceneObject::Rect(RectObject { base: child, radius: 0.0 })];
        assert_eq!(refused(exact), None);
    }

    #[test]
    fn channels_the_path_cannot_follow_refuse() {
        let mut scene = document(vec![rect("r")]);
        scene.timeline.channels.push(KeyframeChannel {
            object_id: "r".into(),
            property: "rotationX".into(),
            keys: Vec::new(),
        });
        assert_eq!(
            property_of(refuse_what_the_software_path_cannot_draw(&scene).err()).as_deref(),
            Some("animated rotationX")
        );
    }

    fn animated(object_id: &str, property: &str) -> KeyframeChannel {
        KeyframeChannel {
            object_id: object_id.into(), property: property.into(),
            keys: vec![crate::animation::SceneKeyframe {
                frame: 1, value: 30.0, easing: Default::default(), bezier: None,
            }],
        }
    }

    #[test]
    fn animation_cannot_introduce_a_shear_after_publish() {
        let mut group = GroupObject { base: ObjectBase::new("g", "g"), child_ids: vec!["r".into()] };
        group.base.scale_x = 2.0;
        let mut scene = document(vec![SceneObject::Group(group), rect("r")]);
        scene.timeline.channels.push(animated("r", "rotation"));
        assert_eq!(property_of(refuse_what_the_software_path_cannot_draw(&scene).err()).as_deref(),
            Some("animated rotation under a scaled parent"));
        scene.objects[0].base_mut().scale_x = 1.0;
        assert!(refuse_what_the_software_path_cannot_draw(&scene).is_ok(), "rotation under uniform scale draws");
        scene.timeline.channels.push(animated("g", "scaleX"));
        assert_eq!(property_of(refuse_what_the_software_path_cannot_draw(&scene).err()).as_deref(),
            Some("animated rotation under a scaled parent"));
    }

    #[test]
    fn strokes_cannot_silently_keep_their_width_under_scale() {
        let mut object = rect("r");
        object.base_mut().stroke = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0) });
        object.base_mut().stroke_width = 10.0;
        object.base_mut().scale_x = 2.0;
        assert_eq!(property_of(refused(vec![object.clone()])).as_deref(), Some("scaled strokeWidth"));
        object.base_mut().scale_x = 1.0;
        let mut scene = document(vec![object]);
        assert!(refuse_what_the_software_path_cannot_draw(&scene).is_ok());
        scene.timeline.channels.push(animated("r", "scaleY"));
        assert_eq!(property_of(refuse_what_the_software_path_cannot_draw(&scene).err()).as_deref(), Some("scaled strokeWidth"));
    }

    #[test]
    fn invalid_text_metrics_and_opacity_refuse_instead_of_being_clamped() {
        for (name, edit) in [
            ("size", Box::new(|t: &mut TextObject| t.size = 0.0) as Box<dyn Fn(&mut TextObject)>),
            ("lineHeight", Box::new(|t: &mut TextObject| t.line_height = Some(-1.0))),
            ("letterSpacing", Box::new(|t: &mut TextObject| t.letter_spacing = f64::INFINITY)),
            ("opacity", Box::new(|t: &mut TextObject| t.base.opacity = 2.0)),
        ] {
            let mut object = text("t");
            edit(&mut object);
            assert_eq!(property_of(refused(vec![SceneObject::Text(object)])).as_deref(), Some(name));
        }
    }

    fn gradient() -> ColorValue {
        ColorValue::LinearGradient {
            angle: 0.0,
            start_x: 0.0,
            start_y: 0.0,
            end_x: 1.0,
            end_y: 0.0,
            stops: Vec::new(),
            spread: Default::default(),
            coordinate_mode: Default::default(),
        }
    }

    #[test]
    fn gradients_on_drawn_paints_refuse_by_paint_even_when_hidden() {
        let mut fill = rect("r");
        fill.base_mut().fill = Some(gradient());
        fill.base_mut().visible = false;
        assert_eq!(
            refused(vec![fill]),
            Some(Refusal::UnsupportedPathGradient { object: "r".into(), paint: "fill".into() })
        );

        let mut stroke = rect("r");
        stroke.base_mut().stroke = Some(gradient());
        assert_eq!(
            refused(vec![stroke]),
            Some(Refusal::UnsupportedPathGradient { object: "r".into(), paint: "stroke".into() })
        );

        let mut title = text("t");
        title.base.fill = Some(gradient());
        assert_eq!(
            refused(vec![SceneObject::Text(title)]),
            Some(Refusal::UnsupportedPathGradient { object: "t".into(), paint: "text fill".into() })
        );

        // A shape whose fill is disabled never paints it, so it cannot refuse.
        let mut shape = shape(vec![Vec2 { x: 0.0, y: 0.0 }; 2]);
        shape.base.fill = Some(gradient());
        shape.fill_enabled = false;
        assert_eq!(refused(vec![SceneObject::Shape(shape)]), None);
    }

    fn shape(tangents: Vec<Vec2>) -> ShapeObject {
        ShapeObject {
            base: ObjectBase::new("s", "s"),
            path: BezierPath {
                closed: false,
                vertices: vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 10.0, y: 0.0 }],
                in_tangents: tangents.clone(),
                out_tangents: tangents,
            },
            compound_paths: None,
            fill_enabled: true,
            stroke_enabled: false,
            fill_rule: Default::default(),
            trim_start: None,
            trim_end: None,
            trim_offset: None,
        }
    }

    #[test]
    fn a_path_whose_tangents_do_not_match_its_vertices_refuses() {
        assert_eq!(refused(vec![SceneObject::Shape(shape(vec![Vec2 { x: 0.0, y: 0.0 }; 2]))]), None);
        assert_eq!(
            refused(vec![SceneObject::Shape(shape(vec![Vec2 { x: 0.0, y: 0.0 }]))]),
            Some(Refusal::VectorTessellationFailed {
                object: "s".into(),
                detail: "Bezier vertices and tangent arrays differ in length".into(),
            })
        );
    }

    #[test]
    fn every_undrawable_property_is_reported_with_its_field() {
        let mut object = text("t");
        object.decoration.underline = true;
        object.word_spacing = 4.0;
        object.base.opacity = 2.0;
        let found = drawability_refusals(&document(vec![rect("r"), SceneObject::Text(object)]));
        let fields: Vec<_> = found.iter().map(|refusal| refusal.field.as_deref().unwrap_or("")).collect();
        assert_eq!(fields, ["objects[1].opacity", "objects[1].decoration", "objects[1].wordSpacing"]);
        assert_eq!(found[0].given, serde_json::json!(2.0));
    }

    #[test]
    fn a_non_finite_value_is_reported_alone() {
        let mut object = rect("r");
        object.base_mut().opacity = f64::NAN;
        object.base_mut().layer_id = "layer".into();
        let found = drawability_refusals(&document(vec![object]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].field.as_deref(), Some("objects[0].opacity"));
    }

    fn light(id: &str) -> SceneObject {
        serde_json::from_value(serde_json::json!({
            "type": "light", "id": id, "name": id, "lightKind": "directional", "intensity": 1.0,
            "color": { "r": 1, "g": 1, "b": 1, "a": 1, "space": "srgb" }, "castShadow": false
        }))
        .expect("a minimal light parses")
    }

    #[test]
    fn a_light_with_nothing_to_light_refuses_by_its_id() {
        let scene = document(vec![rect("r"), light("key"), light("fill")]);
        assert_eq!(
            light_without_responsive_material(&scene),
            Err(Refusal::LightHasNoResponsiveMaterial { light_id: "key".into() })
        );
        let found = drawability_refusals(&scene);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].field.as_deref(), Some("objects[1].type"));
        assert!(light_without_responsive_material(&document(vec![rect("r")])).is_ok(), "no light, no rule");
    }

    #[test]
    fn a_mesh_bound_to_pbr_answers_the_light() {
        use crate::material::{MaterialBinding, MaterialDefinition, MaterialKind};
        let mut scene = document(vec![light("key")]);
        let mut mesh: SceneObject = serde_json::from_value(serde_json::json!({
            "type": "mesh", "id": "m", "name": "m", "meshKind": "cube", "depth": 1.0
        }))
        .expect("a minimal mesh parses");
        mesh.base_mut().material_slots =
            Some(std::collections::BTreeMap::from([("object".to_string(), MaterialBinding::new("lit"))]));
        scene.objects.push(mesh);
        scene.materials.push(MaterialDefinition {
            material_id: "lit".into(), name: "lit".into(), kind: MaterialKind::Pbr,
            color: ColorValue::opaque_white(), opacity: 1.0, blend_mode: Default::default(),
            alpha_mode: Default::default(), cull_mode: Default::default(), depth_mode: Default::default(),
            double_sided: false, textures: Vec::new(), shader_id: None,
        });
        assert!(light_without_responsive_material(&scene).is_ok());
        scene.materials[0].kind = MaterialKind::Unlit;
        assert!(light_without_responsive_material(&scene).is_err(), "unlit material does not respond");
    }
}
