# 2.20 — the wire version enforced on connect (17 Nov 2026)

The OSI layering audit (`docs/audit/osi-layering-2026-11-17.md`, finding 1) found that the wire protocol
version was a number each side wrote down and nobody compared. The user asked for the serious findings
to be fixed, and this is the first of them.

## What was wrong

- `Client::connect` stored the engine's capability reply without reading its `protocol` field.
- The engine answered a capability request with `check_protocol(PROTOCOL_VERSION)`: the constant compared
  with itself, which cannot fail. `ProtocolMismatch` could not be produced on the real path.
- So every protocol bump (4 to 7) changed the number and enforced nothing, and the evidence of row 2.19
  said otherwise ("version 7 refuses a version-6 peer"). That claim was wrong and is corrected in
  `docs/evidence/2.19/README.md` (limit 7).

## Done-when

> A client and an engine on different protocol versions refuse each other on connect, by name and naming
> both versions, from either side, over the real wire; a client that does not state its version is still
> served and checks the reply itself; the host does not start a second worker beside an engine that
> answered and refused it.

## What was built

- **`ClientRequest::Capability { protocol: Option<u32> }`.** The client says which protocol it speaks.
  `ClientRequest::capability()` is the request a client of this build sends (`{"request":"capability",
  "protocol":8}`); `{"request":"capability"}` still reads, as `protocol: None`. **`PROTOCOL_VERSION` is 8.**
- **The engine and the mock** compare the stated protocol with their own (`protocol.map_or(Ok(()),
  check_protocol)`): a different one is `Refused(ProtocolMismatch { expected, actual })`; one that is not
  stated is served.
- **The client** compares the protocol in the engine's capability reply with its own and refuses on
  connect, `InvalidData`, with a message naming both versions. This is the check that protects a client
  of this build from an engine that never learned to refuse.
- **The host** (`gx-engine-host`) no longer takes any failed connect for "nothing is listening".
  `nothing_is_listening(&io::Error)` is true for the operating system's own refusal (`ConnectionRefused`
  carrying an OS error code) or a timeout; an engine that answered and then refused the host (a token the
  host does not hold, another protocol) is `SupervisorError::EngineUnusable`, named, and **no second
  worker is started beside it** (it would fail to bind, and the host would report that instead of the
  refusal).
- Generated TypeScript regenerated (`ClientRequest.ts`, the capability surface at protocol 8).

No download. No change to the asset plane or the MCP servers (no version negotiation there: rows 2.24
and 2.23).

## What was run

- **Transport, over a real socket** (`Shared/control-transport/tests/protocol_version.rs`, 3): an engine
  reporting a protocol one above, one below and zero is refused by `Client::connect` with `InvalidData`
  naming both numbers; an engine on this protocol connects and its capability is kept; a client that states
  another protocol is refused by name by the engine and one that states none is served.
- **Host** (`services/render-engine/host/tests/adopt.rs`, 4): the classification (a real refused connect and
  a timeout say nothing is listening; `PermissionDenied`, `InvalidData` and a `ConnectionRefused` without an OS
  code do not); an engine with a token the host does not hold is `EngineUnusable` with `PermissionDenied`
  and no spawn is attempted (the program it would start does not exist, so a spawn would be a different
  error); an engine on another protocol is `EngineUnusable` with `InvalidData` naming the version; and
  nothing listening still tries to start a worker.
- **Unit tests:** the request's wire form and that the unstated form still reads (`message.rs`); the real
  engine's three cases (`engine.rs`); the mock's (`mock-engine`).
- **An engine built before this row** reads the new request as it always did. Written against a copy of the old
  request shape (a `capability` with nothing after it), the test parses what this build sends and gets
  `Capability`: serde ignores the extra field. So a new client against an old engine is not dropped; it
  receives the old engine's capability (protocol 7), compares it with its own 8, and refuses by name. This was a
  question of the review (below), answered by running it and not by assuming it.
- **Conformance** (two new checks in the control-plane suite, which runs against the mock peers and the
  real render worker process): a client that states another protocol is refused by name with both versions;
  one that states this protocol or none is served.
- Gate (`cargo fmt --check`, `cargo clippy -D warnings`, `npm run check`): see the plan row.

## Mutations

10, one at a time, each restored byte-identical, each made a named check fail (`mutations.txt`).
**The first run stopped after H6**: not a test, but the runner's cleanup command (a PowerShell process listing
used to kill stray test engines) took over a minute and raised `TimeoutExpired`. The runner restores each file
in a `finally`, and `message.rs` was compared with its pre-mutation backup and was identical; the runner now
tolerates a slow listing, and H7 to H10 ran in a second run. No mutation was skipped or counted without a result.

| # | Mutation | Fails |
|---|---|---|
| H1 | the client does not compare the protocol the engine reports | `a_client_refuses_an_engine_that_reports_another_protocol_and_says_both` |
| H2 | the client refuses only an engine on an older protocol | the same test |
| H3 | the engine ignores the protocol a client states | `the_engine_refuses_a_client_that_states_another_protocol_by_name` |
| H3c | the same, seen by the conformance run against the real worker | "a client that states another protocol is refused by name, with both versions" |
| H4 | the mock ignores the protocol a client states | `the_mock_refuses_a_client_that_states_another_protocol_by_name` |
| H5 | the engine refuses a client that does not state a protocol | the engine test |
| H6 | the mismatch names the two versions the wrong way round | the engine test |
| H7 | a client of this build does not state its protocol | the control-plane message test |
| H8 | the host takes any failed connect for nothing listening | the host tests |
| H9 | the host takes a refusal by name for the system's own refusal | `only_the_systems_own_refusal_or_silence_says_nothing_is_listening` |
| H10 | the protocol is not raised | the MCP server's schema-versioning test |

## Jev and Laya

Slice review (`jev-laya.json`): both directions over the wire and against the real worker 0.89; the done-when met on
the named readings 0.91; the correction of 2.19 made openly 0.97; silent substitution 0.40. Two answers led to work:
"can this break an existing peer in a way the evidence does not name" 0.51 (answered by the old-engine test above, which
shows it cannot) and "do the mutations show the checks can fail and is the runner crash reported" 0.22 (it was not
reported: the paragraph and `mutations.txt` above are the fix). Not above 0.5 and reported as they are: the host's
rule can be fooled by a case the evidence does not name 0.49 (its limit is limit 4), and Jev's weakest point is limit 1,
that a client built before this row compares nothing (0.82). "A defect to fix" was 0.60 on the first review; I read the
changed code again for one and found none beyond the two items above. Laya answered 0.91 to 0.97 on every yes/no
question, as all day: no signal from it on yes/no.

## Limits and readings

1. **A client that does not state its protocol is served.** It relies on its own check of the reply. A client
   built before this row sends no protocol and does not compare the reply: it is protected by nothing but the
   fact that Editor, engine and shells are built from one tree.
2. **Only the control plane is covered.** The asset plane (a publish, a fetch, a transfer) and the two MCP
   servers carry no protocol version of their own: rows 2.24 and 2.23 (audit findings 3 and 2).
3. **The mock refuses by the same rule**, not independently: a mock cannot catch the real engine's mistake,
   which is why the conformance checks run against the real worker process too.
4. **`ConnectionRefused` with an OS error code** is the host's only evidence that nothing listens. A firewall
   that drops packets reports a timeout and is treated the same way.
