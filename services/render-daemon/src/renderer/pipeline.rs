//! Quad compositing pipeline built on the shared shader contract.
//!
//! The WGSL source and the byte layout of [`QuadUniforms`] are owned by
//! `Shared/render-shaders` (see docs/shader-contract.md there). The
//! `tests/layout_contract.rs` integration test asserts this struct matches
//! `layouts.json` exactly, so Rust and the future browser WebGPU renderer
//! cannot silently diverge.

use glam::Mat4;

use crate::scene::{PreparedGradient, PreparedScene};

/// Shared shader source, compiled into the binary. The path reaches across
/// the monorepo on purpose: there must be exactly one copy of this shader.
pub const COMPOSITE_QUAD_WGSL: &str =
    include_str!("../../../../Shared/render-shaders/wgsl/composite_quad.wgsl");

/// Mirrors `QuadUniforms` in composite_quad.wgsl. 304 bytes; layout is a
/// contract with Shared/render-shaders/layouts.json.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct QuadUniforms {
    /// Column-major scene->clip transform (see shader-contract.md).
    pub transform: [f32; 16],
    /// Linear-light RGB premultiplied by alpha.
    pub fill_color: [f32; 4],
    /// x = blend mode id (0 = normal); y/z/w reserved, must be 0.
    pub params: [f32; 4],
    /// x gradient kind, y stop count, z spread, w coordinate mode.
    pub gradient_params: [f32; 4],
    pub gradient_geometry: [[f32; 4]; 2],
    pub gradient_positions: [[f32; 4]; 2],
    pub gradient_colors: [[f32; 4]; 8],
}

pub const QUAD_UNIFORMS_SIZE: usize = std::mem::size_of::<QuadUniforms>();

#[derive(Debug, Clone, Copy)]
pub struct QuadStyle {
    pub fill_linear_premultiplied: [f32; 4],
    pub blend_mode: u32,
    pub primitive_kind: u32,
    pub gradient: PreparedGradient,
}

/// Upper bound on quads per frame in v1 (background + objects). Scenes larger
/// than this render the first MAX_QUADS_PER_FRAME quads and warn.
pub const MAX_QUADS_PER_FRAME: usize = 1024;

/// Render target format: BGRA so readback bytes feed NDI BGRA directly, and
/// `-srgb` so the hardware encodes linear shader output back to sRGB bytes.
pub const RENDER_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8UnormSrgb;
pub const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

/// Number of implemented blend modes, indexed by the shared blend id from
/// Shared/render-shaders/layouts.json: 0 normal, 1 multiply, 2 screen,
/// 3 add, 4 darken, 5 lighten.
pub const BLEND_PIPELINE_COUNT: usize = 6;

pub struct QuadPipeline {
    /// One pre-built pipeline per implemented blend mode, indexed by blend id.
    /// Built up front (cheap, one-time) so the render loop never compiles a
    /// pipeline per frame.
    blend_pipelines: [wgpu::RenderPipeline; BLEND_PIPELINE_COUNT],
    bind_group: wgpu::BindGroup,
    uniform_buffer: wgpu::Buffer,
    /// Byte stride between quad uniform slots; QUAD_UNIFORMS_SIZE rounded up
    /// to the device's min_uniform_buffer_offset_alignment (dynamic offsets).
    stride: u32,
}

/// Fixed-function blend state for a shared blend id, mirroring PixiJS's
/// premultiplied-alpha blend equations (GpuBlendModesToPixi) so the editor
/// preview and the daemon match exactly. These are Adobe's standard blend
/// formulas where they are expressible as fixed-function GPU blending.
///
/// darken/lighten use the GPU Min/Max blend operations (factors are ignored
/// by the hardware for Min/Max), matching PixiJS's "min"/"max" modes. Exact
/// Adobe separable darken/lighten over partial transparency would need shader
/// compositing; that is future work and documented in the shader contract.
pub fn blend_state_for_id(blend_mode: u32) -> wgpu::BlendState {
    use wgpu::{BlendComponent, BlendFactor, BlendOperation, BlendState};

    // Alpha channel is premultiplied source-over for every mode except add,
    // matching PixiJS.
    let src_over_alpha = BlendComponent {
        src_factor: BlendFactor::One,
        dst_factor: BlendFactor::OneMinusSrcAlpha,
        operation: BlendOperation::Add,
    };

    match blend_mode {
        // multiply: color = src*dst + dst*(1-srcAlpha)
        1 => BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::Dst,
                dst_factor: BlendFactor::OneMinusSrcAlpha,
                operation: BlendOperation::Add,
            },
            alpha: src_over_alpha,
        },
        // screen: color = src*1 + dst*(1-src)
        2 => BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::OneMinusSrc,
                operation: BlendOperation::Add,
            },
            alpha: src_over_alpha,
        },
        // add: color and alpha = src*1 + dst*1
        3 => BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::Add,
            },
            alpha: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::Add,
            },
        },
        // darken: component-wise min(src, dst)
        4 => BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::Min,
            },
            alpha: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::Min,
            },
        },
        // lighten: component-wise max(src, dst)
        5 => BlendState {
            color: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::Max,
            },
            alpha: BlendComponent {
                src_factor: BlendFactor::One,
                dst_factor: BlendFactor::One,
                operation: BlendOperation::Max,
            },
        },
        // normal (0) and any unexpected id: premultiplied source-over.
        _ => BlendState::PREMULTIPLIED_ALPHA_BLENDING,
    }
}

impl QuadPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let alignment = device.limits().min_uniform_buffer_offset_alignment;
        let stride = (QUAD_UNIFORMS_SIZE as u32).div_ceil(alignment) * alignment;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("grapix-composite-quad"),
            source: wgpu::ShaderSource::Wgsl(COMPOSITE_QUAD_WGSL.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("grapix-quad-uniforms"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(QUAD_UNIFORMS_SIZE as u64),
                },
                count: None,
            }],
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("grapix-quad-uniform-buffer"),
            size: u64::from(stride) * MAX_QUADS_PER_FRAME as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("grapix-quad-bind-group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &uniform_buffer,
                    offset: 0,
                    size: wgpu::BufferSize::new(QUAD_UNIFORMS_SIZE as u64),
                }),
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("grapix-quad-pipeline-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let create_pipeline = |label: &str, blend: wgpu::BlendState| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: RENDER_FORMAT,
                        blend: Some(blend),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                // The native compositor pass always owns a depth attachment
                // so depth-tested meshes can follow 2D content in the same
                // pass. Quads neither read nor write it.
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: DEPTH_FORMAT,
                    depth_write_enabled: false,
                    depth_compare: wgpu::CompareFunction::Always,
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };

        // One pipeline per blend id (0..BLEND_PIPELINE_COUNT).
        let blend_pipelines = std::array::from_fn(|id| {
            create_pipeline(
                &format!("grapix-quad-pipeline-blend-{id}"),
                blend_state_for_id(id as u32),
            )
        });

        Self {
            blend_pipelines,
            bind_group,
            uniform_buffer,
            stride,
        }
    }

    /// Build the ordered quad list for a frame: canvas background first
    /// (matching the editor, which draws the background as scene content),
    /// then every prepared rect in render order.
    pub fn build_frame_quads(scene: &PreparedScene) -> Vec<QuadUniforms> {
        let projection = scene_projection(scene.canvas_width, scene.canvas_height);
        let mut quads = Vec::with_capacity(scene.rects.len() + 1);

        quads.push(quad_uniforms(
            projection,
            0.0,
            0.0,
            scene.canvas_width,
            scene.canvas_height,
            0.0,
            1.0,
            1.0,
            0.0,
            0.0,
            QuadStyle {
                fill_linear_premultiplied: scene.background_linear_premultiplied,
                blend_mode: 0,
                primitive_kind: 0,
                gradient: scene.background_gradient,
            },
        ));

        for rect in &scene.rects {
            quads.push(quad_uniforms(
                projection,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                rect.rotation_degrees,
                rect.scale_x,
                rect.scale_y,
                rect.anchor_x,
                rect.anchor_y,
                QuadStyle {
                    fill_linear_premultiplied: rect.fill_linear_premultiplied,
                    blend_mode: rect.blend_mode,
                    primitive_kind: rect.primitive_kind,
                    gradient: rect.gradient,
                },
            ));
        }

        quads
    }

    /// Upload quads into the dynamic-offset uniform buffer.
    pub fn upload(&self, queue: &wgpu::Queue, quads: &[QuadUniforms]) {
        let mut staging = vec![0u8; quads.len() * self.stride as usize];

        for (index, quad) in quads.iter().enumerate() {
            let offset = index * self.stride as usize;
            staging[offset..offset + QUAD_UNIFORMS_SIZE].copy_from_slice(bytemuck::bytes_of(quad));
        }

        queue.write_buffer(&self.uniform_buffer, 0, &staging);
    }

    /// Record one draw per quad. `upload` must have been called for this frame.
    pub fn draw<'pass>(&'pass self, pass: &mut wgpu::RenderPass<'pass>, quads: &[QuadUniforms]) {
        for (index, quad) in quads.iter().enumerate() {
            // params[0] carries the shared blend id; clamp to the built set so
            // an out-of-range id falls back to normal rather than panicking.
            let blend_id = (quad.params[0] as usize).min(BLEND_PIPELINE_COUNT - 1);
            pass.set_pipeline(&self.blend_pipelines[blend_id]);
            pass.set_bind_group(0, &self.bind_group, &[index as u32 * self.stride]);
            pass.draw(0..6, 0..1);
        }
    }
}

/// Scene-space -> clip-space projection from the shader contract:
/// clip_x = 2x/w - 1, clip_y = 1 - 2y/h (y-down scene space).
pub fn scene_projection(canvas_width: f32, canvas_height: f32) -> Mat4 {
    Mat4::from_cols_array(&[
        2.0 / canvas_width,
        0.0,
        0.0,
        0.0, // column 0
        0.0,
        -2.0 / canvas_height,
        0.0,
        0.0, // column 1
        0.0,
        0.0,
        1.0,
        0.0, // column 2
        -1.0,
        1.0,
        0.0,
        1.0, // column 3
    ])
}

/// Contract transform:
/// projection * translate(x, y) * rotate_z * scale(scale_x, scale_y)
/// * translate(-anchor_x, -anchor_y) * scale(width, height).
///
/// `x/y` is the world-space position of the object-local anchor. Legacy scenes
/// default to anchor (0,0) and scale (1,1), preserving the old top-left pivot.
#[allow(clippy::too_many_arguments)]
pub fn quad_uniforms(
    projection: Mat4,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    rotation_degrees: f32,
    scale_x: f32,
    scale_y: f32,
    anchor_x: f32,
    anchor_y: f32,
    style: QuadStyle,
) -> QuadUniforms {
    let model = Mat4::from_translation(glam::vec3(x, y, 0.0))
        * Mat4::from_rotation_z(rotation_degrees.to_radians())
        * Mat4::from_scale(glam::vec3(scale_x, scale_y, 1.0))
        * Mat4::from_translation(glam::vec3(-anchor_x, -anchor_y, 0.0))
        * Mat4::from_scale(glam::vec3(width, height, 1.0));
    let canvas_width = 2.0 / projection.x_axis.x;
    let canvas_height = -2.0 / projection.y_axis.y;

    QuadUniforms {
        transform: (projection * model).to_cols_array(),
        fill_color: style.fill_linear_premultiplied,
        params: [
            style.blend_mode as f32,
            style.primitive_kind as f32,
            canvas_width,
            canvas_height,
        ],
        gradient_params: [
            style.gradient.kind as f32,
            style.gradient.stop_count as f32,
            style.gradient.spread as f32,
            style.gradient.coordinate_mode as f32,
        ],
        gradient_geometry: style.gradient.geometry,
        gradient_positions: [
            style.gradient.positions[0..4]
                .try_into()
                .expect("four gradient positions"),
            style.gradient.positions[4..8]
                .try_into()
                .expect("four gradient positions"),
        ],
        gradient_colors: style.gradient.colors_linear_premultiplied,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uniforms_are_304_bytes() {
        // The authoritative check against layouts.json lives in
        // tests/layout_contract.rs; this is the fast in-crate guard.
        assert_eq!(QUAD_UNIFORMS_SIZE, 304);
        assert_eq!(std::mem::align_of::<QuadUniforms>(), 4);
    }

    #[test]
    fn blend_states_match_pixi_equations() {
        use wgpu::{BlendFactor, BlendOperation};

        // normal (0): premultiplied source-over.
        let normal = blend_state_for_id(0);
        assert_eq!(normal.color.src_factor, BlendFactor::One);
        assert_eq!(normal.color.dst_factor, BlendFactor::OneMinusSrcAlpha);

        // multiply (1): color = src*dst + dst*(1-srcAlpha).
        let multiply = blend_state_for_id(1);
        assert_eq!(multiply.color.src_factor, BlendFactor::Dst);
        assert_eq!(multiply.color.dst_factor, BlendFactor::OneMinusSrcAlpha);

        // screen (2): color = src + dst*(1-src).
        let screen = blend_state_for_id(2);
        assert_eq!(screen.color.src_factor, BlendFactor::One);
        assert_eq!(screen.color.dst_factor, BlendFactor::OneMinusSrc);

        // add (3): color and alpha = src + dst.
        let add = blend_state_for_id(3);
        assert_eq!(add.color.dst_factor, BlendFactor::One);
        assert_eq!(add.alpha.dst_factor, BlendFactor::One);

        // darken (4) / lighten (5): component-wise min / max.
        assert_eq!(blend_state_for_id(4).color.operation, BlendOperation::Min);
        assert_eq!(blend_state_for_id(5).color.operation, BlendOperation::Max);

        // Out-of-range ids fall back to normal, never panic.
        let fallback = blend_state_for_id(99);
        assert_eq!(fallback.color.src_factor, BlendFactor::One);
        assert_eq!(fallback.color.dst_factor, BlendFactor::OneMinusSrcAlpha);
    }

    #[test]
    fn projection_maps_scene_corners_to_clip_corners() {
        let projection = scene_projection(1920.0, 1080.0);

        let top_left = projection * glam::vec4(0.0, 0.0, 0.0, 1.0);
        assert!((top_left.x - -1.0).abs() < 1e-6);
        assert!((top_left.y - 1.0).abs() < 1e-6);

        let bottom_right = projection * glam::vec4(1920.0, 1080.0, 0.0, 1.0);
        assert!((bottom_right.x - 1.0).abs() < 1e-6);
        assert!((bottom_right.y - -1.0).abs() < 1e-6);
    }

    #[test]
    fn quad_transform_places_unit_corners_at_object_corners() {
        let projection = scene_projection(1920.0, 1080.0);
        let quad = quad_uniforms(
            projection,
            960.0,
            540.0,
            480.0,
            270.0,
            0.0,
            1.0,
            1.0,
            0.0,
            0.0,
            QuadStyle {
                fill_linear_premultiplied: [0.0; 4],
                blend_mode: 0,
                primitive_kind: 0,
                gradient: PreparedGradient::default(),
            },
        );
        let transform = Mat4::from_cols_array(&quad.transform);

        // Unit-quad origin lands at the object's top-left: scene (960, 540) = clip (0, 0).
        let origin = transform * glam::vec4(0.0, 0.0, 0.0, 1.0);
        assert!(origin.x.abs() < 1e-6 && origin.y.abs() < 1e-6);

        // Unit-quad (1,1) lands at scene (1440, 810) = clip (0.5, -0.5).
        let corner = transform * glam::vec4(1.0, 1.0, 0.0, 1.0);
        assert!((corner.x - 0.5).abs() < 1e-6);
        assert!((corner.y - -0.5).abs() < 1e-6);
    }

    #[test]
    fn quad_transform_scales_and_rotates_around_the_anchor() {
        let projection = scene_projection(1000.0, 1000.0);
        let quad = quad_uniforms(
            projection,
            500.0,
            500.0,
            200.0,
            100.0,
            90.0,
            2.0,
            0.5,
            100.0,
            50.0,
            QuadStyle {
                fill_linear_premultiplied: [0.0; 4],
                blend_mode: 0,
                primitive_kind: 0,
                gradient: PreparedGradient::default(),
            },
        );
        let transform = Mat4::from_cols_array(&quad.transform);

        // The local anchor (unit 0.5,0.5) stays exactly at scene (500,500)
        // regardless of scale and rotation, which maps to clip (0,0).
        let anchor = transform * glam::vec4(0.5, 0.5, 0.0, 1.0);
        assert!(anchor.x.abs() < 1e-6 && anchor.y.abs() < 1e-6);
    }
}
