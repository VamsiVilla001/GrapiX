# gx-contract-codegen

Generates `Shared/generated-ts` from the Rust contracts (invariant 22).

Run by `npm run codegen`. CI must fail if the generated output is not identical
to what a fresh run produces — a stale commit is drift wearing a generated
label.
