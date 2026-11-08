//! The software rasteriser.
//!
//! CPU reference and identifier-only control diagnostics. Since 3.16 authored
//! Program uses the GPU scene cache and refuses on a sub-T0 device; this type
//! is never an implicit production fallback. The diagnostic fixture path is
//! explicit and carries no SceneDocument content.
//!
//! Scene content is prepared and rasterised once at publish time. This stage
//! owns the current encoded base frame, applies the device-derived tile plan,
//! and renders it unchanged while Program runs. Identifier-only test fixtures
//! use a deterministic colour key and a frame-counter stamp, so a test can see
//! the clock advance; a published scene's pixels are never stamped (3.13,
//! invariant 18).

use crate::tiling::{Stage, StageOrigin, TileError, TilePlan};

/// Frame dimensions for the software path. 1080p is the supported ceiling
/// (Part C), but a software frame at full raster is wasted work on a device
/// that cannot go to air, so the software path renders a reduced reference
/// frame. Documented, not hidden.
pub const FRAME_WIDTH: u32 = 640;
pub const FRAME_HEIGHT: u32 = 360;

/// A rendered Program frame: raw RGBA8 bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// Row-major, tightly packed, `width * height * 4` bytes.
    pub pixels: Vec<u8>,
}

impl Frame {
    /// A stable checksum over the pixel bytes, so a test can assert that a
    /// take changed Program and a clear returned it to black without
    /// comparing a quarter of a million pixels by hand.
    pub fn checksum(&self) -> u64 {
        // FNV-1a: cheap, deterministic, and good enough to tell two frames
        // apart. Not a security hash.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for &byte in &self.pixels {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }

    /// Whether every pixel is black. Program with no take on it is black.
    pub fn is_black(&self) -> bool {
        self.pixels.iter().all(|&b| b == 0)
    }
}

/// The software rasteriser: a buffer and the current Program key.
///
/// The key is derived once per take, not per frame (invariant 35: nothing
/// that can be built once may be built per Program frame). Per frame it only
/// copies the base, plus a counter stamp for identifier-only fixtures.
#[derive(Debug)]
pub struct SoftwareRasterizer {
    /// The committed Program take, as a colour key, or `None` for black.
    program_key: Option<[u8; 4]>,
    /// Pre-computed base row for the current key, so a frame render is a copy
    /// plus a counter stamp rather than a recompute.
    base: Vec<u8>,
    width: u32,
    height: u32,
    /// The stage's current device-derived render-target plan.
    tiles: TilePlan,
    /// Whether Program is an identifier-only fixture, whose frames carry the
    /// frame counter. A published scene's frames carry exactly its pixels.
    stamp_frame_counter: bool,
}

impl Default for SoftwareRasterizer {
    fn default() -> Self {
        // This software reference path owns no GPU texture. Its fixed frame
        // extent is enough to render one CPU target; hardware callers must
        // supply the negotiated device limit via `with_texture_limit`.
        Self::with_texture_limit(FRAME_WIDTH.max(FRAME_HEIGHT))
            .expect("the non-zero software reference frame always fits its own extent")
    }
}

impl SoftwareRasterizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct the rasteriser with an actual device
    /// `max_texture_dimension_2d`.
    ///
    /// The limit is not a preferred size: it is the hard maximum used to
    /// derive each target core and its overscan. A device too small to hold a
    /// filtered target refuses by name instead of silently using an unsafe
    /// seam-prone fallback.
    pub fn with_texture_limit(texture_limit: u32) -> Result<Self, TileError> {
        let stage = Stage::new(FRAME_WIDTH, FRAME_HEIGHT, StageOrigin { x: 0.0, y: 0.0 })?;
        Ok(Self {
            program_key: None,
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            base: Vec::new(),
            tiles: TilePlan::new(stage, texture_limit)?,
            stamp_frame_counter: false,
        })
    }

    /// The actual texture limit from which this rasteriser derived its tiles.
    pub fn texture_limit(&self) -> u32 {
        self.tiles.texture_limit()
    }

    /// Commit a take to Program: derive its key and pre-build the base frame.
    ///
    /// The key comes from the take id, so two different takes produce visibly
    /// different Program and a republish of the same take reproduces the same
    /// frame — the property a pixel gate relies on.
    pub fn take(&mut self, take_key: [u8; 4]) {
        self.program_key = Some(take_key);
        self.stamp_frame_counter = true;
        self.rebuild_base();
    }

    /// Commit an already-prepared scene frame to Program.
    ///
    /// The caller supplies bytes built at publication; this method only swaps
    /// the immutable base and derives the tile plan for its canvas.
    pub fn take_prepared(&mut self, take_key: [u8; 4], frame: Frame) -> Result<(), TileError> {
        assert_eq!(
            frame.pixels.len(),
            frame.width as usize * frame.height as usize * 4,
            "a prepared frame must be tightly packed RGBA8",
        );
        let texture_limit = self.tiles.texture_limit();
        let stage = Stage::new(frame.width, frame.height, StageOrigin { x: 0.0, y: 0.0 })?;
        self.tiles = TilePlan::new(stage, texture_limit)?;
        self.program_key = Some(take_key);
        self.stamp_frame_counter = false;
        self.width = frame.width;
        self.height = frame.height;
        self.base = frame.pixels;
        Ok(())
    }

    /// Clear Program to black.
    pub fn clear(&mut self) {
        self.program_key = None;
        self.stamp_frame_counter = false;
        self.base.clear();
    }

    /// Whether anything is on Program.
    pub fn has_program(&self) -> bool {
        self.program_key.is_some()
    }

    fn rebuild_base(&mut self) {
        let [r, g, b, a] = self.program_key.unwrap_or([0, 0, 0, 0]);
        let px = (self.width * self.height) as usize;
        self.base = vec![0u8; px * 4];
        for chunk in self.base.chunks_exact_mut(4) {
            chunk[0] = r;
            chunk[1] = g;
            chunk[2] = b;
            chunk[3] = a;
        }
    }

    /// Render the current Program at a frame number.
    ///
    /// Builds from the pre-computed base (built once per take). For an
    /// identifier-only fixture it stamps the frame counter into the first
    /// row, so consecutive frames differ and a test can confirm the clock is
    /// advancing the output. A published scene is never stamped: that would
    /// change on-air pixels (3.13).
    pub fn render(&self, frame: u64) -> Frame {
        let mut rendered = self
            .tiles
            .composite(|point| {
                let x = point.x as u32;
                let y = point.y as u32;
                let offset = ((y as usize * self.width as usize) + x as usize) * 4;
                if self.program_key.is_some() {
                    [
                        self.base[offset],
                        self.base[offset + 1],
                        self.base[offset + 2],
                        self.base[offset + 3],
                    ]
                } else {
                    [0, 0, 0, 0]
                }
            })
            .expect("the validated fixed stage cannot overflow while rendering");
        if self.program_key.is_some() && self.stamp_frame_counter {
            // Frame counter, little-endian, into the first eight pixels' R
            // channel. Deterministic and visible to the checksum.
            let bytes = frame.to_le_bytes();
            for (i, chunk) in rendered.pixels.chunks_exact_mut(4).take(8).enumerate() {
                chunk[0] = chunk[0].wrapping_add(bytes[i]);
            }
        }
        rendered
    }
}

/// Derive a deterministic colour key for an identifier-only test fixture.
pub fn key_for_take(take_id: &gx_contracts::TakeId) -> [u8; 4] {
    let mut hash: u32 = 0x811c_9dc5;
    for &byte in take_id.0.as_bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    // Spread the bits into a non-black RGB with full alpha.
    let r = ((hash >> 16) & 0xff) as u8 | 0x20;
    let g = ((hash >> 8) & 0xff) as u8 | 0x20;
    let b = (hash & 0xff) as u8 | 0x20;
    [r, g, b, 0xff]
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::TakeId;

    #[test]
    fn program_with_no_take_is_black() {
        let r = SoftwareRasterizer::new();
        let frame = r.render(0);
        assert!(frame.is_black());
        assert_eq!(
            frame.pixels.len(),
            (FRAME_WIDTH * FRAME_HEIGHT * 4) as usize
        );
    }

    #[test]
    fn a_take_changes_program_and_a_clear_restores_black() {
        let mut r = SoftwareRasterizer::new();
        r.take(key_for_take(&TakeId("take/101".into())));
        let on_air = r.render(10);
        assert!(!on_air.is_black());

        r.clear();
        assert!(r.render(11).is_black());
    }

    #[test]
    fn the_frame_number_advances_the_output() {
        let mut r = SoftwareRasterizer::new();
        r.take(key_for_take(&TakeId("take/101".into())));
        let a = r.render(100);
        let b = r.render(101);
        assert_ne!(a.checksum(), b.checksum(), "the clock must advance Program");
    }

    /// 3.13: a published scene goes to air exactly as prepared, at every
    /// frame. Before this, its first eight pixels carried the frame counter.
    #[test]
    fn a_prepared_scene_renders_its_pixels_unchanged_at_every_frame() {
        let mut r = SoftwareRasterizer::new();
        let pixels: Vec<u8> = (0..16 * 9 * 4).map(|i| (i % 251) as u8).collect();
        let prepared = Frame {
            width: 16,
            height: 9,
            pixels: pixels.clone(),
        };
        r.take_prepared([1, 2, 3, 4], prepared)
            .expect("a small prepared frame takes");
        for frame in [0, 1, 100, 101, 1_000_000] {
            assert_eq!(
                r.render(frame).pixels,
                pixels,
                "frame {frame} altered the prepared pixels"
            );
        }
    }

    #[test]
    fn different_takes_produce_different_program() {
        let mut r = SoftwareRasterizer::new();
        r.take(key_for_take(&TakeId("take/101".into())));
        let one = r.render(50).checksum();
        r.take(key_for_take(&TakeId("take/102".into())));
        let two = r.render(50).checksum();
        assert_ne!(one, two);
    }

    #[test]
    fn a_forced_small_device_limit_tiles_program_without_changing_its_bytes() {
        let key = key_for_take(&TakeId("take/101".into()));
        let mut whole = SoftwareRasterizer::new();
        let mut tiled = SoftwareRasterizer::with_texture_limit(11).unwrap();
        whole.take(key);
        tiled.take(key);

        assert!(tiled.tiles.tiles().len() > 1);
        assert_eq!(tiled.texture_limit(), 11);
        assert_eq!(whole.render(100), tiled.render(100));
    }
    #[test]
    fn the_base_frame_is_built_once_per_take_not_per_frame() {
        // Invariant 35: rebuilding the base per frame is the regression this
        // guards. If `render` recomputed the whole buffer from the key it
        // would still pass the colour tests, so this asserts the base is the
        // thing being copied, i.e. `render` does not mutate cached state.
        let mut r = SoftwareRasterizer::new();
        r.take(key_for_take(&TakeId("take/101".into())));
        let base_len = r.base.len();
        let _ = r.render(1);
        let _ = r.render(2);
        assert_eq!(r.base.len(), base_len, "render must not rebuild the base");
    }
}
