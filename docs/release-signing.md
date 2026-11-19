# Release signing

Build plan step `11.1` — "Tauri 2 shell on Windows, signed", done when
"Installers produced by CI". GrapiX builds for Windows only (user decisions,
8 and 19 November 2026).

**Status: the CI half is built; the identity is not procured.** The workflow
in `.github/workflows/installers.yml` bundles the Editor as an MSI on
`windows-latest` and uploads the artefact. The signing step in it is
conditional on a secret that does not exist yet, so today it produces an
artefact named `…-UNSIGNED`. A tagged release deliberately **fails** rather
than shipping one.

11.1 cannot be marked done until the identity below is held and a real CI run
has produced a signed installer. (It used to depend on `P.2`, licensing
positions with named owners; that step was removed from the plan on
18 November 2026.)

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

## What is already in place

- `Editor/shell/tauri.conf.json` declares the bundle: identifier
  `com.grapix.editor`, target `msi`, icons, category and description.
- `.github/workflows/installers.yml` builds the web layer, bundles on
  `windows-latest`, records whether the run signed anything, and uploads the
  artefact with the signing state in its name.
- `@tauri-apps/cli` is a declared dev dependency. It previously was not, so
  `npm run editor` and `npm run playout` referenced a `tauri` command that no
  checkout provided.

## What remains

1. Procure the Windows identity above.
2. Add the secret to the repository.
3. Push a `v*` tag and confirm the run produces a **signed** artefact — its
   name will say `signed` rather than `UNSIGNED`.
4. Verify the installer on a clean Windows machine: SmartScreen shows the
   publisher.

Only after (4) is `11.1` done. Until then no claim should be made that GrapiX
ships an installer, because an unsigned installer is not one a user can
reasonably run.
