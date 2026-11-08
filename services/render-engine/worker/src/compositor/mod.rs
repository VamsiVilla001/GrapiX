//! Prepared GPU layer compositor (3.16).
//!
//! Drawing backends supply premultiplied pixels in the declared working
//! space. This module owns only upload, affine warping, opacity and ordered
//! composition in every contract blend mode (3.20, `crate::blend` and
//! `blend.wgsl`). It does not depend on a 2D or text backend.
//! Pipelines, textures, bind groups, uniforms and diagnostic readback buffers
//! are created at prepare. The frame path updates uniforms and dispatches.
//!
//! `scene` maps pinned scenes and owns the Engine's Program/Preview GPU state.
//! Simple bounded synchronous readback serves 3.16; 3.21's asynchronous ring
//! and timing target remain separate. CPU sources are rasterised at prepare.

use gx_contracts::color::{OutputTransform, WorkingColorSpace};
use gx_contracts::material::BlendMode;
use wgpu::util::DeviceExt;

use crate::colour_pipeline::WorkingRgba;
use crate::gpu::Gpu;
use crate::rasterizer::Frame;
use crate::tiling::{Stage, Tile, TileError, TilePlan};
#[cfg(test)]
mod blend_tests;
#[cfg(test)]
pub(crate) mod effect_tests;
pub mod output;
pub mod scene;

/// An object's placement from local pixel coordinates into f64 stage space:
/// x' = a*x + c*y + tx; y' = b*x + d*y + ty.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayerState {
    pub affine: [f64; 6],
    /// Effective opacity, including ancestors; applied once on the GPU.
    pub opacity: f32,
    /// Dissolve seed for this frame (3.20, `crate::blend::dissolve_seed`);
    /// ignored by every other mode.
    pub seed: u32,
}

impl Default for LayerState {
    fn default() -> Self {
        Self {
            affine: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: 1.0,
            seed: 0,
        }
    }
}

/// A backend-neutral layer. The caller supplies layers in effective scene
/// order across object types. Object identity and document path are retained
/// so an unsupported mapping refuses precisely, rather than dropping a layer.
#[derive(Debug, Clone)]
pub struct LayerInput {
    pub object_id: String,
    pub document_path: String,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<WorkingRgba>,
    pub working_space: WorkingColorSpace,
    pub blend_mode: BlendMode,
    /// The layer's effect stack as a pass plan, packed (3.22). Its passes are
    /// fixed at prepare; a disabled effect packs as identity passes.
    pub effects: Option<crate::effect_chain::EffectPlan>,
    pub state: LayerState,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CompositorError {
    HardwareUnavailable,
    Tile(TileError),
    Mapping {
        object_id: String,
        document_path: String,
        detail: String,
    },
    LayerCount {
        expected: usize,
        actual: usize,
    },
    ResourceLimit(String),
    Readback(String),
}

impl std::fmt::Display for CompositorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HardwareUnavailable => f.write_str("GPU compositor requires a hardware adapter"),
            Self::Tile(error) => write!(f, "GPU compositor tile plan: {error}"),
            Self::Mapping {
                object_id,
                document_path,
                detail,
            } => write!(
                f,
                "GPU mapping refused for {object_id} at {document_path}: {detail}"
            ),
            Self::LayerCount { expected, actual } => write!(
                f,
                "GPU compositor expects {expected} layer states, received {actual}"
            ),
            Self::ResourceLimit(detail) => write!(f, "GPU compositor resource limit: {detail}"),
            Self::Readback(detail) => write!(f, "GPU diagnostic readback: {detail}"),
        }
    }
}

impl std::error::Error for CompositorError {}

impl From<TileError> for CompositorError {
    fn from(error: TileError) -> Self {
        Self::Tile(error)
    }
}

struct Layer {
    object_id: String,
    document_path: String,
    mode: u32,
    view: wgpu::TextureView,
    chain: Option<EffectChain>,
}

/// A layer's effect stack on the GPU, built at prepare (3.22): one step per
/// planned pass, alternating between two layer-sized targets, with a third
/// holding the input a glow or drop shadow combines with; the composite pass
/// samples the last.
struct EffectChain {
    width: u32,
    height: u32,
    steps: Vec<EffectStep>,
    _targets: [wgpu::Texture; 3],
    output: wgpu::TextureView,
}

struct EffectStep {
    line: bool,
    uniform: wgpu::Buffer,
    curve: wgpu::Buffer,
    group: wgpu::BindGroup,
}

/// The two effect entry points over one bind layout.
struct EffectPipelines {
    layout: wgpu::BindGroupLayout,
    pixel: wgpu::ComputePipeline,
    line: wgpu::ComputePipeline,
}

impl Layer {
    /// What the composite pass samples: the effect chain's output, or the
    /// source itself.
    fn sampled(&self) -> &wgpu::TextureView {
        self.chain
            .as_ref()
            .map_or(&self.view, |chain| &chain.output)
    }
}

/// 16 bytes of kind, then eight vec4s of parameters.
const EFFECT_UNIFORM_BYTES: usize = 16 + crate::effects::PARAMS * 4;

fn effect_uniform(effect: &crate::effects::PackedEffect) -> [u8; EFFECT_UNIFORM_BYTES] {
    let mut bytes = [0; EFFECT_UNIFORM_BYTES];
    bytes[..4].copy_from_slice(&effect.kind.to_le_bytes());
    for (value, dest) in effect.params.iter().zip(bytes[16..].chunks_exact_mut(4)) {
        dest.copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn write_curve(bytes: &mut Vec<u8>, effect: &crate::effects::PackedEffect) {
    bytes.clear();
    for value in &effect.curve {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
}

struct TileResources {
    tile: Tile,
    targets: [wgpu::Texture; 2],
    clear: wgpu::BindGroup,
    uniforms: Vec<wgpu::Buffer>,
    groups: Vec<wgpu::BindGroup>,
    readback: wgpu::Buffer,
    padded_row: u32,
}

// Cancellation must unmap a buffer as well: a timed-out diagnostic/Program
// readback may be retried, and must not leave a pending mapping that panics.
struct ReadMapping<'a>(&'a wgpu::Buffer);
impl Drop for ReadMapping<'_> {
    fn drop(&mut self) {
        self.0.unmap();
    }
}

/// Work submitted by the compositor, independent of the source drawing
/// backend. These counts describe dispatches, not GPU timing claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompositeSubmission {
    pub tiles: usize,
    pub layer_dispatches: usize,
    pub uniform_bytes: usize,
}

/// Reusable prepared GPU state. No full-stage texture is allocated. Even an
/// oversized stage owns only bounded tile targets (invariants 35, 37, 38).
pub struct PreparedCompositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    stage: Stage,
    working_space: WorkingColorSpace,
    layers: Vec<Layer>,
    tiles: Vec<TileResources>,
    clear_pipeline: wgpu::ComputePipeline,
    composite_pipeline: wgpu::ComputePipeline,
    effect_pipeline: Option<EffectPipelines>,
    curve_scratch: Vec<u8>,
    // Validate the entire frame before writing any GPU state. Reused scratch
    // keeps matrix construction out of the allocator on the frame path.
    uniform_scratch: Vec<[u8; UNIFORM_BYTES]>,
    submitted: bool,
}

impl PreparedCompositor {
    /// Prepare with the negotiated device limit. Source layer tiling belongs
    /// to its drawing backend; oversized source uploads refuse explicitly.
    pub fn prepare(
        gpu: &Gpu,
        stage: Stage,
        space: WorkingColorSpace,
        inputs: &[LayerInput],
    ) -> Result<Self, CompositorError> {
        let limit = gpu
            .max_texture_dimension_2d()
            .ok_or(CompositorError::HardwareUnavailable)?;
        Self::prepare_with_limit(gpu, stage, space, inputs, limit)
    }

    fn prepare_with_limit(
        gpu: &Gpu,
        stage: Stage,
        space: WorkingColorSpace,
        inputs: &[LayerInput],
        limit: u32,
    ) -> Result<Self, CompositorError> {
        let (device, queue) = gpu
            .device_queue()
            .ok_or(CompositorError::HardwareUnavailable)?;
        Stage::new(stage.width, stage.height, stage.origin)?;
        let plan = TilePlan::new(stage, limit.min(device.limits().max_texture_dimension_2d))?;
        for input in inputs {
            validate_input(input, space, device.limits().max_texture_dimension_2d)?;
        }
        let uniform_count = plan
            .tiles()
            .len()
            .checked_mul(inputs.len())
            .ok_or_else(|| {
                CompositorError::ResourceLimit("tile/layer uniform count overflows".into())
            })?;
        for tile in plan.tiles() {
            let r = tile.render_bounds;
            let row = (u64::from(r.width) * 16).div_ceil(256) * 256;
            if row * u64::from(r.height) > device.limits().max_buffer_size {
                return Err(CompositorError::ResourceLimit(format!(
                    "tile {}x{} diagnostic buffer exceeds device max_buffer_size {}",
                    r.width,
                    r.height,
                    device.limits().max_buffer_size
                )));
            }
        }
        let mut uniform_scratch = Vec::with_capacity(uniform_count);
        for tile in plan.tiles() {
            for input in inputs {
                let geometry = uniforms(stage, *tile, input.state).map_err(|(field, detail)| {
                    mapping(&input.object_id, &input.document_path, field, detail)
                })?;
                let mode = crate::blend::mode_index(input.blend_mode);
                uniform_scratch.push(pack_uniform(&geometry, key(mode, *tile, input.state)));
            }
        }
        crate::render_work::gpu_build();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gx-compositor"),
            source: wgpu::ShaderSource::Wgsl(compositor_shader().into()),
        });
        crate::render_work::gpu_build();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gx-compositor"),
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
                        min_binding_size: wgpu::BufferSize::new(UNIFORM_BYTES as u64),
                    },
                    count: None,
                },
            ],
        });
        crate::render_work::gpu_build();
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gx-compositor"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |entry| {
            crate::render_work::gpu_build();
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(entry),
                layout: Some(&pipeline_layout),
                module: &shader,
                entry_point: Some(entry),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let clear_pipeline = pipeline("clear");
        let composite_pipeline = pipeline("composite");
        // 3.22: one effect pipeline for every layer's steps, built only when
        // some layer has effects.
        let effect_pipeline = inputs
            .iter()
            .any(|input| input.effects.is_some())
            .then(|| effect_pipelines(device));
        let layers: Vec<Layer> = inputs
            .iter()
            .map(|input| {
                let texture = float_texture(
                    device,
                    input.width,
                    input.height,
                    wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                );
                let mut bytes = Vec::with_capacity(input.pixels.len() * 16);
                for p in &input.pixels {
                    for c in [p.r, p.g, p.b, p.a] {
                        bytes.extend_from_slice(&c.to_le_bytes());
                    }
                }
                queue.write_texture(
                    texture.as_image_copy(),
                    &bytes,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(input.width * 16),
                        rows_per_image: Some(input.height),
                    },
                    texture.size(),
                );
                crate::render_work::gpu_build();
                let view = texture.create_view(&Default::default());
                let chain = effect_pipeline
                    .as_ref()
                    .zip(input.effects.as_ref())
                    .map(|(pipelines, plan)| effect_chain(device, pipelines, input, plan, &view));
                Layer {
                    object_id: input.object_id.clone(),
                    document_path: input.document_path.clone(),
                    mode: crate::blend::mode_index(input.blend_mode),
                    view,
                    chain,
                }
            })
            .collect();
        let tiles = plan
            .tiles()
            .iter()
            .enumerate()
            .map(|(tile_index, tile)| {
                let r = tile.render_bounds;
                let targets = std::array::from_fn(|_| {
                    float_texture(
                        device,
                        r.width,
                        r.height,
                        wgpu::TextureUsages::TEXTURE_BINDING
                            | wgpu::TextureUsages::STORAGE_BINDING
                            | wgpu::TextureUsages::COPY_SRC,
                    )
                });
                let views: [wgpu::TextureView; 2] = std::array::from_fn(|i| {
                    crate::render_work::gpu_build();
                    targets[i].create_view(&Default::default())
                });
                let make_uniform = |data: &[u8; UNIFORM_BYTES]| {
                    crate::render_work::gpu_build();
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("gx-compositor-uniform"),
                        contents: data,
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    })
                };
                let clear_uniform = make_uniform(&[0; UNIFORM_BYTES]);
                let group =
                    |src: &wgpu::TextureView, dst: usize, out: usize, uniform: &wgpu::Buffer| {
                        crate::render_work::gpu_build();
                        device.create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("gx-compositor"),
                            layout: &layout,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::TextureView(src),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::TextureView(&views[dst]),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 2,
                                    resource: wgpu::BindingResource::TextureView(&views[out]),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 3,
                                    resource: uniform.as_entire_binding(),
                                },
                            ],
                        })
                    };
                let clear = group(&views[1], 1, 0, &clear_uniform);
                let uniforms: Vec<_> = (0..layers.len())
                    .map(|i| make_uniform(&uniform_scratch[tile_index * layers.len() + i]))
                    .collect();
                let groups = layers
                    .iter()
                    .enumerate()
                    .map(|(i, layer)| group(layer.sampled(), i % 2, (i + 1) % 2, &uniforms[i]))
                    .collect();
                let padded_row = (r.width * 16).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
                    * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
                crate::render_work::gpu_build();
                let readback = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("gx-compositor-diagnostic-readback"),
                    size: u64::from(padded_row) * u64::from(r.height),
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                TileResources {
                    tile: *tile,
                    targets,
                    clear,
                    uniforms,
                    groups,
                    readback,
                    padded_row,
                }
            })
            .collect();
        Ok(Self {
            device: device.clone(),
            queue: queue.clone(),
            stage,
            working_space: space,
            layers,
            tiles,
            clear_pipeline,
            composite_pipeline,
            effect_pipeline,
            curve_scratch: Vec::with_capacity(crate::effects::CURVE_FLOATS * 4),
            uniform_scratch,
            submitted: false,
        })
    }

    /// Submit one frame. All mapping validation precedes writes, so a refused
    /// state leaves the previously rendered frame intact. No resource creation,
    /// source upload, tessellation or CPU pixel loop is reachable here.
    pub fn composite(
        &mut self,
        states: &[LayerState],
    ) -> Result<CompositeSubmission, CompositorError> {
        self.composite_with_effects(states, None)
    }

    /// Submit one frame with this frame's packed effect parameters (3.22):
    /// one entry per layer, each as long as that layer's prepared chain.
    /// `None` keeps the parameters last written.
    pub fn composite_with_effects(
        &mut self,
        states: &[LayerState],
        effects: Option<&[Option<crate::effect_chain::EffectPlan>]>,
    ) -> Result<CompositeSubmission, CompositorError> {
        if let Some(effects) = effects {
            let lengths_match = effects.len() == self.layers.len()
                && effects.iter().zip(&self.layers).all(|(plan, layer)| {
                    plan.as_ref().map_or(0, |plan| plan.passes.len())
                        == layer.chain.as_ref().map_or(0, |chain| chain.steps.len())
                });
            if !lengths_match {
                return Err(CompositorError::LayerCount {
                    expected: self.layers.len(),
                    actual: effects.len(),
                });
            }
        }
        if states.len() != self.layers.len() {
            return Err(CompositorError::LayerCount {
                expected: self.layers.len(),
                actual: states.len(),
            });
        }
        for (tile_index, tile) in self.tiles.iter().enumerate() {
            for (i, (state, layer)) in states.iter().zip(&self.layers).enumerate() {
                let geometry =
                    uniforms(self.stage, tile.tile, *state).map_err(|(field, detail)| {
                        mapping(&layer.object_id, &layer.document_path, field, detail)
                    })?;
                self.uniform_scratch[tile_index * states.len() + i] =
                    pack_uniform(&geometry, key(layer.mode, tile.tile, *state));
            }
        }
        for (tile_index, tile) in self.tiles.iter().enumerate() {
            for (i, uniform) in tile.uniforms.iter().enumerate() {
                self.queue.write_buffer(
                    uniform,
                    0,
                    &self.uniform_scratch[tile_index * states.len() + i],
                );
            }
        }
        if let Some(effects) = effects {
            for (layer, plan) in self.layers.iter().zip(effects) {
                let (Some(chain), Some(plan)) = (&layer.chain, plan) else {
                    continue;
                };
                for (step, pass) in chain.steps.iter().zip(&plan.passes) {
                    let effect = &pass.packed;
                    self.queue
                        .write_buffer(&step.uniform, 0, &effect_uniform(effect));
                    if effect.kind == crate::effects::CURVES {
                        write_curve(&mut self.curve_scratch, effect);
                        self.queue.write_buffer(&step.curve, 0, &self.curve_scratch);
                    }
                }
            }
        }
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gx-composite-frame"),
            });
        let mut effect_dispatches = 0;
        if let Some(pipelines) = &self.effect_pipeline {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gx-effects"),
                timestamp_writes: None,
            });
            for chain in self.layers.iter().filter_map(|layer| layer.chain.as_ref()) {
                for step in &chain.steps {
                    pass.set_bind_group(0, &step.group, &[]);
                    if step.line {
                        // One invocation per row or column; the kernel takes
                        // its direction from the pass parameters.
                        pass.set_pipeline(&pipelines.line);
                        pass.dispatch_workgroups(chain.width.max(chain.height).div_ceil(64), 1, 1);
                    } else {
                        pass.set_pipeline(&pipelines.pixel);
                        pass.dispatch_workgroups(
                            chain.width.div_ceil(16),
                            chain.height.div_ceil(16),
                            1,
                        );
                    }
                    effect_dispatches += 1;
                }
            }
        }
        crate::render_work::gpu_effect_dispatch(effect_dispatches);
        for tile in &self.tiles {
            let bounds = tile.tile.render_bounds;
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gx-composite-tile"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.clear_pipeline);
            pass.set_bind_group(0, &tile.clear, &[]);
            pass.dispatch_workgroups(bounds.width.div_ceil(16), bounds.height.div_ceil(16), 1);
            pass.set_pipeline(&self.composite_pipeline);
            for group in &tile.groups {
                pass.set_bind_group(0, group, &[]);
                pass.dispatch_workgroups(bounds.width.div_ceil(16), bounds.height.div_ceil(16), 1);
            }
        }
        self.queue.submit([encoder.finish()]);
        crate::render_work::gpu_dispatch(self.tiles.len() * states.len());
        self.submitted = true;
        Ok(CompositeSubmission {
            tiles: self.tiles.len(),
            layer_dispatches: self.tiles.len() * states.len(),
            uniform_bytes: self.uniform_scratch.len() * UNIFORM_BYTES,
        })
    }

    /// Borrow the completed working-space GPU tiles for an output pass. No
    /// CPU readback is required. A borrow prevents another frame from replacing
    /// these targets while a consumer encodes commands against them.
    pub fn output_tiles(&self) -> Option<impl ExactSizeIterator<Item = (Tile, &wgpu::Texture)>> {
        self.submitted.then(|| {
            self.tiles
                .iter()
                .map(|tile| (tile.tile, &tile.targets[self.layers.len() % 2]))
        })
    }

    /// Build the 3.21 output stage for this compositor: the GPU encode pass,
    /// its tables, the output surfaces and every readback ring slot. Called
    /// at prepare; nothing here runs on the frame path.
    pub fn output_ring(&self) -> Result<output::OutputRing, CompositorError> {
        output::OutputRing::prepare(
            &self.device,
            &self.queue,
            self.stage,
            self.working_space,
            &self.tiles,
            self.layers.len() % 2,
        )
    }

    /// Simple synchronous working-space readback for 3.16. Prepared buffers
    /// bound memory; polling and mapping have a five-second failure deadline.
    /// This is not 3.21's asynchronous ring or a frame-timing guarantee.
    pub fn readback_working(&mut self) -> Result<CompositeReference, CompositorError> {
        if !self.submitted {
            return Err(CompositorError::Readback("no frame submitted".into()));
        }
        let count = usize::try_from(u64::from(self.stage.width) * u64::from(self.stage.height))
            .map_err(|_| CompositorError::Tile(TileError::BufferTooLarge))?;
        let mut pixels = vec![WorkingRgba::transparent(); count];
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gx-compositor-readback"),
            });
        for tile in &self.tiles {
            let texture = &tile.targets[self.layers.len() % 2];
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &tile.readback,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(tile.padded_row),
                        rows_per_image: None,
                    },
                },
                texture.size(),
            );
        }
        self.queue.submit([encoder.finish()]);
        for tile in &self.tiles {
            let (sender, receiver) = std::sync::mpsc::channel();
            tile.readback
                .slice(..)
                .map_async(wgpu::MapMode::Read, move |r| {
                    let _ = sender.send(r);
                });
            let _mapping = ReadMapping(&tile.readback);
            self.device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(5)),
                })
                .map_err(|e| CompositorError::Readback(e.to_string()))?;
            receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| CompositorError::Readback(e.to_string()))?
                .map_err(|e| CompositorError::Readback(e.to_string()))?;
            {
                let data = tile
                    .readback
                    .slice(..)
                    .get_mapped_range()
                    .map_err(|e| CompositorError::Readback(e.to_string()))?;
                let core = tile.tile.core;
                let bounds = tile.tile.render_bounds;
                for y in 0..core.height {
                    for x in 0..core.width {
                        let offset = ((y + core.y - bounds.y) * tile.padded_row
                            + (x + core.x - bounds.x) * 16)
                            as usize;
                        let c: [f32; 4] = std::array::from_fn(|i| {
                            f32::from_le_bytes(
                                data[offset + i * 4..offset + i * 4 + 4]
                                    .try_into()
                                    .expect("one float"),
                            )
                        });
                        pixels[((y + core.y) as usize * self.stage.width as usize)
                            + (x + core.x) as usize] = WorkingRgba {
                            r: c[0],
                            g: c[1],
                            b: c[2],
                            a: c[3],
                        };
                    }
                }
            }
        }
        Ok(CompositeReference {
            width: self.stage.width,
            height: self.stage.height,
            working_space: self.working_space,
            pixels,
        })
    }

    /// Kept for callers of the original diagnostic-only core increment.
    pub fn readback_reference(&mut self) -> Result<CompositeReference, CompositorError> {
        self.readback_working()
    }
}

/// Diagnostic pixels from GPU composition; encoding uses the existing CPU
/// colour authority so GPU compositing can be checked independently of 3.21.
pub struct CompositeReference {
    pub width: u32,
    pub height: u32,
    pub working_space: WorkingColorSpace,
    pub pixels: Vec<WorkingRgba>,
}

impl CompositeReference {
    pub fn encode(&self, output: OutputTransform) -> Frame {
        Frame {
            width: self.width,
            height: self.height,
            pixels: self
                .pixels
                .iter()
                .flat_map(|p| p.encode(output, self.working_space))
                .collect(),
        }
    }
}

fn sampled_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn float_texture(
    device: &wgpu::Device,
    width: u32,
    height: u32,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    crate::render_work::gpu_build();
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("gx-compositor-float"),
        size: wgpu::Extent3d {
            width,
            height,
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

/// A layer's inverse-affine rows on a stage of `width` x `height` with its
/// origin at 0, as the composite pass receives them for a tile at the stage
/// origin: the CPU reference warps with exactly these (3.22).
pub(crate) fn layer_rows(
    width: u32,
    height: u32,
    state: LayerState,
) -> Result<[f32; 12], CompositorError> {
    let stage = Stage::new(width, height, crate::tiling::StageOrigin { x: 0.0, y: 0.0 })?;
    let plan = TilePlan::new(stage, width.max(height).max(64) + 64)?;
    let tile = plan.tiles()[0];
    assert_eq!(
        (tile.render_bounds.x, tile.render_bounds.y),
        (0, 0),
        "one tile at the stage origin"
    );
    uniforms(stage, tile, state).map_err(|(field, detail)| CompositorError::Mapping {
        object_id: String::new(),
        document_path: field.into(),
        detail: detail.into(),
    })
}

/// One layer's uniform: three f32 vec4s of geometry and opacity, then one
/// u32 vec4 key (3.20: blend mode, Dissolve seed, tile stage pixel).
const UNIFORM_BYTES: usize = 64;

// Explicit little-endian packing keeps unsafe code and a layout-cast dependency
// out of the worker.
fn pack_uniform(geometry: &[f32; 12], key: [u32; 4]) -> [u8; UNIFORM_BYTES] {
    let mut bytes = [0; UNIFORM_BYTES];
    let words = geometry.iter().map(|v| v.to_bits()).chain(key);
    for (word, dest) in words.zip(bytes.chunks_exact_mut(4)) {
        dest.copy_from_slice(&word.to_le_bytes());
    }
    bytes
}

/// The integer key: mode, seed and the tile's first stage pixel. The pixel is
/// a Dissolve hash input, never a coordinate in float math (invariant 38).
fn key(mode: u32, tile: Tile, state: LayerState) -> [u32; 4] {
    [mode, state.seed, tile.render_bounds.x, tile.render_bounds.y]
}

/// Both effect pipelines over one explicit bind layout (3.22).
fn effect_pipelines(device: &wgpu::Device) -> EffectPipelines {
    crate::render_work::gpu_build();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gx-effects"),
        source: wgpu::ShaderSource::Wgsl(effects_shader().into()),
    });
    let texture = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    crate::render_work::gpu_build();
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("gx-effects"),
        entries: &[
            texture(0),
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::StorageTexture {
                    access: wgpu::StorageTextureAccess::WriteOnly,
                    format: wgpu::TextureFormat::Rgba32Float,
                    view_dimension: wgpu::TextureViewDimension::D2,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(EFFECT_UNIFORM_BYTES as u64),
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            texture(4),
        ],
    });
    crate::render_work::gpu_build();
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("gx-effects"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = |entry| {
        crate::render_work::gpu_build();
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            cache: None,
        })
    };
    let pixel = pipeline("effect_step");
    let line = pipeline("effect_line");
    EffectPipelines {
        layout,
        pixel,
        line,
    }
}

/// Build one layer's effect chain at prepare (3.22): a step per planned pass.
/// A pass reads the current target and writes the other, except a save pass,
/// which writes the third target and leaves the current one; combine passes
/// read the third. No target is ever bound for writing and reading at once.
fn effect_chain(
    device: &wgpu::Device,
    pipelines: &EffectPipelines,
    input: &LayerInput,
    plan: &crate::effect_chain::EffectPlan,
    source: &wgpu::TextureView,
) -> EffectChain {
    let targets: [wgpu::Texture; 3] = std::array::from_fn(|_| {
        float_texture(
            device,
            input.width,
            input.height,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
        )
    });
    let views: [wgpu::TextureView; 3] = std::array::from_fn(|i| {
        crate::render_work::gpu_build();
        targets[i].create_view(&Default::default())
    });
    let mut curve_bytes = Vec::new();
    // The current input: None is the layer source, Some(i) a target.
    let mut current: Option<usize> = None;
    let mut steps = Vec::with_capacity(plan.passes.len());
    for pass in &plan.passes {
        let effect = &pass.packed;
        crate::render_work::gpu_build();
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gx-effect-params"),
            contents: &effect_uniform(effect),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        write_curve(&mut curve_bytes, effect);
        crate::render_work::gpu_build();
        let curve = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gx-effect-curve"),
            contents: &curve_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let src = current.map_or(source, |i| &views[i]);
        let (dst, aux) = if pass.writes_aux() {
            (2, src)
        } else {
            (if current == Some(0) { 1 } else { 0 }, &views[2])
        };
        crate::render_work::gpu_build();
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gx-effect-step"),
            layout: &pipelines.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(src),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&views[dst]),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: curve.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(aux),
                },
            ],
        });
        if !pass.writes_aux() {
            current = Some(dst);
        }
        steps.push(EffectStep {
            line: pass.entry() == crate::effect_chain::Entry::Line,
            uniform,
            curve,
            group,
        });
    }
    crate::render_work::gpu_build();
    let output =
        targets[current.expect("a plan ends on a target")].create_view(&Default::default());
    EffectChain {
        width: input.width,
        height: input.height,
        steps,
        _targets: targets,
        output,
    }
}

/// The effect shader: generated mode constants and the blend guards, then the
/// pointwise kernels (3.22).
pub(crate) fn effects_shader() -> String {
    let mut source = crate::blend::wgsl_mode_constants();
    source.push_str(include_str!("blend.wgsl"));
    source.push_str(include_str!("effects.wgsl"));
    source
}

/// The compositor shader: generated mode constants, the blend functions, the
/// layer pass. One module, so the blend has a single GPU definition.
pub(crate) fn compositor_shader() -> String {
    let mut source = crate::blend::wgsl_mode_constants();
    source.push_str(include_str!("blend.wgsl"));
    source.push_str(include_str!("composite.wgsl"));
    source
}

fn mapping(id: &str, path: &str, field: &str, detail: impl Into<String>) -> CompositorError {
    CompositorError::Mapping {
        object_id: id.into(),
        document_path: format!("{path}.{field}"),
        detail: detail.into(),
    }
}

fn validate_input(
    input: &LayerInput,
    space: WorkingColorSpace,
    limit: u32,
) -> Result<(), CompositorError> {
    let fail = |field, detail| mapping(&input.object_id, &input.document_path, field, detail);
    if input.working_space != space {
        return Err(fail(
            "workingColorSpace",
            "source must be converted to the compositor's working space at prepare".into(),
        ));
    }
    if input.width == 0 || input.height == 0 || input.width > limit || input.height > limit {
        return Err(fail("pixels", format!("source {}x{} must be non-empty and within device limit {limit}; source backend must supply bounded layers", input.width, input.height)));
    }
    if input.pixels.len() as u64 != u64::from(input.width) * u64::from(input.height) {
        return Err(fail(
            "pixels",
            "source pixel count differs from its dimensions".into(),
        ));
    }
    if input
        .pixels
        .iter()
        .any(|p| ![p.r, p.g, p.b, p.a].iter().all(|c| c.is_finite()) || !(0.0..=1.0).contains(&p.a))
    {
        return Err(fail(
            "pixels",
            "source pixels must be finite with alpha in [0, 1]".into(),
        ));
    }
    Ok(())
}

fn uniforms(
    stage: Stage,
    tile: Tile,
    state: LayerState,
) -> Result<[f32; 12], (&'static str, &'static str)> {
    let [a, b, c, d, tx, ty] = state.affine;
    let determinant = a * d - b * c;
    if !state.affine.iter().all(|v| v.is_finite()) || !determinant.is_finite() || determinant == 0.0
    {
        return Err((
            "transform",
            "affine transform must be finite and invertible",
        ));
    }
    if !state.opacity.is_finite() || !(0.0..=1.0).contains(&state.opacity) {
        return Err(("opacity", "opacity must be finite and in [0, 1]"));
    }
    let [ia, ib, ic, id] = [
        d / determinant,
        -b / determinant,
        -c / determinant,
        a / determinant,
    ];
    // Subtract the absolute translation BEFORE narrowing. No absolute stage
    // coordinate is ever sent to WGSL (invariant 38).
    let dx = (stage.origin.x - tx) + f64::from(tile.render_bounds.x);
    let dy = (stage.origin.y - ty) + f64::from(tile.render_bounds.y);
    let values = [
        ia as f32,
        ic as f32,
        (ia * dx + ic * dy) as f32,
        0.0,
        ib as f32,
        id as f32,
        (ib * dx + id * dy) as f32,
        0.0,
        state.opacity,
        0.0,
        0.0,
        0.0,
    ];
    if !values.iter().all(|v| v.is_finite()) {
        return Err((
            "transform",
            "tile-local inverse transform exceeds finite f32 range",
        ));
    }
    Ok(values)
}

#[cfg(test)]
mod tests;
