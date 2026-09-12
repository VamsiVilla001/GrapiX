//! The `designsystem.*` tools driven over the real JSON-RPC transport.
//!
//! Unit tests call handlers directly, which proves a body is right and not
//! that it is *reachable*. A tool the registry declares with no handler behind
//! it answers nothing in production while every unit test still passes — and
//! that is the failure this file exists to catch, because an agent trusts the
//! capability surface before it asks for anything (ADR-0002 D.1).
//!
//! The other rule under test is G.2's: **nothing auto-commits**. Import
//! proposes; only an explicit commit carrying a human's name creates a
//! version, and the store must refuse to invent one.

use gx_contracts::auth::Scope;
use gx_editor::Projects;
use gx_editor_mcp::{
    DesignSystemCommitTool, DesignSystemGet, DesignSystemImportTool, DesignSystemListVersions,
};
use gx_mcp_server::Server;

fn drive(server: &Server, requests: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let input: String = requests
        .iter()
        .map(|request| format!("{request}\n"))
        .collect();
    let mut output = Vec::new();
    server
        .serve(std::io::BufReader::new(input.as_bytes()), &mut output)
        .expect("the transport writes its replies");
    String::from_utf8(output)
        .expect("replies are UTF-8")
        .lines()
        .map(|line| serde_json::from_str(line).expect("each reply is one JSON object"))
        .collect()
}

fn call(id: u64, tool: &str, arguments: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    })
}

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("gx-ds-surface-{label}-{nanos}"));
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

/// A source document with one value the token contract cannot express.
///
/// Returned as text because that is what travels on the wire: the bytes the
/// reviewer supplied are the bytes hashed into provenance.
fn source() -> String {
    serde_json::json!({
        "brand": { "$type": "color", "primary": { "$value": "#1e88e5" } },
        "space": { "$type": "dimension", "base": { "$value": "16px" } },
        "type": { "$type": "fontSize", "caption": { "$value": "18px" } },
        "effect": {
            "$type": "shadow",
            "card": { "$value": { "offsetX": "0px", "blur": "4px" } }
        }
    })
    .to_string()
}

fn server_with(projects: &Projects, scopes: Vec<Scope>) -> Server {
    let mut server = Server::new(scopes);
    server.register(
        "designsystem.import",
        Box::new(DesignSystemImportTool(projects.clone())),
    );
    server.register(
        "designsystem.commit",
        Box::new(DesignSystemCommitTool(projects.clone())),
    );
    server.register(
        "designsystem.get",
        Box::new(DesignSystemGet(projects.clone())),
    );
    server.register(
        "designsystem.list_versions",
        Box::new(DesignSystemListVersions(projects.clone())),
    );
    server
}

#[test]
fn a_brand_pack_is_imported_reviewed_and_confirmed_over_the_wire() {
    // The whole of Phase 10 as a reviewer would perform it: propose, read what
    // could not be captured, confirm by name, then read the version back.
    let root = scratch("commit");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    // Admin scope: confirming a brand pack is not an author's act (Part G).
    let server = server_with(&projects, vec![Scope::Author, Scope::ConfigureOutput]);

    let import = drive(
        &server,
        &[call(
            1,
            "designsystem.import",
            serde_json::json!({
                "project": "news",
                "name": "Brand",
                "kind": "w3c",
                "document": source(),
            }),
        )],
    );
    assert!(
        import[0]["error"].is_null(),
        "unexpected refusal: {}",
        import[0]
    );
    let draft = import[0]["result"].clone();

    // 10.3 reaches a caller: the shadow the contract cannot hold is named,
    // with the value it held, rather than being quietly absent.
    let unexpressible = draft["unexpressible"]
        .as_array()
        .expect("the draft carries an unexpressible list");
    assert_eq!(unexpressible.len(), 1);
    assert_eq!(unexpressible[0]["sourcePath"], "effect.card");
    assert_eq!(unexpressible[0]["sourceType"], "shadow");
    assert!(
        !unexpressible[0]["value"].is_null(),
        "the report must carry the value, not just its path"
    );

    // Importing must not have created a version. G.2: never auto-accept.
    let before = drive(
        &server,
        &[call(
            2,
            "designsystem.list_versions",
            serde_json::json!({ "project": "news" }),
        )],
    );
    assert_eq!(
        before[0]["result"]["versions"]
            .as_array()
            .expect("a version list")
            .len(),
        0,
        "import proposed a draft and must not have committed it"
    );

    let committed = drive(
        &server,
        &[call(
            3,
            "designsystem.commit",
            serde_json::json!({
                "project": "news",
                "draft": draft,
                "confirmedBy": "head-of-design",
            }),
        )],
    );
    assert!(
        committed[0]["error"].is_null(),
        "unexpected refusal: {}",
        committed[0]
    );
    // The declared output is `DesignSystem`, and this is what proves the
    // declaration is honest rather than aspirational.
    assert_eq!(committed[0]["result"]["version"], 1);
    assert_eq!(committed[0]["result"]["name"], "Brand");
    assert_eq!(committed[0]["result"]["visual"]["minTextSize"], 18.0);

    let after = drive(
        &server,
        &[
            call(4, "designsystem.get", serde_json::json!({ "project": "news" })),
            call(
                5,
                "designsystem.list_versions",
                serde_json::json!({ "project": "news" }),
            ),
        ],
    );
    assert_eq!(after[0]["result"]["version"], 1);
    let versions = after[1]["result"]["versions"]
        .as_array()
        .expect("a version list");
    assert_eq!(versions.len(), 1);
    // Provenance reaches the wire: who confirmed it, and from which source.
    assert_eq!(versions[0]["provenance"]["confirmedBy"], "head-of-design");
    assert_eq!(versions[0]["provenance"]["sourceKind"], "w3c");

    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn an_author_token_cannot_commit_a_brand_pack() {
    // 8.7's done-when at the wire: an author works inside the system and
    // cannot change it. The gate runs before the handler, so this proves the
    // refusal comes from the scope model rather than from the store.
    let root = scratch("scope");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    let server = server_with(&projects, vec![Scope::Author]);

    let replies = drive(
        &server,
        &[call(
            1,
            "designsystem.commit",
            serde_json::json!({
                "project": "news",
                "draft": serde_json::Value::Null,
                "confirmedBy": "someone",
            }),
        )],
    );

    assert!(
        !replies[0]["error"].is_null(),
        "an author must not reach commit"
    );
    assert_eq!(
        replies[0]["error"]["data"]["code"]["refusal"], "unauthenticated",
        "the refusal names the failing condition, got {}",
        replies[0]["error"]
    );

    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn a_commit_with_no_confirming_human_is_refused_at_the_wire() {
    // The store refuses to invent a confirmation; this proves the refusal
    // survives the transport rather than being smoothed into a success.
    let root = scratch("anonymous");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    let server = server_with(&projects, vec![Scope::Author, Scope::ConfigureOutput]);

    let import = drive(
        &server,
        &[call(
            1,
            "designsystem.import",
            serde_json::json!({
                "project": "news",
                "name": "Brand",
                "kind": "w3c",
                "document": source(),
            }),
        )],
    );
    let draft = import[0]["result"].clone();

    let replies = drive(
        &server,
        &[call(
            2,
            "designsystem.commit",
            serde_json::json!({
                "project": "news",
                "draft": draft,
                "confirmedBy": "   ",
            }),
        )],
    );

    assert!(
        !replies[0]["error"].is_null(),
        "an unattributed confirmation must be refused"
    );

    let versions = drive(
        &server,
        &[call(
            3,
            "designsystem.list_versions",
            serde_json::json!({ "project": "news" }),
        )],
    );
    assert_eq!(
        versions[0]["result"]["versions"]
            .as_array()
            .expect("a version list")
            .len(),
        0,
        "the refused commit must not have created a version"
    );

    std::fs::remove_dir_all(root).expect("clean up");
}

#[test]
fn every_declared_designsystem_tool_has_a_reachable_handler() {
    // The check that makes the whole class of defect unrepeatable. The
    // registry declares these names; discovery advertises them; an agent will
    // call them. A declared name with no handler is a lie told to every agent
    // that reads `tools/list`, and it passes every other test in this file.
    let root = scratch("reachable");
    let projects = Projects::at_root(&root);
    projects.create_project("news").expect("a project exists");

    let server = server_with(&projects, vec![Scope::Author, Scope::ConfigureOutput]);

    let declared: Vec<&str> = gx_contracts::mcp::ToolRegistry::all()
        .iter()
        .filter(|tool| tool.group == "designsystem")
        .map(|tool| tool.name)
        .collect();
    assert!(
        declared.len() >= 4,
        "expected the designsystem group to be declared, got {declared:?}"
    );

    for (index, name) in declared.iter().enumerate() {
        let replies = drive(
            &server,
            &[call(
                index as u64 + 1,
                name,
                serde_json::json!({ "project": "news" }),
            )],
        );
        let error = &replies[0]["error"];
        // A missing handler is reported as an unimplemented tool. Any other
        // outcome — including a refusal about the arguments — means the call
        // reached a body, which is all this test asserts.
        let detail = error["data"]["refusal"]["given"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
            + error["message"].as_str().unwrap_or_default();
        assert!(
            !detail.contains("no MCP tool named"),
            "{name} is declared but no handler is registered: {}",
            replies[0]
        );
    }

    std::fs::remove_dir_all(root).expect("clean up");
}
