# 11.43: Save As, and the first run in the real Editor window (23 Nov 2026)

What this shows: the Start screen, the project's colour depth line, a refused Save As and a
whole Save As, run in the **real Tauri window** (the `gx-editor` shell with its WebView), not in a
browser against a stubbed shell. Until today 11.43 had only been driven in a browser.

## How it was run

- The shell was built as usual, and a **second copy** of the exe was built with the Tauri config
  override `TAURI_CONFIG={"app":{"windows":[{... "additionalBrowserArgs":"--remote-debugging-port=9333 --remote-allow-origins=*"}]}}`.
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` does nothing here: wry (0.55) always sets the browser
  arguments through the WebView2 API, which wins over the variable. The copy was run from a scratch
  folder with its own WebView profile (`WEBVIEW2_USER_DATA_FOLDER`) and its own log folder
  (`GX_LOG_DIR`), so it touched neither the user's WebView profile nor their log root.
- The page was driven through DevTools with `cdp.mjs` (this folder): one short call per step, a
  watchdog, modal dialogs answered, **no operating-system key or click sent**. The workstation was
  on the Windows lock screen the whole time (nothing focused, no window visible on the desktop),
  so no human looked at the window; the screenshots are captures of the page
  (`Page.captureScreenshot`) from the real WebView.
- The native folder picker was answered at the page's IPC fetch (`plugin:dialog|open`), and the
  answer needs the header `Tauri-Response: ok` as well as a JSON body, or Tauri ignores it. The
  picker call itself was recorded: `directory: true`, title "Choose where to save the project".
- The shell wrote `recent-projects.json` into the user's data folder; it did not exist before the
  run, so it was deleted afterwards (its three entries were the test projects).

## What was seen

| Step | Result |
|---|---|
| Launch with no project | Start dialog open and not dismissable; the new **Save as** button disabled; File menu has **Save project as…** (`01-start-screen-real-window.png`) |
| New project `LiveFinals`, 32 bits | Scene Manager line reads `Project LiveFinals · 32 bpc float · sRGB · <path>` (`02-depth-line-32bpc-real-window.png`) |
| **Save to project** of the startup blank scene | **Refused: `sceneColorDepthMismatch`, scene untitled composites at 16 bits but project LiveFinals declares 32.** A real defect in the colour depth work (a new scene was always born at the 16 bit default). Fixed the same day; see below |
| Save as with an unsaved scene that is not stored in the project | Dialog opens with name `LiveFinals copy`, the project's own folder, no depth field, `Save a copy` and `Cancel`, and says `(32 bpc float · sRGB, as LiveFinals). LiveFinals stays as it was last saved.` Submitting refuses `sessionHasUnsavedChanges: session 1 for Untitled has unsaved changes`; the project stays open and **nothing was created on disk** (`03-save-as-dialog-and-refusal.png`) |
| After the fix: new project `LiveFinals2`, 32 bits; **Save to project** | `created LiveFinals2/untitled`; `scenes/untitled.json` has `colorDepth: "32"` (`04-scene-stored-at-32bpc-then-edited.png`) |
| Add a rectangle (unsaved), then Save as `LiveFinals2 v2` | The page reloaded onto the copy: project select `LiveFinals2 v2`, line `Project LiveFinals2 v2 · 32 bpc float · sRGB · <path>`, scene `Untitled r1` listed (`05-after-save-as-copy-open.png`) |
| On disk | Original `LiveFinals2`: `untitled.json` has **0** objects, still has its `.scenes.lock`. Copy `LiveFinals2 v2`: **1** object, revision 1, `LiveFinals2 v2.gpx` names itself, depth 32, no lock file, no `.saving` staging folder left |
| Open the original from the recent list afterwards | Reloaded onto `LiveFinals2`; the log has `editor.project.save_as` once and `editor.project.open` three times |

## The defect the real window found, and the fix

`SceneSource::New` (the startup blank scene, the New button) built the scene with the new-project
default (sRGB, 16 bit) whatever project was open, so in any project that was not 16 bit the first
Save to project was refused. The workspace now remembers what the open project declares
(`Workspace::set_new_scene_settings`, set when a project opens, reset when it closes) and a new
scene is born in it, as `create_scene` already did; an imported SVG takes the project's depth, as a
stored import does (its space is not touched, the import converted its colours into the space it
chose). Test: `a_new_scene_is_born_in_the_open_projects_depth_and_saves_into_it`.

## Not done

- A human has not looked at the window (the screen was locked). The page captures are of the real
  WebView, but window chrome, the native folder picker's own look and keyboard focus were not seen.
- The native folder picker and the right-click menu of the recent list were not exercised.
- Save As copies on the calling thread, so a project with very large media freezes the window
  while it copies, and there is no progress bar.
- Save As closes the open scenes (as a project switch does) and reloads the page onto the copy; it
  does not keep them open. Work that was not saved goes into the copy first.
- Only the scene lock is held during the copy: an asset import or a take page written by another
  process in the same moment is not excluded.
- A link or special file inside a project is refused by name; that path is not tested (creating a
  link on Windows needs a privilege this account does not use).

## The recovery journal decision (Jev and Laya, 23 Nov 2026)

The gate found that the engine stops on a recovery journal written before scene schema 4. Five
options were put to Jev and Laya with the same state (`tools/journal_decision_input.json`,
answers in `jev-laya-journal.json`, run with `tools/journal_decision.py`).

| | Jev (`jev-1.14.0`, probabilities and confidences) | Laya (`laya-multilingual`, 8192, not truncated) |
|---|---|---|
| Best option | **E** 0.69 (A 0.09, B 0.22, C 0, D 0); confidence 0.61 | C 0.89 |
| Silent discard acceptable | 0.12 | 0.98 |
| Re-pinning safe | 0.11 | 0.98 |
| Omitting a defaulted field is sustainable | 0.17 | 0.98 |
| An operator step after an upgrade is acceptable | 0.75 | 0.98 |

Laya answered about 0.98 "yes" to every question, including contradictory ones, so it does not
discriminate on this input; it is a second opinion, not a vote. The decision was made by hand and
matches Jev: **E**, refuse by name by default and discard only on purpose. Built: the journal refuses
a prepared scene written under another scene schema before comparing hashes, and
`gx-render-worker --discard-recovery` moves the journal, its asset store and its drop report aside to
`<name>.discarded-<ms>.bak` and starts empty. Run with the real worker binary on a **copy** of the
operator's real journal: without the flag, exit 1 with the plain message and the files untouched;
with it, the engine listened on its port and the old files were kept as `.bak`.
