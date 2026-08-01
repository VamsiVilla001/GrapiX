//! Cross-language shader-layout contract test.
//!
//! Asserts the Rust `QuadUniforms` struct matches the machine-readable layout
//! in `Shared/render-shaders/layouts.json` byte for byte. The browser
//! WebGPU renderer must run the equivalent check against the same file, so
//! the two renderers cannot drift apart silently.

use std::mem::offset_of;

use grapix_render_core::renderer::mesh::{
    MeshUniforms, SceneLightUniform, SceneLightingUniforms, MESH_UNIFORMS_SIZE,
    SCENE_LIGHTING_UNIFORMS_SIZE, SCENE_LIGHT_UNIFORM_SIZE,
};
use grapix_render_core::renderer::pipeline::{QuadUniforms, QUAD_UNIFORMS_SIZE};

fn load_layouts() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../Shared/render-shaders/layouts.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read shared layouts.json at {path}: {error}"));

    serde_json::from_str(&raw).expect("layouts.json must be valid JSON")
}

#[test]
fn quad_uniforms_match_shared_layout() {
    let layouts = load_layouts();
    let uniforms = &layouts["shaders"]["composite_quad"]["uniforms"]["QuadUniforms"];

    assert_eq!(
        uniforms["sizeBytes"].as_u64().expect("sizeBytes"),
        QUAD_UNIFORMS_SIZE as u64,
        "QuadUniforms size drifted from layouts.json"
    );

    let expected_offsets = [
        ("transform", offset_of!(QuadUniforms, transform)),
        ("fill_color", offset_of!(QuadUniforms, fill_color)),
        ("params", offset_of!(QuadUniforms, params)),
        ("gradient_params", offset_of!(QuadUniforms, gradient_params)),
        (
            "gradient_geometry",
            offset_of!(QuadUniforms, gradient_geometry),
        ),
        (
            "gradient_positions",
            offset_of!(QuadUniforms, gradient_positions),
        ),
        ("gradient_colors", offset_of!(QuadUniforms, gradient_colors)),
    ];

    let fields = uniforms["fields"].as_array().expect("fields array");
    assert_eq!(fields.len(), expected_offsets.len(), "field count drifted");

    for (field, (name, rust_offset)) in fields.iter().zip(expected_offsets) {
        assert_eq!(
            field["name"].as_str().expect("field name"),
            name,
            "field order drifted"
        );
        assert_eq!(
            field["offsetBytes"].as_u64().expect("offsetBytes"),
            rust_offset as u64,
            "offset of {name} drifted from layouts.json"
        );
    }
}

#[test]
fn mesh_uniforms_match_shared_layout() {
    let layouts = load_layouts();
    let uniforms = &layouts["shaders"]["mesh_pbr"]["uniforms"]["MeshUniforms"];
    assert_eq!(
        uniforms["sizeBytes"].as_u64().expect("sizeBytes"),
        MESH_UNIFORMS_SIZE as u64,
        "MeshUniforms size drifted from layouts.json"
    );
    let expected_offsets = [
        ("model", offset_of!(MeshUniforms, model)),
        ("view_projection", offset_of!(MeshUniforms, view_projection)),
        ("normal_model", offset_of!(MeshUniforms, normal_model)),
        ("base_color", offset_of!(MeshUniforms, base_color)),
        ("material_params", offset_of!(MeshUniforms, material_params)),
        ("uv_scale_offset", offset_of!(MeshUniforms, uv_scale_offset)),
        (
            "uv_rotation_pivot",
            offset_of!(MeshUniforms, uv_rotation_pivot),
        ),
        ("emissive", offset_of!(MeshUniforms, emissive)),
    ];
    let fields = uniforms["fields"].as_array().expect("fields array");
    assert_eq!(fields.len(), expected_offsets.len(), "field count drifted");
    for (field, (name, rust_offset)) in fields.iter().zip(expected_offsets) {
        assert_eq!(field["name"].as_str().expect("field name"), name);
        assert_eq!(
            field["offsetBytes"].as_u64().expect("offsetBytes"),
            rust_offset as u64,
            "offset of {name} drifted from layouts.json"
        );
    }
}

#[test]
fn scene_lighting_uniforms_match_shared_layout() {
    let layouts = load_layouts();
    let shader_uniforms = &layouts["shaders"]["mesh_pbr"]["uniforms"];
    let light = &shader_uniforms["SceneLight"];
    assert_eq!(
        light["sizeBytes"].as_u64().expect("SceneLight sizeBytes"),
        SCENE_LIGHT_UNIFORM_SIZE as u64
    );
    let expected_light_offsets = [
        (
            "color_intensity",
            offset_of!(SceneLightUniform, color_intensity),
        ),
        (
            "position_kind",
            offset_of!(SceneLightUniform, position_kind),
        ),
        (
            "direction_range",
            offset_of!(SceneLightUniform, direction_range),
        ),
        ("spot_decay", offset_of!(SceneLightUniform, spot_decay)),
    ];
    let light_fields = light["fields"].as_array().expect("SceneLight fields");
    for (field, (name, rust_offset)) in light_fields.iter().zip(expected_light_offsets) {
        assert_eq!(field["name"].as_str().expect("field name"), name);
        assert_eq!(
            field["offsetBytes"].as_u64().expect("offsetBytes"),
            rust_offset as u64,
            "offset of SceneLight.{name} drifted from layouts.json"
        );
    }

    let lighting = &shader_uniforms["SceneLighting"];
    assert_eq!(
        lighting["sizeBytes"]
            .as_u64()
            .expect("SceneLighting sizeBytes"),
        SCENE_LIGHTING_UNIFORMS_SIZE as u64
    );
    assert_eq!(offset_of!(SceneLightingUniforms, params), 0);
    assert_eq!(offset_of!(SceneLightingUniforms, lights), 16);
    assert_eq!(
        lighting["fields"][1]["sizeBytes"]
            .as_u64()
            .expect("lights array size"),
        (16 * SCENE_LIGHT_UNIFORM_SIZE) as u64
    );
}

#[test]
fn declared_wgsl_file_exists_and_declares_the_struct() {
    let layouts = load_layouts();
    for (shader_name, uniform_name) in [
        ("composite_quad", "QuadUniforms"),
        ("mesh_pbr", "MeshUniforms"),
    ] {
        let file = layouts["shaders"][shader_name]["file"]
            .as_str()
            .expect("file");
        let path = format!(
            "{}/../../Shared/render-shaders/{file}",
            env!("CARGO_MANIFEST_DIR")
        );
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("shared shader missing at {path}: {error}"));
        for expected in [
            format!("struct {uniform_name}"),
            "fn vs_main".to_string(),
            "fn fs_main".to_string(),
        ] {
            assert!(
                source.contains(&expected),
                "shared shader no longer contains {expected:?}; update layouts.json and the Rust pipeline together"
            );
        }
    }
    assert!(
        grapix_render_core::renderer::mesh::MESH_PBR_WGSL.contains("struct SceneLight")
            && grapix_render_core::renderer::mesh::MESH_PBR_WGSL.contains("struct SceneLighting")
            && grapix_render_core::renderer::mesh::MESH_PBR_WGSL.contains("@group(0) @binding(3)"),
        "mesh shader must retain its shared authored-light uniform contract"
    );
}
