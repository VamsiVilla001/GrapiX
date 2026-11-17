# 2.19 — a stop request on the control plane (17 Nov 2026)

Row 2.16 left two named gaps: a console window close (closed by 2.18) and no way
to ask the engine to stop in order from another machine. The engine host
deliberately never stops an engine, so the only remote stop was a kill, which
leaves no stop record. The user asked for the gap to be closed (17 Nov 2026).

## Done-when

> A client holding the authority to do so asks the engine to stop: the engine
> replies, writes `engine.stop` naming the request, its correlation id and the
> credential, finishes its log and exits 0; a client without that authority is
> refused by name; what happens while a scene is on Program is decided and tested.
> A new request is a new wire protocol version.

## What was built

- **Contracts.** `Scope::Stop` (a Playout credential may carry it; an Editor or
  engine credential never can). `ClientRequest::Stop` (wire name `stop`, needs
  `Scope::Stop` and no other). `EngineReply::Stopping`.
  `Refusal::StopRefusedProgramOnAir { take_id, revision }` (`stopRefusedProgramOnAir`).
  **`PROTOCOL_VERSION` 6 to 7.** Generated TypeScript regenerated.
- **The rule (decided with Jev and Laya, below).** The engine refuses a stop by
  name while a scene is on Program, naming the scene: clear Program first, or stop
  the engine at its console. With nothing on Program it replies `Stopping`.
- **Who is told.** The engine does not end its own process. `Engine::set_stop_signal`
  names an owner (the render worker binary), which gets one `StopRequest` carrying
  the correlation id the request arrived under. An engine with no owner refuses the
  request by name (`NotImplemented`) instead of claiming to stop; an owner that is
  gone gives `TransportFailed`.
- **The stop (worker).** A listener thread waits for the request, waits 250 ms for
  the reply to leave (`STOP_REPLY_GRACE`), writes `engine.stop` (info, reason "a
  stop request on the control plane") under the request's correlation id, finishes
  the log (`log.stop`) and exits 0. Several requests, or a request during Ctrl+C,
  write one `engine.stop`: the log is taken first (2.18).
- **Who asked (transport).** Before the engine sees a stop that passed the scope
  check, the transport writes `control.stop_requested` (warn) with the credential's
  subject and role, under the same correlation id. Never the credential.
  `engine.stop` carries the same id, so the two records are followed together; the
  credential is named by the transport's record, not duplicated into the engine's.
- **Mock engine** answers the same way (refused on air, `Stopping` off air), so a
  client is tested against the rule and not a mock that always agrees.
- **Conformance.** `every_request` now includes `Stop`; the full-credential check
  holds the new scope; new checks: a credential holding every Program scope but
  `stop` is refused by name and the engine never sees it; a stop is refused by name
  while a scene is on Program and accepted once it is cleared. The refusal audit
  drives the new refusal.

No download.

## What was run

- Unit tests: contracts (the scope's role rule, the list of all scopes holding every
  scope), control plane (the request needs the stop scope and no other; wire names),
  mock engine, worker engine (4: accepted off air and passed on once with its id;
  refused on air by name and the owner not told; refused with nobody to stop it;
  refused with the owner gone), worker binary (the stop waits its grace, is written
  under the request's id, and ends in `log.stop`; a closed channel writes nothing).
- **A real engine process, a real control connection** (`tests/stop_request.rs`):
  a credential without the stop scope is refused by name and the engine keeps
  running and answering; a credential with it, in a correlation scope, gets
  `Stopping`; the engine then exits 0 with `engine.stop` (info, the reason, the id),
  `log.stop` last, exactly one `engine.stop`; the transport's `control.stop_requested`
  names the subject and role under the same id; the refused attempt is on record;
  neither the secret nor any `gx1.` credential is in the log.
- Gate (`cargo fmt --check`, `cargo clippy -D warnings`, `npm run check`) exit 0:
  424 Editor tests, 973 Rust tests passed, 0 failed, 38 ignored, 60 Node tests,
  conformance 613 passed, 0 failed, 9 skipped.

## Mutations

18, one at a time, each restored byte-identical, each made a named check fail
(`mutations.txt`, the runner's own output: the first run of 17 (E1 to E16) and the
rerun of E7 to E10 and E17 after the stop's wait was made a testable function).

| # | Mutation | Fails |
|---|---|---|
| E1 | a stop request needs no scope | `a_stop_request_needs_the_stop_scope_and_no_other` |
| E1c | the same, seen by conformance | "a Playout credential without the stop scope cannot stop the engine" |
| E2 | a Playout credential cannot carry the stop scope | `only_a_playout_credential_may_carry_the_stop_scope` |
| E3 | an engine credential may carry it | the same test |
| E4 | a stop is accepted while a scene is on Program | `a_stop_request_while_a_scene_is_on_program_is_refused_by_name` |
| E5 | an accepted stop is not passed to the owner | three engine stop tests |
| E6 | the stop drops its correlation id | `a_stop_request_off_air_is_accepted_and_passed_to_the_process_owner` |
| E7 | the worker does not wait for the reply to leave | `a_stop_request_waits_for_its_reply_then_is_recorded_under_its_id` |
| E8 | the stop is recorded under the wrong reason | the real-engine test |
| E9 | the worker never listens for a stop | the real-engine test |
| E10 | a stop ends the worker with code 1 | the real-engine test |
| E11 | the transport does not record who asked | the real-engine test |
| E12 | the transport record leaves out the subject | the real-engine test |
| E13 | the mock accepts a stop on air | `a_stop_is_refused_on_air_and_accepted_off_air` |
| E14 | the new refusal has another's name | `every_refusal_code_name_is_its_wire_tag_and_unique` |
| E15 | the protocol version is not raised | `the_tool_schema_is_versioned_with_the_protocol` |
| E16 | the list of every scope leaves out `stop` | `the_list_of_all_scopes_holds_every_scope` |
| E17 | the stop is written outside the request's id | `a_stop_request_waits_for_its_reply_then_is_recorded_under_its_id` |

**E7 survived once.** The first version waited inside the thread that ends the
process, and the real-engine test cannot see the wait: the reply usually wins the
race without it. The wait became `wait_and_record_stop`, and a unit test asserts the
stop is written only after the grace. A mutation that survives is a test that was
not there yet.

Two other things the run found, not mutations: the first gate run stopped on a Node
test that pinned protocol 6, and the second on the refusal audit, which requires
every refusal to be driven by a check or have a named limitation (the audit was
doing its job). I also misread one gate's exit code and started the mutations on
code with a failing test; I stopped them within minutes, restored the one file they
had changed (`message.rs`, byte-compared against its backup) and reran in order.

## Jev and Laya

Design consult (`jev-laya-design.json`): which rule for a stop on air. Jev chose
"own scope, refused on air" (0.74); Laya chose "build nothing" for every question
about the rule, which the user's request rules out. Jev also chose, with 1.00, that
`engine.stop` name the request, its id and the credential, and that the engine reply
first and stop after. Decided by hand for Jev's. Where Jev put the credential in the
engine's own record I put it in the transport's record under the same id (the engine
never sees the credential); that is a reading, named here.

Slice review (`jev-laya.json`): refused by name without the scope 0.97, stops in
order on record 0.97, on-air rule decided and tested 0.85, the credential-in-the-
transport-record reading acceptable 0.86, mutations can fail 0.96, silent
substitution 0.47, a stop could be lost in an unnamed way 0.36, "must fix" 0.48.
Weakest point: the 250 ms wait (0.98), named in limit 3. The 0.48 on "must fix" and
0.47 on silent substitution are not above 0.5 and are reported unresolved: I found
nothing further to fix. Laya answered 0.95 to 0.99 on every yes/no question, as on
2.16 and 2.18: no signal from it on yes/no.

## Limits and readings

1. **Nobody holds the stop scope yet.** No shell, tool or token issuer gives a
   credential `Scope::Stop`; the request works through the protocol and is tested
   with credentials minted for the test. Giving an operator that credential, and a
   Playout button or MCP tool that sends it, are separate rows.
2. **The engine will not stop on air.** The only way to stop an engine with a scene
   on Program remains its console (Ctrl+C or a window close, 2.16, 2.18) or a kill.
   An "even while on air" form was offered (Jev preferred refusing) and not built.
3. **The reply and the stop are not tied together.** The engine waits 250 ms before
   it ends. A reply that takes longer to leave (a stalled socket) is lost and the
   client sees the connection close; the stop is on record either way. The wait
   is tested; that 250 ms always suffices is not.
4. **The credential is named by the transport's record, not the engine's.**
5. **Only the render worker binary owns a process to stop.** The engine host, the
   MCP servers and the shells have no stop request; a library `Engine` with no owner
   refuses the request by name.
6. **A stop that arrives while the engine is already ending** (Ctrl+C, a fatal exit)
   waits for the log and then exits 0 from the handler thread; which exit code wins is
   a race. The log is whole either way.
7. **No wire change is compatible**: version 7 refuses a version-6 peer, as every
   protocol bump does (a mismatch is an error code, never a negotiation).
