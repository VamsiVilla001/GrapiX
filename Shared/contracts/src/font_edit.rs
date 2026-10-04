//! Font library edits (11.13): explicit add and remove.
//!
//! A font enters a scene only through `addFonts` and leaves only through
//! `removeFont`, each one command (invariant 60). Nothing removes a font
//! implicitly. Removal is refused while a text object or text style names the
//! font, because that text would go to air in a fallback face (invariant 18).
//! `Editor/src/font-manager.ts` `planFontRemoval` states the same rule for the
//! panel; the two change together (invariant 27).

use std::collections::HashSet;

use crate::font::{EmbeddingPolicy, FontDefinition, FontSource};
use crate::scene::{AssetKind, AssetLibraryItem, SceneDocument, SceneObject};
use crate::Refusal;

/// Add prepared fonts and the font assets their faces need, all or nothing.
pub fn add_fonts(
    scene: &mut SceneDocument,
    fonts: &[FontDefinition],
    assets: &[AssetLibraryItem],
) -> Result<(), Refusal> {
    if fonts.is_empty() {
        return Err(Refusal::FontBatchEmpty);
    }

    let mut asset_ids: HashSet<&str> = scene.assets.iter().map(|a| a.asset_id.as_str()).collect();
    for asset in assets {
        if !asset_ids.insert(asset.asset_id.as_str()) {
            return Err(Refusal::SceneAssetDuplicate {
                asset_id: asset.asset_id.clone(),
            });
        }
    }
    let font_assets: HashSet<&str> = scene
        .assets
        .iter()
        .chain(assets)
        .filter(|a| a.kind == AssetKind::Font)
        .map(|a| a.asset_id.as_str())
        .collect();

    let mut font_ids: HashSet<&str> = scene.fonts.iter().map(|f| f.font_id.as_str()).collect();
    for font in fonts {
        if !font_ids.insert(font.font_id.as_str()) {
            return Err(Refusal::FontDuplicate {
                font_id: font.font_id.clone(),
            });
        }
        if font.faces.is_empty() {
            return Err(Refusal::InvalidFontData {
                detail: format!("font {} has no faces", font.font_id),
            });
        }
        // An unstated licence is restricted (p2-licensing-positions §5).
        if font.embedding_policy == EmbeddingPolicy::Package
            && font.license.as_deref().is_none_or(|l| l.trim().is_empty())
        {
            return Err(Refusal::FontEmbeddingRefused {
                font_id: font.font_id.clone(),
            });
        }
        for face in &font.faces {
            if let FontSource::File { asset_id, .. } = &face.source {
                if !font_assets.contains(asset_id.as_str()) {
                    return Err(Refusal::SceneAssetUnknown {
                        asset_id: asset_id.clone(),
                        object: font.font_id.clone(),
                    });
                }
            }
        }
    }

    scene.assets.extend_from_slice(assets);
    scene.fonts.extend_from_slice(fonts);
    Ok(())
}

/// Remove one font and the font assets no other font's faces still use.
/// Returns the removed asset ids.
pub fn remove_font(scene: &mut SceneDocument, font_id: &str) -> Result<Vec<String>, Refusal> {
    let Some(index) = scene.fonts.iter().position(|f| f.font_id == font_id) else {
        return Err(Refusal::FontUnknown {
            font_id: font_id.to_owned(),
        });
    };

    let objects: Vec<String> = scene
        .objects
        .iter()
        .filter_map(|object| match object {
            SceneObject::Text(text) if text.font_id == font_id => Some(text.base.id.clone()),
            _ => None,
        })
        .collect();
    let text_styles: Vec<String> = scene
        .text_styles
        .iter()
        .filter(|style| style.font_id == font_id)
        .map(|style| style.style_id.clone())
        .collect();
    if !objects.is_empty() || !text_styles.is_empty() {
        return Err(Refusal::FontInUse {
            font_id: font_id.to_owned(),
            objects,
            text_styles,
        });
    }

    let removed = scene.fonts.remove(index);
    let still_used: HashSet<&str> = scene.fonts.iter().flat_map(file_asset_ids).collect();
    let orphaned: Vec<String> = file_asset_ids(&removed)
        .filter(|id| !still_used.contains(id))
        .map(str::to_owned)
        .collect();
    scene
        .assets
        .retain(|asset| !orphaned.contains(&asset.asset_id));
    Ok(orphaned)
}

fn file_asset_ids(font: &FontDefinition) -> impl Iterator<Item = &str> {
    font.faces.iter().filter_map(|face| match &face.source {
        FontSource::File { asset_id, .. } => Some(asset_id.as_str()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::font::{FontFaceDefinition, FontFormat, FontLoadStatus, FontStyle};
    use crate::ContentHash;

    fn asset(id: &str) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: id.into(),
            name: id.into(),
            kind: AssetKind::Font,
            path: format!("assets/fonts/{id}.woff2"),
            checksum: Some(ContentHash(format!("{id}-hash"))),
            mime_type: Some("font/woff2".into()),
            size_bytes: Some(10),
            status: None,
            provenance: crate::provenance::AssetProvenance::default(),
        }
    }

    fn font(id: &str, assets: &[&str]) -> FontDefinition {
        FontDefinition {
            font_id: id.into(),
            family: "Inter".into(),
            display_name: id.into(),
            faces: assets
                .iter()
                .enumerate()
                .map(|(i, a)| FontFaceDefinition {
                    face_id: format!("{id}-face-{i}"),
                    family: "Inter".into(),
                    weight: 400,
                    style: FontStyle::Normal,
                    stretch: None,
                    unicode_range: None,
                    source: FontSource::File {
                        asset_id: (*a).into(),
                        format: FontFormat::Woff2,
                        original_url: None,
                        stylesheet_url: None,
                    },
                    status: None,
                    error_message: None,
                })
                .collect(),
            fallback_families: vec![],
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("OFL-1.1".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        }
    }

    fn scene() -> SceneDocument {
        crate::scene::new_scene("fonts", "Fonts")
    }

    #[test]
    fn a_batch_adds_every_font_and_asset_or_nothing() {
        let mut s = scene();
        add_fonts(&mut s, &[font("a", &["x"]), font("b", &["y"])], &[asset("x"), asset("y")]).unwrap();
        assert_eq!(s.fonts.len(), 2);
        assert_eq!(s.assets.len(), 2);

        // One bad member refuses the whole batch and leaves the scene as it was.
        let before = s.clone();
        let refused = add_fonts(&mut s, &[font("c", &["z"]), font("a", &["x"])], &[asset("z")]);
        assert!(matches!(refused, Err(Refusal::FontDuplicate { font_id }) if font_id == "a"));
        assert_eq!(s, before);
    }

    #[test]
    fn add_refuses_empty_duplicate_unbacked_and_unlicensed() {
        let mut s = scene();
        assert!(matches!(add_fonts(&mut s, &[], &[asset("x")]), Err(Refusal::FontBatchEmpty)));
        assert!(matches!(
            add_fonts(&mut s, &[font("a", &["x"])], &[asset("x"), asset("x")]),
            Err(Refusal::SceneAssetDuplicate { asset_id }) if asset_id == "x"
        ));
        assert!(matches!(
            add_fonts(&mut s, &[font("a", &["missing"])], &[]),
            Err(Refusal::SceneAssetUnknown { asset_id, object }) if asset_id == "missing" && object == "a"
        ));
        let mut unlicensed = font("a", &["x"]);
        unlicensed.license = Some("  ".into());
        assert!(matches!(
            add_fonts(&mut s, &[unlicensed], &[asset("x")]),
            Err(Refusal::FontEmbeddingRefused { .. })
        ));
        assert!(s.fonts.is_empty() && s.assets.is_empty());
    }

    #[test]
    fn a_font_in_use_is_refused_naming_its_objects_and_styles() {
        let mut s = scene();
        add_fonts(&mut s, &[font("a", &["x"])], &[asset("x")]).unwrap();
        let text = crate::authoring::create_object(&mut s, "text", "Title").unwrap();
        if let Some(SceneObject::Text(t)) = s.objects.iter_mut().find(|o| o.base().id == text) {
            t.font_id = "a".into();
        }
        let before = s.clone();
        assert!(matches!(
            remove_font(&mut s, "a"),
            Err(Refusal::FontInUse { objects, text_styles, .. }) if objects == [text.clone()] && text_styles.is_empty()
        ));
        assert_eq!(s, before);
    }

    #[test]
    fn removal_drops_only_assets_no_other_font_uses() {
        let mut s = scene();
        add_fonts(
            &mut s,
            &[font("a", &["shared", "own"]), font("b", &["shared"])],
            &[asset("shared"), asset("own")],
        )
        .unwrap();
        assert_eq!(remove_font(&mut s, "a").unwrap(), vec!["own".to_string()]);
        assert_eq!(s.fonts.iter().map(|f| f.font_id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert_eq!(s.assets.iter().map(|a| a.asset_id.as_str()).collect::<Vec<_>>(), ["shared"]);
        assert!(matches!(remove_font(&mut s, "a"), Err(Refusal::FontUnknown { font_id }) if font_id == "a"));
    }
}
