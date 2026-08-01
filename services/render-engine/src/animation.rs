//! Per-frame animation evaluation: the engine's scene runtime.
//!
//! Until this existed, Program rendered a **still image**. The clock advanced, frames were
//! counted and delivered, and every one of them was identical: `render_program_frame` cached
//! the prepared scene on `(scene_id, revision, bounds)` and the frame number reached the
//! renderer only as `video.frame_index` metadata. An operator saw a Program that was
//! technically on air, at the right rate, with zero dropped frames, and did not move.
//!
//! ## Why it is applied here and not by re-preparing
//!
//! The obvious fix — evaluate the document at frame N and call `prepare_scene` — is the trap
//! `scene_renderer` already documents: full preparation cost 482 ms against a 20 ms budget.
//! Preparation does text shaping, mesh tessellation and asset decode, none of which a moving
//! rectangle changes.
//!
//! So preparation stays cached on the static document, and this module patches the
//! *animatable numeric fields* of the already-prepared objects each frame. That is a clone of
//! a small `Vec<PreparedRect>` plus arithmetic — no GPU work, no shaping, no allocation of
//! anything large. A scene with no animation returns `is_empty()` and costs one branch.
//!
//! ## Parity
//!
//! The semantics mirror `evaluateSceneAtFrame` in `Shared/shared-types` exactly, because the
//! Editor viewport samples with the TS implementation and Program samples with this one. Two
//! implementations of one specification, like `Shared/tile-system` and `tile.rs`: change them
//! together, and the tests below exist to catch the drift when someone does not.
//!
//! Mirrored decisions, each of which is observable:
//!
//! - Every property is sampled **independently** across only the keys that define it.
//! - Before the first key and after the last, the value **holds** — it does not extrapolate.
//! - Segment easing comes from the **outgoing** (earlier) key.
//! - Bezier handles, when either side has one, replace the named easing.
//! - Per-property channels **win** over legacy whole-object keyframes for the same property.
//!
//! ## What is deliberately not animated here
//!
//! `zDepth` is excluded. Render order is resolved during preparation, so animating depth would
//! need a re-sort and, for meshes, a different draw order — silently moving the value without
//! reordering would look like it worked while producing wrong occlusion. Text content, image
//! sources and path geometry are likewise excluded: those genuinely require preparation, and
//! the honest answer is to re-prepare on a patch rather than to interpolate them here.

use std::collections::HashMap;

use grapix_render_core::scene::{MeshTransform, PreparedMesh};
use grapix_render_core::scene::{PreparedRect, PreparedText};
use serde_json::Value;

/// A numeric property that can be animated without re-preparing the scene.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnimatedProperty {
    X,
    Y,
    /// `zDepth`. Paint order for a 2D quad, a real Z translation for a mesh.
    Z,
    Width,
    Height,
    RotationX,
    RotationY,
    /// `rotation` and `rotationZ`: the same degree of freedom under two names.
    Rotation,
    ScaleX,
    ScaleY,
    ScaleZ,
    Opacity,
}

impl AnimatedProperty {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "x" => Some(Self::X),
            "y" => Some(Self::Y),
            "zDepth" => Some(Self::Z),
            "width" => Some(Self::Width),
            "height" => Some(Self::Height),
            "rotationX" => Some(Self::RotationX),
            "rotationY" => Some(Self::RotationY),
            "rotation" | "rotationZ" => Some(Self::Rotation),
            "scaleX" => Some(Self::ScaleX),
            "scaleY" => Some(Self::ScaleY),
            "scaleZ" => Some(Self::ScaleZ),
            "opacity" => Some(Self::Opacity),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

impl Easing {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("ease-in") => Self::EaseIn,
            Some("ease-out") => Self::EaseOut,
            Some("ease-in-out") => Self::EaseInOut,
            _ => Self::Linear,
        }
    }

    /// `easeKeyframeT` in `Shared/shared-types`.
    fn apply(self, t: f64) -> f64 {
        let c = t.clamp(0.0, 1.0);
        match self {
            Self::EaseIn => c * c,
            Self::EaseOut => 1.0 - (1.0 - c) * (1.0 - c),
            Self::EaseInOut => {
                if c < 0.5 {
                    2.0 * c * c
                } else {
                    1.0 - (-2.0 * c + 2.0).powi(2) / 2.0
                }
            }
            Self::Linear => c,
        }
    }
}

/// One key on a channel. Tangents are the temporal bezier handles from the curve editor,
/// expressed as (frames, value) offsets.
#[derive(Debug, Clone, Copy)]
struct Key {
    frame: f64,
    value: f64,
    easing: Easing,
    out_tangent: Option<(f64, f64)>,
    in_tangent: Option<(f64, f64)>,
}

/// `bezierEase` in `Shared/shared-types`: solve the temporal curve with a few Newton steps.
fn bezier_ease(t: f64, out: Option<(f64, f64)>, inn: Option<(f64, f64)>, span: f64) -> f64 {
    let x1 = (out.map(|o| o.0).unwrap_or(span / 3.0) / span).clamp(0.0, 1.0);
    let y1 = out.map(|o| o.1).unwrap_or(0.0);
    let x2 = (1.0 - inn.map(|i| i.0.abs() / span).unwrap_or(1.0 / 3.0)).clamp(0.0, 1.0);
    let y2 = 1.0 + inn.map(|i| i.1).unwrap_or(0.0);

    let curve_x =
        |u: f64| 3.0 * (1.0 - u) * (1.0 - u) * u * x1 + 3.0 * (1.0 - u) * u * u * x2 + u * u * u;
    let curve_y =
        |u: f64| 3.0 * (1.0 - u) * (1.0 - u) * u * y1 + 3.0 * (1.0 - u) * u * u * y2 + u * u * u;

    let mut u = t;
    for _ in 0..5 {
        let dx = curve_x(u) - t;
        if dx.abs() < 0.0005 {
            break;
        }
        let slope = 3.0 * (1.0 - u) * (1.0 - u) * x1
            + 6.0 * (1.0 - u) * u * (x2 - x1)
            + 3.0 * u * u * (1.0 - x2);
        if slope.abs() < 1e-6 {
            break;
        }
        u = (u - dx / slope).clamp(0.0, 1.0);
    }
    curve_y(u)
}

/// Keys for one property, sorted by frame.
#[derive(Debug, Clone, Default)]
struct Channel {
    keys: Vec<Key>,
}

impl Channel {
    /// `sampleChannel` in `Shared/shared-types`. `None` when the channel defines nothing.
    fn sample(&self, frame: f64) -> Option<f64> {
        let first = self.keys.first()?;
        let last = self.keys.last()?;

        // Hold, never extrapolate.
        if frame <= first.frame {
            return Some(first.value);
        }
        if frame >= last.frame {
            return Some(last.value);
        }

        let mut lo = first;
        let mut hi = last;
        for pair in self.keys.windows(2) {
            if pair[0].frame <= frame && frame <= pair[1].frame {
                lo = &pair[0];
                hi = &pair[1];
                break;
            }
        }

        let span = hi.frame - lo.frame;
        if span <= 0.0 {
            return Some(hi.value);
        }
        let t = (frame - lo.frame) / span;
        let eased = if lo.out_tangent.is_some() || hi.in_tangent.is_some() {
            bezier_ease(t, lo.out_tangent, hi.in_tangent, span)
        } else {
            lo.easing.apply(t)
        };
        Some(lo.value + (hi.value - lo.value) * eased)
    }
}

/// Every animated property of the scene, keyed by object then property.
#[derive(Debug, Clone, Default)]
pub struct SceneAnimation {
    objects: HashMap<String, HashMap<AnimatedProperty, Channel>>,
}

impl SceneAnimation {
    /// True when nothing is animated, so the caller can skip all per-frame work.
    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }

    /// Number of objects carrying animation. Reported in status and logs.
    pub fn animated_object_count(&self) -> usize {
        self.objects.len()
    }

    /// Read both animation models out of a `SceneDocument`.
    ///
    /// Legacy `timeline.keyframes` are read first and per-property `object.animation` channels
    /// second, so a channel replaces a legacy entry for the same property — the precedence the
    /// TypeScript evaluator applies with `{ ...legacyPatch, ...channelPatch }`.
    pub fn from_document(document: &Value) -> Self {
        let mut objects: HashMap<String, HashMap<AnimatedProperty, Channel>> = HashMap::new();

        // --- legacy whole-object keyframe snapshots ---------------------------------
        if let Some(keyframes) = document
            .pointer("/timeline/keyframes")
            .and_then(Value::as_array)
        {
            for keyframe in keyframes {
                let Some(object_id) = keyframe.get("objectId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(frame) = keyframe.get("frame").and_then(Value::as_f64) else {
                    continue;
                };
                let easing = Easing::parse(keyframe.get("easing").and_then(Value::as_str));
                let Some(properties) = keyframe.get("properties").and_then(Value::as_object) else {
                    continue;
                };

                // Sorted so precedence is deterministic rather than JSON key order: `rotation`
                // is applied before `rotationZ`, letting the 3D name win the shared axis the
                // way `rotationZ ?? rotation` does in preparation and in the Editor.
                let mut names: Vec<&String> = properties.keys().collect();
                names.sort();
                for name in names {
                    let raw = &properties[name];
                    let Some(property) = AnimatedProperty::parse(name) else {
                        continue;
                    };
                    let Some(value) = raw.as_f64() else { continue };
                    let key = Key {
                        frame,
                        value,
                        easing,
                        out_tangent: None,
                        in_tangent: None,
                    };
                    let channel = objects
                        .entry(object_id.to_string())
                        .or_default()
                        .entry(property)
                        .or_default();
                    // Replace rather than append when a key already exists at this frame.
                    // `rotation` and `rotationZ` are one axis, so a keyframe carrying both would
                    // otherwise put two keys on the same frame and make sampling depend on
                    // insertion order. Sorted names above mean the 3D name lands last and wins.
                    match channel
                        .keys
                        .iter_mut()
                        .find(|existing| existing.frame == frame)
                    {
                        Some(existing) => *existing = key,
                        None => channel.keys.push(key),
                    }
                }
            }
        }

        // --- per-property channels, which win ---------------------------------------
        if let Some(scene_objects) = document.get("objects").and_then(Value::as_array) {
            for object in scene_objects {
                let Some(object_id) = object.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(animation) = object.get("animation").and_then(Value::as_object) else {
                    continue;
                };

                // Same deterministic precedence as the legacy pass above.
                let mut names: Vec<&String> = animation.keys().collect();
                names.sort();
                for name in names {
                    let channel = &animation[name];
                    let Some(property) = AnimatedProperty::parse(name) else {
                        continue;
                    };
                    let Some(keys) = channel.get("keys").and_then(Value::as_array) else {
                        continue;
                    };

                    let mut parsed = Channel::default();
                    for key in keys {
                        let Some(frame) = key.get("frame").and_then(Value::as_f64) else {
                            continue;
                        };
                        let Some(value) = key.get("value").and_then(Value::as_f64) else {
                            continue;
                        };
                        parsed.keys.push(Key {
                            frame,
                            value,
                            easing: Easing::parse(key.get("easing").and_then(Value::as_str)),
                            out_tangent: read_tangent(key.get("outTangent")),
                            in_tangent: read_tangent(key.get("inTangent")),
                        });
                    }

                    if parsed.keys.is_empty() {
                        continue;
                    }
                    // Replaces any legacy channel for this property.
                    objects
                        .entry(object_id.to_string())
                        .or_default()
                        .insert(property, parsed);
                }
            }
        }

        // Sort once here so sampling never has to.
        for channels in objects.values_mut() {
            for channel in channels.values_mut() {
                channel.keys.sort_by(|a, b| {
                    a.frame
                        .partial_cmp(&b.frame)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
        }
        objects.retain(|_, channels| !channels.is_empty());

        Self { objects }
    }

    /// Sample one object's animated properties at a frame.
    fn sample_object(&self, object_id: &str, frame: f64) -> Option<Vec<(AnimatedProperty, f64)>> {
        let channels = self.objects.get(object_id)?;
        let mut sampled = Vec::with_capacity(channels.len());
        for (property, channel) in channels {
            if let Some(value) = channel.sample(frame) {
                sampled.push((*property, value));
            }
        }
        (!sampled.is_empty()).then_some(sampled)
    }

    /// Patch prepared rects and texts in place for the given frame.
    ///
    /// `origin` is the stage/tile origin the prepared objects were rebased by. Channels hold
    /// coordinates in **scene** space and `rebase_scene_json` shifts objects but not their
    /// animation, so X and Y are shifted here instead. Getting this wrong is invisible on a
    /// stage whose origin is (0,0) and puts every animated object in the wrong place on one
    /// that is not.
    ///
    /// The caller must pass copies of the **pristine** prepared objects, not the output of a
    /// previous frame: opacity is recovered from the baked premultiplied alpha, so applying
    /// twice would compound it.
    pub fn apply(
        &self,
        frame: u64,
        origin: (f32, f32),
        rects: &mut [PreparedRect],
        texts: &mut [PreparedText],
    ) {
        if self.objects.is_empty() {
            return;
        }
        let frame = frame as f64;

        for rect in rects.iter_mut() {
            let Some(sampled) = self.sample_object(&rect.object_id, frame) else {
                continue;
            };
            for (property, value) in sampled {
                let value32 = value as f32;
                match property {
                    AnimatedProperty::X => rect.x = value32 - origin.0,
                    AnimatedProperty::Y => rect.y = value32 - origin.1,
                    AnimatedProperty::Width => rect.width = value32,
                    AnimatedProperty::Height => rect.height = value32,
                    AnimatedProperty::Rotation => rect.rotation_degrees = value32,
                    AnimatedProperty::ScaleX => rect.scale_x = value32,
                    AnimatedProperty::ScaleY => rect.scale_y = value32,
                    AnimatedProperty::Opacity => {
                        // The fill is premultiplied, so alpha is baked into all four
                        // components. Scaling every component by the ratio changes opacity and
                        // leaves the colour intact. A fully transparent baked fill carries no
                        // recoverable colour, so it is left alone rather than guessed at.
                        let baked = rect.fill_linear_premultiplied[3];
                        if baked > f32::EPSILON {
                            let k = (value32.clamp(0.0, 1.0)) / baked;
                            for component in rect.fill_linear_premultiplied.iter_mut() {
                                *component *= k;
                            }
                        }
                    }
                    // A 2D quad has no Z placement and no X/Y tilt: `zDepth` is paint order,
                    // resolved during preparation, and the shared quad shader has no third
                    // rotation axis. Silently applying these would look like it worked.
                    AnimatedProperty::Z
                    | AnimatedProperty::RotationX
                    | AnimatedProperty::RotationY
                    | AnimatedProperty::ScaleZ => {}
                }
            }
        }

        for text in texts.iter_mut() {
            let Some(sampled) = self.sample_object(&text.object_id, frame) else {
                continue;
            };
            for (property, value) in sampled {
                let value32 = value as f32;
                match property {
                    AnimatedProperty::X => text.x = value32 - origin.0,
                    AnimatedProperty::Y => text.y = value32 - origin.1,
                    AnimatedProperty::Width => text.width = value32,
                    AnimatedProperty::Height => text.height = value32,
                    AnimatedProperty::Rotation => text.rotation_degrees = value32,
                    AnimatedProperty::ScaleX => text.scale_x = value32,
                    AnimatedProperty::ScaleY => text.scale_y = value32,
                    AnimatedProperty::Opacity => {
                        // Text colour is straight (not premultiplied) 8-bit RGBA.
                        text.color_rgba[3] = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
                    }
                    AnimatedProperty::Z
                    | AnimatedProperty::RotationX
                    | AnimatedProperty::RotationY
                    | AnimatedProperty::ScaleZ => {}
                }
            }
        }
    }

    /// Model matrices for the meshes that are animated at this frame.
    ///
    /// Returns only animated meshes, so a still scene produces an empty map and the caller
    /// writes no GPU buffers. Each matrix is composed from the mesh's **authored** transform
    /// with the sampled channels overlaid, using `MeshTransform::to_matrix` — the same
    /// composition preparation uses, so an animated mesh at rest lands exactly where the
    /// static one would.
    ///
    /// Unlike a 2D quad, a mesh animates in all three axes: `zDepth` is a real Z translation
    /// and X/Y rotation and Z scale are meaningful. Draw order is not re-sorted, which is
    /// correct for depth-tested opaque geometry; a transparent surface animating through
    /// another one can still composite in the prepared order.
    pub fn mesh_transforms(
        &self,
        frame: u64,
        origin: (f32, f32),
        meshes: &[PreparedMesh],
    ) -> HashMap<String, [f32; 16]> {
        let mut transforms = HashMap::new();
        if self.objects.is_empty() {
            return transforms;
        }
        let frame = frame as f64;

        for mesh in meshes {
            let Some(sampled) = self.sample_object(&mesh.object_id, frame) else {
                continue;
            };
            // Start from what was authored, so an unanimated axis keeps its value.
            let mut transform: MeshTransform = mesh.transform;
            for (property, value) in sampled {
                let value32 = value as f32;
                match property {
                    AnimatedProperty::X => transform.x = value32 - origin.0,
                    AnimatedProperty::Y => transform.y = value32 - origin.1,
                    AnimatedProperty::Z => transform.z = value32,
                    AnimatedProperty::RotationX => transform.rotation_x = value32,
                    AnimatedProperty::RotationY => transform.rotation_y = value32,
                    AnimatedProperty::Rotation => transform.rotation_z = value32,
                    AnimatedProperty::ScaleX => transform.scale_x = value32,
                    AnimatedProperty::ScaleY => transform.scale_y = value32,
                    AnimatedProperty::ScaleZ => transform.scale_z = value32,
                    // Width, height and opacity are surface properties, not transform ones. A
                    // mesh is scaled, and its opacity lives in the material.
                    AnimatedProperty::Width
                    | AnimatedProperty::Height
                    | AnimatedProperty::Opacity => {}
                }
            }
            transforms.insert(mesh.object_id.clone(), transform.to_matrix());
        }

        transforms
    }
}

fn read_tangent(value: Option<&Value>) -> Option<(f64, f64)> {
    let tangent = value?;
    let x = tangent.get("x").and_then(Value::as_f64)?;
    let y = tangent.get("y").and_then(Value::as_f64)?;
    Some((x, y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scene_with_channel(keys: Value) -> Value {
        json!({
            "objects": [{ "id": "rect_1", "animation": { "x": { "keys": keys } } }],
            "timeline": { "keyframes": [] }
        })
    }

    #[test]
    fn a_scene_with_no_animation_costs_nothing() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "rect_1" }],
            "timeline": { "keyframes": [] }
        }));
        assert!(animation.is_empty());
    }

    #[test]
    fn a_linear_channel_interpolates_between_its_keys() {
        let animation = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 0, "value": 100.0, "easing": "linear" },
            { "frame": 10, "value": 200.0, "easing": "linear" }
        ])));

        let at = |frame: u64| {
            animation
                .sample_object("rect_1", frame as f64)
                .expect("object is animated")[0]
                .1
        };
        assert_eq!(at(0), 100.0);
        assert_eq!(at(5), 150.0);
        assert_eq!(at(10), 200.0);
    }

    #[test]
    fn values_hold_outside_the_keyed_range_rather_than_extrapolating() {
        let animation = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 10, "value": 100.0 },
            { "frame": 20, "value": 200.0 }
        ])));

        // Before the first key and after the last: hold. Extrapolating here would fling a
        // graphic off the canvas before its In animation had started.
        assert_eq!(animation.sample_object("rect_1", 0.0).unwrap()[0].1, 100.0);
        assert_eq!(
            animation.sample_object("rect_1", 999.0).unwrap()[0].1,
            200.0
        );
    }

    #[test]
    fn segment_easing_comes_from_the_outgoing_key() {
        let animation = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 0, "value": 0.0, "easing": "ease-in" },
            { "frame": 10, "value": 100.0, "easing": "linear" }
        ])));

        // ease-in at the midpoint is 0.5^2 = 0.25.
        let midpoint = animation.sample_object("rect_1", 5.0).unwrap()[0].1;
        assert!((midpoint - 25.0).abs() < 1e-9, "got {midpoint}");
    }

    #[test]
    fn each_easing_curve_matches_the_typescript_shape() {
        // Values taken from easeKeyframeT in Shared/shared-types.
        assert!((Easing::Linear.apply(0.5) - 0.5).abs() < 1e-12);
        assert!((Easing::EaseIn.apply(0.5) - 0.25).abs() < 1e-12);
        assert!((Easing::EaseOut.apply(0.5) - 0.75).abs() < 1e-12);
        assert!((Easing::EaseInOut.apply(0.25) - 0.125).abs() < 1e-12);
        assert!((Easing::EaseInOut.apply(0.75) - 0.875).abs() < 1e-12);
        // Clamped, not extrapolated.
        assert_eq!(Easing::Linear.apply(-1.0), 0.0);
        assert_eq!(Easing::Linear.apply(2.0), 1.0);
    }

    #[test]
    fn a_bezier_handle_replaces_the_named_easing() {
        let eased = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 0, "value": 0.0, "easing": "linear",
              "outTangent": { "x": 9.0, "y": 0.0 } },
            { "frame": 10, "value": 100.0 }
        ])));
        let linear = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 0, "value": 0.0, "easing": "linear" },
            { "frame": 10, "value": 100.0 }
        ])));

        let a = eased.sample_object("rect_1", 5.0).unwrap()[0].1;
        let b = linear.sample_object("rect_1", 5.0).unwrap()[0].1;
        // A late out-handle holds the value back; if tangents were ignored these would match.
        assert!(a < b, "bezier {a} should trail linear {b}");
    }

    #[test]
    fn properties_are_sampled_independently() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{
                "id": "rect_1",
                "animation": {
                    "x": { "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 10, "value": 100.0 }] },
                    "opacity": { "keys": [{ "frame": 0, "value": 1.0 }, { "frame": 4, "value": 0.0 }] }
                }
            }],
            "timeline": { "keyframes": [] }
        }));

        let sampled: HashMap<_, _> = animation
            .sample_object("rect_1", 5.0)
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(sampled[&AnimatedProperty::X], 50.0);
        // opacity finished at frame 4 and holds; x is still mid-flight.
        assert_eq!(sampled[&AnimatedProperty::Opacity], 0.0);
    }

    #[test]
    fn a_property_channel_wins_over_a_legacy_keyframe() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{
                "id": "rect_1",
                "animation": { "x": { "keys": [
                    { "frame": 0, "value": 0.0 },
                    { "frame": 10, "value": 10.0 }
                ] } }
            }],
            "timeline": { "keyframes": [
                { "objectId": "rect_1", "frame": 0, "properties": { "x": 500.0, "y": 5.0 } },
                { "objectId": "rect_1", "frame": 10, "properties": { "x": 900.0, "y": 25.0 } }
            ] }
        }));

        let sampled: HashMap<_, _> = animation
            .sample_object("rect_1", 5.0)
            .unwrap()
            .into_iter()
            .collect();
        // x from the channel, not the legacy snapshot.
        assert_eq!(sampled[&AnimatedProperty::X], 5.0);
        // y only exists in the legacy model, so it still applies.
        assert_eq!(sampled[&AnimatedProperty::Y], 15.0);
    }

    #[test]
    fn legacy_keyframes_alone_still_animate() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "rect_1" }],
            "timeline": { "keyframes": [
                { "objectId": "rect_1", "frame": 0, "properties": { "x": 0.0 }, "easing": "linear" },
                { "objectId": "rect_1", "frame": 20, "properties": { "x": 400.0 }, "easing": "linear" }
            ] }
        }));
        assert!(!animation.is_empty());
        assert_eq!(animation.sample_object("rect_1", 10.0).unwrap()[0].1, 200.0);
    }

    #[test]
    fn out_of_order_keys_are_sorted_before_sampling() {
        let animation = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 20, "value": 200.0 },
            { "frame": 0, "value": 0.0 },
            { "frame": 10, "value": 100.0 }
        ])));
        assert_eq!(animation.sample_object("rect_1", 5.0).unwrap()[0].1, 50.0);
        assert_eq!(animation.sample_object("rect_1", 15.0).unwrap()[0].1, 150.0);
    }

    #[test]
    fn non_numeric_and_malformed_channels_are_ignored() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{
                "id": "rect_1",
                "animation": {
                    // Not a numeric transform property at all.
                    "text": { "keys": [{ "frame": 0, "value": 1.0 }] },
                    "src": { "keys": [{ "frame": 0, "value": 2.0 }] },
                    // Declared but empty: nothing to sample.
                    "x": { "keys": [] }
                }
            }],
            "timeline": { "keyframes": [] }
        }));
        assert!(animation.is_empty(), "nothing here is animatable per-frame");
    }

    #[test]
    fn zdepth_is_recognised_because_a_mesh_animates_in_z() {
        // `zDepth` is paint order for a 2D quad and a real Z translation for a mesh, so it is
        // parsed and then applied only where it means something. `apply` ignores it for quads;
        // `mesh_transforms` uses it.
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "thing", "animation": {
                "zDepth": { "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 5, "value": 9.0 }] }
            } }],
            "timeline": { "keyframes": [] }
        }));
        assert!(!animation.is_empty());
        assert_eq!(animation.animated_object_count(), 1);
    }

    #[test]
    fn applying_a_frame_moves_a_prepared_rect() {
        let animation = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 0, "value": 220.0 },
            { "frame": 31, "value": 1000.0 }
        ])));

        let pristine = PreparedRect {
            object_id: "rect_1".to_string(),
            x: 1000.0,
            y: 220.0,
            width: 360.0,
            height: 210.0,
            rotation_degrees: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            fill_linear_premultiplied: [0.1, 0.2, 0.3, 1.0],
            gradient: Default::default(),
            blend_mode: 0,
            primitive_kind: 0,
        };

        // Frame 0 overrides the object's stored x of 1000 with the first key.
        let mut rects = vec![pristine.clone()];
        animation.apply(0, (0.0, 0.0), &mut rects, &mut []);
        assert_eq!(rects[0].x, 220.0);

        // Halfway, and at the end.
        let mut rects = vec![pristine.clone()];
        animation.apply(31, (0.0, 0.0), &mut rects, &mut []);
        assert_eq!(rects[0].x, 1000.0);

        let mut rects = vec![pristine];
        animation.apply(15, (0.0, 0.0), &mut rects, &mut []);
        assert!(
            rects[0].x > 220.0 && rects[0].x < 1000.0,
            "got {}",
            rects[0].x
        );
    }

    #[test]
    fn opacity_scales_a_premultiplied_fill_without_tinting_it() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "rect_1", "animation": { "opacity": { "keys": [
                { "frame": 0, "value": 1.0 },
                { "frame": 10, "value": 0.0 }
            ] } } }],
            "timeline": { "keyframes": [] }
        }));

        let mut rects = vec![PreparedRect {
            object_id: "rect_1".to_string(),
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            rotation_degrees: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            // Premultiplied at full opacity.
            fill_linear_premultiplied: [0.4, 0.2, 0.1, 1.0],
            gradient: Default::default(),
            blend_mode: 0,
            primitive_kind: 0,
        }];

        animation.apply(5, (0.0, 0.0), &mut rects, &mut []);
        let fill = rects[0].fill_linear_premultiplied;
        assert!(
            (fill[3] - 0.5).abs() < 1e-6,
            "alpha should be halved, got {}",
            fill[3]
        );
        // Hue is preserved: every component scaled by the same factor.
        assert!((fill[0] - 0.2).abs() < 1e-6);
        assert!((fill[1] - 0.1).abs() < 1e-6);
        assert!((fill[2] - 0.05).abs() < 1e-6);
    }

    #[test]
    fn an_object_with_no_animation_is_left_alone() {
        let animation = SceneAnimation::from_document(&scene_with_channel(json!([
            { "frame": 0, "value": 0.0 },
            { "frame": 10, "value": 100.0 }
        ])));

        let mut rects = vec![PreparedRect {
            object_id: "someone_else".to_string(),
            x: 42.0,
            y: 7.0,
            width: 1.0,
            height: 1.0,
            rotation_degrees: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            fill_linear_premultiplied: [0.0, 0.0, 0.0, 1.0],
            gradient: Default::default(),
            blend_mode: 0,
            primitive_kind: 0,
        }];
        animation.apply(5, (0.0, 0.0), &mut rects, &mut []);
        assert_eq!(rects[0].x, 42.0);
        assert_eq!(rects[0].y, 7.0);
    }

    #[test]
    fn animated_positions_are_rebased_by_the_stage_origin() {
        // rebase_scene_json shifts an object's x/y by the tile origin but leaves its animation
        // channels in scene space, so apply() must shift them to match. On a stage whose
        // origin is (0,0) this is invisible, which is exactly why it needs a test.
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "rect_1", "animation": {
                "x": { "keys": [{ "frame": 0, "value": 1200.0 }, { "frame": 10, "value": 1200.0 }] },
                "y": { "keys": [{ "frame": 0, "value": 800.0 }, { "frame": 10, "value": 800.0 }] }
            } }],
            "timeline": { "keyframes": [] }
        }));

        let pristine = PreparedRect {
            object_id: "rect_1".to_string(),
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            rotation_degrees: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            fill_linear_premultiplied: [0.0, 0.0, 0.0, 1.0],
            gradient: Default::default(),
            blend_mode: 0,
            primitive_kind: 0,
        };

        let mut at_origin = vec![pristine.clone()];
        animation.apply(5, (0.0, 0.0), &mut at_origin, &mut []);
        assert_eq!((at_origin[0].x, at_origin[0].y), (1200.0, 800.0));

        let mut offset = vec![pristine];
        animation.apply(5, (1000.0, 500.0), &mut offset, &mut []);
        assert_eq!((offset[0].x, offset[0].y), (200.0, 300.0));
    }

    fn mesh(object_id: &str, transform: MeshTransform) -> PreparedMesh {
        PreparedMesh {
            object_id: object_id.to_string(),
            model_transform: transform.to_matrix(),
            transform,
            surfaces: Vec::new(),
        }
    }

    const REST: MeshTransform = MeshTransform {
        x: 100.0,
        y: 200.0,
        z: 5.0,
        rotation_x: 10.0,
        rotation_y: 20.0,
        rotation_z: 30.0,
        scale_x: 2.0,
        scale_y: 3.0,
        scale_z: 4.0,
    };

    #[test]
    fn a_still_mesh_produces_no_transform_updates() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1" }],
            "timeline": { "keyframes": [] }
        }));
        let transforms = animation.mesh_transforms(5, (0.0, 0.0), &[mesh("mesh_1", REST)]);
        assert!(
            transforms.is_empty(),
            "a still scene must write no GPU buffers"
        );
    }

    #[test]
    fn an_animated_mesh_composes_from_its_authored_transform() {
        // Only Y is animated. Every other axis must keep what was authored — the bug this
        // guards is resetting the untouched axes to defaults.
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1", "animation": { "y": { "keys": [
                { "frame": 0, "value": 200.0 },
                { "frame": 10, "value": 400.0 }
            ] } } }],
            "timeline": { "keyframes": [] }
        }));

        let transforms = animation.mesh_transforms(5, (0.0, 0.0), &[mesh("mesh_1", REST)]);
        let matrix = transforms.get("mesh_1").expect("mesh is animated");

        let expected = MeshTransform { y: 300.0, ..REST }.to_matrix();
        assert_eq!(matrix, &expected);
    }

    #[test]
    fn an_animated_mesh_at_rest_matches_the_static_composition_exactly() {
        // Parity: at a frame where the channel equals the authored value, the animated matrix
        // must be bit-identical to what preparation produced. Two copies of the composition
        // formula would drift and put a mesh in a slightly different place once it animated.
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1", "animation": { "y": { "keys": [
                { "frame": 0, "value": 200.0 },
                { "frame": 10, "value": 200.0 }
            ] } } }],
            "timeline": { "keyframes": [] }
        }));

        let prepared = mesh("mesh_1", REST);
        let transforms = animation.mesh_transforms(5, (0.0, 0.0), &[prepared.clone()]);
        assert_eq!(transforms["mesh_1"], prepared.model_transform);
    }

    #[test]
    fn a_mesh_animates_in_all_three_axes() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1", "animation": {
                "zDepth":    { "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 10, "value": 50.0 }] },
                "rotationX": { "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 10, "value": 90.0 }] },
                "rotationY": { "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 10, "value": 45.0 }] },
                "scaleZ":    { "keys": [{ "frame": 0, "value": 1.0 }, { "frame": 10, "value": 3.0 }] }
            } }],
            "timeline": { "keyframes": [] }
        }));

        let transforms = animation.mesh_transforms(10, (0.0, 0.0), &[mesh("mesh_1", REST)]);
        let expected = MeshTransform {
            z: 50.0,
            rotation_x: 90.0,
            rotation_y: 45.0,
            scale_z: 3.0,
            ..REST
        }
        .to_matrix();
        assert_eq!(transforms["mesh_1"], expected);
    }

    #[test]
    fn rotation_and_rotation_z_are_the_same_axis_for_a_mesh() {
        for name in ["rotation", "rotationZ"] {
            let animation = SceneAnimation::from_document(&json!({
                "objects": [{ "id": "mesh_1", "animation": {
                    (name): { "keys": [{ "frame": 0, "value": 90.0 }, { "frame": 10, "value": 90.0 }] }
                } }],
                "timeline": { "keyframes": [] }
            }));
            let transforms = animation.mesh_transforms(5, (0.0, 0.0), &[mesh("mesh_1", REST)]);
            let expected = MeshTransform {
                rotation_z: 90.0,
                ..REST
            }
            .to_matrix();
            assert_eq!(
                transforms["mesh_1"], expected,
                "{name} must drive Z rotation"
            );
        }
    }

    #[test]
    fn mesh_positions_are_rebased_by_the_stage_origin() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1", "animation": {
                "x": { "keys": [{ "frame": 0, "value": 1200.0 }, { "frame": 10, "value": 1200.0 }] }
            } }],
            "timeline": { "keyframes": [] }
        }));

        let transforms = animation.mesh_transforms(5, (1000.0, 500.0), &[mesh("mesh_1", REST)]);
        let expected = MeshTransform { x: 200.0, ..REST }.to_matrix();
        assert_eq!(transforms["mesh_1"], expected);
    }

    #[test]
    fn surface_properties_do_not_disturb_a_mesh_transform() {
        // Width, height and opacity are not transform components. A mesh is scaled, and its
        // opacity lives in the material — writing them into the matrix would squash the mesh.
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1", "animation": {
                "width":   { "keys": [{ "frame": 0, "value": 999.0 }, { "frame": 10, "value": 999.0 }] },
                "height":  { "keys": [{ "frame": 0, "value": 888.0 }, { "frame": 10, "value": 888.0 }] },
                "opacity": { "keys": [{ "frame": 0, "value": 0.5 }, { "frame": 10, "value": 0.5 }] }
            } }],
            "timeline": { "keyframes": [] }
        }));

        let prepared = mesh("mesh_1", REST);
        let transforms = animation.mesh_transforms(5, (0.0, 0.0), &[prepared.clone()]);
        assert_eq!(transforms["mesh_1"], prepared.model_transform);
    }

    #[test]
    fn a_quad_ignores_the_three_d_channels() {
        // The reverse of the mesh case: `zDepth` is paint order for a quad and the shared quad
        // shader has no X/Y rotation, so applying these would look like it worked.
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "rect_1", "animation": {
                "zDepth":    { "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 10, "value": 9.0 }] },
                "rotationX": { "keys": [{ "frame": 0, "value": 0.0 }, { "frame": 10, "value": 90.0 }] },
                "scaleZ":    { "keys": [{ "frame": 0, "value": 1.0 }, { "frame": 10, "value": 5.0 }] }
            } }],
            "timeline": { "keyframes": [] }
        }));

        let pristine = PreparedRect {
            object_id: "rect_1".to_string(),
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 40.0,
            rotation_degrees: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            fill_linear_premultiplied: [0.1, 0.2, 0.3, 1.0],
            gradient: Default::default(),
            blend_mode: 0,
            primitive_kind: 0,
        };
        let mut rects = vec![pristine.clone()];
        animation.apply(10, (0.0, 0.0), &mut rects, &mut []);

        assert_eq!(rects[0].x, pristine.x);
        assert_eq!(rects[0].scale_x, pristine.scale_x);
        assert_eq!(rects[0].rotation_degrees, pristine.rotation_degrees);
    }

    #[test]
    fn rotation_z_wins_the_shared_axis_over_rotation() {
        // Preparation uses `rotationZ ?? rotation` and the Editor uses the same fallback, so a
        // scene carrying both must resolve to rotationZ here too. It previously depended on
        // JSON key order, which is to say it was undefined.
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1", "animation": {
                "rotationZ": { "keys": [{ "frame": 0, "value": 90.0 }, { "frame": 10, "value": 90.0 }] },
                "rotation":  { "keys": [{ "frame": 0, "value": 15.0 }, { "frame": 10, "value": 15.0 }] }
            } }],
            "timeline": { "keyframes": [] }
        }));

        let transforms = animation.mesh_transforms(5, (0.0, 0.0), &[mesh("mesh_1", REST)]);
        let expected = MeshTransform {
            rotation_z: 90.0,
            ..REST
        }
        .to_matrix();
        assert_eq!(
            transforms["mesh_1"], expected,
            "rotationZ must win, not rotation"
        );
    }

    #[test]
    fn a_legacy_keyframe_carrying_both_rotation_names_yields_one_key_per_frame() {
        let animation = SceneAnimation::from_document(&json!({
            "objects": [{ "id": "mesh_1" }],
            "timeline": { "keyframes": [
                { "objectId": "mesh_1", "frame": 0, "easing": "linear",
                  "properties": { "rotation": 15.0, "rotationZ": 90.0 } },
                { "objectId": "mesh_1", "frame": 10, "easing": "linear",
                  "properties": { "rotation": 15.0, "rotationZ": 90.0 } }
            ] }
        }));

        // Two frames, one key each — not four keys with two pairs sharing a frame.
        let sampled = animation.sample_object("mesh_1", 5.0).expect("animated");
        assert_eq!(sampled.len(), 1);
        assert_eq!(sampled[0], (AnimatedProperty::Rotation, 90.0));
    }
}
