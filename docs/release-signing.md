# Release signing and notarisation

Build plan step `11.1` — "Tauri 2 shell on both platforms; signed and
notarised", done when "Installers produced by CI".

**Status: the CI half is built; the identities are not procured.** The
workflow in `.github/workflows/installers.yml` bundles on both platforms and
uploads artefacts. Every signing step in it is conditional on a secret that
does not exist yet, so today it produces artefacts named `…-UNSIGNED`. A
tagged release deliberately **fails** rather than shipping one.

11.1 cannot be marked done until the identities below are held and a real CI
run has produced signed installers. Both depend on `P.2` (licensing positions
with named owners), which is an external track.

## What must be procured

### Windows — Authenticode

| | |
|---|---|
| Identity | An OV or EV code-signing certificate from a public CA |
| Held as | A signing command, not a raw certificate — see below |
| Secret | `WINDOWS_SIGN_COMMAND` |
| Blocks | Unsigned MSI trips SmartScreen; users see "unknown publisher" |

Tauri v2 signs Windows artefacts by invoking a command rather than taking a
`.pfx` directly, which is what allows an HSM or a cloud signing service (Azure
Trusted Signing, DigiCert KeyLocker) to be used. **EV certificates are now
required to be issued on hardware**, so a plain `.pfx` in a GitHub secret is
not an option for EV and is a poor idea for OV.

Set `WINDOWS_SIGN_COMMAND` to the full command, with `%1` as the file
placeholder. It must be non-interactive.

### macOS — Developer ID and notarisation

| | |
|---|---|
| Identity | "Developer ID Application" certificate from an Apple Developer Program account |
| Secrets | `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Blocks | Without notarisation, Gatekeeper refuses the app on any machine that did not build it |

Signing alone is not enough on macOS: the `.dmg` must also be **notarised** by
Apple and the ticket stapled. Tauri performs notarisation when `APPLE_ID`,
`APPLE_PASSWORD` and `APPLE_TEAM_ID` are all present.

`APPLE_APP_SPECIFIC_PASSWORD` is generated at appleid.apple.com — it is not
the account password, and the account password will not work.

## What is already in place

- `Editor/shell/tauri.conf.json` declares the bundle: identifier
  `com.grapix.editor`, targets `msi` and `dmg`, icons, category and
  description.
- `.github/workflows/installers.yml` builds the web layer, bundles on
  `windows-latest` and `macos-latest`, imports the Apple identity when present,
  records whether the run signed anything, and uploads the artefacts with the
  signing state in their name.
- `@tauri-apps/cli` is a declared dev dependency. It previously was not, so
  `npm run editor` and `npm run playout` referenced a `tauri` command that no
  checkout provided.

## What remains

1. Procure the two identities above (gated on `P.2`).
2. Add the secrets to the repository.
3. Push a `v*` tag and confirm the run produces **signed** artefacts on both
   legs — the artefact name will say `signed` rather than `UNSIGNED`.
4. Verify the installers on clean machines: SmartScreen on Windows, Gatekeeper
   on a Mac that never built the app.

Only after (4) is `11.1` done. Until then no claim should be made that GrapiX
ships installers, because an unsigned installer is not one a user can
reasonably run.
