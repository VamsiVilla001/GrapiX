# Dependency and licence policy

Build plan 0.4. This is the standing position on what may enter the
dependency tree and on what licence terms. It is enforced two ways: the SBOM
generated on every CI build (`.github/workflows/check.yml`) makes the tree
inspectable, and this document is the rule a reviewer applies to it.

## The rule

1. **The SBOM is the source of truth.** Every build produces `sbom-rust.json`
   (SPDX) and `sbom-npm.json` (CycloneDX) as CI artifacts. A dependency that is
   not in the SBOM does not exist; one that appears there is subject to this
   policy.
2. **New dependencies are a decision, not an accident.** Adding one requires a
   reason in the commit message and a licence that passes § "Accepted
   licences". Vendoring a crate to avoid a decision is still a decision.
3. **One lockfile per ecosystem.** `Cargo.lock` and `package-lock.json` are
   committed. Version pinning is enforced by the lockfiles, not by convention
   (ADR-003).

## Accepted licences

Permissive, no copyleft on the distributed application:

- MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-DFS-2016.

## Requires a written position before use

These are not blanket-rejected, but each needs a named owner and a written
decision (the same class of gate as the Adobe and codec decisions in ADR-0002
Part A.2). The decision lives with Phase P.2.

- **LGPL** (e.g. FFmpeg) — linking and distribution terms matter; a GPL-build
  of FFmpeg is likely incompatible with distribution.
- **GPL / AGPL** — presumed incompatible with shipping the application; using
  one is an explicit, documented exception.
- **Patent-pool codecs** (H.264, HEVC) and **ProRes encode** (Apple licence) —
  obligations exist regardless of the code licence.
- **Font embedding / redistribution** — packaging a font into a `.gpxpkg` is
  redistribution; Adobe Fonts terms generally forbid extracting files at all.

## Prohibited without exception

- Any dependency with no licence, or a licence that cannot be identified from
  the SBOM.
- Any dependency that phones home, collects telemetry, or executes
  network-fetched code at build or run time without an explicit, reviewed
  reason.

## Review cadence

The SBOM diff is reviewed on every dependency change. When the licence policy
versions, the override log and the dependency list are reviewed together, the
same discipline the design system applies to its own overrides.
