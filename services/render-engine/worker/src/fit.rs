//! The record check, measured (plan row 11.153; the contract and the reasoning are `gx_contracts::fit_report`).
//!
//! For each record asked about, every text object bound to data (`bindings.text`) is given the record's value and shaped in its own box by
//! [`prepare_text_object`], the shaping the renderer draws with, so the answer cannot disagree with what is drawn. The shaped text is then
//! compared with the box in the directions its layout does not grow:
//!
//! - **paragraph** text wraps at the box width, so it overflows when its lines need more height than the box (a box height of 0 states no
//!   height and is not checked). A word wider than the box is broken by letter, as the engine draws it, so it shows as height too;
//! - **point** text never wraps, so it overflows when it is wider than the box (a box width of 0 states no width and is not checked).
//!
//! Half a unit of slack absorbs the rounding of shaped advances: nothing is reported for a text that is over by less than that. A value
//! that is null, blank or absent is not shaped: it is reported as Empty or Missing, with whether the element hides when empty.
//!
//! An element that shrinks to fit (`autoFit: shrink`, row 11.51) is shaped smaller by the same call until its box holds it, so it
//! overflows here only when it still does not fit at the shaper's floor size; one that grows to fit (`autoFit: fit`) never overflows. Fonts are read from the scene and the asset bytes the caller holds; a missing font is the shaper's own named refusal.

use std::collections::HashSet;

use gx_contracts::bindings::{text_binding, TextBinding};
use gx_contracts::fit_report::{ElementFit, FitAxis, FitFailure, FitReport, FitRequest, FitResult, RecordFit, MOST_FIT_RECORDS};
use gx_contracts::scene::{SceneDocument, SceneObject, TextAutoFit, TextObject};
use gx_contracts::Refusal;

use crate::mesh::AssetBytes;
use crate::text::{exceeds_box_by, prepare_text_object};

/// Check `request.scene` against `request.records`. Nothing is drawn and nothing is changed.
pub fn fit_report(request: &FitRequest, asset_bytes: &AssetBytes) -> Result<FitReport, FitFailure> {
    if request.records.len() > MOST_FIT_RECORDS {
        return Err(FitFailure::Invalid(format!(
            "{} records asked about; at most {MOST_FIT_RECORDS} at a time",
            request.records.len()
        )));
    }
    let mut seen = HashSet::new();
    for record in &request.records {
        if record.id.trim().is_empty() {
            return Err(FitFailure::Invalid("a record has no id".into()));
        }
        if !seen.insert(record.id.as_str()) {
            return Err(FitFailure::Invalid(format!("record {} is named twice", record.id)));
        }
    }

    let mut records = Vec::with_capacity(request.records.len());
    for record in &request.records {
        let mut elements = Vec::new();
        for object in &request.scene.objects {
            let SceneObject::Text(text) = object else { continue };
            let Some(path) = text.base.bindings.as_ref().and_then(|bindings| bindings.get("text")).and_then(|path| path.as_str()) else {
                continue;
            };
            let hidden = text.base.hide_when_empty == Some(true);
            let state = text_binding(&record.values, path).map_err(|detail| {
                FitFailure::Refused(Refusal::BindingPathInvalid { path: path.to_owned(), detail })
            })?;
            let fit = match state {
                TextBinding::Missing => FitResult::Missing { path: path.to_owned(), hidden },
                TextBinding::Empty => FitResult::Empty { hidden },
                TextBinding::Text(value) => {
                    let mut bound = text.clone();
                    bound.text = value;
                    measure(&request.scene, &bound, asset_bytes)?
                }
            };
            elements.push(ElementFit { object_id: text.base.id.clone(), fit });
        }
        records.push(RecordFit { id: record.id.clone(), elements });
    }
    Ok(FitReport { records })
}

/// Shape one bound text in its box and compare.
fn measure(scene: &SceneDocument, text: &TextObject, asset_bytes: &AssetBytes) -> Result<FitResult, FitFailure> {
    let shaped = prepare_text_object(scene, text, asset_bytes).map_err(FitFailure::Refused)?;
    let lines = u32::try_from(shaped.line_count()).unwrap_or(u32::MAX);
    // `prepare_text_object` has already shrunk an `autoFit: shrink` text to its box (to the floor at worst), and a text that grows to fit
    // never exceeds, so the one rule the draw uses is the one applied here.
    let (over_width, over_height) = if text.auto_fit == TextAutoFit::Fit {
        (0.0, 0.0)
    } else {
        exceeds_box_by(text, f64::from(shaped.width), f64::from(shaped.height))
    };
    let hidden_height = f64::from(shaped.height - shaped.visible_height);
    // Vertical text hides its columns past `maxLines` along the width.
    let hidden_width = f64::from(shaped.hidden_width);
    Ok(verdict(over_width.max(hidden_width), over_height.max(hidden_height), lines))
}

/// The answer for the two excesses (0 for a direction that is not over): nothing over fits; otherwise the larger excess is the one named,
/// height when they tie, rounded to one decimal.
fn verdict(over_width: f64, over_height: f64, lines: u32) -> FitResult {
    if over_width <= 0.0 && over_height <= 0.0 {
        FitResult::Fits
    } else if over_height >= over_width {
        FitResult::Overflows { by_px: round1(over_height), axis: FitAxis::Height, lines }
    } else {
        FitResult::Overflows { by_px: round1(over_width), axis: FitAxis::Width, lines }
    }
}

/// One decimal, as a person reads it: "by 64.3 px".
fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use gx_contracts::fit_report::FitRecord;
    use gx_contracts::font::{EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus, FontSource, FontStyle};
    use gx_contracts::scene::{new_scene, AssetAvailability, AssetKind, AssetLibraryItem};
    use gx_contracts::ContentHash;

    pub(crate) const INTER: &[u8] = include_bytes!("../tests/fixtures/Inter-Regular.ttf");

    pub(crate) fn hash() -> ContentHash {
        ContentHash("inter".into())
    }

    pub(crate) fn inter() -> FontDefinition {
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
                source: FontSource::File { asset_id: "inter".into(), format: FontFormat::Ttf, original_url: None, stylesheet_url: None },
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

    pub(crate) fn bytes() -> AssetBytes {
        AssetBytes::from([(hash(), INTER.to_vec())])
    }

    /// A name plate: one text bound to `p.name`, in a box.
    pub(crate) fn plate(layout: &str, width: f64, height: f64, hide: bool) -> SceneObject {
        serde_json::from_value(serde_json::json!({
            "type": "text", "id": "name", "name": "Name", "text": "Authored", "fontId": "font_inter", "size": 40,
            "layout": layout, "width": width, "height": height, "hideWhenEmpty": hide,
            "bindings": { "text": "p.name" }
        }))
        .unwrap()
    }

    pub(crate) fn scene(objects: Vec<SceneObject>) -> SceneDocument {
        let mut scene = new_scene("scene", "Scene", gx_contracts::color::WorkingColorSpace::NEW_PROJECT);
        scene.assets.push(AssetLibraryItem {
            asset_id: "inter".into(),
            name: "Inter".into(),
            kind: AssetKind::Font,
            path: "fonts/inter.ttf".into(),
            checksum: Some(hash()),
            mime_type: Some("font/ttf".into()),
            size_bytes: Some(INTER.len() as u64),
            status: Some(AssetAvailability::Ready),
            provenance: Default::default(),
            color_space: None,
        });
        scene.fonts.push(inter());
        scene.objects = objects;
        scene
    }

    pub(crate) fn record(id: &str, name: serde_json::Value) -> FitRecord {
        FitRecord { id: id.into(), values: serde_json::from_value(serde_json::json!({ "p": { "name": name } })).unwrap() }
    }

    fn check(layout: &str, width: f64, height: f64, hide: bool, records: Vec<FitRecord>) -> Vec<FitResult> {
        let request = FitRequest { scene: scene(vec![plate(layout, width, height, hide)]), records };
        let report = fit_report(&request, &bytes()).expect("the scene is measurable");
        report.records.into_iter().map(|record| record.elements.into_iter().next().expect("one text").fit).collect()
    }

    /// The record check on the cases Figma B4 draws: a name that fits, one that is too long for its plate, an empty one, a missing one.
    #[test]
    fn point_text_is_checked_for_width_and_never_for_height() {
        let results = check(
            "point",
            400.0,
            10.0,
            false,
            vec![
                record("1", serde_json::json!("ARJUN RAO")),
                record("17", serde_json::json!("VENKATASUBRAMANIAN IYER SUBRAMANIAM")),
                record("31", serde_json::json!("   ")),
                record("32", serde_json::Value::Null),
            ],
        );
        assert_eq!(results[0], FitResult::Fits, "the plate is far taller than 10 units of height, and point text does not check height");
        let FitResult::Overflows { by_px, axis, lines } = results[1] else { panic!("{:?}", results[1]) };
        assert_eq!(axis, FitAxis::Width);
        assert_eq!(lines, 1);
        assert!(by_px > 300.0, "the long name is far wider than its plate: {by_px}");
        assert_eq!(results[2], FitResult::Empty { hidden: false });
        assert_eq!(results[3], FitResult::Empty { hidden: false });
    }

    #[test]
    fn paragraph_text_wraps_and_overflows_in_height_including_a_word_wider_than_the_box() {
        // 40-unit text wraps at 300 wide; two lines of ~48 fit in 120, five do not fit in 120.
        let results = check(
            "paragraph",
            300.0,
            120.0,
            false,
            vec![
                record("1", serde_json::json!("Soul Gaming")),
                record("2", serde_json::json!("one two three four five six seven eight nine ten eleven twelve")),
                record("3", serde_json::json!("SUPERCALIFRAGILISTICEXPIALIDOCIOUS")),
            ],
        );
        assert_eq!(results[0], FitResult::Fits);
        let FitResult::Overflows { by_px, axis, lines } = results[1] else { panic!("{:?}", results[1]) };
        assert_eq!(axis, FitAxis::Height);
        assert!(lines >= 4, "the text wrapped into {lines} lines");
        assert!(by_px > 0.0);
        // One word wider than the box is broken by letter, as the engine draws it, so it is the lines that overflow.
        let FitResult::Overflows { axis, lines, .. } = results[2] else { panic!("{:?}", results[2]) };
        assert_eq!(axis, FitAxis::Height);
        assert!(lines >= 2, "the long word was broken into {lines} lines");
    }

    /// Row 11.51: the record check measures the text the engine draws, so a name that shrinks to its plate fits and a name that grows
    /// never overflows; only a plate too small even for the floor size still reports.
    #[test]
    fn auto_fit_changes_the_verdict_the_way_the_draw_changes_the_text() {
        let long = serde_json::json!("VENKATASUBRAMANIAN IYER SUBRAMANIAM");
        let with = |auto_fit: &str, width: f64| {
            let mut object = plate("point", width, 60.0, false);
            if let SceneObject::Text(text) = &mut object {
                text.auto_fit = serde_json::from_value(serde_json::json!(auto_fit)).unwrap();
            }
            let request = FitRequest { scene: scene(vec![object]), records: vec![record("1", long.clone())] };
            fit_report(&request, &bytes()).expect("measurable").records.remove(0).elements.remove(0).fit
        };
        assert!(matches!(with("none", 400.0), FitResult::Overflows { axis: FitAxis::Width, .. }));
        assert_eq!(with("shrink", 400.0), FitResult::Fits);
        assert_eq!(with("fit", 400.0), FitResult::Fits);
        assert!(matches!(with("shrink", 1.0), FitResult::Overflows { axis: FitAxis::Width, .. }), "a 1 unit plate is below the floor size");
    }

    #[test]
    fn a_box_that_states_no_size_checks_nothing() {
        let results = check("paragraph", 0.0, 0.0, false, vec![record("1", serde_json::json!("VENKATASUBRAMANIAN IYER SUBRAMANIAM"))]);
        assert_eq!(results, vec![FitResult::Fits]);
        let point = check("point", 0.0, 500.0, false, vec![record("1", serde_json::json!("VENKATASUBRAMANIAN IYER SUBRAMANIAM"))]);
        assert_eq!(point, vec![FitResult::Fits]);
    }

    #[test]
    fn empty_and_missing_say_whether_the_element_hides() {
        let records = || {
            vec![
                record("blank", serde_json::json!("")),
                FitRecord { id: "absent".into(), values: serde_json::from_value(serde_json::json!({ "p": {} })).unwrap() },
                FitRecord { id: "other".into(), values: serde_json::from_value(serde_json::json!({ "q": 1 })).unwrap() },
            ]
        };
        assert_eq!(
            check("point", 400.0, 60.0, true, records()),
            vec![
                FitResult::Empty { hidden: true },
                FitResult::Missing { path: "p.name".into(), hidden: true },
                FitResult::Missing { path: "p.name".into(), hidden: true },
            ]
        );
        assert_eq!(
            check("point", 400.0, 60.0, false, records())[1],
            FitResult::Missing { path: "p.name".into(), hidden: false }
        );
    }

    /// Half a unit of slack, and the same shaping as the draw: a text measured to fit its own measured width fits.
    #[test]
    fn a_box_exactly_as_wide_as_the_text_fits_and_one_unit_narrower_does_not() {
        let name = "ARJUN RAO";
        let measured = {
            let request = FitRequest { scene: scene(vec![plate("point", 1.0, 10.0, false)]), records: vec![record("1", serde_json::json!(name))] };
            let FitResult::Overflows { by_px, .. } = fit_report(&request, &bytes()).unwrap().records[0].elements[0].fit else { panic!("a 1 unit box must overflow") };
            1.0 + by_px
        };
        assert_eq!(check("point", measured.ceil(), 60.0, false, vec![record("1", serde_json::json!(name))]), vec![FitResult::Fits]);
        let narrower = check("point", measured.floor() - 1.0, 60.0, false, vec![record("1", serde_json::json!(name))]);
        assert!(matches!(narrower[0], FitResult::Overflows { axis: FitAxis::Width, .. }), "{:?}", narrower[0]);
    }

    /// The verdict for the two excesses: the larger one is named, height on a tie, one decimal.
    #[test]
    fn the_larger_excess_is_named_height_on_a_tie_and_rounded_to_one_decimal() {
        assert_eq!(verdict(0.0, 0.0, 1), FitResult::Fits);
        assert_eq!(verdict(10.0, 10.0, 2), FitResult::Overflows { by_px: 10.0, axis: FitAxis::Height, lines: 2 });
        assert_eq!(verdict(12.0, 5.0, 1), FitResult::Overflows { by_px: 12.0, axis: FitAxis::Width, lines: 1 });
        assert_eq!(verdict(5.0, 12.0, 3), FitResult::Overflows { by_px: 12.0, axis: FitAxis::Height, lines: 3 });
        assert_eq!(verdict(64.26, 0.0, 1), FitResult::Overflows { by_px: 64.3, axis: FitAxis::Width, lines: 1 });
        assert_eq!(verdict(0.0, 64.24, 1), FitResult::Overflows { by_px: 64.2, axis: FitAxis::Height, lines: 1 });
    }

    #[test]
    fn only_texts_bound_to_data_are_reported_and_in_the_scene_order() {
        let mut free: SceneObject = serde_json::from_value(serde_json::json!({
            "type": "text", "id": "free", "name": "Free", "text": "Always", "fontId": "font_inter", "size": 40, "width": 10, "height": 10
        }))
        .unwrap();
        free.base_mut().x = 5.0;
        let mut second = plate("point", 400.0, 60.0, false);
        second.base_mut().id = "role".into();
        second.base_mut().bindings = Some(serde_json::Map::from_iter([("text".to_string(), serde_json::json!("p.role"))]));
        let request = FitRequest { scene: scene(vec![plate("point", 400.0, 60.0, false), free, second]), records: vec![record("1", serde_json::json!("Soul"))] };
        let report = fit_report(&request, &bytes()).unwrap();
        let ids: Vec<&str> = report.records[0].elements.iter().map(|element| element.object_id.as_str()).collect();
        assert_eq!(ids, ["name", "role"], "the free text is not measured and the order is the scene's");
        assert_eq!(report.records[0].elements[1].fit, FitResult::Missing { path: "p.role".into(), hidden: false });
    }

    #[test]
    fn a_request_that_is_not_one_and_a_fault_in_the_scene_are_named() {
        let request = |records: Vec<FitRecord>| FitRequest { scene: scene(vec![plate("point", 400.0, 60.0, false)]), records };
        let invalid = |records: Vec<FitRecord>| match fit_report(&request(records), &bytes()) {
            Err(FitFailure::Invalid(detail)) => detail,
            other => panic!("expected an invalid request: {other:?}"),
        };
        assert!(invalid(vec![record("1", serde_json::json!("a")), record("1", serde_json::json!("b"))]).contains("named twice"));
        assert!(invalid(vec![record(" ", serde_json::json!("a"))]).contains("no id"));
        assert!(invalid((0..=MOST_FIT_RECORDS).map(|n| record(&n.to_string(), serde_json::json!("a"))).collect()).contains("at most"));
        // A number where a text is bound, and a font the engine was not given bytes for, are refused by name.
        let number = fit_report(&request(vec![FitRecord { id: "1".into(), values: serde_json::from_value(serde_json::json!({"p": {"name": 7}})).unwrap() }]), &bytes());
        assert!(matches!(number, Err(FitFailure::Refused(Refusal::BindingPathInvalid { .. }))), "{number:?}");
        let no_bytes = fit_report(&request(vec![record("1", serde_json::json!("Soul"))]), &AssetBytes::new());
        assert!(matches!(no_bytes, Err(FitFailure::Refused(_))), "{no_bytes:?}");
        // No records is a report with no records, not a fault.
        assert_eq!(fit_report(&request(Vec::new()), &bytes()).unwrap(), FitReport { records: Vec::new() });
    }
}
