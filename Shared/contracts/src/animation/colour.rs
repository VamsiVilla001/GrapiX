//! Solid fill and stroke keyframes, separate from scalar property channels.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{ease_at, CubicBezier, SceneEasing};
use crate::{color::Rgba, Refusal};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum ColourProperty {
    Fill,
    Stroke,
    TextAnimatorFill,
}

impl ColourProperty {
    pub(super) fn supports(self, kind: &str) -> bool {
        if self == Self::TextAnimatorFill {
            return kind == "text";
        }
        matches!(kind, "text" | "rect" | "ellipse" | "shape")
            || (kind == "line" && self == Self::Stroke)
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Fill => "fill",
            Self::Stroke => "stroke",
            Self::TextAnimatorFill => "textAnimatorFill",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColourKeyframe {
    pub frame: u64,
    pub value: Rgba,
    #[serde(default)]
    pub easing: SceneEasing,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bezier: Option<CubicBezier>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColourChannel {
    pub object_id: String,
    pub property: ColourProperty,
    pub keys: Vec<ColourKeyframe>,
}

impl ColourChannel {
    /// Sample a channel whose keys are in increasing frame order.
    /// Endpoints keep their authored values. In-between values interpolate in
    /// linear light within one set of primaries, with straight alpha.
    pub fn evaluate(&self, frame: u64) -> Result<Option<Rgba>, Refusal> {
        let upper = self.keys.partition_point(|key| key.frame <= frame);
        let Some(from) = upper.checked_sub(1).and_then(|index| self.keys.get(index)) else {
            return Ok(self.keys.first().map(|key| key.value));
        };
        let Some(to) = self.keys.get(upper).filter(|_| frame != from.frame) else {
            return Ok(Some(from.value));
        };
        let refuse = |detail: &str| Refusal::InvalidKeyframeEasing {
            object: self.object_id.clone(),
            property: self.property.name().into(),
            detail: detail.into(),
        };
        if from.value.space != to.value.space {
            return Err(refuse("solid colour keys must share a source colour space"));
        }
        let position = (frame - from.frame) as f64 / (to.frame - from.frame) as f64;
        let eased = ease_at(from.easing, from.bezier, position)
            .filter(|value| value.is_finite())
            .ok_or_else(|| refuse("invalid solid colour easing"))?;
        // A colour transition has bounded progress so Back and Elastic cannot
        // extrapolate negative coverage or generate a colour beyond its keys.
        let progress = eased.clamp(0.0, 1.0);
        if progress == 0.0 {
            return Ok(Some(from.value));
        }
        if progress == 1.0 {
            return Ok(Some(to.value));
        }
        let [from_r, from_g, from_b] = from.value.to_linear();
        let [to_r, to_g, to_b] = to.value.to_linear();
        let mix = |a: f64, b: f64| a * (1.0 - progress) + b * progress;
        Ok(Some(
            Rgba::linear(
                mix(from_r, to_r),
                mix(from_g, to_g),
                mix(from_b, to_b),
                mix(from.value.a, to.value.a),
            )
            .to_space(from.value.space),
        ))
    }
}

pub(super) fn validate(scene: &crate::scene::SceneDocument) -> Result<(), Refusal> {
    let mut seen = std::collections::HashSet::new();
    for channel in scene.timeline.colour_channels.iter().flatten() {
        let object = &channel.object_id;
        let property = channel.property.name();
        if !seen.insert((object, channel.property)) {
            return Err(Refusal::DuplicateAnimationChannel {
                object: object.clone(),
                property: property.into(),
            });
        }
        validate_channel(scene, channel)?;
    }
    Ok(())
}

fn validate_channel(
    scene: &crate::scene::SceneDocument,
    channel: &ColourChannel,
) -> Result<(), Refusal> {
    let object = &channel.object_id;
    let property = channel.property.name();
    let index = super::object_index(scene, object)?;
    let kind = scene.objects[index].kind();
    if !channel.property.supports(kind)
        || (channel.property == ColourProperty::TextAnimatorFill
            && !matches!(&scene.objects[index], crate::scene::SceneObject::Text(text) if text.text_animator.is_some()))
    {
        return Err(Refusal::AnimationPropertyUnsupported {
            object: object.clone(),
            property: property.into(),
        });
    }
    for key in &channel.keys {
        let rgba = key.value;
        if !valid_rgba(rgba) {
            return Err(Refusal::KeyframeValueOutOfDomain {
                object: object.clone(),
                property: property.into(),
                frame: key.frame,
                value: format!("{rgba:?}"),
                allowed: "finite RGB and alpha in 0..=1".into(),
            });
        }
        super::validate_key(
            scene,
            object,
            property,
            &super::SceneKeyframe {
                frame: key.frame,
                value: rgba.a,
                easing: key.easing,
                bezier: key.bezier,
            },
        )?;
    }
    for keys in channel.keys.windows(2) {
        let (from, to) = (&keys[0], &keys[1]);
        if from.frame == to.frame {
            return Err(Refusal::DuplicateKeyframeFrame {
                object: object.clone(),
                property: property.into(),
                frame: to.frame,
            });
        }
        if from.frame > to.frame {
            return Err(Refusal::AnimationKeyOrderInvalid {
                object: object.clone(),
                property: property.into(),
                previous: from.frame,
                frame: to.frame,
            });
        }
        if from.value.space != to.value.space {
            return Err(Refusal::InvalidKeyframeEasing {
                object: object.clone(),
                property: property.into(),
                detail: "solid colour keys must share a source colour space".into(),
            });
        }
    }
    Ok(())
}

pub fn create_key(
    scene: &mut crate::scene::SceneDocument,
    object: &str,
    property: ColourProperty,
    key: ColourKeyframe,
) -> Result<(), Refusal> {
    edit_channel(scene, object, property, |channel| {
        match channel
            .keys
            .binary_search_by_key(&key.frame, |key| key.frame)
        {
            Ok(_) => Err(Refusal::DuplicateKeyframeFrame {
                object: object.into(),
                property: property.name().into(),
                frame: key.frame,
            }),
            Err(index) => {
                channel.keys.insert(index, key);
                Ok(())
            }
        }
    })
}

pub fn update_key(
    scene: &mut crate::scene::SceneDocument,
    object: &str,
    property: ColourProperty,
    key: ColourKeyframe,
) -> Result<(), Refusal> {
    edit_channel(scene, object, property, |channel| {
        let index = key_index(channel, key.frame)?;
        channel.keys[index] = key;
        Ok(())
    })
}

pub fn move_key(
    scene: &mut crate::scene::SceneDocument,
    object: &str,
    property: ColourProperty,
    from: u64,
    to: u64,
) -> Result<(), Refusal> {
    edit_channel(scene, object, property, |channel| {
        let index = key_index(channel, from)?;
        if from != to {
            let mut key = channel.keys.remove(index);
            let target = match channel.keys.binary_search_by_key(&to, |key| key.frame) {
                Ok(_) => {
                    return Err(Refusal::DuplicateKeyframeFrame {
                        object: object.into(),
                        property: property.name().into(),
                        frame: to,
                    })
                }
                Err(target) => target,
            };
            key.frame = to;
            channel.keys.insert(target, key);
        }
        Ok(())
    })
}

pub fn remove_key(
    scene: &mut crate::scene::SceneDocument,
    object: &str,
    property: ColourProperty,
    frame: u64,
) -> Result<(), Refusal> {
    edit_channel(scene, object, property, |channel| {
        let index = key_index(channel, frame)?;
        channel.keys.remove(index);
        Ok(())
    })
}

fn key_index(channel: &ColourChannel, frame: u64) -> Result<usize, Refusal> {
    channel
        .keys
        .binary_search_by_key(&frame, |key| key.frame)
        .map_err(|_| Refusal::KeyframeUnknown {
            object: channel.object_id.clone(),
            property: channel.property.name().into(),
            frame,
        })
}

fn edit_channel(
    scene: &mut crate::scene::SceneDocument,
    object: &str,
    property: ColourProperty,
    edit: impl FnOnce(&mut ColourChannel) -> Result<(), Refusal>,
) -> Result<(), Refusal> {
    super::refuse_duplicate_object_ids(scene)?;
    let mut matching = scene
        .timeline
        .colour_channels
        .iter()
        .flatten()
        .enumerate()
        .filter(|(_, channel)| channel.object_id == object && channel.property == property);
    let existing = matching.next();
    if matching.next().is_some() {
        return Err(Refusal::DuplicateAnimationChannel {
            object: object.into(),
            property: property.name().into(),
        });
    }
    let mut candidate = existing
        .map(|(_, channel)| channel.clone())
        .unwrap_or_else(|| ColourChannel {
            object_id: object.into(),
            property,
            keys: Vec::new(),
        });
    validate_channel(scene, &candidate)?;
    edit(&mut candidate)?;
    validate_channel(scene, &candidate)?;
    let index = existing.map(|(index, _)| index);
    let channels = scene.timeline.colour_channels.get_or_insert_with(Vec::new);
    match index {
        Some(index) if candidate.keys.is_empty() => {
            channels.remove(index);
        }
        Some(index) => channels[index] = candidate,
        None => channels.push(candidate),
    }
    if channels.is_empty() {
        scene.timeline.colour_channels = None;
    }
    Ok(())
}

pub(crate) fn valid_rgba(colour: Rgba) -> bool {
    [colour.r, colour.g, colour.b]
        .into_iter()
        .all(f64::is_finite)
        && (0.0..=1.0).contains(&colour.a)
}

/// Apply validated solid paint channels to one evaluated scene frame.
pub fn apply(scene: &mut crate::scene::SceneDocument, frame: u64) -> Result<(), Refusal> {
    for channel in scene.timeline.colour_channels.iter().flatten() {
        let Some(color) = channel.evaluate(frame)? else {
            continue;
        };
        let index = scene
            .objects
            .iter()
            .position(|object| object.base().id == channel.object_id)
            .ok_or_else(|| Refusal::AnimationPropertyUnsupported {
                object: channel.object_id.clone(),
                property: channel.property.name().into(),
            })?;
        let object = &mut scene.objects[index];
        let target = match channel.property {
            ColourProperty::Fill => &mut object.base_mut().fill,
            ColourProperty::Stroke => &mut object.base_mut().stroke,
            ColourProperty::TextAnimatorFill => {
                if let crate::scene::SceneObject::Text(text) = object {
                    if let Some(animator) = &mut text.text_animator {
                        animator.fill = Some(color);
                        continue;
                    }
                }
                return Err(Refusal::AnimationPropertyUnsupported {
                    object: channel.object_id.clone(),
                    property: channel.property.name().into(),
                });
            }
        };
        *target = Some(crate::color::ColorValue::Solid { color });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_key_edits_preserve_the_scene_on_refusal() {
        let mut scene =
            crate::scene::new_scene("show", "Show", crate::color::WorkingColorSpace::NEW_PROJECT);
        scene.timeline.duration_frames = 20;
        let object = crate::authoring::create_object(&mut scene, "rect", "Plate").unwrap();
        let property = ColourProperty::Stroke;
        let key = |frame, value| ColourKeyframe {
            frame,
            value,
            easing: SceneEasing::Hold,
            bezier: None,
        };
        let red = Rgba::srgb(1.0, 0.0, 0.0, 1.0);
        let blue = Rgba::srgb(0.0, 0.0, 1.0, 1.0);
        create_key(&mut scene, &object, property, key(15, red)).unwrap();
        create_key(&mut scene, &object, property, key(5, blue)).unwrap();
        let before = scene.clone();
        assert!(create_key(&mut scene, &object, property, key(5, red)).is_err());
        assert!(move_key(&mut scene, &object, property, 5, 15).is_err());
        assert!(move_key(&mut scene, &object, property, 5, 21).is_err());
        assert!(update_key(&mut scene, &object, property, key(0, red)).is_err());
        assert_eq!(scene, before);
        move_key(&mut scene, &object, property, 5, 10).unwrap();
        update_key(&mut scene, &object, property, key(10, red)).unwrap();
        let channel = &scene.timeline.colour_channels.as_ref().unwrap()[0];
        assert_eq!(channel.keys[0], key(10, red));
        let duplicate = crate::authoring::duplicate_object(&mut scene, &object).unwrap();
        assert_eq!(scene.timeline.colour_channels.as_ref().unwrap().len(), 2);
        let duplicate_id = scene.timeline.colour_channels.as_ref().unwrap()[1]
            .object_id
            .clone();
        assert_ne!(duplicate_id, object);
        let _ = duplicate;
        crate::authoring::delete_object(&mut scene, &duplicate_id).unwrap();
        assert_eq!(scene.timeline.colour_channels.as_ref().unwrap().len(), 1);
        remove_key(&mut scene, &object, property, 10).unwrap();
        remove_key(&mut scene, &object, property, 15).unwrap();
        assert!(scene.timeline.colour_channels.is_none());
    }

    #[test]
    fn solid_colour_keys_round_trip_and_interpolate_in_linear_light() {
        let mut channel = ColourChannel {
            object_id: "caption".into(),
            property: ColourProperty::Fill,
            keys: vec![
                ColourKeyframe {
                    frame: 10,
                    value: Rgba::srgb(1.0, 0.0, 0.0, 1.0),
                    easing: SceneEasing::Linear,
                    bezier: None,
                },
                ColourKeyframe {
                    frame: 20,
                    value: Rgba::srgb(0.0, 0.0, 1.0, 0.5),
                    easing: SceneEasing::Linear,
                    bezier: None,
                },
            ],
        };
        let json = serde_json::to_vec(&channel).unwrap();
        assert_eq!(
            serde_json::from_slice::<ColourChannel>(&json).unwrap(),
            channel
        );
        let mid = channel.evaluate(15).unwrap().unwrap();
        assert!((mid.r - crate::color::srgb_encode(0.5)).abs() < 1e-12);
        assert_eq!(mid.g, 0.0);
        assert_eq!(mid.r, mid.b);
        assert_eq!(mid.a, 0.75);
        assert_eq!(channel.evaluate(0).unwrap(), Some(channel.keys[0].value));
        assert_eq!(channel.evaluate(30).unwrap(), Some(channel.keys[1].value));
        channel.keys[0].easing = SceneEasing::Hold;
        assert_eq!(channel.evaluate(15).unwrap(), Some(channel.keys[0].value));
        assert_eq!(channel.evaluate(20).unwrap(), Some(channel.keys[1].value));
    }
}
