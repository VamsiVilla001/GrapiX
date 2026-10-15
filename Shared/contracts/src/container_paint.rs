//! Containers carry no paint (3.13).
//!
//! A Group or Layer only arranges its children: neither the software path
//! nor any planned renderer draws a container's own fill or stroke. An
//! authored one would be data that silently changes nothing on air, so it
//! refuses by object and property instead. Absent and `none` paints are the
//! defaults and pass; `strokeWidth` alone paints nothing and passes.

use crate::color::ColorValue;
use crate::drawability::Found;
use crate::scene::SceneObject;
use crate::Refusal;

/// Refuse a painted fill or stroke on a Group or Layer.
pub(crate) fn container_paints(object: &SceneObject, at: &dyn Fn(&str) -> String, found: &mut Found) {
    if !object.is_container() {
        return;
    }
    let base = object.base();
    for (property, paint) in [("fill", &base.fill), ("stroke", &base.stroke)] {
        if !matches!(paint, None | Some(ColorValue::None)) {
            found.push(
                Refusal::ScenePropertyNotDrawable {
                    object: base.id.clone(),
                    property: property.into(),
                    owner: "3.13".into(),
                },
                at(property),
                serde_json::to_value(paint).unwrap_or_default(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::color::{ColorValue, Rgba, WorkingColorSpace};
    use crate::drawability::drawability_refusals;
    use crate::scene::{GroupObject, ObjectBase, RectObject, SceneObject};
    use crate::Refusal;

    fn refused(object: SceneObject) -> Vec<(Refusal, Option<String>)> {
        let mut scene = crate::scene::new_scene("scene", "Scene", WorkingColorSpace::Srgb);
        scene.objects.push(object);
        drawability_refusals(&scene).into_iter().map(|refusal| (refusal.code, refusal.field)).collect()
    }

    fn solid() -> Option<ColorValue> {
        Some(ColorValue::Solid { color: Rgba::srgb(1.0, 0.0, 0.0, 1.0) })
    }

    fn layer(id: &str) -> SceneObject {
        serde_json::from_value(serde_json::json!({
            "type": "layer", "id": id, "name": id, "layerKind": "object", "childIds": []
        }))
        .expect("a minimal layer parses")
    }

    fn not_drawable(object: &str, property: &str) -> Refusal {
        Refusal::ScenePropertyNotDrawable { object: object.into(), property: property.into(), owner: "3.13".into() }
    }

    #[test]
    fn a_painted_container_refuses_by_object_and_property() {
        let group = || SceneObject::Group(GroupObject { base: ObjectBase::new("g", "g"), child_ids: Vec::new() });

        let mut fill = group();
        fill.base_mut().fill = solid();
        assert_eq!(refused(fill), [(not_drawable("g", "fill"), Some("objects[0].fill".into()))]);

        let mut stroke = group();
        stroke.base_mut().stroke = solid();
        assert_eq!(refused(stroke), [(not_drawable("g", "stroke"), Some("objects[0].stroke".into()))]);

        let mut fill = layer("l");
        fill.base_mut().fill = solid();
        assert_eq!(refused(fill), [(not_drawable("l", "fill"), Some("objects[0].fill".into()))]);

        let mut stroke = layer("l");
        stroke.base_mut().stroke = solid();
        stroke.base_mut().stroke_width = 0.0;
        assert_eq!(refused(stroke), [(not_drawable("l", "stroke"), Some("objects[0].stroke".into()))]);
    }

    #[test]
    fn default_container_paints_and_painting_shapes_pass() {
        let mut none = SceneObject::Group(GroupObject { base: ObjectBase::new("g", "g"), child_ids: Vec::new() });
        none.base_mut().fill = Some(ColorValue::None);
        none.base_mut().stroke_width = 3.0;
        assert_eq!(refused(none), []);
        assert_eq!(refused(layer("l")), []);

        let mut rect = SceneObject::Rect(RectObject { base: ObjectBase::new("r", "r"), radius: 0.0 });
        rect.base_mut().fill = solid();
        rect.base_mut().stroke = solid();
        rect.base_mut().stroke_width = 2.0;
        assert_eq!(refused(rect), []);
    }
}
