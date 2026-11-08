//! Published assets reach the engine (build plan 5.9).
//!
//! Before 5.9 the real engine had no way to receive asset bytes: a scene with a
//! font or an image was refused `AssetMissing` however it was published. This
//! drives the one product route against the real worker: preflight, then the
//! 5.3 transfer of only the missing bytes, on the same asset-plane address the
//! scene is published to; then the scene publishes and goes to Program.

use std::net::SocketAddr;

use gx_asset_plane::{
    content_hash, publish_assets, publish_scene, AssetBytes, PublishRefusal, PublishReply,
};
use gx_contracts::scene::{
    parse_scene_document, AssetKind, AssetLibraryItem, ImageObject, ObjectBase, SceneDocument,
    SceneObject,
};
use gx_contracts::Refusal;
use gx_control_plane::intent::{TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_plane::peer::EnginePeer;

use crate::{expect, Outcome, Report};

const PLANE: &str = "asset";
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../services/render-engine/worker/tests/fixtures"
);

/// The GPU reference lower third (text in Inter) plus one declared PNG image
/// asset, under a take id of its own. The image is an asset only: drawing an
/// image object on the GPU is 3.17's, and refuses by name until then.
fn scene_with_assets(id: &str) -> Result<(SceneDocument, Vec<AssetBytes>), String> {
    let json =
        std::fs::read(format!("{FIXTURES}/gpu-lower-third-50.json")).map_err(|e| e.to_string())?;
    let mut scene = parse_scene_document(&json).map_err(|e| e.to_string())?;
    scene.id = id.to_owned();
    let font = std::fs::read(format!("{FIXTURES}/Inter-Regular.ttf")).map_err(|e| e.to_string())?;
    let font_hash = content_hash(&font);
    if !scene
        .assets
        .iter()
        .any(|asset| asset.checksum.as_ref() == Some(&font_hash))
    {
        return Err("the fixture's font asset does not declare the fixture font's hash".into());
    }
    let png = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/baselines/rate-25.png"
    ))
    .map_err(|e| e.to_string())?;
    let png_hash = content_hash(&png);
    scene.assets.push(AssetLibraryItem {
        asset_id: "conformance-image".into(),
        name: "Conformance image".into(),
        kind: AssetKind::Image,
        path: "images/rate-25.png".into(),
        checksum: Some(png_hash.clone()),
        mime_type: Some("image/png".into()),
        size_bytes: Some(png.len() as u64),
        status: None,
        provenance: gx_contracts::provenance::AssetProvenance::default(),
    });
    Ok((
        scene,
        vec![
            AssetBytes {
                hash: font_hash,
                bytes: font,
            },
            AssetBytes {
                hash: png_hash,
                bytes: png,
            },
        ],
    ))
}

/// 5.9 against an engine reached over its control client and asset plane.
pub fn asset_route_suite<P: EnginePeer>(
    control: &mut P,
    asset_plane: SocketAddr,
    report: &mut Report,
) {
    let (scene, assets) = match scene_with_assets("conformance/asset-route") {
        Ok(built) => built,
        Err(e) => {
            report.record(
                PLANE,
                "a scene's assets reach the engine before the scene",
                Outcome::Fail(format!("fixture: {e}")),
            );
            return;
        }
    };

    // Without the bytes the engine cannot prepare the scene, so it refuses.
    let alone = publish_scene(asset_plane, scene.clone());
    let refused_for_bytes = matches!(
        &alone,
        Ok(PublishReply::Refused(PublishRefusal::PreparationRefused {
            cause: Refusal::AssetMissing { .. }
        }))
    );

    let first = publish_assets(asset_plane, &assets);
    let declared: u64 = assets.iter().map(|asset| asset.bytes.len() as u64).sum();
    report.record(
        PLANE,
        "a scene's assets reach the engine before the scene",
        expect(
            refused_for_bytes
                && matches!(&first, Ok(summary) if summary.missing.len() == assets.len() && summary.transferred_bytes == declared),
            format!("5.9: scene alone {alone:?}; first transfer {first:?} (expected {} missing, {declared} bytes)", assets.len()),
        ),
    );

    let published = publish_scene(asset_plane, scene);
    let taken = match &published {
        Ok(PublishReply::Published {
            take_id,
            revision,
            content_hash,
        }) => control.handle(ClientRequest::Take(TakeRequest {
            take_id: take_id.clone(),
            revision: *revision,
            content_hash: Some(content_hash.clone()),
            at: TakeAt::NextOpportunity,
        })),
        other => EngineReply::Refused(Refusal::NotImplemented {
            what: format!("publish was {other:?}"),
        }),
    };
    report.record(
        PLANE,
        "a scene with a font and an image publishes and goes to Program",
        match &taken {
            EngineReply::Taken(_) => Outcome::Pass,
            // A sub-T0 engine refuses a Program take by name; the publish is
            // what 5.9 proves, so that is a skip that says so (invariant 43).
            EngineReply::Refused(Refusal::TierTooLow { actual })
                if matches!(published, Ok(PublishReply::Published { .. })) =>
            {
                Outcome::Skip(format!(
                    "published; the engine is {actual:?}, below T0, so it refuses the take"
                ))
            }
            other => Outcome::Fail(format!("5.9: publish {published:?}, take {other:?}")),
        },
    );

    // 5.3 into the engine: a second publication sends no byte it already holds.
    // An image object over the delivered image asset: refused by name until
    // 3.17 draws images on the GPU, never dropped from the frame.
    let image = scene_with_assets("conformance/asset-route-image").map(|(mut scene, _)| {
        let mut base = ObjectBase::new("conformance-image", "Image");
        base.width = 320.0;
        base.height = 180.0;
        scene.objects.push(SceneObject::Image(ImageObject {
            base,
            asset_id: "conformance-image".into(),
            fit: Default::default(),
        }));
        publish_scene(asset_plane, scene)
    });
    report.record(
        PLANE,
        "an image object over a delivered image asset is refused by name until 3.17",
        expect(
            matches!(
                &image,
                Ok(Ok(PublishReply::Refused(PublishRefusal::PreparationRefused {
                    cause: Refusal::ObjectKindNotDrawable { kind, owner, .. }
                }))) if kind == "image" && owner == "3.17"
            ),
            format!("5.9: image object publish {image:?}"),
        ),
    );

    let second = publish_assets(asset_plane, &assets);
    report.record(
        PLANE,
        "re-publishing moves no asset bytes the engine already holds",
        expect(
            matches!(&second, Ok(summary) if summary.missing.is_empty() && summary.transferred_bytes == 0),
            format!("5.9: second transfer {second:?}"),
        ),
    );
}
