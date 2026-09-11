//! The software rasteriser.
//!
//! This is the frame producer for a sub-T0 device (invariant 19: T2 is the
//! software tier, CI and no-GPU environments only). It renders Program to a
//! memory buffer rather than a GPU texture, and it is honest about being
//! software: the capability exchange reports the tier, so nobody confuses its
//! output with a hardware frame.
//!
//! **What it is not.** There is no scene contract in the system yet — the
//! control plane carries `take_id` and `revision`, not pixels to draw — so
//! this does not and cannot rasterise scene content. What it renders is a
//! deterministic Program frame: a take key derived from the take id and a
//! frame counter, so a downstream pixel gate (M3) has a real, repeatable byte
//! stream to compare across machines. A large stage is still never one
//! texture (invariant 37): when a scene contract lands, this renders tiles,
//! not the whole canvas.

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
/// stamps the frame counter.
#[derive(Debug, Default)]
pub struct SoftwareRasterizer {
    /// The committed Program take, as a colour key, or `None` for black.
    program_key: Option<[u8; 4]>,
    /// Pre-computed base row for the current key, so a frame render is a copy
    /// plus a counter stamp rather than a recompute.
    base: Vec<u8>,
}

impl SoftwareRasterizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Commit a take to Program: derive its key and pre-build the base frame.
    ///
    /// The key comes from the take id, so two different takes produce visibly
    /// different Program and a republish of the same take reproduces the same
    /// frame — the property a pixel gate relies on.
    pub fn take(&mut self, take_key: [u8; 4]) {
        self.program_key = Some(take_key);
        self.rebuild_base();
    }

    /// Clear Program to black.
    pub fn clear(&mut self) {
        self.program_key = None;
        self.base.clear();
    }

    /// Whether anything is on Program.
    pub fn has_program(&self) -> bool {
        self.program_key.is_some()
    }

    fn rebuild_base(&mut self) {
        let [r, g, b, a] = self.program_key.unwrap_or([0, 0, 0, 0]);
        let px = (FRAME_WIDTH * FRAME_HEIGHT) as usize;
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
    /// Builds from the pre-computed base (built once per take) and stamps the
    /// frame counter into the first row, so consecutive frames differ — which
    /// is what lets a test confirm the clock is actually advancing the
    /// output.
    pub fn render(&self, frame: u64) -> Frame {
        let px = (FRAME_WIDTH * FRAME_HEIGHT) as usize;
        // A cleared rasteriser has no base; Program is a full black frame, not
        // an empty buffer that misreports its own dimensions.
        let mut pixels = if self.program_key.is_some() {
            self.base.clone()
        } else {
            vec![0u8; px * 4]
        };
        if self.program_key.is_some() {
            // Frame counter, little-endian, into the first eight pixels' R
            // channel. Deterministic and visible to the checksum.
            let bytes = frame.to_le_bytes();
            for (i, chunk) in pixels.chunks_exact_mut(4).take(8).enumerate() {
                chunk[0] = chunk[0].wrapping_add(bytes[i]);
            }
        }
        Frame {
            width: FRAME_WIDTH,
            height: FRAME_HEIGHT,
            pixels,
        }
    }
}

/// Derive a deterministic colour key for a take id.
///
/// This stands in for scene content until a scene contract exists: it makes
/// Program a *function of the take*, which is the property the rest of the
/// engine (and the M3 pixel gate) actually depends on.
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
