//! Inspector and object-manager edit rules (11.36).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::command::EditEffect;
use crate::scene::{resolve_hierarchy, SceneDocument, SceneObject};
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
}

impl ObjectField {
    fn name(&self) -> &'static str {
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
        }
    }

    fn applies_to(&self, object: &SceneObject) -> bool {
        match self {
            Self::Text(_) | Self::FontId(_) | Self::Size(_) => {
                matches!(object, SceneObject::Text(_))
            }
            Self::Radius(_) => matches!(object, SceneObject::Rect(_)),
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
        let mut scene = new_scene("scene", "Scene");
        scene.objects = vec![
            rect("card"),
            SceneObject::Group(GroupObject {
                base: ObjectBase::new("group", "Group"),
                child_ids: Vec::new(),
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
        let mut scene = new_scene("scene", "Scene");
        let mut group = GroupObject {
            base: ObjectBase::new("group", "Group"),
            child_ids: vec!["card".into()],
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
}
