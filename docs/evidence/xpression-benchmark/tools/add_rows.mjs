// Adds the rows the XPression benchmark found missing (23 Nov 2026) to GrapiX-Build-Plan.md, each in the
// module it builds, and rewrites rows 11.32 and 11.33 for the menu bar built from the reference.
// Run once from the repository root: node docs/evidence/xpression-benchmark/tools/add_rows.mjs
import { readFileSync, writeFileSync } from "node:fs";

const PLAN = "GrapiX-Build-Plan.md";
let md = readFileSync(PLAN, "utf8");
const nl = md.includes("\r\n") ? "\r\n" : "\n";
const R = "Research: docs/evidence/xpression-benchmark/research.md.";

// [after this row, [id, name, track, needs, done]]
const ADD = [
  ["2.26", [
    ["2.28", "Settings service: user, machine and project scopes", "PLAT", "2.1, 2.4, 2.6",
      `One typed settings store with three scopes: per user (language, theme, layout, shortcuts, last-used paths, confirmations), per machine (GPU adapter, caches, ports, server credentials, outputs) and per project (everything that changes rendered output stays in the \`.gpx\`, never in settings). Defaults, a schema version, an atomic write (2.1), change events, a named refusal for an unknown or out-of-range value, a reset to defaults, and a backup copy kept on each change. The Editor and Playout read settings from here and from nowhere else. ${R}`],
  ]],
  ["12.11", [
    ["6.7", "External control interface: station automation over TCP and HTTP", "BE", "5.7, 6.2, 2.21, 2.23",
      `A line-based TCP command port and an HTTP mirror of the same verbs: load, cue, take, out, clear layer, clear all, update field, run sequence item, next, previous. Every command gets a coded acknowledgement (2xx accepted, 4xx the caller's fault, 5xx the engine's) with an optional request id; layer and state events are pushed to subscribers (this is the tally feed); a documented RossTalk-compatible subset (CUE, TAKE, SWAP, CLRA, GPI n, NEXT) so Ross-trained automation works unchanged. Off or loopback by default, a credential, a role per connection (view, cue, take) checked by the 5.7 scopes, every take on the as-run record (12.11) with who, source and time, and one controller at a time by lock. Replaces the deferral in 6.6 for station automation; the MCP surface stays the agents' route. ${R}`],
    ["6.8", "GPI, tally and control-surface input", "BE", "6.7, 11.31",
      `GPI inputs (first over the network as \`GPI n\` on 6.7, later contact-closure boards) mapped by the user to registry commands (11.31) with a debounce in milliseconds, tally out for on-air and layer state, and control surfaces (Stream Deck through Bitfocus Companion over 6.7, keyboards, MIDI later) reaching the same commands. A parameter-mapping table binds an external value to an object or control property (the XPression PBus idea) through the template contract (11.26). Physical boards, serial and MIDI can wait. ${R}`],
    ["6.9", "Rundown import and export, and a MOS device", "BE", "6.4, 12.3",
      `The Playout rundown imports and exports as XML and CSV (also the backup of a sequence). A MOS device implements Profiles 0, 1 and 2 of MOS 2.8.5 (heartbeat, machine info, mosObj and mosAck, running-order create, replace, delete, element action and status, ready to air) over TCP on 10540, 10541 and 10542, maps each running-order item to a take item, and reports status back; a message it cannot map is a NACK with the reason. Profiles 3 to 7 and newsroom plug-ins (ENPS, iNews) can wait. ${R}`],
    ["7.8", "Project modes and conversion", "BE", "7.1, 3.15, 11.43",
      `A project declares its mode: raster, pixel aspect, frame-rate family with a drop-frame flag, progressive or interlaced with field order, safe areas, colour space and bit depth (3.15), chosen from presets and custom presets. Convert Project Mode makes a new project from the old: all scenes, objects, assets and keys kept, rescaling by an explicit option (none, fit, stretch), a frame-rate change reported as a timing shift, the source never overwritten. Convert semantics in XPression were not verifiable and are our decision. ${R}`],
  ]],
  ["11.51", [
    ["11.90", "Scrolling text objects: crawl and roll", "BE", "3.6, 3.8, 11.51, 11.26",
      `A crawl object (horizontal) and a roll object (vertical, credits): speed in pixels per second, direction, separator and gap, loop or stop at the end, alignment per group, start populated or offscreen. Items come from a list that can be updated on air without a jump (add, remove or replace items not yet visible; a visible item is never reflowed); start, stop with deceleration, resume and live speed change are operator commands. The position is a pure function of the engine frame counter, so it is exact at 50 and 59.94 and never accumulates wall-clock deltas; scrolling is smooth to a sub-pixel with no per-frame text layout. A feed (file, JSON, RSS polled into a list with a last-good fallback) is a separate list model. ${R}`],
  ]],
  ["16.9", [
    ["16.17", "Audio: audio objects, playback and output", "BE", "3.8, 16.1, 11.43",
      `Audio is part of a scene: WAV 48 kHz PCM files and the audio of video clips, an audio cue triggered with a graphic and locked to the engine clock, gain in dB, fade in and out, loop, a channel map to a 2 or 8 channel embedded bus, a peak meter per cue, everything resampled to 48 kHz at import, and an output delay offset in frames. Mixing, loudness and routing stay with the production audio desk. MP3 and AAC, surround, EQ and ducking can wait. ${R}`],
    ["16.18", "Clips: media service, thumbnails, codecs and alpha", "BE", "11.49, 16.1, 2.7",
      `A media service for the project's video and audio: thumbnails and a hover flipbook over a checkerboard, duration, codec, alpha, in and out points, loop, hold-last-frame and premultiplied flags, search by name, duration and date, cue and play on a layer, and a transcode to a playout-friendly cache. Codecs ProRes 4444, HAP and HAP Alpha, H.264, DNxHR and PNG sequences (priority is a judgement). Media asset managers and multi-server sync can wait. ${R}`],
    ["16.19", "Live video input as a layer", "BE", "16.1, 3.8, 15.4",
      `One live input (NDI first, SDI with the hardware in 15.x) as a layer texture: a fixed-latency buffer set in frames, a genlock or free-run flag shown on the status surface, embedded audio passed through or muted, and picture in picture as a transformed live layer. Several inputs and low-latency compositing can wait. ${R}`],
  ]],
  ["16.13", [
    ["16.20", "Camera tracking and virtual studio", "BE", "3.7, 16.8, 16.19",
      `Later, optional. FreeD over UDP (and serial if feasible) into the scene's 3D camera: position, rotation and field of view from a manual lens table, a manual delay in frames, a tracking monitor showing the rate and dropped packets, a per-parameter disable or override, fill and key output, and a manual camera as the fallback. The FreeD scaling differs between sources and must be checked against hardware. Stype, Mo-Sys, Trackmen and Ncam drivers, OpenTrackIO, lens distortion files and timecode sync follow. ${R}`],
  ]],
  ["11.80", [
    ["11.81", "Preferences dialog", "UI", "2.28, 11.31",
      `Edit > Preferences opens one dialog over the settings service (2.28): Editor (startup, delete confirmations, default animation length and keyframe interpolation), GPU adapter and anti-alias, path and asset folders, import defaults, cache limits, process priority, fonts, language, log level, the control server's address and credential, and a reset to defaults. A change applies at once or says it needs a restart. Which scope a setting lives in is shown. ${R}`],
    ["11.82", "Undo and redo history panel", "UI", "11.37, 11.31",
      `Edit > Undo/Redo History lists the steps of the command log; clicking one rolls the scene back or forward to it as one undoable move; entries name the module that made them (11.37). The same list serves the menu, the toolbar and the shortcut. ${R}`],
    ["11.83", "Object align, distribute and snapping", "UI", "11.44, 11.45",
      `Align (edges and centres) and distribute (horizontal and vertical) selected objects as one undoable command; snap to the grid, guides and object edges and centres with a toggle and a hold-key bypass; multi-select move, scale and rotate about a shared pivot. ${R}`],
    ["11.84", "Shortcut and control mapping editor", "UI", "11.31, 6.8",
      `Edit > Keyboard / GPI Mapping edits which key, GPI input or external control triggers which registry command (11.31); conflicts are shown, a shortcut is the one handler for its menu item, and every menu item shows the key it has. Mappings are per-user settings (2.28) and can be reset. ${R}`],
    ["11.85", "Project commands: Revert, Increment And Save, Import from project, Reveal, Convert Mode, Export Package", "UI", "11.30, 11.43, 7.8, 1.8",
      `File > Revert to the last saved state, after a confirm; File > Increment And Save writes name_0001 beside the project; File > Import > From Project/File brings scenes and assets from another project with the options copy resources, use existing fonts and keep folder structure; File > Export Package builds a package (1.8) with scenes, assets and fonts; Projects > Display project path in Explorer; Projects > Convert Project Mode over 7.8. Every one refuses by name with unsaved work in the way. ${R}`],
    ["11.88", "In-app help and About", "UI", "11.32",
      `Help > Help Topics and F1 open local, offline documentation (studios are often air-gapped), with a searchable shortcut sheet; About shows the version, build hash, licence and a shortcut to the log folder. ${R}`],
  ]],
  ["11.58", [
    ["11.86", "Clip Browser and Audio Files panels", "UI", "16.17, 16.18, 11.52",
      `Display > Clip Browser lists the project's video clips as a thumbnail grid and list (duration, codec, alpha, in and out, loop, hold-last-frame, premultiplied, search) with a hover flipbook over a checkerboard, and cues one on a layer; Display > Audio Files lists the audio with gain, fade, loop and a level meter. ${R}`],
    ["11.89", "Scrolling text controls: crawl and roll in the inspector", "UI", "11.90, 11.46",
      `The inspector edits a crawl or roll's speed, direction, gap, separator, loop and alignment and its item list; Playout offers start, stop, resume and live speed on the object. ${R}`],
  ]],
  ["12.9", [
    ["11.87", "Hardware Setup dialog: outputs, key and fill, audio devices, timecode, GPI, tracking", "UI", "6.5, 12.7, 2.28",
      `Edit > Hardware Setup shows and edits the engine's outputs (fill, key, shaped or unshaped, embedded audio and its offset), audio devices, timecode I/O, GPI and tally, camera tracking sources and server channels, each with the refusal reason when the machine cannot do it; Tools > Record Client records a program output to a file. The hardware itself is X2. ${R}`],
  ]],
];

const insertAfter = (id, rows) => {
  const lines = md.split(nl);
  const at = lines.findIndex((l) => l.startsWith(`| \`${id}\` |`));
  if (at < 0) throw new Error(`row ${id} not found`);
  const texts = rows.map(([rid, name, track, needs, done]) => {
    if (lines.some((l) => l.startsWith(`| \`${rid}\` |`))) throw new Error(`row ${rid} already exists`);
    if ([name, needs, done].some((t) => t.includes("|"))) throw new Error(`row ${rid} has a pipe`);
    return `| \`${rid}\` | ${name} | ${track} | ${needs} | ${done} |`;
  });
  lines.splice(at + 1, 0, ...texts);
  md = lines.join(nl);
};
for (const [after, rows] of ADD) insertAfter(after, rows);

// Rows 11.32 and 11.33: the menu bar follows the XPression reference, not After Effects' menus.
const rewrite = (id, replacement) => {
  const lines = md.split(nl);
  const at = lines.findIndex((l) => l.startsWith(`| \`${id}\` |`));
  if (at < 0) throw new Error(`row ${id} not found`);
  lines[at] = replacement;
  md = lines.join(nl);
};
rewrite("11.32", "| `11.32` | Menu bar as Ross XPression's, from the research reference | UI | 11.31 | The Editor's menu bar has the eight top-level menus of Ross XPression Studio in its order, from `docs/reference/xpression-menu-bar.md`: **File, Edit, Windows, Projects, Animation, Display, Tools, Help**. It is built from one model (`Editor/src/app-menu.ts`) in which each item is either a command that runs through an existing Editor control, or is not built yet and says the plan row that builds it (shown disabled, never a dead click); each item says where it comes from (an XPression screenshot or guide, an older guide, a Ross community post, or a GrapiX addition) and a test holds the model to the reference's rules (no duplicate ids or shortcuts, every item has one action or a row, every row named exists). Display toggles the dockable panels in the reference's order; Open Recent is live; Exit refuses by name while a scene has unsaved work. Replaces the After Effects menu layout this row first named (decision 23 Nov 2026: XPression is the benchmark for the basics). Items still waiting on rows are listed in `docs/evidence/xpression-benchmark/README.md` |");
rewrite("11.33", "| `11.33` | Windows menu: every module reachable; tabbed docks and saved layouts | UI | 11.5, 11.32 | The Display menu lists every Editor panel and shows, focuses or hides it, and the Windows menu holds the layout commands; a hidden panel is never lost and reopens where it was; panels stack as tabs inside any dock and drag between docks and tab groups; the user can save named layouts, switch between them and reset to the card-sort default; layouts survive restart |");
writeFileSync(PLAN, md);
console.log("rows added:", ADD.reduce((n, [, r]) => n + r.length, 0));
