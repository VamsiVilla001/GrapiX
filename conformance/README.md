# Conformance suite

Defines what a valid peer does. One suite per plane, runnable against a mock or
a real peer (ADR-001 action 3).

No product merges to the branch without passing it (invariant 26). The same
suite must pass at L1 as at L0 — that is the exit criterion for relocation, and
the reason it is written against the contracts rather than against any
implementation.

Reports **SKIP, not PASS**, when a capability is absent (invariant 43). The
point is knowing which half was actually proven.
