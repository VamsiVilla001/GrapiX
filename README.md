# GrapiX 2.0

Broadcast graphics: authoring, playout and rendering. Three applications, one
set of contracts.

> **Status: foundations.** The four planes' contracts and semantics are
> implemented and tested, and the control plane runs over a real L0 transport.
> There is no renderer, no application shell and no output. **Nothing in this
> repository has produced a frame.** Status words are used exactly as
> [`docs/README.md`](docs/README.md) defines them.

## The three applications

| | Owns | Port |
|---|---|---|
| [**Editor**](Editor/) | Mutable authoring content. Cannot change Program or outputs | project-api 4100 |
| [**Playout**](Playout/) | Published scene operations. The only client that may Cue, Take, Continue, Clear or configure outputs | playout-control 4300 |
| [**Render Engine**](services/render-engine/) | Program pixels, and **time** | 4400 |

[`Shared/`](Shared/) is contracts, not a fourth application.

## The constraint that shapes the design

The engine runs on the editor's machine now and on a separate output server
later — one locked to house genlock. Once output is locked to an external
reference, **the render node owns time**. Any design where a controller says
"render now" is already broken, so the control plane carries intent
(`NextOpportunity` or `Frame(n)`) and the engine answers with the frame it
committed to.

That is why relocating the engine is a deployment change rather than a rewrite.
Full reasoning in
[`docs/adr/0001-distributed-architecture.md`](docs/adr/0001-distributed-architecture.md).

## Layout

```
Shared/          contracts — Rust is the source of truth, TypeScript generated
  contracts/         core types: ids, rational rates, tier, clock, refusals
  control-plane/     protocol v3: intent, never time
  control-transport/ protocol v3 over a stream (L0: loopback TCP)
  asset-plane/       packages, content addressing, resumable transfer
  media-plane/       preview and confidence frames; drops, never queues
  generated-ts/      GENERATED — never edited by hand
services/
  render-engine/   host (supervisor) + worker (Rust/wgpu)
  schema-mcp/      standalone read-only MCP server over the contracts
Editor/          Tauri 2 authoring shell
Playout/         Tauri 2 playout shell
mocks/           valid peers: each product develops against these, not each other
conformance/     what a valid peer does; the merge gate
tools/           contract codegen and the structural guards
docs/            ADRs, invariants, authority order
```

## Getting started

```bash
npm install
npm run check
```

`npm run check` runs, in order: the structural boundary guard, the generated-
output staleness check, the TypeScript project build, and the Rust test suite.

| Command | Does |
|---|---|
| `npm run codegen` | Regenerate `Shared/generated-ts` from the Rust contracts |
| `npm run codegen:check` | Fail if the committed generated output is stale |
| `npm run check:boundaries` | Fail on a cross-domain dependency |
| `npm run typecheck` | Build every TypeScript project |
| `npm run test:rust` | `cargo test --workspace` |
| `npm run conformance` | Run the conformance suite against every available peer |

## Running something

There is no application yet — no window, no viewport, nothing rendered. What
runs today is the control plane.

The conformance suite is the most informative thing to run. It exercises four
peers, including one over a real socket, and reports per peer:

```bash
cargo run -p gx-conformance
```

A mock engine can also be run as a real server, which is how an Editor or
Playout developer works against a peer that refuses where the real engine will
(ADR-003):

```bash
cargo run -p gx-mock-engine -- --genlocked --publish lower-third:4
```

It listens on `127.0.0.1:4400`. It is a mock: no GPU, no renderer, no outputs.
A take moves a state field and nothing reaches a screen.

## Before you change anything

Read [`docs/invariants.md`](docs/invariants.md). It is short, and every rule in
it is there because breaking it cost something real — a 482 ms-per-frame
regression, a 15-second hang on every call, a truncated file cached under a
name claiming it was verified. The rules are cheaper than re-earning them.

Then read [`memory.md`](memory.md) for what has actually been done and verified.
