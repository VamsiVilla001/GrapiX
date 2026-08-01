//! Tiled rendering.
//!
//! Tiles are the only thing in GrapiX that becomes a GPU render target. That is
//! what lets a 50,000 x 50,000 logical stage exist on a GPU whose maximum texture
//! dimension is 16,384, and why declaring such a stage costs nothing until
//! something actually looks at part of it.
//!
//! Mirrors `@grapix/tile-system`. The TypeScript tests are the shared
//! specification; the tests here assert the Rust implementation agrees.
//!
//! Two invariants the whole thing rests on:
//!
//! 1. **The grid is a partition.** An object whose right edge lands exactly on a
//!    boundary belongs to the left tile only. Touching is not overlapping.
//! 2. **Only the inner rectangle is composited.** A tile renders at `bounds +
//!    overscan` so filters have neighbours to sample, and the composite reads back
//!    only `bounds`. The overscan ring is sampled and discarded, which is what
//!    makes the composite seam-free.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::stage::{Point, Rect, TilingConfig, VirtualCanvas};

/// `t:<column>:<row>`. Derived from the grid, never stored, so a stale tile
/// cannot be mistaken for a current one after the tile size changes.
pub type TileId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TileCoord {
    pub column: u32,
    pub row: u32,
}

impl TileCoord {
    pub fn new(column: u32, row: u32) -> Self {
        Self { column, row }
    }

    pub fn id(&self) -> TileId {
        format!("t:{}:{}", self.column, self.row)
    }
}

pub fn parse_tile_id(value: &str) -> Option<TileCoord> {
    let mut parts = value.split(':');
    if parts.next()? != "t" {
        return None;
    }
    let column = parts.next()?.parse::<u32>().ok()?;
    let row = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(TileCoord::new(column, row))
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileGrid {
    /// Stage top-left. Tile 0,0 starts here whatever the canvas origin anchor.
    pub origin: Point,
    pub tile_width: f64,
    pub tile_height: f64,
    pub columns: u32,
    pub rows: u32,
    pub overscan: f64,
    pub logical_bounds: Rect,
}

impl TileGrid {
    pub fn new(canvas: &VirtualCanvas, tiling: &TilingConfig) -> Self {
        let logical_bounds = canvas.bounds();

        // Tiling disabled means one tile covering the stage, so the legacy
        // single-target path is expressible in the same model rather than needing
        // a separate code path.
        let (tile_width, tile_height, overscan) = if tiling.enabled {
            (
                f64::from(tiling.tile_width),
                f64::from(tiling.tile_height),
                f64::from(tiling.overscan),
            )
        } else {
            (
                logical_bounds.width.ceil().max(1.0),
                logical_bounds.height.ceil().max(1.0),
                0.0,
            )
        };

        Self {
            origin: Point::new(logical_bounds.x, logical_bounds.y),
            tile_width,
            tile_height,
            columns: ((logical_bounds.width / tile_width).ceil() as u32).max(1),
            rows: ((logical_bounds.height / tile_height).ceil() as u32).max(1),
            overscan,
            logical_bounds,
        }
    }

    pub fn tile_count(&self) -> u64 {
        u64::from(self.columns) * u64::from(self.rows)
    }

    pub fn is_valid(&self, coord: TileCoord) -> bool {
        coord.column < self.columns && coord.row < self.rows
    }

    /// A tile's logical rectangle, clipped to the stage.
    ///
    /// Right and bottom edge tiles are partial when the stage is not an exact
    /// multiple of the tile size. Clipping here means the composite never has to
    /// know about the ragged edge.
    pub fn tile_bounds(&self, coord: TileCoord) -> Rect {
        let x = self.origin.x + f64::from(coord.column) * self.tile_width;
        let y = self.origin.y + f64::from(coord.row) * self.tile_height;
        Rect::new(x, y, self.tile_width, self.tile_height).intersect(&self.logical_bounds)
    }

    /// A tile's unclipped rectangle. For grid overlays and diagnostics.
    pub fn tile_full_bounds(&self, coord: TileCoord) -> Rect {
        Rect::new(
            self.origin.x + f64::from(coord.column) * self.tile_width,
            self.origin.y + f64::from(coord.row) * self.tile_height,
            self.tile_width,
            self.tile_height,
        )
    }

    /// The rectangle a tile is actually rendered at: bounds plus overscan.
    ///
    /// Not clipped to the stage, because a blur at the stage edge still needs to
    /// know there is nothing out there.
    pub fn tile_render_bounds(&self, coord: TileCoord, overscan: f64) -> Rect {
        self.tile_bounds(coord).inflate(overscan.max(0.0))
    }

    /// Pixel dimensions of a tile's render target.
    pub fn tile_render_size(
        &self,
        coord: TileCoord,
        render_scale: f64,
        overscan: f64,
    ) -> (u32, u32) {
        let bounds = self.tile_render_bounds(coord, overscan);
        (
            ((bounds.width * render_scale).ceil() as u32).max(1),
            ((bounds.height * render_scale).ceil() as u32).max(1),
        )
    }

    /// Column range a rectangle touches, clamped to the grid.
    ///
    /// Partition semantics: `ceil - 1` is what keeps a boundary-aligned right edge
    /// inside one column.
    pub fn column_range(&self, bounds: &Rect) -> Option<(u32, u32)> {
        if !(bounds.width > 0.0) {
            return None;
        }

        let relative_left = bounds.x - self.origin.x;
        let relative_right = bounds.right() - self.origin.x;

        let start = (relative_left / self.tile_width).floor();
        let end = (relative_right / self.tile_width).ceil() - 1.0;

        clamp_range(start, end, self.columns)
    }

    pub fn row_range(&self, bounds: &Rect) -> Option<(u32, u32)> {
        if !(bounds.height > 0.0) {
            return None;
        }

        let relative_top = bounds.y - self.origin.y;
        let relative_bottom = bounds.bottom() - self.origin.y;

        let start = (relative_top / self.tile_height).floor();
        let end = (relative_bottom / self.tile_height).ceil() - 1.0;

        clamp_range(start, end, self.rows)
    }

    /// Every tile a rectangle overlaps.
    ///
    /// Index-driven, so the cost is proportional to the tiles actually touched
    /// rather than to the grid size. A 512-tile grid over a 50,000 x 50,000 stage
    /// has 9,604 tiles, and a lower third touches four.
    pub fn tiles_for_rect(&self, bounds: &Rect) -> Vec<TileCoord> {
        let Some((column_start, column_end)) = self.column_range(bounds) else {
            return Vec::new();
        };
        let Some((row_start, row_end)) = self.row_range(bounds) else {
            return Vec::new();
        };

        let mut result = Vec::new();
        for row in row_start..=row_end {
            for column in column_start..=column_end {
                result.push(TileCoord::new(column, row));
            }
        }
        result
    }

    pub fn tile_ids_for_rect(&self, bounds: &Rect) -> Vec<TileId> {
        self.tiles_for_rect(bounds)
            .into_iter()
            .map(|coord| coord.id())
            .collect()
    }

    /// How many tiles a rectangle touches, without materialising the list.
    pub fn count_tiles_for_rect(&self, bounds: &Rect) -> u64 {
        let Some((column_start, column_end)) = self.column_range(bounds) else {
            return 0;
        };
        let Some((row_start, row_end)) = self.row_range(bounds) else {
            return 0;
        };
        u64::from(column_end - column_start + 1) * u64::from(row_end - row_start + 1)
    }

    pub fn tile_at_point(&self, point: Point) -> Option<TileCoord> {
        let column = ((point.x - self.origin.x) / self.tile_width).floor();
        let row = ((point.y - self.origin.y) / self.tile_height).floor();
        if column < 0.0 || row < 0.0 {
            return None;
        }
        let coord = TileCoord::new(column as u32, row as u32);
        if self.is_valid(coord) {
            Some(coord)
        } else {
            None
        }
    }

    /// Bytes one tile's render target needs, overscan included.
    ///
    /// Overscan is not free: a 1024 tile with 32 units of overscan is 1088 x 1088,
    /// which is 13% more memory than the tile itself.
    pub fn tile_byte_estimate(&self, coord: TileCoord, render_scale: f64, overscan: f64) -> u64 {
        let (width, height) = self.tile_render_size(coord, render_scale, overscan);
        u64::from(width) * u64::from(height) * 4
    }
}

fn clamp_range(start: f64, end: f64, limit: u32) -> Option<(u32, u32)> {
    if !start.is_finite() || !end.is_finite() {
        return None;
    }
    let clamped_start = start.max(0.0) as i64;
    let clamped_end = end.min(f64::from(limit) - 1.0) as i64;
    if clamped_end < clamped_start || clamped_end < 0 {
        return None;
    }
    Some((clamped_start as u32, clamped_end as u32))
}

// ---------------------------------------------------------------------------
// Tile state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TileRenderState {
    #[default]
    Idle,
    Queued,
    Rendering,
    Rendered,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TileGpuState {
    #[default]
    None,
    Allocating,
    Allocated,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TileCacheState {
    #[default]
    Cold,
    Warm,
    Hot,
    Evicted,
}

/// Why a tile was selected. Diagnostics only, never control flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionReason {
    Viewport,
    Output,
    Preview,
    Export,
    Dirty,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TileDescriptor {
    pub tile_id: TileId,
    pub column: u32,
    pub row: u32,
    pub logical_bounds: Rect,
    /// Bounds plus required overscan. What the render target actually covers.
    pub render_bounds: Rect,
    pub active_object_ids: Vec<String>,
    pub dirty: bool,
    pub render_state: TileRenderState,
    pub gpu_state: TileGpuState,
    pub cache_state: TileCacheState,
    pub last_rendered_frame: Option<u64>,
    pub last_used_tick: u64,
    pub output_refs: Vec<String>,
    pub required_overscan: f64,
    pub estimated_bytes: u64,
    pub failure_reason: Option<String>,
}

impl TileDescriptor {
    /// A tile needs work when it has never rendered or has been invalidated.
    pub fn needs_render(&self) -> bool {
        self.dirty
            || self.last_rendered_frame.is_none()
            || self.render_state == TileRenderState::Failed
            || self.cache_state == TileCacheState::Evicted
            || self.gpu_state == TileGpuState::Released
    }

    /// Tiles an output references must never be evicted.
    pub fn is_pinned(&self) -> bool {
        !self.output_refs.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Filter overscan
// ---------------------------------------------------------------------------

/// Sigma-to-radius factor for a Gaussian.
///
/// Three sigma captures 99.7% of the kernel. Truncating tighter is visible as a
/// hard edge exactly where a tile seam would be, which is the one place it must
/// not be visible.
pub const GAUSSIAN_SIGMA_RADIUS_FACTOR: f64 = 3.0;

/// A filter that needs pixels from outside its object's bounds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum FilterOverscan {
    GaussianBlur {
        sigma: f64,
    },
    BoxBlur {
        radius: f64,
    },
    DropShadow {
        sigma: f64,
        offset_x: f64,
        offset_y: f64,
    },
    Glow {
        sigma: f64,
        spread: f64,
    },
    Outline {
        width: f64,
    },
    Custom {
        extent: f64,
    },
}

impl FilterOverscan {
    pub fn extent(&self) -> f64 {
        match *self {
            FilterOverscan::GaussianBlur { sigma } => {
                (sigma.max(0.0) * GAUSSIAN_SIGMA_RADIUS_FACTOR).ceil()
            }
            FilterOverscan::BoxBlur { radius } => radius.max(0.0).ceil(),
            FilterOverscan::DropShadow {
                sigma,
                offset_x,
                offset_y,
            } => {
                (sigma.max(0.0) * GAUSSIAN_SIGMA_RADIUS_FACTOR).ceil()
                    + offset_x.abs().max(offset_y.abs()).ceil()
            }
            FilterOverscan::Glow { sigma, spread } => {
                (sigma.max(0.0) * GAUSSIAN_SIGMA_RADIUS_FACTOR).ceil() + spread.max(0.0).ceil()
            }
            FilterOverscan::Outline { width } => width.max(0.0).ceil(),
            FilterOverscan::Custom { extent } => extent.max(0.0).ceil(),
        }
    }
}

/// Combined extent of a filter stack.
///
/// Filters compose by summing: a blur followed by a drop shadow reaches further
/// than either alone. Taking the maximum would under-pad and produce seams.
pub fn filter_stack_extent(filters: &[FilterOverscan]) -> f64 {
    filters.iter().map(FilterOverscan::extent).sum()
}

// ---------------------------------------------------------------------------
// Object index
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct IndexedObject {
    pub object_id: String,
    pub bounds: Rect,
    pub filter_extent: f64,
    /// Bounds inflated by `filter_extent`; what the index keys on.
    pub effective_bounds: Rect,
    pub tiles: Vec<TileId>,
}

#[derive(Debug, Clone, Default)]
pub struct IndexDelta {
    pub object_id: String,
    pub entered: Vec<TileId>,
    pub left: Vec<TileId>,
    /// True when the tile set is unchanged but the geometry moved.
    pub moved_within_tiles: bool,
}

/// Incremental spatial index from scene objects to tiles.
///
/// Not a quadtree: a uniform grid *is* the spatial structure, so the index only
/// needs both directions of the mapping plus enough per-object state to compute a
/// delta. That delta is the difference between "render on change" and "render
/// everything every frame".
pub struct TileObjectIndex {
    grid: TileGrid,
    objects: HashMap<String, IndexedObject>,
    tile_objects: BTreeMap<TileId, BTreeSet<String>>,
}

impl TileObjectIndex {
    pub fn new(grid: TileGrid) -> Self {
        Self {
            grid,
            objects: HashMap::new(),
            tile_objects: BTreeMap::new(),
        }
    }

    pub fn object_count(&self) -> usize {
        self.objects.len()
    }

    pub fn occupied_tile_count(&self) -> usize {
        self.tile_objects.len()
    }

    /// Insert or move an object, reporting exactly which tiles changed membership.
    pub fn upsert(
        &mut self,
        object_id: &str,
        bounds: Rect,
        filters: &[FilterOverscan],
    ) -> IndexDelta {
        let filter_extent = filter_stack_extent(filters);
        self.upsert_with_extent(object_id, bounds, filter_extent)
    }

    pub fn upsert_with_extent(
        &mut self,
        object_id: &str,
        bounds: Rect,
        filter_extent: f64,
    ) -> IndexDelta {
        let effective_bounds = if filter_extent > 0.0 {
            bounds.inflate(filter_extent)
        } else {
            bounds
        };

        let next_tiles = self.grid.tile_ids_for_rect(&effective_bounds);
        let next_set: BTreeSet<TileId> = next_tiles.iter().cloned().collect();

        let previous = self.objects.get(object_id);
        let previous_set: BTreeSet<TileId> = previous
            .map(|entry| entry.tiles.iter().cloned().collect())
            .unwrap_or_default();

        let geometry_changed = match previous {
            None => true,
            Some(entry) => {
                entry.bounds != bounds || (entry.filter_extent - filter_extent).abs() > f64::EPSILON
            }
        };

        let entered: Vec<TileId> = next_tiles
            .iter()
            .filter(|id| !previous_set.contains(*id))
            .cloned()
            .collect();
        let left: Vec<TileId> = previous_set
            .iter()
            .filter(|id| !next_set.contains(*id))
            .cloned()
            .collect();

        for id in &entered {
            self.tile_objects
                .entry(id.clone())
                .or_default()
                .insert(object_id.to_string());
        }
        for id in &left {
            self.remove_from_tile(id, object_id);
        }

        let moved_within_tiles = geometry_changed && entered.is_empty() && left.is_empty();

        self.objects.insert(
            object_id.to_string(),
            IndexedObject {
                object_id: object_id.to_string(),
                bounds,
                filter_extent,
                effective_bounds,
                tiles: next_tiles,
            },
        );

        IndexDelta {
            object_id: object_id.to_string(),
            entered,
            left,
            moved_within_tiles,
        }
    }

    pub fn remove(&mut self, object_id: &str) -> IndexDelta {
        let Some(existing) = self.objects.remove(object_id) else {
            return IndexDelta {
                object_id: object_id.to_string(),
                ..Default::default()
            };
        };

        for id in &existing.tiles {
            self.remove_from_tile(id, object_id);
        }

        IndexDelta {
            object_id: object_id.to_string(),
            entered: Vec::new(),
            left: existing.tiles,
            moved_within_tiles: false,
        }
    }

    pub fn clear(&mut self) {
        self.objects.clear();
        self.tile_objects.clear();
    }

    pub fn get(&self, object_id: &str) -> Option<&IndexedObject> {
        self.objects.get(object_id)
    }

    pub fn tiles_for_object(&self, object_id: &str) -> Vec<TileId> {
        self.objects
            .get(object_id)
            .map(|entry| entry.tiles.clone())
            .unwrap_or_default()
    }

    /// Objects overlapping a tile, sorted for determinism.
    ///
    /// Sorted because two engines rendering the same frame must submit draws in the
    /// same order, or a transparent overlap can differ between them.
    pub fn objects_in_tile(&self, tile_id: &str) -> Vec<String> {
        self.tile_objects
            .get(tile_id)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Overscan a tile needs: the largest filter extent among its objects.
    pub fn required_overscan(&self, tile_id: &str, minimum: f64) -> f64 {
        let Some(set) = self.tile_objects.get(tile_id) else {
            return minimum;
        };

        let mut maximum = minimum;
        for object_id in set {
            if let Some(entry) = self.objects.get(object_id) {
                if entry.filter_extent > maximum {
                    maximum = entry.filter_extent;
                }
            }
        }
        maximum.ceil()
    }

    /// Objects whose effective bounds intersect a rectangle.
    pub fn objects_in_rect(&self, bounds: &Rect) -> Vec<String> {
        let mut candidates = BTreeSet::new();
        for coord in self.grid.tiles_for_rect(bounds) {
            if let Some(set) = self.tile_objects.get(&coord.id()) {
                for object_id in set {
                    candidates.insert(object_id.clone());
                }
            }
        }

        candidates
            .into_iter()
            .filter(|object_id| {
                self.objects
                    .get(object_id)
                    .is_some_and(|entry| entry.effective_bounds.intersects(bounds))
            })
            .collect()
    }

    /// Union of every indexed object's effective bounds.
    ///
    /// The area that could possibly need rendering. On a sparse 50,000-wide stage
    /// this is usually a small fraction of the whole thing.
    pub fn content_bounds(&self) -> Rect {
        self.objects
            .values()
            .fold(Rect::EMPTY, |acc, entry| acc.union(&entry.effective_bounds))
    }

    /// Objects that straddle more than one tile. The seam risks.
    pub fn multi_tile_objects(&self) -> Vec<String> {
        let mut result: Vec<String> = self
            .objects
            .values()
            .filter(|entry| entry.tiles.len() > 1)
            .map(|entry| entry.object_id.clone())
            .collect();
        result.sort();
        result
    }

    fn remove_from_tile(&mut self, tile_id: &str, object_id: &str) {
        if let Some(set) = self.tile_objects.get_mut(tile_id) {
            set.remove(object_id);
            if set.is_empty() {
                self.tile_objects.remove(tile_id);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tile manager
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct TileSelectionRequest {
    pub frame: u64,
    pub viewports: Vec<Rect>,
    pub outputs: Vec<Rect>,
    pub previews: Vec<Rect>,
    pub exports: Vec<Rect>,
    /// Include tiles that are required but already up to date.
    ///
    /// False is render-on-change. True forces a full redraw of the required set,
    /// which is what device-loss recovery and a first frame after resize need.
    pub include_clean: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TileSelection {
    pub required: Vec<TileId>,
    /// Subset of `required` that actually needs GPU work.
    pub to_render: Vec<TileId>,
    pub culled_count: u64,
    pub reasons: BTreeMap<TileId, Vec<SelectionReason>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TileManagerStats {
    pub total_tiles: u64,
    pub tracked_tiles: usize,
    pub resident_tiles: usize,
    pub dirty_tiles: usize,
    pub rendered_tiles: usize,
    pub failed_tiles: usize,
    pub evicted_tiles: usize,
    pub pinned_tiles: usize,
    pub cache_bytes: u64,
    pub cache_budget_bytes: u64,
    pub max_resident_tiles: u32,
    pub over_budget: bool,
    pub object_count: usize,
    pub multi_tile_object_count: usize,
}

/// What gets rendered, and what gets thrown away.
///
/// The selection rule from the requirements, implemented literally. A tile renders
/// only if it is in the union of: visible in an active viewport, dirty since its
/// last render, required by an active output, required for a preview, or required
/// for an export. Everything else is culled.
pub struct TileManager {
    pub grid: TileGrid,
    pub index: TileObjectIndex,
    tiles: BTreeMap<TileId, TileDescriptor>,
    cache_budget_bytes: u64,
    max_resident_tiles: u32,
    render_scale: f64,
    tick: u64,
}

impl TileManager {
    pub fn new(grid: TileGrid, tiling: &TilingConfig, render_scale: f64) -> Self {
        Self {
            index: TileObjectIndex::new(grid),
            grid,
            tiles: BTreeMap::new(),
            cache_budget_bytes: tiling.cache_budget_bytes,
            max_resident_tiles: tiling.max_resident_tiles,
            render_scale,
            tick: 0,
        }
    }

    // -- Scene synchronisation ------------------------------------------------

    /// Add or move an object, dirtying the minimum set of tiles.
    pub fn sync_object(
        &mut self,
        object_id: &str,
        bounds: Rect,
        filters: &[FilterOverscan],
    ) -> IndexDelta {
        let delta = self.index.upsert(object_id, bounds, filters);

        for id in delta.left.iter().chain(delta.entered.iter()) {
            self.mark_dirty(id);
        }
        if delta.moved_within_tiles {
            for id in self.index.tiles_for_object(object_id) {
                self.mark_dirty(&id);
            }
        }

        delta
    }

    pub fn remove_object(&mut self, object_id: &str) -> IndexDelta {
        let delta = self.index.remove(object_id);
        for id in &delta.left {
            self.mark_dirty(id);
        }
        delta
    }

    /// Object content changed without moving: text, material, a data update.
    pub fn invalidate_object(&mut self, object_id: &str) -> Vec<TileId> {
        let tiles = self.index.tiles_for_object(object_id);
        for id in &tiles {
            self.mark_dirty(id);
        }
        tiles
    }

    pub fn reset(&mut self) {
        self.index.clear();
        self.tiles.clear();
        self.tick = 0;
    }

    // -- Dirty tracking -------------------------------------------------------

    /// How many tiles the manager is currently tracking.
    ///
    /// Not the grid size: a 50,000-square stage has 2,401 tiles in its grid and may be
    /// tracking three. Used to report how much a whole-scene invalidation actually cost.
    pub fn tracked_tile_count(&self) -> usize {
        self.tiles.len()
    }

    pub fn mark_dirty(&mut self, tile_id: &str) {
        if self.ensure_tile(tile_id).is_none() {
            return;
        }
        if let Some(tile) = self.tiles.get_mut(tile_id) {
            tile.dirty = true;
            if matches!(
                tile.render_state,
                TileRenderState::Rendered | TileRenderState::Failed
            ) {
                tile.render_state = TileRenderState::Idle;
            }
        }
    }

    pub fn mark_rect_dirty(&mut self, bounds: &Rect) -> Vec<TileId> {
        let ids = self.grid.tile_ids_for_rect(bounds);
        for id in &ids {
            self.mark_dirty(id);
        }
        ids
    }

    /// Invalidate everything. Device loss, resize, or a full scene resync.
    pub fn mark_all_dirty(&mut self) {
        let mut ids = Vec::new();
        for row in 0..self.grid.rows {
            for column in 0..self.grid.columns {
                ids.push(TileCoord::new(column, row).id());
            }
        }
        for id in ids {
            self.mark_dirty(&id);
        }
    }

    pub fn is_dirty(&self, tile_id: &str) -> bool {
        self.tiles
            .get(tile_id)
            .map(|tile| tile.dirty)
            .unwrap_or(true)
    }

    // -- Selection ------------------------------------------------------------

    pub fn select_tiles(&mut self, request: &TileSelectionRequest) -> TileSelection {
        self.tick += 1;

        let mut reasons: BTreeMap<TileId, Vec<SelectionReason>> = BTreeMap::new();

        let mut collect = |rects: &[Rect], reason: SelectionReason, grid: &TileGrid| {
            for bounds in rects {
                if bounds.is_empty() {
                    continue;
                }
                for id in grid.tile_ids_for_rect(bounds) {
                    let entry = reasons.entry(id).or_default();
                    if !entry.contains(&reason) {
                        entry.push(reason);
                    }
                }
            }
        };

        collect(&request.viewports, SelectionReason::Viewport, &self.grid);
        collect(&request.outputs, SelectionReason::Output, &self.grid);
        collect(&request.previews, SelectionReason::Preview, &self.grid);
        collect(&request.exports, SelectionReason::Export, &self.grid);

        // A dirty tile only matters if something is looking at it. A dirty tile in
        // an unwatched corner of a 50,000-wide stage stays dirty and unrendered
        // until a viewport or output actually needs it.
        let dirty_ids: Vec<TileId> = reasons
            .keys()
            .filter(|id| self.is_dirty(id))
            .cloned()
            .collect();
        for id in dirty_ids {
            let entry = reasons.entry(id).or_default();
            if !entry.contains(&SelectionReason::Dirty) {
                entry.push(SelectionReason::Dirty);
            }
        }

        let mut required = Vec::new();
        let mut to_render = Vec::new();
        let tick = self.tick;

        let candidate_ids: Vec<TileId> = reasons.keys().cloned().collect();
        for id in candidate_ids {
            if self.ensure_tile(&id).is_none() {
                continue;
            }
            let Some(tile) = self.tiles.get_mut(&id) else {
                continue;
            };

            tile.last_used_tick = tick;
            tile.cache_state = match tile.cache_state {
                TileCacheState::Evicted => TileCacheState::Cold,
                TileCacheState::Cold => TileCacheState::Warm,
                TileCacheState::Warm | TileCacheState::Hot => TileCacheState::Hot,
            };

            let needs = tile.needs_render();
            required.push(id.clone());
            if request.include_clean || needs {
                to_render.push(id);
            }
        }

        let culled_count = self.grid.tile_count().saturating_sub(required.len() as u64);

        TileSelection {
            required,
            to_render,
            culled_count,
            reasons,
        }
    }

    // -- Render lifecycle -----------------------------------------------------

    pub fn begin_render(&mut self, ids: &[TileId]) {
        for id in ids {
            if self.ensure_tile(id).is_none() {
                continue;
            }
            if let Some(tile) = self.tiles.get_mut(id) {
                tile.render_state = TileRenderState::Rendering;
                if tile.gpu_state != TileGpuState::Allocated {
                    tile.gpu_state = TileGpuState::Allocating;
                }
            }
        }
    }

    pub fn complete_render(&mut self, tile_id: &str, frame: u64) {
        let tick = self.tick;
        if let Some(tile) = self.tiles.get_mut(tile_id) {
            tile.render_state = TileRenderState::Rendered;
            tile.gpu_state = TileGpuState::Allocated;
            tile.cache_state = TileCacheState::Hot;
            tile.dirty = false;
            tile.last_rendered_frame = Some(frame);
            tile.last_used_tick = tick;
            tile.failure_reason = None;
        }
    }

    pub fn fail_render(&mut self, tile_id: &str, reason: impl Into<String>) {
        if let Some(tile) = self.tiles.get_mut(tile_id) {
            tile.render_state = TileRenderState::Failed;
            tile.failure_reason = Some(reason.into());
            // Stays dirty so the next frame retries rather than showing a stale tile.
            tile.dirty = true;
        }
    }

    pub fn add_output_ref(&mut self, tile_id: &str, output_id: &str) {
        if self.ensure_tile(tile_id).is_none() {
            return;
        }
        if let Some(tile) = self.tiles.get_mut(tile_id) {
            if !tile.output_refs.iter().any(|id| id == output_id) {
                tile.output_refs.push(output_id.to_string());
            }
        }
    }

    pub fn remove_output_ref(&mut self, tile_id: &str, output_id: &str) {
        if let Some(tile) = self.tiles.get_mut(tile_id) {
            tile.output_refs.retain(|id| id != output_id);
        }
    }

    pub fn clear_output_refs(&mut self, output_id: &str) {
        for tile in self.tiles.values_mut() {
            tile.output_refs.retain(|id| id != output_id);
        }
    }

    // -- Eviction -------------------------------------------------------------

    /// Evict least-recently-used tiles until both budgets are satisfied.
    ///
    /// Pinned tiles are never candidates, and neither is anything rendering. If the
    /// remaining candidates cannot bring us under budget, eviction stops rather
    /// than dropping a tile an output is about to transmit: going over budget is
    /// recoverable, dropping a live output tile is not.
    pub fn evict(&mut self) -> Vec<TileId> {
        let mut evicted = Vec::new();

        let mut candidates: Vec<(u64, TileId)> = self
            .tiles
            .values()
            .filter(|tile| {
                tile.gpu_state == TileGpuState::Allocated
                    && !matches!(
                        tile.render_state,
                        TileRenderState::Rendering | TileRenderState::Queued
                    )
                    && !tile.is_pinned()
            })
            .map(|tile| (tile.last_used_tick, tile.tile_id.clone()))
            .collect();
        candidates.sort();

        for (_, tile_id) in candidates {
            if !self.over_budget() {
                break;
            }
            if let Some(tile) = self.tiles.get_mut(&tile_id) {
                tile.gpu_state = TileGpuState::Released;
                tile.cache_state = TileCacheState::Evicted;
                tile.render_state = TileRenderState::Idle;
                tile.dirty = true;
                tile.estimated_bytes = 0;
                evicted.push(tile_id);
            }
        }

        evicted
    }

    fn over_budget(&self) -> bool {
        self.cache_bytes() > self.cache_budget_bytes
            || self.resident_count() as u32 > self.max_resident_tiles
    }

    fn resident_count(&self) -> usize {
        self.tiles
            .values()
            .filter(|tile| tile.gpu_state == TileGpuState::Allocated)
            .count()
    }

    pub fn cache_bytes(&self) -> u64 {
        self.tiles
            .values()
            .filter(|tile| tile.gpu_state == TileGpuState::Allocated)
            .map(|tile| tile.estimated_bytes)
            .sum()
    }

    // -- Inspection -----------------------------------------------------------

    pub fn get(&self, tile_id: &str) -> Option<&TileDescriptor> {
        self.tiles.get(tile_id)
    }

    pub fn tracked_tiles(&self) -> Vec<&TileDescriptor> {
        self.tiles.values().collect()
    }

    pub fn dirty_tiles(&self) -> Vec<&TileDescriptor> {
        self.tiles.values().filter(|tile| tile.dirty).collect()
    }

    pub fn stats(&self) -> TileManagerStats {
        let mut resident_tiles = 0;
        let mut dirty_tiles = 0;
        let mut rendered_tiles = 0;
        let mut failed_tiles = 0;
        let mut evicted_tiles = 0;
        let mut pinned_tiles = 0;

        for tile in self.tiles.values() {
            if tile.gpu_state == TileGpuState::Allocated {
                resident_tiles += 1;
            }
            if tile.dirty {
                dirty_tiles += 1;
            }
            if tile.render_state == TileRenderState::Rendered {
                rendered_tiles += 1;
            }
            if tile.render_state == TileRenderState::Failed {
                failed_tiles += 1;
            }
            if tile.cache_state == TileCacheState::Evicted {
                evicted_tiles += 1;
            }
            if tile.is_pinned() {
                pinned_tiles += 1;
            }
        }

        let cache_bytes = self.cache_bytes();

        TileManagerStats {
            total_tiles: self.grid.tile_count(),
            tracked_tiles: self.tiles.len(),
            resident_tiles,
            dirty_tiles,
            rendered_tiles,
            failed_tiles,
            evicted_tiles,
            pinned_tiles,
            cache_bytes,
            cache_budget_bytes: self.cache_budget_bytes,
            max_resident_tiles: self.max_resident_tiles,
            over_budget: cache_bytes > self.cache_budget_bytes
                || resident_tiles as u32 > self.max_resident_tiles,
            object_count: self.index.object_count(),
            multi_tile_object_count: self.index.multi_tile_objects().len(),
        }
    }

    /// Create a descriptor on demand, or refresh a stale one.
    ///
    /// Descriptors are lazy: a grid may have 9,604 tiles while the manager tracks
    /// only the dozen anything has ever asked for.
    fn ensure_tile(&mut self, tile_id: &str) -> Option<()> {
        if self.tiles.contains_key(tile_id) {
            self.refresh_overscan(tile_id);
            return Some(());
        }

        let coord = parse_tile_id(tile_id)?;
        if !self.grid.is_valid(coord) {
            return None;
        }

        let required_overscan = self.index.required_overscan(tile_id, self.grid.overscan);

        let descriptor = TileDescriptor {
            tile_id: tile_id.to_string(),
            column: coord.column,
            row: coord.row,
            logical_bounds: self.grid.tile_bounds(coord),
            render_bounds: self.grid.tile_render_bounds(coord, required_overscan),
            active_object_ids: self.index.objects_in_tile(tile_id),
            dirty: true,
            render_state: TileRenderState::Idle,
            gpu_state: TileGpuState::None,
            cache_state: TileCacheState::Cold,
            last_rendered_frame: None,
            last_used_tick: self.tick,
            output_refs: Vec::new(),
            required_overscan,
            estimated_bytes: self.grid.tile_byte_estimate(
                coord,
                self.render_scale,
                required_overscan,
            ),
            failure_reason: None,
        };

        self.tiles.insert(tile_id.to_string(), descriptor);
        Some(())
    }

    /// Recompute overscan and membership when a tile's objects changed.
    ///
    /// A new object with a large blur raises a tile's overscan requirement, which
    /// changes the render target size. Missing that would clip the blur exactly at
    /// the seam.
    fn refresh_overscan(&mut self, tile_id: &str) {
        let required_overscan = self.index.required_overscan(tile_id, self.grid.overscan);
        let objects = self.index.objects_in_tile(tile_id);

        let Some(tile) = self.tiles.get(tile_id) else {
            return;
        };
        let coord = TileCoord::new(tile.column, tile.row);
        let changed = (tile.required_overscan - required_overscan).abs() > f64::EPSILON;

        let render_bounds = self.grid.tile_render_bounds(coord, required_overscan);
        let estimated_bytes =
            self.grid
                .tile_byte_estimate(coord, self.render_scale, required_overscan);

        if let Some(tile) = self.tiles.get_mut(tile_id) {
            tile.active_object_ids = objects;
            if !changed {
                return;
            }
            tile.required_overscan = required_overscan;
            tile.render_bounds = render_bounds;
            tile.estimated_bytes = estimated_bytes;
            // The render target changed size, so whatever is in it is unusable.
            tile.dirty = true;
            if tile.gpu_state == TileGpuState::Allocated {
                tile.gpu_state = TileGpuState::Released;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

/// One tile's contribution to a composite target.
#[derive(Debug, Clone, PartialEq)]
pub struct TileCompositeOp {
    pub tile_id: TileId,
    /// Logical rectangle this op contributes. Never includes overscan.
    pub logical_rect: Rect,
    /// Source rectangle inside the tile's render target, in render-target units.
    pub source_in_tile: Rect,
    /// Destination rectangle inside the composite target, in target units.
    pub destination: Rect,
    pub overscan: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TileCompositePlan {
    pub target: Rect,
    pub target_width: u32,
    pub target_height: u32,
    pub render_scale: f64,
    pub ops: Vec<TileCompositeOp>,
    /// Tiles that overlap the target but are not ready to contribute.
    pub missing_tile_ids: Vec<TileId>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeamReport {
    pub seamless: bool,
    pub covered_area: f64,
    pub target_area: f64,
    pub overlaps: Vec<(TileId, TileId)>,
    pub uncovered_area: f64,
}

/// Where a tile's usable content sits inside its own render target.
///
/// The render target starts at `render_bounds`, so the inner rectangle begins at
/// exactly the overscan offset.
pub fn tile_source_rect(tile: &TileDescriptor, render_scale: f64) -> Rect {
    let offset = tile.required_overscan * render_scale;
    Rect::new(
        offset,
        offset,
        tile.logical_bounds.width * render_scale,
        tile.logical_bounds.height * render_scale,
    )
}

/// Origin to subtract before narrowing a tile's geometry for the GPU.
///
/// The padded origin, not the tile corner. Getting it wrong shifts everything in
/// the tile by the overscan amount.
pub fn tile_local_origin(tile: &TileDescriptor) -> Point {
    Point::new(tile.render_bounds.x, tile.render_bounds.y)
}

/// An object's geometry in one tile's local space.
///
/// The single entry point for the precision rule: subtract in `f64` here, and only
/// then narrow to `f32` for the GPU.
pub fn object_rect_in_tile(object_bounds: &Rect, tile: &TileDescriptor) -> Rect {
    object_bounds.to_local(tile_local_origin(tile))
}

/// Build a composite plan for a logical target rectangle.
///
/// Tiles that overlap but are not ready are reported in `missing_tile_ids` rather
/// than silently omitted, so a caller can wait, render them, or accept a partial
/// frame — but never accept one without knowing.
pub fn plan_tile_composite(
    target: Rect,
    tiles: &[&TileDescriptor],
    render_scale: f64,
    require_rendered: bool,
) -> TileCompositePlan {
    let mut ops = Vec::new();
    let mut missing_tile_ids = Vec::new();

    for tile in tiles {
        let logical_rect = tile.logical_bounds.intersect(&target);
        if logical_rect.is_empty() {
            continue;
        }

        let ready = tile.render_state == TileRenderState::Rendered
            && tile.gpu_state == TileGpuState::Allocated;
        if require_rendered && !ready {
            missing_tile_ids.push(tile.tile_id.clone());
            continue;
        }

        // Offset within the tile's own content, then shifted past the overscan ring.
        let within_tile =
            logical_rect.to_local(Point::new(tile.logical_bounds.x, tile.logical_bounds.y));
        let overscan_offset = tile.required_overscan * render_scale;

        let source_in_tile = Rect::new(
            within_tile.x * render_scale + overscan_offset,
            within_tile.y * render_scale + overscan_offset,
            within_tile.width * render_scale,
            within_tile.height * render_scale,
        );

        let within_target = logical_rect.to_local(Point::new(target.x, target.y));
        let destination = Rect::new(
            within_target.x * render_scale,
            within_target.y * render_scale,
            within_target.width * render_scale,
            within_target.height * render_scale,
        );

        ops.push(TileCompositeOp {
            tile_id: tile.tile_id.clone(),
            logical_rect,
            source_in_tile,
            destination,
            overscan: tile.required_overscan,
        });
    }

    // Row-major so two engines composite in the same order.
    ops.sort_by(|a, b| {
        a.logical_rect
            .y
            .partial_cmp(&b.logical_rect.y)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.logical_rect
                    .x
                    .partial_cmp(&b.logical_rect.x)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    missing_tile_ids.sort();

    TileCompositePlan {
        target,
        target_width: ((target.width * render_scale).ceil() as u32).max(1),
        target_height: ((target.height * render_scale).ceil() as u32).max(1),
        render_scale,
        ops,
        missing_tile_ids,
    }
}

/// Prove a composite plan tiles its target exactly.
///
/// A gap means a strip of the output would be transparent; an overlap means a
/// strip would be composited twice, which is visible for anything non-opaque.
/// Either is a seam.
///
/// Because tile bounds come from a grid partition, a correct plan has zero overlap
/// by construction. This asserts the construction was not broken.
pub fn verify_seamless_coverage(plan: &TileCompositePlan) -> SeamReport {
    let target_area = plan.target.area();
    let covered_area: f64 = plan.ops.iter().map(|op| op.logical_rect.area()).sum();

    let mut overlaps = Vec::new();
    for i in 0..plan.ops.len() {
        for j in (i + 1)..plan.ops.len() {
            if !plan.ops[i]
                .logical_rect
                .intersect(&plan.ops[j].logical_rect)
                .is_empty()
            {
                overlaps.push((plan.ops[i].tile_id.clone(), plan.ops[j].tile_id.clone()));
            }
        }
    }

    // An epsilon because logical bounds are f64 and a 50,000-unit target
    // accumulates representation error.
    let epsilon = (target_area * 1e-12).max(1e-9);
    let uncovered_area = (target_area - covered_area).max(0.0);

    SeamReport {
        seamless: overlaps.is_empty()
            && uncovered_area <= epsilon
            && plan.missing_tile_ids.is_empty(),
        covered_area,
        target_area,
        overlaps,
        uncovered_area,
    }
}
