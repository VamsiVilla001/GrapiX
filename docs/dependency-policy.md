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

## Approved render dependencies

- **cosmic-text 0.15** (MIT): shapes the package-owned font bytes identically on
  every render node, including OpenType layout and bidi processing. It is the
  only text shaper in the Program path; its font database is populated only
  from scene-packaged faces, never installed system fonts.

- **memmap2 0.9** (MIT/Apache-2.0): owns the platform-specific virtual-memory
  mapping required by the L0 media slot, so the producer and consumer borrow
  the same frame bytes without introducing unsafe code into GrapiX.

- **parking_lot 0.12** (MIT/Apache-2.0): the shared mutex used where a lock is
  held across code that cannot fail. Its guards return directly rather than
  through a poisoning `Result`, so the call site shows locking rather than
  error-handling boilerplate for a failure a `Mutex` cannot produce.

- **interprocess 2.4** (0BSD/Apache-2.0) and **widestring 1.2**
  (MIT/Apache-2.0): the local control-plane transport (5.1). A named pipe on
  Windows and a unix domain socket elsewhere are the same guarantee expressed
  through two unrelated OS APIs, and both need `unsafe` to reach. These crates
  own that platform code so the control plane keeps `#![forbid(unsafe_code)]`,
  and `widestring` is the UTF-16 conversion the Windows pipe security
  descriptor requires. They carry no runtime behaviour of their own: framing,
  sequencing and the bind policy stay in `Shared/control-transport` and
  `Shared/control-plane`, which is what keeps one transport rule rather than
  one per platform (invariant 27).

- **0BSD** is not in the accepted list below because it had not come up
  before. It is a public-domain-equivalent licence with no attribution
  requirement — strictly more permissive than MIT — and is accepted here.

## Accepted licences

Permissive, no copyleft on the distributed application:

- MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, ISC, Zlib,
  Unicode-DFS-2016.

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
