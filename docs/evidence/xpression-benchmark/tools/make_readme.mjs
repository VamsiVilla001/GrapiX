// Writes docs/evidence/xpression-benchmark/README.md from the hand verdicts and the Jev/Laya answers.
import { readFileSync, writeFileSync } from "node:fs";

const dir = new URL("../", import.meta.url);
const res = JSON.parse(readFileSync(new URL("jev-laya-coverage.json", dir), "utf8"));
const pct = (x) => (typeof x === "number" ? x.toFixed(2) : "?");
const NEW = {
  "file.revert": "11.85", "file.import_project": "11.85", "file.save": "11.30 (Save As built 23 Nov)", "file.export_package": "11.85",
  "file.project_server": "11.57, 11.81", "file.takelist_io": "6.9", "edit.undo_history": "11.82", "edit.transform_tools": "11.44",
  "edit.align": "11.83", "edit.hid": "6.8", "edit.media_setup": "16.18", "edit.keyboard_gpi": "11.84, 6.8", "edit.tessera": "16.20",
  "edit.hardware_setup": "11.87", "edit.preferences": "11.81, 2.28", "windows.menu": "11.33, 11.76", "projects.settings": "7.8, 11.85",
  "projects.reveal": "11.85", "display.project_manager": "11.52", "display.clip_browser": "11.86, 16.18", "display.server_channels": "11.87",
  "display.pbus": "6.8", "display.audio_files": "11.86, 16.17", "tools.flush": "11.58", "tools.debug": "11.58", "tools.input_grabber": "16.19",
  "tools.record": "11.87", "help.topics": "11.88", "data.datalinq": "X4, parked (19.x)", "ctl.external": "6.7", "mos.newsroom": "6.9",
  "text.crawl_roll": "11.90, 11.89", "audio.engine": "16.17", "live.video": "16.19", "tracking.camera": "16.20", "outputs.keyfill": "X2, parked (15.x)",
  "i18n.localisation": "11.91", "template.pages": "11.54, 12.8", "display.widgets": "11.56", "display.stagger": "11.77", "display.object_library": "11.47, 11.40",
  "display.sequencer_list": "12.3", "display.output_monitors": "12.5", "display.take_inspector": "12.8", "edit.scripting": "16.4, 11.55", "seq.rundown": "12.3, 12.8",
  "anim.scene_director": "11.53", "transitions": "16.3",
};
const rows = res.map((r) => {
  const j = r.jev.coverage?.choice, l = r.laya.coverage?.choice;
  return `| ${r.menu} > ${r.label} | ${r.hand.verdict} | ${j} | ${l} | ${pct(r.jev.core_for_broadcast)} | ${pct(r.laya.core_for_broadcast)} | ${(r.hand.rows ?? []).join(", ") || "-"} | ${NEW[r.key] ?? ""} |`;
});
const count = (f) => res.filter(f).length;
const ch = (r, who) => r[who].coverage?.choice;
const text = `# Ross XPression menu benchmark: what GrapiX has and what it lacks (23 Nov 2026)

Source: \`docs/reference/xpression-menu-bar.md\`, the research reference of Ross XPression Studio's menu bar,
which marks what it could not verify. Ross is the benchmark for the basics of a motion graphics
application; AI is left aside. 64 items were matched against the plan rows: every menu entry and panel
the reference shows, plus the XPression workflow it implies (sequencer, as-run log, data links, external
control, MOS, crawl and roll, audio, live video, key and fill, tracking, security, localisation).

## How it was matched

1. **By hand** (the verdict that stands): each item was matched to the plan rows that might cover it,
   with the row's status. Verdicts: **built** (the rows are done or the feature works), **planned** (a row
   covers all of it but it is pending), **partial** (some is built or planned and a named part has no row),
   **missing** (no row, nothing built).
2. **Jev and Laya** were then asked the same typed questions on the same state, without the hand
   verdict: the coverage (those four) and whether the feature is core for a broadcast graphics application
   benchmarked on XPression. Laya is \`laya-multilingual\` at 8192 tokens, not truncated. Inputs and
   answers: \`items.json\`, \`jev-laya-coverage.json\`; tools in \`tools/\`.

| Coverage agrees with the hand verdict | Jev | Laya |
|---|---|---|
| of 64 items | ${count((r) => ch(r, "jev") === r.hand.verdict)} | ${count((r) => ch(r, "laya") === r.hand.verdict)} |

Laya called ${count((r) => ch(r, "laya") === "missing")} of 64 items "missing" and gave "core" a probability above 0.5 for almost
everything, so it is a second opinion and not a vote, as before. Jev agrees with the hand verdict on half
the items; where it differs it mostly says "partial" for something I judged built or planned (it wants
proof that every part works) and "built" for something whose backend exists but whose UI does not
(Export Package, Record Client, PBus); on those the hand verdict stands, for the reasons in the notes
column of \`hand-verdicts.json\`. Where Jev gave "core" under 0.5 (Human Interface Devices 0.36,
Tessera 0.44, Display project path 0.43, Flush 0.39, Debug 0.39, Record Client 0.30, MOS 0.42) the item is
treated as optional or later, not core.

## The table

| XPression item | Hand | Jev | Laya | Jev core | Laya core | Rows that might cover it | Row that builds it now |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## What the benchmark found missing, as core modules

Built or planned already (no new row): the project start and save-as flow, scene and object managers,
materials, inspector, effects, keyframes and the speed graph, preview, the rundown engine, the as-run log,
roles and tokens, diagnostics.

**Added as rows on 23 Nov 2026** (19 from the research, plus 11.91), each in the module it builds, with a
done-when taken from the research in \`research.md\`; all start as pending in \`progress.json\`:

| Row | Module | What |
|---|---|---|
| 2.28 | B2 Platform | Settings service: user, machine and project scopes |
| 6.7 | B7 Playout services | External control interface: station automation over TCP and HTTP |
| 6.8 | B7 | GPI, tally and control-surface input |
| 6.9 | B7 | Rundown import and export, and a MOS device |
| 7.8 | B7 | Project modes and conversion |
| 11.90 | B10 Text engine | Scrolling text objects: crawl and roll |
| 16.17 | B14 Content depth | Audio: objects, playback, output |
| 16.18 | B14 | Clips: media service, thumbnails, codecs and alpha |
| 16.19 | B14 | Live video input as a layer |
| 16.20 | X5 (later, optional) | Camera tracking and virtual studio |
| 11.81 | F1 Editor workspace | Preferences dialog |
| 11.82 | F1 | Undo and redo history panel |
| 11.83 | F1 | Object align, distribute and snapping |
| 11.84 | F1 | Shortcut and control mapping editor |
| 11.85 | F1 | Project commands: Revert, Increment And Save, Import from project, Reveal, Convert Mode, Export Package |
| 11.88 | F1 | In-app help and About |
| 11.91 | F1 | Interface localisation groundwork |
| 11.86 | F2 Authoring panels | Clip Browser and Audio Files panels |
| 11.89 | F2 | Scrolling text controls in the inspector |
| 11.87 | F6 Playout application | Hardware Setup dialog: outputs, key and fill, audio devices, timecode, GPI, tracking |

**Core but parked, for you to decide:** live data connectors (XPression's DataLinq: XML, CSV, Excel,
databases, web) are the parked Data Server (X4), and key and fill outputs, genlock and the video cards
are parked (X2). Both are core for a real broadcast install; they stay parked until you un-park them.

**Optional or later, left as rows or notes:** Human Interface Devices as hardware (reached through 6.7
and Companion first), Tessera and tracking (16.20, parked), MOS profiles beyond 0 to 2 and newsroom
plug-ins, a Flush and cache monitor (11.58), Record Client (11.87).

## The menu bar (row 11.32)

The Editor's menu bar is now built from the reference: **File, Edit, Windows, Projects, Animation,
Display, Tools, Help**, replacing File, Edit, Layer, Window, Help. See \`Editor/src/app-menu.ts\` and the
real-window captures in \`menu-bar/\`. An item with no action is shown disabled and its tooltip names the
row that builds it, so the menu is also the visible to-do list; what moved:

- Layer > New rectangle, ellipse, text and Duplicate moved to **Edit > New Object** and **Edit >
  Duplicate / Rename / Delete** (the reference has no Layer menu; XPression creates objects from the
  Object Toolbar, which Display toggles).
- The old Window list of panels moved to **Display**, which shows and focuses the dockable panels in the
  reference's order; panels XPression has no name for follow under a separator. **Windows** keeps Set main
  viewport as active, Reset layout and the layout rows (11.76).
- Help keeps the diagnostic bundle beside Help Topics (11.88).
- File gained Open Recent (live), Save As, Project Server > Publish, and Exit (refused by name while a
  scene has unsaved work); Close project and New scene stayed under File as GrapiX additions.
- Every item says where it comes from in its tooltip: an XPression screenshot, a guide, an older guide, a
  Ross community post, or a GrapiX addition.
`;
writeFileSync(new URL("README.md", dir), text);
console.log("written", text.length);
