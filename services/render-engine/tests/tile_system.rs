//! Tiling: the grid, culling, dirty tracking, overscan, eviction, and seams.
//!
//! The same specification as `Shared/tile-system`'s tests. Both must agree,
//! because the browser preview and the engine have to decompose a stage the same
//! way or their pictures cannot be compared.

use grapix_render_engine::stage::{Rect, TilingConfig, VirtualCanvas};
use grapix_render_engine::tile::{
    filter_stack_extent, object_rect_in_tile, parse_tile_id, plan_tile_composite, tile_local_origin,
    tile_source_rect, verify_seamless_coverage, FilterOverscan, TileCoord, TileGrid, TileManager,
    TileSelectionRequest,
};

fn grid(width: f64, height: f64, tile: u32, overscan: u32) -> TileGrid {
    let canvas = VirtualCanvas::new(width, height);
    let tiling = TilingConfig {
        enabled: true,
        tile_width: tile,
        tile_height: tile,
        overscan,
        ..TilingConfig::default()
    };
    TileGrid::new(&canvas, &tiling)
}

fn manager(width: f64, height: f64, tile: u32, overscan: u32) -> TileManager {
    let canvas = VirtualCanvas::new(width, height);
    let tiling = TilingConfig {
        enabled: true,
        tile_width: tile,
        tile_height: tile,
        overscan,
        cache_budget_bytes: 64 * 1024 * 1024 * 1024,
        max_resident_tiles: 100_000,
    };
    TileManager::new(TileGrid::new(&canvas, &tiling), &tiling, 1.0)
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

#[test]
fn a_50000_square_stage_tiles_into_a_tractable_grid() {
    let coarse = grid(50_000.0, 50_000.0, 2048, 32);
    assert_eq!(coarse.columns, 25); // ceil(50000 / 2048)
    assert_eq!(coarse.rows, 25);
    assert_eq!(coarse.tile_count(), 625);

    // At 512 the same stage is 98x98. Large, but index-driven.
    let fine = grid(50_000.0, 50_000.0, 512, 0);
    assert_eq!(fine.columns, 98);
    assert_eq!(fine.tile_count(), 9_604);
}

#[test]
fn tile_ids_round_trip_and_reject_malformed_input() {
    assert_eq!(TileCoord::new(24, 12).id(), "t:24:12");
    assert_eq!(parse_tile_id("t:24:12"), Some(TileCoord::new(24, 12)));
    assert_eq!(parse_tile_id("24:12"), None);
    assert_eq!(parse_tile_id("t:-1:0"), None);
    assert_eq!(parse_tile_id("t:a:b"), None);
    assert_eq!(parse_tile_id("t:1:2:3"), None);
}

#[test]
fn edge_tiles_are_clipped_to_the_stage() {
    let g = grid(50_000.0, 50_000.0, 2048, 0);

    assert_eq!(
        g.tile_bounds(TileCoord::new(0, 0)),
        Rect::new(0.0, 0.0, 2048.0, 2048.0)
    );

    // The last column starts at 24*2048 = 49152 and only 848 units remain.
    assert_eq!(
        g.tile_bounds(TileCoord::new(24, 0)),
        Rect::new(49_152.0, 0.0, 848.0, 2048.0)
    );

    // The unclipped view still reports the full tile, for grid overlays.
    assert_eq!(
        g.tile_full_bounds(TileCoord::new(24, 0)),
        Rect::new(49_152.0, 0.0, 2048.0, 2048.0)
    );
}

#[test]
fn the_grid_is_a_partition() {
    let g = grid(8192.0, 8192.0, 2048, 0);

    // Exactly one tile wide, ending on the boundary.
    assert_eq!(g.column_range(&Rect::new(0.0, 0.0, 2048.0, 10.0)), Some((0, 0)));
    // One unit past the boundary reaches the second column.
    assert_eq!(g.column_range(&Rect::new(0.0, 0.0, 2049.0, 10.0)), Some((0, 1)));
    // Starting exactly on a boundary belongs to the new tile.
    assert_eq!(g.column_range(&Rect::new(2048.0, 0.0, 10.0, 10.0)), Some((1, 1)));
    // A zero-area rect touches nothing.
    assert_eq!(g.column_range(&Rect::new(100.0, 0.0, 0.0, 10.0)), None);
}

#[test]
fn rectangles_off_the_grid_select_no_tiles() {
    let g = grid(4096.0, 4096.0, 2048, 0);
    assert!(g.tiles_for_rect(&Rect::new(-1000.0, -1000.0, 500.0, 500.0)).is_empty());
    assert!(g.tiles_for_rect(&Rect::new(10_000.0, 10_000.0, 100.0, 100.0)).is_empty());

    // Partly off the grid clamps to valid tiles.
    assert_eq!(
        g.tile_ids_for_rect(&Rect::new(-500.0, -500.0, 1000.0, 1000.0)),
        vec!["t:0:0".to_string()]
    );
}

#[test]
fn an_object_crossing_a_boundary_selects_every_tile_it_overlaps() {
    let g = grid(8192.0, 8192.0, 2048, 0);
    let straddling = Rect::new(2000.0, 2000.0, 100.0, 100.0);

    let mut ids = g.tile_ids_for_rect(&straddling);
    ids.sort();
    assert_eq!(ids, vec!["t:0:0", "t:0:1", "t:1:0", "t:1:1"]);
    assert_eq!(g.count_tiles_for_rect(&straddling), 4);
}

#[test]
fn overscan_expands_the_render_bounds_and_is_not_clipped_to_the_stage() {
    let g = grid(4096.0, 4096.0, 2048, 32);

    // Overscan reaches outside the stage on purpose: a blur at the stage edge still
    // needs to know there is nothing out there.
    assert_eq!(
        g.tile_render_bounds(TileCoord::new(0, 0), 32.0),
        Rect::new(-32.0, -32.0, 2112.0, 2112.0)
    );
    assert_eq!(g.tile_render_size(TileCoord::new(0, 0), 1.0, 32.0), (2112, 2112));

    // Explicit zero overscan gives the bare tile.
    assert_eq!(
        g.tile_render_bounds(TileCoord::new(0, 0), 0.0),
        Rect::new(0.0, 0.0, 2048.0, 2048.0)
    );
}

#[test]
fn overscan_costs_memory_and_the_estimate_says_so() {
    let bare = grid(4096.0, 4096.0, 1024, 0);
    assert_eq!(
        bare.tile_byte_estimate(TileCoord::new(0, 0), 1.0, 0.0),
        1024 * 1024 * 4
    );

    let padded = grid(4096.0, 4096.0, 1024, 32);
    // 1088^2 instead of 1024^2 — about 13% more memory per tile.
    assert_eq!(
        padded.tile_byte_estimate(TileCoord::new(0, 0), 1.0, 32.0),
        1088 * 1088 * 4
    );
}

#[test]
fn disabling_tiling_collapses_the_grid_to_one_tile() {
    let canvas = VirtualCanvas::new(1920.0, 1080.0);
    let tiling = TilingConfig {
        enabled: false,
        tile_width: 512,
        tile_height: 512,
        overscan: 64,
        ..TilingConfig::default()
    };
    let g = TileGrid::new(&canvas, &tiling);

    assert_eq!(g.columns, 1);
    assert_eq!(g.rows, 1);
    assert_eq!(g.overscan, 0.0);
    assert_eq!(
        g.tile_bounds(TileCoord::new(0, 0)),
        Rect::new(0.0, 0.0, 1920.0, 1080.0)
    );
}

#[test]
fn filter_extents_follow_the_documented_formulas() {
    // Three sigma captures 99.7% of a Gaussian.
    assert_eq!(FilterOverscan::GaussianBlur { sigma: 10.0 }.extent(), 30.0);
    assert_eq!(FilterOverscan::BoxBlur { radius: 7.2 }.extent(), 8.0);
    assert_eq!(
        FilterOverscan::DropShadow {
            sigma: 4.0,
            offset_x: 10.0,
            offset_y: -20.0
        }
        .extent(),
        12.0 + 20.0
    );
    assert_eq!(
        FilterOverscan::Glow {
            sigma: 5.0,
            spread: 3.0
        }
        .extent(),
        18.0
    );
    assert_eq!(FilterOverscan::Custom { extent: 64.0 }.extent(), 64.0);

    // Negative values never produce negative padding.
    assert_eq!(FilterOverscan::GaussianBlur { sigma: -5.0 }.extent(), 0.0);

    // Stacks sum, because a blur then a shadow reaches further than either alone.
    assert_eq!(
        filter_stack_extent(&[
            FilterOverscan::GaussianBlur { sigma: 10.0 },
            FilterOverscan::DropShadow {
                sigma: 4.0,
                offset_x: 0.0,
                offset_y: 8.0
            }
        ]),
        30.0 + 20.0
    );
}

// ---------------------------------------------------------------------------
// Selection and culling
// ---------------------------------------------------------------------------

#[test]
fn only_tiles_an_active_consumer_asks_for_are_selected() {
    let mut m = manager(50_000.0, 50_000.0, 2048, 0);
    assert_eq!(m.grid.tile_count(), 625);

    let selection = m.select_tiles(&TileSelectionRequest {
        frame: 0,
        viewports: vec![Rect::new(0.0, 0.0, 3840.0, 2160.0)],
        ..Default::default()
    });

    // A UHD viewport touches 2x2 tiles of a 2048 grid.
    assert_eq!(selection.required.len(), 4);
    assert_eq!(selection.culled_count, 621);
    // Descriptors are lazy: four allocated, not 625.
    assert_eq!(m.stats().tracked_tiles, 4);
}

#[test]
fn render_on_change_means_a_clean_tile_is_required_but_not_redrawn() {
    let mut m = manager(4096.0, 4096.0, 2048, 0);
    let viewport = vec![Rect::new(0.0, 0.0, 100.0, 100.0)];

    let first = m.select_tiles(&TileSelectionRequest {
        frame: 0,
        viewports: viewport.clone(),
        ..Default::default()
    });
    assert_eq!(first.to_render.len(), 1);

    m.begin_render(&["t:0:0".to_string()]);
    m.complete_render("t:0:0", 0);

    // Nothing changed, so nothing needs rendering.
    let second = m.select_tiles(&TileSelectionRequest {
        frame: 1,
        viewports: viewport.clone(),
        ..Default::default()
    });
    assert_eq!(second.required.len(), 1);
    assert_eq!(second.to_render.len(), 0);

    // include_clean forces a redraw, as device-loss recovery needs.
    let forced = m.select_tiles(&TileSelectionRequest {
        frame: 2,
        viewports: viewport,
        include_clean: true,
        ..Default::default()
    });
    assert_eq!(forced.to_render.len(), 1);
}

#[test]
fn moving_an_object_dirties_only_the_tiles_it_left_and_entered() {
    let mut m = manager(8192.0, 8192.0, 2048, 0);
    let wide = vec![Rect::new(0.0, 0.0, 8192.0, 8192.0)];

    m.sync_object("a", Rect::new(100.0, 100.0, 50.0, 50.0), &[]);
    m.select_tiles(&TileSelectionRequest {
        frame: 0,
        viewports: wide.clone(),
        include_clean: true,
        ..Default::default()
    });
    let ids: Vec<String> = m.tracked_tiles().iter().map(|t| t.tile_id.clone()).collect();
    for id in &ids {
        m.begin_render(&[id.clone()]);
        m.complete_render(id, 0);
    }
    assert_eq!(m.dirty_tiles().len(), 0);

    // Move it two tiles across.
    m.sync_object("a", Rect::new(5000.0, 100.0, 50.0, 50.0), &[]);

    let mut dirty: Vec<String> = m.dirty_tiles().iter().map(|t| t.tile_id.clone()).collect();
    dirty.sort();
    assert_eq!(dirty, vec!["t:0:0", "t:2:0"]);
}

#[test]
fn a_dirty_tile_nobody_is_looking_at_is_not_rendered() {
    let mut m = manager(50_000.0, 10_000.0, 2048, 0);

    // Something changes at the far end of the stage.
    m.sync_object("far", Rect::new(49_000.0, 500.0, 100.0, 100.0), &[]);

    // The operator is looking at the left end.
    let selection = m.select_tiles(&TileSelectionRequest {
        frame: 0,
        viewports: vec![Rect::new(0.0, 0.0, 1920.0, 1080.0)],
        ..Default::default()
    });
    assert!(!selection.to_render.iter().any(|id| id.starts_with("t:24")));

    // It renders as soon as a viewport reaches it.
    let later = m.select_tiles(&TileSelectionRequest {
        frame: 1,
        viewports: vec![Rect::new(48_500.0, 0.0, 1920.0, 1080.0)],
        ..Default::default()
    });
    assert!(!later.to_render.is_empty());
}

#[test]
fn a_failed_tile_stays_dirty_so_the_next_frame_retries() {
    let mut m = manager(4096.0, 4096.0, 2048, 0);
    m.select_tiles(&TileSelectionRequest {
        frame: 0,
        viewports: vec![Rect::new(0.0, 0.0, 100.0, 100.0)],
        ..Default::default()
    });

    m.begin_render(&["t:0:0".to_string()]);
    m.fail_render("t:0:0", "shader compilation failed");

    let tile = m.get("t:0:0").expect("tile");
    assert!(tile.dirty);
    assert_eq!(tile.failure_reason.as_deref(), Some("shader compilation failed"));

    let retry = m.select_tiles(&TileSelectionRequest {
        frame: 1,
        viewports: vec![Rect::new(0.0, 0.0, 100.0, 100.0)],
        ..Default::default()
    });
    assert_eq!(retry.to_render.len(), 1);
}

#[test]
fn adding_a_filter_grows_the_tile_target_and_invalidates_it() {
    let mut m = manager(4096.0, 4096.0, 2048, 0);

    m.sync_object("a", Rect::new(100.0, 100.0, 200.0, 200.0), &[]);
    m.select_tiles(&TileSelectionRequest {
        frame: 0,
        viewports: vec![Rect::new(0.0, 0.0, 100.0, 100.0)],
        ..Default::default()
    });
    m.begin_render(&["t:0:0".to_string()]);
    m.complete_render("t:0:0", 0);

    let bytes_before = m.get("t:0:0").expect("tile").estimated_bytes;
    assert_eq!(m.get("t:0:0").expect("tile").required_overscan, 0.0);

    // Now the object gains a blur.
    m.sync_object(
        "a",
        Rect::new(100.0, 100.0, 200.0, 200.0),
        &[FilterOverscan::GaussianBlur { sigma: 16.0 }],
    );
    m.select_tiles(&TileSelectionRequest {
        frame: 1,
        viewports: vec![Rect::new(0.0, 0.0, 100.0, 100.0)],
        ..Default::default()
    });

    let after = m.get("t:0:0").expect("tile");
    assert_eq!(after.required_overscan, 48.0);
    assert_eq!(after.render_bounds, Rect::new(-48.0, -48.0, 2144.0, 2144.0));
    assert!(after.estimated_bytes > bytes_before);
    // The render target changed size, so the old contents are unusable.
    assert!(after.dirty);
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

#[test]
fn eviction_drops_least_recently_used_tiles_under_a_byte_budget() {
    let canvas = VirtualCanvas::new(8192.0, 8192.0);
    let tiling = TilingConfig {
        enabled: true,
        tile_width: 2048,
        tile_height: 2048,
        overscan: 0,
        // Three tiles' worth; 2048^2 * 4 is 16 MiB each.
        cache_budget_bytes: 2048 * 2048 * 4 * 3,
        max_resident_tiles: 100,
    };
    let mut m = TileManager::new(TileGrid::new(&canvas, &tiling), &tiling, 1.0);

    for column in 0..4u32 {
        let id = format!("t:{column}:0");
        m.select_tiles(&TileSelectionRequest {
            frame: u64::from(column),
            viewports: vec![Rect::new(f64::from(column) * 2048.0, 0.0, 10.0, 10.0)],
            ..Default::default()
        });
        m.begin_render(&[id.clone()]);
        m.complete_render(&id, u64::from(column));
    }

    assert_eq!(m.stats().resident_tiles, 4);
    assert!(m.stats().over_budget);

    // The oldest goes first.
    assert_eq!(m.evict(), vec!["t:0:0".to_string()]);
    assert!(!m.stats().over_budget);

    let gone = m.get("t:0:0").expect("tile");
    // Evicted means it must be re-rendered, never silently reused.
    assert!(gone.dirty);
}

#[test]
fn tiles_an_output_references_are_never_evicted() {
    let canvas = VirtualCanvas::new(8192.0, 8192.0);
    let tiling = TilingConfig {
        enabled: true,
        tile_width: 2048,
        tile_height: 2048,
        overscan: 0,
        // An impossible budget, so eviction wants everything.
        cache_budget_bytes: 1,
        max_resident_tiles: 1,
    };
    let mut m = TileManager::new(TileGrid::new(&canvas, &tiling), &tiling, 1.0);

    for column in 0..2u32 {
        let id = format!("t:{column}:0");
        m.select_tiles(&TileSelectionRequest {
            frame: u64::from(column),
            viewports: vec![Rect::new(f64::from(column) * 2048.0, 0.0, 10.0, 10.0)],
            ..Default::default()
        });
        m.begin_render(&[id.clone()]);
        m.complete_render(&id, u64::from(column));
    }

    m.add_output_ref("t:0:0", "output_program");

    // Going over budget is recoverable; dropping a live output tile is not.
    assert_eq!(m.evict(), vec!["t:1:0".to_string()]);
    assert_eq!(m.stats().pinned_tiles, 1);

    m.remove_output_ref("t:0:0", "output_program");
    assert_eq!(m.evict(), vec!["t:0:0".to_string()]);
}

// ---------------------------------------------------------------------------
// Compositing and seams
// ---------------------------------------------------------------------------

/// Render every tile a target needs so a composite plan is complete.
fn render_tiles_for(m: &mut TileManager, target: Rect) -> Vec<String> {
    let selection = m.select_tiles(&TileSelectionRequest {
        frame: 0,
        outputs: vec![target],
        include_clean: true,
        ..Default::default()
    });
    for id in &selection.to_render {
        m.begin_render(std::slice::from_ref(id));
        m.complete_render(id, 0);
    }
    selection.required
}

#[test]
fn a_composite_plan_tiles_its_target_exactly() {
    let mut m = manager(8192.0, 8192.0, 2048, 32);
    let target = Rect::new(0.0, 0.0, 8192.0, 8192.0);

    let ids = render_tiles_for(&mut m, target);
    assert_eq!(ids.len(), 16);

    let tiles: Vec<_> = ids.iter().filter_map(|id| m.get(id)).collect();
    let plan = plan_tile_composite(target, &tiles, 1.0, true);
    let report = verify_seamless_coverage(&plan);

    assert!(report.seamless, "{:?}", report);
    assert!(report.overlaps.is_empty());
    assert_eq!(report.covered_area, report.target_area);
}

#[test]
fn a_50000_square_stage_composites_seamlessly_from_625_tiles() {
    let mut m = manager(50_000.0, 50_000.0, 2048, 32);
    let target = m.grid.logical_bounds;

    let ids = render_tiles_for(&mut m, target);
    assert_eq!(ids.len(), 625);

    let tiles: Vec<_> = ids.iter().filter_map(|id| m.get(id)).collect();
    let plan = plan_tile_composite(target, &tiles, 1.0, true);
    let report = verify_seamless_coverage(&plan);

    assert!(report.seamless, "{:?}", report.overlaps);
    // The ragged right and bottom edges still sum to exactly the stage area.
    assert_eq!(report.covered_area, 50_000.0 * 50_000.0);
}

#[test]
fn a_partial_target_composites_seamlessly_from_the_tiles_it_crosses() {
    let mut m = manager(8192.0, 8192.0, 2048, 32);
    // Straddles four tiles and is not boundary aligned.
    let target = Rect::new(1900.0, 1900.0, 300.0, 300.0);

    let ids = render_tiles_for(&mut m, target);
    assert_eq!(ids.len(), 4);

    let tiles: Vec<_> = ids.iter().filter_map(|id| m.get(id)).collect();
    let plan = plan_tile_composite(target, &tiles, 1.0, true);

    assert_eq!(plan.ops.len(), 4);
    assert!(verify_seamless_coverage(&plan).seamless);

    let total: f64 = plan.ops.iter().map(|op| op.logical_rect.area()).sum();
    assert_eq!(total, 300.0 * 300.0);
}

#[test]
fn a_missing_tile_is_reported_rather_than_silently_omitted() {
    let mut m = manager(4096.0, 4096.0, 2048, 0);
    let target = Rect::new(0.0, 0.0, 4096.0, 4096.0);

    let selection = m.select_tiles(&TileSelectionRequest {
        frame: 0,
        outputs: vec![target],
        ..Default::default()
    });
    // Render three of the four.
    for id in selection.required.iter().take(3) {
        m.begin_render(std::slice::from_ref(id));
        m.complete_render(id, 0);
    }

    let tiles: Vec<_> = selection.required.iter().filter_map(|id| m.get(id)).collect();
    let plan = plan_tile_composite(target, &tiles, 1.0, true);

    assert_eq!(plan.ops.len(), 3);
    assert_eq!(plan.missing_tile_ids.len(), 1);
    assert!(!verify_seamless_coverage(&plan).seamless);
}

#[test]
fn the_composite_reads_past_the_overscan_ring_never_into_it() {
    let mut m = manager(4096.0, 4096.0, 2048, 0);
    m.sync_object(
        "blurred",
        Rect::new(100.0, 100.0, 200.0, 200.0),
        &[FilterOverscan::GaussianBlur { sigma: 16.0 }],
    );

    let target = Rect::new(0.0, 0.0, 2048.0, 2048.0);
    let ids = render_tiles_for(&mut m, target);
    let tile = ids
        .iter()
        .filter_map(|id| m.get(id))
        .find(|tile| tile.tile_id == "t:0:0")
        .expect("tile 0,0");

    assert_eq!(tile.required_overscan, 48.0);
    // The render target is padded...
    assert_eq!(tile.render_bounds, Rect::new(-48.0, -48.0, 2144.0, 2144.0));
    // ...but only the inner rectangle may reach an output.
    assert_eq!(tile.logical_bounds, Rect::new(0.0, 0.0, 2048.0, 2048.0));
    // The read starts exactly at the overscan offset.
    assert_eq!(tile_source_rect(tile, 1.0), Rect::new(48.0, 48.0, 2048.0, 2048.0));
}

#[test]
fn object_geometry_rebases_onto_the_padded_tile_origin() {
    let mut m = manager(50_000.0, 50_000.0, 2048, 32);
    // An object near the far edge of the stage.
    let bounds = Rect::new(49_200.37, 49_200.81, 400.0, 200.0);
    m.sync_object("far", bounds, &[]);

    let target = Rect::new(49_152.0, 49_152.0, 848.0, 848.0);
    let ids = render_tiles_for(&mut m, target);
    let tile = ids
        .iter()
        .filter_map(|id| m.get(id))
        .find(|tile| tile.tile_id == "t:24:24")
        .expect("tile 24,24");

    // The render origin is the padded corner, not the tile corner.
    assert_eq!(
        tile_local_origin(tile),
        grapix_render_engine::stage::Point::new(49_152.0 - 32.0, 49_152.0 - 32.0)
    );

    let local = object_rect_in_tile(&bounds, tile);
    // Magnitude drops from ~49,200 to ~80, which is where float32 is accurate.
    assert!((local.x - 80.37).abs() < 1e-9, "got {}", local.x);
    assert!((local.y - 80.81).abs() < 1e-9, "got {}", local.y);
    assert!(((local.x as f32) as f64 - local.x).abs() < 1e-5);
}

#[test]
fn an_object_crossing_a_boundary_lands_at_the_same_world_position_in_both_tiles() {
    let mut m = manager(8192.0, 8192.0, 2048, 0);
    let bounds = Rect::new(2000.0, 500.0, 200.0, 100.0); // straddles x = 2048

    m.sync_object("straddle", bounds, &[]);
    let ids = render_tiles_for(&mut m, Rect::new(0.0, 0.0, 4096.0, 2048.0));

    let left = ids
        .iter()
        .filter_map(|id| m.get(id))
        .find(|tile| tile.tile_id == "t:0:0")
        .expect("left tile");
    let right = ids
        .iter()
        .filter_map(|id| m.get(id))
        .find(|tile| tile.tile_id == "t:1:0")
        .expect("right tile");

    let in_left = object_rect_in_tile(&bounds, left);
    let in_right = object_rect_in_tile(&bounds, right);

    // Different local coordinates...
    assert_eq!(in_left, Rect::new(2000.0, 500.0, 200.0, 100.0));
    assert_eq!(in_right, Rect::new(-48.0, 500.0, 200.0, 100.0));

    // ...but adding each tile's origin back recovers the identical world rect.
    // That equality is exactly why the two halves line up with no seam.
    assert_eq!(in_left.x + left.render_bounds.x, bounds.x);
    assert_eq!(in_right.x + right.render_bounds.x, bounds.x);
}

#[test]
fn the_index_reports_which_tiles_an_object_entered_and_left() {
    let mut m = manager(8192.0, 8192.0, 2048, 0);

    let first = m.sync_object("a", Rect::new(0.0, 0.0, 100.0, 100.0), &[]);
    assert_eq!(first.entered, vec!["t:0:0".to_string()]);
    assert!(first.left.is_empty());

    let moved = m.sync_object("a", Rect::new(3000.0, 0.0, 100.0, 100.0), &[]);
    assert_eq!(moved.entered, vec!["t:1:0".to_string()]);
    assert_eq!(moved.left, vec!["t:0:0".to_string()]);

    // Moving within one tile changes no membership but still changes pixels.
    let nudged = m.sync_object("a", Rect::new(3010.0, 0.0, 100.0, 100.0), &[]);
    assert!(nudged.entered.is_empty());
    assert!(nudged.left.is_empty());
    assert!(nudged.moved_within_tiles);

    // An identical update changes nothing at all.
    let same = m.sync_object("a", Rect::new(3010.0, 0.0, 100.0, 100.0), &[]);
    assert!(!same.moved_within_tiles);

    let removed = m.remove_object("a");
    assert_eq!(removed.left, vec!["t:1:0".to_string()]);
    assert_eq!(m.index.object_count(), 0);
}

#[test]
fn stats_summarise_the_tile_cache_for_diagnostics() {
    let mut m = manager(8192.0, 8192.0, 2048, 0);
    m.sync_object("straddle", Rect::new(2000.0, 2000.0, 100.0, 100.0), &[]);
    render_tiles_for(&mut m, Rect::new(0.0, 0.0, 4096.0, 4096.0));

    let stats = m.stats();
    assert_eq!(stats.total_tiles, 16);
    assert_eq!(stats.tracked_tiles, 4);
    assert_eq!(stats.resident_tiles, 4);
    assert_eq!(stats.dirty_tiles, 0);
    assert_eq!(stats.object_count, 1);
    assert_eq!(stats.multi_tile_object_count, 1);
    assert_eq!(stats.cache_bytes, 4 * 2048 * 2048 * 4);
}
