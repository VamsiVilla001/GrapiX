//! Depth-tested native mesh rendering.

use glam::{Mat4, Vec3};
use wgpu::util::DeviceExt;

use crate::renderer::pipeline::{
    blend_state_for_id, BLEND_PIPELINE_COUNT, DEPTH_FORMAT, RENDER_FORMAT,
};
use crate::scene::{
    PreparedCullMode, PreparedFilterMode, PreparedLightKind, PreparedMesh, PreparedMeshSurface,
    PreparedMeshVertex, PreparedScene, PreparedTexture, PreparedWrapMode, MAX_PREPARED_LIGHTS,
};

pub const MESH_PBR_WGSL: &str =
    include_str!("../../../../Shared/render-shaders/wgsl/mesh_pbr.wgsl");
pub const MAX_SCENE_LIGHTS: usize = MAX_PREPARED_LIGHTS;
const PUNCTUAL_LIGHT_SCENE_SCALE: f32 = 0.04;
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuMeshVertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
}

impl From<&PreparedMeshVertex> for GpuMeshVertex {
    fn from(value: &PreparedMeshVertex) -> Self {
        Self {
            position: value.position,
            normal: value.normal,
            uv: value.uv,
        }
    }
}

impl GpuMeshVertex {
    const ATTRIBUTES: [wgpu::VertexAttribute; 3] =
        wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2];

    fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBUTES,
        }
    }
}

/// 272 bytes, naturally aligned for a single non-dynamic uniform binding.
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct MeshUniforms {
    pub model: [f32; 16],
    pub view_projection: [f32; 16],
    pub normal_model: [f32; 16],
    pub base_color: [f32; 4],
    pub material_params: [f32; 4],
    pub uv_scale_offset: [f32; 4],
    pub uv_rotation_pivot: [f32; 4],
    /// Linear emissive RGB and intensity, mirrored by `mesh_pbr.wgsl`.
    pub emissive: [f32; 4],
}

pub const MESH_UNIFORMS_SIZE: usize = std::mem::size_of::<MeshUniforms>();

/// Mirrors `SceneLight` in mesh_pbr.wgsl.
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SceneLightUniform {
    pub color_intensity: [f32; 4],
    pub position_kind: [f32; 4],
    pub direction_range: [f32; 4],
    pub spot_decay: [f32; 4],
}

/// Mirrors `SceneLighting` in mesh_pbr.wgsl.
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SceneLightingUniforms {
    pub params: [f32; 4],
    pub lights: [SceneLightUniform; MAX_SCENE_LIGHTS],
}

pub const SCENE_LIGHT_UNIFORM_SIZE: usize = std::mem::size_of::<SceneLightUniform>();
pub const SCENE_LIGHTING_UNIFORMS_SIZE: usize = std::mem::size_of::<SceneLightingUniforms>();

struct MeshDraw {
    /// Which scene object this draw belongs to, so an animated transform can find it.
    object_id: String,
    /// Retained so a transform update rebuilds the whole uniform rather than writing at a
    /// hand-computed byte offset into the struct.
    uniforms: MeshUniforms,
    uniform_buffer: wgpu::Buffer,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    index_count: u32,
    blend_mode: usize,
    cull_mode: usize,
}

pub struct MeshFrame {
    draws: Vec<MeshDraw>,
}

impl MeshFrame {
    pub fn is_empty(&self) -> bool {
        self.draws.is_empty()
    }

    pub fn draw_count(&self) -> usize {
        self.draws.len()
    }

    /// Rewrite the model matrices of animated meshes.
    ///
    /// This is what makes an animated mesh cheap: geometry, textures, samplers and bind groups
    /// are untouched, and only a 256-byte uniform per surface is written. Rebuilding the frame
    /// instead would recreate every vertex buffer and texture, which is the 482 ms path that
    /// made Program deliver two frames a second.
    ///
    /// Composed from the authored transform every time rather than from the previous frame, so
    /// it cannot accumulate drift.
    pub fn update_model_transforms(
        &mut self,
        queue: &wgpu::Queue,
        transforms: &std::collections::HashMap<String, [f32; 16]>,
    ) {
        if transforms.is_empty() {
            return;
        }
        for draw in &mut self.draws {
            let Some(model) = transforms.get(&draw.object_id) else {
                continue;
            };
            if draw.uniforms.model == *model {
                continue;
            }
            draw.uniforms.model = *model;
            // The normal matrix must follow, or lighting keeps using the old orientation and a
            // rotating mesh is lit as though it never moved.
            draw.uniforms.normal_model = Mat4::from_cols_array(model)
                .inverse()
                .transpose()
                .to_cols_array();
            queue.write_buffer(&draw.uniform_buffer, 0, bytemuck::bytes_of(&draw.uniforms));
        }
    }
}

pub struct MeshPipeline {
    pipelines: [[wgpu::RenderPipeline; 3]; BLEND_PIPELINE_COUNT],
    bind_group_layout: wgpu::BindGroupLayout,
}

impl MeshPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("grapix-native-mesh-pbr"),
            source: wgpu::ShaderSource::Wgsl(MESH_PBR_WGSL.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("grapix-mesh-material-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(MESH_UNIFORMS_SIZE as u64),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(
                            SCENE_LIGHTING_UNIFORMS_SIZE as u64,
                        ),
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("grapix-mesh-pipeline-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipelines = std::array::from_fn(|blend_id| {
            std::array::from_fn(|cull_id| {
                let cull_mode = match cull_id {
                    0 => Some(wgpu::Face::Back),
                    1 => Some(wgpu::Face::Front),
                    _ => None,
                };
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(&format!(
                        "grapix-mesh-pipeline-blend-{blend_id}-cull-{cull_id}"
                    )),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("vs_main"),
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                        buffers: &[GpuMeshVertex::layout()],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some("fs_main"),
                        compilation_options: wgpu::PipelineCompilationOptions::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: RENDER_FORMAT,
                            blend: Some(blend_state_for_id(blend_id as u32)),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        // The camera uses a y-down scene up-vector. Its right axis is therefore
                        // negative X; scene_view_projection reflects clip X back to the Editor's
                        // left-to-right convention, which reverses winding once.
                        front_face: wgpu::FrontFace::Cw,
                        cull_mode,
                        ..Default::default()
                    },
                    depth_stencil: Some(wgpu::DepthStencilState {
                        format: DEPTH_FORMAT,
                        depth_write_enabled: true,
                        depth_compare: wgpu::CompareFunction::LessEqual,
                        stencil: wgpu::StencilState::default(),
                        bias: wgpu::DepthBiasState::default(),
                    }),
                    multisample: wgpu::MultisampleState::default(),
                    multiview: None,
                    cache: None,
                })
            })
        });

        Self {
            pipelines,
            bind_group_layout,
        }
    }

    pub fn prepare_frame(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &PreparedScene,
    ) -> MeshFrame {
        let view_projection = scene_view_projection(scene);
        let lighting_uniforms = build_scene_lighting_uniforms(scene);
        let lighting_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("grapix-scene-lighting-uniform-buffer"),
            contents: bytemuck::bytes_of(&lighting_uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let mut draws = Vec::new();
        for mesh in &scene.meshes {
            for surface in &mesh.surfaces {
                if surface.vertices.is_empty() || surface.indices.is_empty() {
                    continue;
                }
                let vertices: Vec<GpuMeshVertex> =
                    surface.vertices.iter().map(Into::into).collect();
                let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("grapix-mesh-vertex-buffer"),
                    contents: bytemuck::cast_slice(&vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                });
                let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("grapix-mesh-index-buffer"),
                    contents: bytemuck::cast_slice(&surface.indices),
                    usage: wgpu::BufferUsages::INDEX,
                });
                let uniforms = build_mesh_uniforms(mesh, surface, view_projection);
                let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("grapix-mesh-uniform-buffer"),
                    contents: bytemuck::bytes_of(&uniforms),
                    // COPY_DST so an animated transform can rewrite the model matrix in place
                    // instead of rebuilding the whole mesh frame.
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
                let texture = create_texture(
                    device,
                    queue,
                    surface.material.texture.as_ref(),
                    &format!("mesh texture {} {}", mesh.object_id, surface.slot_key),
                );
                let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                    label: Some("grapix-mesh-sampler"),
                    address_mode_u: address_mode(surface.material.wrap),
                    address_mode_v: address_mode(surface.material.wrap),
                    address_mode_w: wgpu::AddressMode::ClampToEdge,
                    mag_filter: filter_mode(surface.material.filtering),
                    min_filter: filter_mode(surface.material.filtering),
                    mipmap_filter: filter_mode(surface.material.filtering),
                    ..Default::default()
                });
                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("grapix-mesh-material-bind-group"),
                    layout: &self.bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&texture_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Sampler(&sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: lighting_buffer.as_entire_binding(),
                        },
                    ],
                });
                draws.push(MeshDraw {
                    object_id: mesh.object_id.clone(),
                    uniforms,
                    uniform_buffer,
                    vertex_buffer,
                    index_buffer,
                    bind_group,
                    index_count: surface.indices.len() as u32,
                    blend_mode: (surface.material.blend_mode as usize)
                        .min(BLEND_PIPELINE_COUNT - 1),
                    cull_mode: match surface.material.cull_mode {
                        PreparedCullMode::Back => 0,
                        PreparedCullMode::Front => 1,
                        PreparedCullMode::None => 2,
                    },
                });
            }
        }
        MeshFrame { draws }
    }

    pub fn draw<'pass>(&'pass self, pass: &mut wgpu::RenderPass<'pass>, frame: &'pass MeshFrame) {
        for draw in &frame.draws {
            pass.set_pipeline(&self.pipelines[draw.blend_mode][draw.cull_mode]);
            pass.set_bind_group(0, &draw.bind_group, &[]);
            pass.set_vertex_buffer(0, draw.vertex_buffer.slice(..));
            pass.set_index_buffer(draw.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..draw.index_count, 0, 0..1);
        }
    }
}

fn build_mesh_uniforms(
    mesh: &PreparedMesh,
    surface: &PreparedMeshSurface,
    view_projection: Mat4,
) -> MeshUniforms {
    let model = Mat4::from_cols_array(&mesh.model_transform);
    let normal_model = model.inverse().transpose();
    MeshUniforms {
        model: mesh.model_transform,
        view_projection: view_projection.to_cols_array(),
        normal_model: normal_model.to_cols_array(),
        base_color: surface.material.base_color_linear,
        material_params: [
            surface.material.metalness,
            surface.material.roughness,
            surface.material.alpha_cutoff,
            if surface.material.texture.is_some() {
                1.0
            } else {
                0.0
            },
        ],
        uv_scale_offset: [
            surface.material.uv_scale[0],
            surface.material.uv_scale[1],
            surface.material.uv_offset[0],
            surface.material.uv_offset[1],
        ],
        uv_rotation_pivot: [
            surface.material.uv_rotation_radians,
            surface.material.uv_pivot[0],
            surface.material.uv_pivot[1],
            if surface.material.lit { 1.0 } else { 0.0 },
        ],
        emissive: [
            surface.material.emissive_linear[0],
            surface.material.emissive_linear[1],
            surface.material.emissive_linear[2],
            surface.material.emissive_intensity,
        ],
    }
}

fn build_scene_lighting_uniforms(scene: &PreparedScene) -> SceneLightingUniforms {
    let camera_position = scene_camera_position(scene);
    let mut output = SceneLightingUniforms {
        params: [
            scene.lights.len().min(MAX_SCENE_LIGHTS) as f32,
            camera_position.x,
            camera_position.y,
            camera_position.z,
        ],
        lights: [SceneLightUniform {
            color_intensity: [0.0; 4],
            position_kind: [0.0; 4],
            direction_range: [0.0; 4],
            spot_decay: [0.0; 4],
        }; MAX_SCENE_LIGHTS],
    };
    let canvas_extent = scene.canvas_width.max(scene.canvas_height).max(1.0);
    let punctual_scale = canvas_extent * canvas_extent * PUNCTUAL_LIGHT_SCENE_SCALE;
    for (index, light) in scene.lights.iter().take(MAX_SCENE_LIGHTS).enumerate() {
        let (kind, intensity) = match light.kind {
            PreparedLightKind::Directional => (0.0, light.intensity),
            PreparedLightKind::Point => (1.0, light.intensity * punctual_scale),
            PreparedLightKind::Spot => (2.0, light.intensity * punctual_scale),
        };
        output.lights[index] = SceneLightUniform {
            color_intensity: [
                light.color_linear[0],
                light.color_linear[1],
                light.color_linear[2],
                intensity,
            ],
            position_kind: [
                light.position[0],
                light.position[1],
                light.position[2],
                kind,
            ],
            direction_range: [
                light.direction[0],
                light.direction[1],
                light.direction[2],
                light.range,
            ],
            spot_decay: [light.spot_outer_cos, light.spot_inner_cos, light.decay, 0.0],
        };
    }
    output
}

fn scene_view_projection(scene: &PreparedScene) -> Mat4 {
    let width = scene.canvas_width.max(1.0);
    let height = scene.canvas_height.max(1.0);
    let fov = 45.0_f32.to_radians();
    let camera_position = scene_camera_position(scene);
    let focal_distance = camera_position.z;
    let near = (focal_distance / 2000.0).max(1.0);
    let far = focal_distance + 20_000.0;
    let projection = Mat4::perspective_rh(fov, width / height, near, far);
    let view = Mat4::look_at_rh(
        camera_position,
        Vec3::new(width * 0.5, height * 0.5, 0.0),
        Vec3::new(0.0, -1.0, 0.0),
    );
    // A +Z camera with a y-down up-vector has a -X right axis. Correct that camera-space
    // reflection here so authored X=0 is the left edge, as it is in the Editor and quad path.
    Mat4::from_scale(Vec3::new(-1.0, 1.0, 1.0)) * projection * view
}

fn scene_camera_position(scene: &PreparedScene) -> Vec3 {
    let width = scene.canvas_width.max(1.0);
    let height = scene.canvas_height.max(1.0);
    let fov = 45.0_f32.to_radians();
    let focal_distance = (height * 0.5) / (fov * 0.5).tan();
    Vec3::new(width * 0.5, height * 0.5, focal_distance)
}

fn create_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    prepared: Option<&PreparedTexture>,
    label: &str,
) -> wgpu::Texture {
    let (width, height, pixels, srgb) = match prepared {
        Some(texture) => (
            texture.width.max(1),
            texture.height.max(1),
            texture.rgba8.as_slice(),
            texture.srgb,
        ),
        None => (1, 1, [255_u8, 255, 255, 255].as_slice(), true),
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: if srgb {
            wgpu::TextureFormat::Rgba8UnormSrgb
        } else {
            wgpu::TextureFormat::Rgba8Unorm
        },
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 4),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    texture
}

fn address_mode(mode: PreparedWrapMode) -> wgpu::AddressMode {
    match mode {
        PreparedWrapMode::Clamp => wgpu::AddressMode::ClampToEdge,
        PreparedWrapMode::Repeat => wgpu::AddressMode::Repeat,
        PreparedWrapMode::MirrorRepeat => wgpu::AddressMode::MirrorRepeat,
    }
}

fn filter_mode(mode: PreparedFilterMode) -> wgpu::FilterMode {
    match mode {
        PreparedFilterMode::Linear => wgpu::FilterMode::Linear,
        PreparedFilterMode::Nearest => wgpu::FilterMode::Nearest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::prepare_scene;
    use serde_json::json;

    #[test]
    fn mesh_uniform_contract_is_272_bytes() {
        assert_eq!(MESH_UNIFORMS_SIZE, 272);
    }

    #[test]
    fn scene_lighting_uniform_contract_is_tightly_aligned() {
        assert_eq!(SCENE_LIGHT_UNIFORM_SIZE, 64);
        assert_eq!(SCENE_LIGHTING_UNIFORMS_SIZE, 1040);
    }

    #[test]
    fn native_camera_projects_scene_center_to_clip_center() {
        let scene = PreparedScene {
            scene_id: "test".to_string(),
            name: "test".to_string(),
            revision: "1".to_string(),
            canvas_width: 1920.0,
            canvas_height: 1080.0,
            background_linear_premultiplied: [0.0; 4],
            background_gradient: crate::scene::PreparedGradient::default(),
            rects: Vec::new(),
            texts: Vec::new(),
            fonts: Vec::new(),
            meshes: Vec::new(),
            lights: Vec::new(),
            object_count: 0,
            warnings: Vec::new(),
            take_blockers: Vec::new(),
            source_document: serde_json::json!({}),
        };
        let projected = scene_view_projection(&scene) * glam::Vec4::new(960.0, 540.0, 0.0, 1.0);
        let ndc = projected / projected.w;
        assert!(ndc.x.abs() < 1e-5);
        assert!(ndc.y.abs() < 1e-5);
    }

    #[test]
    fn lighting_uniform_preserves_kind_and_editor_punctual_scale() {
        let scene_json = json!({
            "id": "lights",
            "name": "Lights",
            "version": 1,
            "canvas": { "width": 96, "height": 64, "background": "#000000" },
            "materials": [],
            "materialInstances": [],
            "objects": [
                {
                    "id": "directional",
                    "type": "light",
                    "lightKind": "directional",
                    "x": 48,
                    "y": 32,
                    "zDepth": 100,
                    "visible": true,
                    "opacity": 1,
                    "intensity": 2,
                    "color": "#ffffff"
                },
                {
                    "id": "point",
                    "type": "light",
                    "lightKind": "point",
                    "x": 48,
                    "y": 32,
                    "zDepth": 100,
                    "visible": true,
                    "opacity": 0.5,
                    "intensity": 2,
                    "color": "#ffffff",
                    "range": 500,
                    "decay": 2
                }
            ],
            "updatedAt": "1"
        });
        let scene = prepare_scene(&scene_json).expect("light scene must prepare");
        let uniforms = build_scene_lighting_uniforms(&scene);
        assert_eq!(uniforms.params[0], 2.0);
        assert_eq!(uniforms.params[1], 48.0);
        assert_eq!(uniforms.params[2], 32.0);
        let expected_camera_z = 32.0 / (45.0_f32.to_radians() * 0.5).tan();
        assert!((uniforms.params[3] - expected_camera_z).abs() < 1e-4);
        assert_eq!(uniforms.lights[0].position_kind[3], 0.0);
        assert_eq!(uniforms.lights[0].color_intensity[3], 2.0);
        assert_eq!(uniforms.lights[1].position_kind[3], 1.0);
        let expected_point_intensity = 96.0_f32.powi(2) * PUNCTUAL_LIGHT_SCENE_SCALE;
        assert!((uniforms.lights[1].color_intensity[3] - expected_point_intensity).abs() < 1e-4);
    }

    #[test]
    fn legacy_solid_material_and_unassigned_faces_use_physical_lighting() {
        let scene_json = json!({
            "id": "material-lighting",
            "name": "Material lighting",
            "version": 1,
            "canvas": { "width": 96, "height": 96, "background": "#000000" },
            "assets": [],
            "materials": [{
                "materialId": "solid",
                "name": "Solid",
                "type": "solid-color",
                "opacity": 1,
                "parameters": {
                    "baseColor": "#ffffff",
                    "emissiveColor": "#ff0000",
                    "emissiveIntensity": 2
                }
            }],
            "materialInstances": [],
            "objects": [{
                "id": "cube",
                "type": "mesh",
                "meshKind": "cube",
                "x": 48,
                "y": 48,
                "zDepth": 0,
                "width": 40,
                "height": 40,
                "depth": 40,
                "visible": true,
                "opacity": 1,
                "fill": "#808080",
                "materialSlots": { "main": "solid" }
            }],
            "updatedAt": "1"
        });
        let scene = prepare_scene(&scene_json).expect("mesh scene must prepare");
        let mesh = &scene.meshes[0];
        let primary = mesh
            .surfaces
            .iter()
            .find(|surface| surface.slot_key == "main")
            .unwrap();
        let side = mesh
            .surfaces
            .iter()
            .find(|surface| surface.slot_key == "face:right")
            .unwrap();
        assert_eq!(
            build_mesh_uniforms(mesh, primary, Mat4::IDENTITY).uv_rotation_pivot[3],
            1.0
        );
        assert_eq!(
            build_mesh_uniforms(mesh, side, Mat4::IDENTITY).uv_rotation_pivot[3],
            1.0
        );
        assert_eq!(
            build_mesh_uniforms(mesh, primary, Mat4::IDENTITY).emissive,
            [1.0, 0.0, 0.0, 2.0]
        );
    }

    #[test]
    fn shared_mesh_shader_declares_view_dependent_cook_torrance_brdf() {
        for function in [
            "fn distribution_ggx",
            "fn geometry_smith",
            "fn fresnel_schlick",
            "fn evaluate_direct_brdf",
        ] {
            assert!(
                MESH_PBR_WGSL.contains(function),
                "physical shader is missing {function}"
            );
        }
        assert!(MESH_PBR_WGSL.contains("scene_lighting.params.yzw"));
        assert!(MESH_PBR_WGSL.contains("view_direction"));
        assert!(
            !MESH_PBR_WGSL.contains("pow(lambert"),
            "legacy view-independent fake specular returned"
        );
    }
}
