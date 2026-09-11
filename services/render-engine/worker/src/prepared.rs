//! Scene parse to prepared scene (build plan 3.4).
//!
//! A published document is authoring data: ids pointing at other ids, colours
//! in whatever space they were authored in, a hierarchy expressed as parent
//! claims. A rasteriser needs none of that — it needs resolved transforms,
//! bound assets and a font it can shape with. Doing that resolution per frame
//! is the fault invariant 35 records: 1.x rebuilt its prepared scene every
//! Program frame and paid 482 ms for it.
//!
//! So preparation happens **once per publish**, and it is where every
//! "this scene cannot be rendered" answer is produced. That placement is the
//! point: a scene that refuses at publish refuses while an operator is still
//! looking at an editor, not at the moment somebody takes it to air. Every
//! refusal here is named (invariant 17), and nothing is approximated to keep
//! a broken scene renderable (invariant 18).
//!
//! What this module deliberately does *not* do is draw. The vector rasteriser
//! (3.5), the text shaper (3.6) and the mesh path (3.7) consume a
//! `PreparedScene`; they are separate steps and are not implemented yet.

use std::collections::{HashMap, HashSet};

use gx_contracts::material::{validate_material, MaterialSupport};
use gx_contracts::scene::{
    resolve_hierarchy, HierarchyDiagnostic, ResolvedObject, SceneDocument, SceneObject,
};
use gx_contracts::{ContentHash, Refusal};

/// A document resolved into what a renderer actually consumes.
///
/// Immutable by construction: it is built from a document that has already
/// been pinned to a revision, and publishing is additive (invariant 30), so
/// there is no method here that mutates one. A second publish makes a second
/// `PreparedScene`.
#[derive(Debug, Clone)]
pub struct PreparedScene {
    document: SceneDocument,
    /// Effective transforms and state, resolved once (1.2's resolver).
    effective: Vec<ResolvedObject>,
    /// Refused hierarchy edges. Not fatal — a scene being repaired still
    /// resolves — but carried so the engine can report them rather than
    /// leaving an object mysteriously unparented.
    diagnostics: Vec<HierarchyDiagnostic>,
    /// Object index, so a lookup during rendering is not a linear scan of the
    /// draw list for every reference.
    by_id: HashMap<String, usize>,
}

impl PreparedScene {
    /// Resolve a document against what this engine holds and can draw.
    ///
    /// `available` is the set of content hashes the asset plane has verified
    /// into the store. A scene declaring bytes the engine does not hold is a
    /// take blocker, not a scene with a missing picture (invariant 29): it
    /// refuses here, before anything can cue it.
    pub fn prepare(
        document: SceneDocument,
        available: &HashSet<ContentHash>,
        support: &MaterialSupport,
    ) -> Result<Self, Refusal> {
        // Every asset the library declares must be present. Checked before
        // the objects, because "the logo has not arrived" is a more useful
        // answer than "object logo_1 cannot resolve its asset".
        for asset in &document.assets {
            let hash = asset
                .checksum
                .as_ref()
                .ok_or_else(|| Refusal::AssetMissing {
                    // An asset still importing has no content address yet, so the
                    // scene cannot be rendered from it either.
                    hash: ContentHash(format!("{} (no content hash yet)", asset.asset_id)),
                })?;
            if !available.contains(hash) {
                return Err(Refusal::AssetMissing { hash: hash.clone() });
            }
        }

        // Every reference an object makes must resolve inside the document.
        // The document is self-describing (1.1), so an id that does not
        // resolve here will never resolve later.
        for object in &document.objects {
            match object {
                SceneObject::Text(text) => {
                    if document.font(&text.font_id).is_none() {
                        return Err(Refusal::SceneFontUnknown {
                            font_id: text.font_id.clone(),
                            object: text.base.id.clone(),
                        });
                    }
                }
                SceneObject::Image(image) => {
                    if document.asset(&image.asset_id).is_none() {
                        return Err(Refusal::SceneAssetUnknown {
                            asset_id: image.asset_id.clone(),
                            object: image.base.id.clone(),
                        });
                    }
                }
                SceneObject::Mesh(mesh) => {
                    if let Some(model) = &mesh.model_asset_id {
                        if document.asset(model).is_none() {
                            return Err(Refusal::SceneAssetUnknown {
                                asset_id: model.clone(),
                                object: mesh.base.id.clone(),
                            });
                        }
                    }
                }
                _ => {}
            }
        }

        // Materials are checked against what this engine declared it can
        // draw, so an unsupported blend or fit mode refuses with the allowed
        // list attached rather than being drawn as its nearest neighbour
        // (1.3, invariant 18).
        for material in &document.materials {
            validate_material(material, support).map_err(|refusal| refusal.code)?;
        }

        let resolution = resolve_hierarchy(&document.objects);
        let by_id = resolution
            .effective
            .iter()
            .enumerate()
            .map(|(index, object)| (object.id.clone(), index))
            .collect();

        Ok(Self {
            document,
            effective: resolution.effective,
            diagnostics: resolution.diagnostics,
            by_id,
        })
    }

    /// The document this was prepared from.
    pub fn document(&self) -> &SceneDocument {
        &self.document
    }

    /// Every object's effective state, in the document's draw order.
    pub fn effective(&self) -> &[ResolvedObject] {
        &self.effective
    }

    /// The objects that draw: everything that is not a container.
    pub fn renderable(&self) -> impl Iterator<Item = &ResolvedObject> {
        self.effective.iter().filter(|object| !object.is_container)
    }

    /// One object's effective state.
    pub fn effective_object(&self, id: &str) -> Option<&ResolvedObject> {
        self.by_id
            .get(id)
            .and_then(|index| self.effective.get(*index))
    }

    /// Hierarchy edges the resolver refused. Reported, never silently lost.
    pub fn diagnostics(&self) -> &[HierarchyDiagnostic] {
        &self.diagnostics
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::color::ColorValue;
    use gx_contracts::font::{
        EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus,
        FontSource, FontStyle,
    };
    use gx_contracts::material::{BlendMode, MaterialDefinition, MaterialKind};
    use gx_contracts::scene::{
        AssetAvailability, AssetKind, AssetLibraryItem, GroupObject, ImageObject, ObjectBase,
        RectObject, SceneCanvas, SceneDocument, SceneTimeline, TextObject,
    };
    use gx_contracts::{RationalRate, Revision};

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        SceneDocument {
            id: "scene_1".into(),
            name: "Lower Third".into(),
            version: 1,
            revision: Some(Revision(1)),
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 100,
            },
            data_context: serde_json::Map::new(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            objects,
        }
    }

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    }

    fn logo_asset(hash: &str) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: "asset_logo".into(),
            name: "Logo".into(),
            kind: AssetKind::Image,
            path: "images/logo.png".into(),
            checksum: Some(ContentHash(hash.into())),
            mime_type: Some("image/png".into()),
            size_bytes: Some(64),
            status: Some(AssetAvailability::Ready),
        }
    }

    fn inter() -> FontDefinition {
        FontDefinition {
            font_id: "font_inter".into(),
            family: "Inter".into(),
            display_name: "Inter".into(),
            faces: vec![FontFaceDefinition {
                face_id: "inter_400".into(),
                family: "Inter".into(),
                weight: 400,
                style: FontStyle::Normal,
                stretch: None,
                unicode_range: None,
                source: FontSource::File {
                    asset_id: "asset_inter".into(),
                    format: FontFormat::Ttf,
                    original_url: None,
                    stylesheet_url: None,
                },
                status: Some(FontLoadStatus::Ready),
                error_message: None,
            }],
            fallback_families: Vec::new(),
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("SIL OFL 1.1".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        }
    }

    #[test]
    fn a_scene_resolves_its_hierarchy_once_at_publish() {
        // Invariant 35: this is the work 1.x did per frame.
        let mut parent = GroupObject {
            base: ObjectBase::new("g", "g"),
            child_ids: vec!["r".into()],
        };
        parent.base.x = 100.0;
        let objects = vec![SceneObject::Group(parent), rect("r")];

        let prepared = PreparedScene::prepare(
            document(objects),
            &HashSet::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("a scene with no assets prepares");

        assert_eq!(prepared.effective().len(), 2);
        assert_eq!(
            prepared.effective_object("r").expect("the rect resolves").x,
            100.0,
            "the child must carry its parent's transform, resolved at publish"
        );
        assert_eq!(
            prepared.renderable().count(),
            1,
            "a container draws nothing"
        );
    }

    #[test]
    fn a_declared_asset_the_engine_does_not_hold_blocks_the_scene() {
        // Invariant 29: a missing asset is a take blocker, not a hole in the
        // picture. It must refuse at publish, while somebody is watching.
        let scene = SceneDocument {
            assets: vec![logo_asset("deadbeef")],
            ..document(vec![rect("bg")])
        };
        match PreparedScene::prepare(
            scene.clone(),
            &HashSet::new(),
            &MaterialSupport::fixed_function(),
        ) {
            Err(Refusal::AssetMissing { hash }) => assert_eq!(hash.0, "deadbeef"),
            other => panic!("a missing asset must refuse by name, got {other:?}"),
        }

        let available = HashSet::from([ContentHash("deadbeef".into())]);
        assert!(
            PreparedScene::prepare(scene, &available, &MaterialSupport::fixed_function()).is_ok(),
            "the same scene prepares once the bytes are held"
        );
    }

    #[test]
    fn an_object_referencing_a_font_the_scene_does_not_carry_refuses() {
        // The scene is self-describing (1.1): a font id that does not resolve
        // in the document will never resolve later, so it refuses now rather
        // than substituting a system face (3.6's rule, enforced at prepare).
        let text = SceneObject::Text(TextObject {
            base: ObjectBase::new("title", "title"),
            text: "Hello".into(),
            font_id: "font_absent".into(),
            size: 72.0,
            ..text_defaults()
        });
        match PreparedScene::prepare(
            document(vec![text]),
            &HashSet::new(),
            &MaterialSupport::fixed_function(),
        ) {
            Err(Refusal::SceneFontUnknown { font_id, object }) => {
                assert_eq!(font_id, "font_absent");
                assert_eq!(object, "title");
            }
            other => panic!("an unresolvable font must refuse by name, got {other:?}"),
        }
    }

    #[test]
    fn an_image_referencing_an_asset_id_the_library_lacks_refuses() {
        let image = SceneObject::Image(ImageObject {
            base: ObjectBase::new("logo", "logo"),
            asset_id: "asset_absent".into(),
            fit: Default::default(),
        });
        match PreparedScene::prepare(
            document(vec![image]),
            &HashSet::new(),
            &MaterialSupport::fixed_function(),
        ) {
            Err(Refusal::SceneAssetUnknown { asset_id, object }) => {
                assert_eq!(asset_id, "asset_absent");
                assert_eq!(object, "logo");
            }
            other => panic!("an unresolvable asset id must refuse by name, got {other:?}"),
        }
    }

    #[test]
    fn a_material_the_engine_cannot_draw_refuses_at_publish() {
        // 1.3's validator, called where it matters: the engine declares what
        // it can reproduce and the scene is held against that declaration.
        let scene = SceneDocument {
            materials: vec![MaterialDefinition {
                material_id: "material_1".into(),
                name: "Overlay".into(),
                kind: MaterialKind::Unlit,
                color: ColorValue::opaque_white(),
                opacity: 1.0,
                blend_mode: BlendMode::Overlay,
                alpha_mode: Default::default(),
                cull_mode: Default::default(),
                depth_mode: Default::default(),
                double_sided: false,
                textures: Vec::new(),
                shader_id: None,
            }],
            ..document(vec![rect("bg")])
        };
        assert!(
            matches!(
                PreparedScene::prepare(
                    scene.clone(),
                    &HashSet::new(),
                    &MaterialSupport::fixed_function()
                ),
                Err(Refusal::UnsupportedBlendMode {
                    mode: BlendMode::Overlay
                })
            ),
            "a fixed-function peer must refuse overlay rather than drawing screen"
        );
        assert!(
            PreparedScene::prepare(
                scene,
                &HashSet::new(),
                &MaterialSupport {
                    blend_modes: vec![BlendMode::Overlay],
                    fit_modes: Vec::new(),
                }
            )
            .is_ok(),
            "a peer that declares overlay may draw it"
        );
    }

    #[test]
    fn a_refused_hierarchy_edge_is_carried_rather_than_lost() {
        let group = SceneObject::Group(GroupObject {
            base: ObjectBase::new("g", "g"),
            child_ids: vec!["ghost".into()],
        });
        let prepared = PreparedScene::prepare(
            document(vec![group, rect("r")]),
            &HashSet::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("a scene being repaired still prepares");
        assert_eq!(
            prepared.diagnostics().len(),
            1,
            "the dropped edge must be reportable, not invisible"
        );
    }

    fn text_defaults() -> TextObject {
        TextObject {
            base: ObjectBase::new("x", "x"),
            text: String::new(),
            font_id: String::new(),
            size: 0.0,
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
        }
    }
}
