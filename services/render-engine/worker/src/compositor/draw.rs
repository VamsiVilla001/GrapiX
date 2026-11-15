//! 3.17: vector layer sources drawn on the GPU at prepare (user decision
//! 15 Nov 2026): Vello GPU 0.3 for coverage, colour in float.
//!
//! Each path is filled in opaque white by Vello GPU into an 8-bit coverage
//! target the size of its coverage window. A compute pass then composites the
//! path's paint, in the scene's working space, scaled by that coverage, onto
//! the layer in float. The window, its integer offset and the compositing
//! formula are the CPU backend's (`rasterise::VelloCpuRasteriser`), so the two
//! agree to within Vello GPU's and Vello CPU's coverage, one code value.
//!
//! This runs only at prepare (invariant 35); the frame path never draws.

use crate::rasterise::{coverage_window, window_transform, PreparedPath};
use gx_contracts::Refusal;
use vello_gpu::peniko::color::palette::css::WHITE;

const COVERAGE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const DRAW_BYTES: u64 = 48;

/// The Vello GPU renderer and the compose pipeline, built once per device:
/// building Vello's pipelines takes about a second.
pub(crate) struct GpuDrawer {
    renderer: vello_gpu::Renderer,
    resources: vello_gpu::Resources,
    compose: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
}

impl GpuDrawer {
    pub(crate) fn new(device: &wgpu::Device) -> Self {
        let (renderer, resources) = vello_gpu::Renderer::new(
            device,
            &vello_gpu::RenderTargetConfig {
                format: COVERAGE_FORMAT,
                width: 256,
                height: 256,
            },
        );
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gx-draw"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(DRAW_BYTES),
                    },
                    count: None,
                },
            ],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gx-draw"),
            source: wgpu::ShaderSource::Wgsl(include_str!("draw.wgsl").into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gx-draw"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let compose = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("gx-draw-compose"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("compose"),
            compilation_options: Default::default(),
            cache: None,
        });
        Self {
            renderer,
            resources,
            compose,
            layout,
        }
    }

    /// Draw `paths` into a new working-space float texture of `width` x
    /// `height` whose texel (0, 0) corner is scene point `origin`. The texture
    /// can be sampled and copied; nothing waits for the GPU.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn draw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        object: &str,
        paths: &[&PreparedPath],
        origin: [f64; 2],
        width: u32,
        height: u32,
    ) -> Result<wgpu::Texture, Refusal> {
        let refuse = |detail: String| Refusal::VectorTessellationFailed {
            object: object.into(),
            detail,
        };
        // Rows padded to the copy alignment, so the buffer copies straight
        // into the texture.
        let stride = width.div_ceil(16) * 16;
        let layer_bytes = u64::from(stride) * u64::from(height) * 16;
        if layer_bytes > device.limits().max_storage_buffer_binding_size {
            return Err(refuse(format!(
                "layer {width}x{height} exceeds the GPU drawing buffer limit"
            )));
        }
        crate::render_work::gpu_build();
        let layer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gx-draw-layer"),
            size: layer_bytes.max(16),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        for path in paths {
            let paint = path.paint();
            if paint.a <= 0.0 {
                continue;
            }
            let Some(window) = coverage_window(path, origin, width, height) else {
                continue;
            };
            let (x0, y0, w, h) = window;
            let (Ok(w16), Ok(h16)) = (u16::try_from(w), u16::try_from(h)) else {
                return Err(refuse(format!("coverage window {w}x{h} exceeds u16")));
            };
            crate::render_work::gpu_build();
            let coverage = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("gx-draw-coverage"),
                size: wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: COVERAGE_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = coverage.create_view(&Default::default());
            // One submission per path: Vello uploads each scene's strips with
            // queue writes, which take effect at the next submission, so two
            // paths recorded into one encoder would both read the last
            // path's strips.
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gx-draw"),
            });
            let mut scene = vello_gpu::Scene::new(w16, h16);
            scene.set_transform(window_transform(origin, window));
            scene.set_fill_rule(path.fill_rule());
            scene.set_paint(WHITE);
            scene.fill_path(path.outline());
            self.renderer
                .render(
                    &scene,
                    &mut self.resources,
                    device,
                    queue,
                    &mut encoder,
                    &vello_gpu::RenderSize {
                        width: w16,
                        height: h16,
                    },
                    &view,
                    None,
                    &vello_gpu::TextureBindings::new(),
                    vello_gpu::TargetInit::Clear(vello_gpu::ClearSettings::default()),
                )
                .map_err(|e| refuse(format!("Vello GPU could not draw the path: {e:?}")))?;
            let mut bytes = [0_u8; DRAW_BYTES as usize];
            let words = [paint.r, paint.g, paint.b, paint.a]
                .map(f32::to_bits)
                .into_iter()
                .chain([x0, y0, w, h, stride, 0, 0, 0]);
            for (word, dest) in words.zip(bytes.chunks_exact_mut(4)) {
                dest.copy_from_slice(&word.to_le_bytes());
            }
            crate::render_work::gpu_build();
            let uniform = wgpu::util::DeviceExt::create_buffer_init(
                device,
                &wgpu::util::BufferInitDescriptor {
                    label: Some("gx-draw-paint"),
                    contents: &bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                },
            );
            crate::render_work::gpu_build();
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("gx-draw"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: layer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: uniform.as_entire_binding(),
                    },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("gx-draw-compose"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.compose);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(w.div_ceil(16), h.div_ceil(16), 1);
            drop(pass);
            queue.submit([encoder.finish()]);
        }
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("gx-draw-copy"),
        });
        crate::render_work::gpu_build();
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("gx-draw-source"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer: &layer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride * 16),
                    rows_per_image: Some(height),
                },
            },
            texture.as_image_copy(),
            texture.size(),
        );
        queue.submit([encoder.finish()]);
        Ok(texture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::colour_pipeline::WorkingRgba;
    use crate::rasterise::{
        BezPath, OutlineFill, PathRasteriser, RasterSurface, VelloCpuRasteriser,
    };
    use vello_gpu::kurbo::{Affine, Circle, RoundedRect, Shape};

    fn read_float(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture) -> Vec<f32> {
        let (w, h) = (texture.width(), texture.height());
        let row = (w * 16).div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(row) * u64::from(h),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: Some(h),
                },
            },
            texture.size(),
        );
        queue.submit([encoder.finish()]);
        buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let data = buffer.slice(..).get_mapped_range().unwrap();
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            let start = (y * row) as usize;
            for c in data[start..start + (w * 16) as usize].chunks_exact(4) {
                out.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
            }
        }
        out
    }

    /// The GPU drawer and the CPU backend, on the same paths, agree to one
    /// coverage step (1/255 of the paint) on every pixel, at sizes on both
    /// sides of the renderer's configured target and at a non-zero origin.
    #[test]
    #[ignore = "requires hardware GPU; explicit 3.17 drawing gate"]
    fn gpu_drawer_matches_the_cpu_backend_within_one_coverage_step() {
        let gpu = crate::gpu::negotiate();
        let (device, queue) = gpu.device_queue().expect("a hardware GPU");
        let paint = WorkingRgba {
            r: 0.4,
            g: 0.2,
            b: 0.1,
            a: 0.8,
        };
        for (width, height, origin) in [
            (40_u32, 30_u32, [0.0, 0.0]),
            (300, 200, [-17.0, 230.0]),
            (700, 90, [5.0, -3.0]),
        ] {
            let w = f64::from(width);
            let h = f64::from(height);
            let shapes: Vec<(BezPath, OutlineFill)> = vec![
                (
                    RoundedRect::new(
                        origin[0] + 3.0,
                        origin[1] + 4.0,
                        origin[0] + w * 0.8,
                        origin[1] + h * 0.9,
                        12.0,
                    )
                    .to_path(0.01),
                    OutlineFill::NonZero,
                ),
                (
                    Affine::translate((origin[0] + w * 0.5, origin[1] + h * 0.5))
                        * Circle::new((0.0, 0.0), h * 0.4).to_path(0.01),
                    OutlineFill::EvenOdd,
                ),
            ];
            let paths: Vec<PreparedPath> = shapes
                .into_iter()
                .map(|(outline, rule)| PreparedPath::new("shape".into(), paint, outline, rule))
                .collect();
            let refs: Vec<&PreparedPath> = paths.iter().collect();
            let mut drawer = GpuDrawer::new(device);
            let texture = drawer
                .draw(device, queue, "shape", &refs, origin, width, height)
                .unwrap();
            let gpu_px = read_float(device, queue, &texture);
            let mut surface = RasterSurface::window(width, height, origin);
            VelloCpuRasteriser.rasterise_into(&refs, &mut surface);
            let mut worst = (0.0_f32, 0_usize);
            for (i, p) in surface.pixels().iter().enumerate() {
                for (c, cpu) in [p.r, p.g, p.b, p.a].into_iter().enumerate() {
                    let d = (gpu_px[i * 4 + c] - cpu).abs();
                    if d > worst.0 {
                        worst = (d, i);
                    }
                }
            }
            let at = worst.1;
            assert!(
                worst.0 <= 1.0 / 255.0 + 1e-6,
                "{width}x{height} at {origin:?}: worst delta {} at ({}, {}): gpu {:?} cpu {:?}",
                worst.0,
                at as u32 % width,
                at as u32 / width,
                &gpu_px[at * 4..at * 4 + 4],
                surface.pixels()[at]
            );
        }
    }
}
