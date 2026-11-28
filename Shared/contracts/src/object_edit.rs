//! Inspector and object-manager edit rules (11.36).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::command::EditEffect;
use crate::scene::{
    resolve_hierarchy, SceneDocument, SceneObject, TextAlign, TextAutoFit, TextCase, TextDecoration, TextLayout, TextOverflow, VerticalAlign, WritingMode,
};
use crate::Refusal;

/// A typed inspector field/value pair. The adjacent tag makes an invalid field
/// and value combination unrepresentable on the command wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "name", content = "value", rename_all = "camelCase")]
pub enum ObjectField {
    Opacity(f64),
    X(f64),
    Y(f64),
    Rotation(f64),
    ScaleX(f64),
    ScaleY(f64),
    Text(String),
    FontId(String),
    Size(f64),
    Radius(f64),
    /// The object's box (`ObjectBase.width`, `height`): a rect and an image
    /// fill it, an ellipse is inscribed in it, paragraph text wraps inside it.
    /// Finite and not negative, as the engine draws it.
    Width(f64),
    Height(f64),
    /// Draw order within a layer (`ObjectBase.z_index`).
    ZIndex(i32),
    /// The text choices of the Properties dock (11.132): held values that are never keyframed. Text objects only. Whether the engine
    /// draws a value is not decided here: `text_choices` asks the drawability check, and a graphic that uses a value the engine
    /// cannot draw yet is refused by name when it is previewed or published, exactly as when it is loaded.
    TextCase(TextCase),
    Align(TextAlign),
    VerticalAlign(VerticalAlign),
    Layout(TextLayout),
    /// Horizontal lines, or upright columns running right to left or left to right (11.51).
    WritingMode(WritingMode),
    AutoFit(TextAutoFit),
    MaxLines(Option<u32>),
    Overflow(TextOverflow),
    Kerning(bool),
    Decoration(TextDecoration),
    ParagraphSpacing(f64),
    /// First-line indent in scene units (11.51): the first line of every paragraph starts this far in. Not negative.
    TextIndent(f64),
    WordSpacing(f64),
    /// Hide when empty (11.153, `ObjectBase.hide_when_empty`): the element is not drawn while one of its text or image bindings resolves to a
    /// missing, null or blank value. Turning it on is refused by name on an element with no such binding; turning it off always works.
    HideWhenEmpty(bool),
}

impl ObjectField {
    /// The field's wire name, as an inspector or a history list shows it.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Opacity(_) => "opacity",
            Self::X(_) => "x",
            Self::Y(_) => "y",
            Self::Rotation(_) => "rotation",
            Self::ScaleX(_) => "scaleX",
            Self::ScaleY(_) => "scaleY",
            Self::Text(_) => "text",
            Self::FontId(_) => "fontId",
            Self::Size(_) => "size",
            Self::Radius(_) => "radius",
            Self::Width(_) => "width",
            Self::Height(_) => "height",
            Self::ZIndex(_) => "zIndex",
            Self::TextCase(_) => "textCase",
            Self::Align(_) => "align",
            Self::VerticalAlign(_) => "verticalAlign",
            Self::Layout(_) => "layout",
            Self::WritingMode(_) => "writingMode",
            Self::AutoFit(_) => "autoFit",
            Self::MaxLines(_) => "maxLines",
            Self::Overflow(_) => "overflow",
            Self::Kerning(_) => "kerning",
            Self::Decoration(_) => "decoration",
            Self::ParagraphSpacing(_) => "paragraphSpacing",
            Self::TextIndent(_) => "textIndent",
            Self::WordSpacing(_) => "wordSpacing",
            Self::HideWhenEmpty(_) => "hideWhenEmpty",
        }
    }

    fn applies_to(&self, object: &SceneObject) -> bool {
        match self {
            Self::Text(_)
            | Self::FontId(_)
            | Self::Size(_)
            | Self::TextCase(_)
            | Self::Align(_)
            | Self::VerticalAlign(_)
            | Self::Layout(_)
            | Self::WritingMode(_)
            | Self::AutoFit(_)
            | Self::MaxLines(_)
            | Self::Overflow(_)
            | Self::Kerning(_)
            | Self::Decoration(_)
            | Self::ParagraphSpacing(_)
            | Self::TextIndent(_)
            | Self::WordSpacing(_) => matches!(object, SceneObject::Text(_)),
            Self::Radius(_) => matches!(object, SceneObject::Rect(_)),
            // The kinds that draw their box. A shape's box follows its path
            // and a line's its end points, so setting either would change
            // nothing drawn; a group, a layer and the rest draw no box.
            Self::Width(_) | Self::Height(_) => matches!(
                object,
                SceneObject::Rect(_)
                    | SceneObject::Ellipse(_)
                    | SceneObject::Image(_)
                    | SceneObject::Text(_)
            ),
            // Draw order means something only for an object that draws.
            Self::ZIndex(_) => !matches!(
                object,
                SceneObject::Group(_)
                    | SceneObject::Layer(_)
                    | SceneObject::Marker(_)
                    | SceneObject::Camera(_)
                    | SceneObject::Light(_)
            ),
            _ => true,
        }
    }

    fn validate(&self) -> Result<(), Refusal> {
        let invalid = |detail: &str| -> Result<(), Refusal> {
            Err(Refusal::ObjectFieldValueInvalid {
                field: self.name().to_owned(),
                detail: detail.to_owned(),
            })
        };
        match self {
            Self::Opacity(value) if !value.is_finite() => invalid("must be finite"),
            Self::Opacity(value) if !(0.0..=1.0).contains(value) => {
                invalid("must be between 0 and 1")
            }
            Self::X(value)
            | Self::Y(value)
            | Self::Rotation(value)
            | Self::ScaleX(value)
            | Self::ScaleY(value)
            | Self::Size(value)
            | Self::Radius(value)
                if !value.is_finite() =>
            {
                invalid("must be finite")
            }
            Self::Width(value) | Self::Height(value) if !value.is_finite() || *value < 0.0 => {
                invalid("must be finite and not negative")
            }
            Self::MaxLines(Some(0)) => invalid("must be a positive line count"),
            Self::WordSpacing(value) if !value.is_finite() || value.abs() > f64::from(f32::MAX) => {
                invalid("must be finite and representable as f32")
            }
            Self::TextIndent(value) if !value.is_finite() || *value < 0.0 || *value > f64::from(f32::MAX) => {
                invalid("must be finite, nonnegative and representable as f32")
            }
            Self::ParagraphSpacing(value) if !value.is_finite() || *value < 0.0 || *value > f64::from(f32::MAX) => {
                invalid("must be finite, nonnegative and representable as f32")
            }
            Self::FontId(value) if value.trim().is_empty() => invalid("cannot be empty"),
            _ => Ok(()),
        }
    }

    fn differs_from(&self, object: &SceneObject) -> bool {
        match self {
            Self::Opacity(value) => !same_number(object.base().opacity, *value),
            Self::X(value) => !same_number(object.base().x, *value),
            Self::Y(value) => !same_number(object.base().y, *value),
            Self::Rotation(value) => !same_number(object.base().rotation, *value),
            Self::ScaleX(value) => !same_number(object.base().scale_x, *value),
            Self::ScaleY(value) => !same_number(object.base().scale_y, *value),
            Self::Text(value) => matches!(object, SceneObject::Text(text) if text.text != *value),
            Self::FontId(value) => {
                matches!(object, SceneObject::Text(text) if text.font_id != *value)
            }
            Self::Size(value) => {
                matches!(object, SceneObject::Text(text) if !same_number(text.size, *value))
            }
            Self::Radius(value) => {
                matches!(object, SceneObject::Rect(rect) if !same_number(rect.radius, *value))
            }
            Self::Width(value) => !same_number(object.base().width, *value),
            Self::Height(value) => !same_number(object.base().height, *value),
            Self::ZIndex(value) => object.base().z_index != *value,
            Self::TextCase(value) => matches!(object, SceneObject::Text(text) if text.text_case != *value),
            Self::Align(value) => matches!(object, SceneObject::Text(text) if text.align != *value),
            Self::VerticalAlign(value) => matches!(object, SceneObject::Text(text) if text.vertical_align != *value),
            Self::Layout(value) => matches!(object, SceneObject::Text(text) if text.layout != *value),
            Self::WritingMode(value) => matches!(object, SceneObject::Text(text) if text.writing_mode != *value),
            Self::AutoFit(value) => matches!(object, SceneObject::Text(text) if text.auto_fit != *value),
            Self::Decoration(value) => matches!(object, SceneObject::Text(text) if text.decoration != *value),
            Self::Kerning(value) => matches!(object, SceneObject::Text(text) if text.kerning.unwrap_or(true) != *value),
            Self::Overflow(value) => matches!(object, SceneObject::Text(text) if text.overflow != *value),
            Self::MaxLines(value) => matches!(object, SceneObject::Text(text) if text.max_lines != *value),
            Self::WordSpacing(value) => matches!(object, SceneObject::Text(text) if !same_number(text.word_spacing, *value)),
            Self::ParagraphSpacing(value) => matches!(object, SceneObject::Text(text) if !same_number(text.paragraph_spacing, *value)),
            Self::TextIndent(value) => matches!(object, SceneObject::Text(text) if !same_number(text.text_indent, *value)),
            Self::HideWhenEmpty(value) => object.base().hide_when_empty.unwrap_or(false) != *value,
        }
    }

    fn apply_to(&self, object: &mut SceneObject) {
        match self {
            Self::Opacity(value) => object.base_mut().opacity = *value,
            Self::X(value) => object.base_mut().x = *value,
            Self::Y(value) => object.base_mut().y = *value,
            Self::Rotation(value) => object.base_mut().rotation = *value,
            Self::ScaleX(value) => object.base_mut().scale_x = *value,
            Self::ScaleY(value) => object.base_mut().scale_y = *value,
            Self::Text(value) => {
                if let SceneObject::Text(text) = object {
                    text.text.clone_from(value);
                }
            }
            Self::FontId(value) => {
                if let SceneObject::Text(text) = object {
                    text.font_id.clone_from(value);
                }
            }
            Self::Size(value) => {
                if let SceneObject::Text(text) = object {
                    text.size = *value;
                }
            }
            Self::Radius(value) => {
                if let SceneObject::Rect(rect) = object {
                    rect.radius = *value;
                }
            }
            Self::Width(value) => object.base_mut().width = *value,
            Self::Height(value) => object.base_mut().height = *value,
            Self::ZIndex(value) => object.base_mut().z_index = *value,
            Self::TextCase(value) => {
                if let SceneObject::Text(text) = object {
                    text.text_case = *value;
                }
            }
            Self::Align(value) => {
                if let SceneObject::Text(text) = object {
                    text.align = *value;
                }
            }
            Self::VerticalAlign(value) => {
                if let SceneObject::Text(text) = object {
                    text.vertical_align = *value;
                }
            }
            Self::Layout(value) => {
                if let SceneObject::Text(text) = object {
                    text.layout = *value;
                }
            }
            Self::WritingMode(value) => {
                if let SceneObject::Text(text) = object {
                    text.writing_mode = *value;
                }
            }
            Self::AutoFit(value) => {
                if let SceneObject::Text(text) = object {
                    text.auto_fit = *value;
                }
            }
            Self::Decoration(value) => {
                if let SceneObject::Text(text) = object {
                    text.decoration = *value;
                }
            }
            Self::Kerning(value) => {
                if let SceneObject::Text(text) = object {
                    text.kerning = (!value).then_some(false);
                }
            }
            Self::Overflow(value) => {
                if let SceneObject::Text(text) = object {
                    text.overflow = *value;
                }
            }
            Self::MaxLines(value) => {
                if let SceneObject::Text(text) = object {
                    text.max_lines = *value;
                }
            }
            Self::WordSpacing(value) => {
                if let SceneObject::Text(text) = object {
                    text.word_spacing = *value;
                }
            }
            Self::ParagraphSpacing(value) => {
                if let SceneObject::Text(text) = object {
                    text.paragraph_spacing = *value;
                }
            }
            Self::TextIndent(value) => {
                if let SceneObject::Text(text) = object {
                    text.text_indent = *value;
                }
            }
            // Absent is false, so turning it off removes the field and a scene that never used it is unchanged on the wire.
            Self::HideWhenEmpty(value) => object.base_mut().hide_when_empty = value.then_some(true),
        }
    }
}

/// `Object.is` equality for finite JSON numbers, retaining its distinction
/// between `0` and `-0`.
fn same_number(left: f64, right: f64) -> bool {
    left.to_bits() == right.to_bits()
}

/// Apply one inspector field over its selected objects as one atomic edit.
pub fn set_object_field(
    scene: &mut SceneDocument,
    object_ids: &[String],
    field: &ObjectField,
) -> Result<EditEffect, Refusal> {
    field.validate()?;
    // Text may only name a font the scene carries and has switched on: any
    // other would be drawn in a fallback face (invariant 18).
    if let ObjectField::FontId(font_id) = field {
        match scene.fonts.iter().find(|font| &font.font_id == font_id) {
            None => {
                return Err(Refusal::SceneFontUnknown {
                    font_id: font_id.clone(),
                    object: object_ids.join(", "),
                })
            }
            Some(font) if !font.enabled => {
                return Err(Refusal::InvalidFontData {
                    detail: format!(
                        "font {font_id} is switched off; switch it on before text uses it"
                    ),
                })
            }
            Some(_) => {}
        }
    }

    let selected: Vec<usize> = scene
        .objects
        .iter()
        .enumerate()
        .filter_map(|(index, object)| object_ids.contains(&object.base().id).then_some(index))
        .collect();
    if selected.is_empty() {
        return Err(Refusal::EditTargetsEmpty);
    }

    let missing_kinds: Vec<String> = selected
        .iter()
        .filter_map(|&index| {
            let object = &scene.objects[index];
            (!field.applies_to(object)).then_some(object.kind())
        })
        .fold(Vec::new(), |mut kinds, kind| {
            if !kinds.iter().any(|present| present == kind) {
                kinds.push(kind.to_owned());
            }
            kinds
        });
    if !missing_kinds.is_empty() {
        return Err(Refusal::ObjectFieldNotApplicable {
            field: field.name().to_owned(),
            kinds: missing_kinds,
        });
    }

    // Hide when empty means something only for an element with a text or image binding: turning it on for any other is refused by name.
    if matches!(field, ObjectField::HideWhenEmpty(true)) {
        let unbound: Vec<String> = selected
            .iter()
            .map(|&index| &scene.objects[index])
            .filter(|object| {
                !object.base().bindings.as_ref().is_some_and(|bindings| {
                    bindings.contains_key("text") || bindings.contains_key("assetId")
                })
            })
            .map(|object| object.base().id.clone())
            .collect();
        if !unbound.is_empty() {
            return Err(Refusal::ObjectFieldValueInvalid {
                field: field.name().to_owned(),
                detail: format!(
                    "needs a text or image binding to look at: {} has none",
                    unbound.join(", ")
                ),
            });
        }
    }

    let changed: Vec<usize> = selected
        .into_iter()
        .filter(|&index| field.differs_from(&scene.objects[index]))
        .collect();
    if changed.is_empty() {
        return Err(Refusal::ObjectFieldUnchanged {
            field: field.name().to_owned(),
        });
    }

    let mut changed_ids = Vec::with_capacity(changed.len());
    for index in changed {
        field.apply_to(&mut scene.objects[index]);
        changed_ids.push(scene.objects[index].base().id.clone());
    }
    Ok(EditEffect::ObjectsChanged {
        object_ids: changed_ids,
    })
}

/// Set one object's authored visibility, rejecting hidden or locked inherited
/// state exactly as the object-manager toggle does.
pub fn set_object_visible(
    scene: &mut SceneDocument,
    object_id: &str,
    visible: bool,
) -> Result<(), Refusal> {
    let object = scene
        .objects
        .iter()
        .find(|object| object.base().id == object_id)
        .ok_or_else(|| Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        })?;
    if let Some(parent) = inherited_owner(scene, object_id, |parent| !parent.base().visible) {
        return Err(Refusal::ObjectHiddenByParent {
            object: object_id.to_owned(),
            parent,
        });
    }
    if object.base().locked {
        return Err(Refusal::ObjectLocked {
            object: object_id.to_owned(),
            owner: object_id.to_owned(),
        });
    }
    if let Some(owner) = inherited_owner(scene, object_id, |parent| parent.base().locked) {
        return Err(Refusal::ObjectLocked {
            object: object_id.to_owned(),
            owner,
        });
    }
    scene
        .objects
        .iter_mut()
        .find(|object| object.base().id == object_id)
        .expect("object was found above")
        .base_mut()
        .visible = visible;
    Ok(())
}

/// Set one object's authored lock, rejecting a lock inherited from an
/// ancestor rather than pretending the child can release it.
pub fn set_object_locked(
    scene: &mut SceneDocument,
    object_id: &str,
    locked: bool,
) -> Result<(), Refusal> {
    if !scene
        .objects
        .iter()
        .any(|object| object.base().id == object_id)
    {
        return Err(Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        });
    }
    if let Some(owner) = inherited_owner(scene, object_id, |parent| parent.base().locked) {
        return Err(Refusal::ObjectLocked {
            object: object_id.to_owned(),
            owner,
        });
    }
    scene
        .objects
        .iter_mut()
        .find(|object| object.base().id == object_id)
        .expect("object was found above")
        .base_mut()
        .locked = locked;
    Ok(())
}

/// The outermost ancestor matching `predicate`, as the object manager's
/// placement walk names it: `hiddenBy`/`lockedBy` are set by the first
/// matching container on the way down from the root and inherited unchanged
/// below it. Accepted hierarchy edges are acyclic, so the walk terminates.
fn inherited_owner(
    scene: &SceneDocument,
    object_id: &str,
    predicate: impl Fn(&SceneObject) -> bool,
) -> Option<String> {
    let hierarchy = resolve_hierarchy(&scene.objects);
    let mut owner = None;
    let mut parent = hierarchy.parent_of(object_id);
    while let Some(parent_id) = parent {
        let parent_object = scene
            .objects
            .iter()
            .find(|object| object.base().id == parent_id)?;
        if predicate(parent_object) {
            owner = Some(parent_id.to_owned());
        }
        parent = hierarchy.parent_of(parent_id);
    }
    owner
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{new_scene, GroupObject, ObjectBase, RectObject};

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    }

    #[test]
    fn inspector_rejects_mixed_kind_and_accepts_opacity_bounds() {
        let mut scene = new_scene(
            "scene",
            "Scene",
            crate::color::WorkingColorSpace::NEW_PROJECT,
        );
        scene.objects = vec![
            rect("card"),
            SceneObject::Group(GroupObject {
                base: ObjectBase::new("group", "Group"),
                child_ids: Vec::new(),
                clip_child_id: None,
            }),
        ];
        let ids = vec!["card".into(), "group".into()];
        assert!(matches!(
            set_object_field(&mut scene, &ids, &ObjectField::Radius(8.0)),
            Err(Refusal::ObjectFieldNotApplicable { .. })
        ));
        let ids = vec!["card".into()];
        assert!(set_object_field(&mut scene, &ids, &ObjectField::Opacity(0.0)).is_ok());
        assert!(matches!(
            set_object_field(&mut scene, &ids, &ObjectField::Opacity(1.1)),
            Err(Refusal::ObjectFieldValueInvalid { .. })
        ));
    }

    #[test]
    fn inherited_visibility_and_lock_refuse_child_edits() {
        let mut scene = new_scene(
            "scene",
            "Scene",
            crate::color::WorkingColorSpace::NEW_PROJECT,
        );
        let mut group = GroupObject {
            base: ObjectBase::new("group", "Group"),
            child_ids: vec!["card".into()],
            clip_child_id: None,
        };
        group.base.visible = false;
        scene.objects = vec![SceneObject::Group(group), rect("card")];
        assert!(matches!(
            set_object_visible(&mut scene, "card", true),
            Err(Refusal::ObjectHiddenByParent { parent, .. }) if parent == "group"
        ));
        if let SceneObject::Group(group) = &mut scene.objects[0] {
            group.base.visible = true;
            group.base.locked = true;
        }
        assert!(matches!(
            set_object_locked(&mut scene, "card", false),
            Err(Refusal::ObjectLocked { owner, .. }) if owner == "group"
        ));
    }

    #[test]
    fn text_names_only_a_font_the_scene_carries_and_has_switched_on() {
        let font = |id: &str, enabled: bool| -> crate::font::FontDefinition {
            serde_json::from_value(serde_json::json!({
                "fontId": id, "family": id, "displayName": id, "faces": [], "fallbackFamilies": [],
                "embeddingPolicy": "restricted", "enabled": enabled, "status": "Ready"
            }))
            .unwrap()
        };
        let mut scene = new_scene(
            "scene",
            "Scene",
            crate::color::WorkingColorSpace::NEW_PROJECT,
        );
        scene.fonts = vec![font("on", true), font("off", false), font("other", true)];
        let text = crate::authoring::create_object(&mut scene, "text", "Title").unwrap();
        let ids = vec![text.clone()];
        assert!(matches!(
            set_object_field(&mut scene, &ids, &ObjectField::FontId("ghost".into())),
            Err(Refusal::SceneFontUnknown { font_id, object }) if font_id == "ghost" && object == text
        ));
        assert!(matches!(
            set_object_field(&mut scene, &ids, &ObjectField::FontId("off".into())),
            Err(Refusal::InvalidFontData { detail }) if detail.contains("off is switched off")
        ));
        assert!(set_object_field(&mut scene, &ids, &ObjectField::FontId("other".into())).is_ok());
    }

    fn two_texts_and_a_rect() -> (SceneDocument, String, String) {
        let mut scene = new_scene(
            "scene",
            "Scene",
            crate::color::WorkingColorSpace::NEW_PROJECT,
        );
        scene.fonts = vec![serde_json::from_value(serde_json::json!({
            "fontId": "face", "family": "face", "displayName": "face", "faces": [], "fallbackFamilies": [],
            "embeddingPolicy": "restricted", "enabled": true, "status": "Ready"
        }))
        .unwrap()];
        let first = crate::authoring::create_object(&mut scene, "text", "One").unwrap();
        let second = crate::authoring::create_object(&mut scene, "text", "Two").unwrap();
        scene.objects.push(rect("card"));
        (scene, first, second)
    }

    fn text_of<'a>(scene: &'a SceneDocument, id: &str) -> &'a crate::scene::TextObject {
        match scene.objects.iter().find(|object| object.base().id == id) {
            Some(SceneObject::Text(text)) => text,
            _ => panic!("{id} is not a text object"),
        }
    }

    #[test]
    fn the_text_choices_are_set_on_every_selected_text_object_as_one_edit() {
        let (mut scene, first, second) = two_texts_and_a_rect();
        let ids = vec![first.clone(), second.clone()];
        for (field, check) in [
            (ObjectField::TextCase(TextCase::Upper), Box::new(|t: &crate::scene::TextObject| t.text_case == TextCase::Upper) as Box<dyn Fn(&crate::scene::TextObject) -> bool>),
            (ObjectField::Align(TextAlign::Center), Box::new(|t| t.align == TextAlign::Center)),
            (ObjectField::VerticalAlign(VerticalAlign::Middle), Box::new(|t| t.vertical_align == VerticalAlign::Middle)),
            (ObjectField::Layout(TextLayout::Paragraph), Box::new(|t| t.layout == TextLayout::Paragraph)),
            (ObjectField::WritingMode(WritingMode::VerticalRl), Box::new(|t| t.writing_mode == WritingMode::VerticalRl)),
            (ObjectField::AutoFit(TextAutoFit::Shrink), Box::new(|t| t.auto_fit == TextAutoFit::Shrink)),
        ] {
            let effect = set_object_field(&mut scene, &ids, &field).unwrap();
            assert!(
                matches!(effect, EditEffect::ObjectsChanged { ref object_ids } if *object_ids == ids),
                "{}",
                field.name()
            );
            assert!(check(text_of(&scene, &first)) && check(text_of(&scene, &second)), "{}", field.name());
        }
    }

    #[test]
    fn a_choice_is_refused_for_any_object_that_is_not_text_and_changes_nothing() {
        let (mut scene, first, _) = two_texts_and_a_rect();
        let before = serde_json::to_value(&scene).unwrap();
        for field in [
            ObjectField::TextCase(TextCase::Lower),
            ObjectField::Align(TextAlign::Right),
            ObjectField::VerticalAlign(VerticalAlign::Bottom),
            ObjectField::Layout(TextLayout::Paragraph),
            ObjectField::WritingMode(WritingMode::VerticalLr),
            ObjectField::AutoFit(TextAutoFit::Fit),
        ] {
            let ids = vec![first.clone(), "card".to_owned()];
            assert!(
                matches!(
                    set_object_field(&mut scene, &ids, &field),
                    Err(Refusal::ObjectFieldNotApplicable { field: ref named, ref kinds }) if named == field.name() && kinds == &vec!["rect".to_owned()]
                ),
                "{}",
                field.name()
            );
        }
        assert_eq!(serde_json::to_value(&scene).unwrap(), before, "a refused edit changes no object, not even the text one");
    }

    #[test]
    fn setting_a_choice_to_what_every_object_already_has_is_refused_as_unchanged() {
        let (mut scene, first, second) = two_texts_and_a_rect();
        let ids = vec![first.clone(), second];
        assert!(matches!(
            set_object_field(&mut scene, &ids, &ObjectField::TextCase(TextCase::Original)),
            Err(Refusal::ObjectFieldUnchanged { field }) if field == "textCase"
        ));
        // One object already has it, the other does not: only the other changes.
        set_object_field(&mut scene, &vec![first.clone()], &ObjectField::Align(TextAlign::Right)).unwrap();
        let effect = set_object_field(&mut scene, &ids, &ObjectField::Align(TextAlign::Right)).unwrap();
        assert!(matches!(effect, EditEffect::ObjectsChanged { ref object_ids } if object_ids.len() == 1 && object_ids[0] != first));
    }

    #[test]
    fn text_indent_is_a_held_nonnegative_value_on_text_only() {
        let (mut scene, first, second) = two_texts_and_a_rect();
        let ids = vec![first.clone(), second];
        assert_eq!(serde_json::to_value(ObjectField::TextIndent(18.0)).unwrap(), serde_json::json!({"name": "textIndent", "value": 18.0}));
        set_object_field(&mut scene, &ids, &ObjectField::TextIndent(18.0)).unwrap();
        for id in &ids {
            let Some(SceneObject::Text(text)) = scene.objects.iter().find(|object| object.base().id == *id) else { panic!() };
            assert_eq!(text.text_indent, 18.0);
        }
        assert!(matches!(
            set_object_field(&mut scene, &ids, &ObjectField::TextIndent(18.0)),
            Err(Refusal::ObjectFieldUnchanged { field }) if field == "textIndent"
        ));
        for bad in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(set_object_field(&mut scene, &ids, &ObjectField::TextIndent(bad)).is_err(), "{bad}");
        }
        let rect = scene.objects.iter().find(|object| matches!(object, SceneObject::Rect(_))).unwrap().base().id.clone();
        assert!(set_object_field(&mut scene, &[rect], &ObjectField::TextIndent(4.0)).is_err());
    }

    #[test]
    fn the_choices_are_on_the_wire_as_a_name_and_a_value_in_the_words_the_scene_uses() {
        for (field, wire) in [
            (ObjectField::TextCase(TextCase::SmallCaps), serde_json::json!({"name": "textCase", "value": "small-caps"})),
            (ObjectField::Align(TextAlign::Center), serde_json::json!({"name": "align", "value": "center"})),
            (ObjectField::VerticalAlign(VerticalAlign::Bottom), serde_json::json!({"name": "verticalAlign", "value": "bottom"})),
            (ObjectField::Layout(TextLayout::Paragraph), serde_json::json!({"name": "layout", "value": "paragraph"})),
            (ObjectField::WritingMode(WritingMode::VerticalRl), serde_json::json!({"name": "writingMode", "value": "vertical-rl"})),
            (ObjectField::WritingMode(WritingMode::VerticalLr), serde_json::json!({"name": "writingMode", "value": "vertical-lr"})),
            (ObjectField::AutoFit(TextAutoFit::Shrink), serde_json::json!({"name": "autoFit", "value": "shrink"})),
        ] {
            assert_eq!(serde_json::to_value(&field).unwrap(), wire);
            // The name a refusal and the history give is the wire name.
            assert_eq!(field.name(), wire["name"].as_str().unwrap());
            assert_eq!(serde_json::from_value::<ObjectField>(wire).unwrap(), field);
        }
        assert!(serde_json::from_value::<ObjectField>(serde_json::json!({"name": "textCase", "value": "shouting"})).is_err());
    }

    /// Hide when empty (11.153): on only where there is a text or image binding to look at, off always, one undo, and absent when false.
    #[test]
    fn hide_when_empty_needs_a_text_or_image_binding_and_is_absent_when_off() {
        let mut scene = new_scene("scene", "Scene", crate::color::WorkingColorSpace::NEW_PROJECT);
        let mut name = rect("name");
        name.base_mut().bindings = Some(serde_json::Map::from_iter([("text".to_string(), serde_json::json!("p.name"))]));
        let mut moved = rect("moved");
        moved.base_mut().bindings = Some(serde_json::Map::from_iter([("x".to_string(), serde_json::json!("p.x"))]));
        scene.objects = vec![name, moved, rect("plain")];
        let on = ObjectField::HideWhenEmpty(true);

        // Refused by name, and whole: the bound one is not changed when another selected object has no binding.
        for unbound in [vec!["plain".to_string()], vec!["moved".to_string()], vec!["name".to_string(), "plain".to_string()]] {
            let refusal = set_object_field(&mut scene, &unbound, &on).unwrap_err();
            assert!(
                matches!(&refusal, Refusal::ObjectFieldValueInvalid { field, detail } if field == "hideWhenEmpty" && detail.contains("needs a text or image binding")),
                "{refusal:?}"
            );
        }
        assert_eq!(scene.objects[0].base().hide_when_empty, None, "a refused edit changes nothing");

        let ids = vec!["name".to_string()];
        let effect = set_object_field(&mut scene, &ids, &on).unwrap();
        assert!(matches!(effect, EditEffect::ObjectsChanged { ref object_ids } if object_ids == &ids));
        assert_eq!(scene.objects[0].base().hide_when_empty, Some(true));
        assert_eq!(serde_json::to_value(&scene.objects[0]).unwrap()["hideWhenEmpty"], serde_json::json!(true));
        assert!(matches!(set_object_field(&mut scene, &ids, &on), Err(Refusal::ObjectFieldUnchanged { field }) if field == "hideWhenEmpty"));

        // Off works on any object that has it, and leaves the field out of the wire, so a scene that never used it is unchanged.
        set_object_field(&mut scene, &ids, &ObjectField::HideWhenEmpty(false)).unwrap();
        assert_eq!(scene.objects[0].base().hide_when_empty, None);
        assert!(serde_json::to_value(&scene.objects[0]).unwrap().get("hideWhenEmpty").is_none());
        assert!(matches!(
            set_object_field(&mut scene, &ids, &ObjectField::HideWhenEmpty(false)),
            Err(Refusal::ObjectFieldUnchanged { .. })
        ));

        // The wire words, and the name a refusal and the history give.
        let wire = serde_json::json!({"name": "hideWhenEmpty", "value": true});
        assert_eq!(serde_json::to_value(&on).unwrap(), wire);
        assert_eq!(on.name(), "hideWhenEmpty");
        assert_eq!(serde_json::from_value::<ObjectField>(wire).unwrap(), on);
        assert!(serde_json::from_value::<ObjectField>(serde_json::json!({"name": "hideWhenEmpty", "value": "yes"})).is_err());
    }
}
