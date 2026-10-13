//! Asset library edits (11.39): an explicit add.
//!
//! An imported asset enters a scene only through `addAssets`, one command
//! (invariant 60), carrying the provenance its import filled in. Fonts are
//! not added here: a font asset means nothing without the font definition
//! whose faces name it, so it enters with that definition through `addFonts`.

use std::collections::HashSet;

use crate::scene::{AssetKind, AssetLibraryItem, SceneDocument};
use crate::Refusal;

/// Add prepared library entries, all or nothing.
pub fn add_assets(scene: &mut SceneDocument, assets: &[AssetLibraryItem]) -> Result<(), Refusal> {
    if assets.is_empty() {
        return Err(Refusal::AssetBatchEmpty);
    }
    let mut asset_ids: HashSet<&str> = scene.assets.iter().map(|a| a.asset_id.as_str()).collect();
    for asset in assets {
        if asset.kind == AssetKind::Font {
            return Err(Refusal::AssetKindNotAddable {
                asset_id: asset.asset_id.clone(),
                kind: asset.kind,
            });
        }
        if !asset_ids.insert(asset.asset_id.as_str()) {
            return Err(Refusal::SceneAssetDuplicate {
                asset_id: asset.asset_id.clone(),
            });
        }
    }
    scene.assets.extend_from_slice(assets);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provenance::{AssetOrigin, AssetProvenance, ProvenanceTool};
    use crate::scene::new_scene;

    fn asset(id: &str, kind: AssetKind) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: id.into(),
            name: id.into(),
            kind,
            path: format!("assets/{id}"),
            checksum: None,
            mime_type: None,
            size_bytes: None,
            status: None,
            provenance: AssetProvenance {
                origin: Some(AssetOrigin::Human),
                tool: Some(ProvenanceTool {
                    name: "import".into(),
                    version: None,
                }),
                ..AssetProvenance::default()
            },
        }
    }

    #[test]
    fn a_batch_lands_whole_with_its_provenance_or_not_at_all() {
        let mut scene = new_scene("s", "S", crate::color::WorkingColorSpace::NEW_PROJECT);
        add_assets(&mut scene, &[asset("logo", AssetKind::Image)]).unwrap();
        assert_eq!(scene.assets[0].provenance.origin, Some(AssetOrigin::Human));

        // The duplicate is the batch's second entry: the first must not land.
        let refused = add_assets(
            &mut scene,
            &[asset("clip", AssetKind::Video), asset("logo", AssetKind::Image)],
        );
        assert_eq!(refused, Err(Refusal::SceneAssetDuplicate { asset_id: "logo".into() }));
        assert_eq!(scene.assets.len(), 1);

        assert_eq!(
            add_assets(&mut scene, &[asset("face", AssetKind::Font)]),
            Err(Refusal::AssetKindNotAddable { asset_id: "face".into(), kind: AssetKind::Font })
        );
        assert_eq!(add_assets(&mut scene, &[]), Err(Refusal::AssetBatchEmpty));
        assert_eq!(scene.assets.len(), 1);
    }
}
