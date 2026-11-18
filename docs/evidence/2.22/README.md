# 2.22 — transport bounds (18 Nov 2026)

The OSI layering audit (`docs/audit/osi-layering-2026-11-17.md`, findings 5, 6 and 11) found that no listener
bounded what a connection could cost it. The control server spawned a thread per connection with no cap and read
with no timeout, so a peer that connected and said nothing, or sent half a frame, held a thread for ever; it
allocated up to 1 MiB for a frame from a peer that had not authenticated; it kept an encoded acknowledgement for
every request a connection ever made; its accepted streams were not low-latency (the client's were); and the stop
path ended the process after a fixed 250 ms sleep, a guess at how long a write takes. The asset plane and the MCP
HTTP server had the same unbounded threads and no timeouts, and the asset transfer dialect held a whole
transfer in memory with no byte cap until the last chunk had arrived.

## Done-when

> Every listener sets read and write timeouts, caps its connections and bounds a frame before authentication; the
> control server evicts acknowledgements it can no longer be asked to repeat; accepted control streams are
> low-latency; an asset transfer is bounded in total as it arrives, not after; a stalled peer is dropped, shown by
> a test for each plane (control, asset, MCP HTTP); the stop path leaves when the transport has flushed the reply,
> not after a 250 ms sleep.

## Design decisions (Jev and Laya consulted first: `jev-laya-design.json`)

Jev's answers, with Laya's in brackets (Laya is an uncalibrated second opinion and disagreed on five of the eight):

| Question | Jev | Laya |
|---|---|---|
| a connection that sends nothing | deadlines, no idle timeout (1.00) | idle timeout |
| how to cap connections | a total per listener (0.91) | the same |
| acknowledgements | a window of the latest 64 (0.89) | drop duplicate support |
| frame size before authentication | small until authenticated (0.92) | the same |
| the stop path | a flush signal with a limit (1.00) | a shorter sleep |
| asset transfer bound | a running count as bytes arrive (1.00) | spill to disk |
| low-latency streams | every listener (**0.32**) | the control plane only |

The one Jev did not settle (0.32) is my decision: **`TCP_NODELAY` on every accepted stream**, control, asset and MCP
HTTP. The frames are small request and reply messages; the 64 KiB asset chunks are large enough that it costs
nothing.

Reading the code, not guessing, corrected two facts in the questions before they were sent: the transfer dialect
had **no** byte cap at all (not "checked after"; `MAX_PACKAGE_BYTES` is checked against sizes a manifest declares),
and the MCP HTTP connection is built with `http1::Builder::new()` and no timer, so no timeout was in force.

## What was built

- **Control plane** (`Shared/control-transport/src/server.rs`, `ServerLimits`, defaults in brackets):
  - a **cap** on connections (32): one more is closed at once, `control.connection_refused` names the cap;
  - **deadlines, not an idle timeout**: from accept to the first request (10 s), then once a frame has begun the
    rest of it has 10 s, and a write has 10 s. An authenticated peer that is merely quiet is never dropped: the
    shells keep one open for the life of the window and the protocol has no ping;
  - **4 KiB before authentication**: a larger declared length on a protected listener is refused before any buffer
    exists for it;
  - the **latest 64 acknowledgements** are kept (invariant 33 still holds inside the window); a duplicate older
    than that closes the connection with "retransmission window passed", on record as `control.window_passed`;
  - accepted streams are **low-latency**, and a limit that could not be applied is logged by name
    (`control.limits_not_applied`), never silently claimed.
- **The stop path** (`EnginePeer::stop_reply_delivered`, `StopFlush`): the engine hands the process owner a one-shot
  the control transport fires after it has written and flushed the stop reply (or failed to). The worker waits for
  it with a 3 s limit and then stops in order; a reply that was not confirmed is a warning
  (`engine.stop_reply_not_delivered`) before `engine.stop`. The 250 ms sleep is gone.
- **Asset plane** (`Shared/asset-plane/src/limits.rs`, `AssetLimits`): both listeners (the publish port and the
  transfer port) take the same cap (16), first-frame (10 s), idle (60 s), frame (30 s) and write (10 s) deadlines and
  low-latency streams. A transfer is **bounded as it arrives**: a `Begin` that declares more than 65,536 chunks, a
  chunk over 64 KiB, or a connection that has sent more than 4 GiB in all, ends the connection with the bound named
  and on record (`asset.transfer_refused`) before the offending request is held; nothing it carried is stored.
- **MCP HTTP** (`services/mcp-server/src/wire.rs`, `HttpLimits`): a 10 s request-head deadline (hyper's
  `header_read_timeout` with a Tokio timer), a cap (16) enforced by a semaphore, and low-latency streams.

No wire or protocol-version change, no new refusal code, no download. One crate gains a dependency edge already in
the lock file (`gx-asset-plane` takes `tracing`).

## What was run

- **Control plane, real sockets** (`server.rs`, 8 new tests): a peer that sends nothing is dropped at the first-frame
  deadline on a protected and on an unprotected listener (400 ms in the test, 10 s shipped); an authenticated peer that
  is quiet for 1.5 s, longer than every deadline, is still served; a frame that begins and stalls is dropped at the
  frame deadline while a quiet peer before it was not; a declared 1000-byte frame before authentication is refused
  without being read (the deadlines were set to 8 s, so only the size could close it); a connection over the cap is
  closed at once and its place is given back when another goes; the latest acknowledgements are repeated and the one
  older than the window closes the connection; accepted streams are low-latency with a write deadline; and the
  transport tells a peer once, and only for a stop, that the reply was written.
- **Stop path** (7 new tests): the engine's one-shot reaches the process owner once and a second word is not heard;
  a stop is recorded as soon as its reply has left (not before, and well before the limit); a reply that had already
  left is not waited for at all (the old sleep was 250 ms); a reply never confirmed, or one the transport could not
  write, ends the wait at the limit and is a warning on record before `engine.stop`.
- **Asset plane** (9 new tests): a silent peer is dropped on both listeners; a peer that pauses between requests is
  dropped at the idle deadline; a frame that begins and stalls is dropped; the cap and its give-back; a `Begin` over
  the chunk limit, a chunk over the chunk size and a connection over its byte total each end the connection with
  nothing stored, and only the bytes inside the bound are counted as received; a transfer inside every bound is
  served; accepted streams are low-latency.
- **MCP HTTP** (4 new tests): a silent connection and a request head that begins and stalls are dropped at the
  header deadline, the cap and its give-back, low-latency streams.
- **The real engine, with the defaults it ships with** (`services/render-engine/worker/tests/limits.rs`): a silent
  peer on the control plane was dropped after 10.0013 s (the asset plane's silent peer was already gone by then);
  with 32 connections held the 33rd was closed in 182 microseconds and the refusal is on record naming the cap;
  and `stop_request.rs` now times the real engine: it was gone **98 ms** after its stop reply reached the client,
  where the old fixed wait alone was 250 ms.
- **Gate** (`cargo fmt --check`, `cargo clippy -D warnings`, `npm run check`): `FMT_OK`, clippy exit 0, `npm run check` exit 0 on the final tree
  (76 Node tests, 424 Editor tests, 1055 Rust tests with 38 ignored, conformance 631 passed, 0 failed, 9 skipped). It was run in a
  separate build folder so the user's running apps were not stopped. An earlier run failed on the log-capture test (see limit 8).

## Mutations

30, one at a time, each restored byte-identical, each made a named check fail (`mutations.txt`).
**One survived its first run.** A5 (a transfer may declare any number of chunks) passed the whole asset-plane suite:
my test closed a connection and asserted it was closed, but the test's idle deadline (600 ms) closes any silent
connection, so the bound could not be told from a timeout. The test now uses a 30 s idle deadline, so only the
bound can close the connection in time; A5 run again fails it by name, as do A6 and A7 which share it.

| # | Mutation | Fails |
|---|---|---|
| C1 | the control listener has no cap | `a_connection_over_the_cap_is_closed_at_once_and_a_place_is_given_back` |
| C1w | the same, seen by the real engine | `the_control_plane_holds_thirty_two_connections_and_closes_the_next_at_once` |
| C2 | a silent peer is never dropped | `a_peer_that_sends_nothing_is_dropped_at_the_first_frame_deadline` |
| C2w | the same, seen by the real engine | `a_peer_that_sends_nothing_is_dropped_by_both_planes_at_the_first_frame_deadline` |
| C3 | a quiet authenticated peer is dropped | the quiet-peer test and the stalled-frame test |
| C4 | an unauthenticated peer may send a full-size frame | `before_authentication_a_large_frame_is_refused_without_being_read` |
| C5 | a started frame has no deadline | `a_frame_that_begins_and_stalls_is_dropped_at_the_frame_deadline` |
| C6 | every acknowledgement is kept | `only_the_latest_acknowledgements_are_kept_for_a_duplicate` |
| C7 | the window keeps one fewer than it says | the same test |
| C8 | accepted streams are not low-latency | `an_accepted_stream_is_low_latency_and_its_writes_are_bounded` |
| C9 | writes have no deadline | the same test |
| C10 | the transport never tells the engine the stop reply left | `the_transport_tells_the_engine_once_the_stop_reply_has_been_written` |
| C11 | the transport tells the engine the opposite | the same test |
| C12 | a connection never gives its place back | the cap test |
| W1 | the stop waits a fixed time again | `a_reply_that_has_already_left_does_not_hold_the_stop_back` and one more |
| W1r | the same, seen by the real engine | `a_stop_request_stops_the_shipped_engine_in_order_and_names_who_asked` |
| W2 | the stop does not wait for the reply at all | the stop-waits test |
| W3 | the engine never tells the owner the reply left | `a_stop_reply_that_could_not_be_written_is_told_as_not_delivered` |
| W4 | the engine never keeps the flush to report on | the real engine's stop test |
| A1 | the asset listeners have no cap | the publish and transfer cap tests |
| A2 | a silent asset peer is never dropped | three asset deadline tests |
| A3 | a started asset frame has no deadline | `a_frame_that_begins_and_stalls_is_dropped_at_the_frame_deadline` |
| A4 | a paused transfer connection is never dropped | `a_peer_that_pauses_between_requests_is_dropped_at_the_idle_deadline` |
| A5 | a transfer may declare any number of chunks | `a_transfer_is_bounded_as_it_arrives_not_after_it_is_assembled` (second run) |
| A6 | a chunk may be any size | the same test |
| A7 | a connection may send any number of bytes | the same test |
| A8 | accepted asset streams are not low-latency | `an_accepted_stream_is_low_latency_and_its_writes_are_bounded` (asset plane) |
| H1 | the MCP header deadline is removed | both MCP header-deadline tests |
| H2 | the MCP listener has no cap | the MCP cap test |
| H3 | accepted MCP streams are not low-latency | `an_accepted_stream_is_low_latency` (MCP) |

## Jev and Laya

Slice review (`jev-laya.json`), Jev: each plane shown with real sockets 0.91; the done-when met on named readings 0.87; the
places it is not fully met named openly 0.95; the stop path shown on the real engine 0.97; leaving a quiet authenticated peer
open is safe 0.82; mutations can fail and the survivor reported 0.97; the log-capture break handled openly 0.96. Two answers
were not clear: "can one peer still cost an unbounded resource nobody named" **0.50**, and "a defect to fix before committing"
**0.62**. Jev's weakest point is the unbounded MCP request body (0.65), which is limit 2. I read the code again for a defect
and found none beyond the limits listed; the MCP body and a 4 GiB in-memory transfer are the two unbounded costs, both named,
and I have left them for a later row rather than claim them. Laya answered 0.97 to 0.99 on every yes/no (no truncation): no
signal, as before.

## Limits and readings

1. **Windows named pipes have no deadline.** The local control endpoint (a named pipe on Windows) offers no read or
   write timeout, so `set_read_deadline` and `set_write_deadline` return `Ok(false)` there, the server logs
   `control.limits_not_applied`, and a silent peer on a pipe is held. A pipe is private to its owner by access
   control; TCP is what an engine exposes.
2. **An MCP request body is not bounded.** The head is (10 s), the cap is, but a peer that sends complete headers
   and then stalls its body holds its task until it closes. No timeout was added to the body: it would need a body
   wrapper, and a limit on tool calls that legitimately run long is a decision of its own.
3. **No MCP write deadline.** hyper offers none; a peer that does not read holds its task.
4. **"Before authentication" means the control plane.** The asset plane and the MCP HTTP server verify no credential
   yet (2.24, 2.23), so their pre-authentication bound is the first-frame or header deadline and the cap.
5. **An asset transfer over a bound ends the connection; it is not a refusal reply.** A legitimate client never
   exceeds them (a package is at most 4 GiB, in 64 KiB chunks), so no new refusal code and no protocol bump were
   made; the Editor would see a transport error, with the bound named in the engine's log.
6. **A transfer is still held in memory** up to its declared chunk count (at most 4 GiB per transfer). The bound is
   now enforced as it arrives, but 4 GiB is a large allowance: spilling to disk (Laya's choice) is a design of its
   own for the asset store.
7. **The stop limit is 3 s.** A client that never reads the stop reply keeps the engine waiting 3 s before it stops;
   it does stop.
8. **Server tests are serial.** The new limit tests failed the existing log-capture test 16 runs in 20 when run in
   parallel with it (see below); they now take one test lock. The lock is a test arrangement, not a product
   change.
