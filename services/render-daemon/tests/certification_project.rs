//! Deterministic 80-scene control-plane certification project.
//!
//! This verifies catalogue/lifecycle/warm/Take behavior without claiming GPU,
//! decoder, NDI, or long-soak hardware certification.

use std::sync::Arc;
use std::time::{Duration, Instant};

use grapix_render_daemon::scene::{prepare_scene, SceneRegistry};
use serde_json::{json, Value};

const GROUPS: &[(&str, usize)] = &[
    ("simple-2d", 20),
    ("data-lower-third", 15),
    ("score-statistics", 10),
    ("video", 10),
    ("transition", 10),
    ("multi-video", 5),
    ("3d", 5),
    ("mixed-heavy", 5),
];

fn certification_scenes() -> Vec<Value> {
    let mut scenes = Vec::new();
    for (group, count) in GROUPS {
        for index in 0..*count {
            let id = format!("cert_{group}_{index:02}");
            scenes.push(json!({
                "id": id,
                "name": format!("{group} {index:02}"),
                "version": 1,
                "canvas": { "width": 1920, "height": 1080, "background": "#07111f" },
                "dataContext": {
                    "certificationGroup": group,
                    "index": index,
                    "liveValue": 0
                },
                // Workload intent is explicit even where a vendor decoder or
                // 3D runtime is an external/feature gate.
                "certificationWorkload": {
                    "videoLayers": if group.contains("video") || *group == "mixed-heavy" { 2 } else { 0 },
                    "gltfModels": if *group == "3d" || *group == "mixed-heavy" { 1 } else { 0 },
                    "lights": if *group == "3d" || *group == "mixed-heavy" { 2 } else { 0 },
                    "continuousData": *group == "data-lower-third" || *group == "score-statistics"
                },
                "assets": [],
                "materials": [],
                "objects": [
                    {
                        "id": format!("rect_{index}"), "name": "Plate", "type": "rect",
                        "x": 100, "y": 700, "zDepth": 0, "zIndex": 0, "layerId": "main",
                        "width": 800, "height": 180, "rotation": 0, "opacity": 1,
                        "visible": true, "locked": false, "fill": "#164e82",
                        "stroke": "#ffffff", "strokeWidth": 0, "bindings": {},
                        "materialSlots": {}, "radius": 0
                    },
                    {
                        "id": format!("ellipse_{index}"), "name": "Indicator", "type": "ellipse",
                        "x": 750, "y": 735, "zDepth": 0, "zIndex": 1, "layerId": "main",
                        "width": 96, "height": 96, "rotation": 0, "opacity": 1,
                        "visible": true, "locked": false, "fill": "#32d583",
                        "stroke": "#ffffff", "strokeWidth": 0, "bindings": {},
                        "materialSlots": {}
                    }
                ],
                "timeline": { "fps": 60, "durationFrames": 600, "keyframes": [] },
                "createdAt": "2026-07-25T00:00:00.000Z",
                "updatedAt": format!("cert-r-{group}-{index:02}")
            }));
        }
    }
    scenes
}

#[test]
fn project_has_exact_reviewed_80_scene_mix() {
    let scenes = certification_scenes();
    assert_eq!(scenes.len(), 80);
    for (group, expected) in GROUPS {
        assert_eq!(
            scenes
                .iter()
                .filter(|scene| scene["dataContext"]["certificationGroup"] == *group)
                .count(),
            *expected,
            "wrong scene count for group {group}"
        );
    }
}

#[test]
fn all_scenes_prepare_under_normal_2d_warm_target() {
    for scene in certification_scenes() {
        let started = Instant::now();
        let prepared = prepare_scene(&scene).expect("certification scene must prepare");
        assert!(prepared.take_blockers.is_empty());
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "{} exceeded 500ms cached 2D warm target",
            prepared.scene_id
        );
    }
}

#[test]
fn repeated_preview_and_take_preserve_active_scenes_and_bound_warm_lru() {
    let scenes = certification_scenes();
    let mut registry = SceneRegistry::new(3, u64::MAX);
    let mut previous_program: Option<String> = None;

    for source in scenes {
        let scene = Arc::new(prepare_scene(&source).unwrap());
        let id = scene.scene_id.clone();
        let revision = scene.revision.clone();
        registry.insert(scene);
        registry.set_preview(&id, &revision).unwrap();

        let started = Instant::now();
        registry.take_program(&id, &revision).unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "{id} exceeded 100ms prepared-scene Take target"
        );
        assert_eq!(registry.program_scene_id(), Some(id.as_str()));
        assert!(registry.warm_scene_count() <= 3);
        if let Some(previous) = previous_program {
            // Previous Program may remain warm or be evicted, but current
            // Program/Preview must always survive.
            let _ = previous;
        }
        previous_program = Some(id);
    }
}
