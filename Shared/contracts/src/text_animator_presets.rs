//! EffectCraft's text-animator presets as typed edits (11.61).
//!
//! The presets, their ranges, shapes, offsets, easing flags and timings are taken from
//! EffectCraft at 9a7d3e76991d5372448033b473dc12c2480a6a04,
//! crates/engine/presets/text_animators.json.
//! Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors.
//! MIT license in services/render-engine/worker/EFFECTCRAFT-LICENSE.
//!
//! A preset here is not a stored blob: it is an animator and the keys that move it, built for the
//! text it is applied to and written by [`apply`] as part of one `applyTextAnimatorPreset` edit
//! (one undo entry, all or nothing, like every other scene edit). Four of the eight need
//! something the engine does not have (a second animator on one text, a wiggly selector, a
//! character offset, a per-glyph blur). They refuse by name, with the reason, rather than apply
//! the part that happens to work: a preset that draws something other than what it is called
//! would put the wrong graphic on air (invariant 18).
//!
//! Units. EffectCraft stores percentages and 1/1000 em; this contract stores normalised ranges
//! (`-100..100 %` is `-1..1`), scene pixels for tracking, and a scale factor (`100 %` is `1`).
//! The tracking conversion needs the em size of the text the preset lands on, so the keys are
//! built per text, never stored.

use crate::animation::{self, SceneEasing, SceneKeyframe};
use crate::effect_catalog::EFFECTCRAFT_PRESETS;
use crate::scene::{SceneDocument, SceneObject};
use crate::text_animator::{TextAnimator, TextRangeBasis, TextRangeSelector, TextRangeShape};
use crate::Refusal;

/// The prefix of every EffectCraft text-animator preset's listing id.
pub const ID_PREFIX: &str = "ec.textanimator.";

/// The build-plan row that owns drawing what an unavailable preset needs.
const OWNER: &str = "11.61";

/// One key of a preset, in seconds after the frame the preset is applied at.
#[derive(Debug, Clone, PartialEq)]
struct PresetKey {
    property: &'static str,
    seconds: f64,
    value: f64,
}

/// What a preset writes on one text: its animator and the keys that move it.
#[derive(Debug, Clone, PartialEq)]
struct Built {
    animator: TextAnimator,
    keys: Vec<PresetKey>,
    /// EffectCraft's `ease: true`: every key leaves with an ease-in-out. Otherwise linear.
    ease: bool,
}

fn key(property: &'static str, seconds: f64, value: f64) -> PresetKey {
    PresetKey { property, seconds, value }
}

/// The name a listing id carries (`ec.textanimator.typewriter` is `typewriter`), if it is one of
/// the eight.
fn preset_name(listing_id: &str) -> Option<&'static str> {
    let name = listing_id.strip_prefix(ID_PREFIX)?;
    EFFECTCRAFT_PRESETS
        .iter()
        .map(|(id, _, _)| *id)
        .find(|id| *id == name)
}

/// Why a preset cannot be applied, or `None` when it can. A name that is not one of the eight is
/// `None` too: an unknown preset is a different refusal ([`Refusal::MotionPresetUnknown`]).
pub fn unavailable_reason(listing_id: &str) -> Option<&'static str> {
    Some(match preset_name(listing_id)? {
        "bounceInWords" => {
            "needs a second animator on the same text for its overshoot, and a text holds one animator"
        }
        "scramble" => {
            "needs a character offset and a wiggly selector, which the engine does not have"
        }
        "blurIn" => "needs a blur on each glyph, which the engine does not have",
        "jitter" => {
            "needs a wiggly selector (seeded noise that moves over time), which the engine does not have"
        }
        _ => return None,
    })
}

/// The preset for a text of em size `size`, or `None` for one that is unavailable.
fn build(name: &str, size: f64) -> Option<Built> {
    let range = |shape, basis, ease_high, ease_low, offset| TextRangeSelector {
        shape,
        basis,
        ease_high,
        ease_low,
        offset,
        ..TextRangeSelector::default()
    };
    Some(match name {
        // Characters appear one at a time, hard-edged: the range's start sweeps 0 to 100 %.
        "typewriter" => Built {
            animator: TextAnimator {
                selector: TextRangeSelector { smoothness: 0.0, ..TextRangeSelector::default() },
                opacity: Some(0.0),
                ..TextAnimator::default()
            },
            keys: vec![
                key("textAnimator.selector.start", 0.0, 0.0),
                key("textAnimator.selector.start", 2.0, 1.0),
            ],
            ease: false,
        },
        // A ramp sweeps left to right; what it has not reached is faded out and 40 down.
        "fadeUpCharacters" => Built {
            animator: TextAnimator {
                selector: range(TextRangeShape::RampUp, None, 0.5, 0.5, -1.0),
                y: 40.0,
                opacity: Some(0.0),
                ..TextAnimator::default()
            },
            keys: vec![
                key("textAnimator.selector.offset", 0.0, -1.0),
                key("textAnimator.selector.offset", 1.5, 1.0),
            ],
            ease: true,
        },
        // No selector in EffectCraft: every glyph is fully selected, and the animator's own
        // tracking (400 thousandths of an em, as pixels for this text) and opacity move.
        "trackingIn" => Built {
            animator: TextAnimator {
                tracking: Some(0.0),
                opacity: Some(1.0),
                ..TextAnimator::default()
            },
            keys: vec![
                key("textAnimator.tracking", 0.0, 400.0 / 1000.0 * size),
                key("textAnimator.tracking", 1.6, 0.0),
                key("textAnimator.opacity", 0.0, 0.0),
                key("textAnimator.opacity", 0.8, 1.0),
            ],
            ease: true,
        },
        // Lines, not characters: each line drops 120 with a slight turn while it fades in.
        "dropInLines" => Built {
            animator: TextAnimator {
                selector: range(TextRangeShape::RampUp, Some(TextRangeBasis::Lines), 0.8, 0.0, -1.0),
                y: -120.0,
                rotation: -8.0,
                opacity: Some(0.0),
                ..TextAnimator::default()
            },
            keys: vec![
                key("textAnimator.selector.offset", 0.0, -1.0),
                key("textAnimator.selector.offset", 1.4, 1.0),
            ],
            ease: true,
        },
        _ => return None,
    })
}

/// Put a preset on a text: replace its animator (and the keys of the animator it had) with the
/// preset's animator, then key it from `at_frame`. Returns the length of the preset in frames,
/// from `at_frame` to its last key.
///
/// A key that cannot land (past the end of the timeline, or on the frame another key of the same
/// property already holds because the rate is too low to tell them apart) refuses the whole
/// preset; the caller applies it on a copy, as `apply_edits` does.
pub fn apply(
    scene: &mut SceneDocument,
    object_id: &str,
    listing_id: &str,
    at_frame: u64,
) -> Result<u64, Refusal> {
    let name = preset_name(listing_id).ok_or_else(|| Refusal::MotionPresetUnknown {
        preset: listing_id.to_owned(),
    })?;
    if let Some(reason) = unavailable_reason(listing_id) {
        return Err(Refusal::ScenePropertyNotDrawable {
            object: object_id.to_owned(),
            property: format!("text animator preset {name}: {reason}"),
            owner: OWNER.to_owned(),
        });
    }
    let targets = [object_id.to_owned()];
    // Removing first names a missing or non-text object and clears the old animator's keys, so
    // the preset never inherits a key of another animator.
    animation::set_text_animator(scene, &targets, None)?;
    let Some(size) = scene.objects.iter().find_map(|object| match object {
        SceneObject::Text(text) if text.base.id == object_id => Some(text.size),
        _ => None,
    }) else {
        unreachable!("set_text_animator found a text object named {object_id}");
    };
    let built = build(name, size).expect("a preset that is not unavailable is built");
    animation::set_text_animator(scene, &targets, Some(&built.animator))?;
    let easing = if built.ease { SceneEasing::EaseInOut } else { SceneEasing::Linear };
    let rate = scene.canvas.frame_rate;
    let mut taken: Vec<(&str, u64)> = Vec::new();
    let mut length = 0;
    for key in &built.keys {
        let offset = (key.seconds * f64::from(rate.num) / f64::from(rate.den)).round() as u64;
        let frame = at_frame + offset;
        if taken.contains(&(key.property, frame)) {
            return Err(Refusal::DuplicateKeyframeFrame {
                object: object_id.to_owned(),
                property: key.property.to_owned(),
                frame,
            });
        }
        taken.push((key.property, frame));
        animation::set_keyframe(
            scene,
            object_id,
            key.property,
            SceneKeyframe { frame, value: key.value, easing, bezier: None },
        )?;
        length = length.max(offset);
    }
    Ok(length)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::witness::fixture_scene;
    use crate::command::{apply_edits, ApplyTextAnimatorPreset, EditContext, EditEffect, SceneEdit};
    use crate::text_animator::ANIMATOR_PROPERTIES;
    use crate::RationalRate;

    /// The witness scene at 50 frames a second and 10 seconds long, holding the text `text`.
    fn scene() -> SceneDocument {
        let mut scene = fixture_scene();
        scene.canvas.frame_rate = RationalRate::P50;
        scene.timeline.duration_frames = 500;
        scene
    }

    fn listing(name: &str) -> String {
        format!("{ID_PREFIX}{name}")
    }

    fn animator_of(scene: &SceneDocument) -> TextAnimator {
        scene
            .objects
            .iter()
            .find_map(|object| match object {
                SceneObject::Text(text) if text.base.id == "text" => text.text_animator.clone(),
                _ => None,
            })
            .expect("the text holds an animator")
    }

    fn keys_of(scene: &SceneDocument, property: &str) -> Vec<(u64, f64)> {
        scene
            .timeline
            .channels
            .iter()
            .filter(|channel| channel.object_id == "text" && channel.property == property)
            .flat_map(|channel| channel.keys.iter().map(|key| (key.frame, key.value)))
            .collect()
    }

    #[test]
    fn each_of_the_eight_is_built_or_named_unavailable_and_never_both() {
        assert_eq!(EFFECTCRAFT_PRESETS.len(), 8);
        let mut available = 0;
        for (id, _, _) in EFFECTCRAFT_PRESETS {
            let built = build(id, 40.0);
            let reason = unavailable_reason(&listing(id));
            assert_eq!(built.is_some(), reason.is_none(), "{id}: built xor unavailable");
            available += usize::from(built.is_some());
        }
        assert_eq!(available, 4, "typewriter, fadeUpCharacters, trackingIn, dropInLines");
        assert_eq!(unavailable_reason("ec.textanimator.nope"), None);
        assert_eq!(unavailable_reason("typewriter"), None, "a listing id carries the prefix");
    }

    #[test]
    fn what_an_available_preset_writes_is_valid_and_uses_only_animator_properties() {
        for (id, _, _) in EFFECTCRAFT_PRESETS {
            let Some(built) = build(id, 40.0) else { continue };
            built.animator.validate().unwrap_or_else(|detail| panic!("{id}: {detail}"));
            assert!(!built.keys.is_empty(), "{id}");
            for key in &built.keys {
                assert!(ANIMATOR_PROPERTIES.contains(&key.property), "{id}: {}", key.property);
                assert!(key.seconds >= 0.0 && key.value.is_finite(), "{id}");
            }
        }
    }

    #[test]
    fn typewriter_sweeps_the_range_start_across_two_seconds_in_a_straight_line() {
        let mut scene = scene();
        let length = apply(&mut scene, "text", &listing("typewriter"), 10).unwrap();
        assert_eq!(length, 100, "two seconds at 50 a second");
        assert_eq!(keys_of(&scene, "textAnimator.selector.start"), vec![(10, 0.0), (110, 1.0)]);
        let animator = animator_of(&scene);
        assert_eq!(animator.opacity, Some(0.0));
        assert_eq!(animator.selector.smoothness, 0.0, "hard-edged");
        let channel = &scene.timeline.channels[0];
        assert!(channel.keys.iter().all(|key| key.easing == SceneEasing::Linear));
        let at = |frame| animation::evaluate_channel(channel, frame).unwrap().unwrap();
        assert_eq!(at(10), 0.0);
        assert!((at(60) - 0.5).abs() < 1e-9, "halfway through the sweep");
        assert_eq!(at(110), 1.0);
    }

    #[test]
    fn fade_up_and_drop_in_sweep_the_offset_with_an_ease_and_carry_their_own_geometry() {
        let mut scene = scene();
        assert_eq!(apply(&mut scene, "text", &listing("fadeUpCharacters"), 0).unwrap(), 75);
        let animator = animator_of(&scene);
        assert_eq!((animator.y, animator.opacity), (40.0, Some(0.0)));
        assert_eq!(animator.selector.shape, TextRangeShape::RampUp);
        assert_eq!((animator.selector.ease_high, animator.selector.ease_low), (0.5, 0.5));
        assert_eq!(keys_of(&scene, "textAnimator.selector.offset"), vec![(0, -1.0), (75, 1.0)]);
        assert!(scene.timeline.channels[0].keys.iter().all(|key| key.easing == SceneEasing::EaseInOut));

        // The next preset replaces the animator and the keys of the one before it.
        assert_eq!(apply(&mut scene, "text", &listing("dropInLines"), 20).unwrap(), 70);
        let animator = animator_of(&scene);
        assert_eq!(animator.selector.basis, Some(TextRangeBasis::Lines));
        assert_eq!((animator.y, animator.rotation), (-120.0, -8.0));
        assert_eq!(keys_of(&scene, "textAnimator.selector.offset"), vec![(20, -1.0), (90, 1.0)]);
        assert_eq!(scene.timeline.channels.len(), 1, "no key of the first preset is left behind");
    }

    #[test]
    fn tracking_in_converts_thousandths_of_an_em_into_pixels_for_the_text_it_lands_on() {
        let mut scene = scene();
        for object in &mut scene.objects {
            if let SceneObject::Text(text) = object {
                text.size = 50.0;
            }
        }
        apply(&mut scene, "text", &listing("trackingIn"), 0).unwrap();
        assert_eq!(keys_of(&scene, "textAnimator.tracking"), vec![(0, 20.0), (80, 0.0)], "0.4 em of 50 is 20 px");
        assert_eq!(keys_of(&scene, "textAnimator.opacity"), vec![(0, 0.0), (40, 1.0)]);
        // The same preset on a text twice the size spaces twice as wide.
        for object in &mut scene.objects {
            if let SceneObject::Text(text) = object {
                text.size = 100.0;
            }
        }
        apply(&mut scene, "text", &listing("trackingIn"), 0).unwrap();
        assert_eq!(keys_of(&scene, "textAnimator.tracking")[0], (0, 40.0));
    }

    #[test]
    fn an_unavailable_preset_refuses_by_name_and_touches_nothing() {
        for (name, needle) in [
            ("bounceInWords", "second animator"),
            ("scramble", "wiggly selector"),
            ("blurIn", "blur"),
            ("jitter", "wiggly selector"),
        ] {
            let mut scene = scene();
            let before = scene.clone();
            match apply(&mut scene, "text", &listing(name), 0) {
                Err(Refusal::ScenePropertyNotDrawable { object, property, owner }) => {
                    assert_eq!((object.as_str(), owner.as_str()), ("text", "11.61"), "{name}");
                    assert!(property.contains(name) && property.contains(needle), "{name}: {property}");
                }
                other => panic!("{name}: {other:?}"),
            }
            assert_eq!(scene, before, "{name}");
        }
    }

    #[test]
    fn an_unknown_preset_or_a_target_that_is_not_text_is_refused() {
        let mut scene = scene();
        assert!(matches!(
            apply(&mut scene, "text", "ec.textanimator.teleport", 0),
            Err(Refusal::MotionPresetUnknown { preset }) if preset == "ec.textanimator.teleport"
        ));
        assert!(matches!(
            apply(&mut scene, "text", "typewriter", 0),
            Err(Refusal::MotionPresetUnknown { .. })
        ));
        assert!(matches!(
            apply(&mut scene, "card", &listing("typewriter"), 0),
            Err(Refusal::AnimationPropertyUnsupported { object, .. }) if object == "card"
        ));
        assert!(apply(&mut scene, "nothing", &listing("typewriter"), 0).is_err());
    }

    #[test]
    fn a_rate_too_low_to_tell_two_keys_apart_refuses_instead_of_dropping_one() {
        let mut scene = scene();
        scene.canvas.frame_rate = RationalRate { num: 1, den: 1000 };
        scene.timeline.duration_frames = 10;
        assert!(matches!(
            apply(&mut scene, "text", &listing("typewriter"), 0),
            Err(Refusal::DuplicateKeyframeFrame { frame: 0, .. })
        ));
    }

    #[test]
    fn as_an_edit_it_is_one_batch_that_lands_whole_or_not_at_all() {
        let edit = |at_frame| {
            SceneEdit::ApplyTextAnimatorPreset(ApplyTextAnimatorPreset {
                object_id: "text".into(),
                preset_id: listing("typewriter"),
                at_frame,
            })
        };
        let ctx = EditContext::default();
        let mut scene = scene();
        let original = scene.clone();
        let (before, effects) = apply_edits(&mut scene, &[edit(10)], &ctx).unwrap();
        assert_eq!(before, original, "the history keeps what it replaced");
        assert!(matches!(effects[0], EditEffect::PresetApplied { duration_frames: 100 }));
        assert_eq!(keys_of(&scene, "textAnimator.selector.start").len(), 2);

        // A preset that does not fit the timeline changes nothing, not even the animator.
        let mut short = original.clone();
        short.timeline.duration_frames = 60;
        let untouched = short.clone();
        assert!(apply_edits(&mut short, &[edit(10)], &ctx).is_err());
        assert_eq!(short, untouched);
    }
}
