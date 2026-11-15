//! 3.19 clip groups (user decisions 15 Nov 2026): a group's `clipChildId`
//! names one child whose alpha, at its own opacity, clips every other
//! descendant of the group as a per-frame matte. The clip child is never drawn
//! itself; nested clip groups multiply. The GPU compositor and the CPU
//! reference both take their clips from this one plan.

use gx_contracts::scene::{resolve_hierarchy, SceneDocument, SceneObject};
use std::collections::HashMap;

/// Each object's clip, by object index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ClipPlan {
    /// The clip child of the object's nearest enclosing clip group that does
    /// not name the object itself; its matte already holds every outer clip.
    pub clip_of: Vec<Option<usize>>,
    /// Whether the object is a clip child: composited into its matte, never
    /// drawn.
    pub is_clip: Vec<bool>,
}

impl ClipPlan {
    pub(crate) fn of(document: &SceneDocument) -> Self {
        let objects = &document.objects;
        let mut index_by_id: HashMap<&str, usize> = HashMap::new();
        for (index, object) in objects.iter().enumerate() {
            index_by_id
                .entry(object.base().id.as_str())
                .or_insert(index);
        }
        let resolution = resolve_hierarchy(objects);
        let parent_of: HashMap<&str, &str> = resolution
            .edges
            .iter()
            .map(|edge| (edge.child_id.as_str(), edge.parent_id.as_str()))
            .collect();
        let clip_child = |group: &str| match objects.get(*index_by_id.get(group)?) {
            Some(SceneObject::Group(group)) => group.clip_child_id.as_deref(),
            _ => None,
        };
        let mut plan = Self {
            clip_of: vec![None; objects.len()],
            is_clip: vec![false; objects.len()],
        };
        for (index, object) in objects.iter().enumerate() {
            let id = object.base().id.as_str();
            if let Some(&parent) = parent_of.get(id) {
                plan.is_clip[index] = clip_child(parent) == Some(id);
            }
            // Walk up: the first ancestor group whose clip child is not the
            // child on this path clips the object. A clip child draws pixels,
            // so it has no descendants, and only the object itself can be one.
            let mut child = id;
            // The hierarchy is acyclic; the bound only guards a bad map.
            for _ in 0..objects.len() {
                let Some(&parent) = parent_of.get(child) else {
                    break;
                };
                if let Some(clip) = clip_child(parent).filter(|&clip| clip != child) {
                    plan.clip_of[index] = index_by_id.get(clip).copied();
                    break;
                }
                child = parent;
            }
        }
        plan
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::scene::{GroupObject, ObjectBase, RectObject};

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    }

    fn group(id: &str, children: &[&str], clip: Option<&str>) -> SceneObject {
        SceneObject::Group(GroupObject {
            base: ObjectBase::new(id, id),
            child_ids: children.iter().map(|c| (*c).into()).collect(),
            clip_child_id: clip.map(Into::into),
        })
    }

    #[test]
    fn nearest_clip_group_clips_every_other_descendant() {
        let mut doc =
            gx_contracts::scene::new_scene("s", "s", gx_contracts::color::WorkingColorSpace::Srgb);
        // outer clips with "o-clip"; inner, inside outer, clips with "i-clip".
        doc.objects = vec![
            group("outer", &["o-clip", "a", "inner"], Some("o-clip")),
            rect("o-clip"),
            rect("a"),
            group("inner", &["i-clip", "b"], Some("i-clip")),
            rect("i-clip"),
            rect("b"),
            rect("free"),
            group("plain", &["c"], None),
            rect("c"),
        ];
        let plan = ClipPlan::of(&doc);
        assert_eq!(
            plan.is_clip,
            [false, true, false, false, true, false, false, false, false]
        );
        assert_eq!(
            plan.clip_of,
            [
                None,
                None,
                Some(1),
                Some(1),
                Some(1),
                Some(4),
                None,
                None,
                None
            ],
            "a clip child is clipped by the outer clip only; b by the inner, whose matte holds the outer"
        );
        doc.objects = vec![group("plain", &["c"], None), rect("c")];
        assert_eq!(ClipPlan::of(&doc).is_clip, [false, false]);
    }
}
