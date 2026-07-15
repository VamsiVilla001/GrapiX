//! Cross-language shader-layout contract test.
//!
//! Asserts the Rust `QuadUniforms` struct matches the machine-readable layout
//! in `packages/render-shaders/layouts.json` byte for byte. The browser
//! WebGPU renderer must run the equivalent check against the same file, so
//! the two renderers cannot drift apart silently.

use std::mem::offset_of;

use grapix_render_daemon::renderer::pipeline::{QuadUniforms, QUAD_UNIFORMS_SIZE};

fn load_layouts() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/render-shaders/layouts.json"
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
fn declared_wgsl_file_exists_and_declares_the_struct() {
    let layouts = load_layouts();
    let file = layouts["shaders"]["composite_quad"]["file"]
        .as_str()
        .expect("file");
    let path = format!(
        "{}/../../packages/render-shaders/{file}",
        env!("CARGO_MANIFEST_DIR")
    );

    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("shared shader missing at {path}: {error}"));

    for expected in ["struct QuadUniforms", "fn vs_main", "fn fs_main"] {
        assert!(
            source.contains(expected),
            "shared shader no longer contains {expected:?}; update layouts.json and the Rust pipeline together"
        );
    }
}
