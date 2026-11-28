//! Indexed keyframes for an existing stroke dash pattern.

use super::{evaluate_channel, KeyframeChannel, SceneEasing, SceneKeyframe};
use crate::scene::{SceneDocument, MOST_DASH_ENTRIES};
use crate::Refusal;

pub(super) const PREFIX: &str = "strokeStyle.dash.";

pub fn index(property: &str) -> Option<usize> {
    let suffix = property.strip_prefix(PREFIX)?;
    if suffix.is_empty()
        || (suffix.starts_with('0') && suffix.len() > 1)
        || !suffix.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    suffix
        .parse::<usize>()
        .ok()
        .filter(|&index| index < MOST_DASH_ENTRIES)
}

pub(super) fn validate_pattern(
    scene: &SceneDocument,
    object_id: &str,
    replacement: Option<(&str, &[SceneKeyframe])>,
) -> Result<(), Refusal> {
    let object = &scene.objects[super::object_index(scene, object_id)?];
    let Some(style) = &object.base().stroke_style else {
        return Ok(());
    };
    let candidate = replacement.map(|(property, keys)| KeyframeChannel {
        object_id: object_id.into(),
        property: property.into(),
        keys: keys.to_vec(),
    });
    let mut channels = vec![None; style.dash.len()];
    for channel in scene
        .timeline
        .channels
        .iter()
        .filter(|channel| {
            channel.object_id == object_id
                && replacement.is_none_or(|(property, _)| channel.property != property)
        })
        .chain(candidate.iter())
    {
        if let Some(entry) = index(&channel.property).filter(|&entry| entry < channels.len()) {
            if !channel.keys.is_empty() {
                channels[entry] = Some(channel);
            }
        }
    }
    let refuse = |frame, value: f64| Refusal::KeyframeValueOutOfDomain {
        object: object_id.into(),
        property: "strokeStyle.dash".into(),
        frame,
        value: value.to_string(),
        allowed: "a finite, positive total dash length".into(),
    };
    let base_total: f64 = style.dash.iter().sum();
    if !base_total.is_finite() || base_total <= 0.0 {
        return Err(refuse(0, base_total));
    }
    let bounded = |key: &SceneKeyframe| {
        !matches!(key.easing, SceneEasing::Elastic | SceneEasing::CustomBezier)
    };
    if channels
        .iter()
        .flatten()
        .flat_map(|channel| &channel.keys)
        .all(bounded)
    {
        let maximum: f64 = channels
            .iter()
            .zip(&style.dash)
            .map(|(channel, &base)| {
                channel.map_or(base, |channel| {
                    channel.keys.iter().map(|key| key.value).fold(0.0, f64::max)
                })
            })
            .sum();
        let never_zero = channels.iter().zip(&style.dash).any(|(channel, &base)| {
            channel.map_or(base > 0.0, |channel| {
                channel.keys.iter().all(|key| key.value > 0.0)
            })
        });
        if never_zero && maximum.is_finite() {
            return Ok(());
        }
    }
    let frames = channels
        .iter()
        .flatten()
        .flat_map(|channel| channel.keys.iter().map(|key| key.frame));
    let (first, last) = frames.fold((u64::MAX, 0), |(first, last), frame| {
        (first.min(frame), last.max(frame))
    });
    for frame in first..=last {
        let mut total = 0.0;
        for (channel, &base) in channels.iter().zip(&style.dash) {
            total += match channel {
                Some(channel) => evaluate_channel(channel, frame)?.unwrap_or(base),
                None => base,
            };
        }
        if !total.is_finite() || total <= 0.0 {
            return Err(refuse(frame, total));
        }
    }
    Ok(())
}
