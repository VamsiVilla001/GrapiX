//! The 50,000 x 50,000 virtual canvas and its precision contract.
//!
//! These tests exist to make the central claim checkable rather than asserted:
//! that a huge stage is representable, that it is never allocated, and that
//! rebasing before narrowing is what keeps geometry accurate at the far edge.

use grapix_render_engine::stage::{
    f32_error, local_f32_error, EngineStageLimits, FrameRate, OriginAnchor, Point, Rect, Size,
    StageDocument, StageOrigin, SurfacePlacement, TilingConfig, VirtualCanvas, Viewport,
    ViewportSource, MAX_LOGICAL_CANVAS_DIMENSION,
};

fn limits() -> EngineStageLimits {
    EngineStageLimits {
        max_logical_canvas_width: 50_000.0,
        max_logical_canvas_height: 50_000.0,
        max_texture_dimension: 16_384,
        tile_rendering: true,
        max_surfaces: 64,
        max_outputs: 8,
    }
}

#[test]
fn supports_a_50000_square_canvas_without_allocating_anything() {
    let canvas = VirtualCanvas::new(50_000.0, 50_000.0);

    assert_eq!(canvas.logical_width, 50_000.0);
    assert_eq!(MAX_LOGICAL_CANVAS_DIMENSION, 50_000.0);

    // The number that makes the case for tiling: one stage-sized RGBA8 target is
    // 10 GB, which is why the engine never materialises one.
    assert_eq!(canvas.full_resolution_bytes(), 10_000_000_000);

    assert!(canvas.exceeds_texture_limit(16_384));
    assert!(!canvas.exceeds_texture_limit(65_536));
}

#[test]
fn canvas_dimensions_clamp_to_the_documented_range() {
    assert_eq!(
        VirtualCanvas::new(120_000.0, 1080.0).normalized().logical_width,
        50_000.0
    );
    // Nonsense falls back to a documented default rather than propagating.
    assert_eq!(VirtualCanvas::new(0.0, 1080.0).normalized().logical_width, 1920.0);
    assert_eq!(
        VirtualCanvas::new(f64::NAN, 1080.0).normalized().logical_width,
        1920.0
    );
    assert_eq!(
        VirtualCanvas::new(-5.0, 1080.0).normalized().logical_width,
        1920.0
    );
}

#[test]
fn normalisation_is_idempotent() {
    let once = VirtualCanvas::new(50_000.0, 10_000.0).normalized();
    assert_eq!(once.normalized(), once);
}

#[test]
fn rebasing_onto_a_tile_origin_recovers_precision_the_gpu_would_lose() {
    // A coordinate near the far edge of a 50,000 unit stage.
    let absolute = 49_999.37_f64;
    let tile_origin = 49_152.0_f64; // column 24 of a 2048 grid

    let absolute_error = f32_error(absolute);
    let local_error = local_f32_error(absolute, tile_origin);

    // Float32 near 50,000 steps in units of 2^-8, so absolute coordinates are
    // already wrong by roughly a thousandth of a pixel before any transform chain
    // compounds it.
    assert!(
        absolute_error > 1e-4,
        "expected absolute f32 error > 1e-4, got {absolute_error}"
    );

    // After the f64 subtraction the magnitude is under 1024, where float32 steps in
    // units of 2^-14.
    assert!(
        local_error < 1e-4,
        "expected local f32 error < 1e-4, got {local_error}"
    );
    assert!(
        absolute_error / local_error > 32.0,
        "expected at least 32x improvement, got {}",
        absolute_error / local_error
    );
}

#[test]
fn to_local_subtracts_in_double_precision_and_preserves_extent() {
    let source = Rect::new(49_999.37, 24_999.81, 640.0, 360.0);
    let local = source.to_local(Point::new(49_152.0, 24_576.0));

    assert_eq!(local.width, 640.0);
    assert_eq!(local.height, 360.0);
    assert!((local.x - 847.37).abs() < 1e-9);
    assert!((local.y - 423.81).abs() < 1e-9);

    // Narrowing the rebased rect keeps sub-thousandth-pixel accuracy.
    let narrowed = local.narrow_f32();
    assert!((f64::from(narrowed[0]) - local.x).abs() < 1e-4);
    assert!((f64::from(narrowed[1]) - local.y).abs() < 1e-4);

    // And the round trip recovers the original stage position exactly.
    assert_eq!(local.to_stage(Point::new(49_152.0, 24_576.0)), source);
}

#[test]
fn origin_anchor_changes_the_coordinate_space_not_the_size() {
    let top_left = VirtualCanvas::new(50_000.0, 10_000.0);
    assert_eq!(top_left.bounds(), Rect::new(0.0, 0.0, 50_000.0, 10_000.0));

    let centered = VirtualCanvas {
        origin: StageOrigin {
            anchor: OriginAnchor::Center,
            offset_x: 0.0,
            offset_y: 0.0,
        },
        ..VirtualCanvas::new(50_000.0, 10_000.0)
    };
    assert_eq!(
        centered.bounds(),
        Rect::new(-25_000.0, -5_000.0, 50_000.0, 10_000.0)
    );
    assert_eq!(centered.origin_point(), Point::new(-25_000.0, -5_000.0));

    let custom = VirtualCanvas {
        origin: StageOrigin {
            anchor: OriginAnchor::Custom,
            offset_x: 100.0,
            offset_y: 50.0,
        },
        ..VirtualCanvas::new(1920.0, 1080.0)
    };
    assert_eq!(custom.bounds(), Rect::new(-100.0, -50.0, 1920.0, 1080.0));
}

#[test]
fn rect_intersection_treats_touching_edges_as_disjoint() {
    // The tile grid depends on this: touching is not overlapping, so an object
    // whose edge lands on a boundary belongs to exactly one tile.
    let left = Rect::new(0.0, 0.0, 100.0, 100.0);
    let touching = Rect::new(100.0, 0.0, 100.0, 100.0);
    assert!(!left.intersects(&touching));
    assert!(left.intersect(&touching).is_empty());

    let overlapping = Rect::new(99.0, 0.0, 100.0, 100.0);
    assert!(left.intersects(&overlapping));
    assert_eq!(left.intersect(&overlapping), Rect::new(99.0, 0.0, 1.0, 100.0));
}

// ---------------------------------------------------------------------------
// The stage from the requirements
// ---------------------------------------------------------------------------

/// A 50,000 x 10,000 LED installation driven by three UHD outputs plus a scaled
/// operator preview — the example from requirement 5.
fn arena_stage() -> StageDocument {
    use grapix_render_engine::stage::{OutputMapping, OutputMappingSource, OutputTarget, Region};

    StageDocument {
        stage_id: "stage_arena".to_string(),
        name: "Arena".to_string(),
        version: 1,
        revision: Some(1),
        canvas: VirtualCanvas::new(50_000.0, 10_000.0),
        regions: vec![
            Region {
                region_id: "region_left".to_string(),
                name: "Left".to_string(),
                bounds: Rect::new(0.0, 0.0, 3840.0, 2160.0),
            },
            Region {
                region_id: "region_centre".to_string(),
                name: "Centre".to_string(),
                bounds: Rect::new(23_080.0, 0.0, 3840.0, 2160.0),
            },
            Region {
                region_id: "region_right".to_string(),
                name: "Right".to_string(),
                bounds: Rect::new(46_160.0, 0.0, 3840.0, 2160.0),
            },
        ],
        surfaces: vec![SurfacePlacement {
            surface_id: "surface_ribbon".to_string(),
            name: "Ribbon".to_string(),
            position: Point::new(0.0, 8_000.0),
            size: Size {
                width: 50_000.0,
                height: 2_000.0,
            },
            rotation_degrees: 0.0,
            output_id: Some("output_a".to_string()),
            enabled: true,
            calibration_pending: false,
        }],
        viewports: vec![
            Viewport {
                viewport_id: "vp_left".to_string(),
                name: "Left".to_string(),
                source: ViewportSource::Region {
                    region_id: "region_left".to_string(),
                },
                render_scale: 1.0,
                enabled: true,
            },
            Viewport {
                viewport_id: "vp_operator".to_string(),
                name: "Operator".to_string(),
                source: ViewportSource::FullStage,
                // 50,000 x 10,000 down to 1920 x 384.
                render_scale: 0.0384,
                enabled: true,
            },
        ],
        outputs: vec![
            OutputTarget {
                output_id: "output_a".to_string(),
                name: "Output A".to_string(),
                width: 3840,
                height: 2160,
                frame_rate: FrameRate {
                    numerator: 60_000,
                    denominator: 1_001,
                },
                adapter_id: "null".to_string(),
                enabled: true,
            },
            OutputTarget {
                output_id: "output_preview".to_string(),
                name: "Preview".to_string(),
                width: 1920,
                height: 384,
                frame_rate: FrameRate::default(),
                adapter_id: "null".to_string(),
                enabled: true,
            },
        ],
        output_mappings: vec![
            OutputMapping {
                mapping_id: "map_a".to_string(),
                output_id: "output_a".to_string(),
                source: OutputMappingSource::Region {
                    region_id: "region_left".to_string(),
                },
                fit: Default::default(),
                enabled: true,
            },
            OutputMapping {
                mapping_id: "map_preview".to_string(),
                output_id: "output_preview".to_string(),
                source: OutputMappingSource::FullStage,
                fit: Default::default(),
                enabled: true,
            },
        ],
        tiling: TilingConfig {
            enabled: true,
            tile_width: 2048,
            tile_height: 2048,
            overscan: 32,
            ..TilingConfig::default()
        },
    }
}

#[test]
fn the_arena_stage_validates_against_a_capable_engine() {
    let validation = arena_stage().validate(&limits());
    assert!(validation.valid, "{:?}", validation.issues);
}

#[test]
fn stage_resolution_and_output_resolution_stay_independent() {
    let stage = arena_stage();

    // The left region is exactly UHD, so it feeds a UHD output 1:1 even though the
    // stage it lives on is 50,000 wide.
    let mapping = &stage.output_mappings[0];
    assert_eq!(
        stage.resolve_output_source(mapping),
        Rect::new(0.0, 0.0, 3840.0, 2160.0)
    );

    // The whole stage feeds the operator output from the same document.
    let preview = &stage.output_mappings[1];
    assert_eq!(
        stage.resolve_output_source(preview),
        Rect::new(0.0, 0.0, 50_000.0, 10_000.0)
    );
}

#[test]
fn viewport_render_scale_turns_a_huge_stage_into_a_small_preview() {
    let stage = arena_stage();

    let operator = stage.viewport("vp_operator").expect("viewport");
    assert_eq!(
        stage.resolve_viewport(operator),
        Rect::new(0.0, 0.0, 50_000.0, 10_000.0)
    );
    assert_eq!(stage.viewport_render_size(operator), (1920, 384));

    let left = stage.viewport("vp_left").expect("viewport");
    assert_eq!(stage.viewport_render_size(left), (3840, 2160));
}

#[test]
fn fit_render_scale_keeps_a_preview_inside_a_pixel_budget() {
    let full_stage = Rect::new(0.0, 0.0, 50_000.0, 50_000.0);
    let scale = StageDocument::fit_render_scale(&full_stage, 1920, 1080);

    let width = (50_000.0 * scale).ceil() as u32;
    let height = (50_000.0 * scale).ceil() as u32;
    assert!(width <= 1920, "width {width} exceeded the budget");
    assert!(height <= 1080, "height {height} exceeded the budget");

    // Never upscales a small source.
    assert_eq!(
        StageDocument::fit_render_scale(&Rect::new(0.0, 0.0, 100.0, 100.0), 1920, 1080),
        1.0
    );
}

#[test]
fn required_output_coverage_excludes_disabled_outputs() {
    let mut stage = arena_stage();
    assert_eq!(stage.required_output_coverage().len(), 2);

    stage.outputs[1].enabled = false;
    let coverage = stage.required_output_coverage();
    assert_eq!(coverage.len(), 1);
    assert_eq!(coverage[0], Rect::new(0.0, 0.0, 3840.0, 2160.0));
}

#[test]
fn a_huge_stage_with_tiling_disabled_is_refused() {
    let mut stage = arena_stage();
    stage.tiling.enabled = false;

    let validation = stage.validate(&limits());
    assert!(!validation.valid);
    assert!(validation
        .issues
        .iter()
        .any(|issue| issue.code == "TILING_REQUIRED"));
}

#[test]
fn an_engine_that_cannot_tile_refuses_a_huge_stage() {
    let mut engine_limits = limits();
    engine_limits.tile_rendering = false;

    let validation = arena_stage().validate(&engine_limits);
    assert!(!validation.valid);
    assert!(validation
        .issues
        .iter()
        .any(|issue| issue.code == "ENGINE_NO_TILING"));
}

#[test]
fn a_tile_larger_than_the_texture_limit_is_refused() {
    let mut stage = arena_stage();
    stage.tiling.tile_width = 8192;
    stage.tiling.tile_height = 8192;
    stage.tiling.overscan = 256;

    let mut engine_limits = limits();
    engine_limits.max_texture_dimension = 8192;

    let validation = stage.validate(&engine_limits);
    assert!(!validation.valid);
    // 8192 + 2*256 is 8704, past the limit.
    assert!(validation
        .issues
        .iter()
        .any(|issue| issue.code == "TILE_EXCEEDS_TEXTURE_LIMIT"));
}

#[test]
fn a_stage_larger_than_the_engine_limit_is_refused() {
    let mut engine_limits = limits();
    engine_limits.max_logical_canvas_width = 16_384.0;

    let validation = arena_stage().validate(&engine_limits);
    assert!(!validation.valid);
    assert!(validation
        .issues
        .iter()
        .any(|issue| issue.code == "ENGINE_CANVAS_WIDTH"));
}

#[test]
fn dangling_references_are_errors() {
    let mut stage = arena_stage();
    stage.viewports.push(Viewport {
        viewport_id: "vp_bad".to_string(),
        name: "Bad".to_string(),
        source: ViewportSource::Region {
            region_id: "missing".to_string(),
        },
        render_scale: 1.0,
        enabled: true,
    });
    stage.surfaces[0].output_id = Some("ghost".to_string());

    let validation = stage.validate(&limits());
    assert!(!validation.valid);

    let codes: Vec<&str> = validation
        .issues
        .iter()
        .map(|issue| issue.code.as_str())
        .collect();
    assert!(codes.contains(&"VIEWPORT_REGION_MISSING"));
    assert!(codes.contains(&"SURFACE_OUTPUT_MISSING"));
}

#[test]
fn an_uncalibrated_surface_is_reported_rather_than_silently_rendered() {
    let mut stage = arena_stage();
    stage.surfaces[0].calibration_pending = true;

    let validation = stage.validate(&limits());
    // A warning, not an error: the stage still renders, just uncalibrated.
    assert!(validation.valid);
    assert!(validation
        .issues
        .iter()
        .any(|issue| issue.code == "CALIBRATION_NOT_IMPLEMENTED"));
    assert_eq!(stage.uncalibrated_surfaces().len(), 1);
}

#[test]
fn a_legacy_scene_gets_an_implicit_single_surface_stage() {
    let stage = StageDocument::implicit("stage_implicit_scene_1", 1920.0, 1080.0);

    assert_eq!(stage.canvas.logical_width, 1920.0);
    assert_eq!(stage.viewports.len(), 1);
    // A canvas-sized stage fits one texture, so the legacy single-target path is
    // preserved rather than being forced through the tiler.
    assert!(!stage.tiling.enabled);
    assert!(stage.validate(&limits()).valid);
}

// ---------------------------------------------------------------------------
// Frame rates
// ---------------------------------------------------------------------------

#[test]
fn broadcast_frame_rates_are_exact_in_integer_nanoseconds() {
    let sixty_drop = FrameRate {
        numerator: 60_000,
        denominator: 1_001,
    };

    // 60000 frames at 60000/1001 fps is exactly 1001 seconds.
    assert_eq!(sixty_drop.deadline_nanos(60_000), 1_001 * 1_000_000_000);

    // The interval is not a whole number of nanoseconds, which is why accumulating
    // it drifts and computing from the frame number does not.
    let interval = sixty_drop.frame_duration_nanos();
    assert_eq!(interval, 16_683_333);

    let frames = 10_000_000u64; // about 46 hours
    let computed = sixty_drop.deadline_nanos(frames);
    let accumulated = interval * frames;
    assert!(
        computed.abs_diff(accumulated) > 3_000_000,
        "expected accumulation drift over {frames} frames"
    );

    // 29.97 is 30000/1001, never the decimal.
    let thirty_drop = FrameRate {
        numerator: 30_000,
        denominator: 1_001,
    };
    assert!((thirty_drop.approximate() - 29.97).abs() > 1e-9);
    assert!((thirty_drop.approximate() - 29.970_029_970_029_97).abs() < 1e-12);
}
