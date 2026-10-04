//! The scene validator and preflight (build plan 7.4, 7.7).
//!
//! **Why this lives in contracts rather than in either product.** The engine
//! decides whether a scene can be rendered; the Editor must be able to tell a
//! designer the same thing *before* they publish. But invariant 3 forbids the
//! Editor importing renderer internals, so it cannot call into the worker —
//! and a second copy of these rules would drift, which is exactly what
//! invariant 27 exists to stop. A validator laxer than the engine is the worse
//! failure of the two: it lets an author save something that only refuses when
//! somebody tries to take it to air.
//!
//! So the document-level checks live here, and both sides call them. That is
//! what makes 7.4's done-when — "shares one enum with the engine" — literally
//! true rather than aspirational: `PreparedScene::prepare` and the Editor run
//! the same function over the same `Refusal` enum.
//!
//! **Why it returns every problem rather than the first.** The engine can stop
//! at the first refusal because it only needs to know that it cannot render.
//! A person fixing a scene, and an agent correcting one, both need the whole
//! list — a validator that reveals one fault per attempt turns a five-minute
//! fix into five round trips (ADR Part D principle 3). `prepare` keeps its
//! first-refusal behaviour by taking the head of this list.
//!
//! **What is deliberately not here.** Checks that need resolved geometry —
//! tessellation failures, glyph coverage, mesh material assignment — happen
//! during preparation because they need work the contracts layer does not do.
//! This module holds only what can be decided from the document plus the
//! peer's declared `MaterialSupport`.

use std::collections::HashSet;

use crate::color::ColorValue;
use crate::material::{validate_material, MaterialKind, MaterialSupport};
use crate::scene::{SceneDocument, SceneObject};
use crate::{ContentHash, Refusal, RefusalSeverity, StructuredRefusal};

/// Validate a document against what a peer declared it can draw.
///
/// An empty result means the document is renderable by a peer with this
/// `MaterialSupport`. `available` is the set of content hashes the peer holds;
/// pass an empty set to check only what is decidable without the asset store,
/// which is what an Editor does before its assets have shipped.
///
/// Every refusal carries its JSON path in `field` and the offending value in
/// `given`, and carries `allowed` wherever the acceptable set is enumerable.
/// That last part is what turns a refusal into a successful retry rather than
/// another guess (0.6, and 7.7's done-when).
pub fn validate_scene_document(
    document: &SceneDocument,
    support: &MaterialSupport,
    available: &HashSet<ContentHash>,
    check_assets_present: bool,
) -> Vec<StructuredRefusal> {
    let mut found = Vec::new();

    if document.canvas.width == 0 || document.canvas.height == 0 {
        found.push(
            StructuredRefusal::error(Refusal::SceneParseFailed {
                detail: "scene canvas dimensions must be non-zero".into(),
            })
            .at(
                "canvas",
                serde_json::json!({
                    "width": document.canvas.width,
                    "height": document.canvas.height
                }),
            ),
        );
    }

    // Declared assets first. "The logo has not arrived" is a more useful
    // answer than "object logo_1 cannot resolve its asset", and an author who
    // sees the second without the first goes looking in the wrong place.
    //
    // An Editor validating before transfer passes `check_assets_present:
    // false`: at authoring time the bytes legitimately have not shipped yet,
    // and reporting every asset as missing would train an author to ignore
    // the validator. An asset with no content hash at all is still a fault on
    // both sides, because it can never resolve.
    for (index, asset) in document.assets.iter().enumerate() {
        match asset.checksum.as_ref() {
            None => found.push(
                StructuredRefusal::error(Refusal::AssetMissing {
                    hash: ContentHash(format!("{} (no content hash yet)", asset.asset_id)),
                })
                .at(
                    format!("assets[{index}].checksum"),
                    serde_json::Value::Null,
                ),
            ),
            Some(hash) if check_assets_present && !available.contains(hash) => found.push(
                StructuredRefusal::error(Refusal::AssetMissing { hash: hash.clone() })
                    .at(
                        format!("assets[{index}].checksum"),
                        serde_json::json!(hash.0),
                    ),
            ),
            Some(_) => {}
        }
    }

    // Every reference an object makes must resolve inside the document. The
    // document is self-describing (1.1), so an id that does not resolve here
    // will never resolve later — there is no ambient registry to consult.
    for (index, object) in document.objects.iter().enumerate() {
        match object {
            SceneObject::Text(text) => {
                if document.font(&text.font_id).is_none() {
                    found.push(
                        StructuredRefusal::error(Refusal::SceneFontUnknown {
                            font_id: text.font_id.clone(),
                            object: text.base.id.clone(),
                        })
                        .at(
                            format!("objects[{index}].fontId"),
                            serde_json::json!(text.font_id),
                        )
                        .allowing(
                            document
                                .fonts
                                .iter()
                                .map(|font| serde_json::json!(font.font_id))
                                .collect(),
                        ),
                    );
                }
                // The software path fills glyphs with a solid colour. A
                // gradient needs a fill rule it does not implement, so it
                // refuses here rather than being flattened to a stop at frame
                // time (invariant 18).
                if matches!(
                    text.base.fill,
                    Some(ColorValue::LinearGradient { .. } | ColorValue::RadialGradient { .. })
                ) {
                    found.push(
                        StructuredRefusal::error(Refusal::UnsupportedPathGradient {
                            object: text.base.id.clone(),
                            paint: "text fill".into(),
                        })
                        .at(format!("objects[{index}].fill.type"), gradient_kind(&text.base.fill)),
                    );
                }
            }
            SceneObject::Image(image) => {
                if document.asset(&image.asset_id).is_none() {
                    found.push(
                        StructuredRefusal::error(Refusal::SceneAssetUnknown {
                            asset_id: image.asset_id.clone(),
                            object: image.base.id.clone(),
                        })
                        .at(
                            format!("objects[{index}].assetId"),
                            serde_json::json!(image.asset_id),
                        )
                        .allowing(
                            document
                                .assets
                                .iter()
                                .map(|asset| serde_json::json!(asset.asset_id))
                                .collect(),
                        ),
                    );
                }
            }
            SceneObject::Mesh(mesh) => {
                if let Some(model) = &mesh.model_asset_id {
                    if document.asset(model).is_none() {
                        found.push(
                            StructuredRefusal::error(Refusal::SceneAssetUnknown {
                                asset_id: model.clone(),
                                object: mesh.base.id.clone(),
                            })
                            .at(
                                format!("objects[{index}].modelAssetId"),
                                serde_json::json!(model),
                            )
                            .allowing(
                                document
                                    .assets
                                    .iter()
                                    .map(|asset| serde_json::json!(asset.asset_id))
                                    .collect(),
                            ),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    // Materials against what the peer declared it can draw, so an unsupported
    // blend or fit mode refuses with the allowed list attached rather than
    // being drawn as its nearest neighbour. `overlay` aliasing to `screen` is
    // the recorded live fault behind invariant 18, and `validate_material` is
    // the single implementation of this check (1.3).
    for material in &document.materials {
        if let Err(refusal) = validate_material(material, support) {
            found.push(refusal);
        }
    }

    found.extend(pbr_without_a_shader_path(document, support));

    found
}

/// PBR material bound to a mesh on a peer that has no shader path.
///
/// Separated because the reason is a capability rather than a document fault:
/// the same scene is perfectly valid against a peer that declares shader
/// compositing, and this check must not fire there. The signal is the peer's
/// own `MaterialSupport` — a renderer whose blend modes are all fixed-function
/// has no shader stage to evaluate PBR lighting in. That is inferred from the
/// declared capability rather than from a build flag, which is invariant 21.
fn pbr_without_a_shader_path(
    document: &SceneDocument,
    support: &MaterialSupport,
) -> Vec<StructuredRefusal> {
    let has_shader_path = support
        .blend_modes
        .iter()
        .any(|mode| !mode.is_fixed_function());
    if has_shader_path {
        return Vec::new();
    }

    let pbr: HashSet<&str> = document
        .materials
        .iter()
        .filter(|material| material.kind == MaterialKind::Pbr)
        .map(|material| material.material_id.as_str())
        .collect();
    if pbr.is_empty() {
        return Vec::new();
    }

    let mut found = Vec::new();
    for (index, object) in document.objects.iter().enumerate() {
        let SceneObject::Mesh(mesh) = object else {
            continue;
        };
        let Some(slots) = &mesh.base.material_slots else {
            continue;
        };
        for (slot, binding) in slots {
            if pbr.contains(binding.material_id.as_str()) {
                found.push(
                    StructuredRefusal::error(Refusal::NotImplemented {
                        what: format!(
                            "PBR material '{}' on mesh '{}' slot '{}' requires a shader path",
                            binding.material_id, mesh.base.id, slot
                        ),
                    })
                    .at(
                        format!("objects[{index}].materialSlots.{slot}"),
                        serde_json::json!(binding.material_id),
                    ),
                );
            }
        }
    }
    found
}

fn gradient_kind(fill: &Option<ColorValue>) -> serde_json::Value {
    match fill {
        Some(ColorValue::LinearGradient { .. }) => serde_json::json!("linear-gradient"),
        Some(ColorValue::RadialGradient { .. }) => serde_json::json!("radial-gradient"),
        _ => serde_json::Value::Null,
    }
}

/// What preflight answers (7.7).
///
/// `publishable` is derived rather than stored, and it is false only for
/// `Error`. That split is the whole point of having three severities: a
/// warning that blocked publication would be an error, and a system that
/// blocks on everything gets bypassed entirely (ADR-0002 G.4).
#[derive(Debug, Clone, PartialEq)]
pub struct PreflightReport {
    pub refusals: Vec<StructuredRefusal>,
}

impl PreflightReport {
    /// Whether this document may be published.
    pub fn publishable(&self) -> bool {
        !self
            .refusals
            .iter()
            .any(|refusal| refusal.severity == RefusalSeverity::Error)
    }

    /// The most urgent severity reported, if anything was.
    pub fn worst_severity(&self) -> Option<RefusalSeverity> {
        self.refusals.iter().map(|refusal| refusal.severity).max()
    }
}

/// Run preflight over a document.
///
/// The Editor's pre-publish gate. It asks the same question the engine will
/// ask, with the same code, so "it passed preflight and then refused at
/// publish" cannot happen for any reason this layer can see.
pub fn preflight(
    document: &SceneDocument,
    support: &MaterialSupport,
    available: &HashSet<ContentHash>,
    check_assets_present: bool,
) -> PreflightReport {
    PreflightReport {
        refusals: validate_scene_document(document, support, available, check_assets_present),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::material::{BlendMode, MaterialBinding, MaterialDefinition};
    use crate::scene::{
        AssetKind, AssetLibraryItem, ImageObject, ObjectBase, SceneCanvas, SceneTimeline,
        TextObject,
    };
    use crate::{RationalRate, Revision};

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        SceneDocument {
            id: "scene".into(),
            name: "Scene".into(),
            version: crate::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline { duration_frames: 1, ..Default::default() },
            data_context: Default::default(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            objects,
        }
    }

    fn text(id: &str, font_id: &str) -> SceneObject {
        SceneObject::Text(TextObject {
            base: ObjectBase::new(id, id),
            text: "On air".into(),
            font_id: font_id.into(),
            size: 48.0,
            layout: Default::default(),
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: Default::default(),
            text_case: Default::default(),
            decoration: Default::default(),
            overflow: Default::default(),
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
        })
    }

    fn material(id: &str, blend: BlendMode) -> MaterialDefinition {
        MaterialDefinition {
            material_id: id.into(),
            name: id.into(),
            kind: MaterialKind::Unlit,
            color: ColorValue::opaque_white(),
            opacity: 1.0,
            blend_mode: blend,
            alpha_mode: Default::default(),
            cull_mode: Default::default(),
            depth_mode: Default::default(),
            double_sided: false,
            textures: Vec::new(),
            shader_id: None,
        }
    }

    #[test]
    fn a_renderable_scene_reports_nothing() {
        let found = validate_scene_document(
            &document(Vec::new()),
            &MaterialSupport::fixed_function(),
            &HashSet::new(),
            true,
        );
        assert!(found.is_empty(), "expected no refusals, got {found:?}");
    }

    #[test]
    fn every_fault_is_reported_not_only_the_first() {
        // The reason this function exists rather than reusing the engine's
        // first-refusal behaviour: an author fixing a scene needs the whole
        // list, not one fault per attempt.
        let mut scene = document(vec![
            text("title", "missing-font"),
            SceneObject::Image(ImageObject {
                base: ObjectBase::new("logo", "logo"),
                asset_id: "missing-asset".into(),
                fit: Default::default(),
            }),
        ]);
        scene.canvas.width = 0;

        let found = validate_scene_document(
            &scene,
            &MaterialSupport::fixed_function(),
            &HashSet::new(),
            true,
        );

        assert_eq!(found.len(), 3, "expected all three faults, got {found:?}");
        assert!(found
            .iter()
            .any(|r| matches!(r.code, Refusal::SceneParseFailed { .. })));
        assert!(found
            .iter()
            .any(|r| matches!(r.code, Refusal::SceneFontUnknown { .. })));
        assert!(found
            .iter()
            .any(|r| matches!(r.code, Refusal::SceneAssetUnknown { .. })));
    }

    #[test]
    fn an_unresolvable_reference_names_what_it_could_have_been() {
        // 7.7's done-when: structured refusals with allowed values. A font id
        // that does not resolve carries the ids that would have.
        let mut scene = document(vec![text("title", "nope")]);
        scene.fonts.push(crate::font::FontDefinition {
            font_id: "inter".into(),
            family: "Inter".into(),
            display_name: "Inter".into(),
            faces: Vec::new(),
            fallback_families: Vec::new(),
            embedding_policy: crate::font::EmbeddingPolicy::Package,
            license: None,
            enabled: true,
            source_label: None,
            status: crate::font::FontLoadStatus::Ready,
            error_message: None,
        });

        let found = validate_scene_document(
            &scene,
            &MaterialSupport::fixed_function(),
            &HashSet::new(),
            true,
        );
        let refusal = found
            .iter()
            .find(|r| matches!(r.code, Refusal::SceneFontUnknown { .. }))
            .expect("an unknown font must be reported");

        assert_eq!(refusal.field.as_deref(), Some("objects[0].fontId"));
        assert_eq!(refusal.given, serde_json::json!("nope"));
        assert_eq!(
            refusal.allowed,
            Some(vec![serde_json::json!("inter")]),
            "the refusal must name the fonts that would have resolved"
        );
    }

    #[test]
    fn an_unsupported_blend_mode_carries_the_modes_that_are_supported() {
        let mut scene = document(Vec::new());
        scene.materials.push(material("m", BlendMode::Overlay));

        let found = validate_scene_document(
            &scene,
            &MaterialSupport::fixed_function(),
            &HashSet::new(),
            true,
        );
        let refusal = found
            .iter()
            .find(|r| matches!(r.code, Refusal::UnsupportedBlendMode { .. }))
            .expect("overlay is not fixed-function and must refuse");
        let allowed = refusal.allowed.as_ref().expect("allowed modes travel");
        assert!(allowed.contains(&serde_json::json!("normal")));
        assert!(
            !allowed.contains(&serde_json::json!("overlay")),
            "the refused mode must not appear in its own allowed list"
        );
    }

    #[test]
    fn an_editor_may_validate_before_its_assets_have_shipped() {
        // At authoring time the bytes legitimately have not transferred yet.
        // Reporting every asset as missing would train an author to ignore
        // the validator, so the presence check is the caller's choice.
        let mut scene = document(Vec::new());
        scene.assets.push(AssetLibraryItem {
            asset_id: "logo".into(),
            name: "Logo".into(),
            kind: AssetKind::Image,
            path: "images/logo.png".into(),
            checksum: Some(ContentHash("abc".into())),
            mime_type: Some("image/png".into()),
            size_bytes: None,
            status: None,
            provenance: crate::provenance::AssetProvenance::default(),
        });

        let authoring =
            validate_scene_document(&scene, &MaterialSupport::fixed_function(), &HashSet::new(), false);
        assert!(authoring.is_empty(), "authoring must not demand transfer");

        let engine =
            validate_scene_document(&scene, &MaterialSupport::fixed_function(), &HashSet::new(), true);
        assert!(
            engine
                .iter()
                .any(|r| matches!(r.code, Refusal::AssetMissing { .. })),
            "the engine still refuses bytes it does not hold (invariant 29)"
        );
    }

    #[test]
    fn an_asset_with_no_content_hash_refuses_on_both_sides() {
        // It can never resolve, so deferring the check would only move the
        // failure later.
        let mut scene = document(Vec::new());
        scene.assets.push(AssetLibraryItem {
            asset_id: "importing".into(),
            name: "Still importing".into(),
            kind: AssetKind::Image,
            path: "images/x.png".into(),
            checksum: None,
            mime_type: None,
            size_bytes: None,
            status: None,
            provenance: crate::provenance::AssetProvenance::default(),
        });

        for check in [true, false] {
            let found = validate_scene_document(
                &scene,
                &MaterialSupport::fixed_function(),
                &HashSet::new(),
                check,
            );
            assert!(
                found
                    .iter()
                    .any(|r| matches!(r.code, Refusal::AssetMissing { .. })),
                "an asset with no content hash is a fault regardless of transfer"
            );
        }
    }

    #[test]
    fn pbr_refuses_on_a_fixed_function_peer_and_passes_on_a_shader_peer() {
        // The same scene is valid against a peer that declares a shader path.
        // The capability decides, never a build flag (invariant 21).
        let mut scene = document(Vec::new());
        let mut pbr = material("pbr", BlendMode::Normal);
        pbr.kind = MaterialKind::Pbr;
        scene.materials.push(pbr);

        let mut mesh_base = ObjectBase::new("mesh", "mesh");
        mesh_base.material_slots = Some(
            [("object".to_string(), MaterialBinding::new("pbr"))]
                .into_iter()
                .collect(),
        );
        scene.objects.push(SceneObject::Mesh(crate::scene::MeshObject {
            base: mesh_base,
            mesh_kind: crate::scene::MeshPrimitiveKind::Cube,
            depth: 1.0,
            slab: None,
            model_asset_id: None,
            material_elements: None,
            anchor_3d: None,
            clip_name: None,
            clip_index: None,
            time_scale: None,
            frame_offset: None,
            animation_loop: false,
        }));

        let fixed = validate_scene_document(
            &scene,
            &MaterialSupport::fixed_function(),
            &HashSet::new(),
            true,
        );
        assert!(
            fixed
                .iter()
                .any(|r| matches!(r.code, Refusal::NotImplemented { .. })),
            "a fixed-function peer cannot evaluate PBR"
        );

        let mut shader_capable = MaterialSupport::fixed_function();
        shader_capable.blend_modes = BlendMode::ALL.to_vec();
        let shader = validate_scene_document(&scene, &shader_capable, &HashSet::new(), true);
        assert!(
            !shader
                .iter()
                .any(|r| matches!(r.code, Refusal::NotImplemented { .. })),
            "a peer with a shader path draws PBR, so the same scene is valid"
        );
    }

    #[test]
    fn preflight_blocks_on_error_and_allows_a_warning() {
        // Three severities exist so that not everything is a hard rule. A
        // warning that blocked publication would just be an error.
        let blocking = PreflightReport {
            refusals: vec![StructuredRefusal::error(Refusal::SceneParseFailed {
                detail: "x".into(),
            })],
        };
        assert!(!blocking.publishable());
        assert_eq!(blocking.worst_severity(), Some(RefusalSeverity::Error));

        let mut advisory = StructuredRefusal::error(Refusal::SceneParseFailed {
            detail: "x".into(),
        });
        advisory.severity = RefusalSeverity::Warning;
        let permitted = PreflightReport {
            refusals: vec![advisory],
        };
        assert!(
            permitted.publishable(),
            "a warning is recorded, not a block (ADR-0002 G.4)"
        );

        assert!(PreflightReport { refusals: Vec::new() }.publishable());
    }
}
