//! 12.11: every Program command that reaches the engine, accepted or refused, is one as-run
//! record, written and synced before the reply, hash-chained, naming the signed-in operator and the
//! credential's subject, and carrying the frame the engine committed.
//!
//! A real server, client and mock engine over TCP: what is read back is what an operator was shown.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use gx_contracts::auth::{OperatorName, Role, Scope};
use gx_contracts::{ContentHash, RationalRate, Refusal, Revision, TakeId};
use gx_control_plane::intent::{ClearRequest, CueRequest, PhaseRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineReply};
use gx_control_plane::peer::EnginePeer;
use gx_control_transport::{verify_as_run, AsRunLog, Client, Server, Token};
use gx_mock_engine::MockEngine;

const SECRET: &str = "as-run-test-secret-0123456789abcdef";

static NEXT: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "gx-as-run-it-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn serve(root: &std::path::Path) -> SocketAddr {
    let mut engine = MockEngine::new().genlocked(RationalRate::P29_97);
    engine.publish(TakeId("t".into()), Revision(1), ContentHash("a".repeat(64)));
    let server = Server::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        Some(SECRET),
        engine,
    )
    .unwrap()
    .with_as_run(AsRunLog::open(root, "program").unwrap());
    let addr = server.local_addr().unwrap();
    server.serve_in_background();
    addr
}

fn signed_in(addr: SocketAddr, operator: &str) -> Client {
    let token = Token::mint(
        "playout-1",
        Role::Playout,
        vec![Scope::Cue, Scope::Take, Scope::Clear],
        SECRET,
    )
    .unwrap();
    let mut client = Client::authenticate_only(addr, token).unwrap();
    client.set_operator(Some(&OperatorName::parse(operator).unwrap()));
    client
}

fn take(revision: u64) -> ClientRequest {
    ClientRequest::Take(TakeRequest {
        take_id: TakeId("t".into()),
        revision: Revision(revision),
        content_hash: Some(ContentHash("a".repeat(64))),
        at: TakeAt::NextOpportunity,
    })
}

fn file(root: &std::path::Path) -> PathBuf {
    std::fs::read_dir(root.join("as-run"))
        .unwrap()
        .next()
        .expect("one as-run file")
        .unwrap()
        .path()
}

fn records(root: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(file(root))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn every_program_command_is_a_record_with_who_what_and_the_committed_frame() {
    let root = root();
    let mut client = signed_in(serve(&root), "Ada Lovelace");

    let cued = client.handle(ClientRequest::Cue(CueRequest {
        take_id: TakeId("t".into()),
        revision: Revision(1),
        content_hash: Some(ContentHash("a".repeat(64))),
        at: TakeAt::NextOpportunity,
    }));
    let EngineReply::Cued(cue_frame) = cued else {
        panic!("cue: {cued:?}")
    };
    let taken = client.handle(take(1));
    let EngineReply::Taken(take_frame) = taken else {
        panic!("take: {taken:?}")
    };
    // A refusal is on the record too, with its name and no committed frame.
    let refused = client.handle(take(7));
    let EngineReply::Refused(refusal) = refused else {
        panic!("a take of an unpublished revision is refused: {refused:?}")
    };
    let cleared = client.handle(ClientRequest::Clear(ClearRequest {
        at: TakeAt::NextOpportunity,
    }));
    let EngineReply::Cleared(clear_frame) = cleared else {
        panic!("clear: {cleared:?}")
    };
    // A read is not a Program command: no record.
    let _ = client.handle(ClientRequest::Status);

    let all = records(&root);
    assert_eq!(all.len(), 4, "cue, take, refused take, clear");
    let kinds: Vec<_> = all.iter().map(|r| r["request"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["cue", "take", "take", "clear"]);
    for (index, record) in all.iter().enumerate() {
        assert_eq!(record["seq"], index as u64 + 1, "monotonic");
        assert_eq!(record["operator"], "Ada Lovelace");
        assert_eq!(record["subject"], "playout-1");
        assert_eq!(record["role"], "Playout");
        assert_eq!(record["channel"], "program");
        assert_eq!(record["layer"], "main", "no target is the main layer");
    }
    assert_eq!(all[0]["committedFrame"], cue_frame.frame);
    assert_eq!(all[1]["committedFrame"], take_frame.frame);
    assert_eq!(all[3]["committedFrame"], clear_frame.frame);
    assert_eq!(all[0]["page"], "t");
    assert_eq!(all[0]["revision"], 1);
    assert_eq!(all[0]["contentHash"], "a".repeat(64));
    assert_eq!(all[1]["page"], "t");
    assert_eq!(all[1]["revision"], 1);
    assert_eq!(all[1]["result"], "accepted");
    assert_eq!(all[2]["result"], "refused");
    assert_eq!(all[2]["refusal"], refusal.code_name());
    assert!(all[2]["committedFrame"].is_null());
    assert_eq!(all[2]["revision"], 7);
    assert_eq!(verify_as_run(&file(&root)), Ok(4));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_phase_names_its_phase_and_the_record_never_holds_a_credential() {
    let root = root();
    let mut client = signed_in(serve(&root), "Ada Lovelace");
    let _ = client.handle(take(1));
    let reply = client.handle(ClientRequest::Phase(PhaseRequest {
        phase: "hold".into(),
        at: TakeAt::NextOpportunity,
    }));
    let all = records(&root);
    let phase = all
        .iter()
        .find(|r| r["request"] == "phase")
        .expect("a phase record");
    assert_eq!(phase["phase"], "hold");
    // Whatever the engine answered is what is recorded: the frame it committed, or its refusal.
    match reply {
        EngineReply::PhaseCommitted(committed) => {
            assert_eq!(phase["committedFrame"], committed.committed.frame);
            assert_eq!(phase["result"], "accepted");
        }
        EngineReply::Refused(refusal) => {
            assert_eq!(phase["result"], "refused");
            assert_eq!(phase["refusal"], refusal.code_name());
        }
        other => panic!("phase: {other:?}"),
    }
    let text = std::fs::read_to_string(file(&root)).unwrap();
    assert!(!text.contains(SECRET), "the secret is never written");
    assert!(!text.contains("gx1."), "no credential is written");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_command_with_no_operator_never_reaches_the_engine_and_is_not_a_record() {
    let root = root();
    let addr = serve(&root);
    let token = Token::mint("playout-1", Role::Playout, vec![Scope::Take], SECRET).unwrap();
    let mut client = Client::authenticate_only(addr, token).unwrap();
    assert!(matches!(
        client.handle(take(1)),
        EngineReply::Refused(Refusal::OperatorRequired { .. })
    ));
    assert!(
        records(&root).is_empty(),
        "what the engine never saw is not as-run"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_edited_record_is_found_at_its_line() {
    let root = root();
    let mut client = signed_in(serve(&root), "Ada Lovelace");
    let _ = client.handle(take(1));
    let _ = client.handle(ClientRequest::Clear(ClearRequest {
        at: TakeAt::NextOpportunity,
    }));
    let _ = client.handle(take(1));
    let path = file(&root);
    assert_eq!(verify_as_run(&path), Ok(3));
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, text.replacen("Ada Lovelace", "Someone Else", 1)).unwrap();
    assert_eq!(verify_as_run(&path).unwrap_err().line, 2);
    let _ = std::fs::remove_dir_all(root);
}
