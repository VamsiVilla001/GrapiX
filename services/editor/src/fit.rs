//! The record check (build plan 11.153): ask the engine whether each record's text fits the layout it is bound to.
//!
//! The request is the asset plane's `fit`: the draft document and a list of records, answered with a report per record and per bound text
//! (Fits, Overflows, Empty, Missing). The engine does the measuring, with the shaping it draws with, so the Editor never computes a
//! "fits" of its own (`gx_contracts::fit_report`). It creates no revision and touches nothing on air, and the Editor holds no
//! control-plane client to ask it with (boundary rules R6, invariant 4).
//!
//! Failures stay apart as they do for a preview. An engine that cannot be reached decided nothing; an engine that answers and declines
//! does so by name; a request the engine calls malformed is its own case.

use std::net::SocketAddr;

use gx_asset_plane::{fit_scene, FitError, PublishClientError};
use gx_contracts::fit_report::{FitRecord, FitReport, FitRequest};
use gx_contracts::scene::SceneDocument;
use gx_contracts::Refusal;

/// Why a fit report was not made.
#[derive(Debug)]
pub enum FitCheckFailure {
    /// The endpoint text is not a socket address. Nothing was opened.
    InvalidEndpoint { endpoint: String },
    /// The engine could not be reached, or the connection failed before a reply: nothing was decided.
    Unreachable { endpoint: String, detail: String },
    /// The engine understood the request and declined it, by name.
    EngineRefused(Refusal),
    /// The engine says the request was not a fit request (too many records, a record named twice or not at all).
    Invalid { detail: String },
    /// A reply arrived that is not a reply.
    Protocol { detail: String },
}

impl std::fmt::Display for FitCheckFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEndpoint { endpoint } => write!(f, "{endpoint} is not a host:port address"),
            Self::Unreachable { endpoint, detail } => write!(f, "cannot reach the engine at {endpoint}: {detail}"),
            Self::EngineRefused(refusal) => write!(f, "the engine declined the record check: {refusal}"),
            Self::Invalid { detail } => write!(f, "the record check request is not valid: {detail}"),
            Self::Protocol { detail } => write!(f, "asset plane protocol failed: {detail}"),
        }
    }
}

impl std::error::Error for FitCheckFailure {}

/// The records a check of `scene` asks about today: its own sample data, as the one record `sample`. A CSV kept in the project adds the
/// rest (slice C of row 11.153).
pub fn records_of(scene: &SceneDocument) -> Vec<FitRecord> {
    vec![FitRecord { id: "sample".into(), values: scene.data_context.clone() }]
}

/// CSV records keep source order and preserve every cell as text, including blanks.
pub fn csv_records(table: gx_contracts::csv_table::TextTable) -> Vec<FitRecord> {
    table.rows.into_iter().enumerate().map(|(index, row)| FitRecord {
        id: (index + 1).to_string(),
        values: table.columns.iter().cloned().zip(row.into_iter().map(serde_json::Value::String)).collect(),
    }).collect()
}

/// Check `scene` against `records` on the engine's asset plane at `endpoint`.
///
/// The one function the Editor shell's `cmd_fit_report` and the tests both call, so what is tested is what the shell does.
pub fn fit_document(endpoint: &str, scene: SceneDocument, records: Vec<FitRecord>) -> Result<FitReport, FitCheckFailure> {
    let address: SocketAddr = endpoint
        .parse()
        .map_err(|_| FitCheckFailure::InvalidEndpoint { endpoint: endpoint.to_owned() })?;
    // 2.24: an engine started with a token verifies a credential on the asset plane. A process that holds one for it
    // (`GX_ASSET_CREDENTIAL`, made with the engine's secret, Author scope) sends it.
    let _credential = gx_asset_plane::auth::enter_from_environment();
    fit_scene(address, FitRequest { scene, records }).map_err(|error| match error {
        FitError::Refused(refusal) => FitCheckFailure::EngineRefused(refusal),
        FitError::Invalid(detail) => FitCheckFailure::Invalid { detail },
        FitError::Client(PublishClientError::Connect(source) | PublishClientError::Transport(source)) => {
            FitCheckFailure::Unreachable { endpoint: endpoint.to_owned(), detail: source.to_string() }
        }
        FitError::Client(other) => FitCheckFailure::Protocol { detail: other.to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nothing_listens() -> String {
        // A port that was just free and is not listening now.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        address.to_string()
    }

    fn scene(data: serde_json::Value) -> SceneDocument {
        serde_json::from_value(serde_json::json!({
            "version": gx_contracts::scene::SCENE_SCHEMA_VERSION,
            "id": "draft", "name": "Draft", "workingColorSpace": "linear-srgb", "colorDepth": "32",
            "canvas": { "width": 64, "height": 32, "frameRate": { "num": 50, "den": 1 } },
            "timeline": { "durationFrames": 10, "channels": [] },
            "dataContext": data,
            "objects": []
        }))
        .expect("a minimal scene parses")
    }

    #[test]
    fn the_scenes_own_data_is_the_one_record_today() {
        let records = records_of(&scene(serde_json::json!({ "p": { "name": "Soul" } })));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "sample");
        assert_eq!(records[0].values["p"]["name"], "Soul");
        assert!(records_of(&scene(serde_json::json!({}))).iter().all(|record| record.values.is_empty()), "no data is still a record, so a bound text says Missing");
    }

    #[test]
    fn a_bad_endpoint_is_named_and_nothing_is_opened() {
        match fit_document("not an address", scene(serde_json::json!({})), Vec::new()) {
            Err(FitCheckFailure::InvalidEndpoint { endpoint }) => assert_eq!(endpoint, "not an address"),
            other => panic!("expected an invalid endpoint, got {other:?}"),
        }
    }

    #[test]
    fn an_engine_that_is_not_there_decided_nothing() {
        let endpoint = nothing_listens();
        match fit_document(&endpoint, scene(serde_json::json!({})), Vec::new()) {
            Err(FitCheckFailure::Unreachable { endpoint: named, .. }) => assert_eq!(named, endpoint),
            other => panic!("expected an unreachable engine, got {other:?}"),
        }
    }
}
