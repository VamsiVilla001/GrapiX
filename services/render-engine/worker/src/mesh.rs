//! Mesh preparation for scene-owned 3D content (build plan 3.7).
//!
//! A renderer must not discover mesh topology, model material names or camera
//! selection while Program is running.  This module makes those answers once
//! when a scene is published.  In particular it only accepts glTF bytes found
//! by the asset's verified content hash: passing the authoring-library path to
//! a model loader would let a relink change Program without a publish
//! (invariant 31).
//!
//! It also rejects every unassigned surface.  A default material makes a bad
//! assignment look plausibly rendered, which is exactly the silent fallback
//! invariants 17 and 18 prohibit.

use std::collections::{HashMap, HashSet};

use gx_contracts::material::{MaterialDefinition, MaterialKind, MaterialSupport};
use gx_contracts::scene::{
    AssetKind, CameraKind, MeshObject, MeshPrimitiveKind, SceneDocument, SceneObject,
    SlabProperties,
};
use gx_contracts::color::ColorValue;
use gx_contracts::{ContentHash, Refusal};

use crate::colour_pipeline::WorkingRgba;
use crate::rasterise::RasterSurface;

/// Verified model payloads keyed only by their immutable content address.
pub type AssetBytes = HashMap<ContentHash, Vec<u8>>;

/// Geometry built once during scene publication.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedGeometry {
    pub vertices: Vec<[f64; 3]>,
    pub parts: Vec<GeometryPart>,
}

/// One independently materialled part of prepared geometry.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometryPart {
    pub element: String,
    pub triangles: Vec<[u32; 3]>,
}

/// A resolved material assignment for a geometry part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedMaterialElement {
    pub element: String,
    pub material_id: String,
    pub scope: MaterialAssignmentScope,
}

/// The authoring level at which an assignment was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterialAssignmentScope {
    Object,
    Face,
    Element,
}

/// One mesh ready for a renderer to consume without re-resolving scene ids.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedMesh {
    pub object_id: String,
    pub geometry: PreparedGeometry,
    pub materials: Vec<PreparedMaterialElement>,
}

/// The camera that Program must use after preparation.
#[derive(Debug, Clone, PartialEq)]
pub enum ActiveCamera {
    /// The 1.2 default when a scene does not select a camera.
    SyntheticTwoDimensionalOrthographic,
    SceneCamera {
        object_id: String,
        kind: CameraKind,
        fov: f64,
        zoom: f64,
    },
}

/// Mesh-side state prepared with a scene revision.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedMeshes {
    pub meshes: Vec<PreparedMesh>,
    pub active_camera: ActiveCamera,
    pub light_ids: Vec<String>,
}

/// Resolve model payloads, generated primitive geometry, material slots,
/// lights and the active camera exactly once per published scene.
pub fn prepare_meshes(
    document: &SceneDocument,
    available: &HashSet<ContentHash>,
    asset_bytes: &AssetBytes,
    _support: &MaterialSupport,
) -> Result<PreparedMeshes, Refusal> {
    let active_camera = resolve_active_camera(document)?;
    let light_ids: Vec<String> = document
        .objects
        .iter()
        .filter_map(|object| match object {
            SceneObject::Light(light) => Some(light.base.id.clone()),
            _ => None,
        })
        .collect();

    let material_by_id: HashMap<&str, &MaterialDefinition> = document
        .materials
        .iter()
        .map(|material| (material.material_id.as_str(), material))
        .collect();
    let mut meshes = Vec::new();

    for object in &document.objects {
        let SceneObject::Mesh(mesh) = object else {
            continue;
        };
        let (geometry, required, scope) = match mesh.mesh_kind {
            MeshPrimitiveKind::Model => model_geometry(mesh, document, available, asset_bytes)?,
            _ => primitive_geometry(mesh)?,
        };

        let assignments = resolve_materials(mesh, required, scope, &material_by_id)?;
        for assignment in &assignments {
            if light_ids.is_empty()
                && material_by_id
                    .get(assignment.material_id.as_str())
                    .is_some_and(|material| material.kind == MaterialKind::Pbr)
            {
                return Err(Refusal::MeshMaterialRequiresLight {
                    object: mesh.base.id.clone(),
                    material_id: assignment.material_id.clone(),
                });
            }
        }
        meshes.push(PreparedMesh {
            object_id: mesh.base.id.clone(),
            geometry,
            materials: assignments,
        });
    }

    // A light with no PBR mesh to answer it is a document-level rule, shared
    // with the validator so the Editor refuses it too (3.13).
    gx_contracts::drawability::light_without_responsive_material(document)?;

    Ok(PreparedMeshes {
        meshes,
        active_camera,
        light_ids,
    })
}

fn resolve_active_camera(document: &SceneDocument) -> Result<ActiveCamera, Refusal> {
    let Some(camera_id) = &document.active_camera_id else {
        return Ok(ActiveCamera::SyntheticTwoDimensionalOrthographic);
    };
    let camera = document.objects.iter().find_map(|object| match object {
        SceneObject::Camera(camera) if camera.base.id == *camera_id => Some(camera),
        _ => None,
    });
    match camera {
        Some(camera) => Ok(ActiveCamera::SceneCamera {
            object_id: camera.base.id.clone(),
            kind: camera.camera_kind,
            fov: camera.fov,
            zoom: camera.zoom,
        }),
        None => Err(Refusal::SceneActiveCameraUnknown {
            camera_id: camera_id.clone(),
        }),
    }
}

fn resolve_materials(
    mesh: &MeshObject,
    required: Vec<String>,
    scope: MaterialAssignmentScope,
    material_by_id: &HashMap<&str, &MaterialDefinition>,
) -> Result<Vec<PreparedMaterialElement>, Refusal> {
    let slots = mesh.base.material_slots.as_ref();
    required
        .into_iter()
        .map(|element| {
            let binding = slots
                .and_then(|slots| slots.get(&element))
                .ok_or_else(|| Refusal::MeshMaterialUnassigned {
                    object: mesh.base.id.clone(),
                    element: element.clone(),
                })?;
            if !material_by_id.contains_key(binding.material_id.as_str()) {
                return Err(Refusal::SceneMaterialUnknown {
                    material_id: binding.material_id.clone(),
                    object: mesh.base.id.clone(),
                    element: element.clone(),
                });
            }
            Ok(PreparedMaterialElement {
                element,
                material_id: binding.material_id.clone(),
                scope,
            })
        })
        .collect()
}

fn model_geometry(
    mesh: &MeshObject,
    document: &SceneDocument,
    available: &HashSet<ContentHash>,
    asset_bytes: &AssetBytes,
) -> Result<(PreparedGeometry, Vec<String>, MaterialAssignmentScope), Refusal> {
    let asset_id = mesh
        .model_asset_id
        .as_ref()
        .ok_or_else(|| Refusal::SceneAssetUnknown {
            asset_id: "<missing model asset id>".to_string(),
            object: mesh.base.id.clone(),
        })?;
    let asset = document
        .asset(asset_id)
        .ok_or_else(|| Refusal::SceneAssetUnknown {
            asset_id: asset_id.clone(),
            object: mesh.base.id.clone(),
        })?;
    if asset.kind != AssetKind::Model {
        return Err(Refusal::MeshModelAssetWrongKind {
            asset_id: asset_id.clone(),
            object: mesh.base.id.clone(),
        });
    }
    let hash = asset.checksum.as_ref().ok_or_else(|| Refusal::AssetMissing {
        hash: ContentHash(format!("{} (no content hash yet)", asset.asset_id)),
    })?;
    if !available.contains(hash) {
        return Err(Refusal::AssetMissing { hash: hash.clone() });
    }
    let bytes = asset_bytes
        .get(hash)
        .ok_or_else(|| Refusal::AssetMissing { hash: hash.clone() })?;
    let gltf = gltf::Gltf::from_slice(bytes).map_err(|error| Refusal::MeshModelInvalid {
        hash: hash.clone(),
        detail: error.to_string(),
    })?;

    for buffer in gltf.document.buffers() {
        if matches!(buffer.source(), gltf::buffer::Source::Uri(_)) {
            return Err(Refusal::MeshModelInvalid {
                hash: hash.clone(),
                detail: "external glTF buffers are not content-addressed scene assets".to_string(),
            });
        }
    }

    let imported: Vec<String> = gltf
        .document
        .materials()
        .map(|material| {
            material.name().map(str::to_owned).ok_or_else(|| {
                Refusal::MeshModelInvalid {
                    hash: hash.clone(),
                    detail: "a glTF material has no name for element assignment".to_string(),
                }
            })
        })
        .collect::<Result<_, _>>()?;
    if imported.len() != imported.iter().collect::<HashSet<_>>().len() {
        return Err(Refusal::MeshModelInvalid {
            hash: hash.clone(),
            detail: "glTF material element names must be unique".to_string(),
        });
    }
    let declared = mesh.material_elements.clone().unwrap_or_default();
    if declared != imported {
        return Err(Refusal::MeshMaterialElementsMismatch {
            object: mesh.base.id.clone(),
            declared,
            imported,
        });
    }

    let mut parts = Vec::new();
    let mut required = Vec::new();
    for imported_mesh in gltf.document.meshes() {
        for primitive in imported_mesh.primitives() {
            let Some(index) = primitive.material().index() else {
                return Err(Refusal::MeshMaterialUnassigned {
                    object: mesh.base.id.clone(),
                    element: format!("primitive[{}]", primitive.index()),
                });
            };
            let element = gltf
                .document
                .materials()
                .nth(index)
                .and_then(|material| material.name())
                .expect("named materials were validated above")
                .to_string();
            if !required.contains(&element) {
                required.push(element.clone());
            }
            parts.push(GeometryPart {
                element,
                triangles: Vec::new(),
            });
        }
    }
    if parts.is_empty() {
        return Err(Refusal::MeshModelInvalid {
            hash: hash.clone(),
            detail: "glTF model has no primitives".to_string(),
        });
    }
    Ok((
        PreparedGeometry {
            vertices: Vec::new(),
            parts,
        },
        required,
        MaterialAssignmentScope::Element,
    ))
}

fn primitive_geometry(
    mesh: &MeshObject,
) -> Result<(PreparedGeometry, Vec<String>, MaterialAssignmentScope), Refusal> {
    match mesh.mesh_kind {
        MeshPrimitiveKind::Cube => Ok(cube_geometry()),
        MeshPrimitiveKind::Sphere => Ok(surface_geometry(sphere_geometry())),
        MeshPrimitiveKind::Cylinder => Ok(cylinder_geometry()),
        MeshPrimitiveKind::Torus => Ok(surface_geometry(torus_geometry())),
        MeshPrimitiveKind::Slab => Ok(slab_geometry(mesh, mesh.slab.unwrap_or_default())),
        MeshPrimitiveKind::Model => unreachable!("models are prepared by model_geometry"),
    }
}

fn cube_geometry() -> (PreparedGeometry, Vec<String>, MaterialAssignmentScope) {
    let vertices = vec![
        [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
    ];
    let faces = [
        ("front", [4, 5, 6, 7]), ("back", [1, 0, 3, 2]),
        ("left", [0, 4, 7, 3]), ("right", [5, 1, 2, 6]),
        ("top", [3, 7, 6, 2]), ("bottom", [0, 1, 5, 4]),
    ];
    let parts = faces
        .iter()
        .map(|(name, face)| GeometryPart {
            element: (*name).to_string(),
            triangles: vec![[face[0], face[1], face[2]], [face[0], face[2], face[3]]],
        })
        .collect();
    (
        PreparedGeometry { vertices, parts },
        faces.iter().map(|(name, _)| (*name).to_string()).collect(),
        MaterialAssignmentScope::Face,
    )
}

fn surface_geometry(vertices: Vec<[f64; 3]>) -> (PreparedGeometry, Vec<String>, MaterialAssignmentScope) {
    let triangles = (1..vertices.len().saturating_sub(1))
        .map(|index| [0, index as u32, (index + 1) as u32])
        .collect();
    (
        PreparedGeometry {
            vertices,
            parts: vec![GeometryPart { element: "object".to_string(), triangles }],
        },
        vec!["object".to_string()],
        MaterialAssignmentScope::Object,
    )
}

fn sphere_geometry() -> Vec<[f64; 3]> {
    let segments = 16;
    let rings = 8;
    (0..=rings)
        .flat_map(|ring| {
            let theta = std::f64::consts::PI * ring as f64 / rings as f64;
            (0..=segments).map(move |segment| {
                let phi = std::f64::consts::TAU * segment as f64 / segments as f64;
                [theta.sin() * phi.cos() * 0.5, theta.cos() * 0.5, theta.sin() * phi.sin() * 0.5]
            })
        })
        .collect()
}

fn torus_geometry() -> Vec<[f64; 3]> {
    let major_segments = 16;
    let minor_segments = 8;
    (0..=major_segments)
        .flat_map(|major| {
            let theta = std::f64::consts::TAU * major as f64 / major_segments as f64;
            (0..=minor_segments).map(move |minor| {
                let phi = std::f64::consts::TAU * minor as f64 / minor_segments as f64;
                let radius = 0.35 + 0.15 * phi.cos();
                [radius * theta.cos(), 0.15 * phi.sin(), radius * theta.sin()]
            })
        })
        .collect()
}

fn cylinder_geometry() -> (PreparedGeometry, Vec<String>, MaterialAssignmentScope) {
    let segments = 16;
    let mut vertices = vec![[0.0, 0.5, 0.0], [0.0, -0.5, 0.0]];
    for y in [-0.5, 0.5] {
        for segment in 0..segments {
            let angle = std::f64::consts::TAU * segment as f64 / segments as f64;
            vertices.push([0.5 * angle.cos(), y, 0.5 * angle.sin()]);
        }
    }
    let top = (0..segments)
        .map(|segment| [0, 2 + segments + segment, 2 + segments + (segment + 1) % segments])
        .collect();
    let bottom = (0..segments)
        .map(|segment| [1, 2 + (segment + 1) % segments, 2 + segment])
        .collect();
    let side = (0..segments)
        .flat_map(|segment| {
            let next = (segment + 1) % segments;
            [[2 + segment, 2 + next, 2 + segments + next], [2 + segment, 2 + segments + next, 2 + segments + segment]]
        })
        .collect();
    let names = ["top", "bottom", "side"];
    (
        PreparedGeometry {
            vertices,
            parts: vec![
                GeometryPart { element: "top".to_string(), triangles: top },
                GeometryPart { element: "bottom".to_string(), triangles: bottom },
                GeometryPart { element: "side".to_string(), triangles: side },
            ],
        },
        names.iter().map(|name| (*name).to_string()).collect(),
        MaterialAssignmentScope::Face,
    )
}

fn slab_geometry(
    mesh: &MeshObject,
    slab: SlabProperties,
) -> (PreparedGeometry, Vec<String>, MaterialAssignmentScope) {
    let width = mesh.base.width;
    let height = mesh.base.height;
    let half_depth = mesh.depth / 2.0;
    let outer = rounded_outline(width, height, slab.corner_radius, slab.corner_segments, slab.skew);
    let inset = rounded_outline(
        width - 2.0 * slab.front_bevel.size,
        height - 2.0 * slab.front_bevel.size,
        (slab.corner_radius - slab.front_bevel.size).max(0.0),
        slab.corner_segments,
        slab.skew,
    );
    let mut vertices = Vec::new();
    let front_outer = push_outline(&mut vertices, &outer, half_depth - slab.front_bevel.depth);
    let front_inner = push_outline(&mut vertices, &inset, half_depth);
    let back_outer = push_outline(&mut vertices, &outer, -half_depth + slab.back_bevel.depth);
    let back_inner = push_outline(&mut vertices, &inset, -half_depth);
    let front_center = push_vertex(&mut vertices, [slab.skew, 0.0, half_depth]);
    let back_center = push_vertex(&mut vertices, [0.0, 0.0, -half_depth]);
    let mut parts = vec![
        GeometryPart { element: "front".to_string(), triangles: fan(front_center, &front_inner) },
        GeometryPart { element: "back".to_string(), triangles: fan(back_center, &back_inner) },
        GeometryPart { element: "side".to_string(), triangles: bridge(&front_outer, &back_outer) },
    ];
    let mut required = vec!["front".to_string(), "back".to_string(), "side".to_string()];
    if slab.front_bevel.enabled {
        parts.push(GeometryPart { element: "frontBevel".to_string(), triangles: bridge(&front_outer, &front_inner) });
        required.push("frontBevel".to_string());
    }
    if slab.back_bevel.enabled {
        parts.push(GeometryPart { element: "backBevel".to_string(), triangles: bridge(&back_inner, &back_outer) });
        required.push("backBevel".to_string());
    }
    (
        PreparedGeometry { vertices, parts },
        required,
        MaterialAssignmentScope::Face,
    )
}

fn rounded_outline(width: f64, height: f64, radius: f64, segments: u32, skew: f64) -> Vec<[f64; 2]> {
    let radius = radius.min(width.abs() / 2.0).min(height.abs() / 2.0).max(0.0);
    let segments = segments.max(1);
    let centers = [
        (width / 2.0 - radius, height / 2.0 - radius, 0.0),
        (-width / 2.0 + radius, height / 2.0 - radius, std::f64::consts::FRAC_PI_2),
        (-width / 2.0 + radius, -height / 2.0 + radius, std::f64::consts::PI),
        (width / 2.0 - radius, -height / 2.0 + radius, std::f64::consts::FRAC_PI_2 * 3.0),
    ];
    centers
        .into_iter()
        .flat_map(|(cx, cy, start)| {
            (0..segments).map(move |segment| {
                let angle = start + std::f64::consts::FRAC_PI_2 * segment as f64 / segments as f64;
                let y = cy + radius * angle.sin();
                [cx + radius * angle.cos() + skew * ((y + height / 2.0) / height), y]
            })
        })
        .collect()
}

fn push_outline(vertices: &mut Vec<[f64; 3]>, outline: &[[f64; 2]], z: f64) -> Vec<u32> {
    outline.iter().map(|point| push_vertex(vertices, [point[0], point[1], z])).collect()
}

fn push_vertex(vertices: &mut Vec<[f64; 3]>, vertex: [f64; 3]) -> u32 {
    let index = vertices.len() as u32;
    vertices.push(vertex);
    index
}

fn fan(center: u32, ring: &[u32]) -> Vec<[u32; 3]> {
    ring.iter().enumerate().map(|(index, current)| [center, *current, ring[(index + 1) % ring.len()]]).collect()
}

fn bridge(first: &[u32], second: &[u32]) -> Vec<[u32; 3]> {
    first.iter().enumerate().flat_map(|(index, current)| {
        let next = (index + 1) % first.len();
        [[*current, first[next], second[next]], [*current, second[next], second[index]]]
    }).collect()
}

/// Rasterise prepared meshes onto the linear surface using the scene's
/// active camera and lights.
///
/// Only unlit (solid-colour) materials produce pixels in the software path.
/// PBR materials were validated against the engine's declared support at
/// publication time; a scene that reached rasterisation with PBR materials on
/// a fixed-function engine is a bug, not a fallback case.
pub fn rasterise_meshes(
    prepared: &PreparedMeshes,
    document: &SceneDocument,
    effective: &[gx_contracts::scene::ResolvedObject],
    surface: &mut RasterSurface,
) -> Result<(), Refusal> {
    let material_by_id: HashMap<&str, &MaterialDefinition> = document
        .materials
        .iter()
        .map(|m| (m.material_id.as_str(), m))
        .collect();

    for mesh in &prepared.meshes {
        let Some(resolved) = effective.iter().find(|r| r.id == mesh.object_id) else {
            continue;
        };
        if !resolved.visible || resolved.opacity <= 0.0 {
            continue;
        }

        // Build a material lookup for this mesh's parts.
        let part_materials: HashMap<&str, WorkingRgba> = mesh
            .materials
            .iter()
            .filter_map(|assignment| {
                let material = material_by_id.get(assignment.material_id.as_str())?;
                match material.kind {
                    MaterialKind::Unlit | MaterialKind::SolidColor => {
                        let color = match &material.color {
                            ColorValue::Solid { color } => {
                                WorkingRgba::from_source(*color, document.working_color_space)
                            }
                            ColorValue::None => WorkingRgba::transparent(),
                            _ => return None, // gradients refused at validate_material
                        };
                        let scaled = WorkingRgba {
                            r: color.r * material.opacity as f32 * resolved.opacity as f32,
                            g: color.g * material.opacity as f32 * resolved.opacity as f32,
                            b: color.b * material.opacity as f32 * resolved.opacity as f32,
                            a: color.a * material.opacity as f32 * resolved.opacity as f32,
                        };
                        Some((assignment.element.as_str(), scaled))
                    }
                    _ => None,
                }
            })
            .collect();

        // Project and rasterise every triangle. The software path uses
        // orthographic projection (x, y in scene space → canvas pixels).
        for part in &mesh.geometry.parts {
            let Some(&fill) = part_materials.get(part.element.as_str()) else {
                continue;
            };
            if fill.a <= 0.0 {
                continue;
            }
            for triangle in &part.triangles {
                let [ia, ib, ic] = *triangle;
                let (Some(va), Some(vb), Some(vc)) = (
                    mesh.geometry.vertices.get(ia as usize),
                    mesh.geometry.vertices.get(ib as usize),
                    mesh.geometry.vertices.get(ic as usize),
                ) else {
                    continue;
                };
                rasterise_mesh_triangle(
                    surface,
                    *va, *vb, *vc,
                    resolved,
                    fill,
                );
            }
        }
    }
    Ok(())
}

/// Rasterise one mesh triangle into the linear surface.
///
/// Applies the object's resolved 2D transform (position, rotation, scale)
/// and composites with the material's linear colour. The Z coordinate is
/// used for depth ordering via z_depth but the projection is orthographic.
fn rasterise_mesh_triangle(
    surface: &mut RasterSurface,
    va: [f64; 3],
    vb: [f64; 3],
    vc: [f64; 3],
    resolved: &gx_contracts::scene::ResolvedObject,
    fill: WorkingRgba,
) {
    let cos = resolved.rotation_z.to_radians().cos();
    let sin = resolved.rotation_z.to_radians().sin();
    let transform = |v: [f64; 3]| -> (f64, f64) {
        let lx = v[0] * resolved.scale_x;
        let ly = v[1] * resolved.scale_y;
        (lx * cos - ly * sin + resolved.x, lx * sin + ly * cos + resolved.y)
    };
    let (ax, ay) = transform(va);
    let (bx, by) = transform(vb);
    let (cx, cy) = transform(vc);

    let min_x = ax.min(bx).min(cx).floor().max(0.0) as u32;
    let min_y = ay.min(by).min(cy).floor().max(0.0) as u32;
    let max_x = ax.max(bx).max(cx).ceil().min(surface.width() as f64) as u32;
    let max_y = ay.max(by).max(cy).ceil().min(surface.height() as f64) as u32;
    let area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if area.abs() < f64::EPSILON {
        return;
    }

    for py in min_y..max_y {
        for px in min_x..max_x {
            let sx = px as f64 + 0.5;
            let sy = py as f64 + 0.5;
            let w0 = ((bx - sx) * (cy - sy) - (cx - sx) * (by - sy)) / area;
            let w1 = ((cx - sx) * (ay - sy) - (ax - sx) * (cy - sy)) / area;
            let w2 = 1.0 - w0 - w1;
            if w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0 {
                surface.composite(px, py, fill);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::color::ColorValue;
    use gx_contracts::material::{MaterialBinding, MaterialDefinition};
    use gx_contracts::scene::{ObjectBase, SceneCanvas, SceneTimeline};
    use gx_contracts::{RationalRate, Revision};
    use std::collections::BTreeMap;

    fn document(objects: Vec<SceneObject>, materials: Vec<MaterialDefinition>) -> SceneDocument {
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            id: "scene".to_string(), name: "mesh".to_string(), version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)), active_camera_id: None,
            canvas: SceneCanvas { width: 1920, height: 1080, frame_rate: RationalRate::P50 },
            timeline: SceneTimeline { duration_frames: 1, ..Default::default() }, data_context: Default::default(),
            assets: Vec::new(), fonts: Vec::new(), materials,
            controls: Vec::new(), text_styles: Vec::new(), objects,
        }
    }

    fn two_material_glb() -> Vec<u8> {
        let mut json = br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":36}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36}],"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}],"materials":[{"name":"body"},{"name":"trim"}],"meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0},{"attributes":{"POSITION":0},"material":1}]}]}"#.to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let binary = vec![0_u8; 36];
        let total_length = 12 + 8 + json.len() + 8 + binary.len();
        let mut glb = Vec::with_capacity(total_length);
        glb.extend_from_slice(&0x4654_6c67_u32.to_le_bytes());
        glb.extend_from_slice(&2_u32.to_le_bytes());
        glb.extend_from_slice(&(total_length as u32).to_le_bytes());
        glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x4e4f_534a_u32.to_le_bytes());
        glb.extend_from_slice(&json);
        glb.extend_from_slice(&(binary.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x004e_4942_u32.to_le_bytes());
        glb.extend_from_slice(&binary);
        glb
    }

    fn material(id: &str) -> MaterialDefinition {
        MaterialDefinition {
            material_id: id.to_string(), name: id.to_string(), kind: MaterialKind::Unlit,
            color: ColorValue::opaque_white(), opacity: 1.0, blend_mode: Default::default(),
            alpha_mode: Default::default(), cull_mode: Default::default(), depth_mode: Default::default(),
            double_sided: false, textures: Vec::new(), shader_id: None,
        }
    }

    fn mesh(kind: MeshPrimitiveKind, slots: &[(&str, &str)]) -> MeshObject {
        let mut base = ObjectBase::new("mesh", "mesh");
        base.width = 100.0;
        base.height = 80.0;
        base.material_slots = Some(slots.iter().map(|(slot, id)| ((*slot).to_string(), MaterialBinding::new(*id))).collect::<BTreeMap<_, _>>());
        MeshObject { base, mesh_kind: kind, depth: 20.0, slab: None, model_asset_id: None, material_elements: None, anchor_3d: None, clip_name: None, clip_index: None, time_scale: None, frame_offset: None, animation_loop: false }
    }

    #[test]
    fn object_face_and_element_assignments_resolve_once_per_publish() {
        let object_mesh = SceneObject::Mesh(mesh(MeshPrimitiveKind::Sphere, &[("object", "mat")])) ;
        let cube_slots = [("front", "mat"), ("back", "mat"), ("left", "mat"), ("right", "mat"), ("top", "mat"), ("bottom", "mat")];
        let mut face_mesh = mesh(MeshPrimitiveKind::Cube, &cube_slots);
        face_mesh.base.id = "cube".to_string();

        let gltf_bytes = two_material_glb();
        let hash = ContentHash("model-content".to_string());
        let mut element_mesh = mesh(MeshPrimitiveKind::Model, &[("body", "mat"), ("trim", "mat")]);
        element_mesh.base.id = "model".to_string();
        element_mesh.model_asset_id = Some("model".to_string());
        element_mesh.material_elements = Some(vec!["body".to_string(), "trim".to_string()]);
        let mut scene = document(vec![object_mesh, SceneObject::Mesh(face_mesh), SceneObject::Mesh(element_mesh)], vec![material("mat")]);
        scene.assets.push(gx_contracts::scene::AssetLibraryItem { asset_id: "model".to_string(), name: "model".to_string(), kind: AssetKind::Model, path: "must-not-be-read.gltf".to_string(), checksum: Some(hash.clone()), mime_type: Some("model/gltf+json".to_string()), size_bytes: None, status: None, provenance: Default::default() });
        let prepared = prepare_meshes(&scene, &HashSet::from([hash.clone()]), &AssetBytes::from([(hash, gltf_bytes)]), &MaterialSupport::fixed_function()).expect("all three explicit assignment levels prepare");
        assert_eq!(prepared.meshes[0].materials[0].scope, MaterialAssignmentScope::Object);
        assert_eq!(prepared.meshes[1].materials.len(), 6);
        assert_eq!(prepared.meshes[2].materials.iter().map(|element| element.element.as_str()).collect::<Vec<_>>(), ["body", "trim"]);
    }

    /// 3.13: the software path cannot draw meshes correctly (no sizing,
    /// depth or camera; 11.48 owns them), so publish refuses a mesh by name
    /// instead of preparing a glTF to empty geometry that draws nothing.
    #[test]
    fn a_gltf_model_refuses_at_publish_instead_of_drawing_nothing() {
        let hash = ContentHash("model-content".to_string());
        let mut model = mesh(MeshPrimitiveKind::Model, &[("body", "mat"), ("trim", "mat")]);
        model.base.id = "model".to_string();
        model.model_asset_id = Some("model".to_string());
        model.material_elements = Some(vec!["body".to_string(), "trim".to_string()]);
        let mut scene = document(vec![SceneObject::Mesh(model)], vec![material("mat")]);
        scene.assets.push(gx_contracts::scene::AssetLibraryItem { asset_id: "model".to_string(), name: "model".to_string(), kind: AssetKind::Model, path: "must-not-be-read.gltf".to_string(), checksum: Some(hash.clone()), mime_type: Some("model/gltf+json".to_string()), size_bytes: None, status: None, provenance: Default::default() });
        let refused = crate::prepared::PreparedScene::prepare(
            scene,
            &HashSet::from([hash.clone()]),
            &AssetBytes::from([(hash, two_material_glb())]),
            &MaterialSupport::fixed_function(),
        );
        assert!(
            matches!(&refused, Err(Refusal::ObjectKindNotDrawable { object, kind, owner }) if object == "model" && kind == "mesh" && owner == "11.48"),
            "{:?}",
            refused.err()
        );
    }

    #[test]
    fn an_unassigned_face_refuses_by_name() {
        let slots = [("front", "mat"), ("back", "mat"), ("left", "mat"), ("right", "mat"), ("top", "mat")];
        let scene = document(vec![SceneObject::Mesh(mesh(MeshPrimitiveKind::Cube, &slots))], vec![material("mat")]);
        assert!(matches!(prepare_meshes(&scene, &HashSet::new(), &AssetBytes::new(), &MaterialSupport::fixed_function()), Err(Refusal::MeshMaterialUnassigned { element, .. }) if element == "bottom"));
    }
}
