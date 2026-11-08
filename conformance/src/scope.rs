//! Control-port scope enforcement (build plan 5.7).
//!
//! The engine's control port is Playout's. A credential of any other role is
//! refused for every request, reads included, and a Program change needs its
//! own scope. The transport decides this before the engine is locked, so a
//! refused request never reaches the engine's handler. That is checked here
//! with a recording peer behind the real transport: every request the engine
//! handler receives is written down.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use gx_contracts::auth::{Role, Scope};
use gx_contracts::{ContentHash, Refusal, Revision, TakeId};
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::intent::{ClearRequest, CueRequest, PhaseRequest, TakeAt, TakeRequest};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, OutputConfig};
use gx_control_plane::peer::{EnginePeer, Handled};
use gx_control_plane::render::RenderRequest;
use gx_control_transport::{Client, Server, Token};
use gx_mock_engine::MockEngine;

use crate::{expect, Outcome, Report};

const PLANE: &str = "control";
/// The names of the requests the engine handler received, in order.
type Trace = Arc<Mutex<Vec<&'static str>>>;

const SECRET: &str = "conformance-scope-secret-0123456789abcdef";

/// A peer that writes down the name of every request its handler receives.
struct RecordingPeer {
    inner: MockEngine,
    reached: Trace,
}

impl EnginePeer for RecordingPeer {
    fn capability(&self) -> EngineCapability {
        self.inner.capability()
    }
    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        self.reached
            .lock()
            .expect("trace mutex")
            .push(request.name());
        self.inner.handle(request)
    }
    fn handle_detached(&mut self, request: ClientRequest) -> Handled {
        Handled::Reply(self.handle(request))
    }
    fn drain_events(&mut self) -> Vec<EngineEvent> {
        self.inner.drain_events()
    }
}

/// One of every control request except `Authenticate`.
fn every_request() -> Vec<ClientRequest> {
    let take_id = TakeId("conformance/published".into());
    let pin = Some(ContentHash("a".repeat(64)));
    vec![
        ClientRequest::Capability,
        ClientRequest::Status,
        ClientRequest::Performance,
        ClientRequest::Render(RenderRequest {
            take_id: take_id.clone(),
            revision: Revision(1),
            content_hash: pin.clone(),
            frame: 0,
        }),
        ClientRequest::Cue(CueRequest {
            take_id: take_id.clone(),
            revision: Revision(1),
            content_hash: pin.clone(),
            at: TakeAt::NextOpportunity,
        }),
        ClientRequest::Take(TakeRequest {
            take_id,
            revision: Revision(1),
            content_hash: pin,
            at: TakeAt::NextOpportunity,
        }),
        ClientRequest::Phase(PhaseRequest {
            phase: "out".into(),
            at: TakeAt::NextOpportunity,
        }),
        ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
        }),
        ClientRequest::ConfigureOutput(OutputConfig {
            adapter: "null".into(),
            live: false,
            accept_free_run: false,
        }),
    ]
}

/// Serve a recording mock behind the real transport with a secret.
fn serve() -> Result<(SocketAddr, Trace), String> {
    let reached = Arc::new(Mutex::new(Vec::new()));
    let mut inner = MockEngine::new();
    inner.publish(
        TakeId("conformance/published".into()),
        Revision(1),
        ContentHash("a".repeat(64)),
    );
    let peer = RecordingPeer {
        inner,
        reached: Arc::clone(&reached),
    };
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let server = Server::bind(addr, Some(SECRET), peer).map_err(|e| e.to_string())?;
    let bound = server.local_addr().map_err(|e| e.to_string())?;
    server.serve_in_background();
    Ok((bound, reached))
}

fn connect(addr: SocketAddr, role: Role, scopes: Vec<Scope>) -> Result<Client, String> {
    let token =
        Token::mint("conformance-scope", role, scopes, SECRET).map_err(|e| e.to_string())?;
    Client::authenticate_only(addr, token).map_err(|e| e.to_string())
}

/// 5.7 against an engine this suite does not own (the real render worker,
/// started with `--token secret`): an author credential is refused by name for
/// every request, and Program is unchanged afterwards, as a full Playout
/// credential then reads it. The engine itself never produces
/// `ScopeNotGranted`, so each refusal was the transport's.
pub fn real_engine_scope_suite(addr: SocketAddr, secret: &str, report: &mut Report) {
    let mint = |role, scopes| Token::mint("conformance-scope", role, scopes, secret);
    let author = mint(Role::Editor, vec![Scope::Author])
        .map_err(|e| e.to_string())
        .and_then(|token| Client::authenticate_only(addr, token).map_err(|e| e.to_string()));
    let mut author = match author {
        Ok(client) => client,
        Err(e) => {
            report.record(
                PLANE,
                "the real engine's transport refuses an author credential for every request",
                Outcome::Fail(format!("could not authenticate the author credential: {e}")),
            );
            return;
        }
    };
    let mut wrong = Vec::new();
    for request in every_request() {
        let name = request.name();
        match author.request(request) {
            Ok(EngineReply::Refused(Refusal::ScopeNotGranted { request, .. }))
                if request == name => {}
            other => wrong.push(format!("{name}: {other:?}")),
        }
    }
    report.record(
        PLANE,
        "the real engine's transport refuses an author credential for every request",
        expect(wrong.is_empty(), format!("5.7: {wrong:?}")),
    );
    let playout = mint(
        Role::Playout,
        vec![
            Scope::Cue,
            Scope::Take,
            Scope::Clear,
            Scope::ConfigureOutput,
        ],
    )
    .map_err(|e| e.to_string())
    .and_then(|token| Client::connect_with_token(addr, token).map_err(|e| e.to_string()));
    let program = playout.map(|mut client| client.request(ClientRequest::Status));
    report.record(
        PLANE,
        "an author credential's take leaves the real engine's Program untouched",
        expect(
            matches!(&program, Ok(Ok(EngineReply::Status(status))) if status.program.is_none()),
            format!("5.7: a Playout status read after the author's requests gave {program:?}"),
        ),
    );
}

/// 5.7: author-scoped and partly scoped credentials are refused by name at
/// the transport and never reach the engine; a full Playout credential does.
pub fn scope_enforcement_suite(report: &mut Report) {
    let (addr, reached) = match serve() {
        Ok(served) => served,
        Err(e) => {
            report.skip_unavailable(format!("cannot serve the recording peer: {e}"));
            return;
        }
    };
    let reached_now = || reached.lock().expect("trace mutex").clone();

    // An Editor credential, holding the one scope its role permits.
    match connect(addr, Role::Editor, vec![Scope::Author]) {
        Ok(mut author) => {
            let mut wrong = Vec::new();
            for request in every_request() {
                let name = request.name();
                let required = request.required_scope();
                match author.request(request) {
                    Ok(EngineReply::Refused(Refusal::ScopeNotGranted {
                        request,
                        required: named,
                        role: Role::Editor,
                    })) if request == name && named == required => {}
                    other => wrong.push(format!("{name}: {other:?}")),
                }
            }
            report.record(
                PLANE,
                "an author credential is refused by name for every control request",
                expect(wrong.is_empty(), format!("5.7: {wrong:?}")),
            );
            let trace = reached_now();
            report.record(
                PLANE,
                "no request from an author credential reaches the engine",
                expect(
                    trace.is_empty(),
                    format!("5.7: the engine handled {trace:?}"),
                ),
            );
        }
        Err(e) => report.record(
            PLANE,
            "an author credential is refused by name for every control request",
            Outcome::Fail(format!("could not authenticate the author credential: {e}")),
        ),
    }

    // A Playout credential that may only cue: reads and cue pass, the
    // Program changes it lacks the scope for are refused naming that scope.
    match connect(addr, Role::Playout, vec![Scope::Cue]) {
        Ok(mut cue_only) => {
            let before = reached_now().len();
            let take = cue_only.request(every_request().remove(5));
            let status = cue_only.request(ClientRequest::Status);
            let after = reached_now();
            report.record(
                PLANE,
                "a Playout credential without the Take scope cannot take",
                expect(
                    matches!(
                        &take,
                        Ok(EngineReply::Refused(Refusal::ScopeNotGranted {
                            required: Some(Scope::Take),
                            role: Role::Playout,
                            ..
                        }))
                    ) && matches!(status, Ok(EngineReply::Status(_)))
                        && after[before..] == ["status"],
                    format!(
                        "5.7: take {take:?}, status {status:?}, engine handled {:?}",
                        &after[before..]
                    ),
                ),
            );
        }
        Err(e) => report.record(
            PLANE,
            "a Playout credential without the Take scope cannot take",
            Outcome::Fail(format!("could not authenticate: {e}")),
        ),
    }

    // The full Playout credential: every request reaches the engine, so the
    // gate refuses exactly what it should and nothing more.
    match connect(
        addr,
        Role::Playout,
        vec![
            Scope::Cue,
            Scope::Take,
            Scope::Clear,
            Scope::ConfigureOutput,
        ],
    ) {
        Ok(mut playout) => {
            let before = reached_now().len();
            let mut refused = Vec::new();
            for request in every_request() {
                let name = request.name();
                if let Ok(EngineReply::Refused(Refusal::ScopeNotGranted { .. })) =
                    playout.request(request)
                {
                    refused.push(name);
                }
            }
            let handled: Vec<_> = reached_now()[before..].to_vec();
            let expected: Vec<_> = every_request().iter().map(ClientRequest::name).collect();
            report.record(
                PLANE,
                "a full Playout credential reaches the engine with every request",
                expect(
                    refused.is_empty() && handled == expected,
                    format!("5.7: refused {refused:?}; engine handled {handled:?}"),
                ),
            );
        }
        Err(e) => report.record(
            PLANE,
            "a full Playout credential reaches the engine with every request",
            Outcome::Fail(format!("could not authenticate: {e}")),
        ),
    }
}
