//! 3.19 clip groups (user decisions 15 Nov 2026): a group's `clipChildId`
//! names one child whose alpha, at its own opacity, clips every other
//! descendant of the group as a per-frame matte. The clip child is never drawn
//! itself; nested clip groups multiply. Track mattes (3.19, user decisions 15
//! Nov 2026) use the same per-frame matte: an object's `trackMatte` names a
//! source whose alpha or luma, at its own opacity, shapes it; the source is a
//! matte whether or not it is seen, and is drawn like any layer when its own
//! visibility says so (3.30; before that it was never drawn). The GPU
//! compositor and the CPU reference
//! both take their clips and mattes from this one plan.

use gx_contracts::scene::{resolve_hierarchy, SceneDocument, SceneObject, TrackMatteMode};
use std::collections::HashMap;

/// Rec.709 luma weights, applied to premultiplied working-space colour; the
/// composite shader uses the same three.
pub(crate) const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// What a track matte lets through at one matte pixel (premultiplied), as the
/// composite shader computes it.
pub(crate) fn track_value(matte: crate::colour_pipeline::WorkingRgba, mode: TrackMatteMode) -> f32 {
    let luma = || (matte.r * LUMA[0] + matte.g * LUMA[1] + matte.b * LUMA[2]).clamp(0.0, 1.0);
    match mode {
        TrackMatteMode::Alpha => matte.a,
        TrackMatteMode::AlphaInverted => 1.0 - matte.a,
        TrackMatteMode::Luma => luma(),
        TrackMatteMode::LumaInverted => 1.0 - luma(),
    }
}

/// The composite shader's code for a track matte mode; 0 is none.
pub(crate) fn track_code(mode: TrackMatteMode) -> f32 {
    match mode {
        TrackMatteMode::Alpha => 1.0,
        TrackMatteMode::AlphaInverted => 2.0,
        TrackMatteMode::Luma => 3.0,
        TrackMatteMode::LumaInverted => 4.0,
    }
}

/// Each object's clip, by object index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ClipPlan {
    /// The clip child of the object's nearest enclosing clip group that does
    /// not name the object itself; its matte already holds every outer clip.
    pub clip_of: Vec<Option<usize>>,
    /// Whether the object is a clip child: composited into its matte, never
    /// drawn.
    pub is_clip: Vec<bool>,
    /// The object's track matte: its source's index and the mode.
    pub track_of: Vec<Option<(usize, TrackMatteMode)>>,
    /// Whether the object is some layer's track matte source: composited into
    /// its matte, and drawn too unless it is hidden.
    pub is_source: Vec<bool>,
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
            track_of: vec![None; objects.len()],
            is_source: vec![false; objects.len()],
        };
        for (index, object) in objects.iter().enumerate() {
            let Some(matte) = object.base().track_matte() else {
                continue;
            };
            if let Some(&source) = index_by_id.get(matte.source_id.as_str()) {
                plan.track_of[index] = Some((source, matte.mode));
                plan.is_source[source] = true;
            }
        }
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

    /// A clip child or a track matte source: composited into its matte each
    /// frame (a clip child is never drawn itself; a source is drawn too when
    /// it is visible).
    pub(crate) fn is_matte(&self, index: usize) -> bool {
        self.is_clip.get(index) == Some(&true) || self.is_source.get(index) == Some(&true)
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
