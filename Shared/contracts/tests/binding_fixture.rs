//! The binding resolver has two implementations by design: `gx_contracts::bindings`
//! applies bindings for the engine and the MCP servers, and `Editor/src/bindings.ts`
//! applies them in the Editor's preview, where a round trip to Rust per keystroke is
//! not acceptable. Row 0.9 forbids a TS copy that can drift from its Rust original,
//! so both read `fixtures/binding-resolution.json` and must give the same answers:
//! the same issues, in the same order and wording, and the same resolved values.
//! The TS half is `Editor/tests/binding-fixture.test.ts`.

use std::collections::BTreeMap;

use gx_contracts::bindings::{binding_issues, resolve_scene_bindings, BindingIssue};
use gx_contracts::scene::SceneDocument;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/binding-resolution.json");

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    scene: SceneDocument,
    issues: Vec<BindingIssue>,
    #[serde(default)]
    resolved: BTreeMap<String, BTreeMap<String, Value>>,
}

/// JSON `640` and the `640.0` a resolved f64 serialises to are the same answer.
fn same_value(actual: &Value, expected: &Value) -> bool {
    match (actual.as_f64(), expected.as_f64()) {
        (Some(actual), Some(expected)) => actual == expected,
        _ => actual == expected,
    }
}

#[test]
fn rust_resolution_matches_the_shared_fixture() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("the fixture parses");
    assert!(fixture.cases.len() >= 6, "the fixture lost cases");

    for case in &fixture.cases {
        let issues = binding_issues(&case.scene);
        assert_eq!(issues, case.issues, "issues for case {:?}", case.name);

        let resolution = resolve_scene_bindings(&case.scene);
        if case.issues.is_empty() {
            let resolved = resolution
                .unwrap_or_else(|refusal| panic!("case {:?} must resolve: {refusal:?}", case.name));
            assert!(
                !case.resolved.is_empty(),
                "case {:?} names no resolved values",
                case.name
            );
            for (object_id, properties) in &case.resolved {
                let object = resolved
                    .objects
                    .iter()
                    .find(|object| object.base().id == *object_id)
                    .unwrap_or_else(|| panic!("case {:?} has no object {object_id}", case.name));
                let wire = serde_json::to_value(object).expect("a scene object serialises");
                for (property, expected) in properties {
                    let actual = &wire[property];
                    assert!(
                        same_value(actual, expected),
                        "case {:?}: {object_id}.{property} resolved to {actual}, expected {expected}",
                        case.name
                    );
                }
            }
        } else {
            assert!(
                resolution.is_err(),
                "case {:?} must refuse resolution",
                case.name
            );
            assert!(
                case.resolved.is_empty(),
                "case {:?} refuses yet names resolved values",
                case.name
            );
        }
    }
}
