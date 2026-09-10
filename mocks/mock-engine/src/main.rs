//! Runs the mock engine far enough to prove it is a peer, and prints what it
//! declares. Not a server: there is no transport yet, and pretending otherwise
//! would be the kind of claim invariant 21 forbids.

fn main() {
    let engine = gx_mock_engine::MockEngine::new();
    println!("{}", gx_mock_engine::describe(&engine));
    println!("no transport yet: use this crate as a library, or run gx-conformance");
}
