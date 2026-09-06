# GrapiX Font Manager

> How fonts are ingested, validated, loaded and rendered. Read from the code on
> 2026-08-09, not from `memory.md`.

Fonts cross all three runtimes, and each one has a different job:

```text
project-api   resolve → validate → store as content-hashed assets   (the only thing that touches the network)
editor-web    register faces with FontFace, report per-face state   (never fetches a remote stylesheet)
render-engine shape and composite with cosmic-text                  (no I/O at all)
```

The rule that shapes the whole design: **only the API talks to the internet.**
A remote stylesheet is resolved *once*, server-side, into real packaged font
bytes. Neither the browser nor the native renderer ever executes remote CSS.

## The contract

All font types live in [`Shared/shared-types/src/index.ts`](../Shared/shared-types/src/index.ts).

`FontSource` (L721) is a four-way union:

| Kind | Carries | Meaning |
| --- | --- | --- |
| `file` | `assetId`, `format`, `originalUrl?`, `stylesheetUrl?` | Packaged bytes. The only kind that renders. |
| `css-url` | `url`, `integrity?` | Unresolved stylesheet reference |
| `adobe-fonts` | `projectId`, `url` | Typekit project |
| `direct-url` | `url`, `format?` | Unresolved font file |

`FontLoadStatus` (L747) has seven states — `LOADING`, `READY`, `MISSING`,
`INVALID`, `UNSUPPORTED`, `UNVERIFIED`, `ERROR`. `UNVERIFIED` is the one that
matters: it means a source is still a reference, not bytes.

`FontDefinition` (L768) is a family — `faces[]`, `fallbackFamilies[]`,
`embeddingPolicy` (`package` | `reference` | `restricted`), `license?`,
`enabled?`, `status`. `FontFaceDefinition` (L756) is one face: `weight`,
`style`, optional `stretch` and `unicodeRange`.

Scenes carry `fonts?: FontDefinition[]`, validated by `validateFontDefinition`
(L3818) as part of scene validation.

## Ingest — three routes

All in [`Editor/services/project-api/src/index.ts`](../Editor/services/project-api/src/index.ts):

- **`POST /api/fonts/import`** (L523) — upload OTF/TTF/WOFF/WOFF2. Becomes a
  `file` source with `embeddingPolicy: "package"` and status `READY`.
- **`POST /api/fonts/link`** (L562) — record a reference without fetching it.
  `embeddingPolicy: "reference"`, status `UNVERIFIED`.
- **`POST /api/fonts/resolve`** (L576) — the real workhorse. Fetches, parses,
  downloads every face, and converts a reference into packaged assets.

Identity is content-derived, so re-importing the same file is idempotent:
`fontId = font_${sha256(...).slice(0,16)}`, `faceId` hashed from
family + weight + style + checksum.

[`fontManager.ts`](../Editor/services/project-api/src/fontManager.ts) enforces
the cheap invariants — family 1–128 chars, weight an integer 1–1000, at most 8
fallback families, Adobe project IDs matching `^[a-z0-9]{3,32}$` and
canonicalised to `https://use.typekit.net/{id}.css`.

## Resolution and its guard rails

[`fonts/remoteFontResolver.ts`](../Editor/services/project-api/src/fonts/remoteFontResolver.ts)
is the only code that fetches. It is written defensively:

- **Host allowlist** — `isTrustedFontCssUrl` (shared-types L3917) permits only
  `use.typekit.net`, `fonts.googleapis.com`, `fonts.bunny.net`, over HTTPS,
  with no embedded credentials.
- **SSRF guard** — `assertPublicHttpsUrl` re-checks *every* hop, resolves DNS,
  and rejects loopback, link-local, ULA and every RFC 1918 range, including
  IPv4-mapped IPv6. Redirects are followed manually, capped at 4.
- **Bounded work** — CSS ≤ 1 MiB, font ≤ 30 MiB, `@import` depth ≤ 3, ≤ 64
  faces per stylesheet, 12 s timeout.
- **Format is sniffed, not trusted** — extension, then content-type, then magic
  bytes (`wOF2`, `wOFF`, `OTTO`, `0x00010000`/`true`).
- **Partial success is allowed** — a face that fails to download becomes a
  warning; the rest still resolve.

`woff2 > woff > otf > ttf` decides which `src:` entry to pull. Faces are
deduplicated on `weight:style:stretch:unicodeRange`.

Stylesheet parsing is inert: [`cssFontParser.ts`](../Editor/services/project-api/src/fonts/cssFontParser.ts)
reads `@font-face` and `@import` rules as text and never evaluates anything.

## Browser loading

[`ProjectFontRegistry.ts`](../Editor/apps/editor-web/src/fonts/ProjectFontRegistry.ts)
is a singleton — *"the one browser-side font loading authority."* It is an
external store; components subscribe through `useSyncExternalStore`, and
[`useSceneFonts.ts`](../Editor/apps/editor-web/src/hooks/useSceneFonts.ts) drives
it from `scene.fonts` and `scene.assets`.

`sync()` does the work:

1. A generation counter invalidates in-flight loads when the scene changes.
2. Faces no longer active are removed from `document.fonts`.
3. Non-`file` sources are **not fetched** — they resolve to `UNVERIFIED` with a
   message telling the user to resolve the source again.
4. Each `file` face is fetched, wrapped in `FontFace(family, bytes, …)` with
   `display: "block"`, loaded, then added to `document.fonts`.
5. A signature of `url:checksum:weight:style:stretch` decides re-registration,
   so an unchanged face is never reloaded.
6. After `document.fonts.ready`, the revision bumps and a `grapix-fonts-ready`
   event fires so the viewport re-renders against real metrics.

Measurement happens only after loading completes — that is what stops text
being laid out against a fallback and then silently shifting.

Per-family status is the *strongest* failure among its faces, in the order
`MISSING > INVALID > UNSUPPORTED > UNVERIFIED > ERROR`.

## Native rendering

[`services/render-daemon/src/renderer/text.rs`](../services/render-daemon/src/renderer/text.rs)
uses **cosmic-text** for Unicode bidi, script itemization, OpenType shaping,
combining marks, emoji clusters and system fallback.

Its header states the boundary plainly: *"Project font bytes are supplied by
`PreparedScene`; this module performs no I/O."* That is what keeps it legal on
the render thread.

`sync_fonts` is keyed on `scene.revision`, so animated text does not reload font
files every frame. Note that when the revision *does* change, the whole
`FontSystem` and `SwashCache` are rebuilt — correct, but not cheap on
font-heavy scenes.

## Packaging

[`packageBuilder.ts`](../Editor/services/project-api/src/packageBuilder.ts)
writes `fonts.json` when a scene has fonts, and font assets land under `fonts/`
in the `.gfxpkg`. Because resolution has already turned references into `file`
sources, a packaged scene plays out with no network access.

## Map

| Concern | File |
| --- | --- |
| Types, validation, allowlist, CSS helpers | `Shared/shared-types/src/index.ts` |
| Routes | `Editor/services/project-api/src/index.ts` |
| Definition construction | `Editor/services/project-api/src/fontManager.ts` |
| Fetch, SSRF guard, format sniffing | `.../src/fonts/remoteFontResolver.ts` |
| Inert CSS parsing | `.../src/fonts/cssFontParser.ts` |
| File inspection | `.../src/fonts/fontMetadata.ts` |
| Browser loading authority | `Editor/apps/editor-web/src/fonts/ProjectFontRegistry.ts` |
| Scene binding hook | `.../src/hooks/useSceneFonts.ts` |
| Panel UI | `.../src/components/FontManagerPanel.tsx` |
| Text object controls | `.../src/components/TextFontControls.tsx` |
| Native shaping | `services/render-daemon/src/renderer/text.rs` |
| Packaging | `Editor/services/project-api/src/packageBuilder.ts` |
| Tests | `Shared/shared-types/tests/font-system.test.mjs`, `Editor/services/project-api/tests/fontCssParser.test.mjs`, `.../fontAutomation.test.mjs` |
