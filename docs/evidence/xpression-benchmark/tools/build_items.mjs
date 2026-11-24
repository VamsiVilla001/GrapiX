// Builds the typed Jev/Laya inputs for the XPression menu benchmark (23 Nov 2026).
// Each item: an XPression menu entry or panel from Ross_XPression_Menu_Bar_Reference_for_Claude.md,
// the GrapiX plan rows that might cover it (picked by hand), and my own verdict, which is NOT sent to
// the models. Run: node build_items.mjs  -> ../items.json (inputs) and ../hand-verdicts.json
import { readFileSync, writeFileSync } from "node:fs";
import { parsePlan } from "../../../../tools/sync-tracker.mjs";

const here = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const plan = parsePlan(readFileSync(new URL("../../../../GrapiX-Build-Plan.md", import.meta.url), "utf8"));
const status = JSON.parse(readFileSync(new URL("../../../../progress.json", import.meta.url), "utf8"));
const row = (id) => plan.find((r) => r.id === id);
const STATUS = { d: "done", a: "active (partly built)", p: "pending (not started)", b: "blocked" };
const stateOf = (id) => ({ done: "done", active: "active (partly built)", blocked: "blocked", pending: "pending (not started)" })[status[id] ?? "pending"];

// [key, menu, label, what it is in XPression (from the reference), candidate rows, hand verdict, hand note]
const ITEMS = [
  ["file.new", "File", "New project", "Create a new project (Ctrl+Alt+N).", ["11.43"], "built", "Start screen, New project dialog (22 Nov), run in the real window 23 Nov"],
  ["file.open", "File", "Open Project and Open Recent", "Open a project file; a dynamic recent list.", ["11.43"], "built", "Open project and the recent list are built"],
  ["file.revert", "File", "Revert", "Discard changes and reload the last saved state (F9).", ["11.30", "11.43"], "missing", "No row names revert; 11.30 is save only"],
  ["file.import_project", "File", "Import > From Project/File", "Bring scenes and assets from another XPression project into the open one.", ["7.2", "11.43", "11.64"], "missing", "7.2 imports design sources (SVG, Figma), not another GrapiX project's scenes"],
  ["file.save", "File", "Save, Save As, Increment And Save", "Save in place; save under a new name; save as the next numbered version.", ["11.30", "11.43"], "partial", "Save As built 23 Nov; Save in place and Increment And Save are 11.30, pending"],
  ["file.export_package", "File", "Export Package", "Export the project or scenes as a transferable package.", ["1.8", "7.6", "7.7"], "partial", "Package format, build, verify and publish exist (1.8, 7.6); no menu command or dialog"],
  ["file.project_server", "File", "Project Server: Publish, Deploy, Setup", "Publish a project to a project server and deploy it to playout machines; configure the server.", ["6.1", "7.6", "5.10", "12.2"], "partial", "Published library, publish by route and Playout library exist; no deploy to several Playout machines, no server setup UI"],
  ["file.exit", "File", "Exit", "Quit the application.", [], "built", "Window close; the shell exits in order (2.16)"],
  ["file.takelist_io", "File (Sequence)", "Take Item List: import and export XML, Insert Take Item", "Import and export the rundown as XML; insert a take item.", ["6.4", "12.3", "11.57"], "partial", "Rundown and take list are planned (6.4 done, 12.3 pending); no import or export format"],
  ["edit.undo", "Edit", "Undo, Redo", "Undo and redo (Ctrl+Z, Ctrl+Shift+Z).", ["11.37"], "built", "Command-log undo and redo are done"],
  ["edit.undo_history", "Edit", "Undo/Redo History", "A list of undoable steps to jump back to.", ["11.37", "11.35"], "missing", "The log exists in the command model; no history panel or menu"],
  ["edit.transform_tools", "Edit", "Select, Move, Rotate, Scale, Pivot tools", "Mode tools with Ctrl+Q/W/E/R/T.", ["11.7", "11.44"], "partial", "Selection and creation tools exist; move, rotate, scale and pivot gizmos are 11.44, pending"],
  ["edit.align", "Edit", "Object Align", "Align and distribute selected objects.", ["11.44", "11.45", "11.9"], "missing", "No row for align, distribute or snapping"],
  ["edit.hid", "Edit", "Human Interface Devices", "Set up control surfaces, joysticks and other input devices.", ["11.31"], "missing", "No row for physical control devices"],
  ["edit.scripting", "Edit", "Scripting", "Scripts and events attached to scenes.", ["16.4", "11.55", "16.14", "16.15"], "planned", "Script sandbox, logic, After Effects scripts and ScriptUI panels are all pending"],
  ["edit.media_setup", "Edit", "OpenMAM Setup and Clip Store Setup", "Connect to a media asset manager and a clip store (video server).", ["16.1", "11.52", "11.49"], "missing", "Video decode and a video layer are planned; no media server or MAM connection"],
  ["edit.keyboard_gpi", "Edit", "Keyboard / GPI Mapping", "Map keys and GPI inputs to commands.", ["11.31", "6.6", "11.30"], "partial", "One command registry is planned (11.31); no mapping UI, no GPI; automation triggers are deferred (6.6)"],
  ["edit.tessera", "Edit", "Tessera (camera tracking, virtual studio)", "Tracked-camera and virtual set engine.", ["3.7", "11.48", "16.8"], "missing", "3D cameras exist; no tracking data input and no virtual set"],
  ["edit.hardware_setup", "Edit", "Hardware Setup", "Video inputs and outputs, audio devices, timecode I/O, preview and monitor, GPI/tally boards, camera tracking, server channels.", ["6.5", "12.7", "15.1", "15.2", "15.4", "15.5"], "partial", "Output configuration and status exist; hardware I/O, timecode, GPI and tally are parked (X2)"],
  ["edit.preferences", "Edit", "Preferences", "A settings dialog: editor, renderer, viewports, folders, caches, sequencer, fonts, remote server, RossTalk, log level, localisation.", ["11.43", "2.4", "2.8"], "missing", "No settings dialog or settings store"],
  ["windows.menu", "Windows", "Windows menu, docking layouts", "Make a window active; saved and recalled docking layouts.", ["11.33", "11.5", "11.76", "11.75"], "partial", "Dockable workspace done; Window menu lists panels; saved layouts and named workspaces pending"],
  ["projects.settings", "Projects", "Convert Project Mode and project settings", "Change the project's mode (resolution, frame rate family, SD or HD).", ["11.43", "3.15", "1.1"], "partial", "Colour space and bit depth are project settings; resolution and frame rate are per scene"],
  ["projects.reveal", "Projects", "Display project path in Explorer", "Open the project's folder in Windows Explorer.", ["11.43"], "missing", "Small, no row"],
  ["anim.controller", "Animation", "Animation Controller, Set Keyframe", "Per-object animation controllers and keyframing.", ["11.20", "11.21", "11.68"], "built", "Editable animation contract and keyframes are done"],
  ["anim.scene_director", "Animation", "Scene Director", "Timeline of the scene's animations, events and stop points.", ["11.25", "11.53", "11.10"], "partial", "Timeline and named phases done; stop points and looping hold (11.53) pending"],
  ["anim.key_graph", "Animation", "Key Graph Editor", "Edit curves between keys.", ["11.11", "11.23", "11.78"], "built", "Speed graph and curve editing done; infinity modes (11.78) pending"],
  ["display.project_manager", "Display", "Project Manager panel", "Browse the project's scenes and media folders.", ["11.43", "11.52", "11.64"], "partial", "Start screen and Scene Manager; asset manager (11.52) pending"],
  ["display.scene_manager", "Display", "Scene Manager panel", "List, search and manage scenes.", ["11.64", "11.72"], "built", "Scene Manager done; dense list active"],
  ["display.object_manager", "Display", "Object Manager panel", "Scene object tree.", ["11.8", "11.45"], "built", "Treegrid done; command-model parenting pending"],
  ["display.material_manager", "Display", "Material Manager panel", "Materials and textures.", ["11.12", "11.50"], "built", "Material manager done"],
  ["display.inspector", "Display", "Object Inspector panel", "Properties of the selection.", ["11.9", "11.46"], "built", "Type-aware inspector done"],
  ["display.widgets", "Display", "Widgets panel", "Ready-made objects such as clocks, counters and timers.", ["11.56"], "planned", "Widgets row pending"],
  ["display.stagger", "Display", "Stagger Animations", "Offset the animations of several objects by a step.", ["11.77"], "planned", "Pending"],
  ["display.effects", "Display", "Effects panel", "Browse and apply effects.", ["11.69", "11.70", "11.79", "3.25"], "built", "Effects & Presets and Effect Controls are active with 46 effects"],
  ["display.clip_browser", "Display", "Clip Browser", "Browse video and audio clips; cue a clip on a server channel.", ["11.49", "16.1", "11.52"], "missing", "Video layer and decoder are planned; no clip browser panel or clip cueing"],
  ["display.server_channels", "Display", "Server Channels", "Video server channels clips play on.", ["15.2", "15.3", "6.5"], "missing", "Hardware and server channels are parked"],
  ["display.pbus", "Display", "PBus Mapping", "Map an external parameter bus (control surfaces, data) to object properties.", ["11.19", "11.26", "11.54"], "partial", "Data bindings and template controls exist; no external parameter mapping"],
  ["display.object_library", "Display", "Object Library", "A library of reusable objects and scenes.", ["11.47", "11.48", "11.40", "6.1"], "planned", "2D and 3D libraries and a component registry are pending"],
  ["display.audio_files", "Display", "Audio Files", "Audio clips used by scenes and sequences.", ["11.43", "3.25"], "missing", "An Assets/Audio folder exists; no audio object, playback or mixing in any row"],
  ["display.sequencer_list", "Display", "Sequencer List", "The rundown of take items.", ["6.4", "12.3"], "planned", "Rundown persistence done; the Playout take list is pending"],
  ["display.output_monitors", "Display", "Output Monitors", "Monitors of program, preview, fill and key.", ["12.5", "11.65", "3.11"], "planned", "Confidence monitors pending; engine preview monitor in the Editor active"],
  ["display.online_preview", "Display", "Online Preview", "Preview what is on or going to air.", ["11.65", "3.21", "8.9"], "built", "Engine preview monitor active"],
  ["display.take_inspector", "Display", "Take Inspector", "Inspect and edit the selected take item's values.", ["12.3", "12.8", "11.27"], "planned", "Operator fill form pending"],
  ["display.object_toolbar", "Display", "Object Toolbar", "Create objects.", ["11.32", "11.7"], "built", "Layer creation tools in the Editor"],
  ["display.status_log", "Display", "Status Log", "Application log.", ["2.11", "2.27", "11.74"], "built", "Activity log, JSON log and live telemetry"],
  ["tools.flush", "Tools", "Advanced > Flush", "Flush caches.", ["11.58", "2.27"], "missing", "No row for cache control"],
  ["tools.debug", "Tools", "Debug > Video Cache Monitor", "Diagnostic monitors.", ["11.58", "2.27", "2.14"], "partial", "Diagnostics bundle and telemetry done; console and debugger pending"],
  ["tools.input_grabber", "Tools", "Input Grabber", "Capture a live video input into the scene.", ["15.2", "15.4", "11.49"], "missing", "No live video input row; hardware parked"],
  ["tools.record", "Tools", "Record Client", "Record the program output to a file.", ["3.10", "14.5"], "partial", "Recording output adapter exists in the engine; no operator command or UI"],
  ["help.topics", "Help", "Help Topics", "Open the manual.", ["2.14"], "missing", "Only a diagnostic bundle in Help; no in-app help"],
  // Not in the menu bar but part of the XPression workflow the benchmark implies:
  ["seq.rundown", "Sequence", "Sequencer: ordered take items, cue, take, out, run order", "The operator's rundown.", ["6.4", "12.3", "12.4", "12.8", "12.9"], "planned", "Engine side done; Playout UI pending"],
  ["seq.asrun", "Sequence", "As-run log", "A record of what went to air and when.", ["12.11"], "built", "Active; recorded"],
  ["data.datalinq", "Data", "DataLinq: live data from XML, CSV, Excel, databases and web", "Scenes bound to external data that updates live.", ["11.19", "19.2", "19.4", "19.5", "19.6", "19.8"], "partial", "Bindings exist; every connector is parked in the Data Server (X4)"],
  ["ctl.external", "Control", "External control protocol (RossTalk), automation, GPI and tally", "A text protocol and contact closures for automation to cue and take.", ["6.6", "8.11", "2.23"], "missing", "Automation trigger evaluation is explicitly deferred (6.6); the MCP surface is for agents, not station automation"],
  ["mos.newsroom", "Integration", "MOS newsroom integration", "Rundown and story data from a newsroom system.", ["6.4", "12.3"], "missing", "No row"],
  ["text.crawl_roll", "Objects", "Crawl and roll (ticker, credits)", "Scrolling text objects: tickers and end-credit rolls.", ["11.51", "11.55", "12.10"], "missing", "No scrolling text object in any row"],
  ["live.video", "Objects", "Live video in a scene (camera feeds, picture in picture)", "A live video input as a layer.", ["11.49", "16.1", "15.4"], "missing", "Video file layer planned; live input not"],
  ["audio.engine", "Audio", "Audio: sound with graphics, levels, output", "Audio cues played with a graphic.", ["11.43"], "missing", "No row"],
  ["outputs.keyfill", "Outputs", "Key and fill video outputs, genlock, multiple channels", "Fill and key to a switcher, locked to the facility reference.", ["12.5", "12.10", "15.2", "15.4", "15.5"], "planned", "Parked (X2); overlay channels active (12.10)"],
  ["tracking.camera", "Virtual", "Camera tracking and virtual studio", "Tracked cameras drive 3D scenes.", ["3.7", "16.8"], "missing", "No row; 3D camera parity is planned"],
  ["roles.security", "Security", "Operator roles and permissions", "Who may edit and who may take.", ["2.9", "2.15", "5.7"], "built", "Tokens, roles and scopes; named operator login active"],
  ["i18n.localisation", "Preferences", "Localisation and language", "Interface language.", ["11.42", "1.1"], "missing", "No row"],
  ["template.pages", "Sequence", "Template pages for operators (fill fields, constraints)", "Operator fills a template's declared fields.", ["11.26", "11.54", "12.8"], "partial", "Field contract done; constraints and the fill form pending"],
  ["transitions", "Animation", "Scene transitions and transition effects", "Transitions between scenes or takes.", ["16.3", "11.55"], "planned", "Pending"],
];

const QUESTIONS = {
  coverage: {
    type: "choice",
    instructions: "How well does GrapiX cover this Ross XPression feature, going only by the plan rows given?",
    criteria: {
      built: "Built: the rows that cover it are done or already working, so the feature exists.",
      planned: "Planned: there is a row for all of it but it has not been built (pending).",
      partial: "Partial: some of it is built or planned, but a named part of the feature has no row or is not built.",
      missing: "Missing: no row covers it and it does not exist.",
    },
  },
  core_for_broadcast: {
    type: "noul",
    instructions: "Is this feature core for a broadcast motion graphics application that uses Ross XPression as its benchmark (leaving AI features aside)?",
    criteria: {
      true: "Yes: a broadcast graphics operator or designer will expect it, and the application is not a credible alternative without it.",
      false: "No: it is optional, rare, vendor-specific or a convenience.",
    },
  },
};

const inputs = ITEMS.map(([key, menu, label, what, rows, verdict, note]) => ({
  key, menu, label, hand: { verdict, note },
  state: {
    xpression_feature: `${menu} > ${label}`,
    what_it_is: what,
    grapix_rows_that_might_cover_it: rows.length === 0 ? "(none)" : rows.map((id) => {
      const r = row(id);
      return r ? { id, name: r.name, status: stateOf(id), done_when: r.done.slice(0, 220) } : { id, name: "(no such row)" };
    }),
    note: "GrapiX is a Windows broadcast motion graphics application: an Editor (authoring) and Playout (operator) over a GPU render engine. Judge only by the rows given; a row that is pending is planned, not built.",
  },
}));
writeFileSync(new URL("../items.json", import.meta.url), JSON.stringify({ questions: QUESTIONS, items: inputs.map(({ hand, ...rest }) => rest) }, null, 1));
writeFileSync(new URL("../hand-verdicts.json", import.meta.url), JSON.stringify(Object.fromEntries(inputs.map((i) => [i.key, { label: i.label, menu: i.menu, ...i.hand, rows: ITEMS.find((x) => x[0] === i.key)[4] }])), null, 1));
console.log(`${inputs.length} items`);
const counts = {};
for (const i of inputs) counts[i.hand.verdict] = (counts[i.hand.verdict] ?? 0) + 1;
console.log(counts);
