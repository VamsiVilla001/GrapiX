//! Tile planning and seam-free composition for stages larger than a device texture.
//!
//! A stage must never become one GPU texture (invariant 37): doing so makes a
//! stage silently fail at a device-specific edge. This module derives every
//! render target from the negotiated device limit, extends interior tile edges
//! by the filter radius, then copies only each tile's unfiltered core into the
//! final frame. That overscan prevents a filter at a seam from reading beyond
//! the tile that owns it. It also translates stage positions in `f64` before
//! producing tile-local `f32` coordinates (invariant 38), preventing distant
//! stage positions from entering GPU geometry and losing pixel precision.

use crate::rasterizer::Frame;

/// The widest sample footprint the current compositing filter can read.
pub const FILTER_RADIUS: u32 = 1;

/// A stage-space origin. It remains `f64` until a tile-local coordinate is
/// formed, so absolute positions never reach a GPU-facing `f32` value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StageOrigin {
    pub x: f64,
    pub y: f64,
}

/// A point in absolute stage space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StagePoint {
    pub x: f64,
    pub y: f64,
}

/// The dimensions and absolute placement of a render stage.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stage {
    pub width: u32,
    pub height: u32,
    pub origin: StageOrigin,
}

impl Stage {
    /// Make a non-empty stage at an absolute stage-space origin.
    pub fn new(width: u32, height: u32, origin: StageOrigin) -> Result<Self, TileError> {
        if width == 0 || height == 0 {
            return Err(TileError::EmptyStage);
        }
        if !origin.x.is_finite() || !origin.y.is_finite() {
            return Err(TileError::NonFiniteStageOrigin);
        }
        Ok(Self {
            width,
            height,
            origin,
        })
    }
}

/// A named failure to form or render a tile plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TileError {
    EmptyStage,
    NonFiniteStageOrigin,
    TextureLimitTooSmall { actual: u32, minimum: u32 },
    PointOutsideTile,
    BufferTooLarge,
}

impl std::fmt::Display for TileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyStage => formatter.write_str("a render stage must not be empty"),
            Self::NonFiniteStageOrigin => formatter.write_str("a stage origin must be finite"),
            Self::TextureLimitTooSmall { actual, minimum } => write!(
                formatter,
                "texture limit {actual} is below the {minimum}-pixel minimum needed for overscan"
            ),
            Self::PointOutsideTile => {
                formatter.write_str("stage point lies outside the tile target")
            }
            Self::BufferTooLarge => {
                formatter.write_str("tile or composite buffer exceeds addressable memory")
            }
        }
    }
}

impl std::error::Error for TileError {}

/// An axis-aligned pixel rectangle relative to a stage origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl PixelRect {
    fn right(self) -> u32 {
        self.x + self.width
    }

    fn bottom(self) -> u32 {
        self.y + self.height
    }
}

/// One render target's core and its overscanned input area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    /// The pixels this tile owns in the final composite.
    pub core: PixelRect,
    /// The pixels materialized in this tile's render target, including the
    /// filter footprint around interior core edges.
    pub render_bounds: PixelRect,
    stage_origin: StageOrigin,
}

impl Tile {
    /// Translate an absolute stage point to this render target's local GPU
    /// coordinate. The subtraction is deliberately in `f64`; narrowing the
    /// absolute point first would lose a one-pixel delta at a distant corner.
    pub fn local_coordinate(&self, point: StagePoint) -> Result<[f32; 2], TileError> {
        let render_x = self.stage_origin.x + f64::from(self.render_bounds.x);
        let render_y = self.stage_origin.y + f64::from(self.render_bounds.y);
        let local_x = point.x - render_x;
        let local_y = point.y - render_y;
        if !local_x.is_finite()
            || !local_y.is_finite()
            || local_x < 0.0
            || local_y < 0.0
            || local_x >= f64::from(self.render_bounds.width)
            || local_y >= f64::from(self.render_bounds.height)
        {
            return Err(TileError::PointOutsideTile);
        }
        Ok([local_x as f32, local_y as f32])
    }
}

/// A plan whose render targets are all no larger than the device's actual
/// `max_texture_dimension_2d`.
#[derive(Debug, Clone)]
pub struct TilePlan {
    stage: Stage,
    texture_limit: u32,
    tiles: Vec<Tile>,
}

impl TilePlan {
    /// Derive tile cores from an actual device texture limit.
    ///
    /// A dimension that already fits the device is one target. Above the
    /// limit, the core is `texture_limit - 2 * FILTER_RADIUS`, leaving
    /// overscan on both interior sides. A lower-limit device therefore creates
    /// smaller cores and more tiles; no fixed tile size can accidentally
    /// exceed a different device's capability.
    pub fn new(stage: Stage, texture_limit: u32) -> Result<Self, TileError> {
        let minimum = FILTER_RADIUS
            .checked_mul(2)
            .and_then(|diameter| diameter.checked_add(1))
            .expect("filter radius minimum fits in u32");
        if texture_limit < minimum {
            return Err(TileError::TextureLimitTooSmall {
                actual: texture_limit,
                minimum,
            });
        }
        let core_limit = texture_limit - FILTER_RADIUS * 2;
        let mut tiles = Vec::new();
        let mut y = 0;
        while y < stage.height {
            let core_height = if stage.height <= texture_limit {
                stage.height
            } else {
                core_limit.min(stage.height - y)
            };
            let mut x = 0;
            while x < stage.width {
                let core_width = if stage.width <= texture_limit {
                    stage.width
                } else {
                    core_limit.min(stage.width - x)
                };
                let core = PixelRect {
                    x,
                    y,
                    width: core_width,
                    height: core_height,
                };
                let left = x.saturating_sub(FILTER_RADIUS);
                let top = y.saturating_sub(FILTER_RADIUS);
                let right = core
                    .right()
                    .saturating_add(FILTER_RADIUS)
                    .min(stage.width);
                let bottom = core
                    .bottom()
                    .saturating_add(FILTER_RADIUS)
                    .min(stage.height);
                let render_bounds = PixelRect {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                };
                debug_assert!(render_bounds.width <= texture_limit);
                debug_assert!(render_bounds.height <= texture_limit);
                tiles.push(Tile {
                    core,
                    render_bounds,
                    stage_origin: stage.origin,
                });
                x += core_width;
            }
            y += core_height;
        }
        Ok(Self {
            stage,
            texture_limit,
            tiles,
        })
    }

    /// The negotiated device limit used to derive this plan.
    pub fn texture_limit(&self) -> u32 {
        self.texture_limit
    }

    /// Every tile that will be rendered and composited.
    pub fn tiles(&self) -> &[Tile] {
        &self.tiles
    }

    /// Composite the stage from its tiles, each tile contributing its core
    /// unchanged. Program and Preview use this: authored pixels go to air as
    /// authored (3.13). Before, every frame went through `composite_filtered`
    /// and its 3x3 box filter, blurring all of Program.
    pub fn composite(&self, source: impl Fn(StagePoint) -> [u8; 4]) -> Result<Frame, TileError> {
        let mut pixels = vec![0; bytes_for(self.stage.width, self.stage.height)?];
        for tile in &self.tiles {
            for y in 0..tile.core.height {
                for x in 0..tile.core.width {
                    let point = StagePoint {
                        x: self.stage.origin.x + f64::from(tile.core.x + x),
                        y: self.stage.origin.y + f64::from(tile.core.y + y),
                    };
                    let destination = pixel_offset(self.stage.width, tile.core.x + x, tile.core.y + y);
                    pixels[destination..destination + 4].copy_from_slice(&source(point));
                }
            }
        }
        Ok(Frame { width: self.stage.width, height: self.stage.height, pixels })
    }

    /// Render a filtered stage by materializing every tile target and cropping
    /// only its core into the composite. This is 3.9's proof that overscan
    /// keeps a filtered composite seam-free, for the effects that will need
    /// it; Program does not filter.
    ///
    /// `source` represents the stage content before the filter. It receives
    /// absolute stage positions because it is CPU-side scene evaluation; a GPU
    /// renderer calls [`Tile::local_coordinate`] to receive only local `f32`
    /// geometry for its target.
    pub fn composite_filtered(
        &self,
        source: impl Fn(StagePoint) -> [u8; 4],
    ) -> Result<Frame, TileError> {
        let mut pixels = vec![0; bytes_for(self.stage.width, self.stage.height)?];
        for tile in &self.tiles {
            let target_width = tile.render_bounds.width;
            let target_height = tile.render_bounds.height;
            let mut target = vec![0; bytes_for(target_width, target_height)?];
            for local_y in 0..target_height {
                for local_x in 0..target_width {
                    let stage_point = StagePoint {
                        x: self.stage.origin.x + f64::from(tile.render_bounds.x + local_x),
                        y: self.stage.origin.y + f64::from(tile.render_bounds.y + local_y),
                    };
                    let offset = pixel_offset(target_width, local_x, local_y);
                    target[offset..offset + 4].copy_from_slice(&source(stage_point));
                }
            }

            let core_x = tile.core.x - tile.render_bounds.x;
            let core_y = tile.core.y - tile.render_bounds.y;
            for y in 0..tile.core.height {
                for x in 0..tile.core.width {
                    let filtered =
                        box_filter(&target, target_width, target_height, core_x + x, core_y + y);
                    let destination =
                        pixel_offset(self.stage.width, tile.core.x + x, tile.core.y + y);
                    pixels[destination..destination + 4].copy_from_slice(&filtered);
                }
            }
        }
        Ok(Frame {
            width: self.stage.width,
            height: self.stage.height,
            pixels,
        })
    }
}

fn bytes_for(width: u32, height: u32) -> Result<usize, TileError> {
    let bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(TileError::BufferTooLarge)?;
    usize::try_from(bytes).map_err(|_| TileError::BufferTooLarge)
}

fn pixel_offset(width: u32, x: u32, y: u32) -> usize {
    ((y as usize * width as usize) + x as usize) * 4
}

fn box_filter(target: &[u8], width: u32, height: u32, x: u32, y: u32) -> [u8; 4] {
    let mut sums = [0_u16; 4];
    for sample_y in y.saturating_sub(FILTER_RADIUS)..=(y + FILTER_RADIUS).min(height - 1) {
        for sample_x in x.saturating_sub(FILTER_RADIUS)..=(x + FILTER_RADIUS).min(width - 1) {
            let offset = pixel_offset(width, sample_x, sample_y);
            for channel in 0..4 {
                sums[channel] += u16::from(target[offset + channel]);
            }
        }
    }
    // At a stage edge the render target is clipped, so divide by the actual
    // number of in-stage samples. Interior tile edges always have all nine
    // samples because overscan has materialized the filter footprint.
    let sample_width = (x + FILTER_RADIUS).min(width - 1) - x.saturating_sub(FILTER_RADIUS) + 1;
    let sample_height = (y + FILTER_RADIUS).min(height - 1) - y.saturating_sub(FILTER_RADIUS) + 1;
    let count =
        u16::try_from(sample_width * sample_height).expect("3x3 filter sample count fits u16");
    sums.map(|sum| (sum / count) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patterned_source(point: StagePoint) -> [u8; 4] {
        let x = point.x as u64;
        let y = point.y as u64;
        let mixed = x
            .wrapping_mul(0x9e37_79b9)
            .wrapping_add(y.wrapping_mul(0x85eb_ca6b));
        [mixed as u8, (mixed >> 8) as u8, (mixed >> 16) as u8, 0xff]
    }

    #[test]
    fn a_tiled_overscan_composite_is_byte_identical_to_one_whole_target() {
        let stage = Stage::new(
            47,
            31,
            StageOrigin {
                x: 16_777_216.0,
                y: 8_388_608.0,
            },
        )
        .unwrap();
        let whole = TilePlan::new(stage, 64)
            .unwrap()
            .composite_filtered(patterned_source)
            .unwrap();
        let tiled = TilePlan::new(stage, 11)
            .unwrap()
            .composite_filtered(patterned_source)
            .unwrap();

        assert!(TilePlan::new(stage, 11).unwrap().tiles().len() > 1);
        assert_eq!(
            whole.pixels, tiled.pixels,
            "a seam is a wrong byte, not a visual judgement"
        );
    }

    #[test]
    fn every_tile_target_stays_within_the_actual_device_limit() {
        let stage = Stage::new(47, 31, StageOrigin { x: 0.0, y: 0.0 }).unwrap();
        let plan = TilePlan::new(stage, 11).unwrap();

        assert_eq!(plan.texture_limit(), 11);
        assert!(plan.tiles().iter().all(|tile| {
            tile.render_bounds.width <= plan.texture_limit()
                && tile.render_bounds.height <= plan.texture_limit()
        }));
    }

    #[test]
    fn a_distant_stage_point_is_translated_before_narrowing_to_f32() {
        let stage = Stage::new(
            9,
            9,
            StageOrigin {
                x: 16_777_216.0,
                y: 16_777_216.0,
            },
        )
        .unwrap();
        let tile = TilePlan::new(stage, 11).unwrap().tiles()[0];

        assert_eq!(
            tile.local_coordinate(StagePoint {
                x: 16_777_217.5,
                y: 16_777_218.5,
            }),
            Ok([1.5, 2.5])
        );
    }

    #[test]
    fn a_limit_that_cannot_hold_overscan_refuses_by_name() {
        let stage = Stage::new(1, 1, StageOrigin { x: 0.0, y: 0.0 }).unwrap();
        assert!(matches!(
            TilePlan::new(stage, 2),
            Err(TileError::TextureLimitTooSmall {
                actual: 2,
                minimum: 3,
            })
        ));
    }
}
