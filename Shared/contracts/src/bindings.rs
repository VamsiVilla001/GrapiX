//! Binding authoring and data-context replacement rules (11.36).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::scene::{AssetKind, DataContext, SceneDocument, SceneObject};
use crate::Refusal;

/// A binding which is invalid against a data context. Invalid bindings remain
/// authored; replacing data reports them rather than silently deleting work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BindingIssue {
    pub object_id: String,
    pub property: String,
    pub path: String,
    pub detail: String,
}

#[derive(Clone, Copy)]
struct BindableProperty {
    key: &'static str,
    expected: &'static str,
    applies_to: Option<&'static [&'static str]>,
    constraint: Option<&'static str>,
}

const TEXT: BindableProperty = BindableProperty {
    key: "text",
    expected: "string",
    applies_to: Some(&["text"]),
    constraint: None,
};
const ASSET_ID: BindableProperty = BindableProperty {
    key: "assetId",
    expected: "string",
    applies_to: Some(&["image"]),
    constraint: None,
};
const X: BindableProperty = BindableProperty {
    key: "x",
    expected: "number",
    applies_to: None,
    constraint: None,
};
const Y: BindableProperty = BindableProperty {
    key: "y",
    expected: "number",
    applies_to: None,
    constraint: None,
};
const Z_DEPTH: BindableProperty = BindableProperty {
    key: "zDepth",
    expected: "number",
    applies_to: None,
    constraint: None,
};
const ROTATION: BindableProperty = BindableProperty {
    key: "rotation",
    expected: "number",
    applies_to: None,
    constraint: None,
};
const ROTATION_X: BindableProperty = BindableProperty {
    key: "rotationX",
    expected: "number",
    applies_to: None,
    constraint: None,
};
const ROTATION_Y: BindableProperty = BindableProperty {
    key: "rotationY",
    expected: "number",
    applies_to: None,
    constraint: None,
};
const SCALE_X: BindableProperty = BindableProperty {
    key: "scaleX",
    expected: "number",
    applies_to: None,
    constraint: Some("non-zero"),
};
const SCALE_Y: BindableProperty = BindableProperty {
    key: "scaleY",
    expected: "number",
    applies_to: None,
    constraint: Some("non-zero"),
};
const SCALE_Z: BindableProperty = BindableProperty {
    key: "scaleZ",
    expected: "number",
    applies_to: None,
    constraint: Some("non-zero"),
};
const WIDTH: BindableProperty = BindableProperty {
    key: "width",
    expected: "number",
    applies_to: None,
    constraint: Some("zero or greater"),
};
const HEIGHT: BindableProperty = BindableProperty {
    key: "height",
    expected: "number",
    applies_to: None,
    constraint: Some("zero or greater"),
};
const OPACITY: BindableProperty = BindableProperty {
    key: "opacity",
    expected: "number",
    applies_to: None,
    constraint: Some("between 0 and 1"),
};
const VISIBLE: BindableProperty = BindableProperty {
    key: "visible",
    expected: "boolean",
    applies_to: None,
    constraint: None,
};
const BINDABLE: &[BindableProperty] = &[
    TEXT, ASSET_ID, X, Y, Z_DEPTH, ROTATION, ROTATION_X, ROTATION_Y, SCALE_X, SCALE_Y, SCALE_Z,
    WIDTH, HEIGHT, OPACITY, VISIBLE,
];

fn spec_for(object: &SceneObject, property: &str) -> Option<BindableProperty> {
    BINDABLE.iter().copied().find(|spec| {
        spec.key == property
            && spec
                .applies_to
                .is_none_or(|kinds| kinds.contains(&object.kind()))
    })
}

/// Add, replace, or remove one authored binding.
pub fn set_binding(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    path: Option<&str>,
) -> Result<(), Refusal> {
    let index = scene
        .objects
        .iter()
        .position(|object| object.base().id == object_id)
        .ok_or_else(|| Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        })?;
    let object = &scene.objects[index];
    let spec = spec_for(object, property).ok_or_else(|| Refusal::BindingPropertyUnsupported {
        object: object_id.to_owned(),
        kind: object.kind().to_owned(),
        property: property.to_owned(),
    })?;
    let previous = object
        .base()
        .bindings
        .as_ref()
        .and_then(|bindings| bindings.get(property));

    match path {
        None => {
            if previous.is_none() {
                return Err(Refusal::BindingNotBound {
                    object: object_id.to_owned(),
                    property: property.to_owned(),
                });
            }
            let bindings = scene.objects[index]
                .base_mut()
                .bindings
                .as_mut()
                .expect("existing binding map holds the binding");
            bindings.remove(property);
            if bindings.is_empty() {
                scene.objects[index].base_mut().bindings = None;
            }
        }
        Some(path) => {
            let value = resolve_path(&scene.data_context, path).map_err(|detail| {
                Refusal::BindingPathInvalid {
                    path: path.to_owned(),
                    detail,
                }
            })?;
            validate_value(scene, object, spec, path, value)?;
            if previous.and_then(Value::as_str) == Some(path) {
                return Err(Refusal::BindingUnchanged {
                    object: object_id.to_owned(),
                    property: property.to_owned(),
                    path: path.to_owned(),
                });
            }
            scene.objects[index]
                .base_mut()
                .bindings
                .get_or_insert_with(Default::default)
                .insert(property.to_owned(), Value::String(path.to_owned()));
        }
    }
    Ok(())
}

/// Replace live data and return bindings which were valid before the write but
/// no longer resolve afterwards.
pub fn replace_data_context(
    scene: &mut SceneDocument,
    data_context: DataContext,
) -> Result<Vec<BindingIssue>, Refusal> {
    // The TS rule compared `JSON.stringify` output, so a reordering of keys
    // the document would serialise differently is a change, not a no-op.
    if serde_json::to_string(&scene.data_context).ok() == serde_json::to_string(&data_context).ok()
    {
        return Err(Refusal::DataContextUnchanged);
    }
    let before = binding_issues(scene);
    scene.data_context = data_context;
    let after = binding_issues(scene);
    Ok(after
        .into_iter()
        .filter(|issue| {
            !before.iter().any(|previous| {
                previous.object_id == issue.object_id && previous.property == issue.property
            })
        })
        .collect())
}

/// Apply every binding against the scene's data context (3.13), as the
/// Editor's preview does (`Editor/src/bindings.ts` `resolveSceneBindings`):
/// strict and all-or-nothing. The first binding that cannot apply refuses by
/// name, rather than putting some bound values on air and leaving the rest at
/// their authored values. Before this the engine applied no binding at all.
pub fn resolve_scene_bindings(scene: &SceneDocument) -> Result<SceneDocument, Refusal> {
    let mut resolved = scene.clone();
    for object in &mut resolved.objects {
        let Some(bindings) = object.base().bindings.clone() else {
            continue;
        };
        if bindings.is_empty() {
            continue;
        }
        let mut wire = serde_json::to_value(&*object).map_err(|error| Refusal::BindingPathInvalid {
            path: object.base().id.clone(),
            detail: error.to_string(),
        })?;
        for (property, raw_path) in &bindings {
            let Some(path) = raw_path.as_str() else {
                return Err(Refusal::BindingPathInvalid {
                    path: raw_path.to_string(),
                    detail: format!("{property} binding on {} must be a string path", object.base().id),
                });
            };
            let Some(spec) = spec_for(object, property) else {
                return Err(Refusal::BindingPropertyUnsupported {
                    object: object.base().id.clone(),
                    kind: object.kind().to_owned(),
                    property: property.clone(),
                });
            };
            let value = resolve_path(&scene.data_context, path)
                .map_err(|detail| Refusal::BindingPathInvalid { path: path.to_owned(), detail })?;
            validate_value(scene, object, spec, path, value)?;
            if let Some(fields) = wire.as_object_mut() {
                fields.insert(property.clone(), value.clone());
            }
        }
        *object = serde_json::from_value(wire).map_err(|error| Refusal::BindingPathInvalid {
            path: object.base().id.clone(),
            detail: error.to_string(),
        })?;
    }
    Ok(resolved)
}

/// The value type a property's binding must resolve to (`"string"`,
/// `"number"` or `"boolean"`), or `None` when the property cannot be bound on
/// this object. The same table `set_binding` enforces, so a schema an agent
/// reads and the refusal it would get cannot disagree (invariant 27).
pub fn binding_expects(object: &SceneObject, property: &str) -> Option<&'static str> {
    spec_for(object, property).map(|spec| spec.expected)
}

/// Every authored binding that would not apply against the scene's current
/// data context, in document order: a non-string path, an unbindable
/// property, a path the data lacks, or a value of the wrong type or range.
/// The bindings stay authored; this names them (invariant 18).
pub fn binding_issues(scene: &SceneDocument) -> Vec<BindingIssue> {
    let mut issues = Vec::new();
    for object in &scene.objects {
        let Some(bindings) = &object.base().bindings else {
            continue;
        };
        for (property, raw_path) in bindings {
            let Some(path) = raw_path.as_str() else {
                issues.push(BindingIssue {
                    object_id: object.base().id.clone(),
                    property: property.clone(),
                    path: raw_path.to_string(),
                    detail: format!(
                        "{property} binding on {} must be a string path",
                        object.base().id
                    ),
                });
                continue;
            };
            let Some(spec) = spec_for(object, property) else {
                issues.push(BindingIssue {
                    object_id: object.base().id.clone(),
                    property: property.clone(),
                    path: path.to_owned(),
                    detail: format!("{property} is not a bindable property of {}", object.kind()),
                });
                continue;
            };
            let value = match resolve_path(&scene.data_context, path) {
                Ok(value) => value,
                Err(detail) => {
                    issues.push(BindingIssue {
                        object_id: object.base().id.clone(),
                        property: property.clone(),
                        path: path.to_owned(),
                        detail,
                    });
                    continue;
                }
            };
            if let Some(detail) = value_issue(scene, object, spec, path, value) {
                issues.push(BindingIssue {
                    object_id: object.base().id.clone(),
                    property: property.clone(),
                    path: path.to_owned(),
                    detail,
                });
            }
        }
    }
    issues
}

fn validate_value(
    scene: &SceneDocument,
    object: &SceneObject,
    spec: BindableProperty,
    path: &str,
    value: &Value,
) -> Result<(), Refusal> {
    if !matches_expected(value, spec.expected) {
        return Err(Refusal::BindingTypeMismatch {
            object: object.base().id.clone(),
            property: spec.key.to_owned(),
            path: path.to_owned(),
            expected: spec.expected.to_owned(),
        });
    }
    if let Some(constraint) = spec.constraint {
        let number = value.as_f64().expect("number property was checked above");
        if !satisfies_constraint(spec.key, number) {
            return Err(Refusal::BindingValueOutOfRange {
                object: object.base().id.clone(),
                property: spec.key.to_owned(),
                path: path.to_owned(),
                constraint: constraint.to_owned(),
            });
        }
    }
    if object.kind() == "image" && spec.key == "assetId" {
        let asset = value.as_str().expect("string property was checked above");
        if !scene
            .assets
            .iter()
            .any(|candidate| candidate.asset_id == asset && candidate.kind == AssetKind::Image)
        {
            return Err(Refusal::BindingAssetUnknown {
                object: object.base().id.clone(),
                path: path.to_owned(),
                asset: asset.to_owned(),
            });
        }
    }
    Ok(())
}

fn value_issue(
    scene: &SceneDocument,
    object: &SceneObject,
    spec: BindableProperty,
    path: &str,
    value: &Value,
) -> Option<String> {
    if !matches_expected(value, spec.expected) {
        return Some(format!(
            "{path} is {}; {} requires {}",
            json_type(value),
            label(spec.key),
            spec.expected
        ));
    }
    if let Some(constraint) = spec.constraint {
        let number = value.as_f64().expect("number property was checked above");
        if !satisfies_constraint(spec.key, number) {
            return Some(format!("{path} must be {constraint}"));
        }
    }
    if object.kind() == "image" && spec.key == "assetId" {
        let asset = value.as_str().expect("string property was checked above");
        if !scene
            .assets
            .iter()
            .any(|candidate| candidate.asset_id == asset && candidate.kind == AssetKind::Image)
        {
            return Some(format!(
                "{path} names image asset {asset}, which the scene does not carry"
            ));
        }
    }
    None
}

fn matches_expected(value: &Value, expected: &str) -> bool {
    match expected {
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        _ => false,
    }
}

fn satisfies_constraint(key: &str, value: f64) -> bool {
    match key {
        "scaleX" | "scaleY" | "scaleZ" => value != 0.0,
        "width" | "height" => value >= 0.0,
        "opacity" => (0.0..=1.0).contains(&value),
        _ => true,
    }
}

fn resolve_path<'a>(data: &'a DataContext, path: &str) -> Result<&'a Value, String> {
    let segments = parse_path(path)?;
    let mut value = data
        .get(segments[0])
        .ok_or_else(|| format!("{path} is absent from the scene data context"))?;
    for segment in &segments[1..] {
        value = match value {
            Value::Array(values) => {
                if !is_index(segment) {
                    return Err(format!("{path} addresses array {segment} by a non-index"));
                }
                let index = segment.parse::<usize>().expect("binding index is decimal");
                values
                    .get(index)
                    .ok_or_else(|| format!("{path} has no value at index {segment}"))?
            }
            Value::Object(values) => values
                .get(*segment)
                .ok_or_else(|| format!("{path} is absent from the scene data context"))?,
            // `typeof null` is "object" in the TS rule this ports.
            other => {
                let kind = if other.is_null() {
                    "object"
                } else {
                    json_type(other)
                };
                return Err(format!("{path} continues through a {kind} value"));
            }
        };
    }
    Ok(value)
}

fn parse_path(path: &str) -> Result<Vec<&str>, String> {
    if path.is_empty() {
        return Err("binding path is empty".to_owned());
    }
    let segments: Vec<&str> = path.split('.').collect();
    for segment in &segments {
        if !is_path_segment(segment)
            || matches!(*segment, "__proto__" | "prototype" | "constructor")
        {
            return Err(format!("binding path segment {segment:?} is invalid"));
        }
    }
    Ok(segments)
}

fn is_path_segment(segment: &str) -> bool {
    is_index(segment)
        || segment.bytes().enumerate().all(|(index, byte)| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'_' => true,
            b'0'..=b'9' | b'-' => index > 0,
            _ => false,
        }) && segment
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
}

/// `0` or a decimal without a leading zero (`^(0|[1-9][0-9]*)$` in the TS twin).
/// Before 8 Nov 2026 a single digit other than `0` was refused here while the
/// Editor preview accepted it, so `teams.1.name` previewed and then refused on
/// air; the shared fixture (`tests/binding_fixture.rs`) now holds both to one rule.
fn is_index(segment: &str) -> bool {
    !segment.is_empty()
        && segment.bytes().all(|byte| byte.is_ascii_digit())
        && (segment.len() == 1 || !segment.starts_with('0'))
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) | Value::Object(_) => "object",
    }
}

fn label(key: &str) -> &'static str {
    match key {
        "text" => "Text",
        "assetId" => "Image asset",
        "x" => "X",
        "y" => "Y",
        "zDepth" => "Depth",
        "rotation" => "Rotation Z",
        "rotationX" => "Rotation X",
        "rotationY" => "Rotation Y",
        "scaleX" => "Scale X",
        "scaleY" => "Scale Y",
        "scaleZ" => "Scale Z",
        "width" => "Width",
        "height" => "Height",
        "opacity" => "Opacity",
        "visible" => "Visible",
        _ => "Property",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{new_scene, ImageObject, ObjectBase, RectObject};

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    }

    /// 3.13: bound values apply exactly as the Editor's preview applies
    /// them, and one binding that cannot apply refuses the whole scene.
    #[test]
    fn bindings_apply_all_or_nothing() {
        let mut scene = crate::scene::new_scene("scene", "Scene", crate::color::WorkingColorSpace::Srgb);
        scene.data_context = serde_json::from_value(serde_json::json!({
            "pos": { "x": 500, "y": 40 },
            "flags": [false],
        }))
        .unwrap();
        let mut bar = rect("bar");
        bar.base_mut().bindings = Some(serde_json::Map::from_iter([
            ("x".to_string(), serde_json::json!("pos.x")),
            ("visible".to_string(), serde_json::json!("flags.0")),
        ]));
        scene.objects.push(bar);
        let resolved = resolve_scene_bindings(&scene).expect("both bindings apply");
        assert_eq!(resolved.objects[0].base().x, 500.0);
        assert!(!resolved.objects[0].base().visible);
        assert_eq!(scene.objects[0].base().x, 0.0, "the authored document is untouched");

        let mut broken = scene.clone();
        broken.objects[0].base_mut().bindings.as_mut().unwrap().insert("y".into(), serde_json::json!("pos.missing"));
        assert!(matches!(resolve_scene_bindings(&broken), Err(Refusal::BindingPathInvalid { .. })));
        broken.objects[0].base_mut().bindings.as_mut().unwrap().insert("y".into(), serde_json::json!("flags.0"));
        assert!(matches!(resolve_scene_bindings(&broken), Err(Refusal::BindingTypeMismatch { .. })));
    }

    #[test]
    fn binding_paths_and_numeric_ranges_are_strict() {
        let mut scene = new_scene("scene", "Scene", crate::color::WorkingColorSpace::NEW_PROJECT);
        scene.objects.push(rect("card"));
        scene.data_context.insert("score".into(), Value::from(0));
        assert!(matches!(
            set_binding(&mut scene, "card", "scaleX", Some("score")),
            Err(Refusal::BindingValueOutOfRange { constraint, .. }) if constraint == "non-zero"
        ));
        assert!(matches!(
            set_binding(&mut scene, "card", "x", Some("__proto__.x")),
            Err(Refusal::BindingPathInvalid { .. })
        ));
        scene.data_context.insert("score".into(), Value::from(1));
        assert!(set_binding(&mut scene, "card", "scaleX", Some("score")).is_ok());
    }

    #[test]
    fn image_binding_rejects_wrong_asset_kind() {
        let mut scene = new_scene("scene", "Scene", crate::color::WorkingColorSpace::NEW_PROJECT);
        scene.objects.push(SceneObject::Image(ImageObject {
            base: ObjectBase::new("logo", "Logo"),
            asset_id: "old".into(),
            fit: Default::default(),
        }));
        scene
            .data_context
            .insert("logo".into(), Value::from("missing"));
        assert!(matches!(
            set_binding(&mut scene, "logo", "assetId", Some("logo")),
            Err(Refusal::BindingAssetUnknown { asset, .. }) if asset == "missing"
        ));
    }

    #[test]
    fn replacing_data_reports_only_newly_invalid_bindings() {
        let mut scene = new_scene("scene", "Scene", crate::color::WorkingColorSpace::NEW_PROJECT);
        scene.objects.push(rect("card"));
        scene.data_context.insert("score".into(), Value::from(1));
        set_binding(&mut scene, "card", "x", Some("score")).unwrap();
        let mut replacement = DataContext::new();
        replacement.insert("score".into(), Value::from("wide"));
        let issues = replace_data_context(&mut scene, replacement).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].property, "x");
        let unchanged = scene.data_context.clone();
        assert!(matches!(
            replace_data_context(&mut scene, unchanged),
            Err(Refusal::DataContextUnchanged)
        ));
    }
}
