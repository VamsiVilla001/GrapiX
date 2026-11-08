//! GPU output encode and the bounded asynchronous readback ring (3.21).
//!
//! Frames leave the GPU through the 3.15 output transforms with exactly one
//! quantisation: an output pass converts the composited working-space tiles
//! to Program (Rec.709) and Preview (sRGB) RGBA8 on the GPU, and only those
//! bytes are read back. The CPU colour authority still defines every code
//! value: [`OutputTables`] holds, per output, the smallest f32 straight value
//! that reaches each code, computed from [`WorkingRgba::encode`] itself, so the
//! GPU result is byte-identical to the CPU encode (`output.wgsl` explains the
//! exact rounding). Pipelines, tables, output buffers and every ring slot are
//! built at prepare (invariant 35). The frame path encodes commands, copies
//! into an idle slot and returns; it never waits on the GPU. A full ring
//! refuses the frame's readback instead of stalling, and that is counted.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gx_contracts::color::{OutputTransform, WorkingColorSpace};

use super::{CompositorError, TileResources};
use crate::colour_pipeline::WorkingRgba;
use crate::rasterizer::Frame;
use crate::tiling::Stage;

/// Ring slots. Three gives one frame being written by the GPU, one in
/// transfer and one being collected, without the frame loop waiting.
pub const RING_SLOTS: usize = 3;

const IDLE: u8 = 0;
const IN_FLIGHT: u8 = 1;
const READY: u8 = 2;
const FAILED: u8 = 3;

/// Per-output code thresholds for one working space. Entry `k` (1..=255) is
/// the bit pattern of the smallest non-negative f32 whose code is at least
/// `k`; entry 0 is unused. Layout matches `output.wgsl`: Program RGB, Preview
/// RGB, then alpha.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputTables {
    pub words: [u32; 768],
}

impl OutputTables {
    pub fn new(space: WorkingColorSpace) -> Self {
        let mut words = [0u32; 768];
        let program = |x: f32| straight_code(x, OutputTransform::Rec709, space);
        let preview = |x: f32| straight_code(x, OutputTransform::Srgb, space);
        let alpha = |x: f32| {
            WorkingRgba {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: x,
            }
            .encode(OutputTransform::Srgb, space)[3]
        };
        fill(&mut words[0..256], program);
        fill(&mut words[256..512], preview);
        fill(&mut words[512..768], alpha);
        Self { words }
    }

    fn bytes(&self) -> Vec<u8> {
        self.words.iter().flat_map(|w| w.to_le_bytes()).collect()
    }
}

/// The code the CPU authority gives one straight (unpremultiplied) channel.
fn straight_code(x: f32, output: OutputTransform, space: WorkingColorSpace) -> u8 {
    WorkingRgba {
        r: x,
        g: x,
        b: x,
        a: 1.0,
    }
    .encode(output, space)[0]
}

fn fill(table: &mut [u32], code: impl Fn(f32) -> u8) {
    assert_eq!(code(0.0), 0, "an output must encode zero as code 0");
    for (k, entry) in table.iter_mut().enumerate().skip(1) {
        // Codes are monotone in the bit pattern of a non-negative f32.
        let (mut lo, mut hi) = (0u32, 0x7f80_0000u32);
        assert!(
            code(f32::from_bits(hi - 1)) as usize >= k,
            "code {k} is unreachable"
        );
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if code(f32::from_bits(mid)) as usize >= k {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        *entry = lo;
    }
}

/// CPU twin of `output.wgsl`'s exact rule: does the correctly rounded f32
/// quotient `r / a` reach threshold `t`? Integer arithmetic only, so tests can
/// check the GPU algorithm against `WorkingRgba::encode` on the CPU as well.
pub fn quotient_reaches(r_bits: u32, a_bits: u32, t: u32) -> bool {
    const EXP: u32 = 0x7f80_0000;
    let (ur, ua) = (r_bits & 0x7fff_ffff, a_bits & 0x7fff_ffff);
    if ur > EXP || ua > EXP || ur == 0 || (r_bits >> 31) != (a_bits >> 31) || ua == EXP {
        return false;
    }
    if ur == EXP || ua == 0 {
        return true;
    }
    let decompose = |bits: u32| -> (u64, i32) {
        let raw = (bits >> 23) & 0xff;
        let frac = u64::from(bits & 0x007f_ffff);
        if raw == 0 {
            (frac, -149)
        } else {
            (frac | 0x0080_0000, raw as i32 - 150)
        }
    };
    let (mr, er) = decompose(ur);
    let (ma, ea) = decompose(ua);
    let (mt, et) = decompose(t);
    let (mp, ep) = decompose(t - 1);
    let e0 = et.min(ep);
    let s = (mp << (ep - e0)) + (mt << (et - e0));
    let y = u128::from(s * ma);
    let d = (er + 1) - (e0 + ea);
    let order = if d >= 0 {
        (u128::from(mr) << d).cmp(&y)
    } else {
        u128::from(mr).cmp(&(y << -d))
    };
    match order {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => t & 1 == 0,
    }
}

/// CPU twin of `output.wgsl`'s `channel_code`, for tests.
pub fn channel_code(table: &[u32], r: f32, a: f32) -> u8 {
    if a.to_bits() & 0x7fff_ffff == 0 {
        return 0;
    }
    let x = r / a;
    let mut code = table[1..]
        .iter()
        .take_while(|&&t| x >= f32::from_bits(t))
        .count();
    while code < 255 && quotient_reaches(r.to_bits(), a.to_bits(), table[code + 1]) {
        code += 1;
    }
    while code > 0 && !quotient_reaches(r.to_bits(), a.to_bits(), table[code]) {
        code -= 1;
    }
    code as u8
}

/// A frame the ring has delivered: the engine frame it was submitted for,
/// both encoded surfaces and how long its readback took.
pub struct Delivered {
    pub tag: u64,
    pub program: Frame,
    pub preview: Frame,
    pub latency: Duration,
}

/// Outcome of handing a composited frame to the ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Submitted {
    Queued,
    /// Every slot was still in flight. The frame was composited but not read
    /// back; nothing waited.
    RingFull,
}

struct Slot {
    // Program bytes, then Preview bytes: one mapping per frame.
    staging: wgpu::Buffer,
    state: Arc<AtomicU8>,
    tag: u64,
    submitted_at: Instant,
}

struct TileEncode {
    group: wgpu::BindGroup,
    dispatch: [u32; 2],
}

/// Prepared output stage for one compositor: built once, reused per frame.
pub struct OutputRing {
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
    bytes: u64,
    pipeline: wgpu::ComputePipeline,
    tiles: Vec<TileEncode>,
    program_out: wgpu::Buffer,
    preview_out: wgpu::Buffer,
    slots: Vec<Slot>,
    next: usize,
    pending: VecDeque<usize>,
    ring_full: u64,
    superseded: u64,
    // Recycled frame allocations. A fresh 8 to 33 MB Vec per frame is paged
    // in by the OS on first touch, which costs more than the copy itself;
    // reusing resident allocations keeps the copy at memory speed.
    pool: Vec<Vec<u8>>,
}

impl OutputRing {
    pub(super) fn prepare(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        stage: Stage,
        space: WorkingColorSpace,
        tiles: &[TileResources],
        final_target: usize,
    ) -> Result<Self, CompositorError> {
        let bytes = u64::from(stage.width) * u64::from(stage.height) * 4;
        let limits = device.limits();
        if bytes > limits.max_storage_buffer_binding_size || bytes * 2 > limits.max_buffer_size {
            return Err(CompositorError::ResourceLimit(format!(
                "a {}x{} output surface needs {bytes} bytes; the device binds at most {} \
                 (max_storage_buffer_binding_size)",
                stage.width, stage.height, limits.max_storage_buffer_binding_size
            )));
        }
        crate::render_work::gpu_build();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gx-output"),
            source: wgpu::ShaderSource::Wgsl(include_str!("output.wgsl").into()),
        });
        let storage = |binding, read_only| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        crate::render_work::gpu_build();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gx-output"),
            entries: &[
                super::sampled_entry(0),
                storage(1, true),
                storage(2, false),
                storage(3, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(32),
                    },
                    count: None,
                },
            ],
        });
        crate::render_work::gpu_build();
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gx-output"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        crate::render_work::gpu_build();
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("encode"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("encode"),
            compilation_options: Default::default(),
            cache: None,
        });
        use wgpu::util::DeviceExt;
        crate::render_work::gpu_build();
        let tables = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gx-output-tables"),
            contents: &OutputTables::new(space).bytes(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let surface = |label| {
            crate::render_work::gpu_build();
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let program_out = surface("gx-output-program");
        let preview_out = surface("gx-output-preview");
        let tiles = tiles
            .iter()
            .map(|t| {
                let core = t.tile.core;
                let bounds = t.tile.render_bounds;
                let words = [
                    core.x,
                    core.y,
                    core.width,
                    core.height,
                    core.x - bounds.x,
                    core.y - bounds.y,
                    stage.width,
                    0,
                ];
                let uniform_bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
                crate::render_work::gpu_build();
                let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("gx-output-tile"),
                    contents: &uniform_bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                crate::render_work::gpu_build();
                let view = t.targets[final_target].create_view(&Default::default());
                crate::render_work::gpu_build();
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("gx-output"),
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: tables.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: program_out.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: preview_out.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: uniform.as_entire_binding(),
                        },
                    ],
                });
                TileEncode {
                    group,
                    dispatch: [core.width.div_ceil(16), core.height.div_ceil(16)],
                }
            })
            .collect();
        let staging = |label| {
            crate::render_work::gpu_build();
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: bytes * 2,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let slots = (0..RING_SLOTS)
            .map(|_| Slot {
                staging: staging("gx-output-ring"),
                state: Arc::new(AtomicU8::new(IDLE)),
                tag: 0,
                submitted_at: Instant::now(),
            })
            .collect();
        Ok(Self {
            device: device.clone(),
            queue: queue.clone(),
            width: stage.width,
            height: stage.height,
            bytes,
            pipeline,
            tiles,
            program_out,
            preview_out,
            slots,
            next: 0,
            pending: VecDeque::with_capacity(RING_SLOTS),
            ring_full: 0,
            superseded: 0,
            pool: Vec::new(),
        })
    }

    /// Whether the next slot can take a frame now. Checked before the
    /// composite is submitted, so GPU work is bounded by the ring depth: a
    /// frame the ring cannot read back is not drawn either.
    pub fn has_idle_slot(&mut self) -> bool {
        self.reap();
        self.slots[self.next].state.load(Ordering::Acquire) == IDLE
    }

    /// Count a frame refused before compositing because no slot was idle.
    pub fn note_ring_full(&mut self) {
        self.ring_full += 1;
    }

    /// Encode the composited frame and queue its readback into an idle slot.
    /// Never waits: with no idle slot the frame is not read back.
    pub fn submit(&mut self, tag: u64) -> Submitted {
        self.reap();
        let index = self.next;
        if self.slots[index].state.load(Ordering::Acquire) != IDLE {
            self.ring_full += 1;
            return Submitted::RingFull;
        }
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gx-output-frame"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gx-output-encode"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            for tile in &self.tiles {
                pass.set_bind_group(0, &tile.group, &[]);
                pass.dispatch_workgroups(tile.dispatch[0], tile.dispatch[1], 1);
            }
        }
        let slot = &mut self.slots[index];
        encoder.copy_buffer_to_buffer(&self.program_out, 0, &slot.staging, 0, self.bytes);
        encoder.copy_buffer_to_buffer(&self.preview_out, 0, &slot.staging, self.bytes, self.bytes);
        self.queue.submit([encoder.finish()]);
        crate::render_work::gpu_output_dispatch(self.tiles.len());
        slot.state.store(IN_FLIGHT, Ordering::Release);
        slot.tag = tag;
        slot.submitted_at = Instant::now();
        let state = Arc::clone(&slot.state);
        slot.staging
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                state.store(
                    if result.is_ok() { READY } else { FAILED },
                    Ordering::Release,
                );
            });
        self.pending.push_back(index);
        self.next = (index + 1) % self.slots.len();
        Submitted::Queued
    }

    /// Advance mapping callbacks without blocking.
    fn reap(&mut self) {
        let _ = self.device.poll(wgpu::PollType::Poll);
    }

    /// The newest delivered frame, if any completed since the last call.
    /// Older completed frames are superseded and counted, never queued up.
    pub fn collect(&mut self) -> Result<Option<Delivered>, CompositorError> {
        self.reap();
        let mut newest = None;
        while let Some(&index) = self.pending.front() {
            match self.slots[index].state.load(Ordering::Acquire) {
                READY => {
                    self.pending.pop_front();
                    if newest.is_some() {
                        self.superseded += 1;
                    }
                    newest = Some(self.read(index)?);
                }
                FAILED => {
                    self.pending.pop_front();
                    self.release(index);
                    return Err(CompositorError::Readback(
                        "an output readback mapping failed".into(),
                    ));
                }
                _ => break,
            }
        }
        Ok(newest)
    }

    /// Wait, up to `deadline`, for the frame submitted with `tag`. Only for
    /// callers outside the live frame loop (tests, synchronous renders).
    pub fn wait_for(&mut self, tag: u64, deadline: Duration) -> Result<Delivered, CompositorError> {
        let started = Instant::now();
        loop {
            let _ = self.device.poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_millis(50)),
            });
            while let Some(&index) = self.pending.front() {
                match self.slots[index].state.load(Ordering::Acquire) {
                    READY => {
                        self.pending.pop_front();
                        let delivered = self.read(index)?;
                        if delivered.tag == tag {
                            return Ok(delivered);
                        }
                    }
                    FAILED => {
                        self.pending.pop_front();
                        self.release(index);
                        return Err(CompositorError::Readback(
                            "an output readback mapping failed".into(),
                        ));
                    }
                    _ => break,
                }
            }
            if self.pending.is_empty() {
                return Err(CompositorError::Readback(format!(
                    "frame {tag} was never submitted"
                )));
            }
            if started.elapsed() > deadline {
                return Err(CompositorError::Readback(format!(
                    "frame {tag} not read back within {deadline:?}"
                )));
            }
        }
    }

    /// Wait, up to `deadline`, until the next slot is idle, discarding the
    /// frames in flight. Only for callers outside the live frame loop.
    pub fn wait_for_idle(&mut self, deadline: Duration) -> Result<(), CompositorError> {
        let started = Instant::now();
        while self.slots[self.next].state.load(Ordering::Acquire) != IDLE {
            let _ = self.device.poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_millis(50)),
            });
            self.collect()?;
            if started.elapsed() > deadline {
                return Err(CompositorError::Readback(format!(
                    "no readback slot idle within {deadline:?}"
                )));
            }
        }
        Ok(())
    }

    /// Return a frame allocation of this ring's frame size for reuse.
    pub fn recycle(&mut self, pixels: Vec<u8>) {
        // Kept at full length: the pages stay resident and the next copy
        // writes straight into them with no zeroing.
        if pixels.len() == self.bytes as usize && self.pool.len() < 2 * RING_SLOTS {
            self.pool.push(pixels);
        }
    }

    fn read(&mut self, index: usize) -> Result<Delivered, CompositorError> {
        let split = self.bytes as usize;
        let mut program = self.pool.pop().unwrap_or_else(|| vec![0; split]);
        let mut preview = self.pool.pop().unwrap_or_else(|| vec![0; split]);
        let slot = &self.slots[index];
        let result = slot
            .staging
            .slice(..)
            .get_mapped_range()
            .map_err(|e| CompositorError::Readback(e.to_string()))
            .map(|view| {
                copy_parallel(&view[..split], &mut program);
                copy_parallel(&view[split..], &mut preview);
                debug_assert_eq!(program.len(), split);
                Delivered {
                    tag: slot.tag,
                    program: Frame {
                        width: self.width,
                        height: self.height,
                        pixels: program,
                    },
                    preview: Frame {
                        width: self.width,
                        height: self.height,
                        pixels: preview,
                    },
                    latency: slot.submitted_at.elapsed(),
                }
            });
        self.release(index);
        result
    }

    fn release(&mut self, index: usize) {
        let slot = &self.slots[index];
        slot.staging.unmap();
        slot.state.store(IDLE, Ordering::Release);
    }

    /// Frames whose readback was refused because every slot was in flight.
    pub fn ring_full(&self) -> u64 {
        self.ring_full
    }

    /// Completed frames replaced by a newer one before they were collected.
    pub fn superseded(&self) -> u64 {
        self.superseded
    }
}

/// Copy a mapped surface into a resident, full-length Vec on several
/// threads. Reading from readback memory is bandwidth-bound per core; four
/// readers move a 2160p surface in a few milliseconds where one takes about
/// ten.
fn copy_parallel(src: &[u8], dst: &mut [u8]) {
    const CHUNKS: usize = 4;
    debug_assert_eq!(src.len(), dst.len());
    let chunk = src.len().div_ceil(CHUNKS).max(1);
    std::thread::scope(|scope| {
        for (s, d) in src.chunks(chunk).zip(dst.chunks_mut(chunk)) {
            scope.spawn(move || d.copy_from_slice(s));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spaces() -> [WorkingColorSpace; 2] {
        [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb]
    }

    /// Small deterministic generator: no new dependency for a test.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 32) as u32
        }
        fn unit(&mut self) -> f32 {
            self.next() as f32 / u32::MAX as f32
        }
    }

    #[test]
    fn every_threshold_is_the_first_value_that_reaches_its_code() {
        for space in spaces() {
            let tables = OutputTables::new(space);
            for (base, output) in [(0, OutputTransform::Rec709), (256, OutputTransform::Srgb)] {
                for k in 1..256usize {
                    let t = tables.words[base + k];
                    assert!(straight_code(f32::from_bits(t), output, space) as usize >= k);
                    assert!((straight_code(f32::from_bits(t - 1), output, space) as usize) < k);
                }
            }
        }
    }

    /// The integer rule equals the CPU encode for premultiplied pixels,
    /// including values placed exactly on and beside every threshold.
    #[test]
    fn the_exact_rule_matches_the_cpu_encode() {
        let mut rng = Lcg(0x5eed);
        for space in spaces() {
            let tables = OutputTables::new(space);
            let mut cases: Vec<(f32, f32)> = (0..200_000)
                .map(|_| {
                    let a = rng.unit();
                    (rng.unit() * a, a)
                })
                .collect();
            // Straight values on and around each threshold, at many alphas.
            for &t in &tables.words[1..256] {
                for delta in [-2i64, -1, 0, 1, 2] {
                    let x = f32::from_bits((i64::from(t) + delta) as u32);
                    for a in [1.0f32, 0.5, 0.25, 0.75, 0.3, 0.9, 1.0 / 3.0, 0.01] {
                        cases.push((x * a, a));
                    }
                }
            }
            cases.extend([
                (0.0, 0.0),
                (0.2, 0.0),
                (-0.0, 0.5),
                (-0.1, 0.5),
                (0.5, 0.25),
                (1.0, 1.0),
                (f32::NAN, 1.0),
            ]);
            for (r, a) in cases {
                let pixel = WorkingRgba { r, g: r, b: r, a };
                for (base, output) in [
                    (0usize, OutputTransform::Rec709),
                    (256, OutputTransform::Srgb),
                ] {
                    let expected = pixel.encode(output, space)[0];
                    let got = channel_code(&tables.words[base..base + 256], r, a);
                    assert_eq!(got, expected, "{space:?} {output:?} r={r:e} a={a:e}");
                }
            }
        }
    }
}
