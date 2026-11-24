// Rewrites the rows added on 23 Nov 2026 in plain, everyday English with GrapiX's own names (decision
// 23 Nov 2026: no XPression names for menus, drop-downs or modules), and makes 6.7 TCP, UDP and HTTP of our
// own design (RossTalk is a vendor protocol and is not the base). Run once from the repository root.
import { readFileSync, writeFileSync } from "node:fs";

const PLAN = "GrapiX-Build-Plan.md";
let md = readFileSync(PLAN, "utf8");
const nl = md.includes("\r\n") ? "\r\n" : "\n";
const R = "Research: docs/evidence/xpression-benchmark/research.md.";

// id -> [name, needs or null to keep, done-when]
const ROWS = {
  "2.28": ["Settings service: user, machine and project levels", null,
    `One typed settings store with two files and a rule for the third. **User settings** follow a person (language, confirmations, what a new animation starts with, what the app does at start). **Machine settings** belong to this computer (GPU adapter, caches, ports, process priority, log level). **Project settings** (anything that changes how a graphic looks when rendered) stay inside the project file and never in settings, so changing a setting can never change a graphic on air. Defaults, a version number, atomic writes with a backup copy kept at each change, change events, a clear refusal for an unknown or out-of-range value, a reset to defaults, and a damaged file set aside (never lost) with the backup or defaults used. Built so far: the service, its tests and the Editor commands; the apps read their settings from here row by row (11.81 onwards). ${R}`],
  "6.7": ["Remote control: commands from other systems over TCP, UDP and HTTP", null,
    `Other systems (station automation, control panels, scripts) can drive Playout over three channels of our own design, all doing the same jobs: load, cue, take, out, clear one layer, clear all, update a field, run a run-order item, next, previous. **TCP**: one text command per line; every command gets a coded reply (2xx done, 4xx the caller's mistake, 5xx the engine's fault) with an optional request number; changes of state (what is on air, layer by layer) are pushed to everyone listening, which is also the on-air signal. **UDP**: one command per datagram, for simple triggers where a lost packet does no harm; there is no connection to log in on, so every datagram carries a token and a rising counter and an old or repeated one is dropped; a size limit; replies and state go back to the sender; never the only way to take something to air. **HTTP**: the same jobs as a documented JSON interface. All three are off, or on this computer only, until switched on; each needs a credential; a role per connection (view, cue, take) is checked by the 5.7 scopes; every take is on the as-run record (12.11) with who, from where and when; one controller at a time can hold control. Replaces the deferral in 6.6 for station automation. Not in this row: vendor protocols such as RossTalk (proprietary); notes on how RossTalk works are in docs/evidence/xpression-benchmark/rosstalk-notes.md, and a compatible adapter can be added beside these three later if wanted. ${R}`],
  "6.8": ["Trigger inputs, on-air signals and control panels", null,
    `Simple trigger inputs (first over the network as "trigger n" on 6.7, later contact-closure boards) that the user links to commands (11.31), with a debounce in milliseconds so one press is one action; on-air and per-layer signals sent out; control panels (Stream Deck through Bitfocus Companion over 6.7, keyboards, MIDI later) that reach the same commands. A table links an outside value to an object or field through the template contract (11.26). Physical boards, serial and MIDI can wait. ${R}`],
  "6.9": ["Run order exchange: files and a newsroom link", null,
    `The Playout run order can be saved and loaded as XML and CSV (also a backup of a run). A newsroom link implements the first three levels of the MOS 2.8.5 standard (heartbeat and machine info; objects with acknowledgement; running order create, replace, delete, element action, status and ready to air) over TCP on ports 10540, 10541 and 10542, turns each running-order item into a run-order item and reports its status back; a message it cannot use is refused with the reason. The higher MOS levels and newsroom-specific plug-ins (ENPS, iNews) can wait. ${R}`],
  "7.8": ["Project format and conversion", null,
    `A project declares its format: picture size, pixel shape, frame-rate family with a drop-frame flag, progressive or interlaced with field order, safe areas, colour space and bit depth (3.15), chosen from presets and the user's own presets. Changing the format makes a new project from the old one: all scenes, objects, assets and keys kept, resizing by a clear choice (none, fit, stretch), a frame-rate change reported as a change of timing, and the original never overwritten. What the same step does in XPression could not be verified, so the behaviour is our own decision. ${R}`],
  "11.81": ["Settings window", null,
    `Edit > Settings… opens one window over the settings service (2.28): editor behaviour (what happens at start, delete confirmations, default animation length and key easing), GPU adapter and edge smoothing, folders for assets and caches, import defaults, cache limits, process priority, fonts, language, log level, the control address and credential for remote control (6.7), and a reset to defaults. A change applies at once or says it needs a restart, and each setting shows whether it is yours (user) or this computer's (machine). ${R}`],
  "11.82": ["Change history list", null,
    `Edit > Change history… lists the steps of the command log; clicking one takes the scene back or forward to it as one undoable move; each entry names the part of the app that made it (11.37). The same list serves the menu, the toolbar and the shortcut. ${R}`],
  "11.83": ["Line up, spread and snap", null,
    `Line up (edges and centres) and spread (even gaps across or down) the selected objects as one undoable command; snap to the grid, guides and the edges and centres of other objects, with a switch and a key to hold to bypass it; move, resize and rotate several selected objects around one shared point. ${R}`],
  "11.84": ["Shortcut and trigger settings", null,
    `Edit > Shortcuts and triggers… shows and changes which key, trigger input or outside control runs which command (11.31); clashes are shown, a shortcut has one handler, and every menu item shows the key it has. The choices are user settings (2.28) and can be reset. ${R}`],
  "11.85": ["Project commands: go back to saved, next version, bring in, show folder, change format, pack", null,
    `File > Go back to last saved… (after a confirm); File > Save as next version writes name_0001 beside the project; File > Bring in > From another project… brings scenes and assets from another project with the choices copy files into this project, use fonts already here and keep the folder layout; File > Pack for sharing… builds a package (1.8) with scenes, assets and fonts; Project > Show project folder; Project > Change project format… over 7.8. Each one refuses by name when unsaved work is in the way. ${R}`],
  "11.86": ["Media library and Sounds panels", null,
    `Panels > Media library lists the project's video clips as thumbnails and as a list (length, format, transparency, in and out points, loop, hold last frame, search) with a hover preview over a checkerboard, and puts one on a layer; Panels > Sounds lists the audio with level, fade, loop and a level meter. ${R}`],
  "11.87": ["Outputs and devices window", null,
    `Edit > Outputs and devices… shows and changes the engine's outputs (picture and key, shaped or not, audio and its delay), audio devices, timecode, trigger and on-air signal boards, camera tracking sources and playout channels, each with the reason when this computer cannot do it; Utilities > Record output… records an output to a file. The hardware itself is X2. ${R}`],
  "11.88": ["Help guide and About inside the app", null,
    `Help > Help guide and the F1 key open local, offline help (studios are often cut off from the internet), with a searchable list of shortcuts; About shows the version, build, licence and a shortcut to the log folder. ${R}`],
  "11.89": ["Moving text controls in the Properties panel", null,
    `The Properties panel edits a ticker's or credit roll's speed, direction, gap, separator, loop and alignment and its list of items; Playout offers start, stop, resume and live speed change on the object. ${R}`],
  "11.90": ["Moving text: sideways ticker and upward credits", null,
    `A ticker object (sideways) and a credit-roll object (upward): speed in pixels per second, direction, separator and gap, loop or stop at the end, alignment per group, starting full or from off screen. Items come from a list that can change on air without a jump (add, remove or replace items not yet visible; a visible item never shifts). Start, stop with a slow-down, resume and a live speed change are operator commands. The position is worked out from the engine's frame counter, so it is exact at 50 and 59.94 frames and never builds up errors from the wall clock; movement is smooth to a fraction of a pixel with no text layout per frame. A feed (file, JSON, RSS read at an interval into a list, with the last good list kept if a read fails) is a separate list. ${R}`],
  "11.91": ["Interface language groundwork", null,
    `Every word the user sees in the Editor and Playout lives in a language file under a stable key (no sentence is built from pieces), text is UTF-8 everywhere, numbers and dates follow the locale, the project's language is kept apart from the interface language, layouts allow for longer text, and a test run with every string lengthened and accented shows nothing cut off or fixed in code. Translated languages and full right-to-left layout follow. ${R}`],
  "16.17": ["Audio: sounds with graphics", null,
    `Audio is part of a scene: WAV files at 48 kHz and the sound of video clips, a sound started together with a graphic and locked to the engine clock, level in dB, fade in and out, loop, a map to a 2 or 8 channel embedded bus, a peak meter per sound, everything converted to 48 kHz at import, and an output delay in frames. Mixing, loudness and routing stay with the production audio desk. MP3 and AAC, surround, EQ and ducking can wait. ${R}`],
  "16.18": ["Media library service: thumbnails, formats and transparency", null,
    `A service for the project's video and audio: thumbnails and a hover preview over a checkerboard, length, format, transparency, in and out points, loop, hold-last-frame and premultiplied flags, search by name, length and date, play on a layer, and a conversion to a playout-friendly cache. Formats ProRes 4444, HAP and HAP Alpha, H.264, DNxHR and PNG sequences (the order is a judgement). Links to outside media systems and syncing several servers can wait. ${R}`],
  "16.19": ["Live video input as a layer", null,
    `One live input (NDI first, SDI with the hardware in 15.x) as a layer: a fixed delay buffer set in frames, a locked-or-free-running flag on the status screen, audio passed through or muted, and picture in picture as a moved and resized live layer. Several inputs and very low delay compositing can wait. ${R}`],
  "16.20": ["Tracked camera and virtual studio", null,
    `Later, optional. FreeD over UDP (and serial if feasible) drives the scene's 3D camera: position, rotation and field of view from a lens table, a manual delay in frames, a monitor showing the rate and dropped packets, a switch to ignore or override each value, picture and key output, and a manual camera as the fallback. The FreeD scaling differs between sources and must be checked against real hardware. Other tracking systems, OpenTrackIO, lens distortion files and timecode sync follow. ${R}`],
  "11.32": ["Menu bar with GrapiX's own names", null,
    `The Editor's menu bar has eight menus in plain words: **File, Edit, Project, Motion, Panels, Layout, Utilities, Help**. What each holds follows the jobs a broadcast graphics application needs, taken from the research reference (docs/reference/xpression-menu-bar.md), but no menu, drop-down or item uses XPression's own name for it (decision 23 Nov 2026: simple, everyday English). It is built from one model (Editor/src/app-menu.ts): each item either runs an existing Editor control or says which plan row builds it (shown dimmed, never a dead click), and each item privately records which feature in the reference it does the job of, so a test can check the match and that the name is not copied. Panels shows and focuses the dockable panels; Recent projects is live; Close app refuses by name while a scene has unsaved work. Replaces the After Effects menu layout this row first named. The items still waiting on rows are listed in docs/evidence/xpression-benchmark/README.md`],
  "11.33": ["Layout and Panels menus: every module reachable; tabbed docks and saved layouts", null,
    `The Panels menu lists every Editor panel and shows, focuses or hides it, and the Layout menu holds the layout commands; a hidden panel is never lost and reopens where it was; panels stack as tabs inside any dock and drag between docks and tab groups; the user can save named layouts, switch between them and reset to the default; layouts survive restart`],
};

const lines = md.split(nl);
let changed = 0;
for (const [id, [name, , done]] of Object.entries(ROWS)) {
  const at = lines.findIndex((l) => l.startsWith(`| \`${id}\` |`));
  if (at < 0) throw new Error(`row ${id} not found`);
  const m = lines[at].match(/^\| `([\d.]+)` \| (.*?) \| (CON|PLAT|BE|UI|RES|EXT|AI) \| (.*?) \| (.*) \|$/);
  if (!m) throw new Error(`row ${id} does not parse`);
  if ([name, done].some((t) => t.includes("|"))) throw new Error(`row ${id} has a pipe`);
  lines[at] = `| \`${id}\` | ${name} | ${m[3]} | ${m[4]} | ${done} |`;
  changed += 1;
}
writeFileSync(PLAN, lines.join(nl));
console.log("rows rewritten:", changed);
