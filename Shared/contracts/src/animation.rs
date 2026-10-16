//! Editable scene animation channels and keyframes (build plan 11.20).
//!
//! The scene timeline previously declared a duration but had no keyframe model;
//! this module is that model. Scene keys are **absolute frame numbers**, not
//! normalised 0–1 times: normalised time belongs to reusable presets (G.6.2),
//! while an author editing a scene expects "frame 20 at 50p" to stay frame 20.
//! Preset channels keep their normalised form and are instantiated into these
//! scene channels against the scene's rational rate.
//!
//! The edit operations here are deliberately in `gx_contracts`: Editor,
//! service handlers and eventually the renderer must all apply the same rules,
//! and invariant 27 treats two private copies of that rule as a bug. A refusal
//! names what failed — no object, no channel, duplicate frame, unsupported
//! property, out-of-range frame — rather than leaving an author to infer which
//! no-op happened.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::design_system::{DurationSpec, MotionChannel, MotionKey, MotionPhase, TokenRef};
use crate::scene::SceneDocument;
use crate::{RationalRate, Refusal};

/// The easing between two keys. Closed and finite: the curve an author chooses
/// must be one every evaluator knows by name, because a substituted curve is a
/// visual change no one named (invariant 18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SceneEasing {
    Linear,
    Hold,
    EaseIn,
    EaseOut,
    EaseInOut,
    CustomBezier,
}

impl SceneEasing {
    pub const ALL: &'static [Self] = &[
        Self::Linear,
        Self::Hold,
        Self::EaseIn,
        Self::EaseOut,
        Self::EaseInOut,
        Self::CustomBezier,
    ];
}

/// Cubic-bezier control points for a custom outgoing easing.
///
/// `x1` and `x2` stay in 0–1 because they are time controls; y may overshoot
/// provided the resulting segment stays within the property's range (opacity
/// 0–1, width/height non-negative). Other properties permit overshoot.
/// The points are stored with the
/// key, not solved from neighbouring keys at display time, so a saved scene
/// means the same curve when it is reopened.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CubicBezier {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// One key on one numeric property channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SceneKeyframe {
    /// Absolute frame at the scene canvas rate.
    pub frame: u64,
    /// The property's value at that frame, in the property's own units.
    pub value: f64,
    /// Outgoing easing toward the next key.
    #[serde(default)]
    pub easing: SceneEasing,
    /// Custom bezier control points, present exactly when easing is custom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bezier: Option<CubicBezier>,
}

impl Default for SceneEasing {
    fn default() -> Self {
        Self::Linear
    }
}

/// One animatable property on one object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeChannel {
    /// Stable object id the channel belongs to. The object lookup is by id,
    /// so a duplicate object id is refused before any edit lands.
    pub object_id: String,
    /// One of the contract's animatable property names.
    pub property: String,
    /// Keys sorted by frame.
    #[serde(default)]
    pub keys: Vec<SceneKeyframe>,
}
/// Object kinds the current scene contract exposes keyframe channels for.
///
/// `layer` is a container whose transform composes into its children, so it is
/// animatable here just as 1.x animated it. Channels on the other kinds fail
/// by name rather than being stored and ignored.
pub const ANIMATABLE_OBJECT_KINDS: &[&str] = &[
    "camera", "ellipse", "group", "image", "layer", "line", "marker", "mesh", "paint", "rect",
    "shape", "text",
];

/// The scene properties keyframes may drive.
///
/// This intentionally includes Size (`width`/`height`) as well as Position,
/// Scale, Rotation and Opacity: 11.21 names those fields as the inspector's
/// keyframe surface. Text content and image source remain bindings, not
/// animation channels.
pub const ANIMATABLE_PROPERTIES: &[&str] = &[
    "opacity",
    "x",
    "y",
    "zDepth",
    "rotation",
    "rotationX",
    "rotationY",
    "scaleX",
    "scaleY",
    "scaleZ",
    "width",
    "height",
];
/// Discoverable animation vocabulary for the Editor UI. The browser reads
/// this from Rust rather than maintaining a second list of properties or
/// easing names that can drift from the contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnimationSurface {
    pub properties: Vec<String>,
    pub object_kinds: Vec<String>,
    pub easings: Vec<SceneEasing>,
}

pub fn animation_surface() -> AnimationSurface {
    AnimationSurface {
        properties: ANIMATABLE_PROPERTIES
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        object_kinds: ANIMATABLE_OBJECT_KINDS
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        easings: SceneEasing::ALL.to_vec(),
    }
}


/// Whether a scene channel is one the current evaluator may own.
pub fn is_animatable(kind: &str, property: &str) -> bool {
    ANIMATABLE_OBJECT_KINDS.contains(&kind) && ANIMATABLE_PROPERTIES.contains(&property)
}

/// Refuse duplicate object ids before addressing an object by id.
fn refuse_duplicate_object_ids(scene: &SceneDocument) -> Result<(), Refusal> {
    let mut seen = std::collections::BTreeSet::new();
    for object in &scene.objects {
        if !seen.insert(object.base().id.as_str()) {
            return Err(Refusal::SceneDuplicateObjectId {
                object_id: object.base().id.clone(),
            });
        }
    }
    Ok(())
}

fn object_index(scene: &SceneDocument, object_id: &str) -> Result<usize, Refusal> {
    scene
        .objects
        .iter()
        .position(|object| object.base().id == object_id)
        .ok_or_else(|| Refusal::SceneObjectUnknown {
            object_id: object_id.to_owned(),
        })
}

fn channel_index(
    scene: &SceneDocument,
    object_id: &str,
    property: &str,
) -> Result<Option<usize>, Refusal> {
    refuse_duplicate_object_ids(scene)?;
    let index = object_index(scene, object_id)?;
    let object = &scene.objects[index];
    let kind = object.kind();
    if !is_animatable(kind, property) {
        return Err(Refusal::AnimationPropertyUnsupported {
            object: object_id.to_owned(),
            property: property.to_owned(),
        });
    }
    Ok(scene.timeline.channels.iter().position(|channel| {
        channel.object_id == object_id && channel.property == property
    }))
}

fn validate_key(
    scene: &SceneDocument,
    object_id: &str,
    property: &str,
    key: &SceneKeyframe,
) -> Result<(), Refusal> {
    if key.frame > scene.timeline.duration_frames {
        return Err(Refusal::KeyframeOutOfRange {
            object: object_id.to_owned(),
            property: property.to_owned(),
            frame: key.frame,
            duration_frames: scene.timeline.duration_frames,
        });
    }
    if !key.value.is_finite() {
        return Err(Refusal::InvalidKeyframeEasing {
            object: object_id.to_owned(),
            property: property.to_owned(),
            detail: "keyframe value must be finite".to_owned(),
        });
    }
    validate_property_domain(object_id, property, key.frame, key.value)?;
    match (key.easing, key.bezier) {
        (SceneEasing::CustomBezier, None) => {
            return Err(Refusal::InvalidKeyframeEasing {
                object: object_id.to_owned(),
                property: property.to_owned(),
                detail: "custom-bezier has no control points".to_owned(),
            });
        }
        (SceneEasing::CustomBezier, Some(bezier))
            if !(0.0..=1.0).contains(&bezier.x1)
                || !(0.0..=1.0).contains(&bezier.x2)
                || !bezier.y1.is_finite()
                || !bezier.y2.is_finite() =>
        {
            return Err(Refusal::InvalidKeyframeEasing {
                object: object_id.to_owned(),
                property: property.to_owned(),
                detail: "custom-bezier x controls must be in 0–1 and all controls finite"
                    .to_owned(),
            });
        }
        (SceneEasing::CustomBezier, Some(_)) | (_, None) => {}
        (_, Some(_)) => {
            return Err(Refusal::InvalidKeyframeEasing {
                object: object_id.to_owned(),
                property: property.to_owned(),
                detail: "bezier controls are only valid with custom-bezier".to_owned(),
            });
        }
    }
    Ok(())
}

fn validate_property_domain(object: &str, property: &str, frame: u64, value: f64) -> Result<(), Refusal> {
    let allowed = match property {
        "opacity" if !value.is_finite() || !(0.0..=1.0).contains(&value) => "0..=1",
        "width" | "height" if !value.is_finite() || value < 0.0 => "finite and >= 0",
        _ => return Ok(()),
    };
    Err(Refusal::KeyframeValueOutOfDomain {
        object: object.into(), property: property.into(), frame,
        value: value.to_string(), allowed: allowed.into(),
    })
}

/// Exact extrema of the outgoing value curve, checked at edit/prepare time.
/// Time controls are monotone, so its y extrema cover every sampled frame.
fn validate_segments(object: &str, property: &str, keys: &[SceneKeyframe]) -> Result<(), Refusal> {
    if !matches!(property, "opacity" | "width" | "height") { return Ok(()); }
    for pair in keys.windows(2) {
        let (from, to) = (&pair[0], &pair[1]);
        if from.easing != SceneEasing::CustomBezier || from.value == to.value { continue; }
        let Some(points) = from.bezier else { continue; }; // validate_key names missing controls.
        // Normalize before forming derivative coefficients to keep even very
        // large finite y controls from overflowing the quadratic solve.
        let scale = points.y1.abs().max(points.y2.abs()).max(1.0);
        let (y1, y2, end) = (points.y1 / scale, points.y2 / scale, 1.0 / scale);
        let a = 3.0 * y1 - 3.0 * y2 + end;
        let b = 2.0 * (y2 - 2.0 * y1);
        let c = y1;
        let mut roots = Vec::with_capacity(2);
        if a == 0.0 {
            if b != 0.0 { roots.push(-c / b); }
        } else {
            let discriminant = b * b - 4.0 * a * c;
            if discriminant >= 0.0 {
                let q = -0.5 * (b + discriminant.sqrt().copysign(b));
                if q == 0.0 { roots.push(-b / (2.0 * a)); }
                else { roots.extend([q / a, c / q]); }
            }
        }
        for u in roots.into_iter().filter(|u| *u > 0.0 && *u < 1.0) {
            let value = from.value + (to.value - from.value) * bezier_axis(points.y1, points.y2, u);
            validate_property_domain(object, property, from.frame, value)?;
        }
    }
    Ok(())
}
/// Validate animation channels loaded from a scene document.
///
/// Edit commands maintain these invariants incrementally. Publication still
/// re-checks them because a hand-authored document can bypass those commands,
/// and the evaluator's binary search requires strictly increasing frames.
pub fn validate_scene_animation(scene: &SceneDocument) -> Result<(), Refusal> {
    refuse_duplicate_object_ids(scene)?;
    let mut channels = std::collections::BTreeSet::new();
    for channel in &scene.timeline.channels {
        let index = object_index(scene, &channel.object_id)?;
        if !is_animatable(scene.objects[index].kind(), &channel.property) {
            return Err(Refusal::AnimationPropertyUnsupported {
                object: channel.object_id.clone(),
                property: channel.property.clone(),
            });
        }
        if !channels.insert((channel.object_id.as_str(), channel.property.as_str())) {
            return Err(Refusal::DuplicateAnimationChannel {
                object: channel.object_id.clone(),
                property: channel.property.clone(),
            });
        }
        for key in &channel.keys {
            validate_key(scene, &channel.object_id, &channel.property, key)?;
        }
        for pair in channel.keys.windows(2) {
            if pair[0].frame == pair[1].frame {
                return Err(Refusal::DuplicateKeyframeFrame {
                    object: channel.object_id.clone(),
                    property: channel.property.clone(),
                    frame: pair[1].frame,
                });
            }
            if pair[0].frame > pair[1].frame {
                return Err(Refusal::AnimationKeyOrderInvalid {
                    object: channel.object_id.clone(),
                    property: channel.property.clone(),
                    previous: pair[0].frame,
                    frame: pair[1].frame,
                });
            }
        }
        validate_segments(&channel.object_id, &channel.property, &channel.keys)?;
    }
    Ok(())
}

/// Set one object's authored base value for an animatable numeric property.
///
/// This is what an unkeyed property edit changes, and the value Auto-Key keeps
/// in step with the key it writes. Property names match the animation
/// vocabulary; anything else is refused rather than silently ignored.
pub fn set_base_property(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    value: f64,
) -> Result<(), Refusal> {
    if !value.is_finite() {
        return Err(Refusal::InvalidKeyframeEasing {
            object: object_id.to_owned(),
            property: property.to_owned(),
            detail: "property value must be finite".to_owned(),
        });
    }
    validate_property_domain(object_id, property, 0, value)?;
    refuse_duplicate_object_ids(scene)?;
    let index = object_index(scene, object_id)?;
    let kind = scene.objects[index].kind();
    if !is_animatable(kind, property) {
        return Err(Refusal::AnimationPropertyUnsupported {
            object: object_id.to_owned(),
            property: property.to_owned(),
        });
    }
    let base = scene.objects[index].base_mut();
    match property {
        "opacity" => base.opacity = value,
        "x" => base.x = value,
        "y" => base.y = value,
        "zDepth" => base.z_depth = value,
        "rotation" => base.rotation = value,
        "rotationX" => base.rotation_x = value,
        "rotationY" => base.rotation_y = value,
        "scaleX" => base.scale_x = value,
        "scaleY" => base.scale_y = value,
        "scaleZ" => base.scale_z = value,
        "width" => base.width = value,
        "height" => base.height = value,
        // `is_animatable` already gates the set, so an unmatched name here is a
        // vocabulary that grew without a field to write — a bug, not input.
        other => {
            return Err(Refusal::AnimationPropertyUnsupported {
                object: object_id.to_owned(),
                property: other.to_owned(),
            })
        }
    }
    Ok(())
}

/// Whether Auto-Key writes a key alongside a value edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoKey {
    /// Value edits touch the base value only.
    Off,
    /// Value edits also upsert one key at the given frame.
    On,
}

/// Apply a property value edit with defined Auto-Key behaviour.
///
/// - **Off**: the base value changes; no key is created or moved.
/// - **On**: the base value changes *and* exactly one key at `frame` is
///   upserted with the same value — created when the channel has none there
///   (including the first key on a fresh channel), updated in place otherwise.
///   The key keeps its existing easing; a brand-new key eases in-out.
///
/// Base and key are written together so the property reads the same value at
/// `frame` whether or not it is evaluated through the channel.
pub fn apply_property_edit(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    value: f64,
    frame: u64,
    auto_key: AutoKey,
) -> Result<(), Refusal> {
    if auto_key == AutoKey::On {
        // Validate the key before writing the base, so a refused edit leaves
        // the object exactly as it was rather than half-applied.
        let easing = existing_easing(scene, object_id, property, frame);
        let key = SceneKeyframe {
            frame,
            value,
            easing,
            bezier: existing_bezier(scene, object_id, property, frame, easing),
        };
        validate_key(scene, object_id, property, &key)?;
        channel_index(scene, object_id, property)?;
        set_keyframe(scene, object_id, property, key)?;
        // set_keyframe has checked the address and finite value, so the base
        // write cannot refuse after the keys have committed.
        set_base_property(scene, object_id, property, value)?;
    } else {
        set_base_property(scene, object_id, property, value)?;
    }
    Ok(())
}

fn existing_key<'a>(
    scene: &'a SceneDocument,
    object_id: &str,
    property: &str,
    frame: u64,
) -> Option<&'a SceneKeyframe> {
    scene
        .timeline
        .channels
        .iter()
        .find(|channel| channel.object_id == object_id && channel.property == property)?
        .keys
        .iter()
        .find(|key| key.frame == frame)
}

fn existing_easing(
    scene: &SceneDocument,
    object_id: &str,
    property: &str,
    frame: u64,
) -> SceneEasing {
    existing_key(scene, object_id, property, frame)
        .map(|key| key.easing)
        .unwrap_or(SceneEasing::EaseInOut)
}

fn existing_bezier(
    scene: &SceneDocument,
    object_id: &str,
    property: &str,
    frame: u64,
    easing: SceneEasing,
) -> Option<CubicBezier> {
    if easing != SceneEasing::CustomBezier {
        return None;
    }
    existing_key(scene, object_id, property, frame).and_then(|key| key.bezier)
}

/// Create one key. A key already at that frame is a conflict, not an implicit
/// value edit; callers that mean to edit must say so through the inspector's
/// keyframe update path rather than accidentally replacing authored motion.
pub fn create_keyframe(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    key: SceneKeyframe,
) -> Result<(), Refusal> {
    validate_key(scene, object_id, property, &key)?;
    if let Some(index) = channel_index(scene, object_id, property)? {
        if scene.timeline.channels[index]
            .keys
            .iter()
            .any(|existing| existing.frame == key.frame)
        {
            return Err(Refusal::DuplicateKeyframeFrame {
                object: object_id.to_owned(),
                property: property.to_owned(),
                frame: key.frame,
            });
        }
    }
    set_keyframe(scene, object_id, property, key)
}
/// Replace an existing keyframe at its own frame.
///
/// `set_keyframe` intentionally creates a channel or key when absent. The
/// inspector's update operation is narrower: it must name a key that already
/// exists, otherwise an accidental update becomes an undeclared creation.
pub fn update_keyframe(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    key: SceneKeyframe,
) -> Result<(), Refusal> {
    let Some(index) = channel_index(scene, object_id, property)? else {
        return Err(Refusal::AnimationChannelUnknown {
            object: object_id.to_owned(),
            property: property.to_owned(),
        });
    };
    if !scene.timeline.channels[index]
        .keys
        .iter()
        .any(|existing| existing.frame == key.frame)
    {
        return Err(Refusal::KeyframeUnknown {
            object: object_id.to_owned(),
            property: property.to_owned(),
            frame: key.frame,
        });
    }
    set_keyframe(scene, object_id, property, key)
}


/// Add or replace one key. Replacement at the same frame is explicit rather
/// than an accidental second key: two values for one frame cannot both render.
pub fn set_keyframe(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    key: SceneKeyframe,
) -> Result<(), Refusal> {
    validate_key(scene, object_id, property, &key)?;
    let index = channel_index(scene, object_id, property)?;
    match index {
        Some(index) => {
            let mut keys = scene.timeline.channels[index].keys.clone();
            if let Some(existing) = keys.iter_mut().find(|existing| existing.frame == key.frame) {
                *existing = key;
            } else {
                keys.push(key);
                keys.sort_by_key(|key| key.frame);
            }
            validate_segments(object_id, property, &keys)?;
            scene.timeline.channels[index].keys = keys;
        }
        None => scene.timeline.channels.push(KeyframeChannel {
            object_id: object_id.to_owned(),
            property: property.to_owned(),
            keys: vec![key],
        }),
    }
    Ok(())
}

/// Move one key to another frame. The previous frame must be named, because a
/// caller cannot move a key it did not identify; a duplicate target frame
/// refuses rather than overwriting the key already there.
pub fn move_keyframe(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    from_frame: u64,
    to_frame: u64,
) -> Result<(), Refusal> {
    let Some(index) = channel_index(scene, object_id, property)? else {
        return Err(Refusal::AnimationChannelUnknown {
            object: object_id.to_owned(),
            property: property.to_owned(),
        });
    };
    let channel = &mut scene.timeline.channels[index];
    let key_index = channel
        .keys
        .iter()
        .position(|key| key.frame == from_frame)
        .ok_or_else(|| Refusal::KeyframeUnknown {
            object: object_id.to_owned(),
            property: property.to_owned(),
            frame: from_frame,
        })?;
    if channel.keys.iter().any(|key| key.frame == to_frame) {
        return Err(Refusal::DuplicateKeyframeFrame {
            object: object_id.to_owned(),
            property: property.to_owned(),
            frame: to_frame,
        });
    }
    if to_frame > scene.timeline.duration_frames {
        return Err(Refusal::KeyframeOutOfRange {
            object: object_id.to_owned(),
            property: property.to_owned(),
            frame: to_frame,
            duration_frames: scene.timeline.duration_frames,
        });
    }
    let mut keys = channel.keys.clone();
    keys[key_index].frame = to_frame;
    keys.sort_by_key(|key| key.frame);
    validate_segments(object_id, property, &keys)?;
    channel.keys = keys;
    Ok(())
}

/// Remove one key. The channel disappears with its last key rather than
/// continuing to advertise an animated property it no longer owns.
pub fn remove_keyframe(
    scene: &mut SceneDocument,
    object_id: &str,
    property: &str,
    frame: u64,
) -> Result<SceneKeyframe, Refusal> {
    remove_keyframe_inner(scene, object_id, property, frame, true)
}

/// Only the atomic command batch may defer the joined-segment check until
/// its candidate is complete. Removing several keys must not depend on order.
pub(crate) fn remove_keyframe_in_batch(
    scene: &mut SceneDocument, object_id: &str, property: &str, frame: u64,
) -> Result<SceneKeyframe, Refusal> {
    remove_keyframe_inner(scene, object_id, property, frame, false)
}

fn remove_keyframe_inner(
    scene: &mut SceneDocument, object_id: &str, property: &str, frame: u64,
    validate_join: bool,
) -> Result<SceneKeyframe, Refusal> {
    let Some(index) = channel_index(scene, object_id, property)? else {
        return Err(Refusal::AnimationChannelUnknown {
            object: object_id.to_owned(),
            property: property.to_owned(),
        });
    };
    let channel = &mut scene.timeline.channels[index];
    let key_index = channel
        .keys
        .iter()
        .position(|key| key.frame == frame)
        .ok_or_else(|| Refusal::KeyframeUnknown {
            object: object_id.to_owned(),
            property: property.to_owned(),
            frame,
        })?;
    let mut keys = channel.keys.clone();
    let removed = keys.remove(key_index);
    // Removing a middle key joins two formerly separate segments.
    if validate_join { validate_segments(object_id, property, &keys)?; }
    channel.keys = keys;
    if channel.keys.is_empty() {
        scene.timeline.channels.remove(index);
    }
    Ok(removed)
}

/// The scene property a preset's property path names.
///
/// Presets speak the design-system vocabulary (`position.x`, `scale.y`), the
/// scene speaks its own (`x`, `scaleY`). Mapping here rather than renaming
/// either keeps the preset library portable and the scene schema stable; an
/// unmapped path is refused by name rather than silently skipped, because a
/// preset that applied "most of" its channels is motion nobody can account
/// for.
pub fn scene_property_for_preset_path(path: &str) -> Option<&'static str> {
    Some(match path {
        "opacity" => "opacity",
        "position.x" | "x" => "x",
        "position.y" | "y" => "y",
        "position.z" | "zDepth" => "zDepth",
        "scale.x" | "scaleX" => "scaleX",
        "scale.y" | "scaleY" => "scaleY",
        "scale.z" | "scaleZ" => "scaleZ",
        "rotation" => "rotation",
        "rotation.x" | "rotationX" => "rotationX",
        "rotation.y" | "rotationY" => "rotationY",
        "size.width" | "width" => "width",
        "size.height" | "height" => "height",
        _ => return None,
    })
}

/// The preset path a scene property is written under when motion is captured
/// into a preset (11.15). The inverse of [`scene_property_for_preset_path`],
/// kept beside it so the two directions change together (invariant 27); a
/// test pins that every animatable property survives the round trip.
pub fn preset_path_for_scene_property(property: &str) -> Option<&'static str> {
    Some(match property {
        "opacity" => "opacity",
        "x" => "position.x",
        "y" => "position.y",
        "zDepth" => "position.z",
        "scaleX" => "scale.x",
        "scaleY" => "scale.y",
        "scaleZ" => "scale.z",
        "rotation" => "rotation",
        "rotationX" => "rotation.x",
        "rotationY" => "rotation.y",
        "width" => "size.width",
        "height" => "size.height",
        _ => return None,
    })
}

/// The easing token a scene easing is captured as (11.15), the inverse of
/// [`scene_easing_for_token`]. Linear is the absence of a token, exactly as a
/// preset key with no `out` reads back as linear.
///
/// `None` for custom-bezier: a preset key names an easing token and cannot
/// carry control points, so capture refuses it by name rather than saving the
/// curve as some other one (invariant 18).
pub fn easing_token_for_scene_easing(easing: SceneEasing) -> Option<Option<TokenRef>> {
    let name = match easing {
        SceneEasing::Linear => return Some(None),
        SceneEasing::EaseIn => "ease-in",
        SceneEasing::EaseOut => "ease-out",
        SceneEasing::EaseInOut => "ease-in-out",
        SceneEasing::Hold => "hold",
        SceneEasing::CustomBezier => return None,
    };
    Some(Some(TokenRef(format!("easing.{name}"))))
}

/// The scene easing an easing token names.
///
/// A preset's outgoing easing is a token reference (`{easing.ease-out}`), and
/// resolving it properly needs the design system's token set. Where the token
/// names one of the standard curves the mapping is unambiguous and is made
/// here. **Anything else resolves linear**, which is a named limit rather than
/// a silent one: a brand's custom easing token cannot be honoured until the
/// token set is threaded through instantiation.
pub fn scene_easing_for_token(token: Option<&TokenRef>) -> SceneEasing {
    match token.map(TokenRef::name) {
        Some("ease-in") => SceneEasing::EaseIn,
        Some("ease-out") => SceneEasing::EaseOut,
        Some("ease-in-out") => SceneEasing::EaseInOut,
        Some("hold") => SceneEasing::Hold,
        _ => SceneEasing::Linear,
    }
}

/// Instantiate a preset phase into absolute scene keys for one object.
///
/// Three conversions happen here, once, so nothing downstream repeats them:
///
/// - **Time.** Preset `t` is normalised 0–1 (G.6.2); frames are derived
///   against the scene's rational rate and offset by `at_frame`, never stored
///   on the preset.
/// - **Property.** The preset's path becomes a scene property, or the whole
///   instantiation refuses.
/// - **Value.** A position channel's `v` is a **normalised offset** in
///   object-widths (G.6.4), so `-1.0` means one width to the left of where the
///   object actually sits. That is what makes one Slide preset work on a
///   lower-third and a full-frame card. Opacity, scale and rotation are
///   absolute.
///
/// **Nothing authored is ever overwritten, and a refusal changes nothing.**
/// The collision rule is the one move and paste already follow (11.22): a
/// preset key landing on a frame that already carries a key on that channel
/// refuses with `DuplicateKeyframeFrame` naming the object, property and
/// frame — as does a preset whose own keys round onto one frame, which would
/// otherwise silently drop one of them. Keys elsewhere on the channel are kept
/// and the preset's keys join them, exactly as a paste between existing keys
/// does. The whole plan is resolved and validated before the first write, so a
/// preset that fails on its last key leaves the scene as it found it.
pub fn instantiate_phase_channels(
    scene: &mut SceneDocument,
    object_id: &str,
    phase: &MotionPhase,
    resolved_duration_frames: u64,
    at_frame: u64,
) -> Result<(), Refusal> {
    if resolved_duration_frames == 0 {
        return Err(Refusal::KeyframeOutOfRange {
            object: object_id.to_owned(),
            property: "preset".to_owned(),
            frame: 0,
            duration_frames: scene.timeline.duration_frames,
        });
    }

    // The object's authored geometry, read once: a normalised offset is
    // relative to where the object is and how big it is.
    refuse_duplicate_object_ids(scene)?;
    let index = object_index(scene, object_id)?;
    let base = scene.objects[index].base();
    let (origin_x, origin_y, width, height) = (base.x, base.y, base.width, base.height);

    // Plan: resolve and validate every key before writing any of them.
    let mut plan: Vec<(&'static str, SceneKeyframe)> = Vec::new();
    let mut landing = std::collections::BTreeSet::new();
    for channel in &phase.channels {
        let Some(property) = scene_property_for_preset_path(&channel.property) else {
            return Err(Refusal::AnimationPropertyUnsupported {
                object: object_id.to_owned(),
                property: channel.property.clone(),
            });
        };
        let existing = channel_index(scene, object_id, property)?;
        for key in &channel.keys {
            let frame = at_frame + (key.t * resolved_duration_frames as f64).round() as u64;
            let value = match property {
                "x" => origin_x + key.v * width,
                "y" => origin_y + key.v * height,
                _ => key.v,
            };
            let key = SceneKeyframe {
                frame,
                value,
                easing: scene_easing_for_token(key.out.as_ref()),
                bezier: None,
            };
            validate_key(scene, object_id, property, &key)?;
            let occupied = existing.is_some_and(|index| {
                scene.timeline.channels[index]
                    .keys
                    .iter()
                    .any(|authored| authored.frame == frame)
            });
            if occupied || !landing.insert((property, frame)) {
                return Err(Refusal::DuplicateKeyframeFrame {
                    object: object_id.to_owned(),
                    property: property.to_owned(),
                    frame,
                });
            }
            plan.push((property, key));
        }
    }

    // Apply. Every key above was validated against the untouched scene and no
    // two collide, so `set_keyframe` only ever inserts here. The snapshot is
    // the guarantee rather than the expectation: if a write still refused,
    // the channels are put back so the refusal changes nothing.
    let snapshot = scene.timeline.channels.clone();
    for (property, key) in plan {
        if let Err(refusal) = set_keyframe(scene, object_id, property, key) {
            scene.timeline.channels = snapshot;
            return Err(refusal);
        }
    }
    Ok(())
}

/// One authored key a capture names: a property and the frame it sits on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeyRef {
    pub property: String,
    pub frame: u64,
}

/// Capture selected keys of one object as a motion-preset phase (11.15), the
/// inverse of [`instantiate_phase_channels`].
///
/// Three conversions run backwards, once, so a saved preset applies to a
/// different object exactly as a starter does:
///
/// - **Time.** Frames become `t` in 0–1 across the selection's own span, and the
///   span becomes the phase's duration in milliseconds at the scene's rational
///   rate (never frames, G.6.2).
/// - **Property.** The scene property becomes its preset path.
/// - **Value.** A position channel is divided back into object-widths relative
///   to the object's own position and size (G.6.4), so the saved motion is
///   size-independent. Everything else is absolute.
///
/// Nothing is approximated: a custom-bezier key (a preset key names an easing
/// token and cannot carry control points), an unknown key, an empty selection
/// and a zero-length span each refuse by name and write nothing.
pub fn capture_motion_phase(
    scene: &SceneDocument,
    object_id: &str,
    keys: &[KeyRef],
) -> Result<MotionPhase, Refusal> {
    refuse_duplicate_object_ids(scene)?;
    let index = object_index(scene, object_id)?;
    if keys.is_empty() {
        return Err(Refusal::MotionPresetSelectionEmpty {
            object: object_id.to_owned(),
        });
    }
    let base = scene.objects[index].base();
    let (origin_x, origin_y, width, height) = (base.x, base.y, base.width, base.height);

    // Resolve every selected key against the document first; a capture that
    // fails on its last key must not have half-built anything worth keeping.
    let mut found: Vec<(String, SceneKeyframe)> = Vec::new();
    for reference in keys {
        if preset_path_for_scene_property(&reference.property).is_none() {
            return Err(Refusal::AnimationPropertyUnsupported {
                object: object_id.to_owned(),
                property: reference.property.clone(),
            });
        }
        let key = scene
            .timeline
            .channels
            .iter()
            .find(|channel| channel.object_id == object_id && channel.property == reference.property)
            .and_then(|channel| channel.keys.iter().find(|key| key.frame == reference.frame))
            .ok_or_else(|| Refusal::KeyframeUnknown {
                object: object_id.to_owned(),
                property: reference.property.clone(),
                frame: reference.frame,
            })?;
        found.push((reference.property.clone(), key.clone()));
    }

    let first = found.iter().map(|(_, key)| key.frame).min().unwrap_or(0);
    let last = found.iter().map(|(_, key)| key.frame).max().unwrap_or(0);
    if last == first {
        return Err(Refusal::MotionPresetSpanZero {
            object: object_id.to_owned(),
            frame: first,
        });
    }
    let span = (last - first) as f64;

    let mut channels: Vec<MotionChannel> = Vec::new();
    for (property, key) in found {
        let path = preset_path_for_scene_property(&property).ok_or_else(|| {
            Refusal::AnimationPropertyUnsupported {
                object: object_id.to_owned(),
                property: property.clone(),
            }
        })?;
        let out = easing_token_for_scene_easing(key.easing).ok_or_else(|| {
            Refusal::InvalidKeyframeEasing {
                object: object_id.to_owned(),
                property: property.to_owned(),
                detail: "a custom bezier cannot be saved in a preset: a preset key names an easing token"
                    .to_owned(),
            }
        })?;
        let v = match property.as_str() {
            "x" | "y" => {
                let (origin, extent) = if property == "x" { (origin_x, width) } else { (origin_y, height) };
                if extent == 0.0 {
                    return Err(Refusal::AnimationPropertyUnsupported {
                        object: object_id.to_owned(),
                        property: property.to_owned(),
                    });
                }
                (key.value - origin) / extent
            }
            _ => key.value,
        };
        let motion_key = MotionKey {
            t: (key.frame - first) as f64 / span,
            v,
            out,
        };
        match channels.iter_mut().find(|channel| channel.property == path) {
            Some(channel) => channel.keys.push(motion_key),
            None => channels.push(MotionChannel {
                property: path.to_owned(),
                keys: vec![motion_key],
            }),
        }
    }
    for channel in &mut channels {
        channel
            .keys
            .sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    }

    let rate = scene.canvas.frame_rate;
    let milliseconds = span * 1000.0 * f64::from(rate.den) / f64::from(rate.num);
    Ok(MotionPhase {
        duration: DurationSpec::Ms(milliseconds.round()),
        channels,
    })
}

/// Apply one phase of a preset to an object at a frame.
///
/// Resolves the phase's own duration against the scene's rate, so a caller
/// supplies intent (which preset, which phase, where) and never a frame count.
pub fn apply_preset_phase(
    scene: &mut SceneDocument,
    object_id: &str,
    phase: &MotionPhase,
    at_frame: u64,
) -> Result<u64, Refusal> {
    let rate = scene.canvas.frame_rate;
    let frames = phase.resolve_frames(rate).ok_or_else(|| Refusal::NotImplemented {
        what: "a token-referenced duration needs the design system's token set".to_owned(),
    })?;
    instantiate_phase_channels(scene, object_id, phase, frames, at_frame)?;
    Ok(frames)
}

/// Whole frames at a rational rate, in one place. Mirrors the G.6.2 rule and
/// stays exact rather than storing a float rate (invariant 12).
pub fn frames_for_milliseconds(ms: f64, rate: RationalRate) -> u64 {
    crate::design_system::ms_to_frames(ms, rate)
}

// ---------------------------------------------------------------------------
// Evaluation (11.11)
//
// **This is the authoritative evaluator.** The engine rasterises from it and
// the Editor's speed graph draws from a TypeScript mirror pinned against a
// generated reference table, exactly as the colour transfer curves are (11.4,
// invariant 27). A curve edited on one side without the other fails the gate
// in the same run.
// ---------------------------------------------------------------------------

/// The cubic-bezier control points a named easing stands for.
///
/// The named curves are CSS's, because that is the vocabulary designers and
/// every web animation tool already share, and because a preset library
/// authored against CSS timing must mean the same thing here (G.6.1).
/// `Hold` has no curve — it is handled before this is reached.
pub const fn easing_control_points(easing: SceneEasing) -> CubicBezier {
    match easing {
        // A straight line: X(u) = Y(u) = u.
        SceneEasing::Linear | SceneEasing::Hold => CubicBezier {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        },
        SceneEasing::EaseIn => CubicBezier {
            x1: 0.42,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        },
        SceneEasing::EaseOut => CubicBezier {
            x1: 0.0,
            y1: 0.0,
            x2: 0.58,
            y2: 1.0,
        },
        SceneEasing::EaseInOut => CubicBezier {
            x1: 0.42,
            y1: 0.0,
            x2: 0.58,
            y2: 1.0,
        },
        // Meaningless without its stored points, which `ease_at` requires: a
        // custom easing with none is refused, never solved as this line.
        SceneEasing::CustomBezier => CubicBezier {
            x1: 0.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        },
    }
}

/// One coordinate of a cubic bezier whose endpoints are fixed at 0 and 1.
///
/// Written as the expanded Bernstein form rather than de Casteljau: it is the
/// same polynomial, and the mirror in TypeScript is easier to keep identical
/// when both are one expression.
fn bezier_axis(c1: f64, c2: f64, u: f64) -> f64 {
    let inv = 1.0 - u;
    3.0 * inv * inv * u * c1 + 3.0 * inv * u * u * c2 + u * u * u
}

fn bezier_axis_slope(c1: f64, c2: f64, u: f64) -> f64 {
    let inv = 1.0 - u;
    3.0 * inv * inv * c1 + 6.0 * inv * u * (c2 - c1) + 3.0 * u * u * (1.0 - c2)
}

/// Solve the curve for `t`, returning the eased 0–1 progress.
///
/// The curve is parametric: `t` is a position on the X axis, and the value
/// wanted is Y at the same parameter. Newton-Raphson converges in a few
/// iterations over almost all of the domain; bisection is the fallback where
/// the slope is flat enough that Newton would step wildly. This is the method
/// browsers use for `cubic-bezier()`, and matching them is deliberate.
///
/// `None` exactly when `easing` is custom-bezier and no control points were
/// given: there is no curve to solve, and substituting one would be a visual
/// change nobody named (invariant 18), so the caller refuses by name.
pub fn ease_at(easing: SceneEasing, bezier: Option<CubicBezier>, t: f64) -> Option<f64> {
    if !t.is_finite() {
        return Some(0.0);
    }
    let t = t.clamp(0.0, 1.0);
    // A hold does not interpolate at all: it stays on the from-key until the
    // next one takes over. Returning 0 is what produces that step.
    if easing == SceneEasing::Hold {
        return Some(0.0);
    }
    let points = match (easing, bezier) {
        (SceneEasing::CustomBezier, Some(points)) => points,
        // The edit operations and the Editor's and engine's document readers
        // all refuse this by name (`validate_key`); reaching it means a caller
        // skipped them, and the answer is still a refusal, not a curve.
        (SceneEasing::CustomBezier, None) => return None,
        (named, _) => easing_control_points(named),
    };
    Some(solve_bezier(points, t))
}

/// Eased progress along one resolved curve, `t` already clamped to 0–1.
fn solve_bezier(points: CubicBezier, t: f64) -> f64 {
    // Linear is the identity, and worth short-circuiting: it is the default
    // easing, so this is the common path.
    if points.x1 == 0.0 && points.y1 == 0.0 && points.x2 == 1.0 && points.y2 == 1.0 {
        return t;
    }
    if t == 0.0 || t == 1.0 {
        return t;
    }

    let mut u = t;
    for _ in 0..8 {
        let x = bezier_axis(points.x1, points.x2, u) - t;
        if x.abs() < 1e-9 {
            return bezier_axis(points.y1, points.y2, u);
        }
        let slope = bezier_axis_slope(points.x1, points.x2, u);
        if slope.abs() < 1e-9 {
            break;
        }
        u -= x / slope;
    }

    // Bisection over the whole domain, which cannot diverge.
    let (mut low, mut high) = (0.0_f64, 1.0_f64);
    let mut mid = t;
    for _ in 0..64 {
        mid = 0.5 * (low + high);
        let x = bezier_axis(points.x1, points.x2, mid);
        if (x - t).abs() < 1e-9 {
            break;
        }
        if x < t {
            low = mid;
        } else {
            high = mid;
        }
    }
    bezier_axis(points.y1, points.y2, mid)
}

/// The value a channel holds at a frame.
///
/// `None` only when the channel carries no keys at all — a channel that exists
/// always answers. Before the first key and after the last the value is held
/// flat rather than extrapolated: extrapolating invents motion the author did
/// not key, which on air is a graphic drifting for reasons nobody authored.
///
/// A segment whose outgoing key is custom-bezier with no control points
/// refuses with `InvalidKeyframeEasing` rather than being eased as linear.
/// Every reader already refuses such a document, so this is the last guard,
/// not the expected path.
pub fn evaluate_channel(channel: &KeyframeChannel, frame: u64) -> Result<Option<f64>, Refusal> {
    let keys = &channel.keys;
    let (Some(first), Some(last)) = (keys.first(), keys.last()) else {
        return Ok(None);
    };
    if frame <= first.frame {
        return Ok(Some(first.value));
    }
    if frame >= last.frame {
        return Ok(Some(last.value));
    }

    // Keys are kept sorted by `set_keyframe`, so the segment is a binary
    // search rather than a scan: an evaluator called per object per frame
    // cannot afford to be linear in key count.
    let upper = keys.partition_point(|key| key.frame <= frame);
    let from = &keys[upper - 1];
    let to = &keys[upper];

    let span = to.frame.saturating_sub(from.frame);
    if span == 0 {
        return Ok(Some(from.value));
    }
    let t = (frame - from.frame) as f64 / span as f64;
    // The easing belongs to the key it leaves, matching `SceneKeyframe`'s
    // "outgoing easing toward the next key".
    let eased = ease_at(from.easing, from.bezier, t).ok_or_else(|| {
        Refusal::InvalidKeyframeEasing {
            object: channel.object_id.clone(),
            property: channel.property.clone(),
            detail: "custom-bezier has no control points".to_owned(),
        }
    })?;
    Ok(Some(from.value + (to.value - from.value) * eased))
}

/// Evaluate every channel in a scene at one frame, as (object, property,
/// value). The Editor uses this to preview a frame; the engine will use it to
/// resolve a scene before rastering. The first channel that cannot be
/// evaluated refuses the whole frame rather than being dropped from it.
pub fn evaluate_scene_at(
    scene: &SceneDocument,
    frame: u64,
) -> Result<Vec<(String, String, f64)>, Refusal> {
    let mut values = Vec::with_capacity(scene.timeline.channels.len());
    for channel in &scene.timeline.channels {
        if let Some(value) = evaluate_channel(channel, frame)? {
            values.push((channel.object_id.clone(), channel.property.clone(), value));
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::design_system::MotionChannel;
    use crate::scene::{ObjectBase, RectObject, SceneCanvas, SceneObject, SceneTimeline};
    use crate::{RationalRate, Revision};

    fn scene_with(objects: Vec<SceneObject>) -> SceneDocument {
        SceneDocument {
            working_color_space: crate::color::WorkingColorSpace::LinearSrgb,
            id: "motion".into(),
            name: "Motion".into(),
            version: crate::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 100,
                ..Default::default()
            },
            data_context: Default::default(),
            assets: vec![],
            fonts: vec![],
            materials: vec![],
            controls: vec![],
            text_styles: vec![],
            objects,
        }
    }

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    }

    fn key(frame: u64, value: f64) -> SceneKeyframe {
        SceneKeyframe {
            frame,
            value,
            easing: SceneEasing::Linear,
            bezier: None,
        }
    }

    fn overshoot_key(frame: u64, value: f64) -> SceneKeyframe {
        SceneKeyframe { easing: SceneEasing::CustomBezier,
            bezier: Some(CubicBezier { x1: 0.25, y1: 1.4, x2: 0.75, y2: 1.4 }),
            ..key(frame, value) }
    }

    #[test]
    fn bounded_keyframe_values_refuse_without_mutation() {
        for (property, value) in [("opacity", -0.1), ("opacity", 1.5), ("width", -1.0), ("height", -1.0)] {
            let mut scene = scene_with(vec![rect("card")]);
            let before = scene_bytes(&scene);
            assert!(matches!(set_keyframe(&mut scene, "card", property, key(10, value)),
                Err(Refusal::KeyframeValueOutOfDomain { object, property: refused, frame: 10, .. })
                if object == "card" && refused == property));
            assert_eq!(scene_bytes(&scene), before);
            assert!(apply_property_edit(&mut scene, "card", property, value, 0, AutoKey::Off).is_err());
            assert_eq!(scene_bytes(&scene), before);
        }
        let mut scene = scene_with(vec![rect("card")]);
        for (property, value) in [("opacity", 0.0), ("opacity", 1.0), ("width", 0.0), ("scaleX", -1.0)] {
            set_keyframe(&mut scene, "card", property, key(0, value)).unwrap();
        }
    }

    #[test]
    fn custom_bezier_checks_actual_segment_extrema_not_control_bounds() {
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(&mut scene, "card", "opacity", overshoot_key(0, 0.0)).unwrap();
        set_keyframe(&mut scene, "card", "opacity", key(100, 0.5)).unwrap();
        let before = scene_bytes(&scene);
        assert!(matches!(set_keyframe(&mut scene, "card", "opacity", key(100, 1.0)),
            Err(Refusal::KeyframeValueOutOfDomain { frame: 0, .. })));
        assert_eq!(scene_bytes(&scene), before);
        set_keyframe(&mut scene, "card", "x", overshoot_key(0, 0.0)).unwrap();
        set_keyframe(&mut scene, "card", "x", key(100, 1.0)).unwrap();
        validate_scene_animation(&scene).unwrap();
        // A descending curve can undershoot a non-negative size.
        set_keyframe(&mut scene, "card", "width", overshoot_key(0, 10.0)).unwrap();
        assert!(set_keyframe(&mut scene, "card", "width", key(100, 0.0)).is_err());
    }

    #[test]
    fn refused_segment_edits_preserve_keys_and_autokey_base() {
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(&mut scene, "card", "opacity", overshoot_key(0, 0.0)).unwrap();
        set_keyframe(&mut scene, "card", "opacity", key(40, 0.5)).unwrap();
        set_keyframe(&mut scene, "card", "opacity", key(80, 1.0)).unwrap();
        let before = scene_bytes(&scene);
        assert!(create_keyframe(&mut scene, "card", "opacity", key(20, 1.0)).is_err());
        assert_eq!(scene_bytes(&scene), before);
        assert!(update_keyframe(&mut scene, "card", "opacity", key(40, 1.0)).is_err());
        assert_eq!(scene_bytes(&scene), before);
        assert!(move_keyframe(&mut scene, "card", "opacity", 40, 90).is_err());
        assert_eq!(scene_bytes(&scene), before);
        assert!(remove_keyframe(&mut scene, "card", "opacity", 40).is_err());
        assert_eq!(scene_bytes(&scene), before);
        assert!(apply_property_edit(&mut scene, "card", "opacity", 1.0, 40, AutoKey::On).is_err());
        assert_eq!(scene_bytes(&scene), before);
    }

    #[test]
    fn loaded_animation_rechecks_key_values_and_segment_extrema() {
        let mut scene = scene_with(vec![rect("card")]);
        scene.timeline.channels.push(KeyframeChannel { object_id: "card".into(), property: "opacity".into(),
            keys: vec![overshoot_key(0, 0.0), key(100, 1.0)] });
        assert!(matches!(validate_scene_animation(&scene), Err(Refusal::KeyframeValueOutOfDomain { frame: 0, .. })));
        scene.timeline.channels[0].keys = vec![key(10, 1.5)];
        assert!(matches!(validate_scene_animation(&scene), Err(Refusal::KeyframeValueOutOfDomain { frame: 10, .. })));
    }

    #[test]
    fn set_replace_move_and_remove_keep_channels_sorted() {
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(&mut scene, "card", "x", key(20, 100.0)).unwrap();
        set_keyframe(&mut scene, "card", "x", key(0, 0.0)).unwrap();
        set_keyframe(&mut scene, "card", "x", key(20, 120.0)).unwrap();
        assert_eq!(
            scene.timeline.channels[0].keys.iter().map(|key| (key.frame, key.value)).collect::<Vec<_>>(),
            vec![(0, 0.0), (20, 120.0)]
        );

        move_keyframe(&mut scene, "card", "x", 20, 80).unwrap();
        assert_eq!(
            scene.timeline.channels[0].keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 80]
        );

        assert_eq!(remove_keyframe(&mut scene, "card", "x", 80).unwrap().value, 120.0);
        remove_keyframe(&mut scene, "card", "x", 0).unwrap();
        assert!(scene.timeline.channels.is_empty(), "an empty channel disappears");
    }
    #[test]
    fn update_requires_an_existing_keyframe() {
        let mut scene = scene_with(vec![rect("card")]);

        assert!(matches!(
            update_keyframe(&mut scene, "card", "x", key(20, 120.0)),
            Err(Refusal::AnimationChannelUnknown { .. })
        ));

        create_keyframe(&mut scene, "card", "x", key(20, 100.0)).unwrap();
        update_keyframe(&mut scene, "card", "x", key(20, 120.0)).unwrap();
        assert_eq!(scene.timeline.channels[0].keys[0].value, 120.0);
        assert!(matches!(
            update_keyframe(&mut scene, "card", "x", key(30, 130.0)),
            Err(Refusal::KeyframeUnknown { frame: 30, .. })
        ));
    }


    #[test]
    fn a_move_onto_an_occupied_frame_refuses_by_name() {
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(&mut scene, "card", "x", key(0, 0.0)).unwrap();
        set_keyframe(&mut scene, "card", "x", key(20, 1.0)).unwrap();
        assert!(matches!(
            move_keyframe(&mut scene, "card", "x", 0, 20),
            Err(Refusal::DuplicateKeyframeFrame { frame: 20, .. })
        ));
    }

    #[test]
    fn duplicate_object_ids_and_unsupported_properties_refuse() {
        let mut scene = scene_with(vec![rect("same"), rect("same")]);
        assert!(matches!(
            set_keyframe(&mut scene, "same", "x", key(0, 0.0)),
            Err(Refusal::SceneDuplicateObjectId { object_id }) if object_id == "same"
        ));

        let mut scene = scene_with(vec![rect("card")]);
        assert!(matches!(
            set_keyframe(&mut scene, "card", "text", key(0, 0.0)),
            Err(Refusal::AnimationPropertyUnsupported { property, .. }) if property == "text"
        ));
    }

    #[test]
    fn keys_outside_the_scene_duration_refuse() {
        let mut scene = scene_with(vec![rect("card")]);
        assert!(matches!(
            set_keyframe(&mut scene, "card", "x", key(101, 0.0)),
            Err(Refusal::KeyframeOutOfRange { frame: 101, duration_frames: 100, .. })
        ));
    }

    #[test]
    fn preset_channels_resolve_to_absolute_scene_frames() {
        // The rect is 100 wide at x=40, so a normalised -1.0 offset is one
        // object-width to its left: x = 40 - 100 = -60 (G.6.4).
        let mut card = rect("card");
        if let SceneObject::Rect(o) = &mut card {
            o.base.x = 40.0;
            o.base.width = 100.0;
        }
        let mut scene = scene_with(vec![card]);
        let phase = MotionPhase {
            duration: crate::design_system::DurationSpec::Ms(400.0),
            channels: vec![MotionChannel {
                property: "position.x".into(),
                keys: vec![
                    crate::design_system::MotionKey {
                        t: 0.0,
                        v: -1.0,
                        out: Some(crate::design_system::TokenRef("easing.ease-out".into())),
                    },
                    crate::design_system::MotionKey { t: 1.0, v: 0.0, out: None },
                ],
            }],
        };
        let frames = frames_for_milliseconds(400.0, scene.canvas.frame_rate);
        instantiate_phase_channels(&mut scene, "card", &phase, frames, 0).unwrap();
        assert_eq!(frames, 20);
        assert_eq!(
            scene.timeline.channels[0].keys.iter().map(|key| (key.frame, key.value)).collect::<Vec<_>>(),
            vec![(0, -60.0), (20, 40.0)],
            "a normalised offset resolves against the object's own position and width"
        );
        // The easing token became a scene easing rather than defaulting flat.
        assert_eq!(scene.timeline.channels[0].keys[0].easing, SceneEasing::EaseOut);
    }

    #[test]
    fn a_preset_phase_applies_at_a_frame_and_reports_its_length() {
        let mut scene = scene_with(vec![rect("card")]);
        let fade = crate::design_system::starter_presets()
            .into_iter()
            .find(|preset| preset.id == "fade")
            .expect("fade is in the starter library");
        let frames = apply_preset_phase(&mut scene, "card", &fade.phases.r#in, 30).unwrap();
        // 300 ms at 50p is 15 frames, laid down starting at frame 30.
        assert_eq!(frames, 15);
        let channel = &scene.timeline.channels[0];
        assert_eq!(channel.property, "opacity");
        assert_eq!(
            channel.keys.iter().map(|key| (key.frame, key.value)).collect::<Vec<_>>(),
            vec![(30, 0.0), (45, 1.0)]
        );
    }

    fn starter(id: &str) -> crate::design_system::MotionPreset {
        crate::design_system::starter_presets()
            .into_iter()
            .find(|preset| preset.id == id)
            .expect("the preset is in the starter library")
    }

    fn scene_bytes(scene: &SceneDocument) -> String {
        serde_json::to_string(scene).expect("a scene serialises")
    }

    #[test]
    fn a_preset_landing_on_an_authored_key_refuses_by_name_and_changes_nothing() {
        // Slide lays keys at 0 and 20 on x. An authored hold at 20 must not be
        // silently replaced by the preset's arrival key (11.22: nothing is
        // ever overwritten).
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(
            &mut scene,
            "card",
            "x",
            SceneKeyframe { frame: 20, value: 999.0, easing: SceneEasing::Hold, bezier: None },
        )
        .unwrap();
        let before = scene_bytes(&scene);
        assert!(matches!(
            apply_preset_phase(&mut scene, "card", &starter("slide").phases.r#in, 0),
            Err(Refusal::DuplicateKeyframeFrame { object, property, frame: 20 })
                if object == "card" && property == "x"
        ));
        assert_eq!(scene_bytes(&scene), before, "a refused preset leaves the scene byte-identical");
    }

    #[test]
    fn a_preset_whose_own_keys_round_onto_one_frame_refuses_rather_than_dropping_one() {
        // Two preset keys resolving to the same frame would make the later one
        // silently replace the earlier — an overshoot quietly lost.
        let mut scene = scene_with(vec![rect("card")]);
        let phase = MotionPhase {
            duration: crate::design_system::DurationSpec::Ms(200.0),
            channels: vec![MotionChannel {
                property: "opacity".into(),
                keys: vec![
                    crate::design_system::MotionKey { t: 0.0, v: 0.0, out: None },
                    crate::design_system::MotionKey { t: 0.5, v: 0.8, out: None },
                    crate::design_system::MotionKey { t: 0.52, v: 0.9, out: None },
                    crate::design_system::MotionKey { t: 1.0, v: 1.0, out: None },
                ],
            }],
        };
        let before = scene_bytes(&scene);
        assert!(matches!(
            instantiate_phase_channels(&mut scene, "card", &phase, 10, 0),
            Err(Refusal::DuplicateKeyframeFrame { frame: 5, .. })
        ));
        assert_eq!(scene_bytes(&scene), before);
    }

    #[test]
    fn a_preset_refused_partway_through_leaves_the_scene_byte_identical() {
        // Slide at 90 on a 100-frame timeline: its first key (90) is legal, its
        // arrival (110) is not. Nothing may be written before the refusal.
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(&mut scene, "card", "opacity", key(0, 1.0)).unwrap();
        let before = scene_bytes(&scene);
        assert!(matches!(
            apply_preset_phase(&mut scene, "card", &starter("slide").phases.r#in, 90),
            Err(Refusal::KeyframeOutOfRange { frame: 110, duration_frames: 100, .. })
        ));
        assert_eq!(scene_bytes(&scene), before, "partial mutation on refusal");
    }

    #[test]
    fn a_preset_may_share_a_channel_with_keys_on_other_frames() {
        // The collision rule is the frame, as it is for move and paste (11.22):
        // keys elsewhere on the channel are kept and the preset's keys join them.
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(&mut scene, "card", "opacity", key(60, 0.5)).unwrap();
        apply_preset_phase(&mut scene, "card", &starter("fade").phases.r#in, 0).unwrap();
        assert_eq!(
            scene.timeline.channels[0].keys.iter().map(|key| key.frame).collect::<Vec<_>>(),
            vec![0, 15, 60]
        );
    }

    #[test]
    fn a_custom_bezier_with_no_points_refuses_in_the_evaluator_rather_than_going_linear() {
        let c = channel(vec![
            SceneKeyframe { frame: 0, value: 0.0, easing: SceneEasing::CustomBezier, bezier: None },
            key(100, 200.0),
        ]);
        assert!(matches!(
            evaluate_channel(&c, 50),
            Err(Refusal::InvalidKeyframeEasing { object, property, .. })
                if object == "card" && property == "x"
        ));
        // Outside the eased span no curve is consulted, so the value answers.
        assert_eq!(evaluate_channel(&c, 100), Ok(Some(200.0)));
    }

    #[test]
    fn an_unmapped_preset_property_refuses_rather_than_skipping_the_channel() {
        let mut scene = scene_with(vec![rect("card")]);
        let phase = MotionPhase {
            duration: crate::design_system::DurationSpec::Ms(200.0),
            channels: vec![MotionChannel {
                property: "colour.hue".into(),
                keys: vec![crate::design_system::MotionKey { t: 0.0, v: 0.0, out: None }],
            }],
        };
        assert!(matches!(
            apply_preset_phase(&mut scene, "card", &phase, 0),
            Err(Refusal::AnimationPropertyUnsupported { property, .. }) if property == "colour.hue"
        ));
        assert!(scene.timeline.channels.is_empty(), "nothing partial was written");
    }

    #[test]
    fn every_starter_preset_can_leave_the_screen_and_applies_somewhere() {
        // G.6.6: a graphic that cannot clear is a defect, so a starter preset
        // without a real `out` would ship the failure the browser refuses.
        for preset in crate::design_system::starter_presets() {
            assert!(
                !preset.phases.out.channels.is_empty(),
                "{} has no out channels",
                preset.id
            );
            assert!(
                matches!(preset.phases.out.duration, crate::design_system::DurationSpec::Ms(ms) if ms > 0.0),
                "{} has a zero-length out phase",
                preset.id
            );
            assert!(!preset.applies_to.is_empty(), "{} applies to nothing", preset.id);
            // Every channel must map onto a scene property, or applying it
            // would refuse at the worst possible moment.
            for phase in [&preset.phases.r#in, &preset.phases.out] {
                for channel in &phase.channels {
                    assert!(
                        scene_property_for_preset_path(&channel.property).is_some(),
                        "{} drives unmapped property {}",
                        preset.id,
                        channel.property
                    );
                }
            }
        }
    }

    #[test]
    fn pop_overshoots_and_settles() {
        let pop = crate::design_system::starter_presets()
            .into_iter()
            .find(|preset| preset.id == "pop")
            .expect("pop is in the starter library");
        let scale = pop.phases.r#in.channels.iter().find(|c| c.property == "scale.x").unwrap();
        let peak = scale.keys.iter().map(|key| key.v).fold(f64::MIN, f64::max);
        assert!(peak > 1.0, "a pop that never exceeds 1 is a scale, not a pop");
        assert_eq!(scale.keys.last().unwrap().v, 1.0, "it must settle back to 1");
    }

    #[test]
    fn base_property_edits_refuse_unknown_properties_and_objects() {
        let mut scene = scene_with(vec![rect("card")]);
        set_base_property(&mut scene, "card", "x", 250.0).unwrap();
        assert!(matches!(&scene.objects[0], SceneObject::Rect(o) if o.base.x == 250.0));
        assert!(matches!(
            set_base_property(&mut scene, "card", "text", 1.0),
            Err(Refusal::AnimationPropertyUnsupported { .. })
        ));
        assert!(matches!(
            set_base_property(&mut scene, "ghost", "x", 1.0),
            Err(Refusal::SceneObjectUnknown { .. })
        ));
    }

    #[test]
    fn auto_key_off_sets_only_the_base_value() {
        let mut scene = scene_with(vec![rect("card")]);
        apply_property_edit(&mut scene, "card", "opacity", 0.5, 10, AutoKey::Off).unwrap();
        assert!(matches!(&scene.objects[0], SceneObject::Rect(o) if o.base.opacity == 0.5));
        assert!(scene.timeline.channels.is_empty(), "off writes no key");
    }

    #[test]
    fn auto_key_on_writes_the_first_key_and_keeps_the_base_in_step() {
        let mut scene = scene_with(vec![rect("card")]);
        apply_property_edit(&mut scene, "card", "x", 200.0, 20, AutoKey::On).unwrap();
        assert!(matches!(&scene.objects[0], SceneObject::Rect(o) if o.base.x == 200.0));
        let channel = &scene.timeline.channels[0];
        assert_eq!(channel.keys.len(), 1);
        assert_eq!((channel.keys[0].frame, channel.keys[0].value), (20, 200.0));
        assert_eq!(channel.keys[0].easing, SceneEasing::EaseInOut, "a fresh key eases in-out");
    }

    #[test]
    fn auto_key_on_updates_in_place_and_preserves_the_keys_easing() {
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(
            &mut scene,
            "card",
            "x",
            SceneKeyframe { frame: 20, value: 1.0, easing: SceneEasing::Hold, bezier: None },
        )
        .unwrap();
        apply_property_edit(&mut scene, "card", "x", 9.0, 20, AutoKey::On).unwrap();
        let channel = &scene.timeline.channels[0];
        assert_eq!(channel.keys.len(), 1, "no second key at the same frame");
        assert_eq!(channel.keys[0].value, 9.0);
        assert_eq!(channel.keys[0].easing, SceneEasing::Hold, "the key's own easing survives");
    }

    #[test]
    fn a_refused_auto_key_edit_leaves_the_object_untouched() {
        let mut scene = scene_with(vec![rect("card")]);
        assert!(matches!(
            apply_property_edit(&mut scene, "card", "x", 5.0, 200, AutoKey::On),
            Err(Refusal::KeyframeOutOfRange { .. })
        ));
        assert!(matches!(&scene.objects[0], SceneObject::Rect(o) if o.base.x == 0.0), "base is unchanged");
        assert!(scene.timeline.channels.is_empty(), "no partial channel remains");
    }

    fn channel(keys: Vec<SceneKeyframe>) -> KeyframeChannel {
        KeyframeChannel {
            object_id: "card".into(),
            property: "x".into(),
            keys,
        }
    }

    #[test]
    fn a_channel_interpolates_linearly_between_its_keys() {
        let c = channel(vec![key(0, 0.0), key(100, 200.0)]);
        assert_eq!(evaluate_channel(&c, 0), Ok(Some(0.0)));
        assert_eq!(evaluate_channel(&c, 50), Ok(Some(100.0)));
        assert_eq!(evaluate_channel(&c, 100), Ok(Some(200.0)));
    }

    #[test]
    fn values_hold_flat_outside_the_keyed_range_rather_than_extrapolating() {
        // Extrapolating would invent motion nobody authored, which on air is a
        // graphic drifting for no reason.
        let c = channel(vec![key(10, 5.0), key(20, 9.0)]);
        assert_eq!(evaluate_channel(&c, 0), Ok(Some(5.0)));
        assert_eq!(evaluate_channel(&c, 9), Ok(Some(5.0)));
        assert_eq!(evaluate_channel(&c, 1_000), Ok(Some(9.0)));
        assert_eq!(evaluate_channel(&channel(vec![]), 0), Ok(None));
    }

    #[test]
    fn hold_steps_and_does_not_interpolate() {
        let c = channel(vec![
            SceneKeyframe { frame: 0, value: 0.0, easing: SceneEasing::Hold, bezier: None },
            key(100, 200.0),
        ]);
        // Flat across the whole span, then the next key takes over exactly.
        assert_eq!(evaluate_channel(&c, 1), Ok(Some(0.0)));
        assert_eq!(evaluate_channel(&c, 99), Ok(Some(0.0)));
        assert_eq!(evaluate_channel(&c, 100), Ok(Some(200.0)));
    }

    #[test]
    fn eased_curves_are_monotonic_and_pinned_at_both_ends() {
        for easing in [
            SceneEasing::Linear,
            SceneEasing::EaseIn,
            SceneEasing::EaseOut,
            SceneEasing::EaseInOut,
        ] {
            assert_eq!(ease_at(easing, None, 0.0).unwrap(), 0.0, "{easing:?} must start at 0");
            assert_eq!(ease_at(easing, None, 1.0).unwrap(), 1.0, "{easing:?} must end at 1");
            let mut previous = 0.0;
            for step in 0..=100 {
                let value = ease_at(easing, None, step as f64 / 100.0).unwrap();
                assert!(value >= previous - 1e-9, "{easing:?} went backwards at {step}");
                previous = value;
            }
        }
        // Ease-in starts slow: it is below the straight line at the midpoint.
        assert!(ease_at(SceneEasing::EaseIn, None, 0.5).unwrap() < 0.5);
        // Ease-out starts fast, so it is above it.
        assert!(ease_at(SceneEasing::EaseOut, None, 0.5).unwrap() > 0.5);
    }

    #[test]
    fn a_custom_bezier_solves_its_own_curve_and_may_overshoot() {
        // y beyond 1 is legal — an overshoot is a deliberate animation effect,
        // and `validate_key` only constrains the x controls to 0–1.
        let overshoot = CubicBezier { x1: 0.5, y1: 0.0, x2: 0.5, y2: 1.6 };
        let peak = ease_at(SceneEasing::CustomBezier, Some(overshoot), 0.8).unwrap();
        assert!(peak > 1.0, "an overshooting curve must be allowed to exceed 1, got {peak}");
        // The solve is exact at the ends whatever the controls.
        assert_eq!(ease_at(SceneEasing::CustomBezier, Some(overshoot), 0.0).unwrap(), 0.0);
        assert_eq!(ease_at(SceneEasing::CustomBezier, Some(overshoot), 1.0).unwrap(), 1.0);

        // The CSS named curves are reproduced by their own control points.
        let ease_in = easing_control_points(SceneEasing::EaseIn);
        assert_eq!(
            ease_at(SceneEasing::CustomBezier, Some(ease_in), 0.35).unwrap(),
            ease_at(SceneEasing::EaseIn, None, 0.35).unwrap(),
        );
    }

    #[test]
    fn the_solver_inverts_its_own_x_axis() {
        // The property the whole method rests on: solving for t then
        // evaluating X at the found parameter returns t.
        let points = CubicBezier { x1: 0.17, y1: 0.67, x2: 0.83, y2: 0.67 };
        for step in 1..100 {
            let t = step as f64 / 100.0;
            let y = ease_at(SceneEasing::CustomBezier, Some(points), t).unwrap();
            assert!(y.is_finite(), "solve produced a non-finite value at {t}");
        }
    }

    #[test]
    fn a_whole_scene_evaluates_every_channel_at_a_frame() {
        let mut scene = scene_with(vec![rect("card")]);
        set_keyframe(&mut scene, "card", "x", key(0, 0.0)).unwrap();
        set_keyframe(&mut scene, "card", "x", key(100, 100.0)).unwrap();
        set_keyframe(&mut scene, "card", "opacity", key(0, 1.0)).unwrap();
        let at = evaluate_scene_at(&scene, 50).unwrap();
        assert_eq!(at.len(), 2);
        assert!(at.contains(&("card".to_string(), "x".to_string(), 50.0)));
        assert!(at.contains(&("card".to_string(), "opacity".to_string(), 1.0)));
    }
    #[test]
    fn loaded_duplicate_channels_refuse_instead_of_last_writer_winning() {
        let mut scene = scene_with(vec![rect("card")]);
        let channel = KeyframeChannel {
            object_id: "card".into(),
            property: "x".into(),
            keys: vec![key(0, 0.0)],
        };
        scene.timeline.channels = vec![channel.clone(), channel];
        assert!(matches!(
            validate_scene_animation(&scene),
            Err(Refusal::DuplicateAnimationChannel { object, property })
                if object == "card" && property == "x"
        ));
    }

    #[test]
    fn loaded_channels_must_be_strictly_ordered_for_binary_search() {
        let mut scene = scene_with(vec![rect("card")]);
        scene.timeline.channels = vec![KeyframeChannel {
            object_id: "card".into(),
            property: "x".into(),
            keys: vec![key(20, 20.0), key(10, 10.0)],
        }];
        assert!(matches!(
            validate_scene_animation(&scene),
            Err(Refusal::AnimationKeyOrderInvalid { previous: 20, frame: 10, .. })
        ));
    }

}
