# 5.7, done 8 November 2026 (Claude)

**Row:** Control-port scope enforcement (Phase 5, Needs 5.2 and 8.13; added
8 Nov from the done-row review).

**Done-when:** a conformance test sends every control request with an
author-scoped token and each is refused by name at the transport; the engine
handler is never reached (asserted by trace). Done before Phase 14 exposes the
port beyond loopback.

## The finding it closes

`Shared/control-transport/src/server.rs` verified a token's signature and then
ignored its claims. Any valid token, of any role, could Take, Clear or
configure outputs straight to the engine. Only the MCP server checked scopes
(8.11, 8.13). Found by the done-row review (`docs/evidence/review-2026-11`).

## Design, asked of both models (`design-jev-laya.json`)

| Question | Jev | Laya | Taken |
|---|---|---|---|
| Reads (Capability, Status, Performance, Render) | Playout role only | Playout role only | Playout role only |
| Phase (continue, play out) | Take scope | a new scope (confidence 0.32) | Take: it changes Program |
| Refusal | a new named refusal | reuse Unauthenticated (0.09) | `ScopeNotGranted`: names the request, the scope and the role |
| Proof the engine is not reached | a recording peer | the reply only (0.39) | recording peer: the done-when asks for a trace |

## What was built

- `ClientRequest::required_scope()`, one exhaustive match, so a new request
  cannot be added without a scope decision:
  - reads need no scope;
  - Cue needs Cue;
  - Take and Phase need Take;
  - Clear needs Clear;
  - ConfigureOutput needs ConfigureOutput.
- `ClientRequest::authorise(role, scopes)`: the role must be Playout and the
  required scope held. Otherwise it returns the new
  `Refusal::ScopeNotGranted { request, required, role }`. TS is regenerated and
  the refusal audit has a route for it.
- The transport checks every request on a protected connection before it takes
  the engine mutex. A refused request is answered by the transport and never
  handed to the engine.
- Unprotected servers are unchanged. The bind policy allows them only on
  approved L0 endpoints, with no secret.
- `Client::authenticate_only`: authenticates without the capability exchange.
  This lets conformance observe the refusal for a credential that may not even
  read the capability.

## Executed

`cargo run -p gx-conformance`: 529 passed, 0 failed, 9 skipped.

**Recording mock behind the protected transport**

- PASS "an author credential is refused by name for every control request".
  All nine requests are refused, each naming the request, its scope and role
  Editor.
- PASS "no request from an author credential reaches the engine". The
  recording peer's trace is empty.
- PASS "a Playout credential without the Take scope cannot take". The take is
  refused naming Take; Status is allowed; the trace shows only `status`.
- PASS "a full Playout credential reaches the engine with every request". The
  trace equals all nine, so the gate refuses exactly what it should.

**The real render worker, started with `--token`**

Both models named the mock as the weakest point, so the check also runs here.

- PASS "the real engine's transport refuses an author credential for every
  request". The engine never produces `ScopeNotGranted`, so each refusal was the
  transport's.
- PASS "an author credential's take leaves the real engine's Program
  untouched". A Playout status read afterwards shows no Program.

**Other checks**

- Refusal audit: PASS "ScopeNotGranted is produced …".
- **Mutation check:** with the transport check stubbed to always allow, the
  first three mock checks FAIL. The engine handled capability, status,
  performance, render, cue and so on, and the cue-only token's take was taken.
  The stub was then reverted.
- Every real caller (the Playout shell, the mock Playout, the Playout MCP)
  uses Playout-role tokens. `gx-control-transport`'s tests pass unchanged.
- Acceptance, asked of both models before the real-worker check was added
  (`acceptance-jev-laya.json`): done, Jev 0.59 and Laya 0.86.

## Also in this commit

The third CI run failed two conformance checks against the real engine. The
runner has no GPU, so the engine reports T2. Both models endorsed both fixes
(0.83/0.93 and 0.91/0.96).

- **"live output refuses below T0"** asked for a made-up adapter, so the real
  engine refused `UnknownOutputAdapter` before checking the tier. It now asks
  for `virtual`, which the real engine offers and the mock accepts.
- **"headless renders while Program runs …"**: a T2 engine correctly refuses
  the Program take this check needs. The check now records a named skip
  instead of a failure (invariant 43).
