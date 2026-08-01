//! Tile rendering.
//!
//! This is where the virtual canvas meets the GPU, and it reuses the render
//! core's proven pipeline rather than reimplementing it.
//!
//! The mechanism: to render a tile, the scene document is **rebased into
//! tile-local coordinates in `f64`** and its canvas is set to the tile's padded
//! render bounds. The core's `prepare_scene` then sees an ordinary scene that
//! happens to be tile-sized, and `render_single_frame` draws it with the same
//! quad pipeline, mesh pipeline, and text compositor that Program output uses.
//!
//! Rebasing at the *document* level rather than at the uniform level is
//! deliberate. `PreparedScene` stores positions as `f32`, so a 49,999-unit
//! coordinate would already have lost precision by the time it reached a
//! transform. Subtracting the tile origin while the numbers are still `f64` JSON
//! is the only place the precision rule can actually be enforced.
//!
//! The cost is a `prepare_scene` per tile rather than per scene. That is
//! acceptable because tiles only re-prepare when dirty, and it is cached by
//! `(tile, revision)` — a static scene prepares each tile once and then renders
//! nothing at all. A per-pass uniform offset would avoid the re-prepare entirely
//! and is the obvious optimisation, but it requires the core's shaders to accept
//! an `f64`-derived origin, which is a shader-contract change.

use std::collections::HashMap;

use anyhow::Context;
use serde_json::{json, Map, Value};

use grapix_render_core::output::VideoFrame;
use grapix_render_core::renderer::gpu::GpuContext;
use grapix_render_core::renderer::render_single_frame;
use grapix_render_core::scene::{prepare_scene, PreparedScene};

use crate::stage::{Point, Rect};
use crate::tile::{TileDescriptor, TileId};

/// A scene rebased for one tile, ready to render.
pub struct TileScene {
    pub tile_id: TileId,
    /// Revision this was prepared from, so a stale entry is never reused.
    pub revision: String,
    /// Padded logical rectangle the target covers.
    pub render_bounds: Rect,
    pub target_width: u32,
    pub target_height: u32,
    pub prepared: PreparedScene,
}

/// Builds and caches per-tile scenes.
///
/// Keyed by `(tile id, revision)`: changing the scene invalidates every entry,
/// which is correct because a revision change may have moved anything.
pub struct TileSceneBuilder {
    scene_json: Value,
    revision: String,
    cache: HashMap<TileId, TileScene>,
}

impl TileSceneBuilder {
    pub fn new(scene_json: Value, revision: impl Into<String>) -> Self {
        Self {
            scene_json,
            revision: revision.into(),
            cache: HashMap::new(),
        }
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    /// The scene document as loaded, before any tile rebasing.
    pub fn source_document(&self) -> &Value {
        &self.scene_json
    }

    /// Replace the scene, dropping every cached tile.
    pub fn update_scene(&mut self, scene_json: Value, revision: impl Into<String>) {
        self.scene_json = scene_json;
        self.revision = revision.into();
        self.cache.clear();
    }

    pub fn invalidate(&mut self, tile_id: &str) {
        self.cache.remove(tile_id);
    }

    pub fn clear(&mut self) {
        self.cache.clear();
    }

    pub fn cached_tile_count(&self) -> usize {
        self.cache.len()
    }

    /// Prepare (or reuse) the tile-local scene for a tile.
    pub fn prepared_for_tile(
        &mut self,
        tile: &TileDescriptor,
        render_scale: f64,
    ) -> anyhow::Result<&TileScene> {
        let needs_build = match self.cache.get(&tile.tile_id) {
            Some(existing) => {
                existing.revision != self.revision || existing.render_bounds != tile.render_bounds
            }
            None => true,
        };

        if needs_build {
            let built = self.build(tile, render_scale)?;
            self.cache.insert(tile.tile_id.clone(), built);
        }

        self.cache
            .get(&tile.tile_id)
            .context("tile scene missing immediately after insertion")
    }

    fn build(&self, tile: &TileDescriptor, render_scale: f64) -> anyhow::Result<TileScene> {
        let origin = Point::new(tile.render_bounds.x, tile.render_bounds.y);

        let rebased = rebase_scene_json(
            &self.scene_json,
            origin,
            tile.render_bounds.width,
            tile.render_bounds.height,
        );

        let prepared = prepare_scene(&rebased).map_err(|error| {
            anyhow::anyhow!("tile {} scene preparation failed: {error}", tile.tile_id)
        })?;

        let target_width = ((tile.render_bounds.width * render_scale).ceil() as u32).max(1);
        let target_height = ((tile.render_bounds.height * render_scale).ceil() as u32).max(1);

        Ok(TileScene {
            tile_id: tile.tile_id.clone(),
            revision: self.revision.clone(),
            render_bounds: tile.render_bounds,
            target_width,
            target_height,
            prepared,
        })
    }
}

/// Rebase a scene document onto a local origin, in `f64`.
///
/// Every object's position has the origin subtracted while the values are still
/// doubles, and the canvas becomes the tile's padded size. Objects entirely
/// outside the tile are dropped, which is the per-tile culling the core pipeline
/// would otherwise not do.
///
/// Objects are *not* clipped to the tile. Each tile draws every object it
/// overlaps in full, clipped only by the render target itself. Because every tile
/// applies the same world transform and differs only by the subtracted origin, an
/// object crossing a boundary lands on exactly the same world position in both
/// tiles — which is what makes the composite seam-free.
pub fn rebase_scene_json(scene_json: &Value, origin: Point, width: f64, height: f64) -> Value {
    let mut document = scene_json.clone();

    let Some(map) = document.as_object_mut() else {
        return document;
    };

    // The canvas becomes the tile. `render_single_frame` maps this to the target.
    let background = map
        .get("canvas")
        .and_then(|canvas| canvas.get("background"))
        .cloned()
        .unwrap_or_else(|| json!("#00000000"));
    let background_style = map
        .get("canvas")
        .and_then(|canvas| canvas.get("backgroundStyle"))
        .cloned();

    let mut canvas = Map::new();
    canvas.insert("width".to_string(), json!(width.max(1.0)));
    canvas.insert("height".to_string(), json!(height.max(1.0)));
    canvas.insert("background".to_string(), background);
    if let Some(style) = background_style {
        canvas.insert("backgroundStyle".to_string(), style);
    }
    map.insert("canvas".to_string(), Value::Object(canvas));

    // Editor chrome never reaches a render target.
    if let Some(canvas) = map.get_mut("canvas").and_then(Value::as_object_mut) {
        canvas.remove("editorViewport");
    }

    let tile_rect = Rect::new(origin.x, origin.y, width, height);

    if let Some(objects) = map.get_mut("objects").and_then(Value::as_array_mut) {
        let mut kept = Vec::with_capacity(objects.len());

        for object in objects.iter() {
            let Some(entry) = object.as_object() else {
                continue;
            };

            // Containers carry no pixels but do carry transforms for their
            // children, so they are always kept and rebased.
            let is_container = entry
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "layer" || kind == "group");

            if !is_container && !object_intersects(entry, &tile_rect) {
                continue;
            }

            let mut rebased = entry.clone();
            offset_number(&mut rebased, "x", -origin.x);
            offset_number(&mut rebased, "y", -origin.y);

            // Masks and paths hold their own coordinates in scene space.
            offset_nested_points(&mut rebased, -origin.x, -origin.y);

            kept.push(Value::Object(rebased));
        }

        *objects = kept;
    }

    document
}

/// Does an object's bounds overlap the tile?
///
/// Conservative: an object whose extent cannot be determined is kept. Dropping
/// something that should have been drawn is far worse than drawing something
/// that turns out to be off-tile.
fn object_intersects(entry: &Map<String, Value>, tile: &Rect) -> bool {
    let x = entry.get("x").and_then(Value::as_f64);
    let y = entry.get("y").and_then(Value::as_f64);
    let (Some(x), Some(y)) = (x, y) else {
        return true;
    };

    let width = entry.get("width").and_then(Value::as_f64);
    let height = entry.get("height").and_then(Value::as_f64);

    match (width, height) {
        (Some(width), Some(height)) if width > 0.0 && height > 0.0 => {
            // Anchors and rotation can push the drawn area outside the nominal
            // rectangle, so pad generously rather than clipping something real.
            let padding = width.max(height);
            Rect::new(
                x - padding,
                y - padding,
                width + padding * 2.0,
                height + padding * 2.0,
            )
            .intersects(tile)
        }
        // Text, meshes, paths, and lines have no simple extent here. Keep them:
        // the render target clips them correctly anyway.
        _ => true,
    }
}

fn offset_number(entry: &mut Map<String, Value>, key: &str, delta: f64) {
    if let Some(value) = entry.get(key).and_then(Value::as_f64) {
        // The subtraction happens here, in f64, before anything narrows to f32.
        entry.insert(key.to_string(), json!(value + delta));
    }
}

/// Offset coordinate pairs nested inside masks, paths, and strokes.
fn offset_nested_points(entry: &mut Map<String, Value>, delta_x: f64, delta_y: f64) {
    for key in [
        "mask", "masks", "path", "paths", "strokes", "points", "vertices",
    ] {
        if let Some(value) = entry.get_mut(key) {
            offset_points_in_value(value, delta_x, delta_y);
        }
    }
}

fn offset_points_in_value(value: &mut Value, delta_x: f64, delta_y: f64) {
    match value {
        Value::Array(items) => {
            for item in items {
                offset_points_in_value(item, delta_x, delta_y);
            }
        }
        Value::Object(map) => {
            // A node with both x and y is a point.
            let has_x = map.get("x").and_then(Value::as_f64).is_some();
            let has_y = map.get("y").and_then(Value::as_f64).is_some();
            if has_x && has_y {
                offset_number(map, "x", delta_x);
                offset_number(map, "y", delta_y);
            }

            for (_, child) in map.iter_mut() {
                offset_points_in_value(child, delta_x, delta_y);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

pub struct RenderedTile {
    pub tile_id: TileId,
    pub frame: VideoFrame,
    /// Logical rectangle the padded target covers.
    pub render_bounds: Rect,
    /// Logical rectangle that may be composited. Never includes overscan.
    pub composite_bounds: Rect,
    /// Overscan offset in target pixels: where `composite_bounds` starts.
    pub composite_offset_x: u32,
    pub composite_offset_y: u32,
    pub render_micros: u64,
}

/// Render one tile.
///
/// Draws the padded target so filters can write into the overscan ring, and
/// reports where the inner rectangle sits so the compositor reads only that.
pub fn render_tile(
    gpu: &GpuContext,
    builder: &mut TileSceneBuilder,
    tile: &TileDescriptor,
    render_scale: f64,
) -> anyhow::Result<RenderedTile> {
    let started = std::time::Instant::now();

    let (target_width, target_height, render_bounds) = {
        let tile_scene = builder.prepared_for_tile(tile, render_scale)?;
        (
            tile_scene.target_width,
            tile_scene.target_height,
            tile_scene.render_bounds,
        )
    };

    let frame = {
        let tile_scene = builder
            .prepared_for_tile(tile, render_scale)
            .context("tile scene disappeared between preparation and render")?;
        render_single_frame(gpu, &tile_scene.prepared, target_width, target_height)?
    };

    let offset = (tile.required_overscan * render_scale).round().max(0.0) as u32;

    Ok(RenderedTile {
        tile_id: tile.tile_id.clone(),
        frame,
        render_bounds,
        composite_bounds: tile.logical_bounds,
        composite_offset_x: offset,
        composite_offset_y: offset,
        render_micros: started.elapsed().as_micros() as u64,
    })
}

// ---------------------------------------------------------------------------
// CPU compositing
// ---------------------------------------------------------------------------

/// A CPU-side composite target.
///
/// Assembling on the CPU is what lets a 50,000-wide recording exist at all: the
/// full stage never becomes one GPU texture, and a 10 GB image can be streamed to
/// disk row by row instead of allocated.
pub struct CompositeTarget {
    pub width: u32,
    pub height: u32,
    /// BGRA8, premultiplied, tightly packed.
    pub pixels: Vec<u8>,
    /// Logical rectangle this target represents.
    pub logical_bounds: Rect,
    pub render_scale: f64,
}

// Fields are public so a single-pass preview can wrap an already-rendered frame
// without copying it through `new` and `blit`.

impl CompositeTarget {
    pub fn new(logical_bounds: Rect, render_scale: f64) -> anyhow::Result<Self> {
        let width = ((logical_bounds.width * render_scale).ceil() as u32).max(1);
        let height = ((logical_bounds.height * render_scale).ceil() as u32).max(1);

        let bytes = u64::from(width) * u64::from(height) * 4;
        // Refuse rather than attempt a doomed allocation. A caller that wants the
        // whole of a huge stage must stream it, not ask for it in one buffer.
        const MAX_COMPOSITE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
        if bytes > MAX_COMPOSITE_BYTES {
            anyhow::bail!(
                "composite target would need {bytes} bytes ({width}x{height}); the limit is {MAX_COMPOSITE_BYTES}. Reduce render scale or composite in regions."
            );
        }

        Ok(Self {
            width,
            height,
            pixels: vec![0u8; bytes as usize],
            logical_bounds,
            render_scale,
        })
    }

    /// Copy a tile's inner rectangle into the target.
    ///
    /// Only `composite_bounds` is read; the overscan ring is skipped entirely.
    /// That is the difference between a seamless composite and a visible grid.
    pub fn blit(&mut self, tile: &RenderedTile) -> bool {
        let overlap = tile.composite_bounds.intersect(&self.logical_bounds);
        if overlap.is_empty() {
            return false;
        }

        // Source position inside the tile's padded target.
        let source_x = (((overlap.x - tile.composite_bounds.x) * self.render_scale).round() as i64)
            + i64::from(tile.composite_offset_x);
        let source_y = (((overlap.y - tile.composite_bounds.y) * self.render_scale).round() as i64)
            + i64::from(tile.composite_offset_y);

        let dest_x = ((overlap.x - self.logical_bounds.x) * self.render_scale).round() as i64;
        let dest_y = ((overlap.y - self.logical_bounds.y) * self.render_scale).round() as i64;

        let copy_width = (overlap.width * self.render_scale).round() as i64;
        let copy_height = (overlap.height * self.render_scale).round() as i64;

        if copy_width <= 0 || copy_height <= 0 {
            return false;
        }

        let tile_width = i64::from(tile.frame.width);
        let tile_height = i64::from(tile.frame.height);
        let target_width = i64::from(self.width);
        let target_height = i64::from(self.height);

        for row in 0..copy_height {
            let source_row = source_y + row;
            let dest_row = dest_y + row;
            if source_row < 0 || source_row >= tile_height {
                continue;
            }
            if dest_row < 0 || dest_row >= target_height {
                continue;
            }

            // Clamp the run to both buffers rather than trusting the arithmetic.
            let available_source = tile_width - source_x.max(0);
            let available_dest = target_width - dest_x.max(0);
            let run = copy_width.min(available_source).min(available_dest);
            if run <= 0 {
                continue;
            }

            let source_start = ((source_row * tile_width + source_x.max(0)) * 4) as usize;
            let dest_start = ((dest_row * target_width + dest_x.max(0)) * 4) as usize;
            let byte_run = (run * 4) as usize;

            if source_start + byte_run > tile.frame.data.len() {
                continue;
            }
            if dest_start + byte_run > self.pixels.len() {
                continue;
            }

            self.pixels[dest_start..dest_start + byte_run]
                .copy_from_slice(&tile.frame.data[source_start..source_start + byte_run]);
        }

        true
    }
}
