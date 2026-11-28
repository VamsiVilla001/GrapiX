//! The record check (plan row 11.153, Figma B2v2 and B4): does a record's text fit the layout it is bound to?
//!
//! A graphic is a template an operator fills live, and names vary in length. Before air a designer wants to see every record of a data
//! source checked against the layout: "Record 17 overflows its plate by 64 px". **The engine measures, never the Editor** (decided with
//! Jev and Laya, `docs/evidence/11.153/jev-laya-data-block.json`): the request carries the scene and a list of records; for each record
//! the engine resolves every text object's binding with the record's values and shapes the text in the element's box with the same
//! shaping it draws with, so the answer cannot disagree with what is drawn. This module is the shared vocabulary of the request and the
//! answer; the measuring is `services/render-engine/worker/src/fit.rs`.
//!
//! What the answer says, per record and per text bound to data:
//!
//! - **Fits**: the shaped text is not larger than its box in a direction its layout does not grow.
//! - **Overflows**: it is, by how many pixels, along which axis, in how many lines. Paragraph text overflows when its lines need more
//!   height than the box (a word wider than the box is broken by letter, as the engine draws it, so it counts here); point text
//!   overflows when it is wider than the box.
//! - **Empty**: the value is null, blank or missing. For an element that hides when empty this is the intended outcome
//!   (`hidden` says so); for one that does not it is a blank plate on air, which is why it is reported rather than called a fit.
//! - **Missing**: the record has no such field at all (the path is absent), reported apart from a field that is there and blank.
//!
//! An element that grows or shrinks to fit does not overflow while it can still fit; the engine does not draw those fits yet (row 11.51),
//! so such a scene is refused by the engine's own drawability check before anything is measured, and nothing here says FITS for it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::scene::{DataContext, SceneDocument};

/// Why a fit report could not be made.
#[derive(Debug)]
pub enum FitFailure {
    /// The request itself is not one: too many records, or a record named twice or not at all.
    Invalid(String),
    /// A scene fault, by name: a font that is not there, a binding that cannot apply.
    Refused(crate::Refusal),
}

impl std::fmt::Display for FitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(detail) => write!(f, "not a fit request: {detail}"),
            Self::Refused(refusal) => write!(f, "the fit check was refused: {refusal}"),
        }
    }
}

impl std::error::Error for FitFailure {}

/// The most records one request may carry. A CSV may hold more (`csv_table`): the Editor asks in pages of at most this many, since every record is shaped.
pub const MOST_FIT_RECORDS: usize = 1_000;

/// One record: the values the scene's data context takes for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitRecord {
    /// What the record is called: its 1-based row number for a CSV (decided for row 11.153), or `sample` for the scene's own data.
    pub id: String,
    /// The data context the bindings resolve against for this record.
    #[ts(type = "{ [key: string]: unknown }")]
    #[schemars(with = "serde_json::Map<String, serde_json::Value>")]
    pub values: DataContext,
}

/// A closed request to check a scene against records. It creates no revision and touches nothing on air.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitRequest {
    pub scene: SceneDocument,
    pub records: Vec<FitRecord>,
}

/// Along which axis a text is larger than its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FitAxis {
    /// The lines need more height than the box has (paragraph text).
    Height,
    /// A line is wider than the box (point text, which does not wrap).
    Width,
}

/// What the check found for one text of one record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(
    tag = "result",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FitResult {
    Fits,
    /// Larger than the box by `by_px` scene units along `axis` (the larger of the two when both), laid out in `lines` lines.
    Overflows { by_px: f64, axis: FitAxis, lines: u32 },
    /// The bound value is null, blank or missing from a field that is there. `hidden`: the element hides when empty, so nothing is drawn.
    Empty { hidden: bool },
    /// The record has no field at `path`. `hidden` as for `Empty`.
    Missing { path: String, hidden: bool },
}

/// One text of one record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
// No `deny_unknown_fields`: serde cannot combine it with the flattened result, and the result enum is itself strict about its tag.
#[serde(rename_all = "camelCase")]
pub struct ElementFit {
    pub object_id: String,
    #[serde(flatten)]
    pub fit: FitResult,
}

/// Everything the check found for one record, in the scene's object order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordFit {
    pub id: String,
    pub elements: Vec<ElementFit>,
}

/// The answer: one entry per record asked about, in the order asked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitReport {
    pub records: Vec<RecordFit>,
}

impl FitResult {
    /// Whether the record needs the designer's attention for this element: it overflows, or it is empty or missing and the element does
    /// not hide (a blank plate on air). A hidden empty element is the intended outcome and needs nothing.
    pub fn needs_fixing(&self) -> bool {
        match self {
            Self::Fits => false,
            Self::Overflows { .. } => true,
            Self::Empty { hidden } | Self::Missing { hidden, .. } => !hidden,
        }
    }
}

impl RecordFit {
    /// Whether any element of this record needs fixing.
    pub fn needs_fixing(&self) -> bool {
        self.elements.iter().any(|element| element.fit.needs_fixing())
    }
}

impl FitReport {
    /// How many records fit, and how many need fixing: the "46 FIT, 2 NEED FIXING" of Figma B4.
    pub fn tally(&self) -> (usize, usize) {
        let to_fix = self.records.iter().filter(|record| record.needs_fixing()).count();
        (self.records.len() - to_fix, to_fix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> FitReport {
        let at = |object_id: &str, fit: FitResult| ElementFit { object_id: object_id.into(), fit };
        FitReport {
            records: vec![
                RecordFit { id: "1".into(), elements: vec![at("name", FitResult::Fits), at("role", FitResult::Fits)] },
                RecordFit { id: "17".into(), elements: vec![at("name", FitResult::Overflows { by_px: 64.0, axis: FitAxis::Width, lines: 1 })] },
                RecordFit { id: "31".into(), elements: vec![at("role", FitResult::Empty { hidden: true }), at("name", FitResult::Fits)] },
                RecordFit { id: "32".into(), elements: vec![at("role", FitResult::Empty { hidden: false })] },
                RecordFit { id: "33".into(), elements: vec![at("role", FitResult::Missing { path: "p.role".into(), hidden: false })] },
                RecordFit { id: "34".into(), elements: vec![] },
                RecordFit { id: "35".into(), elements: vec![at("name", FitResult::Fits)] },
            ],
        }
    }

    /// An empty value is a fault only where it would put a blank plate on air; the tally counts records, not elements.
    #[test]
    fn an_empty_value_needs_fixing_only_where_nothing_hides_it() {
        let report = report();
        let to_fix: Vec<bool> = report.records.iter().map(RecordFit::needs_fixing).collect();
        assert_eq!(to_fix, [false, true, false, true, true, false, false]);
        assert_eq!(report.tally(), (4, 3), "fit first, then needing fixing, and the two differ");
        assert!(!FitResult::Fits.needs_fixing());
        assert!(FitResult::Overflows { by_px: 0.5, axis: FitAxis::Height, lines: 3 }.needs_fixing());
        assert!(!FitResult::Missing { path: "a.b".into(), hidden: true }.needs_fixing());
    }

    /// The answer is on the wire as a flat object with the result in its words, so a person and an agent read the same line.
    #[test]
    fn the_answer_is_on_the_wire_as_one_flat_object_per_element() {
        let wire = serde_json::to_value(report()).unwrap();
        assert_eq!(wire["records"][0]["elements"][0], serde_json::json!({"objectId": "name", "result": "fits"}));
        assert_eq!(
            wire["records"][1]["elements"][0],
            serde_json::json!({"objectId": "name", "result": "overflows", "byPx": 64.0, "axis": "width", "lines": 1})
        );
        assert_eq!(wire["records"][2]["elements"][0], serde_json::json!({"objectId": "role", "result": "empty", "hidden": true}));
        assert_eq!(
            wire["records"][4]["elements"][0],
            serde_json::json!({"objectId": "role", "result": "missing", "path": "p.role", "hidden": false})
        );
        let back: FitReport = serde_json::from_value(wire).unwrap();
        assert_eq!(back, report());
    }

    /// A request is strict: an unknown field is refused, so a typo does not become a silent default.
    #[test]
    fn a_request_refuses_what_it_does_not_name() {
        assert!(serde_json::from_value::<FitRecord>(serde_json::json!({"id": "1", "values": {}, "extra": 1})).is_err());
        assert!(serde_json::from_value::<FitRecord>(serde_json::json!({"id": "1"})).is_err());
        let record: FitRecord = serde_json::from_value(serde_json::json!({"id": "17", "values": {"p": {"name": "Soul"}}})).unwrap();
        assert_eq!(record.values["p"]["name"], "Soul");
    }
}
