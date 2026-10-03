//! Material relink and deletion rules (11.36).

use crate::scene::SceneDocument;
use crate::Refusal;

/// Repoint every use of one material to another, discarding instance overrides
/// because they were authored for the source material's parameter surface.
pub fn relink_material(
    scene: &mut SceneDocument,
    from_material_id: &str,
    to_material_id: &str,
) -> Result<Vec<String>, Refusal> {
    ensure_material_exists(scene, from_material_id)?;
    ensure_material_exists(scene, to_material_id)?;
    if from_material_id == to_material_id {
        return Err(Refusal::MaterialRelinkSameMaterial {
            material: from_material_id.to_owned(),
        });
    }

    let mut changed = Vec::new();
    for object in &mut scene.objects {
        let Some(slots) = object.base_mut().material_slots.as_mut() else {
            continue;
        };
        let mut uses_source = false;
        for binding in slots.values_mut() {
            if binding.material_id == from_material_id {
                binding.material_id = to_material_id.to_owned();
                binding.instance_id = None;
                uses_source = true;
            }
        }
        if uses_source {
            changed.push(object.base().id.clone());
        }
    }
    if changed.is_empty() {
        return Err(Refusal::MaterialRelinkNoUsers {
            material: from_material_id.to_owned(),
        });
    }
    Ok(changed)
}

/// Delete a material only when no object still binds it.
pub fn delete_material(scene: &mut SceneDocument, material_id: &str) -> Result<(), Refusal> {
    ensure_material_exists(scene, material_id)?;
    let users = material_users(scene, material_id);
    if !users.is_empty() {
        return Err(Refusal::MaterialInUse {
            material: material_id.to_owned(),
            users,
        });
    }
    scene
        .materials
        .retain(|material| material.material_id != material_id);
    Ok(())
}

fn ensure_material_exists(scene: &SceneDocument, material_id: &str) -> Result<(), Refusal> {
    scene
        .materials
        .iter()
        .any(|material| material.material_id == material_id)
        .then_some(())
        .ok_or_else(|| Refusal::MaterialUnknown {
            material: material_id.to_owned(),
        })
}

fn material_users(scene: &SceneDocument, material_id: &str) -> Vec<String> {
    scene
        .objects
        .iter()
        .filter(|object| {
            object.base().material_slots.as_ref().is_some_and(|slots| {
                slots
                    .values()
                    .any(|binding| binding.material_id == material_id)
            })
        })
        .map(|object| object.base().id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::color::ColorValue;
    use crate::material::{MaterialBinding, MaterialDefinition};
    use crate::scene::{new_scene, ObjectBase, RectObject, SceneObject};

    fn material(id: &str) -> MaterialDefinition {
        MaterialDefinition {
            material_id: id.into(),
            name: id.into(),
            kind: Default::default(),
            color: ColorValue::opaque_white(),
            opacity: 1.0,
            blend_mode: Default::default(),
            alpha_mode: Default::default(),
            cull_mode: Default::default(),
            depth_mode: Default::default(),
            double_sided: false,
            textures: Vec::new(),
            shader_id: None,
        }
    }

    #[test]
    fn relink_requires_users_and_clears_instance_override() {
        let mut scene = new_scene("scene", "Scene");
        scene.materials = vec![material("from"), material("to")];
        let mut base = ObjectBase::new("card", "Card");
        base.material_slots = Some(BTreeMap::from([(
            "front".into(),
            MaterialBinding {
                material_id: "from".into(),
                instance_id: Some("instance".into()),
            },
        )]));
        scene
            .objects
            .push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
        assert_eq!(relink_material(&mut scene, "from", "to").unwrap(), ["card"]);
        let binding = scene.objects[0]
            .base()
            .material_slots
            .as_ref()
            .unwrap()
            .get("front")
            .unwrap();
        assert_eq!(binding.material_id, "to");
        assert_eq!(binding.instance_id, None);
        assert!(matches!(
            relink_material(&mut scene, "from", "to"),
            Err(Refusal::MaterialRelinkNoUsers { .. })
        ));
    }

    #[test]
    fn delete_refuses_live_material_and_removes_unused_material() {
        let mut scene = new_scene("scene", "Scene");
        scene.materials = vec![material("used"), material("unused")];
        let mut base = ObjectBase::new("card", "Card");
        base.material_slots = Some(BTreeMap::from([(
            "front".into(),
            MaterialBinding::new("used"),
        )]));
        scene
            .objects
            .push(SceneObject::Rect(RectObject { base, radius: 0.0 }));
        assert!(matches!(
            delete_material(&mut scene, "used"),
            Err(Refusal::MaterialInUse { users, .. }) if users == ["card"]
        ));
        delete_material(&mut scene, "unused").unwrap();
        assert_eq!(scene.materials.len(), 1);
    }
}
