//! Independent authored-value witnesses for the corrected colour-ramp golden
//! frame. These assert opacity/compositing semantics, not a captured checksum.
use std::collections::{HashMap, HashSet};

use gx_contracts::{
    color::OutputTransform, material::MaterialSupport, scene::parse_scene_document,
};
use gx_render_worker::prepared::PreparedScene;

#[test]
fn colour_reference_matches_authored_opacity_and_over_compositing() {
    let scene = parse_scene_document(include_bytes!(
        "../../../../tests/reference-scenes/colour-ramp-50.json"
    ))
    .unwrap();
    let font = include_bytes!("fixtures/Inter-Regular.ttf").to_vec();
    let hash = gx_asset_plane::content_hash(&font);
    assert_eq!(scene.assets[0].checksum.as_ref(), Some(&hash));
    let prepared = PreparedScene::prepare(
        scene,
        &HashSet::from([hash.clone()]),
        &HashMap::from([(hash, font)]),
        &MaterialSupport::fixed_function(),
    )
    .unwrap();
    let frame = prepared.frame_at(0, OutputTransform::Srgb).unwrap();
    let at = |x: usize, y: usize| &frame.pixels[(y * frame.width as usize + x) * 4..][..4];
    assert_eq!(at(5, 5), [255, 0, 0, 255], "opaque ramp red");
    assert_eq!(
        at(28, 40),
        [255, 0, 0, 26],
        "red veil at authored opacity 0.1"
    );
    // Linear white at .2, then red at .1: alpha .28, green/blue
    // .18/.28, encoded as sRGB 210. No text/vector covers this sample.
    assert_eq!(at(40, 40), [255, 210, 210, 71]);
    for (&actual, expected) in at(90, 100).iter().zip([26_u8, 102, 255, 255]) {
        assert!(
            actual.abs_diff(expected) <= 1,
            "authored opaque vector fill"
        );
    }
    assert_eq!(
        at(250, 120),
        [255, 210, 210, 71],
        "removed mesh placeholder leaves the authored veils"
    );
    assert_eq!(at(300, 170), [0, 0, 0, 0], "outside all authored geometry");
}
