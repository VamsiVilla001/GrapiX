# 12.10 Overlay layers with channel/layer targeting: first slice

**Slice 1 built 20 November 2026; the row stays active.** Decision Q8 (16 Oct 2026): keep overlay layers with channel/layer targeting on one Program channel in scope, add the target fields now and refuse other channels by name.

## Built
- **`Envelope.target: Option<OutputTarget { channel, layer }>`** (`Shared/control-plane`): closed (`deny_unknown_fields`); absent on the wire when none, so an engine or client that predates it reads the envelope as before. Absent means the Program channel's main layer (`PROGRAM_CHANNEL`, `MAIN_LAYER`). It rides the envelope, as the operator does, so no request type changed; it moves into the requests when the engine composes layers.
- **`ClientRequest::is_targeted()`:** cue, take, clear and phase (the continue). The output configuration is the channel's own and is not aimed.
- **Refusals by name** (`Refusal::ChannelNotSupported`, `LayerNotSupported`), checked by the transport server after the credential, scope and operator, before the engine: only `program` exists, and only `main` is drawn. The name is shown cut to 32 characters and escaped, so a hostile one cannot put a line break or a long string in a log.
- **Client:** `Client::set_target`, sent with targeted commands only, kept across a redial.
- **As-run (12.11):** each record names the layer (`main` when none).

## Evidence
- `tests/target.rs`, 8 tests over a real server, client and mock engine: each of the four targeted commands refused for another channel and for another layer, and none reaches the engine; no target and an explicit `program/main` both work; a read and the output configuration carry no target; a hostile name is cut and escaped; the target survives a redial; the wire form (no target when none, round trip, closed). The conformance refusal audit drives both refusals through a real server.
- 11 mutants, one at a time: 10 each failed a named test; one is equivalent (the client sending a target on every request: the server ignores it on a command that is not aimed).
- Gate: fmt, clippy `-D warnings`, `npm run check` exit 0: 135 Node, 547 Editor, 1,209 Rust (38 ignored), conformance 633 passed, 0 failed, 9 skipped.

## Not done (the row stays open)
- Independent layers: a bug, a lower third and a ticker cued, taken, updated and cleared separately on one output with a deterministic z-order and a named refusal on conflict. The engine holds one Program scene; compositing several is its own engine change.
- Update, Continue and Out as commands of their own (the engine has Cue, Take, Clear and Phase), and the targeted clear that removes only its layer when the expected page still matches.
- Playout and the Playout MCP do not set a target yet.
