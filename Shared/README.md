# GrapiX Shared workspace

This is the v0.2 ownership root for application-neutral GrapiX contracts:

- scene and package schemas;
- renderer-control protocol types;
- rundown and transition schemas;
- shared shader/layout contracts;
- the GrapiX JavaScript SDK;
- common deterministic utilities.

Phase 1 provides a compatibility entry point over the existing `packages/*`
modules. Phase 3 moves those packages here while preserving their package names
and compatibility exports.

Shared code may not depend on Editor or Playout. The root
`npm run check:boundaries` gate enforces that direction from the start.
