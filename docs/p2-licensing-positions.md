# P.2 licensing positions — codecs and font embedding

Build plan P.2, scoped by the 2026-09-11 session: the user deferred Adobe/AE
and asked for FFmpeg, video-codec and font-embedding positions now. Each
position has a named owner and a decision that engineering can build against.
This document satisfies the "written position per item" half of P.2's
done-when for these items only; **Adobe/AE remains open**, so P.2 stays
`active` until that position exists too.

Owner for every position below: **the project owner (user)**, recorded
2026-09-11. Escalation: any position can be revisited, but only by editing
this file — never by quietly linking a different build.

---

## 1. FFmpeg — LGPL build only, dynamically linked

**Position: use LGPL-licensed FFmpeg builds, dynamically linked, no GPL
components. Anything GPL-only (`--enable-gpl`, x264, x265, libfdk-aac,
OpenCL kernels compiled in) is prohibited.**

- The engine consumes FFmpeg as a **dynamically loaded library**, never
  statically linked, never vendored in binary form. Dynamic loading preserves
  the LGPL's replacement requirement by construction.
- Distribution includes the FFmpeg licence text and a written offer/notice
  for corresponding source, as LGPL §6 requires. The SBOM (0.4) is where the
  FFmpeg version is recorded per build.
- Decode backends per ADR-0002 A.2: NVDEC via FFmpeg hwaccel on Windows,
  Quick Sync fallback, VideoToolbox on macOS. The `VideoDecoder` trait hides
  the choice; scene logic never sees it.
- If a feature ever needs a GPL-only build (it should not), that is a new
  written position here, not a build flag.

## 2. H.264 — licensed via the OS/hardware royalty path; ship no software encoder

**Position: decode H.264 freely; encode H.264 only through hardware/OS
encoders (NVENC, VideoToolbox, Media Foundation). Ship no x264 and no
software H.264 encoder.**

- MPEG-LA/Access Advance pool obligations for H.264 attach to encoders and
  to distribution of codec software. Hardware and OS-provided encoders are
  already licensed by the platform/vendor royalty; GrapiX rides that and
  ships no codec implementation of its own.
- Decode is required for the video content tier (16.1); encode is required
  for recording and the remote media plane. Both are satisfied by the
  hardware/OS path above.

## 3. HEVC — same posture as H.264, platform-decided

**Position: HEVC decode where the platform provides it (VideoToolbox always;
Windows via the OS HEVC component); HEVC encode via hardware only. No x265,
no software HEVC encoder.**

- HEVC patent terms (Access Advance, MPEG-LA, Velos) are stricter than
  H.264's and are the platform vendor's problem only when we use their
  component. Using an OS/hardware encoder keeps GrapiX out of the pool.
- HEVC is a *negotiated* media-plane codec (`MediaCodec::Hevc`), never a
  required one: a peer without HEVC support falls back to H.264, and that is
  a normal negotiation outcome, not a refusal.

## 4. ProRes — decode yes; encode is Apple's licence, out of scope until licensed

**Position: ProRes *decode* is permitted and expected (broadcast interchange,
macOS-native). ProRes *encode* is not licensed and must not ship until a
written Apple licence position exists here.**

- ProRes encode requires an Apple licence; decode does not (ADR-0002 A.2).
- The engine therefore treats ProRes as **decode-only**. Any recording or
  remote-media encode request for ProRes is refused by name
  (`Refusal::NotImplemented` / a codec-specific refusal), never silently
  re-encoded to something else.
- macOS: use VideoToolbox's ProRes decode. Windows: FFmpeg's ProRes decoder
  (LGPL-safe).

## 5. Font embedding — font links are downloaded into the project

**Position (revised 2026-10-03 by the project owner): ingesting a font link
downloads its font files into the project as hashed assets, and the font
manager generates `@font-face` rules for them in the stylesheet templates
use. This covers Google Fonts, Bunny Fonts and Adobe Fonts
(`use.typekit.net`) links. A `.gpxpkg` carries those bytes.**

This supersedes the 2026-09-11 position, under which linked fonts stayed
references resolved at the render node and Adobe Fonts were never packaged.

- **Adobe Fonts: risk accepted by the owner.** Adobe's terms do not permit
  extracting font files from Adobe Fonts. The owner chose on 2026-10-03 to
  download them anyway and owns that licensing risk. Revisit this before
  any package leaves the owner's own use.
- The font model still carries an `embeddingPolicy` per font (`package`,
  `reference`, `restricted`). A downloaded link font is `package`, and its
  faces keep `originalUrl` and `stylesheetUrl` as provenance.
- Every packaged font records its licence. A downloaded font records the
  licence from its name table. An Adobe Fonts file that names none records
  "Adobe Fonts — packaging accepted by project owner 2026-10-03". Preflight
  still refuses a `package` font with no licence recorded.
- A failed download or an unverifiable file is a named refusal, and no part
  of that link enters the project. Nothing falls back to a reference or a
  system font.
- System-installed fonts are never referenced by anything that reaches air —
  unchanged from A.4, restated here because it is also a licensing position.

---

## What remains open in P.2

- **Adobe / After Effects** — deferred by the user, 2026-09-11. No position
  recorded; P.2 does not close until there is one.
