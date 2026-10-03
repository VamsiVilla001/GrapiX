//! Declared template controls (build plan 11.26).
//!
//! A template's controls are an explicit, typed handoff from its author to an
//! operator.  The allow-list lives here with the setters so every caller
//! exposes and applies the same contract (invariant 27), and a failed edit
//! leaves the authored template unchanged.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::color::ColorValue;
use crate::scene::{SceneDocument, SceneObject};
use crate::Refusal;

/// The kind of value an operator may enter for a declared field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ControlFieldKind {
    Text,
    Number,
    Color,
    Boolean,
    Asset,
}

impl ControlFieldKind {
    const fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Color => "color",
            Self::Boolean => "boolean",
            Self::Asset => "asset",
        }
    }
}

/// A typed value supplied to a declared control field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ControlValue {
    Text(String),
    Number(f64),
    Color(ColorValue),
    Boolean(bool),
    Asset(String),
}

impl ControlValue {
    const fn kind(&self) -> ControlFieldKind {
        match self {
            Self::Text(_) => ControlFieldKind::Text,
            Self::Number(_) => ControlFieldKind::Number,
            Self::Color(_) => ControlFieldKind::Color,
            Self::Boolean(_) => ControlFieldKind::Boolean,
            Self::Asset(_) => ControlFieldKind::Asset,
        }
    }
}

/// One named property an operator is allowed to fill on a template.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ControlField {
    pub field_id: String,
    pub label: String,
    pub object_id: String,
    pub property: String,
    pub kind: ControlFieldKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub default: Option<ControlValue>,
}

/// A saved operator-filled instance of a template.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TakePage {
    pub page_id: String,
    pub name: String,
    pub scene_id: String,
    #[serde(default)]
    pub values: BTreeMap<String, ControlValue>,
}

const BASE_PROPERTIES: &[(&str, ControlFieldKind)] = &[
    ("x", ControlFieldKind::Number),
    ("y", ControlFieldKind::Number),
    ("zDepth", ControlFieldKind::Number),
    ("rotation", ControlFieldKind::Number),
    ("rotationX", ControlFieldKind::Number),
    ("rotationY", ControlFieldKind::Number),
    ("scaleX", ControlFieldKind::Number),
    ("scaleY", ControlFieldKind::Number),
    ("scaleZ", ControlFieldKind::Number),
    ("width", ControlFieldKind::Number),
    ("height", ControlFieldKind::Number),
    ("opacity", ControlFieldKind::Number),
    ("visible", ControlFieldKind::Boolean),
    ("fill", ControlFieldKind::Color),
    ("stroke", ControlFieldKind::Color),
];

const TEXT_PROPERTIES: &[(&str, ControlFieldKind)] = &[
    ("text", ControlFieldKind::Text),
    ("x", ControlFieldKind::Number),
    ("y", ControlFieldKind::Number),
    ("zDepth", ControlFieldKind::Number),
    ("rotation", ControlFieldKind::Number),
    ("rotationX", ControlFieldKind::Number),
    ("rotationY", ControlFieldKind::Number),
    ("scaleX", ControlFieldKind::Number),
    ("scaleY", ControlFieldKind::Number),
    ("scaleZ", ControlFieldKind::Number),
    ("width", ControlFieldKind::Number),
    ("height", ControlFieldKind::Number),
    ("opacity", ControlFieldKind::Number),
    ("visible", ControlFieldKind::Boolean),
    ("fill", ControlFieldKind::Color),
    ("stroke", ControlFieldKind::Color),
];

const IMAGE_PROPERTIES: &[(&str, ControlFieldKind)] = &[
    ("assetId", ControlFieldKind::Asset),
    ("x", ControlFieldKind::Number),
    ("y", ControlFieldKind::Number),
    ("zDepth", ControlFieldKind::Number),
    ("rotation", ControlFieldKind::Number),
    ("rotationX", ControlFieldKind::Number),
    ("rotationY", ControlFieldKind::Number),
    ("scaleX", ControlFieldKind::Number),
    ("scaleY", ControlFieldKind::Number),
    ("scaleZ", ControlFieldKind::Number),
    ("width", ControlFieldKind::Number),
    ("height", ControlFieldKind::Number),
    ("opacity", ControlFieldKind::Number),
    ("visible", ControlFieldKind::Boolean),
    ("fill", ControlFieldKind::Color),
    ("stroke", ControlFieldKind::Color),
];

/// Properties a template may declare for an object kind.
///
/// The returned list is also the implementation's setter vocabulary.  Unknown
/// kinds deliberately expose nothing: an editor must report an unavailable
/// target rather than offer a control the renderer cannot honour.
pub fn fillable_properties(kind: &str) -> &'static [(&'static str, ControlFieldKind)] {
    match kind {
        "text" => TEXT_PROPERTIES,
        "image" => IMAGE_PROPERTIES,
        "rect" | "ellipse" | "line" | "shape" | "paint" | "mesh" | "light" | "camera"
        | "layer" | "marker" | "group" => BASE_PROPERTIES,
        _ => &[],
    }
}

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

fn target<'a>(scene: &'a SceneDocument, object_id: &str, property: &str) -> Result<&'a SceneObject, Refusal> {
    refuse_duplicate_object_ids(scene)?;
    let object = scene.objects.iter().find(|object| object.base().id == object_id);
    match object {
        Some(object)
            if fillable_properties(object.kind())
                .iter()
                .any(|(fillable, _)| *fillable == property) => Ok(object),
        _ => Err(Refusal::ControlFieldTargetUnknown {
            object_id: object_id.to_owned(),
            property: property.to_owned(),
        }),
    }
}

fn expected_kind(scene: &SceneDocument, field: &ControlField) -> Result<ControlFieldKind, Refusal> {
    target(scene, &field.object_id, &field.property)?;
    fillable_properties(
        scene
            .objects
            .iter()
            .find(|object| object.base().id == field.object_id)
            .expect("target lookup already established the object exists")
            .kind(),
    )
    .iter()
    .find_map(|(property, kind)| (*property == field.property).then_some(*kind))
    .ok_or_else(|| Refusal::ControlFieldTargetUnknown {
        object_id: field.object_id.clone(),
        property: field.property.clone(),
    })
}

/// Declare one field after proving its target belongs to the control vocabulary.
///
/// Validation precedes the append, so a refusal cannot leave a half-authored
/// control contract on the scene.
pub fn declare_control_field(scene: &mut SceneDocument, field: ControlField) -> Result<(), Refusal> {
    let target_kind = expected_kind(scene, &field)?;
    if target_kind != field.kind {
        return Err(Refusal::ControlFieldTargetUnknown {
            object_id: field.object_id,
            property: field.property,
        });
    }
    if let Some(default) = &field.default {
        if default.kind() != field.kind {
            return Err(Refusal::ControlValueTypeMismatch {
                field_id: field.field_id,
                expected: field.kind.name().to_owned(),
                actual: default.kind().name().to_owned(),
            });
        }
    }
    if scene.controls.iter().any(|existing| existing.field_id == field.field_id) {
        return Err(Refusal::ControlFieldDuplicate {
            field_id: field.field_id,
        });
    }
    scene.controls.push(field);
    Ok(())
}
/// Validate a control contract loaded from a scene document.
///
/// Authoring operations already prevent these states, but a hand-written or
/// older document can bypass those operations. The render node runs this at
/// publish so an ambiguous operator contract never reaches Program.
pub fn validate_control_fields(scene: &SceneDocument) -> Result<(), Refusal> {
    refuse_duplicate_object_ids(scene)?;
    let mut ids = BTreeSet::new();
    for field in &scene.controls {
        if !ids.insert(field.field_id.as_str()) {
            return Err(Refusal::ControlFieldDuplicate {
                field_id: field.field_id.clone(),
            });
        }
        let expected = expected_kind(scene, field)?;
        if expected != field.kind {
            return Err(Refusal::ControlFieldTargetUnknown {
                object_id: field.object_id.clone(),
                property: field.property.clone(),
            });
        }
        if let Some(default) = &field.default {
            if default.kind() != field.kind {
                return Err(Refusal::ControlValueTypeMismatch {
                    field_id: field.field_id.clone(),
                    expected: field.kind.name().to_owned(),
                    actual: default.kind().name().to_owned(),
                });
            }
        }
    }
    Ok(())
}

/// Remove the named field; absent fields are explicit authoring errors.
pub fn remove_control_field(scene: &mut SceneDocument, field_id: &str) -> Result<(), Refusal> {
    let index = scene
        .controls
        .iter()
        .position(|field| field.field_id == field_id)
        .ok_or_else(|| Refusal::ControlFieldUnknown {
            field_id: field_id.to_owned(),
        })?;
    scene.controls.remove(index);
    Ok(())
}
/// Replace an existing declared field after validating the replacement against
/// the scene's current control vocabulary.
///
/// Replacement keeps its address stable: changing `field_id` is not an update
/// of an existing control and is therefore refused as unknown.
pub fn replace_control_field(scene: &mut SceneDocument, field: ControlField) -> Result<(), Refusal> {
    let index = scene
        .controls
        .iter()
        .position(|existing| existing.field_id == field.field_id)
        .ok_or_else(|| Refusal::ControlFieldUnknown {
            field_id: field.field_id.clone(),
        })?;

    let target_kind = expected_kind(scene, &field)?;
    if target_kind != field.kind {
        return Err(Refusal::ControlFieldTargetUnknown {
            object_id: field.object_id,
            property: field.property,
        });
    }
    if let Some(default) = &field.default {
        if default.kind() != field.kind {
            return Err(Refusal::ControlValueTypeMismatch {
                field_id: field.field_id,
                expected: field.kind.name().to_owned(),
                actual: default.kind().name().to_owned(),
            });
        }
    }

    scene.controls[index] = field;
    Ok(())
}


fn set_value(object: &mut SceneObject, property: &str, value: ControlValue) {
    match (property, value) {
        ("text", ControlValue::Text(value)) => {
            if let SceneObject::Text(text) = object {
                text.text = value;
            }
        }
        ("assetId", ControlValue::Asset(value)) => {
            if let SceneObject::Image(image) = object {
                image.asset_id = value;
            }
        }
        ("fill", ControlValue::Color(value)) => object.base_mut().fill = Some(value),
        ("stroke", ControlValue::Color(value)) => object.base_mut().stroke = Some(value),
        ("visible", ControlValue::Boolean(value)) => object.base_mut().visible = value,
        ("x", ControlValue::Number(value)) => object.base_mut().x = value,
        ("y", ControlValue::Number(value)) => object.base_mut().y = value,
        ("zDepth", ControlValue::Number(value)) => object.base_mut().z_depth = value,
        ("rotation", ControlValue::Number(value)) => object.base_mut().rotation = value,
        ("rotationX", ControlValue::Number(value)) => object.base_mut().rotation_x = value,
        ("rotationY", ControlValue::Number(value)) => object.base_mut().rotation_y = value,
        ("scaleX", ControlValue::Number(value)) => object.base_mut().scale_x = value,
        ("scaleY", ControlValue::Number(value)) => object.base_mut().scale_y = value,
        ("scaleZ", ControlValue::Number(value)) => object.base_mut().scale_z = value,
        ("width", ControlValue::Number(value)) => object.base_mut().width = value,
        ("height", ControlValue::Number(value)) => object.base_mut().height = value,
        ("opacity", ControlValue::Number(value)) => object.base_mut().opacity = value,
        // `expected_kind` validates this closed vocabulary before a setter is
        // reached. An unmatched pair is therefore an implementation error, not
        // a user value to silently discard.
        _ => unreachable!("validated control value did not match its setter"),
    }
}

/// Fill declared controls into a clone of the template.
///
/// Every supplied value is checked before the clone is changed, so failed page
/// values cannot mutate either the source template or the returned scene.
pub fn apply_control_values(
    scene: &SceneDocument,
    values: &BTreeMap<String, ControlValue>,
) -> Result<SceneDocument, Refusal> {
    for (field_id, value) in values {
        let field = scene
            .controls
            .iter()
            .find(|field| field.field_id == *field_id)
            .ok_or_else(|| Refusal::ControlFieldUnknown {
                field_id: field_id.clone(),
            })?;
        let expected = expected_kind(scene, field)?;
        if expected != field.kind || value.kind() != field.kind {
            return Err(Refusal::ControlValueTypeMismatch {
                field_id: field_id.clone(),
                expected: field.kind.name().to_owned(),
                actual: value.kind().name().to_owned(),
            });
        }
    }

    let mut filled = scene.clone();
    for (field_id, value) in values {
        let field = filled
            .controls
            .iter()
            .find(|field| field.field_id == *field_id)
            .expect("all fields were validated before the clone was edited");
        let object = filled
            .objects
            .iter_mut()
            .find(|object| object.base().id == field.object_id)
            .expect("field target was validated before the clone was edited");
        set_value(object, &field.property, value.clone());
    }
    Ok(filled)
}
/// Apply one saved page to the template it names.
///
/// Matching only field ids is insufficient: unrelated templates routinely use
/// names such as `headline`. The scene pin is checked before any value is
/// applied, and `apply_control_values` returns a clone, so both failure and
/// success leave the authored template unchanged.
pub fn apply_take_page(scene: &SceneDocument, page: &TakePage) -> Result<SceneDocument, Refusal> {
    if page.scene_id != scene.id {
        return Err(Refusal::TakePageSceneMismatch {
            page_id: page.page_id.clone(),
            expected: scene.id.clone(),
            actual: page.scene_id.clone(),
        });
    }
    validate_control_fields(scene)?;
    apply_control_values(scene, &page.values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{ObjectBase, RectObject, SceneCanvas, SceneTimeline, TextObject};
    use crate::RationalRate;

    fn scene() -> SceneDocument {
        SceneDocument {
            id: "template".into(),
            name: "Template".into(),
            version: 1,
            revision: None,
            active_camera_id: None,
            canvas: SceneCanvas { width: 1920, height: 1080, frame_rate: RationalRate::P50 },
            timeline: SceneTimeline { duration_frames: 1, channels: Vec::new(), phases: Vec::new() },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects: vec![
                SceneObject::Text(TextObject {
                    base: ObjectBase::new("headline", "Headline"),
                    text: "Before".into(),
                    font_id: "font".into(),
                    size: 32.0,
                    layout: Default::default(), auto_fit: Default::default(), writing_mode: Default::default(),
                    vertical_align: Default::default(), direction: Default::default(), text_case: Default::default(),
                    decoration: Default::default(), overflow: Default::default(), align: Default::default(),
                    line_height: None, letter_spacing: 0.0, word_spacing: 0.0, paragraph_spacing: 0.0, text_indent: 0.0,
                }),
                SceneObject::Rect(RectObject { base: ObjectBase::new("card", "Card"), radius: 0.0 }),
            ],
        }
    }

    fn field(id: &str, property: &str, kind: ControlFieldKind) -> ControlField {
        ControlField { field_id: id.into(), label: id.into(), object_id: "headline".into(), property: property.into(), kind, default: None }
    }

    #[test]
    fn non_fillable_property_refuses_by_name_without_declaring_it() {
        let mut document = scene();
        let refused = declare_control_field(&mut document, field("font", "fontId", ControlFieldKind::Text));
        assert!(matches!(refused, Err(Refusal::ControlFieldTargetUnknown { object_id, property }) if object_id == "headline" && property == "fontId"));
        assert!(document.controls.is_empty());
    }

    #[test]
    fn duplicate_field_id_refuses_without_changing_the_contract() {
        let mut document = scene();
        declare_control_field(&mut document, field("headline", "text", ControlFieldKind::Text)).unwrap();
        let refused = declare_control_field(&mut document, field("headline", "x", ControlFieldKind::Number));
        assert!(matches!(refused, Err(Refusal::ControlFieldDuplicate { field_id }) if field_id == "headline"));
        assert_eq!(document.controls.len(), 1);
    }

    #[test]
    fn applying_values_returns_a_filled_copy_and_leaves_template_untouched() {
        let mut document = scene();
        declare_control_field(&mut document, field("headline", "text", ControlFieldKind::Text)).unwrap();
        let values = BTreeMap::from([("headline".into(), ControlValue::Text("After".into()))]);
        let filled = apply_control_values(&document, &values).unwrap();
        assert!(matches!(&document.objects[0], SceneObject::Text(text) if text.text == "Before"));
        assert!(matches!(&filled.objects[0], SceneObject::Text(text) if text.text == "After"));
    }

    #[test]
    fn wrong_value_type_names_expected_and_actual() {
        let mut document = scene();
        declare_control_field(&mut document, field("headline", "text", ControlFieldKind::Text)).unwrap();
        let values = BTreeMap::from([("headline".into(), ControlValue::Number(42.0))]);
        assert!(matches!(apply_control_values(&document, &values), Err(Refusal::ControlValueTypeMismatch { field_id, expected, actual }) if field_id == "headline" && expected == "text" && actual == "number"));
    }

    #[test]
    fn a_scene_authored_before_controls_still_parses_with_an_empty_contract() {
        let mut raw = serde_json::to_value(scene()).unwrap();
        raw.as_object_mut()
            .expect("a scene serializes as an object")
            .remove("controls");
        let parsed = crate::scene::parse_scene_document(&serde_json::to_vec(&raw).unwrap()).unwrap();
        assert!(parsed.controls.is_empty());
    }
    #[test]
    fn a_take_page_is_pinned_to_its_template_before_values_are_applied() {
        let mut document = scene();
        declare_control_field(&mut document, field("headline", "text", ControlFieldKind::Text)).unwrap();
        let page = TakePage {
            page_id: "page-1".into(),
            name: "Wrong template".into(),
            scene_id: "other".into(),
            values: BTreeMap::from([("headline".into(), ControlValue::Text("After".into()))]),
        };
        let refused = apply_take_page(&document, &page);
        assert!(matches!(
            refused,
            Err(Refusal::TakePageSceneMismatch { page_id, expected, actual })
                if page_id == "page-1" && expected == "template" && actual == "other"
        ));
        assert!(matches!(&document.objects[0], SceneObject::Text(text) if text.text == "Before"));
    }

    #[test]
    fn a_loaded_duplicate_control_contract_refuses_at_validation() {
        let mut document = scene();
        let declared = field("headline", "text", ControlFieldKind::Text);
        document.controls = vec![declared.clone(), declared];
        assert!(matches!(
            validate_control_fields(&document),
            Err(Refusal::ControlFieldDuplicate { field_id }) if field_id == "headline"
        ));
    }

}
