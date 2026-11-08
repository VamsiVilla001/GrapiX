//! Isolated lyon-on-wgpu-30 benchmark, not a product drawing backend.
//! Same paths, dashes, paints and timing boundary as the Vello probes.
use super::*;
use lyon::tessellation::{
    BuffersBuilder, FillOptions, FillTessellator, FillVertex, StrokeOptions, StrokeTessellator,
    StrokeVertex, VertexBuffers,
};
use vello::wgpu;
use wgpu::util::DeviceExt;

pub(super) struct LyonGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    mask: wgpu::RenderPipeline,
    paint: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    msaa: wgpu::TextureView,
    stencil: wgpu::TextureView,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    buffer: wgpu::Buffer,
}

struct Draw {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    count: u32,
    paint: wgpu::BindGroup,
    scissor: [u32; 4],
}

impl LyonGpu {
    pub(super) fn new(backend: &str, dxc: Option<&str>) -> Result<(Self, String, f64)> {
        let (device, queue, info) = gpu30::device(backend, dxc)?;
        let start = Instant::now();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("lyon paint"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(96),
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("lyon benchmark"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("lyon benchmark"),
            source: wgpu::ShaderSource::Wgsl(include_str!("lyon_gpu.wgsl").into()),
        });
        let pipeline = |mask: bool| {
            let stencil = wgpu::StencilFaceState {
                compare: if mask {
                    wgpu::CompareFunction::Always
                } else {
                    wgpu::CompareFunction::Equal
                },
                fail_op: wgpu::StencilOperation::Keep,
                depth_fail_op: wgpu::StencilOperation::Keep,
                pass_op: if mask {
                    wgpu::StencilOperation::Replace
                } else {
                    wgpu::StencilOperation::Zero
                },
            };
            let vertices = [Some(wgpu::VertexBufferLayout {
                array_stride: 8,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 0,
                    shader_location: 0,
                }],
            })];
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(if mask {
                    "lyon union mask"
                } else {
                    "lyon shaded coverage"
                }),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(if mask { "mesh" } else { "quad" }),
                    compilation_options: Default::default(),
                    buffers: if mask { &vertices } else { &[] },
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24PlusStencil8,
                    depth_write_enabled: Some(false),
                    depth_compare: Some(wgpu::CompareFunction::Always),
                    stencil: wgpu::StencilState {
                        front: stencil,
                        back: stencil,
                        read_mask: 0xff,
                        write_mask: 0xff,
                    },
                    bias: Default::default(),
                }),
                multisample: wgpu::MultisampleState {
                    count: 4,
                    mask: !0,
                    alpha_to_coverage_enabled: false,
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(if mask { "mask" } else { "color" }),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                        write_mask: if mask {
                            wgpu::ColorWrites::empty()
                        } else {
                            wgpu::ColorWrites::ALL
                        },
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let mask = pipeline(true);
        let paint = pipeline(false);
        let make_target = |format| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("lyon 4x MSAA"),
                    size: wgpu::Extent3d {
                        width: WIDTH,
                        height: HEIGHT,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 4,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                })
                .create_view(&Default::default())
        };
        let msaa = make_target(wgpu::TextureFormat::Rgba8Unorm);
        let stencil = make_target(wgpu::TextureFormat::Depth24PlusStencil8);
        let (texture, view, buffer) =
            gpu30::target(&device, wgpu::TextureUsages::RENDER_ATTACHMENT);
        let init_ms = start.elapsed().as_secs_f64() * 1000.0;
        Ok((
            Self {
                device,
                queue,
                mask,
                paint,
                layout,
                msaa,
                stencil,
                texture,
                view,
                buffer,
            },
            info,
            init_ms,
        ))
    }

    pub(super) fn frame(&mut self, work: &Workload, readback: bool) -> Result<Image> {
        // Deliberately include tessellation and upload in this dynamic-frame
        // comparison, as Vello includes display-list encoding and uploads.
        // A product backend must cache persistent resources at prepare.
        let draws = work
            .cmds
            .iter()
            .map(|cmd| self.prepare(cmd))
            .collect::<Result<Vec<_>>>()?;
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("lyon 4x MSAA union + paint"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.msaa,
                    depth_slice: None,
                    resolve_target: Some(&self.view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Discard,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.stencil,
                    depth_ops: None,
                    stencil_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(0),
                        store: wgpu::StoreOp::Discard,
                    }),
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_stencil_reference(1);
            for draw in &draws {
                let [x, y, width, height] = draw.scissor;
                if width == 0 || height == 0 {
                    continue;
                }
                pass.set_scissor_rect(x, y, width, height);
                pass.set_bind_group(0, &draw.paint, &[]);
                pass.set_pipeline(&self.mask);
                pass.set_vertex_buffer(0, draw.vertices.slice(..));
                pass.set_index_buffer(draw.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..draw.count, 0, 0..1);
                pass.set_pipeline(&self.paint);
                pass.draw(0..3, 0..1);
            }
        }
        if !readback {
            self.queue.submit([encoder.finish()]);
            self.device
                .poll(wgpu::PollType::wait_indefinitely())
                .map_err(|e| format!("lyon poll: {e}"))?;
            return Ok(Image::straight(Vec::new()));
        }
        Ok(Image::premultiplied(gpu30::read_back(
            &self.device,
            &self.queue,
            encoder,
            &self.texture,
            &self.buffer,
        )?))
    }

    fn prepare(&self, cmd: &Cmd) -> Result<Draw> {
        let (path, paint, stroke) = match cmd {
            Cmd::Fill { path, paint } => (path, paint, None),
            Cmd::Stroke { path, paint, style } => (path, paint, Some(style)),
        };
        let elements: Vec<_> = match stroke.and_then(|s| s.dash.as_ref()) {
            Some(dashes) => kurbo::dash(path.iter(), 0.0, dashes).collect(),
            None => path.iter().collect(),
        };
        let mut builder = lyon::path::Path::builder();
        let mut open = false;
        let point = |p: Point| lyon::math::point(p.x as f32, p.y as f32);
        for element in elements {
            match element {
                kurbo::PathEl::MoveTo(p) => {
                    if open {
                        builder.end(false);
                    }
                    builder.begin(point(p));
                    open = true;
                }
                kurbo::PathEl::LineTo(p) => {
                    builder.line_to(point(p));
                }
                kurbo::PathEl::QuadTo(a, b) => {
                    builder.quadratic_bezier_to(point(a), point(b));
                }
                kurbo::PathEl::CurveTo(a, b, c) => {
                    builder.cubic_bezier_to(point(a), point(b), point(c));
                }
                kurbo::PathEl::ClosePath => {
                    builder.end(true);
                    open = false;
                }
            }
        }
        if open {
            builder.end(false);
        }
        let path = builder.build();
        let mut geometry: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
        if let Some(style) = stroke {
            let join = match style.join {
                Join::Miter => lyon::tessellation::LineJoin::Miter,
                Join::Round => lyon::tessellation::LineJoin::Round,
                Join::Bevel => lyon::tessellation::LineJoin::Bevel,
            };
            let cap = match style.cap {
                Cap::Butt => lyon::tessellation::LineCap::Butt,
                Cap::Round => lyon::tessellation::LineCap::Round,
                Cap::Square => lyon::tessellation::LineCap::Square,
            };
            StrokeTessellator::new()
                .tessellate_path(
                    &path,
                    &StrokeOptions::default()
                        .with_line_width(style.width as f32)
                        .with_line_join(join)
                        .with_line_cap(cap)
                        .with_tolerance(0.05),
                    &mut BuffersBuilder::new(&mut geometry, |v: StrokeVertex<'_, '_>| {
                        v.position().to_array()
                    }),
                )
                .map_err(|e| format!("lyon stroke: {e:?}"))?;
        } else {
            FillTessellator::new()
                .tessellate_path(
                    &path,
                    &FillOptions::default()
                        .with_fill_rule(lyon::path::FillRule::NonZero)
                        .with_tolerance(0.05),
                    &mut BuffersBuilder::new(&mut geometry, |v: FillVertex<'_>| {
                        v.position().to_array()
                    }),
                )
                .map_err(|e| format!("lyon fill: {e:?}"))?;
        }
        // Bound the mask/paint pass to the tessellated primitive. A fullscreen
        // paint quad for every small scorebug item would bias the comparison.
        let bounds = geometry.vertices.iter().fold(
            [
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            ],
            |b, p| {
                [
                    b[0].min(p[0]),
                    b[1].min(p[1]),
                    b[2].max(p[0]),
                    b[3].max(p[1]),
                ]
            },
        );
        let x0 = (bounds[0].floor() - 1.0).clamp(0.0, WIDTH as f32) as u32;
        let y0 = (bounds[1].floor() - 1.0).clamp(0.0, HEIGHT as f32) as u32;
        let x1 = (bounds[2].ceil() + 1.0).clamp(0.0, WIDTH as f32) as u32;
        let y1 = (bounds[3].ceil() + 1.0).clamp(0.0, HEIGHT as f32) as u32;
        let scissor = [x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0)];
        let vertex_bytes: Vec<_> = geometry
            .vertices
            .iter()
            .flatten()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let index_bytes: Vec<_> = geometry
            .indices
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let vertex = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("lyon vertices"),
                contents: &vertex_bytes,
                usage: wgpu::BufferUsages::VERTEX,
            });
        let indices = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("lyon indices"),
                contents: &index_bytes,
                usage: wgpu::BufferUsages::INDEX,
            });
        let data = paint_data(paint);
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("lyon paint"),
                contents: &data,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let paint = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lyon paint"),
            layout: &self.layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        });
        Ok(Draw {
            vertices: vertex,
            indices,
            count: geometry.indices.len() as u32,
            paint,
            scissor,
        })
    }
}

fn paint_data(paint: &Paint) -> Vec<u8> {
    let (geometry, kind, stops) = match paint {
        Paint::Solid(c) => ([0.0; 4], 0.0, vec![(0.0, *c), (1.0, *c)]),
        Paint::Linear { p0, p1, stops } => (
            [p0.x as f32, p0.y as f32, p1.x as f32, p1.y as f32],
            1.0,
            stops.clone(),
        ),
        Paint::Radial {
            centre,
            radius,
            stops,
        } => (
            [centre.x as f32, centre.y as f32, *radius as f32, 0.0],
            2.0,
            stops.clone(),
        ),
    };
    let mut values = Vec::from(geometry);
    values.extend([kind, stops.len() as f32, 0.0, 0.0]);
    for i in 0..3 {
        let (_, c) = stops[i.min(stops.len() - 1)];
        let a = f32::from(c[3]) / 255.0;
        values.extend([
            f32::from(c[0]) / 255.0 * a,
            f32::from(c[1]) / 255.0 * a,
            f32::from(c[2]) / 255.0 * a,
            a,
        ]);
    }
    values.extend([stops[0].0, stops[1].0, stops.last().unwrap().0, 0.0]);
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}
