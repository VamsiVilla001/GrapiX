# 2.21 — one bind policy for every listener (17 to 18 Nov 2026)

The OSI layering audit (`docs/audit/osi-layering-2026-11-17.md`, findings 3, 4 and 10) found that only the
control plane asked a bind policy before it opened a socket. The asset plane bound its own listener and asked
nobody; the MCP HTTP server hard-coded loopback but took any port; `--lan` changed a label and no interface;
and the engine's `127.0.0.1:4400` and `:4401` were written out in both shells, a launcher and the worker.

## Done-when

> Every listener a product opens passes through one bind policy (`gx_contracts::endpoints::check_listen`): a port
> reserved for another product is refused by name on every plane; a token under 32 bytes is refused; the control
> plane may leave loopback only with a token; the asset plane and the MCP HTTP server verify no credential, so
> they listen on loopback only, token or not, until rows 2.24 and 2.23 give them one; an engine started with
> `--bind IP` listens for control on that interface and a test reaches it over this machine's own address, while
> `--lan` stays a declaration of how assets reach the engine; the repeated `127.0.0.1:4400` and `:4401` literals
> come from one constants module; the architecture guard refuses a socket bind outside the listed bind sites (and
> a listed site that does not ask the policy) and an engine host:port literal outside that module.

**This is not the done-when first proposed for the row.** Three things changed, each decided by hand with Jev
and Laya consulted first (`jev-laya-design.json`), and each is named here and in the plan row:

1. **A plane that verifies no credential may not leave loopback even with a token.** The proposal said "a bind
   off loopback without a token is refused" for the asset plane and the MCP HTTP server "as for the control
   plane". But those two never check a token, so a token configured on them protects nothing and would only
   make the listener look protected. Jev: refuse until authenticated, 1.00, and the safest option, 0.94.
2. **`--lan` was not made to bind.** The proposal said an engine started with `--lan` "binds its declared
   interface". Conformance and tests start engines with `--lan` on loopback to exercise the LAN transfer path
   without a second machine, so `--lan` stays what it is (a declaration of how assets arrive) and a new
   `--bind IP` chooses the control plane's interface. Jev chose this at only 0.42; Laya chose "`--lan` implies
   bind" at 0.14. Neither is a clear answer, so this one is my decision and is reported as that.
3. **The guard checks for `Playout/web` and the Playout shell "as it does the Editor" were not done.** They are
   a different kind of rule (R1, R4, R9) from the two this row adds; they are proposed row 2.26.

Laya disagreed with Jev on all five design questions (0.14 to 0.43 confidence, no truncation); it preferred
authenticating now, which is rows 2.23 and 2.24 and needs the user's decision on the credential.

## What was built

- **`Shared/contracts/src/endpoints.rs`** (new, in the lowest crate so every plane can use it): the ports
  (`ENGINE_CONTROL_PORT` 4400, `ENGINE_ASSET_PORT` 4401), the default endpoints, `MINIMUM_TOKEN_BYTES`,
  `RESERVED_PORTS` (4200, 4100, 4300), `Plane { Control, Asset, McpHttp }` with `authenticates()` (only
  `Control` today: the one line that changes with 2.24 and 2.23), `check_listen(plane, addr, token)` and
  `check_listen_io` (the same as an `io::Error`, `PermissionDenied`, with the plane named first).
- **Control plane** (`Shared/control-plane/src/bind.rs`): `check_bind` is now the control plane's case of
  `check_listen`; the constants are re-exported; `BindRefusal` gains `PlaneCannotAuthenticate`.
- **Asset plane**: `check_asset_listen`, asked first by `AssetPublishServer::bind` and `AssetTransferServer::bind`.
- **MCP HTTP** (`services/mcp-server/src/wire.rs`): `check_http_listen`, asked by `serve_http` before it binds
  (so `--http 4100` is refused by name) and by `serve_http_listener` in place of its own loopback comparison.
- **Worker**: `--bind IP` for the control plane (the policy requires a token off loopback); the asset plane
  stays on `127.0.0.1` and the start line says so; `engine.start` records `bind`; the usage text says what
  `--bind` and `--lan` each mean.
- **One place for the endpoints**: the Playout and Editor shells and the mock editor's usage text take them
  from `endpoints.rs`; the launcher takes its ports from a new `tools/engine-ports.mjs`, which reads the same
  file and fails by name if a constant is gone. `tools/serve-web.mjs` now binds `127.0.0.1` (it listened on every
  interface).
- **Guard** (`tools/check-boundaries.mjs`): **R10** a `TcpListener::bind` or `UdpSocket::bind` outside the four
  listed bind sites is refused, and a listed site that never calls a `check_*listen(` is refused; **R11** an
  engine `host:4400` or `host:4401` literal outside `endpoints.rs` is refused, in Rust and in the Editor and
  Playout TypeScript. `conformance/` is exempt from both (it binds scratch sockets for the processes it tests).

No download. No wire or protocol-version change.

## What was run

- **The policy** (`endpoints.rs`, 8 tests): loopback needs no token on any plane; the control plane leaves
  loopback with a token and not without (`192.168.1.50`, `10.0.0.4`, `0.0.0.0`, `::`); the asset plane and the MCP
  HTTP transport are refused off loopback with or without a token, and the message names the plane and says why;
  each reserved port is refused by name on every plane; a short token is refused; the default endpoints agree
  with the port constants and the engine's own ports are not reserved; an `io` refusal is `PermissionDenied`
  and names the plane first.
- **Control plane** (`bind.rs`, 8 tests, unchanged in what they ask): they pass through the shared policy.
- **Asset plane** (2 new tests): `AssetPublishServer::bind` and `AssetTransferServer::bind` refuse `0.0.0.0`,
  `192.168.1.50`, `::` and port 4100 (the publish server also 4200 and 4300), `PermissionDenied`, naming the asset
  plane and the reason; loopback on a free port binds. `192.168.1.50` is not an address of this machine, so the
  refusal is shown to come from the policy and not from a bind that could not succeed anyway.
- **MCP HTTP** (2 new tests, 1 changed): the policy names the transport and allows `127.0.0.1` and `::1` only;
  `serve_http` on 4100, 4200 or 4300 is refused before anything binds; a listener bound to `0.0.0.0` is refused.
- **A real engine process** (`services/render-engine/worker/tests/bind.rs`, 6 tests, each starts
  `gx-render-worker`):
  - `--bind 0.0.0.0` without a token: `engine.bind_failed` names "non-loopback control plane requires a token",
    exit code 1, and no `engine.start` is ever written.
  - `--bind 0.0.0.0` with a token: the control plane's recorded address is not loopback, the asset plane's is,
    `engine.start` records `bind`, and a client with a credential for the secret gets a status reply.
  - **`--bind <this machine's own network address>` with a token** (the address the system would send from, found
    without sending anything): the control plane is on that address and answers a credentialed client over it;
    it refuses a connection on `127.0.0.1`; the asset plane refuses a connection on the network address and
    accepts one on loopback. On this machine the test printed `RAN: bound and reached over this machine's own
    network address`.
  - by default both planes are on loopback; `--asset-port 4100` is refused naming the asset plane and the reserved
    port, exit 1; `--bind the-lan` is a usage error, exit 2.
- **Guard** (`tools/tests/check-boundaries.test.mjs`, 9 new cases, 33 in all with the real tree): a bind outside
  the list (std and tokio forms) is refused; a listed site that does not ask is refused; a listed site that asks
  and the conformance harness are allowed; the engine's control and asset endpoints written out are refused in
  Rust and in a front end; `endpoints.rs` is where they are written. **On the real tree the new rule found one
  literal I had missed**, in the mock editor's usage text, now taken from `endpoints`.
- **The tools' ports** (`tools/tests/engine-ports.test.mjs`, 3 tests, in the gate): the ports read from
  `endpoints.rs` agree with the default endpoints written in the same file; a constant that is not there, was
  renamed or is only in a comment is an error by name and never a default; the launcher imports them and writes
  no port number of its own. The launcher itself was not started (it opens both shells).
- **Gate** (`cargo fmt --check`, `cargo clippy -D warnings`, `npm run check`), four runs, all reported:
  1. **Failed**, exit 1, on one conformance check that is not this row's: "no log file has a gap in its sequence
     that a log.lost record does not state". In the engine's log, `log.lost` named number 48, then 49 was
     written, then 48. Cause, read in the code and not guessed: the log sink (row 2.11) takes a record's number,
     builds the line and then queues it, so two threads logging microseconds apart can queue in the other order,
     and the writer states the late one as lost and then writes it. This is a defect in the sink, not load, and
     it is **not fixed here**: the failing lines are kept in `gate-first-run-failure.txt` and it is proposed as
     row 2.25.
  2. **Passed** on the same tree: 69 Node tests, 424 Editor tests, 1030 Rust tests (38 ignored), conformance 631
     passed, 0 failed, 9 skipped.
  3. **Failed**, exit 1, on the final tree (after the tools' port module and the fresh test secret): the timed
     check "headless renders while Program runs add no late or missed Program frame" counted 1 late frame of 155
     with 4 headless renders (150 frames and none late for Program alone). I had the Laya model running on the
     CPU while this gate ran, which was my mistake; this check has failed under load before (rows 2.12, 3.19) and
     neither change of this run touches the frame path.
  4. **Passed** on the final tree with nothing else running: `FMT_OK`, clippy exit 0, `npm run check` exit 0
     (72 Node tests, 424 Editor tests, 1030 Rust tests with 38 ignored, conformance 631 passed, 0 failed,
     9 skipped).

  Two passes do not show the sink race is gone; they show this row's tree passes when the race does not happen.

## Mutations

27, one at a time, each restored byte-identical, each made a named check fail (`mutations.txt`).
**One did not on its first run.** H2 (the MCP listener serves any address) made the mutated transport serve the
`0.0.0.0` listener for ever, so the one test that would notice hung until the runner killed it at its 25 minute
limit. A hung test is not a named failure. The test now shuts the listener down after 5 seconds and fails by
assertion, and H2 run again fails it by name. W4 was added after the reach test, and L1 and L2 after the
tools' port test, to show those tests can fail.

| # | Mutation | Fails |
|---|---|---|
| P1 | a plane that verifies no credential may leave loopback with a token | `a_plane_that_verifies_none_may_not_leave_loopback_token_or_not` |
| P2 | every plane is said to verify a credential | `only_the_control_plane_verifies_a_credential_today` |
| P3 | a reserved port is not refused | `a_reserved_port_is_refused_by_name_on_every_plane_and_address` |
| P4 | port 4100 is no longer reserved | both asset-plane bind tests |
| P5 | the asset port constant drifts from the default endpoint | `the_defaults_agree_with_the_ports` |
| P6 | a short token is accepted | `a_short_token_is_refused_rather_than_padded` |
| P7 | the unspecified address counts as loopback | both leave-loopback tests |
| P8 | an io refusal does not name the plane | `an_io_refusal_is_permission_denied_and_names_the_plane_first` |
| P9 | an io refusal is not `PermissionDenied` | the same test |
| A1 | the publish server binds without asking the policy | `the_publish_server_asks_the_bind_policy_before_it_opens_a_socket` |
| A2 | the publish server asks as the control plane | both asset-plane bind tests |
| A3 | the transfer server binds without asking the policy | `the_transfer_server_asks_the_bind_policy_before_it_opens_a_socket` |
| A3g | the same, seen by the guard on the real tree | R10 at `preflight.rs` |
| H1 | the MCP HTTP transport takes any port | `the_http_transport_refuses_a_reserved_port_before_it_binds` |
| H2 | the MCP HTTP listener serves any address | `the_http_transport_refuses_a_listener_off_loopback` (second run) |
| C1 | the control plane asks the policy as another plane | two control-plane bind tests |
| W1 | the worker ignores where `--bind` says | two real-process tests |
| W2 | the worker lets the asset plane follow `--bind` | the real-process test with a token |
| W3 | the worker parses `--bind` and drops it | two real-process tests |
| W4 | the worker binds every interface when `--bind` names one | the reach test |
| L1 | the launcher writes the ports out again | "the launcher asks for the ports and writes no port number of its own" |
| L2 | a port the module does not name falls back to a default | "a constant the module does not name is an error by name, not a default" |
| G1 | the guard stops listing the MCP server as a bind site | a guard case and the real tree |
| G2 | the guard no longer asks a listed site to call the policy | "a listed bind site that never asks the policy is refused" |
| G3 | the guard forgets the asset port | "the engine's asset endpoint written out is refused" |
| G4 | the guard no longer watches for binds outside the list | three guard cases |
| G5 | the real tree writes the engine endpoint out again | R11 at `Playout/shell/src/lib.rs` |

## Jev and Laya

The design consult (`jev-laya-design.json`) is reported under the done-when above.

The slice review ran twice: `jev-laya-first-review.json`, then `jev-laya.json` after the two fixes it led to.
Jev's answers, first run then second:

| Question | First | Second |
|---|---|---|
| every listener asks the policy, each with a test and a guard rule | 0.86 | 0.85 |
| the done-when, as written here, is met | 0.75 | 0.76 |
| each change from the proposed done-when is named with its reason | 0.93 | 0.93 |
| loopback only is the right rule for a plane that checks no credential | 0.90 | 0.90 |
| the reach is shown with a real process | 0.96 | 0.96 |
| the policy has a hole | 0.33 | 0.32 |
| the mutations show the checks can fail, and the hung one is reported | 0.97 | 0.97 |
| the gate's first failure is handled openly (asked in the second run only) | | 0.95 |
| something is silently substituted | 0.52 | 0.51 |
| a defect should be fixed before committing | 0.71 | 0.73 |

What the review led to:

- **Weakest point, first run: the launcher's untested port reading (0.48).** Fixed: `tools/engine-ports.mjs`, three
  tests in the gate, two mutations.
- **"A defect to fix first", 0.71.** I read the slice again for one and found a second: the real-process tests
  listened on a network address with a secret written in the test file. Fixed: a fresh secret per run.
- **"Silently substituted", 0.52 and 0.51: not clear either way.** I read it as the guard's Playout checks, left
  out of this row with no row to hold them. They are now proposed row 2.26. The review was not run a third time
  after that, so the number does not reflect it.
- **A hole in the policy, 0.33.** None found by hand: only `127.0.0.0/8` and `::1` count as loopback; the
  unspecified addresses and a mapped `::ffff:127.0.0.1` do not, so a plane that checks no credential is refused
  them.
- **Weakest point, second run: the gate failed once on the unfixed sink race (0.39), and "a defect to fix first"
  stayed at 0.73.** This one is not fixed, and that is my decision, not Jev's: the race is in every commit since
  row 2.11, this row neither adds nor hides it, and its fix changes how the frame path logs, which is a design
  choice (proposed row 2.25). Jev leans towards fixing it before this row is committed; the user is told so.

Laya answered 0.93 to 0.99 on every yes/no question in both runs (no truncation, 7,309 and 7,498 tokens): no
signal from it on yes/no, as before. Its weakest-point choices were "none", then "the reach test needs a network".

## Limits and readings

1. **The asset plane and the MCP HTTP server cannot leave loopback.** A LAN engine started with `--bind` is
   reachable for control only; publishing to it over a network waits for row 2.24, and MCP over a network for
   2.23. Both need the user's decision on the credential.
2. **`--lan` still chooses no interface.** It is a declaration, as before; the usage text now says so.
3. **The host adopts an engine through loopback.** An engine bound to one specific address (not `0.0.0.0`) does
   not answer on loopback, so `gx-engine-host` cannot adopt it. It belongs with the remote-engine work (14.2).
4. **The tools read the ports from the Rust source by pattern**, because a Node script cannot import a Rust
   constant. It is tested and fails by name, but it is a second reader of that file and would need to follow a
   change in how the constants are written.
5. **The guard scans `.rs`, `.ts` and `.tsx`.** The `.mjs` tools and `Playout/web/*.js` are not scanned, so R11
   does not see a literal there. R10 matches `TcpListener::bind` and `UdpSocket::bind` by name: a socket opened
   another way (a raw socket crate) is not seen. Both are in proposed row 2.26.
6. **The real-process tests listen on a network address for a few seconds** on every gate run. Each uses a
   secret made from the system's randomness for that run (the first version used one written in the test file,
   which anybody on the network would hold; found reading the slice again after the review). Windows can raise
   its firewall prompt the first time `gx-render-worker.exe` listens there; the tests connect from this machine
   and do not depend on the answer.
7. **The reach test needs a network address.** On a machine with none it prints `NOT RUN` and returns; it is
   not counted as shown there.
