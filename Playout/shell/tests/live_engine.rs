//! Does a running engine actually answer the Playout shell?
//!
//! Every other test in this crate runs against a stub, which proves the shell
//! is internally consistent and proves nothing about the wire. This one drives
//! `connect` — the exact function `cmd_connect` calls — against whatever is
//! listening on the default control endpoint.
//!
//! It is `#[ignore]` by default because a test that needs a running engine
//! would otherwise fail on a machine that has none, and a suite that fails for
//! environmental reasons stops being read. Run it deliberately:
//!
//! ```text
//! cargo test -p gx-playout-shell --test live_engine -- --ignored --nocapture
//! ```

use gx_playout_shell::{connect, Connection, DEFAULT_CONTROL_ENDPOINT};

#[test]
#[ignore = "needs a render engine listening on the default control endpoint"]
fn a_running_engine_answers_the_operator_surface() {
    let state = Connection::default();
    let view = match connect(&state, DEFAULT_CONTROL_ENDPOINT, None) {
        Ok(view) => view,
        Err(error) => panic!("the engine at {DEFAULT_CONTROL_ENDPOINT} refused: {error}"),
    };

    // Print the whole view: when this is run by hand the point is to *see*
    // what the engine said, not only that it said something.
    println!(
        "connected to {DEFAULT_CONTROL_ENDPOINT}\n{}",
        serde_json::to_string_pretty(&view).expect("the operator view serialises")
    );

    let status = &view.status;
    // A connected surface must carry a real tier and a real clock. These are
    // the two facts every other operator decision reads, and a default in
    // either would be the silent substitution invariant 18 forbids.
    assert!(
        status.epoch.0 > 0,
        "an engine that has started has a non-zero incarnation epoch, got {:?}",
        status.epoch
    );
    assert!(
        status.timebase.den > 0,
        "the rate is rational and its denominator is never zero (invariant 12), got {:?}",
        status.timebase
    );
}
