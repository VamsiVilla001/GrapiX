//! Linked paths (plan row 11.112; Pen spec v2 sections 4 and 13): one path that a shape and a mask (or two masks) share, so that an edit of
//! it changes them all, while a plain copy stays independent unless the author links it.
//!
//! A [`PathLink`] names the users of a path (a shape's path or subpath, a mask by its id) and carries a revision. Every user keeps its own
//! inline path, which is what every renderer reads, and the validator holds the users to the same numbers; so a link costs the renderers
//! nothing and an old scene (no links) is unchanged. An edit of a linked path (`editPath`) writes the new path to every user and bumps
//! the revision; it may name the revision it was made on, and one made on an older revision is refused by name, so two editors or an old
//! undo never silently overwrite each other. A mask is addressed by id (the edits give a mask one when it is linked), so reordering or
//! removing other masks does not break a link. A linked path animates as one: every user holds the same keys, an edit of the keys of any
//! user is made on that user and the rest path and the keys then go to the others, and the validator holds the users' keys to be equal.
//! Linking onto a path that has keys of its own is refused by name (it would lose them).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::path_geometry::PathTarget;
use crate::scene::{BezierPath, SceneDocument, SceneObject};
use crate::Refusal;

/// A path in the scene, addressed from outside by its place in its object (`target`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathAddress {
    pub object_id: String,
    pub target: PathTarget,
}

/// One user of a link: a shape's path (`subpath` 0 is the main path, 1 and on its compound subpaths) or a mask, by its id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPath {
    pub object_id: String,
    /// The shape's subpath; absent for a mask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subpath: Option<usize>,
    /// The mask's id; absent for a shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mask_id: Option<String>,
}

/// A path shared by several users, and how many times it has been edited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathLink {
    pub id: String,
    /// Starts at 1 and goes up by one with every edit of the shared path.
    pub revision: u64,
    pub users: Vec<LinkedPath>,
}

impl LinkedPath {
    /// The place in its object this user is, or `None` when its mask is gone.
    pub fn target(&self, scene: &SceneDocument) -> Option<PathTarget> {
        match (&self.subpath, &self.mask_id) {
            (Some(subpath), None) => Some(PathTarget::Shape { subpath: *subpath }),
            (None, Some(id)) => {
                let object = scene.objects.iter().find(|o| o.base().id == self.object_id)?;
                let index = object.base().masks().iter().position(|m| m.id.as_deref() == Some(id.as_str()))?;
                Some(PathTarget::Mask { index })
            }
            _ => None,
        }
    }

    /// Its path, if there is one.
    pub fn path(&self, scene: &SceneDocument) -> Option<BezierPath> {
        crate::path_anim::target_path(scene, &self.object_id, self.target(scene)?)
    }
}

/// The user an address stands for, or `None` when the object or the mask is not there. A mask with no id has no user yet.
pub fn user_at(scene: &SceneDocument, address: &PathAddress) -> Option<LinkedPath> {
    let object = scene.objects.iter().find(|o| o.base().id == address.object_id)?;
    match address.target {
        PathTarget::Shape { subpath } => {
            crate::path_anim::target_path(scene, &address.object_id, address.target)?;
            Some(LinkedPath { object_id: address.object_id.clone(), subpath: Some(subpath), mask_id: None })
        }
        PathTarget::Mask { index } => {
            let id = object.base().masks().get(index)?.id.clone()?;
            Some(LinkedPath { object_id: address.object_id.clone(), subpath: None, mask_id: Some(id) })
        }
    }
}

/// The index of the link the address is a user of, if any.
pub fn link_at(scene: &SceneDocument, address: &PathAddress) -> Option<usize> {
    let user = user_at(scene, address)?;
    scene.path_links.iter().position(|link| link.users.contains(&user))
}

/// Remove the users whose object, mask or subpath is gone, and the links left with fewer than two users. What an edit that deletes things
/// calls before it is checked, so a link never outlives the paths it joined.
pub fn prune_path_links(scene: &mut SceneDocument) {
    let snapshot = scene.clone();
    for link in &mut scene.path_links {
        link.users.retain(|user| user.path(&snapshot).is_some());
    }
    scene.path_links.retain(|link| link.users.len() >= 2);
}

/// A link's consistency: ids unique, every user there and in one link only, no user animated, and every user holding the same path.
pub fn validate_path_links(scene: &SceneDocument) -> Result<(), Refusal> {
    let invalid = |field: String, detail: &str| Refusal::ObjectFieldValueInvalid { field, detail: detail.into() };
    let mut ids = std::collections::BTreeSet::new();
    let mut used: Vec<&LinkedPath> = Vec::new();
    for (index, link) in scene.path_links.iter().enumerate() {
        let field = format!("pathLinks[{index}]");
        if !ids.insert(link.id.as_str()) {
            return Err(invalid(field, "two path links have the same id"));
        }
        if link.revision == 0 {
            return Err(invalid(field, "a path link's revision starts at 1"));
        }
        let mut first: Option<BezierPath> = None;
        let mut first_keys: Option<Vec<crate::path_anim::PathKey>> = None;
        for user in &link.users {
            if used.contains(&user) {
                return Err(invalid(field, "a path is in two links"));
            }
            used.push(user);
            let Some(target) = user.target(scene) else {
                return Err(invalid(field, "a linked path's shape subpath or mask is not there"));
            };
            let Some(path) = crate::path_anim::target_path(scene, &user.object_id, target) else {
                return Err(invalid(field, "a linked path is not there"));
            };
            let keys = scene
                .timeline
                .path_channels
                .iter()
                .find(|c| c.object_id == user.object_id && c.target == target)
                .map(|c| c.keys.clone())
                .unwrap_or_default();
            match &first {
                None => {
                    first = Some(path);
                    first_keys = Some(keys);
                }
                Some(shared) if *shared == path => {
                    if first_keys.as_ref() != Some(&keys) {
                        return Err(invalid(field, "linked paths have different keys: edit a linked path with editPath, or unlink it first"));
                    }
                }
                Some(_) => return Err(invalid(field, "linked paths differ: edit a linked path with editPath, or unlink it first")),
            }
        }
    }
    Ok(())
}

/// Bring the other users of a link in line with `from`: each gets the same keys as `from` (a copy, on its own object and place), or none
/// when `from` has none. Their rest paths are the caller's to write. A linked path animates as one: every user holds the same channel.
pub fn sync_channels(scene: &mut SceneDocument, link_index: usize, from: &PathAddress) {
    let keys = scene
        .timeline
        .path_channels
        .iter()
        .find(|c| c.object_id == from.object_id && c.target == from.target)
        .map(|c| c.keys.clone())
        .filter(|k| !k.is_empty());
    let users = scene.path_links[link_index].users.clone();
    for user in &users {
        let Some(place) = user.target(scene) else { continue };
        if user.object_id == from.object_id && place == from.target {
            continue;
        }
        scene.timeline.path_channels.retain(|c| !(c.object_id == user.object_id && c.target == place));
        if let Some(keys) = &keys {
            scene.timeline.path_channels.push(crate::path_anim::PathChannel {
                object_id: user.object_id.clone(),
                target: place,
                keys: keys.clone(),
            });
        }
    }
}

/// The ids of every object that uses a link, without repeats.
pub fn objects_of(link: &PathLink) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for user in &link.users {
        if !ids.contains(&user.object_id) {
            ids.push(user.object_id.clone());
        }
    }
    ids
}

/// Give a mask an id (the lowest free `mask-N` among its object's masks) when it has none, and say which it has.
pub fn ensure_mask_id(scene: &mut SceneDocument, object_id: &str, index: usize) -> Option<String> {
    let object: &mut SceneObject = scene.objects.iter_mut().find(|o| o.base().id == object_id)?;
    let masks = object.base_mut().masks.as_mut()?;
    if let Some(id) = masks.get(index)?.id.clone() {
        return Some(id);
    }
    let taken: Vec<String> = masks.iter().filter_map(|m| m.id.clone()).collect();
    let id = (1..).map(|n| format!("mask-{n}")).find(|candidate| !taken.contains(candidate))?;
    masks[index].id = Some(id.clone());
    Some(id)
}

/// The lowest free `path-link-N`.
pub fn next_link_id(scene: &SceneDocument) -> String {
    (1..)
        .map(|n| format!("path-link-{n}"))
        .find(|id| !scene.path_links.iter().any(|link| &link.id == id))
        .expect("an unbounded range has a free name")
}
