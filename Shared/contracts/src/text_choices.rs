//! The choices a text object stores that the Properties dock offers (plan row 11.132, Figma B3d Style card), and which of them the engine
//! draws today. Case, Align, Vertical align, Box (point or paragraph text) and Fit.
//!
//! **What the engine draws is decided once, in Rust, by asking the drawability check itself.** For every value of every choice this builds a
//! one-object scene whose only departure from the defaults is that value, under each layout, and runs the public
//! [`drawability_refusals`](crate::drawability::drawability_refusals) on it. A value the check refuses is listed as not drawn there, with
//! the plan row that owns drawing it. Nothing here names a fact about the engine, so when row 11.51 draws small caps the surface says so by
//! itself, and the Editor, which copies none of this, follows (invariant 27; asked of Jev and Laya first,
//! `docs/evidence/11.132/jev-laya-text-choices.json`).
//!
//! Alignment is the one choice that depends on another: centre and right are drawn for paragraph text and refused for point text. A value
//! therefore says the LAYOUTS it is drawn under, and the Editor offers a value only when it is drawn under the layout of every selected object.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::drawability::drawability_refusals;
use crate::scene::{new_scene, SceneObject};
use crate::{color::WorkingColorSpace, Refusal};

/// One value of one choice, in the scene's own wire words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextChoiceValue {
    /// The value as the scene and the `setObjectField` edit write it: `small-caps`, `center`, `paragraph`.
    pub value: String,
    /// The value as a person reads it.
    pub label: String,
    /// The layouts (`point`, `paragraph`) under which the engine draws a text object with this value and nothing else changed. Empty: it
    /// is not drawn under either.
    pub drawn_for_layouts: Vec<String>,
    /// The plan row that will draw it, when it is not drawn under every layout it could be set under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub owner: Option<String>,
}

/// One choice and its values, in the order the dock lists them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextChoiceField {
    /// The `setObjectField` name and the text object's own field: `textCase`, `align`, `verticalAlign`, `layout`, `autoFit`.
    pub field: String,
    pub label: String,
    pub values: Vec<TextChoiceValue>,
}

/// Every text choice the Properties dock offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextChoices {
    pub fields: Vec<TextChoiceField>,
}

/// The choices, their values and their words: the contract's own enums in the order a person reads them. Kept next to the enums in
/// `scene.rs`; a test pins that every value here parses as the real enum.
const FIELDS: &[(&str, &str, &[(&str, &str)])] = &[
    (
        "textCase",
        "Case",
        &[("original", "As typed"), ("upper", "Uppercase"), ("lower", "Lowercase"), ("title", "Title case"), ("small-caps", "Small caps")],
    ),
    ("align", "Align", &[("left", "Left"), ("center", "Centre"), ("right", "Right")]),
    ("verticalAlign", "Vertical align", &[("top", "Top"), ("middle", "Middle"), ("bottom", "Bottom")]),
    ("layout", "Box", &[("point", "Point text"), ("paragraph", "Paragraph text")]),
    (
        "writingMode",
        "Writing mode",
        &[("horizontal-tb", "Horizontal"), ("vertical-rl", "Vertical, columns right to left"), ("vertical-lr", "Vertical, columns left to right")],
    ),
    ("autoFit", "Fit", &[("none", "Fixed"), ("shrink", "Shrinks to fit"), ("fit", "Grows to fit")]),
    ("overflow", "Overflow", &[("visible", "Visible"), ("hidden", "Hidden"), ("clip", "Clip")]),
];

const LAYOUTS: [&str; 2] = ["point", "paragraph"];

/// A one-object scene with a text object that has the defaults but for `field = value` and `layout`.
fn probe(field: &str, value: &str, layout: &str) -> crate::scene::SceneDocument {
    let mut text = serde_json::json!({
        "type": "text", "id": "probe", "name": "probe", "text": "Hello", "fontId": "font", "size": 40.0,
        "layout": layout,
    });
    text[field] = serde_json::json!(value);
    let object: SceneObject = serde_json::from_value(text).unwrap_or_else(|why| panic!("{field} = {value} is not a text value: {why}"));
    let mut scene = new_scene("probe", "Probe", WorkingColorSpace::Srgb);
    scene.objects = vec![object];
    scene
}

/// Every text choice, with what the engine draws of each value now.
pub fn text_choices() -> TextChoices {
    let fields = FIELDS
        .iter()
        .map(|(field, label, values)| TextChoiceField {
            field: (*field).to_owned(),
            label: (*label).to_owned(),
            values: values
                .iter()
                .map(|(value, words)| {
                    // The layout is itself a value: it is drawn under itself, so it is probed once.
                    let layouts: Vec<&str> = if *field == "layout" { vec![*value] } else { LAYOUTS.to_vec() };
                    let mut drawn = Vec::new();
                    let mut owner = None;
                    for layout in layouts {
                        let refusals = drawability_refusals(&probe(field, value, layout));
                        if refusals.is_empty() {
                            drawn.push(layout.to_owned());
                        } else if owner.is_none() {
                            owner = refusals.iter().find_map(|found| match &found.code {
                                Refusal::ScenePropertyNotDrawable { owner, .. } => Some(owner.clone()),
                                _ => None,
                            });
                        }
                    }
                    TextChoiceValue { value: (*value).to_owned(), label: (*words).to_owned(), drawn_for_layouts: drawn, owner }
                })
                .collect(),
        })
        .collect();
    TextChoices { fields }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value<'a>(choices: &'a TextChoices, field: &str, value: &str) -> &'a TextChoiceValue {
        choices
            .fields
            .iter()
            .find(|candidate| candidate.field == field)
            .and_then(|candidate| candidate.values.iter().find(|candidate| candidate.value == value))
            .unwrap_or_else(|| panic!("{field} = {value} is not listed"))
    }

    fn drawn(choices: &TextChoices, field: &str, which: &str) -> Vec<String> {
        value(choices, field, which).drawn_for_layouts.clone()
    }

    #[test]
    fn the_five_choices_are_listed_in_the_order_the_dock_reads_them_with_their_values() {
        let choices = text_choices();
        let listed: Vec<(&str, Vec<&str>)> = choices
            .fields
            .iter()
            .map(|field| (field.field.as_str(), field.values.iter().map(|value| value.value.as_str()).collect()))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("textCase", vec!["original", "upper", "lower", "title", "small-caps"]),
                ("align", vec!["left", "center", "right"]),
                ("verticalAlign", vec!["top", "middle", "bottom"]),
                ("layout", vec!["point", "paragraph"]),
                ("writingMode", vec!["horizontal-tb", "vertical-rl", "vertical-lr"]),
                ("autoFit", vec!["none", "shrink", "fit"]),
                ("overflow", vec!["visible", "hidden", "clip"]),
            ]
        );
        assert_eq!(choices.fields.iter().map(|field| field.label.as_str()).collect::<Vec<_>>(), ["Case", "Align", "Vertical align", "Box", "Writing mode", "Fit", "Overflow"]);
    }

    #[test]
    fn every_value_is_one_the_scene_reads_and_the_edit_writes_in_the_same_words() {
        // `probe` panics on a value the real text object does not parse; the edit's wire form is the same enum.
        for field in text_choices().fields {
            for value in field.values {
                let _ = probe(&field.field, &value.value, "point");
                let wire = serde_json::json!({"name": field.field, "value": value.value});
                serde_json::from_value::<crate::object_edit::ObjectField>(wire.clone()).unwrap_or_else(|why| panic!("{wire}: {why}"));
            }
        }
    }

    #[test]
    fn the_defaults_are_drawn_under_every_layout() {
        let choices = text_choices();
        for (field, which) in [("textCase", "original"), ("align", "left"), ("verticalAlign", "top"), ("autoFit", "none")] {
            assert_eq!(drawn(&choices, field, which), ["point", "paragraph"], "{field} = {which}");
            assert_eq!(value(&choices, field, which).owner, None);
        }
        assert_eq!(drawn(&choices, "layout", "point"), ["point"]);
        assert_eq!(drawn(&choices, "layout", "paragraph"), ["paragraph"]);
    }

    // These pin what the engine draws TODAY, read from its own drawability check. When row 11.51 draws a value, the surface changes
    // by itself and the matching line here is the one to update: a failure here is not a bug in the surface.
    #[test]
    fn what_the_engine_draws_today_is_what_its_drawability_check_says() {
        let choices = text_choices();
        // Row 11.51: every case is drawn, small capitals included (a smaller capital in place of each lowercase letter).
        for case in ["original", "upper", "lower", "title", "small-caps"] {
            assert_eq!(drawn(&choices, "textCase", case), ["point", "paragraph"], "{case}");
            assert_eq!(value(&choices, "textCase", case).owner, None, "{case}");
        }
        // Row 11.51 slice 1: the engine shrinks a text to its box (and a box that grows to fit never overflows), under both layouts.
        for fit in ["shrink", "fit"] {
            assert_eq!(drawn(&choices, "autoFit", fit), ["point", "paragraph"], "{fit}");
            assert_eq!(value(&choices, "autoFit", fit).owner, None, "{fit}");
        }
        // Row 11.51: vertical writing is set upright in columns, under both layouts.
        for mode in ["horizontal-tb", "vertical-rl", "vertical-lr"] {
            assert_eq!(drawn(&choices, "writingMode", mode), ["point", "paragraph"], "{mode}");
            assert_eq!(value(&choices, "writingMode", mode).owner, None, "{mode}");
        }
        // Row 11.51 slice 2: the lines are placed in the box height, and point text is aligned in the box width.
        for vertical in ["middle", "bottom"] {
            assert_eq!(drawn(&choices, "verticalAlign", vertical), ["point", "paragraph"], "{vertical}");
            assert_eq!(value(&choices, "verticalAlign", vertical).owner, None, "{vertical}");
        }
    }

    #[test]
    fn centre_and_right_are_drawn_for_both_layouts() {
        let choices = text_choices();
        for align in ["left", "center", "right"] {
            assert_eq!(drawn(&choices, "align", align), ["point", "paragraph"], "{align}");
            assert_eq!(value(&choices, "align", align).owner, None, "{align}");
        }
    }

    #[test]
    fn a_value_drawn_everywhere_names_no_owner() {
        let choices = text_choices();
        for field in &choices.fields {
            for value in &field.values {
                if value.drawn_for_layouts.len() == if field.field == "layout" { 1 } else { 2 } {
                    assert_eq!(value.owner, None, "{} = {}", field.field, value.value);
                }
            }
        }
    }

    /// `fixtures/text-choices.json` is the surface as the Editor reads it; `Editor/tests/text-choices.test.ts` runs the dock's rules on the
    /// same file, so the two cannot drift. Rewrite it with GX_WRITE_FIXTURES=1 when the engine draws more.
    #[test]
    fn the_shared_fixture_is_the_surface_the_editor_reads() {
        let current = serde_json::to_value(text_choices()).unwrap();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/text-choices.json");
        if std::env::var("GX_WRITE_FIXTURES").is_ok() {
            std::fs::write(&path, serde_json::to_string_pretty(&current).unwrap() + "\n").unwrap();
        }
        let stored: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("the fixture is there")).expect("the fixture is JSON");
        assert_eq!(stored, current, "run with GX_WRITE_FIXTURES=1 to rewrite fixtures/text-choices.json");
    }

    #[test]
    fn the_surface_is_the_same_every_time_and_is_camel_case_on_the_wire() {
        assert_eq!(text_choices(), text_choices());
        let wire = serde_json::to_value(text_choices()).unwrap();
        let small_caps = &wire["fields"][0]["values"][4];
        assert_eq!(small_caps, &serde_json::json!({"value": "small-caps", "label": "Small caps", "drawnForLayouts": ["point", "paragraph"]}));
        let original = &wire["fields"][0]["values"][0];
        assert!(original.get("owner").is_none(), "owner is absent, not null: {original}");
    }
}
