//! Independent authored-value witnesses for the corrected colour-ramp golden
//! frame. These assert opacity/compositing semantics, not a captured checksum.
use std::collections::{HashMap, HashSet};

use gx_contracts::{
    color::OutputTransform, material::MaterialSupport, scene::parse_scene_document,
};
use gx_render_worker::prepared::PreparedScene;

#[test]
fn colour_reference_matches_authored_opacity_and_over_compositing() {
    let scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    assert_eq!(scene.assets[0].checksum.as_ref(), Some(&hash));
    let prepared = PreparedScene::prepare(
        scene,
        &HashSet::from([hash.clone()]),
        &HashMap::from([(hash, font)]),
        &MaterialSupport::fixed_function(),
    )
    .unwrap();
    let frame = prepared.frame_at(0, OutputTransform::Srgb).unwrap();
    let at = |x: usize, y: usize| &frame.pixels[(y * frame.width as usize + x) * 4..][..4];
    assert_eq!(at(5, 5), [255, 0, 0, 255], "opaque ramp red");
    assert_eq!(
        at(28, 40),
        [255, 0, 0, 26],
        "red veil at authored opacity 0.1"
    );
    // Linear white at .2, then red at .1: alpha .28, green/blue
    // .18/.28, encoded as sRGB 210. No text/vector covers this sample.
    assert_eq!(at(40, 40), [255, 210, 210, 71]);
    for (&actual, expected) in at(90, 100).iter().zip([26_u8, 102, 255, 255]) {
        assert!(
            actual.abs_diff(expected) <= 1,
            "authored opaque vector fill"
        );
    }
    assert_eq!(
        at(250, 120),
        [255, 210, 210, 71],
        "removed mesh placeholder leaves the authored veils"
    );
    assert_eq!(at(300, 170), [0, 0, 0, 0], "outside all authored geometry");
}

#[test]
fn animated_text_size_matches_equivalent_static_render_with_an_effect() {
    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::effect::{Effect, EffectInstance, Exposure};
    use gx_contracts::scene::SceneObject;

    let mut scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    let caption = scene
        .objects
        .iter_mut()
        .find_map(|object| match object {
            SceneObject::Text(text) if text.base.id == "caption" => Some(text),
            _ => None,
        })
        .unwrap();
    caption.base.effects = Some(vec![EffectInstance::new(
        "exposure",
        Effect::Exposure(Exposure {
            exposure: -0.5,
            offset: 0.0,
            gamma_correction: 1.0,
        }),
    )]);
    let original_size = caption.size;
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare =
        |document| PreparedScene::prepare(document, &available, &assets, &materials).unwrap();

    let mut animated = scene.clone();
    animated.timeline.channels.push(KeyframeChannel {
        object_id: "caption".into(),
        property: "size".into(),
        keys: [(0, original_size), (10, original_size * 2.0)]
            .into_iter()
            .map(|(frame, value)| SceneKeyframe {
                frame,
                value,
                easing: SceneEasing::Linear,
                bezier: None,
            })
            .collect(),
    });
    let animated = prepare(animated);
    let before = prepare(scene.clone());
    let expected_before = before.frame(OutputTransform::Srgb);
    let caption = scene
        .objects
        .iter_mut()
        .find_map(|object| match object {
            SceneObject::Text(text) if text.base.id == "caption" => Some(text),
            _ => None,
        })
        .unwrap();
    caption.size *= 2.0;
    let after = prepare(scene);
    let expected_after = after.frame(OutputTransform::Srgb);
    assert_ne!(expected_before, expected_after);
    assert_eq!(
        animated.frame_at(0, OutputTransform::Srgb).unwrap(),
        expected_before
    );
    assert_eq!(
        animated.frame_at(10, OutputTransform::Srgb).unwrap(),
        expected_after
    );

    if let Some(gpu) = scalar_test_gpu() {
        use gx_render_worker::compositor::scene::GpuScene;

        let mut gpu_animated = GpuScene::prepare(&gpu, &animated).unwrap();
        for (frame, expected) in [(0, &before), (10, &after), (0, &before)] {
            let (actual, _) = gpu_animated.render(frame).unwrap();
            let (expected, _) = GpuScene::prepare(&gpu, expected)
                .unwrap()
                .render(0)
                .unwrap();
            assert_eq!(
                (actual.width, actual.height),
                (expected.width, expected.height)
            );
            let max_difference = actual
                .pixels
                .iter()
                .zip(&expected.pixels)
                .map(|(actual, expected)| actual.abs_diff(*expected))
                .max()
                .unwrap();
            assert!(
                max_difference <= 1,
                "frame {frame} differs by {max_difference} codes"
            );
        }
    }
}

#[test]
fn every_scalar_property_changes_pixels_and_survives_scene_save() {
    use gx_contracts::animation::{set_base_property, KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::color::ColorValue;
    use gx_contracts::scene::SceneObject;
    use gx_render_worker::compositor::scene::GpuScene;

    let mut scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    for object in &mut scene.objects {
        match object {
            SceneObject::Text(text) => {
                text.text = "GrapiX\nreference".into();
            }
            SceneObject::Shape(shape) => {
                shape.stroke_enabled = true;
                shape.base.stroke = Some(ColorValue::opaque_white());
                shape.base.stroke_width = 4.0;
            }
            _ => {}
        }
    }
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare =
        |document| PreparedScene::prepare(document, &available, &assets, &materials).unwrap();
    let hardware = scalar_test_gpu();
    if hardware.is_some() {
        let start = std::time::Instant::now();
        for _ in 0..20 {
            std::hint::black_box(gx_render_worker::text::prepare_texts(&scene, &assets).unwrap());
        }
        eprintln!(
            "mean packaged-font reshape time for two lines: {:?}",
            start.elapsed() / 20
        );
    }

    for (id, property, low, high) in [
        ("caption", "size", 16.0, 28.0),
        ("caption", "lineHeight", 0.9, 1.6),
        ("caption", "letterSpacing", -50.0, 200.0),
        ("caption", "baselineShift", -5.0, 10.0),
        ("ramp-red", "radius", 0.0, 15.0),
        ("path", "strokeWidth", 2.0, 9.0),
        ("path", "trimStart", 0.0, 60.0),
        ("path", "trimEnd", 40.0, 100.0),
        ("path", "trimOffset", -20.0, 50.0),
        ("path", "strokeStyle.dashOffset", -2.0, 4.0),
        ("path", "strokeStyle.dash.0", 2.0, 12.0),
    ] {
        let mut fixture = scene.clone();
        if matches!(property, "strokeStyle.dashOffset" | "strokeStyle.dash.0") {
            let shape = fixture
                .objects
                .iter_mut()
                .find(|object| object.base().id == id)
                .unwrap();
            shape.base_mut().stroke_style = Some(gx_contracts::scene::StrokeStyle {
                dash: vec![7.0, 5.0],
                ..Default::default()
            });
        }
        if property == "trimOffset" {
            let shape = fixture
                .objects
                .iter_mut()
                .find(|object| object.base().id == id)
                .unwrap();
            let SceneObject::Shape(shape) = shape else {
                unreachable!()
            };
            shape.trim_end = Some(40.0);
        }
        let mut animated = fixture.clone();
        animated.timeline.channels.push(KeyframeChannel {
            object_id: id.into(),
            property: property.into(),
            keys: [(0, low), (10, high)]
                .into_iter()
                .map(|(frame, value)| SceneKeyframe {
                    frame,
                    value,
                    easing: SceneEasing::Linear,
                    bezier: None,
                })
                .collect(),
        });
        let restored = parse_scene_document(&serde_json::to_vec(&animated).unwrap()).unwrap();
        assert_eq!(animated.timeline.channels, restored.timeline.channels);
        let animated = prepare(restored);
        let mut gpu_animated = hardware
            .as_ref()
            .map(|gpu| GpuScene::prepare(gpu, &animated).unwrap());
        let mut previous = None;
        for (frame, value) in [(0, low), (5, (low + high) / 2.0), (10, high)] {
            let mut expected = fixture.clone();
            set_base_property(&mut expected, id, property, value).unwrap();
            let expected = prepare(expected);
            let actual = animated.frame_at(frame, OutputTransform::Srgb).unwrap();
            assert_eq!(
                actual,
                expected.frame(OutputTransform::Srgb),
                "{property} at {frame}"
            );
            assert_ne!(
                previous.as_ref(),
                Some(&actual),
                "{property} at {frame} must change pixels"
            );
            previous = Some(actual);
            if let (Some(gpu), Some(animated)) = (&hardware, &mut gpu_animated) {
                let (actual, _) = animated.render(frame).unwrap();
                let (expected, _) = GpuScene::prepare(gpu, &expected)
                    .unwrap()
                    .render(0)
                    .unwrap();
                assert_eq!(
                    (actual.width, actual.height),
                    (expected.width, expected.height)
                );
                let max_difference = actual
                    .pixels
                    .iter()
                    .zip(&expected.pixels)
                    .map(|(actual, expected)| actual.abs_diff(*expected))
                    .max()
                    .unwrap();
                assert!(
                    max_difference <= 1,
                    "{property} at {frame} differs by {max_difference} codes"
                );
            }
        }
    }
    for (id, property) in [("path", "size"), ("caption", "trimEnd"), ("path", "radius")] {
        assert!(matches!(set_base_property(&mut scene, id, property, 10.0),
            Err(gx_contracts::Refusal::AnimationPropertyUnsupported { object, property: name })
                if object == id && name == property));
    }
}

fn scalar_test_gpu() -> Option<gx_render_worker::gpu::Gpu> {
    use gx_render_worker::gpu;

    let backend = std::env::var("GX_TEST_SCALAR_GPU").ok()?;
    let gpu = match backend.as_str() {
        "dx12" => gpu::negotiate_backends(wgpu::Backends::DX12),
        "vulkan" => gpu::negotiate_backends(wgpu::Backends::VULKAN),
        "1" => gpu::negotiate(),
        _ => panic!("unknown scalar redraw backend: {backend}"),
    };
    assert!(
        gpu.has_hardware(),
        "scalar redraw proof requires hardware for {backend}"
    );
    Some(gpu)
}

#[test]
fn solid_fill_and_stroke_keys_render_from_a_saved_scene() {
    use gx_contracts::animation::colour::{ColourChannel, ColourKeyframe, ColourProperty};
    use gx_contracts::animation::SceneEasing;
    use gx_contracts::color::{srgb_encode, ColorValue, Rgba};

    let mut scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    scene
        .objects
        .retain(|object| object.base().id == "ramp-red");
    let base = scene.objects[0].base_mut();
    base.stroke_width = 6.0;
    base.stroke = None;
    let rgb = |r, g, b| Rgba::srgb(r, g, b, 1.0);
    let channel = |property, from, to| ColourChannel {
        object_id: "ramp-red".into(),
        property,
        keys: [(0, from), (10, to)]
            .into_iter()
            .map(|(frame, value)| ColourKeyframe {
                frame,
                value,
                easing: SceneEasing::Linear,
                bezier: None,
            })
            .collect(),
    };
    let mut animated = scene.clone();
    animated.timeline.colour_channels = Some(vec![
        channel(ColourProperty::Fill, rgb(1.0, 0.0, 0.0), rgb(0.0, 0.0, 1.0)),
        channel(
            ColourProperty::Stroke,
            rgb(0.0, 1.0, 0.0),
            rgb(1.0, 0.0, 0.0),
        ),
    ]);
    let restored = parse_scene_document(&serde_json::to_vec(&animated).unwrap()).unwrap();
    assert_eq!(
        restored.timeline.colour_channels,
        animated.timeline.colour_channels
    );
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let material = MaterialSupport::fixed_function();
    let prepare = |scene| PreparedScene::prepare(scene, &available, &assets, &material).unwrap();
    let animated = prepare(restored);
    let hardware = scalar_test_gpu();
    let mut gpu_animated = hardware
        .as_ref()
        .map(|gpu| gx_render_worker::compositor::scene::GpuScene::prepare(gpu, &animated).unwrap());
    let midpoint = srgb_encode(0.5);
    let mut previous = None;
    for (frame, fill, stroke) in [
        (0, rgb(1.0, 0.0, 0.0), rgb(0.0, 1.0, 0.0)),
        (
            5,
            rgb(midpoint, 0.0, midpoint),
            rgb(midpoint, midpoint, 0.0),
        ),
        (10, rgb(0.0, 0.0, 1.0), rgb(1.0, 0.0, 0.0)),
    ] {
        let mut expected = scene.clone();
        let base = expected.objects[0].base_mut();
        base.fill = Some(ColorValue::Solid { color: fill });
        base.stroke = Some(ColorValue::Solid { color: stroke });
        let actual = animated.frame_at(frame, OutputTransform::Srgb).unwrap();
        let expected = prepare(expected);
        assert_eq!(actual, expected.frame(OutputTransform::Srgb));
        if let (Some(gpu), Some(animated)) = (&hardware, &mut gpu_animated) {
            let (actual, _) = animated.render(frame).unwrap();
            let (expected, _) =
                gx_render_worker::compositor::scene::GpuScene::prepare(gpu, &expected)
                    .unwrap()
                    .render(0)
                    .unwrap();
            assert_eq!(
                (actual.width, actual.height),
                (expected.width, expected.height)
            );
            let delta = actual
                .pixels
                .iter()
                .zip(&expected.pixels)
                .map(|(actual, expected)| actual.abs_diff(*expected))
                .max()
                .unwrap();
            assert!(delta <= 1, "colour frame {frame} differed by {delta} codes");
        }
        assert_ne!(previous.as_ref(), Some(&actual));
        previous = Some(actual);
    }
}

#[test]
fn saved_text_animator_offset_and_tracking_render_at_keys_and_midpoint() {
    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::scene::SceneObject;
    use gx_contracts::text_animator::{
        TextAnimator, TextRangeBasis, TextRangeSelector, TextRangeShape,
    };
    use gx_render_worker::compositor::scene::GpuScene;

    let mut scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    scene.objects.retain(|object| object.base().id == "caption");
    let SceneObject::Text(text) = &mut scene.objects[0] else {
        panic!("caption is text")
    };
    text.text_animator = Some(TextAnimator {
        x: 22.0,
        y: 12.0,
        scale: 1.25,
        selector: TextRangeSelector {
            shape: TextRangeShape::RampUp,
            basis: Some(TextRangeBasis::Words),
            ..Default::default()
        },
        ..Default::default()
    });
    let mut animated = scene.clone();
    for (property, values) in [
        ("textAnimator.selector.offset", [-0.25, 0.25]),
        ("textAnimator.tracking", [-8.0, 16.0]),
    ] {
        animated.timeline.channels.push(KeyframeChannel {
            object_id: "caption".into(),
            property: property.into(),
            keys: [0, 10]
                .into_iter()
                .zip(values)
                .map(|(frame, value)| SceneKeyframe {
                    frame,
                    value,
                    easing: SceneEasing::Linear,
                    bezier: None,
                })
                .collect(),
        });
    }

    let saved = serde_json::to_vec(&animated).unwrap();
    let restored = parse_scene_document(&saved).unwrap();
    assert_eq!(restored, animated);
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare =
        |document| PreparedScene::prepare(document, &available, &assets, &materials).unwrap();
    let animated = prepare(restored);
    let hardware = scalar_test_gpu();
    let mut gpu_animated = hardware
        .as_ref()
        .map(|gpu| GpuScene::prepare(gpu, &animated).unwrap());
    let mut previous = None;
    for (frame, offset, tracking) in [(0, -0.25, -8.0), (5, 0.0, 4.0), (10, 0.25, 16.0)] {
        let mut expected = scene.clone();
        let SceneObject::Text(text) = &mut expected.objects[0] else {
            unreachable!()
        };
        let animator = text.text_animator.as_mut().unwrap();
        animator.selector.offset = offset;
        animator.tracking = Some(tracking);
        let expected = prepare(expected);
        let actual = animated.frame_at(frame, OutputTransform::Srgb).unwrap();
        assert_eq!(actual, expected.frame(OutputTransform::Srgb));
        assert_ne!(previous.as_ref(), Some(&actual));
        previous = Some(actual);
        if let (Some(gpu), Some(animated)) = (&hardware, &mut gpu_animated) {
            let (actual, _) = animated.render(frame).unwrap();
            let (expected, _) = GpuScene::prepare(gpu, &expected)
                .unwrap()
                .render(0)
                .unwrap();
            assert_eq!(
                (actual.width, actual.height),
                (expected.width, expected.height)
            );
            let max_difference = actual
                .pixels
                .iter()
                .zip(&expected.pixels)
                .map(|(actual, expected)| actual.abs_diff(*expected))
                .max()
                .unwrap();
            assert!(
                max_difference <= 1,
                "animator frame {frame} differed by {max_difference} codes"
            );
        }
    }
}

#[test]
fn animator_opacity_fades_the_selected_glyph_without_fading_its_neighbour() {
    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::scene::SceneObject;
    use gx_contracts::text_animator::{TextAnimator, TextRangeSelector};
    use gx_render_worker::compositor::scene::GpuScene;

    let mut scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    scene.objects.retain(|object| object.base().id == "caption");
    let SceneObject::Text(text) = &mut scene.objects[0] else {
        unreachable!()
    };
    text.text = "AB".into();
    let x = text.base.x;
    text.text_animator = Some(TextAnimator {
        selector: TextRangeSelector {
            end: 0.5,
            smoothness: 0.0,
            ..Default::default()
        },
        ..Default::default()
    });
    let mut animated = scene.clone();
    animated.timeline.channels.push(KeyframeChannel {
        object_id: "caption".into(),
        property: "textAnimator.opacity".into(),
        keys: [(0, 0.0), (10, 1.0)]
            .into_iter()
            .map(|(frame, value)| SceneKeyframe {
                frame,
                value,
                easing: SceneEasing::Linear,
                bezier: None,
            })
            .collect(),
    });
    let restored = parse_scene_document(&serde_json::to_vec(&animated).unwrap()).unwrap();
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare = |scene| PreparedScene::prepare(scene, &available, &assets, &materials).unwrap();
    let animated = prepare(restored);
    let second_x = (x + f64::from(animated.texts().objects[0].glyphs[1].x)).round() as usize;
    let hardware = scalar_test_gpu();
    let mut gpu_animated = hardware
        .as_ref()
        .map(|gpu| GpuScene::prepare(gpu, &animated).unwrap());
    let mut alpha = Vec::new();
    for (frame, opacity) in [(0, 0.0), (5, 0.5), (10, 1.0)] {
        let mut expected = scene.clone();
        let SceneObject::Text(text) = &mut expected.objects[0] else {
            unreachable!()
        };
        text.text_animator.as_mut().unwrap().opacity = Some(opacity);
        let expected = prepare(expected);
        let cpu = animated.frame_at(frame, OutputTransform::Srgb).unwrap();
        assert_eq!(cpu, expected.frame(OutputTransform::Srgb));
        let mut left = 0_u32;
        let mut right = 0_u32;
        for (index, pixel) in cpu.pixels.chunks_exact(4).enumerate() {
            if index % (cpu.width as usize) < second_x {
                left += u32::from(pixel[3]);
            } else {
                right += u32::from(pixel[3]);
            }
        }
        alpha.push((left, right));
        if let (Some(gpu), Some(animated)) = (&hardware, &mut gpu_animated) {
            let (actual, _) = animated.render(frame).unwrap();
            let (expected, _) = GpuScene::prepare(gpu, &expected)
                .unwrap()
                .render(0)
                .unwrap();
            assert_eq!(
                (actual.width, actual.height),
                (expected.width, expected.height)
            );
            let delta = actual
                .pixels
                .iter()
                .zip(&expected.pixels)
                .map(|(actual, expected)| actual.abs_diff(*expected))
                .max()
                .unwrap();
            assert!(
                delta <= 1,
                "animator opacity frame {frame} differs by {delta} codes"
            );
        }
    }
    assert!(alpha[0].0 < alpha[1].0 && alpha[1].0 < alpha[2].0);
    assert!(alpha[0].1 > 0);
    assert_eq!(alpha[0].1, alpha[1].1);
    assert_eq!(alpha[1].1, alpha[2].1);
}

#[test]
fn animator_fill_keys_recolour_only_the_selected_glyph() {
    use gx_contracts::animation::colour::{ColourChannel, ColourKeyframe, ColourProperty};
    use gx_contracts::animation::SceneEasing;
    use gx_contracts::color::{srgb_encode, ColorValue, Rgba};
    use gx_contracts::scene::SceneObject;
    use gx_contracts::text_animator::{TextAnimator, TextRangeSelector};
    use gx_render_worker::compositor::scene::GpuScene;

    let mut scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    scene.objects.retain(|object| object.base().id == "caption");
    let SceneObject::Text(text) = &mut scene.objects[0] else {
        unreachable!()
    };
    text.text = "AB".into();
    text.base.fill = Some(ColorValue::opaque_white());
    let x = text.base.x;
    text.text_animator = Some(TextAnimator {
        selector: TextRangeSelector {
            end: 0.5,
            smoothness: 0.0,
            ..Default::default()
        },
        ..Default::default()
    });
    let red = Rgba::srgb(1.0, 0.0, 0.0, 1.0);
    let blue = Rgba::srgb(0.0, 0.0, 1.0, 1.0);
    let mut animated = scene.clone();
    animated.timeline.colour_channels = Some(vec![ColourChannel {
        object_id: "caption".into(),
        property: ColourProperty::TextAnimatorFill,
        keys: [(0, red), (10, blue)]
            .into_iter()
            .map(|(frame, value)| ColourKeyframe {
                frame,
                value,
                easing: SceneEasing::Linear,
                bezier: None,
            })
            .collect(),
    }]);
    let restored = parse_scene_document(&serde_json::to_vec(&animated).unwrap()).unwrap();
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare = |scene| PreparedScene::prepare(scene, &available, &assets, &materials).unwrap();
    let animated = prepare(restored);
    let second_x = (x + f64::from(animated.texts().objects[0].glyphs[1].x)).round() as usize;
    let hardware = scalar_test_gpu();
    let mut gpu_animated = hardware
        .as_ref()
        .map(|gpu| GpuScene::prepare(gpu, &animated).unwrap());
    let midpoint = srgb_encode(0.5);
    for (frame, fill) in [
        (0, red),
        (5, Rgba::srgb(midpoint, 0.0, midpoint, 1.0)),
        (10, blue),
    ] {
        let mut expected = scene.clone();
        let SceneObject::Text(text) = &mut expected.objects[0] else {
            unreachable!()
        };
        text.text_animator.as_mut().unwrap().fill = Some(fill);
        let expected = prepare(expected);
        let cpu = animated.frame_at(frame, OutputTransform::Srgb).unwrap();
        assert_eq!(cpu, expected.frame(OutputTransform::Srgb));
        assert!(cpu
            .pixels
            .chunks_exact(4)
            .enumerate()
            .any(|(index, pixel)| {
                index % (cpu.width as usize) < second_x && pixel[3] > 128 && pixel[1] == 0
            }));
        assert!(cpu
            .pixels
            .chunks_exact(4)
            .enumerate()
            .any(|(index, pixel)| {
                index % (cpu.width as usize) >= second_x && pixel == [255, 255, 255, 255]
            }));
        if let (Some(gpu), Some(animated)) = (&hardware, &mut gpu_animated) {
            let (actual, _) = animated.render(frame).unwrap();
            let (expected, _) = GpuScene::prepare(gpu, &expected)
                .unwrap()
                .render(0)
                .unwrap();
            let delta = actual
                .pixels
                .iter()
                .zip(&expected.pixels)
                .map(|(actual, expected)| actual.abs_diff(*expected))
                .max()
                .unwrap();
            assert!(
                delta <= 1,
                "animator fill frame {frame} differs by {delta} codes"
            );
        }
    }
}

#[test]
fn animated_text_ink_stays_inside_its_clip_box() {
    use gx_contracts::scene::{SceneObject, TextLayout, TextOverflow};
    use gx_contracts::text_animator::TextAnimator;
    use gx_render_worker::compositor::scene::GpuScene;

    let mut scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    scene.objects.retain(|object| object.base().id == "caption");
    let SceneObject::Text(text) = &mut scene.objects[0] else {
        panic!("caption is text")
    };
    text.text = "MMMM".into();
    text.layout = TextLayout::Point;
    text.overflow = TextOverflow::Clip;
    text.base.width = 35.0;
    text.base.height = 0.0;
    text.text_animator = Some(TextAnimator {
        x: 13.0,
        ..Default::default()
    });
    let right = (text.base.x + text.base.width) as usize;
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let assets = HashMap::from([(hash.clone(), font)]);
    let prepared = PreparedScene::prepare(
        scene,
        &HashSet::from([hash]),
        &assets,
        &MaterialSupport::fixed_function(),
    )
    .unwrap();
    let cpu = prepared.frame(OutputTransform::Srgb);
    let assert_box = |pixels: &[u8], width: usize| {
        assert!(pixels.chunks_exact(4).any(|rgba| rgba[3] > 0));
        assert!(pixels
            .chunks_exact(4)
            .enumerate()
            .all(|(index, rgba)| index % width < right || rgba[3] == 0));
    };
    assert_box(&cpu.pixels, cpu.width as usize);
    if let Some(gpu) = scalar_test_gpu() {
        let (frame, _) = GpuScene::prepare(&gpu, &prepared).unwrap().render(0).unwrap();
        assert_box(&frame.pixels, frame.width as usize);
    }
}

/// 11.51: small capitals and the first-line indent reach the pixels (CPU, and the GPU compositor where there is one), measured as the ink's
/// extent: small capitals are narrower than all-capitals, and an indent moves the ink right by the indent.
#[test]
fn small_caps_and_text_indent_reach_the_pixels() {
    use gx_contracts::scene::{SceneObject, TextAutoFit, TextCase, TextLayout};
    use gx_render_worker::compositor::scene::GpuScene;

    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let assets = HashMap::from([(hash.clone(), font)]);
    let gpu = scalar_test_gpu();
    // The ink's left and right pixel columns, of the caption under `set`, on the CPU path and then the GPU path.
    let ink = |set: &dyn Fn(&mut gx_contracts::scene::TextObject)| -> Vec<(usize, usize)> {
        let mut scene = parse_scene_document(include_bytes!("../../../../tests/reference-scenes/colour-ramp-50.json")).unwrap();
        scene.objects.retain(|object| object.base().id == "caption");
        let SceneObject::Text(text) = &mut scene.objects[0] else { panic!("caption is text") };
        text.text = "Hexx Hexx".into();
        text.layout = TextLayout::Point;
        text.auto_fit = TextAutoFit::None;
        text.base.width = 0.0;
        text.base.height = 0.0;
        set(text);
        let prepared = PreparedScene::prepare(scene, &HashSet::from([hash.clone()]), &assets, &MaterialSupport::fixed_function()).unwrap();
        let extent = |pixels: &[u8], width: usize| {
            let columns: Vec<usize> = pixels.chunks_exact(4).enumerate().filter(|(_, rgba)| rgba[3] > 0).map(|(index, _)| index % width).collect();
            (*columns.iter().min().expect("ink"), *columns.iter().max().unwrap())
        };
        let cpu = prepared.frame(OutputTransform::Srgb);
        let mut found = vec![extent(&cpu.pixels, cpu.width as usize)];
        if let Some(gpu) = &gpu {
            let (frame, _) = GpuScene::prepare(gpu, &prepared).unwrap().render(0).unwrap();
            found.push(extent(&frame.pixels, frame.width as usize));
        }
        found
    };
    let upper = ink(&|t| t.text_case = TextCase::Upper);
    let small = ink(&|t| t.text_case = TextCase::SmallCaps);
    let flat = ink(&|t| t.text_case = TextCase::Original);
    let indented = ink(&|t| {
        t.text_case = TextCase::Original;
        t.text_indent = 30.0;
    });
    for path in 0..upper.len() {
        let width = |(left, right): (usize, usize)| right - left;
        assert!(width(small[path]) < width(upper[path]), "path {path}: small caps {:?} vs capitals {:?}", small[path], upper[path]);
        assert!(width(small[path]) > width(upper[path]) * 3 / 4, "path {path}: only the lowercase letters shrink");
        assert_eq!(small[path].0, upper[path].0, "path {path}: the first capital starts where it did");
        let moved = indented[path].0 as i64 - flat[path].0 as i64;
        assert!((moved - 30).abs() <= 1, "path {path}: the ink moved {moved}, not 30");
        assert_eq!(width(indented[path]), width(flat[path]), "path {path}: the text itself is the same width");
    }
}

/// The reference scene with its caption in `text`, set in Noto Sans Arabic (packaged beside this test), as point text at a size that fits
/// the 320 x 180 frame. The font is swapped through the scene's JSON so the font, the asset and the checksum stay one consistent record.
fn font_caption_scene(font: &[u8], family: &str, file: &str, format: &str, text: &str, size: f64) -> (gx_contracts::scene::SceneDocument, HashMap<gx_contracts::ContentHash, Vec<u8>>, gx_contracts::ContentHash) {
    use gx_contracts::scene::{SceneObject, TextAutoFit, TextLayout};

    let font = font.to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let mut json: serde_json::Value = serde_json::from_slice(include_bytes!("../../../../tests/reference-scenes/colour-ramp-50.json")).unwrap();
    json["fonts"][0]["family"] = family.into();
    json["fonts"][0]["displayName"] = family.into();
    json["fonts"][0]["faces"][0]["family"] = family.into();
    json["fonts"][0]["faces"][0]["source"]["format"] = format.into();
    json["fonts"][0]["faces"][0]["source"]["assetId"] = "caption-font".into();
    json["assets"][0]["assetId"] = "caption-font".into();
    json["assets"][0]["name"] = family.into();
    json["assets"][0]["mimeType"] = (if format == "otf" { "font/otf" } else { "font/ttf" }).into();
    json["assets"][0]["path"] = format!("services/render-engine/worker/tests/fixtures/{file}").into();
    json["assets"][0]["checksum"] = hash.to_string().into();
    let mut scene = parse_scene_document(&serde_json::to_vec(&json).unwrap()).unwrap();
    scene.objects.retain(|object| object.base().id == "caption");
    let SceneObject::Text(caption) = &mut scene.objects[0] else { panic!("caption is text") };
    caption.text = text.into();
    caption.size = size;
    caption.layout = TextLayout::Point;
    caption.auto_fit = TextAutoFit::None;
    caption.base.x = 20.0;
    caption.base.y = 60.0;
    caption.base.width = 0.0;
    caption.base.height = 0.0;
    (scene, HashMap::from([(hash.clone(), font)]), hash)
}

/// The frame of a caption in `font` on the CPU path, and on the GPU compositor where there is one.
fn font_frames(font: &[u8], family: &str, file: &str, format: &str, text: &str, size: f64) -> Vec<(u32, u32, Vec<u8>)> {
    font_frames_with(font, family, file, format, text, size, &|_| {})
}

/// As `font_frames`, with `set` applied to the caption (its writing mode, box and the like) before it is drawn.
fn font_frames_with(
    font: &[u8],
    family: &str,
    file: &str,
    format: &str,
    text: &str,
    size: f64,
    set: &dyn Fn(&mut gx_contracts::scene::TextObject),
) -> Vec<(u32, u32, Vec<u8>)> {
    use gx_contracts::scene::SceneObject;
    use gx_render_worker::compositor::scene::GpuScene;

    let (mut scene, assets, hash) = font_caption_scene(font, family, file, format, text, size);
    let SceneObject::Text(caption) = &mut scene.objects[0] else { panic!("caption is text") };
    set(caption);
    let prepared = PreparedScene::prepare(scene, &HashSet::from([hash]), &assets, &MaterialSupport::fixed_function()).unwrap();
    let cpu = prepared.frame(OutputTransform::Srgb);
    let mut frames = vec![(cpu.width, cpu.height, cpu.pixels)];
    if let Some(gpu) = scalar_test_gpu() {
        let (frame, _) = GpuScene::prepare(&gpu, &prepared).unwrap().render(0).unwrap();
        frames.push((frame.width, frame.height, frame.pixels));
    }
    frames
}

fn arabic_frames(text: &str, size: f64) -> Vec<(u32, u32, Vec<u8>)> {
    font_frames(include_bytes!("fixtures/NotoSansArabic-Regular.ttf"), "Noto Sans Arabic", "NotoSansArabic-Regular.ttf", "ttf", text, size)
}

fn cjk_frames(text: &str, size: f64) -> Vec<(u32, u32, Vec<u8>)> {
    font_frames(include_bytes!("fixtures/NotoSansSC-Subset.otf"), "Noto Sans SC", "NotoSansSC-Subset.otf", "otf", text, size)
}

/// Writes the golden PNG when `GX_UPDATE_GOLDEN` is set, then holds the CPU frame to it (within one code value) and the GPU frame, where there
/// is one, to the CPU frame (99.5 per cent of values within 24).
fn hold_to_golden(name: &str, frames: &[(u32, u32, Vec<u8>)]) {
    let golden_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden").join(name);
    let (width, height, pixels) = &frames[0];
    if std::env::var("GX_UPDATE_GOLDEN").is_ok() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(&golden_path).unwrap()), *width, *height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(pixels).unwrap();
    }
    let decoder = png::Decoder::new(std::fs::File::open(&golden_path).expect("the golden frame exists (GX_UPDATE_GOLDEN=1 writes it)"));
    let mut reader = decoder.read_info().unwrap();
    let mut golden = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut golden).unwrap();
    assert_eq!((info.width, info.height), (*width, *height), "{name}: the golden frame is another size");
    let worst = pixels.iter().zip(&golden).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap();
    assert!(worst <= 1, "{name}: the CPU frame differs from the golden frame by {worst} code values");
    if let Some((_, _, gpu)) = frames.get(1) {
        let off = pixels.iter().zip(gpu).filter(|(a, b)| (**a as i32 - **b as i32).abs() > 24).count();
        assert!(off * 200 < pixels.len(), "{name}: the GPU frame differs from the CPU frame in {off} values");
    }
}

/// Columns holding any ink (alpha above zero), as the left and right edge.
fn ink_columns(pixels: &[u8], width: usize) -> (usize, usize) {
    let columns: Vec<usize> = pixels.chunks_exact(4).enumerate().filter(|(_, rgba)| rgba[3] > 0).map(|(index, _)| index % width).collect();
    (*columns.iter().min().expect("the text left ink"), *columns.iter().max().unwrap())
}

/// 11.51: Arabic is drawn right to left. Two words set together put the first word on the right, and that word's ink is the ink of the
/// same word set alone (same size, same shaping), so the proof does not depend on any golden file; then the whole frame is held against its
/// golden PNG (set `GX_UPDATE_GOLDEN=1` to write it once, then read it before committing it).
#[test]
fn arabic_text_draws_right_to_left_and_matches_its_golden_frame() {
    const FIRST: &str = "مرحبا";
    const SECOND: &str = "بالعالم";
    let together = arabic_frames(&format!("{FIRST} {SECOND}"), 36.0);
    let first_alone = arabic_frames(FIRST, 36.0);
    let second_alone = arabic_frames(SECOND, 36.0);
    for path in 0..together.len() {
        let (width, _, pixels) = &together[path];
        let width = *width as usize;
        let (left, right) = ink_columns(pixels, width);
        let (first_left, first_right) = ink_columns(&first_alone[path].2, width);
        let (second_left, second_right) = ink_columns(&second_alone[path].2, width);
        let first_width = first_right - first_left + 1;
        let second_width = second_right - second_left + 1;
        // Together, the line is the two words and a space; the first word is the right-hand one, and the second word starts the line.
        assert!(right - left + 1 > first_width + second_width, "path {path}: the two words are not both drawn");
        // The right-hand `first_width` columns of the line are the first word alone, to within the sub-pixel shift of where it starts.
        let height = pixels.len() / 4 / width;
        let mut worst = 0_i32;
        let mut total = 0_i64;
        let mut count = 0_i64;
        for y in 0..height {
            for offset in 0..first_width {
                let together_pixel = pixels[(y * width + right - offset) * 4 + 3] as i32;
                let alone_pixel = first_alone[path].2[(y * width + first_right - offset) * 4 + 3] as i32;
                let diff = (together_pixel - alone_pixel).abs();
                worst = worst.max(diff);
                total += diff as i64;
                count += 1;
            }
        }
        let mean = total as f64 / count as f64;
        assert!(mean < 3.0, "path {path}: the right-hand word is not the first word (mean alpha difference {mean}, worst {worst})");
        // The left-hand word is the second word.
        let mut total = 0_i64;
        for y in 0..height {
            for offset in 0..second_width {
                let together_pixel = pixels[(y * width + left + offset) * 4 + 3] as i32;
                let alone_pixel = second_alone[path].2[(y * width + second_left + offset) * 4 + 3] as i32;
                total += (together_pixel - alone_pixel).abs() as i64;
            }
        }
        let mean = total as f64 / (height * second_width) as f64;
        assert!(mean < 3.0, "path {path}: the left-hand word is not the second word (mean alpha difference {mean})");
    }

    // Two renders of one frame are the same bytes.
    assert_eq!(arabic_frames(&format!("{FIRST} {SECOND}"), 36.0)[0].2, together[0].2, "two renders of the Arabic frame differ");

    // The golden frame: the CPU path against the stored PNG, the GPU path (where there is one) against the CPU path.
    hold_to_golden("arabic-rtl-320x180.png", &together);
}

/// 11.51: Chinese is drawn left to right, one em to a character, from the CJK face alone (Noto Sans SC, subset, packaged beside this test).
/// Four characters set together are four ems wide; the first two set alone are the left half of them, pixel for pixel; two renders are the
/// same bytes; the frame is held to its golden PNG.
#[test]
fn cjk_text_draws_left_to_right_one_em_a_character_and_matches_its_golden_frame() {
    const SIZE: f64 = 36.0;
    let together = cjk_frames("你好世界", SIZE);
    let first_pair = cjk_frames("你好", SIZE);
    for path in 0..together.len() {
        let (width, height, pixels) = (together[path].0 as usize, together[path].1 as usize, &together[path].2);
        let (left, right) = ink_columns(pixels, width);
        let (pair_left, pair_right) = ink_columns(&first_pair[path].2, width);
        let ink_width = (right - left + 1) as f64;
        assert!(ink_width > SIZE * 3.4 && ink_width < SIZE * 4.0, "path {path}: four characters span {ink_width}, not about four ems of {SIZE}");
        assert_eq!(left, pair_left, "path {path}: the line does not start where the pair starts");
        // The first two characters are the left half of the four, pixel for pixel (a character's ink never crosses into the next em).
        let mut worst = 0_i32;
        for y in 0..height {
            for x in left..=pair_right {
                let a = pixels[(y * width + x) * 4 + 3] as i32;
                let b = first_pair[path].2[(y * width + x) * 4 + 3] as i32;
                worst = worst.max((a - b).abs());
            }
        }
        assert!(worst <= 8, "path {path}: the first two characters are not the left half of the line (worst alpha difference {worst})");
    }
    assert_eq!(cjk_frames("你好世界", SIZE)[0].2, together[0].2, "two renders of the CJK frame differ");
    hold_to_golden("cjk-ltr-320x180.png", &together);
}

/// The rows holding any ink (alpha above zero), as the top and bottom edge.
fn ink_rows(pixels: &[u8], width: usize) -> (usize, usize) {
    let rows: Vec<usize> = pixels.chunks_exact(4).enumerate().filter(|(_, rgba)| rgba[3] > 0).map(|(index, _)| index / width).collect();
    (*rows.iter().min().expect("the text left ink"), *rows.iter().max().unwrap())
}

/// 11.51: vertical text is drawn upright in columns. Four characters in `vertical-rl` are one em wide and four ems tall, and the top two are
/// the same ink as those two set alone; two paragraphs are two columns, the first on the right in `vertical-rl` and on the left in
/// `vertical-lr`, each the same ink as that paragraph set alone; two renders are the same bytes; the two-column frame is held to its golden
/// PNG (CPU, and the GPU against it).
#[test]
fn vertical_cjk_draws_upright_in_columns_and_matches_its_golden_frame() {
    use gx_contracts::scene::WritingMode::{VerticalLr, VerticalRl};
    const SIZE: f64 = 36.0;
    let font = include_bytes!("fixtures/NotoSansSC-Subset.otf");
    let frames = |text: &str, mode: gx_contracts::scene::WritingMode| {
        font_frames_with(font, "Noto Sans SC", "NotoSansSC-Subset.otf", "otf", text, SIZE, &|caption| {
            caption.writing_mode = mode;
            // A line of one and a half ems: 54 units, a whole number, so a column lands on whole pixels.
            caption.line_height = Some(1.5);
            // Four cells of 36 units fit the 180 high frame from here.
            caption.base.y = 10.0;
        })
    };
    let alpha_difference = |a: &[u8], a_shift: i64, b: &[u8], width: usize, columns: std::ops::RangeInclusive<usize>| {
        // The mean alpha difference over `columns` of `b` against `a` shifted right by `a_shift`, over every row.
        let height = b.len() / 4 / width;
        let (mut total, mut count) = (0_i64, 0_i64);
        for y in 0..height {
            for x in columns.clone() {
                let from = x as i64 - a_shift;
                let other = if from < 0 { 0 } else { a[(y * width + from as usize) * 4 + 3] as i64 };
                total += (b[(y * width + x) * 4 + 3] as i64 - other).abs();
                count += 1;
            }
        }
        total as f64 / count as f64
    };

    let four = frames("你好世界", VerticalRl);
    let top_two = frames("你好", VerticalRl);
    for path in 0..four.len() {
        let width = four[path].0 as usize;
        let (left, right) = ink_columns(&four[path].2, width);
        let (top, bottom) = ink_rows(&four[path].2, width);
        let (_, top_two_bottom) = ink_rows(&top_two[path].2, width);
        assert!(((right - left + 1) as f64) <= SIZE * 1.05, "path {path}: one column is {} wide", right - left + 1);
        assert!(((bottom - top + 1) as f64) > SIZE * 3.4 && ((bottom - top + 1) as f64) < SIZE * 4.0, "path {path}: four characters are {} tall", bottom - top + 1);
        assert_eq!(ink_rows(&top_two[path].2, width).0, top, "path {path}: the pair starts where the four start");
        // The top two characters of the four are the pair set alone.
        let height = four[path].2.len() / 4 / width;
        let mut worst = 0_i32;
        for y in 0..=top_two_bottom.min(height - 1) {
            for x in 0..width {
                worst = worst.max((four[path].2[(y * width + x) * 4 + 3] as i32 - top_two[path].2[(y * width + x) * 4 + 3] as i32).abs());
            }
        }
        assert!(worst <= 8, "path {path}: the top two characters are not the pair alone (worst alpha difference {worst})");
    }

    // Two paragraphs, two columns.
    let rl = frames("你好\n世界", VerticalRl);
    let lr = frames("你好\n世界", VerticalLr);
    let first = frames("你好", VerticalLr);
    let second = frames("世界", VerticalLr);
    for path in 0..rl.len() {
        let width = rl[path].0 as usize;
        let (lr_left, _) = ink_columns(&lr[path].2, width);
        let (first_left, first_right) = ink_columns(&first[path].2, width);
        let (second_left, second_right) = ink_columns(&second[path].2, width);
        let step = (SIZE * 1.5) as i64;
        // vertical-lr: the first paragraph is the left column (where it is set alone), the second one step to the right.
        assert_eq!(lr_left, first_left, "path {path}: the first paragraph does not start the line");
        assert!(alpha_difference(&first[path].2, 0, &lr[path].2, width, first_left..=first_right) < 3.0, "path {path}: lr left column is not the first paragraph");
        assert!(alpha_difference(&second[path].2, step, &lr[path].2, width, second_left + step as usize..=second_right + step as usize) < 3.0, "path {path}: lr right column is not the second paragraph");
        // vertical-rl: the first paragraph is the right column, one step to the right of where it is set alone in vertical-lr.
        assert!(alpha_difference(&first[path].2, step, &rl[path].2, width, first_left + step as usize..=first_right + step as usize) < 3.0, "path {path}: rl right column is not the first paragraph");
        assert!(alpha_difference(&second[path].2, 0, &rl[path].2, width, second_left..=second_right) < 3.0, "path {path}: rl left column is not the second paragraph");
    }
    assert_eq!(frames("你好\n世界", VerticalRl)[0].2, rl[0].2, "two renders of the vertical frame differ");
    hold_to_golden("cjk-vertical-rl-320x180.png", &rl);
}

/// 11.61: the four EffectCraft text-animator presets the contract applies, put on a two-line caption
/// with `text_animator_presets::apply`, saved, reopened and rendered. Each one must start with no ink
/// (the same frame as the text switched off), pass through frames that are neither end, finish as the
/// plain text with no animator, and give the same bytes when a frame is rendered twice. On the CPU
/// always; on hardware too when GX_TEST_SCALAR_GPU names a backend.
#[test]
fn applied_text_animator_presets_start_hidden_finish_as_the_plain_text_and_repeat_byte_for_byte() {
    use gx_contracts::scene::SceneObject;
    use gx_contracts::text_animator_presets::{apply, ID_PREFIX};
    use gx_render_worker::compositor::scene::GpuScene;

    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare = |scene| PreparedScene::prepare(scene, &available, &assets, &materials).unwrap();
    let max_code_difference = |left: &[u8], right: &[u8]| {
        assert_eq!(left.len(), right.len());
        left.iter().zip(right).map(|(a, b)| a.abs_diff(*b)).max().unwrap_or(0)
    };

    let mut base = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    base.objects.retain(|object| object.base().id == "caption");
    base.timeline.duration_frames = 200;
    let SceneObject::Text(text) = &mut base.objects[0] else {
        panic!("caption is text")
    };
    text.text = "GrapiX\nreference".into();
    let plain = prepare(base.clone());
    let mut off = base.clone();
    off.objects[0].base_mut().visible = false;
    let hidden = prepare(off);
    let plain_frame = plain.frame(OutputTransform::Srgb);
    let hidden_frame = hidden.frame(OutputTransform::Srgb);
    assert_ne!(plain_frame, hidden_frame, "the caption has ink to show and to hide");

    let hardware = scalar_test_gpu();
    let (gpu_plain, gpu_hidden) = match &hardware {
        Some(gpu) => (
            Some(GpuScene::prepare(gpu, &plain).unwrap().render(0).unwrap().0),
            Some(GpuScene::prepare(gpu, &hidden).unwrap().render(0).unwrap().0),
        ),
        None => (None, None),
    };

    for (name, length) in [
        ("typewriter", 100),
        ("fadeUpCharacters", 75),
        ("trackingIn", 80),
        ("dropInLines", 70),
    ] {
        let mut scene = base.clone();
        let applied = apply(&mut scene, "caption", &format!("{ID_PREFIX}{name}"), 0).unwrap();
        assert_eq!(applied, length, "{name}: its length in frames");
        let restored = parse_scene_document(&serde_json::to_vec(&scene).unwrap()).unwrap();
        assert_eq!(restored, scene, "{name}: it survives save and reopen");
        let animated = prepare(restored);
        let middle_frame = length / 2;

        let start = animated.frame_at(0, OutputTransform::Srgb).unwrap();
        let middle = animated.frame_at(middle_frame, OutputTransform::Srgb).unwrap();
        let end = animated.frame_at(length, OutputTransform::Srgb).unwrap();
        // Byte for byte, not only alpha: a glyph left at an alpha of 1e-16 draws nothing but leaves
        // its colour in the frame ([255, 255, 255, 0]), which is how the selector rounding was found.
        assert_eq!(start, hidden_frame, "{name}: frame 0 shows no ink");
        assert_ne!(middle, start, "{name}: the middle has begun");
        assert_ne!(middle, end, "{name}: the middle has not finished");
        let finish = max_code_difference(&end.pixels, &plain_frame.pixels);
        assert!(finish <= 1, "{name}: its last frame differs from the plain text by {finish} codes");
        assert_eq!(
            animated.frame_at(middle_frame, OutputTransform::Srgb).unwrap(),
            middle,
            "{name}: two renders of one frame are the same bytes"
        );
        // A frame after the last key holds the last key.
        assert_eq!(animated.frame_at(length + 30, OutputTransform::Srgb).unwrap(), end, "{name}: it holds");

        if let (Some(gpu), Some(gpu_plain), Some(gpu_hidden)) = (&hardware, &gpu_plain, &gpu_hidden) {
            let mut scene = GpuScene::prepare(gpu, &animated).unwrap();
            let start = scene.render(0).unwrap().0;
            let middle = scene.render(middle_frame).unwrap().0;
            let end = scene.render(length).unwrap().0;
            let hidden = max_code_difference(&start.pixels, &gpu_hidden.pixels);
            assert!(hidden <= 1, "{name}: hardware frame 0 differs from the hidden text by {hidden} codes");
            assert_ne!(middle.pixels, start.pixels, "{name}: hardware middle has begun");
            assert_ne!(middle.pixels, end.pixels, "{name}: hardware middle has not finished");
            let finish = max_code_difference(&end.pixels, &gpu_plain.pixels);
            assert!(finish <= 1, "{name}: hardware last frame differs from the plain text by {finish} codes");
            let again = scene.render(middle_frame).unwrap().0;
            assert_eq!(again.pixels, middle.pixels, "{name}: hardware renders one frame to the same bytes");
        }
    }
}

/// 11.61: a frame that only moves a text animator shapes no text, on the CPU path and on the GPU: it places the glyph outlines
/// that were shaped when the scene was prepared, each by its own transform, alpha and fill. And what the GPU builds for such a
/// frame does not grow with the number of glyphs: their coverage shares a sheet and each glyph is one draw record (before, each
/// glyph was a texture, a buffer, a bind group and a submission of its own: 30 builds a frame for 15 glyphs and 112 for 64).
/// The counter is shown to count: a keyed size, which changes the layout, shapes the text again on its frames.
#[test]
fn a_frame_of_a_text_animator_shapes_no_text_and_its_gpu_work_does_not_grow_with_the_glyphs() {
    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::scene::SceneObject;
    use gx_contracts::text_animator_presets::{apply, ID_PREFIX};
    use gx_render_worker::compositor::scene::GpuScene;
    use gx_render_worker::render_work::RenderWork;

    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    let available = HashSet::from([hash.clone()]);
    let assets = HashMap::from([(hash, font)]);
    let materials = MaterialSupport::fixed_function();
    let prepare = |scene| PreparedScene::prepare(scene, &available, &assets, &materials).unwrap();
    let caption = |text: &str| {
        let mut scene = parse_scene_document(include_bytes!(
            "../../../../tests/reference-scenes/colour-ramp-50.json"
        ))
        .unwrap();
        scene.objects.retain(|object| object.base().id == "caption");
        scene.timeline.duration_frames = 200;
        let SceneObject::Text(object) = &mut scene.objects[0] else {
            panic!("caption is text")
        };
        object.text = text.into();
        object.base.height = 140.0;
        scene
    };
    // Fade Up Characters gives every glyph its own opacity, so every glyph is a path of its own.
    let fading = |text: &str| {
        let mut scene = caption(text);
        apply(&mut scene, "caption", &format!("{ID_PREFIX}fadeUpCharacters"), 0).unwrap();
        prepare(scene)
    };
    let short = fading("GrapiX\nreference");
    let long = fading("GrapiX reference\ncaption line two\nand a third line\nfourth line here");
    let glyphs = |scene: &PreparedScene| scene.texts().objects[0].glyphs.len();
    assert!(glyphs(&long) >= 4 * glyphs(&short), "{} and {} glyphs", glyphs(&short), glyphs(&long));
    let mut sized = caption("GrapiX\nreference");
    sized.timeline.channels.push(KeyframeChannel {
        object_id: "caption".into(),
        property: "size".into(),
        keys: [(0, 20.0), (40, 30.0)]
            .into_iter()
            .map(|(frame, value)| SceneKeyframe { frame, value, easing: SceneEasing::Linear, bezier: None })
            .collect(),
    });
    let sized = prepare(sized);
    let frames = 20..30_u64;

    let before = RenderWork::snapshot();
    for frame in frames.clone() {
        short.frame_at(frame, OutputTransform::Srgb).unwrap();
        long.frame_at(frame, OutputTransform::Srgb).unwrap();
    }
    assert_eq!(RenderWork::snapshot().since(before).cpu_text_shapings, 0, "the CPU path shaped text on an animator frame");
    let before = RenderWork::snapshot();
    for frame in frames.clone() {
        sized.frame_at(frame, OutputTransform::Srgb).unwrap();
    }
    let shaped = RenderWork::snapshot().since(before).cpu_text_shapings;
    assert!(shaped >= frames.clone().count() as u64, "a keyed size shapes the text on each frame, counted {shaped}");

    let Some(gpu) = scalar_test_gpu() else { return };
    let count = frames.clone().count() as u64;
    let mut builds = Vec::new();
    for prepared in [&short, &long] {
        let mut scene = GpuScene::prepare(&gpu, prepared).unwrap();
        scene.render(15).unwrap();
        let before = RenderWork::snapshot();
        for frame in frames.clone() {
            scene.render(frame).unwrap();
        }
        let work = RenderWork::snapshot().since(before);
        assert_eq!(work.cpu_text_shapings, 0, "the GPU path shaped text on an animator frame ({} glyphs)", glyphs(prepared));
        builds.push(work.gpu_resource_builds);
    }
    // The frames did draw (the layer's source was built again on each one), and four times the glyphs built nothing more:
    // the layer's buffer, one coverage sheet, the draw records and their bind group.
    assert!(builds[0] >= count, "{} GPU builds over {count} frames", builds[0]);
    assert_eq!(
        builds[0], builds[1],
        "{} glyphs took {} GPU builds over {count} frames and {} glyphs took {}",
        glyphs(&short), builds[0], glyphs(&long), builds[1]
    );
    assert!(builds[1] <= 6 * count, "{} GPU builds over {count} frames for one text layer", builds[1]);
    let mut scene = GpuScene::prepare(&gpu, &sized).unwrap();
    let before = RenderWork::snapshot();
    for frame in frames.clone() {
        scene.render(frame).unwrap();
    }
    let shaped = RenderWork::snapshot().since(before).cpu_text_shapings;
    assert!(shaped >= count, "on the GPU path a keyed size shapes the text on each frame, counted {shaped}");
}
