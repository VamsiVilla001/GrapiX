# 2.26 The architecture guard covers Playout as it covers the Editor

Done 19 November 2026. `tools/check-boundaries.mjs`, `npm run check:boundaries` (first stage of `npm run check`).

## What the guard now does
- **R1 for Playout:** `Playout/shell/src` is parsed as the Editor's shell is. Its commands must be in the named `PLAYOUT_SHELL_SURFACE` (13: log, connect, status, performance, cue, take, clear, phase, configure output, sign in, sign out, operator, default endpoint); none may take an authoring document or command parameter; `generate_handler!` and the `#[tauri::command]` functions must list the same names (checked per product, so an Editor handler cannot hide a Playout mismatch). An Editor command (`cmd_execute`) is not a Playout command.
- **R4 for the page:** `Playout/web` (plain JavaScript, so `.js` and `.mjs` are read) may invoke only named shell commands, by literal name, with no scene or document in the arguments. `Playout/web/shell-bridge.js` (the correlation bridge) is exempt as `Editor/src/shell-bridge.ts` is. `Playout/web/main.js` declares one `function invoke(command, args)` wrapper; only that function's own body may pass the name on, and no other file may declare one. **The guard found one real gap on the first run:** `transport()` in the page passed a command name through as a parameter; each caller now passes the call that names its command (`(payload) => invoke("cmd_take", payload)`).
- **R9 and R11 read JavaScript:** a comparison with the engine's locality in `Editor/` or `Playout/` `.js`/`.mjs`, and the engine's host:port written in `Editor/`, `Playout/` or `tools/` scripts (`tools/tests/` excepted), are refused as they are in TypeScript. The repository walk now reads those scripts.
- **R10 for other listeners:** `TcpSocket`, a `socket2` path, `UnixListener`, `UnixDatagram`, a named-pipe server (`ServerOptions`, `NamedPipeServer`, `CreateNamedPipe*`) are refused outside the listed bind sites, and a listed site that uses one without asking `check_listen` is refused. The conformance harness stays exempt for scratch sockets.

## Evidence
- `node --test tools/tests/check-boundaries.test.mjs`: 56 pass (was 33): 24 new failing cases, one for each rule above and the exemptions that must stay narrow, a no-false-positive case (Playout's allowed surface, the wrapper, comments, tests paths, conformance) and a test that the walk reads the scripts.
- The real tree passes (`check:boundaries OK`).
- 17 mutants of the guard (each rule's regex, condition and table, the wrapper's file and range, the walk) each failed a named test; the file was restored byte for byte.
- Playout page re-checked in the browser pane with a fake shell after the `transport()` change: Cue, Take and Clear reach the shell by name with the pinned payload.
- Gate: `npm run check` (see the 19 November log).

## Not done
- `socket2` is still a dependency of `Shared/control-transport` (`Cargo.toml`) and is not used in its source; the guard reads source, not manifests, for this rule. Removing the unused dependency is a separate clean-up.
