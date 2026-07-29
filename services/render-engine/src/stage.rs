//! The virtual canvas and stage model, in f64.
//!
//! Mirrors `@grapix/stage-model`. The two are kept deliberately parallel so the
//! TypeScript tests double as the specification for this module, and so a stage
//! authored in the Editor means exactly the same thing here.
//!
//! The precision rule, which the whole 50,000 x 50,000 requirement depends on:
//!
//! > Never hand absolute stage coordinates to the GPU. Subtract the tile or
//! > viewport origin in `f64` first, and only then narrow to `f32`.
//!
//! At 50,000 the `f64` spacing is about 7.3e-12 — twelve orders of magnitude
//! finer than a pixel. The `f32` spacing there is 0.0039 px, which is visible
//! jitter before any transform chain compounds it. `to_local` is that
//! subtraction, and `f32_error` exists so the improvement is asserted by tests
//! rather than assumed.

use serde::{Deserialize, Serialize};

/// Largest logical canvas dimension the architecture commits to supporting.
///
/// A logical limit, deliberately far above any GPU texture limit. Declaring a
/// canvas this large allocates nothing.
pub const MAX_LOGICAL_CANVAS_DIMENSION: f64 = 50_000.0;
pub const MIN_LOGICAL_CANVAS_DIMENSION: f64 = 1.0;

pub const DEFAULT_TILE_SIZE: u32 = 1024;
pub const MIN_TILE_SIZE: u32 = 64;
pub const MAX_TILE_SIZE: u32 = 8192;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const EMPTY: Self = Self {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };

    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    pub fn area(&self) -> f64 {
        self.width.max(0.0) * self.height.max(0.0)
    }

    pub fn is_empty(&self) -> bool {
        !(self.width > 0.0) || !(self.height > 0.0)
    }

    /// True when the rectangles share interior area.
    ///
    /// Touching edges do not count. That matters for tiling: the grid is a
    /// partition, so an object whose right edge lands exactly on a boundary
    /// belongs to one tile, not two.
    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }

    pub fn contains_rect(&self, inner: &Rect) -> bool {
        inner.x >= self.x
            && inner.y >= self.y
            && inner.right() <= self.right()
            && inner.bottom() <= self.bottom()
    }

    pub fn intersect(&self, other: &Rect) -> Rect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());

        if right <= x || bottom <= y {
            return Rect::new(x, y, 0.0, 0.0);
        }
        Rect::new(x, y, right - x, bottom - y)
    }

    pub fn union(&self, other: &Rect) -> Rect {
        if self.is_empty() {
            return *other;
        }
        if other.is_empty() {
            return *self;
        }
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        Rect::new(x, y, right - x, bottom - y)
    }

    pub fn inflate(&self, amount: f64) -> Rect {
        Rect::new(
            self.x - amount,
            self.y - amount,
            self.width + amount * 2.0,
            self.height + amount * 2.0,
        )
    }

    /// Rebase onto a local origin, in `f64`.
    ///
    /// This is the precision rule. Call it before narrowing anything for the GPU.
    pub fn to_local(&self, origin: Point) -> Rect {
        Rect::new(self.x - origin.x, self.y - origin.y, self.width, self.height)
    }

    pub fn to_stage(&self, origin: Point) -> Rect {
        Rect::new(self.x + origin.x, self.y + origin.y, self.width, self.height)
    }

    /// Narrow to the precision the GPU actually uses.
    ///
    /// Only ever correct on a rectangle that has already been rebased.
    pub fn narrow_f32(&self) -> [f32; 4] {
        [
            self.x as f32,
            self.y as f32,
            self.width as f32,
            self.height as f32,
        ]
    }
}

/// Absolute error introduced by storing a coordinate as `f32`.
pub fn f32_error(value: f64) -> f64 {
    ((value as f32) as f64 - value).abs()
}

/// Absolute error after rebasing onto an origin and then narrowing.
///
/// Compare against [`f32_error`] on the same absolute coordinate to see what the
/// rebase buys. The tests assert the ratio rather than trusting it.
pub fn local_f32_error(value: f64, origin: f64) -> f64 {
    let local = value - origin;
    ((local as f32) as f64 - local).abs()
}

// ---------------------------------------------------------------------------
// Virtual canvas
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum OriginAnchor {
    #[default]
    TopLeft,
    Center,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOrigin {
    pub anchor: OriginAnchor,
    pub offset_x: f64,
    pub offset_y: f64,
}

impl Default for StageOrigin {
    fn default() -> Self {
        Self {
            anchor: OriginAnchor::TopLeft,
            offset_x: 0.0,
            offset_y: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualCanvas {
    pub logical_width: f64,
    pub logical_height: f64,
    #[serde(default)]
    pub origin: StageOrigin,
    #[serde(default = "one")]
    pub render_scale: f64,
    #[serde(default = "one")]
    pub pixel_aspect_ratio: f64,
}

fn one() -> f64 {
    1.0
}

impl Default for VirtualCanvas {
    fn default() -> Self {
        Self {
            logical_width: 1920.0,
            logical_height: 1080.0,
            origin: StageOrigin::default(),
            render_scale: 1.0,
            pixel_aspect_ratio: 1.0,
        }
    }
}

impl VirtualCanvas {
    pub fn new(logical_width: f64, logical_height: f64) -> Self {
        Self {
            logical_width,
            logical_height,
            ..Default::default()
        }
    }

    /// Clamp to the documented range. Deterministic, so the engine and the editor
    /// normalise identically.
    pub fn normalized(&self) -> Self {
        Self {
            logical_width: clamp_dimension(self.logical_width, 1920.0),
            logical_height: clamp_dimension(self.logical_height, 1080.0),
            origin: self.origin,
            render_scale: clamp_positive(self.render_scale, 1.0, 1.0 / 4096.0, 16.0),
            pixel_aspect_ratio: clamp_positive(self.pixel_aspect_ratio, 1.0, 1.0 / 16.0, 16.0),
        }
    }

    /// The stage as a rectangle in its own coordinate system.
    pub fn bounds(&self) -> Rect {
        match self.origin.anchor {
            OriginAnchor::Center => Rect::new(
                -self.logical_width / 2.0,
                -self.logical_height / 2.0,
                self.logical_width,
                self.logical_height,
            ),
            OriginAnchor::Custom => Rect::new(
                -self.origin.offset_x,
                -self.origin.offset_y,
                self.logical_width,
                self.logical_height,
            ),
            OriginAnchor::TopLeft => {
                Rect::new(0.0, 0.0, self.logical_width, self.logical_height)
            }
        }
    }

    pub fn origin_point(&self) -> Point {
        let bounds = self.bounds();
        Point::new(bounds.x, bounds.y)
    }

    /// Bytes a single full-resolution RGBA8 image of this canvas would need.
    ///
    /// Exists to be *reported*, never allocated. It is the number that makes the
    /// case for tiling: a 50,000 x 50,000 stage is 10 GB.
    pub fn full_resolution_bytes(&self) -> u64 {
        (self.logical_width.max(0.0) as u64) * (self.logical_height.max(0.0) as u64) * 4
    }

    /// Whether this canvas could ever be one GPU texture.
    pub fn exceeds_texture_limit(&self, max_texture_dimension: u32) -> bool {
        let limit = f64::from(max_texture_dimension);
        self.logical_width > limit || self.logical_height > limit
    }
}

fn clamp_dimension(value: f64, fallback: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return fallback;
    }
    value.clamp(MIN_LOGICAL_CANVAS_DIMENSION, MAX_LOGICAL_CANVAS_DIMENSION)
}

fn clamp_positive(value: f64, fallback: f64, minimum: f64, maximum: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return fallback;
    }
    value.clamp(minimum, maximum)
}

// ---------------------------------------------------------------------------
// Stage structure
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub region_id: String,
    #[serde(default)]
    pub name: String,
    pub bounds: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ViewportSource {
    FullStage,
    Region {
        #[serde(rename = "regionId")]
        region_id: String,
    },
    Surface {
        #[serde(rename = "surfaceId")]
        surface_id: String,
    },
    Rect { bounds: Rect },
}

impl Default for ViewportSource {
    fn default() -> Self {
        Self::FullStage
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub viewport_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub source: ViewportSource,
    /// Logical-to-render pixel ratio.
    ///
    /// This is how a 50,000 x 10,000 stage becomes a 1920 x 384 operator preview:
    /// one viewport over the full stage at `render_scale` 0.0384.
    #[serde(default = "one")]
    pub render_scale: f64,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Where a physical display sits on the stage.
///
/// Placement only. The physical detail — panel kind, density, bezels, warp, edge
/// blending — belongs to the surface layout, which the engine carries but does
/// not yet apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfacePlacement {
    pub surface_id: String,
    #[serde(default)]
    pub name: String,
    pub position: Point,
    pub size: Size,
    #[serde(default)]
    pub rotation_degrees: f64,
    #[serde(default)]
    pub output_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// True when the surface declares warp, edge blending, or bezel compensation
    /// that this engine carries but cannot yet apply. Reported, never hidden.
    #[serde(default)]
    pub calibration_pending: bool,
}

impl SurfacePlacement {
    pub fn bounds(&self) -> Rect {
        Rect::new(
            self.position.x,
            self.position.y,
            self.size.width,
            self.size.height,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

impl Default for FrameRate {
    fn default() -> Self {
        Self {
            numerator: 50,
            denominator: 1,
        }
    }
}

impl FrameRate {
    /// Exact frame duration in nanoseconds. Integer maths, so it cannot drift.
    pub fn frame_duration_nanos(&self) -> u64 {
        if self.numerator == 0 {
            return 0;
        }
        (1_000_000_000u64 * u64::from(self.denominator)) / u64::from(self.numerator)
    }

    /// Absolute deadline of a frame, computed from the frame number.
    ///
    /// Never accumulated: computing from `frame` is what makes frame one million
    /// as accurate as frame one.
    pub fn deadline_nanos(&self, frame: u64) -> u64 {
        if self.numerator == 0 {
            return 0;
        }
        (frame as u128 * 1_000_000_000u128 * u128::from(self.denominator)
            / u128::from(self.numerator)) as u64
    }

    /// Decimal rate. Display only — never use it for scheduling.
    pub fn approximate(&self) -> f64 {
        if self.denominator == 0 {
            return 0.0;
        }
        f64::from(self.numerator) / f64::from(self.denominator)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputTarget {
    pub output_id: String,
    #[serde(default)]
    pub name: String,
    /// Device pixels. Completely independent of the logical canvas.
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub frame_rate: FrameRate,
    /// Opaque adapter identifier, resolved against the engine's registry.
    #[serde(default = "null_adapter")]
    pub adapter_id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn null_adapter() -> String {
    "null".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum OutputMappingSource {
    FullStage,
    Region {
        #[serde(rename = "regionId")]
        region_id: String,
    },
    Surface {
        #[serde(rename = "surfaceId")]
        surface_id: String,
    },
    Viewport {
        #[serde(rename = "viewportId")]
        viewport_id: String,
    },
    Rect { bounds: Rect },
}

impl Default for OutputMappingSource {
    fn default() -> Self {
        Self::FullStage
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FitMode {
    Stretch,
    #[default]
    Contain,
    Cover,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputMapping {
    pub mapping_id: String,
    pub output_id: String,
    #[serde(default)]
    pub source: OutputMappingSource,
    #[serde(default)]
    pub fit: FitMode,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TilingConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_tile_size")]
    pub tile_width: u32,
    #[serde(default = "default_tile_size")]
    pub tile_height: u32,
    /// Logical padding rendered outside each tile so filters have neighbours.
    #[serde(default = "default_overscan")]
    pub overscan: u32,
    #[serde(default = "default_max_resident")]
    pub max_resident_tiles: u32,
    #[serde(default = "default_cache_budget")]
    pub cache_budget_bytes: u64,
}

fn default_tile_size() -> u32 {
    DEFAULT_TILE_SIZE
}

fn default_overscan() -> u32 {
    32
}

fn default_max_resident() -> u32 {
    256
}

fn default_cache_budget() -> u64 {
    512 * 1024 * 1024
}

impl Default for TilingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            tile_width: DEFAULT_TILE_SIZE,
            tile_height: DEFAULT_TILE_SIZE,
            overscan: 32,
            max_resident_tiles: 256,
            cache_budget_bytes: 512 * 1024 * 1024,
        }
    }
}

impl TilingConfig {
    pub fn normalized(&self) -> Self {
        Self {
            enabled: self.enabled,
            tile_width: self.tile_width.clamp(MIN_TILE_SIZE, MAX_TILE_SIZE),
            tile_height: self.tile_height.clamp(MIN_TILE_SIZE, MAX_TILE_SIZE),
            overscan: self.overscan.min(1024),
            max_resident_tiles: self.max_resident_tiles.clamp(1, 65_536),
            cache_budget_bytes: self.cache_budget_bytes.max(1024 * 1024),
        }
    }

    /// Whether padded tiles fit the GPU's texture limit.
    pub fn fits_texture_limit(&self, max_texture_dimension: u32) -> bool {
        self.tile_width + self.overscan * 2 <= max_texture_dimension
            && self.tile_height + self.overscan * 2 <= max_texture_dimension
    }
}

pub const STAGE_DOCUMENT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDocument {
    pub stage_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "stage_version")]
    pub version: u32,
    #[serde(default)]
    pub revision: Option<u64>,
    pub canvas: VirtualCanvas,
    #[serde(default)]
    pub regions: Vec<Region>,
    #[serde(default)]
    pub surfaces: Vec<SurfacePlacement>,
    #[serde(default)]
    pub viewports: Vec<Viewport>,
    #[serde(default)]
    pub outputs: Vec<OutputTarget>,
    #[serde(default)]
    pub output_mappings: Vec<OutputMapping>,
    #[serde(default)]
    pub tiling: TilingConfig,
}

fn stage_version() -> u32 {
    STAGE_DOCUMENT_VERSION
}

impl StageDocument {
    /// The implicit stage for a scene with no stage of its own.
    ///
    /// Every pre-stage scene behaves as a single-surface stage exactly the size of
    /// its canvas, with tiling off. That keeps existing scenes renderable through
    /// the legacy single-target path without migration.
    pub fn implicit(stage_id: impl Into<String>, width: f64, height: f64) -> Self {
        Self {
            stage_id: stage_id.into(),
            name: "Implicit stage".to_string(),
            version: STAGE_DOCUMENT_VERSION,
            revision: None,
            canvas: VirtualCanvas::new(width, height),
            regions: Vec::new(),
            surfaces: Vec::new(),
            viewports: vec![Viewport {
                viewport_id: "viewport_program".to_string(),
                name: "Program".to_string(),
                source: ViewportSource::FullStage,
                render_scale: 1.0,
                enabled: true,
            }],
            outputs: Vec::new(),
            output_mappings: Vec::new(),
            tiling: TilingConfig {
                enabled: false,
                ..TilingConfig::default()
            },
        }
    }

    pub fn normalized(&self) -> Self {
        let mut normalized = self.clone();
        normalized.canvas = self.canvas.normalized();
        normalized.tiling = self.tiling.normalized();
        normalized.version = STAGE_DOCUMENT_VERSION;
        normalized
    }

    pub fn bounds(&self) -> Rect {
        self.canvas.bounds()
    }

    pub fn region(&self, region_id: &str) -> Option<&Region> {
        self.regions.iter().find(|r| r.region_id == region_id)
    }

    pub fn surface(&self, surface_id: &str) -> Option<&SurfacePlacement> {
        self.surfaces.iter().find(|s| s.surface_id == surface_id)
    }

    pub fn viewport(&self, viewport_id: &str) -> Option<&Viewport> {
        self.viewports.iter().find(|v| v.viewport_id == viewport_id)
    }

    pub fn output(&self, output_id: &str) -> Option<&OutputTarget> {
        self.outputs.iter().find(|o| o.output_id == output_id)
    }

    /// Logical rectangle a viewport source refers to, clipped to the stage.
    pub fn resolve_viewport_source(&self, source: &ViewportSource) -> Rect {
        let stage = self.bounds();
        match source {
            ViewportSource::Region { region_id } => self
                .region(region_id)
                .map(|region| region.bounds.intersect(&stage))
                .unwrap_or(stage),
            ViewportSource::Surface { surface_id } => self
                .surface(surface_id)
                .map(|surface| surface.bounds().intersect(&stage))
                .unwrap_or(stage),
            ViewportSource::Rect { bounds } => bounds.intersect(&stage),
            ViewportSource::FullStage => stage,
        }
    }

    pub fn resolve_viewport(&self, viewport: &Viewport) -> Rect {
        self.resolve_viewport_source(&viewport.source)
    }

    /// Render-target size in pixels for a viewport.
    ///
    /// Rounded up so a fractional render scale never drops the last row of
    /// logical content.
    pub fn viewport_render_size(&self, viewport: &Viewport) -> (u32, u32) {
        let bounds = self.resolve_viewport(viewport);
        (
            ((bounds.width * viewport.render_scale).ceil() as u32).max(1),
            ((bounds.height * viewport.render_scale).ceil() as u32).max(1),
        )
    }

    /// Logical rectangle an output mapping reads from.
    pub fn resolve_output_source(&self, mapping: &OutputMapping) -> Rect {
        let stage = self.bounds();
        match &mapping.source {
            OutputMappingSource::Region { region_id } => self
                .region(region_id)
                .map(|region| region.bounds.intersect(&stage))
                .unwrap_or(stage),
            OutputMappingSource::Surface { surface_id } => self
                .surface(surface_id)
                .map(|surface| surface.bounds().intersect(&stage))
                .unwrap_or(stage),
            OutputMappingSource::Viewport { viewport_id } => self
                .viewport(viewport_id)
                .map(|viewport| self.resolve_viewport(viewport))
                .unwrap_or(stage),
            OutputMappingSource::Rect { bounds } => bounds.intersect(&stage),
            OutputMappingSource::FullStage => stage,
        }
    }

    /// Union of every logical rectangle an enabled output needs.
    ///
    /// The tile system uses this so nothing outside any output's reach is rendered.
    pub fn required_output_coverage(&self) -> Vec<Rect> {
        let enabled: Vec<&str> = self
            .outputs
            .iter()
            .filter(|output| output.enabled)
            .map(|output| output.output_id.as_str())
            .collect();

        self.output_mappings
            .iter()
            .filter(|mapping| {
                mapping.enabled && enabled.contains(&mapping.output_id.as_str())
            })
            .map(|mapping| self.resolve_output_source(mapping))
            .filter(|rect| !rect.is_empty())
            .collect()
    }

    /// Render scale that fits a logical rectangle inside a pixel budget.
    ///
    /// How a preview request for a huge stage becomes a sane image instead of a
    /// 10 GB frame.
    pub fn fit_render_scale(bounds: &Rect, max_width: u32, max_height: u32) -> f64 {
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return 1.0;
        }
        (f64::from(max_width) / bounds.width)
            .min(f64::from(max_height) / bounds.height)
            .min(1.0)
    }

    /// Surfaces that declare corrections this engine cannot yet apply.
    pub fn uncalibrated_surfaces(&self) -> Vec<&SurfacePlacement> {
        self.surfaces
            .iter()
            .filter(|surface| surface.enabled && surface.calibration_pending)
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageIssue {
    pub severity: IssueSeverity,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageValidation {
    pub valid: bool,
    pub issues: Vec<StageIssue>,
}

/// Hardware limits a stage is checked against.
pub struct EngineStageLimits {
    pub max_logical_canvas_width: f64,
    pub max_logical_canvas_height: f64,
    pub max_texture_dimension: u32,
    pub tile_rendering: bool,
    pub max_surfaces: usize,
    pub max_outputs: usize,
}

impl StageDocument {
    /// Structural and hardware validation together.
    ///
    /// Errors mean the engine refuses the stage; warnings mean it renders but the
    /// operator should know something first.
    pub fn validate(&self, limits: &EngineStageLimits) -> StageValidation {
        let mut issues = Vec::new();
        let stage = self.bounds();

        let mut error = |code: &str, message: String| {
            issues.push(StageIssue {
                severity: IssueSeverity::Error,
                code: code.to_string(),
                message,
            });
        };

        if self.canvas.logical_width > limits.max_logical_canvas_width {
            error(
                "ENGINE_CANVAS_WIDTH",
                format!(
                    "engine supports a logical width of {}; stage needs {}",
                    limits.max_logical_canvas_width, self.canvas.logical_width
                ),
            );
        }
        if self.canvas.logical_height > limits.max_logical_canvas_height {
            error(
                "ENGINE_CANVAS_HEIGHT",
                format!(
                    "engine supports a logical height of {}; stage needs {}",
                    limits.max_logical_canvas_height, self.canvas.logical_height
                ),
            );
        }

        let needs_tiling = self.canvas.exceeds_texture_limit(limits.max_texture_dimension);
        if needs_tiling && !self.tiling.enabled {
            error(
                "TILING_REQUIRED",
                format!(
                    "stage exceeds the engine texture limit of {}px and requires tiling",
                    limits.max_texture_dimension
                ),
            );
        }
        if needs_tiling && !limits.tile_rendering {
            error(
                "ENGINE_NO_TILING",
                "stage requires tiled rendering but this engine does not support it".to_string(),
            );
        }

        if self.tiling.enabled && !self.tiling.fits_texture_limit(limits.max_texture_dimension) {
            let footprint = (self.tiling.tile_width + self.tiling.overscan * 2)
                .max(self.tiling.tile_height + self.tiling.overscan * 2);
            error(
                "TILE_EXCEEDS_TEXTURE_LIMIT",
                format!(
                    "tile plus overscan is {footprint}px; engine maximum texture dimension is {}",
                    limits.max_texture_dimension
                ),
            );
        }

        if self.surfaces.len() > limits.max_surfaces {
            error(
                "TOO_MANY_SURFACES",
                format!(
                    "engine supports {} surfaces; stage declares {}",
                    limits.max_surfaces,
                    self.surfaces.len()
                ),
            );
        }
        if self.outputs.len() > limits.max_outputs {
            error(
                "TOO_MANY_OUTPUTS",
                format!(
                    "engine supports {} outputs; stage declares {}",
                    limits.max_outputs,
                    self.outputs.len()
                ),
            );
        }

        // Dangling references.
        for viewport in &self.viewports {
            match &viewport.source {
                ViewportSource::Region { region_id } if self.region(region_id).is_none() => {
                    error(
                        "VIEWPORT_REGION_MISSING",
                        format!(
                            "viewport {} references unknown region {region_id}",
                            viewport.viewport_id
                        ),
                    );
                }
                ViewportSource::Surface { surface_id } if self.surface(surface_id).is_none() => {
                    error(
                        "VIEWPORT_SURFACE_MISSING",
                        format!(
                            "viewport {} references unknown surface {surface_id}",
                            viewport.viewport_id
                        ),
                    );
                }
                _ => {}
            }
        }

        for mapping in &self.output_mappings {
            if self.output(&mapping.output_id).is_none() {
                error(
                    "MAPPING_OUTPUT_MISSING",
                    format!(
                        "output mapping {} references unknown output {}",
                        mapping.mapping_id, mapping.output_id
                    ),
                );
            }
        }

        for surface in &self.surfaces {
            if let Some(output_id) = &surface.output_id {
                if self.output(output_id).is_none() {
                    error(
                        "SURFACE_OUTPUT_MISSING",
                        format!(
                            "surface {} references unknown output {output_id}",
                            surface.surface_id
                        ),
                    );
                }
            }
        }

        // Warnings.
        for region in &self.regions {
            if !stage.contains_rect(&region.bounds) && !region.bounds.is_empty() {
                issues.push(StageIssue {
                    severity: IssueSeverity::Warning,
                    code: "REGION_OUTSIDE_STAGE".to_string(),
                    message: format!("region {} extends outside the stage", region.region_id),
                });
            }
        }

        for surface in self.uncalibrated_surfaces() {
            issues.push(StageIssue {
                severity: IssueSeverity::Warning,
                code: "CALIBRATION_NOT_IMPLEMENTED".to_string(),
                message: format!(
                    "surface {} declares warp, edge blend, or bezel compensation; the engine carries the data but does not apply it",
                    surface.surface_id
                ),
            });
        }

        let valid = !issues
            .iter()
            .any(|issue| issue.severity == IssueSeverity::Error);
        StageValidation { valid, issues }
    }
}
