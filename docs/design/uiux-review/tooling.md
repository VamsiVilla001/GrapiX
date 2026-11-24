# Tooling for the UI/UX review agent

Installed: the Humbleteam `design-review` skill (section 5). Nothing else on this page is
installed yet. Every other install or download below needs the user's approval in chat, one tool
at a time, and must follow `docs/dependency-policy.md`. Review-only tools live
under `agent/tmp/uiux-review/tools/`, never in the product's `package.json`.

## 1. Reach the real window without touching the user's

GrapiX runs in WebView2 inside Tauri. Playwright, Chrome DevTools MCP and axe-core all talk to it
over the Chrome DevTools Protocol (CDP). What works on this machine (live-check notes 10 and 11):

1. Build a **second copy** of the shell with a debugging port. `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
   is ignored by wry 0.55, so the port goes in the window config:
   ```bash
   TAURI_CONFIG='{"app":{"windows":[{"title":"GrapiX Editor","width":1440,"height":900,"minWidth":960,"minHeight":600,"resizable":true,"additionalBrowserArgs":"--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9333 --remote-allow-origins=*"}]}}' cargo build -p gx-editor-shell --bin gx-editor
   ```
   Copy the exe aside, then unset `TAURI_CONFIG` (it is a merge patch). Do the same for Playout
   with title `GrapiX Playout` and port 9334.
2. Run your copy with `WEBVIEW2_USER_DATA_FOLDER` and `GX_LOG_DIR` pointing into
   `agent/tmp/uiux-review/<date>/profile/`. Back up `%APPDATA%\GrapiX\GrapiX\data\recent-projects.json`
   first and restore it after.
3. Take your PID from the shell log name (`shell-<time>-<pid>-1.jsonl`). Process listings hang on
   this machine: test with Node `process.kill(pid, 0)` and end with `process.kill(pid)`. Never end
   `gx-editor` by name; the user's own may be running.
4. Open a project through the Start dialog, or open it and then `Page.reload` and wait about 7 s so
   the dock layout applies.
5. Native file pickers: answer `plugin:dialog|open` in the page's `fetch` wrapper with headers
   `Content-Type: application/json` and `Tauri-Response: ok`.
6. A modal `window.prompt` holds the page: enable `Page` events and answer
   `Page.javascriptDialogOpening` with `Page.handleJavaScriptDialog`.
7. If the screen shows the Windows lock screen, no human sees the window: send no input, captures
   through CDP still work.

`docs/evidence/11.43/cdp.mjs` is a ready one-call helper (evaluate a file or capture a PNG, with a
watchdog and dialog handling). Use it when no MCP is installed:

```bash
node docs/evidence/11.43/cdp.mjs 9333 shot agent/tmp/uiux-review/<date>/shots/editor-start-default-1440.png
node docs/evidence/11.43/cdp.mjs 9333 eval agent/tmp/uiux-review/<date>/probe.js
```

Resize for the 1280 / 1440 / 1920 captures with CDP `Emulation.setDeviceMetricsOverride`, not by
moving the OS window.

## 2. Playwright MCP (needs approval)

Attach to the running copy rather than launching a browser:

```bash
claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333
```

Use it for scripted state replays (click a `data-menu-item`, open a panel, select an object) and
screenshots. Prefer selectors on `data-panel`, `data-menu-item`, `data-tool` and ARIA names.

## 3. Chrome DevTools MCP (needs approval)

```bash
claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9333
```

Use it for computed styles, layout boxes, the accessibility tree, console errors, and performance
traces of panel drags and timeline scrubbing.

## 4. axe-core (needs approval)

Fetch `axe.min.js` once into `agent/tmp/uiux-review/tools/` (pin the version in the report), then
for each captured state:

```js
// probe.js, evaluated in the page
(async () => {
  if (!window.axe) { eval(await (await fetch("file:///…/axe.min.js")).text()); }
  const r = await axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"] });
  return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target.join(" ")) }));
})()
```

If `file://` fetches are blocked in the WebView, inject the script text through
`Runtime.evaluate` instead. Keep the JSON per state in `axe/`.

## 5. Review skills (each needs approval and a confirmed source)

| Skill | Use | Notes |
|---|---|---|
| Impeccable | Audit and critique passes on each module's capture and CSS | Discard landing-page, hero or marketing advice. |
| UI/UX Pro Max | UX-guideline, accessibility and dark-UI lookups for a specific finding | Use its guideline search, not its style generator. |
| Humbleteam Design Review | **Installed** (24 Nov 2026, user's command): `git clone https://github.com/humbleteam/design-review .claude/skills/design-review`, commit `e605f4d`, MIT, instructions only (no scripts). Review mode per module capture (0–4 score, at most 6 issues, Before / After / Why with one citation); comparison mode for every before/after pair at re-test | Not for WCAG-only audits; give it the module's job as the project goal. |

These are second opinions. A finding only enters the report with evidence from section 1 to 4.

## 6. Fallback without any install

- `npm run build:web` and open `Editor/web/index.html` in the built-in browser pane for static
  layout and CSS checks. The page says the Tauri bridge is missing, so engine, file and project
  states cannot be reached this way.
- Evidence screenshots under `docs/evidence/*/` show earlier states of the real window; cite them
  as "earlier capture" with their date, never as the current state.
