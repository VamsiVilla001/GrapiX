# Mock peers

Each product develops against a mock peer, never against another product
(invariant 25). This is what makes the parallel build real rather than three
teams serialised on whoever's build is broken.

A mock is defined by the conformance suite: it is a *valid peer*, not a stub
that returns whatever unblocks the caller. Mocks must refuse exactly where a
real peer refuses — a mock that is more permissive than the engine teaches the
caller a contract that does not exist.

`mock-engine`, `mock-playout`, `mock-editor`.
