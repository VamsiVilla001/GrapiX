//! What the software reference path cannot draw yet, refused by name (3.13).
//!
//! Invariant 18 forbids a fallback that changes pixels, so an authored kind or
//! property this engine would ignore refuses at publish instead of being
//! dropped. Every refusal names the object, the property and the build-plan
//! step that will draw it, so the answer is also the plan. A property refuses
//! only when it differs from its default: the default draws exactly what the
//! engine already draws.
//!
//! The list comes from the 13 October 2026 audit of every authored field
//! (`memory.md`). When a step lands, its check here is deleted with it.

use std::collections::HashMap;

use gx_contracts::color::ColorValue;
use gx_contracts::scene::{
    SceneDocument, SceneObject, TextAlign, TextAutoFit, TextCase, TextLayout, TextObject, TextOverflow,
    VerticalAlign, WritingMode,
};
use gx_contracts::Refusal;

/// Refuse the first authored kind or property this engine cannot draw.
pub fn refuse_what_the_software_path_cannot_draw(document: &SceneDocument) -> Result<(), Refusal> {
    if document.active_camera_id.is_some() {
        return Err(property(&document.id, "activeCameraId", "11.48"));
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
    let resolution = gx_contracts::scene::resolve_hierarchy(&document.objects);

    for (object_index, object) in document.objects.iter().enumerate() {
        let base = object.base();
        let id = base.id.as_str();
        for (name, value) in [
            ("x", base.x), ("y", base.y), ("width", base.width), ("height", base.height),
            ("rotation", base.rotation), ("rotationX", base.rotation_x),
            ("rotationY", base.rotation_y), ("scaleX", base.scale_x),
            ("scaleY", base.scale_y), ("scaleZ", base.scale_z),
            ("zDepth", base.z_depth), ("opacity", base.opacity),
            ("strokeWidth", base.stroke_width),
        ] {
            if !value.is_finite() {
                return Err(property(id, name, "3.13"));
            }
        }
        if !(0.0..=1.0).contains(&base.opacity) {
            return Err(property(id, "opacity", "3.13"));
        }
        if base.width < 0.0 || base.height < 0.0 || base.stroke_width < 0.0 {
            return Err(property(id, "negative dimensions or strokeWidth", "3.13"));
        }
        if base.anchor.is_some_and(|anchor| !anchor.x.is_finite() || !anchor.y.is_finite()) {
            return Err(property(id, "anchor", "3.13"));
        }
        match object {
            SceneObject::Rect(rect) if !rect.radius.is_finite() || rect.radius < 0.0 => {
                return Err(property(id, "radius", "3.13"));
            }
            SceneObject::Image(_) => return Err(kind(id, "image", "3.17")),
            SceneObject::Mesh(_) => return Err(kind(id, "mesh", "11.48")),
            SceneObject::Paint(_) => return Err(kind(id, "paint", "3.17")),
            SceneObject::Text(text) => text_properties(text)?,
            SceneObject::Line(line) if paints(&line.base.fill) => {
                return Err(property(id, "fill", "3.17"));
            }
            _ => {}
        }
        if base.material_slots.as_ref().is_some_and(|slots| !slots.is_empty()) {
            return Err(property(id, "materialSlots", "11.50"));
        }
        for (name, set) in [
            ("rotationX", base.rotation_x != 0.0),
            ("rotationY", base.rotation_y != 0.0),
            ("scaleZ", base.scale_z != 1.0),
            ("zDepth", base.z_depth != 0.0),
        ] {
            if set {
                return Err(property(id, name, "11.48"));
            }
        }
        if !base.layer_id.is_empty() {
            return Err(property(id, "layerId", "3.16"));
        }
        if shears(id, &parents, &by_id) {
            return Err(property(id, "rotation under a non-uniformly scaled parent", "3.16"));
        }
        // Strokes are tessellated after the centreline is transformed. Their
        // width therefore cannot follow a scaled object or parent yet.
        if has_stroke(object) {
            let transform = &resolution.effective[object_index];
            if transform.scale_x.abs() != 1.0 || transform.scale_y.abs() != 1.0
                || chain(id, &parents).iter().any(|ancestor| {
                    document.timeline.channels.iter().any(|channel| {
                        channel.object_id == *ancestor && !channel.keys.is_empty()
                            && matches!(channel.property.as_str(), "scaleX" | "scaleY")
                    })
                })
            {
                return Err(property(id, "scaled strokeWidth", "3.17"));
            }
        }
        let ancestors = chain(id, &parents);
        for (index, ancestor) in ancestors.iter().enumerate() {
            let rotates = by_id.get(ancestor).is_some_and(|o| o.base().rotation.rem_euclid(360.0) != 0.0)
                || document.timeline.channels.iter().any(|channel| {
                    channel.object_id == *ancestor && channel.property == "rotation" && !channel.keys.is_empty()
                });
            if rotates && ancestors[index + 1..].iter().any(|parent| {
                by_id.get(parent).is_some_and(|o| o.base().scale_x != o.base().scale_y)
                    || document.timeline.channels.iter().any(|channel| {
                        channel.object_id == *parent && !channel.keys.is_empty()
                            && matches!(channel.property.as_str(), "scaleX" | "scaleY")
                    })
            }) {
                return Err(property(id, "animated rotation under a scaled parent", "3.16"));
            }
        }
    }

    for channel in &document.timeline.channels {
        let owner = match channel.property.as_str() {
            "rotationX" | "rotationY" | "scaleZ" | "zDepth" => Some("11.48"),
            "width" | "height" => match by_id.get(channel.object_id.as_str()) {
                Some(SceneObject::Text(text)) if text.layout == TextLayout::Paragraph => Some("11.51"),
                _ => None,
            },
            _ => None,
        };
        if let Some(owner) = owner {
            return Err(property(&channel.object_id, &format!("animated {}", channel.property), owner));
        }
    }
    Ok(())
}

fn text_properties(text: &TextObject) -> Result<(), Refusal> {
    let id = text.base.id.as_str();
    if text.line_height.is_some_and(|height| !(height * text.size).is_finite()
        || height * text.size > f64::from(f32::MAX)) {
        return Err(property(id, "lineHeight", "3.13"));
    }
    for (name, value, positive) in [
        ("size", text.size, true),
        ("lineHeight", text.line_height.unwrap_or(1.0), true),
        ("letterSpacing", text.letter_spacing, false),
    ] {
        if !value.is_finite() || (positive && value <= 0.0) || value.abs() > f64::from(f32::MAX) {
            return Err(property(id, name, "3.13"));
        }
    }
    for (name, set, owner) in [
        ("autoFit", text.auto_fit != TextAutoFit::None, "11.51"),
        ("writingMode", text.writing_mode != WritingMode::HorizontalTb, "11.51"),
        ("verticalAlign", text.vertical_align != VerticalAlign::Top, "3.18"),
        ("decoration", text.decoration.underline || text.decoration.strikethrough, "3.18"),
        ("overflow", text.overflow != TextOverflow::Visible, "3.18"),
        ("textCase", text.text_case == TextCase::SmallCaps, "11.51"),
        ("wordSpacing", text.word_spacing != 0.0, "11.51"),
        ("paragraphSpacing", text.paragraph_spacing != 0.0, "11.51"),
        ("textIndent", text.text_indent != 0.0, "11.51"),
        ("stroke", paints(&text.base.stroke) && text.base.stroke_width > 0.0, "3.18"),
        ("point text align", text.layout == TextLayout::Point && text.align != TextAlign::Left, "3.18"),
    ] {
        if set {
            return Err(property(id, name, owner));
        }
    }
    Ok(())
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
    use gx_contracts::animation::KeyframeChannel;
    use gx_contracts::color::{ColorValue, Rgba, WorkingColorSpace};
    use gx_contracts::scene::{
        GroupObject, ImageObject, ObjectBase, RectObject, SceneCanvas, SceneTimeline,
    };
    use gx_contracts::RationalRate;

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        let mut scene = gx_contracts::scene::new_scene("scene", "Scene", WorkingColorSpace::Srgb);
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
                    gx_contracts::material::MaterialBinding::new("m"),
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
            keys: vec![gx_contracts::animation::SceneKeyframe {
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
}
