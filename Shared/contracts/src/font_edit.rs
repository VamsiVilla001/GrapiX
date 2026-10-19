//! Font library edits (11.13): explicit add, update, replace and remove.
//!
//! A font enters a scene only through `addFonts` and leaves only through
//! `removeFont`, each one command (invariant 60). Nothing removes a font
//! implicitly. Removal is refused while a text object or text style names the
//! font, because that text would go to air in a fallback face (invariant 18);
//! so is switching such a font off with `updateFont`. `replaceFont` swaps a
//! font's files under the same id, so what names it keeps naming it.
//! `Editor/src/font-manager.ts` (`planFontRemoval`, `fontUpdateRefused`)
//! states the same rules for the panel; the two change together (invariant 27).

use std::collections::{HashMap, HashSet};

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

    let (objects, text_styles) = font_users(scene, font_id);
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

/// The most fallback families a font may list (the 1.x panel's cap).
pub const MAX_FALLBACK_FAMILIES: usize = 12;

/// Change what the author edits on a font in the panel: its display name,
/// fallback list and enabled state (11.13, the 1.x panel's fields). All or
/// nothing, and something must change.
///
/// Disabling a font something names is refused exactly like removing it: a
/// disabled font is not registered, so that text would go to air in a
/// fallback face (invariant 18). Fallbacks are taken as stated: a blank or
/// repeated family, or more than [`MAX_FALLBACK_FAMILIES`], is refused rather
/// than quietly cleaned up.
pub fn update_font(
    scene: &mut SceneDocument,
    font_id: &str,
    display_name: Option<&str>,
    fallback_families: Option<&[String]>,
    enabled: Option<bool>,
) -> Result<(), Refusal> {
    let invalid = |detail: String| Refusal::InvalidFontData { detail };
    let Some(index) = scene.fonts.iter().position(|f| f.font_id == font_id) else {
        return Err(Refusal::FontUnknown {
            font_id: font_id.to_owned(),
        });
    };
    let mut updated = scene.fonts[index].clone();
    if let Some(name) = display_name {
        if name.trim().is_empty() {
            return Err(invalid(format!("font {font_id} needs a display name")));
        }
        updated.display_name = name.trim().to_owned();
    }
    if let Some(families) = fallback_families {
        if families.len() > MAX_FALLBACK_FAMILIES {
            return Err(invalid(format!(
                "font {font_id} lists {} fallback families; at most {MAX_FALLBACK_FAMILIES}",
                families.len()
            )));
        }
        let mut seen = HashSet::new();
        for family in families {
            let family = family.trim();
            if family.is_empty() {
                return Err(invalid(format!("font {font_id} lists a blank fallback family")));
            }
            if !seen.insert(family.to_lowercase()) {
                return Err(invalid(format!("font {font_id} lists fallback {family} twice")));
            }
        }
        updated.fallback_families = families.iter().map(|f| f.trim().to_owned()).collect();
    }
    if let Some(enabled) = enabled {
        if !enabled {
            let (objects, text_styles) = font_users(scene, font_id);
            if !objects.is_empty() || !text_styles.is_empty() {
                return Err(Refusal::FontInUse {
                    font_id: font_id.to_owned(),
                    objects,
                    text_styles,
                });
            }
        }
        updated.enabled = enabled;
    }
    if updated == scene.fonts[index] {
        return Err(invalid(format!("updateFont for {font_id} changes nothing")));
    }
    scene.fonts[index] = updated;
    Ok(())
}

/// Replace a font's faces and files under the same id (1.x's Replace): text
/// objects and styles keep naming the font, and the author's display name,
/// fallbacks and enabled state are kept. Everything else comes from
/// `replacement`, which is checked as `add_fonts` checks a new font. Returns
/// the old font's file assets that nothing uses any more, which leave the
/// scene with it.
pub fn replace_font(
    scene: &mut SceneDocument,
    font_id: &str,
    replacement: &FontDefinition,
    assets: &[AssetLibraryItem],
) -> Result<Vec<String>, Refusal> {
    let Some(index) = scene.fonts.iter().position(|f| f.font_id == font_id) else {
        return Err(Refusal::FontUnknown {
            font_id: font_id.to_owned(),
        });
    };
    if replacement.faces.is_empty() {
        return Err(Refusal::InvalidFontData {
            detail: format!("font {font_id} has no faces"),
        });
    }
    if replacement.embedding_policy == EmbeddingPolicy::Package
        && replacement.license.as_deref().is_none_or(|l| l.trim().is_empty())
    {
        return Err(Refusal::FontEmbeddingRefused {
            font_id: font_id.to_owned(),
        });
    }

    // An asset already in the scene may be offered again only as the very same
    // record; a different record under that id would rewrite another font's file.
    let mut known: HashMap<&str, &AssetLibraryItem> =
        scene.assets.iter().map(|a| (a.asset_id.as_str(), a)).collect();
    let mut adding = Vec::new();
    for asset in assets {
        match known.get(asset.asset_id.as_str()) {
            Some(existing) if *existing == asset => {}
            Some(_) => {
                return Err(Refusal::SceneAssetDuplicate {
                    asset_id: asset.asset_id.clone(),
                })
            }
            None => {
                known.insert(asset.asset_id.as_str(), asset);
                adding.push(asset.clone());
            }
        }
    }
    for face in &replacement.faces {
        if let FontSource::File { asset_id, .. } = &face.source {
            if !known.get(asset_id.as_str()).is_some_and(|a| a.kind == AssetKind::Font) {
                return Err(Refusal::SceneAssetUnknown {
                    asset_id: asset_id.clone(),
                    object: font_id.to_owned(),
                });
            }
        }
    }

    let current = &scene.fonts[index];
    let font = FontDefinition {
        font_id: current.font_id.clone(),
        display_name: current.display_name.clone(),
        fallback_families: current.fallback_families.clone(),
        enabled: current.enabled,
        ..replacement.clone()
    };
    if &font == current && adding.is_empty() {
        return Err(Refusal::InvalidFontData {
            detail: format!("replaceFont for {font_id} changes nothing"),
        });
    }
    let old = std::mem::replace(&mut scene.fonts[index], font);
    scene.assets.extend(adding);
    let still_used: HashSet<&str> = scene.fonts.iter().flat_map(file_asset_ids).collect();
    let mut orphaned: Vec<String> = Vec::new();
    for id in file_asset_ids(&old) {
        if !still_used.contains(id) && !orphaned.iter().any(|o| o == id) {
            orphaned.push(id.to_owned());
        }
    }
    scene.assets.retain(|asset| !orphaned.contains(&asset.asset_id));
    Ok(orphaned)
}

/// The text objects and text styles that name a font.
fn font_users(scene: &SceneDocument, font_id: &str) -> (Vec<String>, Vec<String>) {
    let objects = scene
        .objects
        .iter()
        .filter_map(|object| match object {
            SceneObject::Text(text) if text.font_id == font_id => Some(text.base.id.clone()),
            _ => None,
        })
        .collect();
    let text_styles = scene
        .text_styles
        .iter()
        .filter(|style| style.font_id == font_id)
        .map(|style| style.style_id.clone())
        .collect();
    (objects, text_styles)
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
        crate::scene::new_scene("fonts", "Fonts", crate::color::WorkingColorSpace::NEW_PROJECT)
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

    fn in_use(s: &mut SceneDocument, font_id: &str) -> String {
        let text = crate::authoring::create_object(s, "text", "Title").unwrap();
        if let Some(SceneObject::Text(t)) = s.objects.iter_mut().find(|o| o.base().id == text) {
            t.font_id = font_id.into();
        }
        text
    }

    #[test]
    fn an_update_changes_only_the_named_fields() {
        let mut s = scene();
        add_fonts(&mut s, &[font("a", &["x"])], &[asset("x")]).unwrap();
        let fallbacks = ["Helvetica".to_string(), " Arial ".to_string()];
        update_font(&mut s, "a", Some(" Brand Sans "), Some(&fallbacks), None).unwrap();
        let a = &s.fonts[0];
        assert_eq!(a.display_name, "Brand Sans");
        assert_eq!(a.fallback_families, ["Helvetica", "Arial"]);
        assert!(a.enabled);
        assert_eq!(a.faces, font("a", &["x"]).faces, "faces are not the update's to change");
        update_font(&mut s, "a", None, None, Some(false)).unwrap();
        assert!(!s.fonts[0].enabled);
    }

    #[test]
    fn an_update_refuses_bad_names_and_fallbacks_and_changing_nothing() {
        let mut s = scene();
        add_fonts(&mut s, &[font("a", &["x"])], &[asset("x")]).unwrap();
        let before = s.clone();
        let detail = |r: Result<(), Refusal>| match r {
            Err(Refusal::InvalidFontData { detail }) => detail,
            other => panic!("expected invalidFontData, got {other:?}"),
        };
        assert!(matches!(
            update_font(&mut s, "nope", None, None, Some(true)),
            Err(Refusal::FontUnknown { font_id }) if font_id == "nope"
        ));
        assert_eq!(detail(update_font(&mut s, "a", Some("  "), None, None)), "font a needs a display name");
        let repeated = ["Arial".to_string(), "arial".to_string()];
        assert_eq!(
            detail(update_font(&mut s, "a", None, Some(&repeated), None)),
            "font a lists fallback arial twice"
        );
        assert_eq!(
            detail(update_font(&mut s, "a", None, Some(&[" ".to_string()]), None)),
            "font a lists a blank fallback family"
        );
        let thirteen: Vec<String> = (0..13).map(|i| format!("F{i}")).collect();
        assert_eq!(
            detail(update_font(&mut s, "a", None, Some(&thirteen), None)),
            "font a lists 13 fallback families; at most 12"
        );
        assert_eq!(detail(update_font(&mut s, "a", None, None, None)), "updateFont for a changes nothing");
        assert_eq!(
            detail(update_font(&mut s, "a", Some("a"), None, Some(true))),
            "updateFont for a changes nothing"
        );
        assert_eq!(s, before);
    }

    #[test]
    fn a_font_in_use_cannot_be_disabled_but_can_be_renamed() {
        let mut s = scene();
        add_fonts(&mut s, &[font("a", &["x"])], &[asset("x")]).unwrap();
        let text = in_use(&mut s, "a");
        let before = s.clone();
        assert!(matches!(
            update_font(&mut s, "a", Some("Renamed"), None, Some(false)),
            Err(Refusal::FontInUse { objects, .. }) if objects == [text.clone()]
        ));
        assert_eq!(s, before, "a refused update changes nothing, not even the name");
        update_font(&mut s, "a", Some("Renamed"), None, None).unwrap();
        assert_eq!(s.fonts[0].display_name, "Renamed");
    }

    #[test]
    fn replace_keeps_the_id_and_the_authors_fields_and_drops_orphaned_files() {
        let mut s = scene();
        add_fonts(
            &mut s,
            &[font("a", &["x", "shared"]), font("b", &["shared"])],
            &[asset("x"), asset("shared")],
        )
        .unwrap();
        let text = in_use(&mut s, "a");
        update_font(&mut s, "a", Some("Brand"), Some(&["Arial".to_string()]), None).unwrap();

        let mut replacement = font("from-file", &["y"]);
        replacement.family = "Brand Sans".into();
        let removed = replace_font(&mut s, "a", &replacement, &[asset("y")]).unwrap();
        assert_eq!(removed, ["x"], "the old file nothing uses leaves; the shared one stays");

        let a = s.fonts.iter().find(|f| f.font_id == "a").unwrap();
        assert_eq!(a.display_name, "Brand");
        assert_eq!(a.fallback_families, ["Arial"]);
        assert!(a.enabled);
        assert_eq!(a.family, "Brand Sans");
        assert_eq!(a.faces, replacement.faces);
        assert_eq!(s.assets.iter().map(|x| x.asset_id.as_str()).collect::<Vec<_>>(), ["shared", "y"]);
        let still = s.objects.iter().find(|o| o.base().id == text).unwrap();
        assert!(matches!(still, SceneObject::Text(t) if t.font_id == "a"), "the text stays on the font");
    }

    #[test]
    fn replace_refuses_as_add_refuses_and_changes_nothing_when_refused() {
        let mut s = scene();
        add_fonts(&mut s, &[font("a", &["x"]), font("b", &["z"])], &[asset("x"), asset("z")]).unwrap();
        let before = s.clone();
        assert!(matches!(
            replace_font(&mut s, "nope", &font("n", &["y"]), &[asset("y")]),
            Err(Refusal::FontUnknown { .. })
        ));
        assert!(matches!(replace_font(&mut s, "a", &font("n", &[]), &[]), Err(Refusal::InvalidFontData { .. })));
        let mut unlicensed = font("n", &["y"]);
        unlicensed.license = None;
        assert!(matches!(
            replace_font(&mut s, "a", &unlicensed, &[asset("y")]),
            Err(Refusal::FontEmbeddingRefused { font_id }) if font_id == "a"
        ));
        assert!(matches!(
            replace_font(&mut s, "a", &font("n", &["missing"]), &[]),
            Err(Refusal::SceneAssetUnknown { asset_id, object }) if asset_id == "missing" && object == "a"
        ));
        // Another font's file id with a different record would rewrite that font's file.
        let mut clash = asset("z");
        clash.checksum = Some(ContentHash("other-bytes".into()));
        assert!(matches!(
            replace_font(&mut s, "a", &font("n", &["z"]), &[clash]),
            Err(Refusal::SceneAssetDuplicate { asset_id }) if asset_id == "z"
        ));
        assert!(matches!(replace_font(&mut s, "a", &font("a", &["x"]), &[]), Err(Refusal::InvalidFontData { .. })));
        assert_eq!(s, before);
        // The very same record already in the scene may be named again.
        replace_font(&mut s, "a", &font("n", &["z"]), &[asset("z")]).unwrap();
        assert_eq!(s.assets.iter().map(|x| x.asset_id.as_str()).collect::<Vec<_>>(), ["z"]);
    }
}
