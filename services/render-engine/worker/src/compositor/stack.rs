//! Several scenes in one frame (task 112, rows 12.10 and 12.13).
//!
//! Each scene on air has its own GPU compositor and its own working-space tiles. A [`LayerStack`] puts them in one picture the way a
//! single scene puts its layers together: low to high, in the working space, premultiplied, BEFORE the output encode, so the colour
//! is made once and quantised once (invariant 35: everything is built at prepare, nothing is allocated per frame except the bind
//! groups that name the scenes' textures, which change with the layers on air).
//!
//! The stack knows nothing about scenes, takes, phases or layer numbers. It is given tiles lowest first: [`LayerStack::begin`], then
//! [`LayerStack::add`] for each, then [`LayerStack::submit`], which encodes the result through its own output ring.
//!
//! **Every scene on the stack has the stack's stage** (the same canvas size, so the same tiles). A different size is refused by the
//! caller by name before it gets here; `add` refuses it again so a mismatch can never composite out of place.

use std::time::Duration;

use gx_contracts::color::{ColorDepth, WorkingColorSpace};

use super::output::{Delivered, OutputRing, Submitted};
use super::{sampled_entry, CompositorError};
use crate::tiling::{Stage, Tile};

/// One tile of the stack: the textures the passes ping-pong between, and the one the output ring reads.
struct StackTile {
    tile: Tile,
    accum: [wgpu::Texture; 2],
    result: wgpu::Texture,
    /// The pass parameters for the lowest scene (nothing below it) and for every other.
    first: wgpu::Buffer,
    rest: wgpu::Buffer,
}

pub struct LayerStack {
    device: wgpu::Device,
    queue: wgpu::Queue,
    stage: Stage,
    working_space: WorkingColorSpace,
    depth: ColorDepth,
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    tiles: Vec<StackTile>,
    ring: OutputRing,
    /// Which accumulation texture holds what has been composited so far, and how many scenes that is.
    current: Option<usize>,
    added: usize,
}

fn texture(device: &wgpu::Device, tile: Tile, usage: wgpu::TextureUsages) -> wgpu::Texture {
    crate::render_work::gpu_build();
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("gx-stack"),
        size: wgpu::Extent3d {
            width: tile.render_bounds.width,
            height: tile.render_bounds.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Float,
        usage,
        view_formats: &[],
    })
}

impl LayerStack {
    /// Build the stack for a stage, from the tile plan every scene of that size shares.
    pub fn prepare(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        stage: Stage,
        working_space: WorkingColorSpace,
        depth: ColorDepth,
        tiles: &[Tile],
    ) -> Result<Self, CompositorError> {
        use wgpu::util::DeviceExt;
        crate::render_work::gpu_build();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gx-stack"),
            source: wgpu::ShaderSource::Wgsl(include_str!("stack.wgsl").into()),
        });
        crate::render_work::gpu_build();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gx-stack"),
            entries: &[
                sampled_entry(0),
                sampled_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba32Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(16),
                    },
                    count: None,
                },
            ],
        });
        crate::render_work::gpu_build();
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gx-stack"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        crate::render_work::gpu_build();
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("over"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("over"),
            compilation_options: Default::default(),
            cache: None,
        });
        let levels = depth.levels().map_or(0.0, |n| n as f32);
        let params = |tile: Tile, has_lower: u32| {
            let mut bytes = Vec::with_capacity(16);
            bytes.extend_from_slice(&tile.render_bounds.width.to_le_bytes());
            bytes.extend_from_slice(&tile.render_bounds.height.to_le_bytes());
            bytes.extend_from_slice(&has_lower.to_le_bytes());
            bytes.extend_from_slice(&levels.to_le_bytes());
            crate::render_work::gpu_build();
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("gx-stack-params"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            })
        };
        let work = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC;
        let stack_tiles: Vec<StackTile> = tiles
            .iter()
            .map(|&tile| StackTile {
                tile,
                accum: [texture(device, tile, work), texture(device, tile, work)],
                // The result is copied into, and read by the output pass.
                result: texture(device, tile, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST),
                first: params(tile, 0),
                rest: params(tile, 1),
            })
            .collect();
        let encode_tiles: Vec<(Tile, wgpu::Texture)> = stack_tiles.iter().map(|t| (t.tile, t.result.clone())).collect();
        let ring = OutputRing::prepare_textures(device, queue, stage, working_space, &encode_tiles)?;
        Ok(Self {
            device: device.clone(),
            queue: queue.clone(),
            stage,
            working_space,
            depth,
            pipeline,
            layout,
            tiles: stack_tiles,
            ring,
            current: None,
            added: 0,
        })
    }

    /// Whether this stack was built for this stage, working space and colour depth.
    pub fn fits(&self, stage: Stage, working_space: WorkingColorSpace, depth: ColorDepth) -> bool {
        self.stage.width == stage.width && self.stage.height == stage.height && self.working_space == working_space && self.depth == depth
    }

    /// The same question by the numbers `GpuScene::stack_key` reports: canvas size, working space and colour depth.
    pub fn fits_key(&self, width: u32, height: u32, working_space: WorkingColorSpace, depth: ColorDepth) -> bool {
        self.stage.width == width && self.stage.height == height && self.working_space == working_space && self.depth == depth
    }

    /// Start a frame: nothing is composited yet.
    pub fn begin(&mut self) {
        self.current = None;
        self.added = 0;
    }

    /// Put one scene's finished tiles over what is composited so far. Scenes are added lowest first. Everything is checked before any
    /// GPU work is recorded, so a refusal leaves the stack exactly as it was.
    pub fn add<'a>(&mut self, scene: impl ExactSizeIterator<Item = (Tile, &'a wgpu::Texture)>) -> Result<(), CompositorError> {
        let scene: Vec<(Tile, &wgpu::Texture)> = scene.collect();
        if scene.len() != self.tiles.len() {
            return Err(CompositorError::Readback(format!(
                "a scene with {} tiles cannot be stacked on a stage of {}",
                scene.len(),
                self.tiles.len()
            )));
        }
        if scene.iter().zip(&self.tiles).any(|((tile, _), mine)| tile.render_bounds != mine.tile.render_bounds) {
            return Err(CompositorError::Readback("a scene's tiles are not the stack's".into()));
        }
        let into = self.current.map_or(0, |held| 1 - held);
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("gx-stack-frame") });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("gx-stack-over"), timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            for ((tile, texture), mine) in scene.into_iter().zip(&self.tiles) {
                let upper = texture.create_view(&Default::default());
                // With nothing below, the lower input is never read; the scene's own texture stands in (it is only sampled, so it can be
                // bound twice, which the pass's own output could not be).
                let lower = match self.current {
                    Some(held) => mine.accum[held].create_view(&Default::default()),
                    None => texture.create_view(&Default::default()),
                };
                let out = mine.accum[into].create_view(&Default::default());
                crate::render_work::gpu_build();
                let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("gx-stack"),
                    layout: &self.layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&upper) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&lower) },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&out) },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: (if self.current.is_some() { &mine.rest } else { &mine.first }).as_entire_binding(),
                        },
                    ],
                });
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(tile.render_bounds.width.div_ceil(16), tile.render_bounds.height.div_ceil(16), 1);
            }
        }
        self.queue.submit([encoder.finish()]);
        self.current = Some(into);
        self.added += 1;
        Ok(())
    }

    /// How many scenes are on this frame so far.
    pub fn added(&self) -> usize {
        self.added
    }

    /// Whether the ring can take a frame now (checked before any scene is drawn, as a single scene's is).
    pub fn has_idle_slot(&mut self) -> bool {
        self.ring.has_idle_slot()
    }

    pub fn note_ring_full(&mut self) {
        self.ring.note_ring_full();
    }

    /// Encode what was composited and queue its readback under `tag`. Never waits.
    pub fn submit(&mut self, tag: u64) -> Result<Submitted, CompositorError> {
        let Some(held) = self.current else {
            return Err(CompositorError::Readback("nothing was composited on the stack".into()));
        };
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("gx-stack-result") });
        for tile in &self.tiles {
            encoder.copy_texture_to_texture(
                tile.accum[held].as_image_copy(),
                tile.result.as_image_copy(),
                wgpu::Extent3d { width: tile.tile.render_bounds.width, height: tile.tile.render_bounds.height, depth_or_array_layers: 1 },
            );
        }
        self.queue.submit([encoder.finish()]);
        Ok(self.ring.submit(tag))
    }

    pub fn collect(&mut self) -> Result<Option<Delivered>, CompositorError> {
        self.ring.collect()
    }

    pub fn recycle(&mut self, pixels: Vec<u8>) {
        self.ring.recycle(pixels);
    }

    pub fn ring_counters(&self) -> (u64, u64) {
        (self.ring.ring_full(), self.ring.superseded())
    }

    /// Wait for the frame submitted with `tag`: for callers outside the live loop (a settled render, a test).
    pub fn wait_for(&mut self, tag: u64, deadline: Duration) -> Result<Delivered, CompositorError> {
        self.ring.wait_for(tag, deadline)
    }

    /// Drain the frames in flight and wait for an idle slot (outside the live loop).
    pub fn drain(&mut self, deadline: Duration) -> Result<(), CompositorError> {
        while self.ring.collect()?.is_some() {}
        self.ring.wait_for_idle(deadline)
    }
}
