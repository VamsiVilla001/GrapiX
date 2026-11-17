# OSI layering audit of GrapiX (17 November 2026)

Read-only. Nothing was built, run or changed to produce it. Requested by the user on 17 Nov 2026: "make sure the whole
application is solidly built on the OSI model". Three read-only agents mapped the network-facing code (control plane and
transport; asset and media planes; MCP servers, shells and the architecture guard). I checked the claims marked **verified**
against the code myself; the rest are the agents' reports, read as consistent with what I saw but not re-checked.

**Words.** In this repo "L0/L1" means *locality tiers* (co-located vs LAN) and "plane" means a logical channel (control,
asset, media). Neither is an OSI layer. Layers here: 1 physical/link (NIC, loopback, local pipe, shared memory, video
output); 3 network (which interface, loopback vs LAN policy); 4 transport (TCP, pipe, accept loops, timeouts); 5 session
(connection state, authentication, sequence numbers, handshake, retry); 6 presentation (framing, serialisation, hashing,
compression, codecs, wire version); 7 application (requests, scopes, refusals). Layer 2 is the OS's and has no code here.

## The shape, in one paragraph

The *pure* pieces are well layered: framing (`framing.rs`), sequencing (`sequence.rs`), the bind *policy* (`check_bind`), the
`ControlStream` abstraction that makes TCP, pipe and Unix socket one server loop, the `Transfer` state machine, the pure
`handoff_for`, the generic media slot, and the `FontFetcher` and `OutputAdapter` traits. The *loops that use them* are where
layers mix: `server.rs` `handle_connection`, `publish.rs` and `preflight.rs` each span transport to application in one
function. That is normal for a first build; the cost is that policy exists in several places and the places disagree.

## Findings, most serious first

**High**

1. **The wire version is not enforced on connect (verified).** The client stores the engine's capability reply without
   comparing its protocol number (`control-transport/src/client.rs`, capability exchange). The engine's own check is
   `check_protocol(PROTOCOL_VERSION)`, a constant compared with itself (`engine.rs:1248`, `mock-engine:421`), so
   `ProtocolMismatch` cannot be produced on the real path. The `Capability` request and the envelope carry no version.
   *Consequence:* bumping the protocol (I did, to 7, in row 2.19) does not make a mismatched peer refuse by name. My 2.19
   evidence said it did; corrected today. *Layer:* 6 (and 5, the handshake).
2. **The MCP HTTP server has no authentication (verified).** Nothing in `mcp-server/src` reads a credential; scopes are fixed
   when the server is built (`editor-mcp/src/lib.rs:66`) although a comment says they are "presented at connection". The
   protection is loopback-only binding plus a Host/Origin allow-list (good against a browser, none against any other local
   process, which gets the Author scope). The control plane verifies a token. *Layer:* 5.
3. **The asset plane has no authentication and its own bind (reported; consistent with what I read).** `AssetPublishServer`
   calls `TcpListener::bind` directly (`publish.rs:223`, `preflight.rs:108`), bypassing `check_bind` and the token rule. The
   worker only avoids exposure by passing loopback. Invariant 41 is therefore a convention, not structure. *Layers:* 3, 5.
4. **`--lan` is a label, not a route (verified).** The worker binds both listeners to `127.0.0.1` whatever `--lan` says
   (`worker/src/main.rs:170,175`); the flag only changes the declared locality, which drives timing lead and codec choice.
   A LAN engine as declared cannot be reached over a LAN. May be intentional for the current phase; it is not stated.
   *Layers:* 3, and 7 deciding by a label.
5. **No timeouts or keepalive at the transport layer (asset plane verified; control server and MCP reported).** The asset
   plane sets no socket timeout (the only one is the font fetcher's 30 s), so a stalled peer can hang the Editor's publish
   command. The control client has a 5 s request timeout; the control server has none and allocates up to 1 MiB after a
   length prefix before authentication. The MCP HTTP path has no per-call timeout and one driver thread serialises calls.
   *Layer:* 4.
6. **Unbounded server state (verified).** One thread per accepted connection with no cap (`server.rs:134`, also
   `publish.rs:246`, `preflight.rs:129`); the per-connection acknowledgement map is never trimmed (`server.rs:305,427`);
   the asset-plane transfer has no cumulative size bound before the 4 GiB check after full receipt. Accepted control
   streams never get low-latency set (only the client does). *Layers:* 4, 5.

**Medium**

7. **Resume and retry are claimed but not built (verified).** `lib.rs` and `transfer.rs` describe resume; every transfer
   answers `resume_from: 0`, the active transfer is connection-local, and the client has no retry or backoff. *Layer:* 5.
8. **The host mistakes an authentication refusal for "nothing listening" (code read).** `host/src/lib.rs` treats any
   `Client::connect` error as no engine and spawns a worker; the second worker then fails to bind and the host reports
   that, not the refusal. The host also has no token option. *Layers:* 5, 7.
9. **Locality is decided in three tables and the offered-codec table is written twice** (`handoff_for`, `negotiate`,
   `Lead::for_locality`; `engine.rs:1163-66` and `mock-engine:396-97`), and the server re-decides the route
   (`publish.rs:586`). One negotiation point would be safer. *Layers:* 3, 6, 7.
10. **Hard-coded addresses repeat (verified).** `127.0.0.1:4400` in `Playout/shell/src/lib.rs:41` duplicates
    `ENGINE_CONTROL_PORT`; `127.0.0.1:4401` in `Editor/shell/src/lib.rs:70` duplicates the worker's "control port + 1"
    rule; `tools/launch-shells.mjs` repeats both; `editor-mcp --http <port>` accepts any port while rule R8 only greps the
    literal `4100`. *Layer:* 3.
11. **My own stop path guesses at the transport (verified, mine, row 2.19).** The worker waits 250 ms after accepting a
    stop so the reply can leave (`worker/src/main.rs`): application code guessing when layer 4 has flushed, with no flush
    acknowledgement. Named in the 2.19 evidence as a limit; this is the layering reason it is one.
12. **Application meaning in transport code.** `server.rs` special-cases `ClientRequest::Stop` for the log record and
    enforces per-request scopes (deliberate, row 5.7, but the transport changes whenever requests change); the L5
    message `Authenticate` lives in the L7 enum and the engine must handle it; `publish.rs` parses and validates the scene
    inside request dispatch and splices correlation ids and edit ids into the JSON bytes at the framing layer;
    `package.rs` parses the scene inside the container reader. *Layers:* 5, 6 mixed with 7.
13. **Verification is repeated** (the same bytes hashed up to six times on the local-path route). Mostly deliberate
    (invariant 28); the dialect and store re-hashes are the redundant pair. Upload sends chunks as JSON number arrays,
    download streams raw bytes: presentation is asymmetric. *Layer:* 6.
14. **Errors cross layers.** `Refusal::TransportFailed` is the transport's error and also emitted by the engine for
    non-transport causes; the Editor maps resets and EOF to "Protocol" failures; MCP returns `Unauthenticated` for a
    missing scope where the control plane returns `ScopeNotGranted` and the comment claims the two cases are
    indistinguishable while the code returns different refusals.
15. **Client reply matching (inferred).** The control client matches replies by FIFO channel, not by id; after the 5 s
    timeout a late reply may be handed to the next request. Events are drained only inside a request, so an idle link
    gets no events and no liveness check. `Client::reconnect` has no product caller.

**Low**

16. The MCP wire layer is unlogged (a Host/Origin 403 or a dropped stdio line leaves no record). `CORR_HEADER` is copied
    in three places with no cross-language equality test. `tools/serve-web.mjs` listens on all interfaces (a dev tool).
    The media plane is a clean generic slot with almost nothing on top of it yet (no encoder for JPEG/H.264/HEVC in the
    tree; `Frame` carries no pixel format or colour tag).

## What is already well layered

Framing and sequencing are pure and check bounds before allocating; the bind policy runs before a socket exists; connect
never falls back to TCP; credentials are verified once and kept as connection state, never logged; the duplicate-acknowledgement
cache gives re-send without re-execution; the font fetcher is https-only with redirect re-check, byte ceilings and a 30 s
timeout; MCP HTTP is loopback-only with a test and Host/Origin tests; handlers are thin; every MCP call passes one scope gate;
no front-end code opens a socket or builds control-plane bytes (I found no fetch, WebSocket, XHR or EventSource in either
front end, and both shells' CSP is `connect-src ipc:`); the Playout service sits behind the `EnginePeer` trait.

## What the guard (`tools/check-boundaries.mjs`) covers and what a layering rule set would add

Covered today: dependency direction between Shared and the products (inv 1, 3, 23), the shell command boundary (R1, R4),
store and mutator chokepoints (R2, R3), no scene document in the MCP structs (R5), Editor crates take no control-plane client
(R6), schema headers (R7), the literal port 4100 (R8), no branching on `Locality` (R9). Blind spots: files under `tests/`;
anything but `.rs`, `.ts`, `.tsx`, `Cargo.toml` and schema files; R4 covers Editor TypeScript only (not `Playout/web/*.js`);
R1 skips the Playout shell.

Rules a layering guard could enforce:

- **Socket policy:** `TcpListener::bind`, `TcpStream::connect` and `SocketAddr` parsing only in an allow-list of crates; every
  listener goes through `check_bind`; host:port literals only in the one constants module (4400, 4401, the MCP port).
- **Handler crates** (`editor-mcp`, `playout-mcp`): may not use hyper, rmcp, `std::net`, tokio net or control-plane `message`
  types. `wire.rs` may not import `gx_editor` or `gx_playout`.
- **Scope checks:** `Scope::` and `authorise` only at the gate (control server and MCP gate).
- **Front ends:** extend R4 and R9 to `Playout/web/*.js`; ban fetch, WebSocket, XHR and EventSource in web code; pin the CSP
  and the Tauri capabilities; extend R1 to the Playout shell.
- **Limits:** a test that each listener sets read and write timeouts, a body or frame bound and a connection cap; a test that
  `CORR_HEADER` is the same string in its three copies.

## Proposed rows (for the user to accept, reorder or refuse; numbers are suggestions)

| Row | Work | Why first |
| --- | --- | --- |
| 2.20 | Enforce the wire version on connect: the client sends its protocol, the engine refuses a mismatch by name (`ProtocolMismatch`), the client checks what comes back; tests against a peer at another version | Every protocol change since 4 is unenforced; cheapest fix, widest protection |
| 2.21 | One bind policy for every listener: asset plane and MCP HTTP go through `check_bind`; `--lan` binds per policy; ports from one constants module; guard rules for sockets and literals | Makes invariant 41 structural |
| 2.22 | Transport bounds: read and write timeouts, connection caps, pre-authentication frame bound, acknowledgement eviction, low-latency on accepted streams, asset-transfer cumulative bound; a flush acknowledgement so the stop path does not sleep | Closes findings 5, 6 and 11 |
| 2.23 | MCP HTTP authentication (decision for the user: a token like the control plane, or loopback-only stays) | Finding 2 is a design decision, not a bug |
| 2.24 | Asset-plane authentication, resume and retry, host classifies an authentication refusal (decision for the user on scope) | Findings 3, 7, 8 |

Not proposed as rows: the repeated hashing (13), the error-name cleanups (14) and the low items (16): worth a pass inside
the rows above, not on their own.

## Limits of this audit

Read from code, not executed: client behaviour after a timeout (15) and the Windows named-pipe close behaviour are
inferred. TypeScript clients' reconnect behaviour was not examined. Whether the asset plane has compensating controls
elsewhere was not found. The media plane's UI consumers, if any, were not found. Findings 3, 5 (control server and MCP),
6 (control server), 8 and 12 to 16 are the agents' reports that I read as consistent with the code but did not re-check.
