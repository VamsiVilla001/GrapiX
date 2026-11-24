// The application menu bar (plan row 11.32).
//
// What it holds follows the jobs a broadcast graphics application needs, taken from the research
// reference of Ross XPression's menu bar (`docs/reference/xpression-menu-bar.md`, 23 Nov 2026). The
// NAMES are GrapiX's own, in plain everyday English: no menu, drop-down or panel carries XPression's
// own name for it (decision 23 Nov 2026). Each item that matches a feature in the reference keeps a
// private `basedOn` note, so the match can still be checked, but it is never shown.
//
//   File  Edit  Project  Motion  Panels  Layout  Utilities  Help
//
// This module is the model only: what each menu holds, what runs when an item is chosen and where
// the item came from. `app-menu-view.ts` draws it, and `main.ts` runs the actions through the
// Editor's own existing paths (the menu never has a second copy of a command).
//
// Rules held here:
//  - An item is a command with exactly one action, or it is not built yet and says which plan row
//    builds it. There are no dead clickable items: an unbuilt item is shown dimmed, with its row.
//  - Every item says where it came from (`evidence`). An item the reference does not show, that
//    GrapiX needs, is `grapix`.
//  - Panels are not invented: Panels shows and hides the Editor's own dockable panels.

import type { ArrangeCommand } from "./arrange";

/** Where an item comes from. `screen` is a screenshot of an XPression dropdown, `v11` and `v12` a
 * Ross user guide, `legacy` an older Ross guide, `community` a Ross community post, `grapix` an item
 * GrapiX adds that the reference does not show. */
export type Evidence = "screen" | "v11" | "v12" | "legacy" | "community" | "grapix";

/** The tooltip's source line. It names the kind of source, never the feature, so the menu does not
 * repeat XPression's names even in a tooltip. */
export const EVIDENCE_LABEL: Readonly<Record<Evidence, string>> = {
  screen: "Same job as a feature seen in an XPression screenshot",
  v11: "Same job as a feature in the XPression 11.5 guide",
  v12: "Same job as a feature in the XPression 12.5 guide",
  legacy: "Same job as a feature in an older XPression guide",
  community: "Same job as a feature a Ross community post names",
  grapix: "Added by GrapiX",
};

/** Things the menu does that are not a click on an existing control. */
export type NativeAction =
  | `arrange-${ArrangeCommand}`
  | "save"
  | "save-next-version"
  | "new-project"
  | "open-project"
  | "open-settings"
  | "exit"
  | "view-fit"
  | "view-zoom-in"
  | "view-zoom-out"
  | "view-zoom-100"
  | "easy-ease"
  | "easy-ease-in"
  | "easy-ease-out"
  | "delete-keys"
  | "copy-keys"
  | "paste-keys"
  | "toggle-object-toolbar"
  | "focus-activity"
  | "export-diagnostics-all"
  | "export-diagnostics-editor";

export interface MenuCommand {
  readonly kind: "command";
  readonly id: string;
  readonly label: string;
  readonly evidence: Evidence;
  /** The reference's own name for the feature this item does the job of. Never shown; tests check
   * it against the reference, and that the label is not the same words. */
  readonly basedOn?: string;
  /** Shown beside the label. Only a shortcut the Editor really handles is written here. */
  readonly shortcut?: string;
  /** Click the Editor control with this element id (the one command path). */
  readonly invoke?: string;
  /** Create an object of this kind, as the toolbar does. */
  readonly createKind?: string;
  /** Bring this dockable panel (`data-panel`) forward. */
  readonly focusPanel?: string;
  readonly native?: NativeAction;
  /** Not built yet: the plan row that builds it. A command has an action or a row, never both. */
  readonly row?: string;
}

export interface MenuSubmenu {
  readonly kind: "submenu";
  readonly id: string;
  readonly label: string;
  readonly evidence: Evidence;
  readonly basedOn?: string;
  readonly items: readonly MenuNode[];
}

export interface MenuSeparator {
  readonly kind: "separator";
}

/** Items made when the menu opens. */
export type MenuDynamic =
  | { readonly kind: "recent" }
  /** The Editor's dockable panels not named elsewhere in the menu. */
  | { readonly kind: "panels"; readonly except: readonly string[] };

export type MenuNode = MenuCommand | MenuSubmenu | MenuSeparator | MenuDynamic;

export interface Menu {
  readonly id: string;
  readonly label: string;
  readonly items: readonly MenuNode[];
}

type How = Partial<Omit<MenuCommand, "kind" | "id" | "label" | "evidence">>;
const cmd = (id: string, label: string, evidence: Evidence, how: How = {}): MenuCommand => ({
  kind: "command",
  id,
  label,
  evidence,
  ...how,
});
const sub = (
  id: string,
  label: string,
  evidence: Evidence,
  items: readonly MenuNode[],
  basedOn?: string,
): MenuSubmenu => ({ kind: "submenu", id, label, evidence, items, ...(basedOn !== undefined ? { basedOn } : {}) });
const SEP: MenuSeparator = { kind: "separator" };

/** The dockable panels the Panels menu names, so the "other panels" list leaves them out. */
const NAMED_PANELS = ["scene-manager", "object-manager", "materials", "inspector", "effects", "timeline", "preview"];

export const APP_MENUS: readonly Menu[] = [
  {
    id: "file",
    label: "File",
    items: [
      cmd("file.new-project", "New project…", "screen", { native: "new-project", basedOn: "New" }),
      cmd("file.new-scene", "New scene…", "grapix", { invoke: "new-scene" }),
      cmd("file.open-project", "Open project…", "screen", { native: "open-project", basedOn: "Open Project" }),
      { kind: "recent" },
      cmd("file.close-project", "Close project", "grapix", { invoke: "project-close" }),
      SEP,
      cmd("file.revert", "Go back to last saved…", "screen", { row: "11.85", basedOn: "Revert" }),
      sub(
        "file.bring-in",
        "Bring in",
        "screen",
        [
          cmd("file.bring-in.project", "From another project…", "v11", { row: "11.85", basedOn: "From Project/File" }),
          SEP,
          cmd("file.bring-in.scene", "Scene file…", "grapix", { invoke: "open-scene" }),
          cmd("file.bring-in.svg", "SVG drawing…", "grapix", { invoke: "import-svg" }),
        ],
        "Import",
      ),
      SEP,
      cmd("file.save", "Save", "screen", { native: "save", shortcut: "Ctrl S", basedOn: "Save" }),
      cmd("file.save-as", "Save as…", "screen", { invoke: "project-save-as", basedOn: "Save As" }),
      cmd("file.save-scene-file", "Save scene file…", "grapix", { invoke: "save-scene" }),
      cmd("file.next-version", "Save as next version", "screen", { native: "save-next-version", shortcut: "Ctrl Shift S", basedOn: "Increment And Save" }),
      cmd("file.pack", "Pack for sharing…", "screen", { row: "11.85", basedOn: "Export Package" }),
      sub(
        "file.playout",
        "Send to Playout",
        "screen",
        [
          cmd("file.playout.send", "Send to Playout…", "screen", { invoke: "publish", basedOn: "Publish" }),
          cmd("file.playout.others", "Send to other machines…", "screen", { row: "11.57", basedOn: "Deploy" }),
          cmd("file.playout.connection", "Connection settings…", "screen", { row: "11.81", basedOn: "Setup" }),
        ],
        "Project Server",
      ),
      SEP,
      cmd("file.exit", "Close app", "screen", { native: "exit", basedOn: "Exit" }),
    ],
  },
  {
    id: "edit",
    label: "Edit",
    items: [
      cmd("edit.history", "Change history…", "screen", { invoke: "history-open", basedOn: "Undo/Redo History" }),
      cmd("edit.undo", "Undo", "screen", { invoke: "undo", shortcut: "Ctrl Z", basedOn: "Undo" }),
      cmd("edit.redo", "Redo", "screen", { invoke: "redo", shortcut: "Ctrl Shift Z", basedOn: "Redo" }),
      SEP,
      // The tools of the ribbon (11.102): each is a button there, a key here, and one command in the registry.
      cmd("edit.pointer", "Pointer", "screen", { invoke: "tool-selection", shortcut: "V", basedOn: "Select" }),
      cmd("edit.move", "Move", "screen", { invoke: "tool-move", shortcut: "W", basedOn: "Move" }),
      cmd("edit.rotate", "Rotate", "screen", { invoke: "tool-rotate", shortcut: "E", basedOn: "Rotate" }),
      cmd("edit.resize", "Resize", "screen", { invoke: "tool-scale", shortcut: "R", basedOn: "Scale" }),
      cmd("edit.centre", "Pivot point", "screen", { invoke: "tool-pivot", shortcut: "Y", basedOn: "Pivot" }),
      cmd("edit.pen", "Pen", "grapix", { invoke: "tool-pen", shortcut: "G" }),
      cmd("edit.path", "Edit path", "grapix", { invoke: "tool-path", shortcut: "A" }),
      cmd("edit.vertex-add", "Add vertex", "grapix", { invoke: "tool-vertex-add", shortcut: "=" }),
      cmd("edit.vertex-delete", "Delete vertex", "grapix", { invoke: "tool-vertex-delete", shortcut: "-" }),
      cmd("edit.vertex-convert", "Convert vertex", "grapix", { invoke: "tool-vertex-convert", shortcut: "C" }),
      cmd("edit.hand", "Hand", "grapix", { invoke: "tool-hand", shortcut: "H" }),
      cmd("edit.zoom", "Zoom", "grapix", { invoke: "tool-zoom", shortcut: "Z" }),
      sub(
        "edit.line-up",
        "Line up and spread",
        "screen",
        [
          cmd("edit.line-up.left", "Line up left edges", "grapix", { native: "arrange-line-left" }),
          cmd("edit.line-up.centre", "Line up centres across", "grapix", { native: "arrange-line-centre" }),
          cmd("edit.line-up.right", "Line up right edges", "grapix", { native: "arrange-line-right" }),
          cmd("edit.line-up.top", "Line up top edges", "grapix", { native: "arrange-line-top" }),
          cmd("edit.line-up.middle", "Line up middles down", "grapix", { native: "arrange-line-middle" }),
          cmd("edit.line-up.bottom", "Line up bottom edges", "grapix", { native: "arrange-line-bottom" }),
          SEP,
          cmd("edit.line-up.spread-across", "Spread evenly across", "grapix", { native: "arrange-spread-across" }),
          cmd("edit.line-up.spread-down", "Spread evenly down", "grapix", { native: "arrange-spread-down" }),
          SEP,
          cmd("edit.line-up.snap", "Snap to grid and guides", "grapix", { row: "11.83" }),
        ],
        "Object Align",
      ),
      SEP,
      sub("edit.add-object", "Add object", "grapix", [
        cmd("edit.add-object.rect", "Rectangle", "grapix", { createKind: "rect" }),
        cmd("edit.add-object.ellipse", "Ellipse", "grapix", { createKind: "ellipse" }),
        cmd("edit.add-object.text", "Text", "grapix", { createKind: "text" }),
      ]),
      cmd("edit.duplicate", "Duplicate", "grapix", { invoke: "object-duplicate" }),
      cmd("edit.rename", "Rename…", "grapix", { invoke: "object-rename" }),
      cmd("edit.delete", "Delete", "grapix", { invoke: "object-delete" }),
      cmd("edit.join", "Join paths", "grapix", { invoke: "object-join", shortcut: "Ctrl J" }),
      cmd("edit.copy-svg", "Copy path as SVG", "grapix", { invoke: "object-copy-svg" }),
      SEP,
      cmd("edit.devices", "Control devices", "screen", { row: "6.8", basedOn: "Human Interface Devices" }),
      cmd("edit.scripts", "Scripts", "screen", { row: "16.4", basedOn: "Scripting" }),
      cmd("edit.media-link", "Media library link…", "screen", { row: "16.18", basedOn: "OpenMAM Setup" }),
      cmd("edit.shortcuts", "Shortcuts and triggers…", "screen", { row: "11.84", basedOn: "Keyboard / GPI Mapping" }),
      cmd("edit.tracked-camera", "Tracked camera", "screen", { row: "16.20", basedOn: "Tessera" }),
      cmd("edit.outputs", "Outputs and devices…", "v12", { row: "11.87", basedOn: "Hardware Setup" }),
      cmd("edit.settings", "Settings…", "v12", { native: "open-settings", basedOn: "Preferences" }),
    ],
  },
  {
    id: "project",
    label: "Project",
    items: [
      cmd("project.format", "Change project format…", "community", { row: "7.8", basedOn: "Convert Project Mode" }),
      cmd("project.folder", "Show project folder", "legacy", { row: "11.85", basedOn: "Display project path in Windows Explorer" }),
    ],
  },
  {
    id: "motion",
    label: "Motion",
    items: [
      cmd("motion.controls", "Motion controls", "legacy", { focusPanel: "animation", basedOn: "Animation Controller" }),
      cmd("motion.curves", "Curve editor", "legacy", { invoke: "timeline-graph-mode", basedOn: "Key Graph Editor" }),
      cmd("motion.add-key", "Add key", "legacy", { row: "11.68", basedOn: "Set Keyframe" }),
      SEP,
      // The timeline's keys, which each had a shortcut and no menu item. Every key the Editor handles is here (11.31).
      cmd("motion.play", "Play or pause preview", "grapix", { invoke: "preview-play", shortcut: "Space" }),
      cmd("motion.easy-ease", "Ease selected keys", "grapix", { native: "easy-ease", shortcut: "F9" }),
      cmd("motion.easy-ease-in", "Ease selected keys in", "grapix", { native: "easy-ease-in", shortcut: "Shift F9" }),
      cmd("motion.easy-ease-out", "Ease selected keys out", "grapix", { native: "easy-ease-out", shortcut: "Ctrl Shift F9" }),
      cmd("motion.delete-keys", "Delete selected keys", "grapix", { native: "delete-keys", shortcut: "Delete" }),
      cmd("motion.copy-keys", "Copy selected keys", "grapix", { native: "copy-keys", shortcut: "Ctrl C" }),
      cmd("motion.paste-keys", "Paste keys", "grapix", { native: "paste-keys", shortcut: "Ctrl V" }),
      SEP,
      cmd("motion.preset-in", "Apply entry preset", "grapix", { invoke: "timeline-preset-apply" }),
      cmd("motion.preset-out", "Apply exit preset", "grapix", { invoke: "timeline-preset-apply-out" }),
      cmd("motion.play-phase", "Play this phase", "grapix", { invoke: "phase-play" }),
      cmd("motion.jump-hold", "Jump to hold", "grapix", { invoke: "timeline-jump-hold" }),
    ],
  },
  {
    id: "panels",
    label: "Panels",
    // Shows and hides the dockable panels. The order follows the jobs, not the reference's list.
    items: [
      cmd("panels.project-files", "Project files", "screen", { row: "11.52", basedOn: "Project Manager" }),
      cmd("panels.scenes", "Scenes", "screen", { focusPanel: "scene-manager", basedOn: "Scene Manager" }),
      cmd("panels.objects", "Objects", "screen", { focusPanel: "object-manager", basedOn: "Object Manager" }),
      cmd("panels.materials", "Materials", "screen", { focusPanel: "materials", basedOn: "Material Manager" }),
      cmd("panels.properties", "Properties", "screen", { focusPanel: "inspector", basedOn: "Object Inspector" }),
      cmd("panels.timeline", "Timeline", "screen", { focusPanel: "timeline", basedOn: "Scene Directors" }),
      cmd("panels.effects", "Effects", "screen", { focusPanel: "effects", basedOn: "Effects" }),
      cmd("panels.offset-timing", "Offset timing", "screen", { row: "11.77", basedOn: "Stagger Animations" }),
      cmd("panels.live-items", "Clocks and counters", "screen", { row: "11.56", basedOn: "Widgets" }),
      cmd("panels.ready-objects", "Ready-made objects", "screen", { row: "11.47", basedOn: "Object Library" }),
      cmd("panels.media", "Media library", "screen", { row: "11.86", basedOn: "Clip Browser" }),
      cmd("panels.sounds", "Sounds", "screen", { row: "11.86", basedOn: "Audio Files" }),
      cmd("panels.live-preview", "Live preview", "screen", { focusPanel: "preview", basedOn: "Online Preview" }),
      cmd("panels.output-previews", "Output previews", "screen", { row: "12.5", basedOn: "Output Monitors" }),
      cmd("panels.run-order", "Run order", "screen", { row: "12.3", basedOn: "Sequencer List" }),
      cmd("panels.item-details", "Item details", "screen", { row: "12.8", basedOn: "Take Inspector" }),
      cmd("panels.playout-channels", "Playout channels", "screen", { row: "11.87", basedOn: "Server Channels" }),
      cmd("panels.value-links", "External value links", "screen", { row: "6.8", basedOn: "PBus Mapping" }),
      cmd("panels.object-tools", "Object tools", "screen", { native: "toggle-object-toolbar", basedOn: "Object Toolbar" }),
      cmd("panels.activity", "Activity log", "screen", { native: "focus-activity", basedOn: "Status Log" }),
      SEP,
      { kind: "panels", except: NAMED_PANELS },
    ],
  },
  {
    id: "layout",
    label: "Layout",
    items: [
      cmd("layout.main-view", "Bring main view forward", "legacy", { focusPanel: "viewport", basedOn: "Set main viewport as active" }),
      // The view of the picture (11.105): fit, in, out and actual size. Editor only; nothing is saved in the scene.
      cmd("layout.fit", "Fit to window", "grapix", { native: "view-fit", shortcut: "Ctrl 0" }),
      cmd("layout.zoom-in", "Zoom in", "grapix", { native: "view-zoom-in", shortcut: "Ctrl =" }),
      cmd("layout.zoom-out", "Zoom out", "grapix", { native: "view-zoom-out", shortcut: "Ctrl -" }),
      cmd("layout.zoom-100", "Actual size", "grapix", { native: "view-zoom-100", shortcut: "Ctrl 1" }),
      SEP,
      cmd("layout.reset", "Reset layout", "grapix", { invoke: "workspace-reset" }),
      SEP,
      cmd("layout.save", "Save this layout…", "grapix", { row: "11.76" }),
      cmd("layout.named", "My layouts", "grapix", { row: "11.76" }),
    ],
  },
  {
    id: "utilities",
    label: "Utilities",
    items: [
      sub(
        "utilities.housekeeping",
        "Housekeeping",
        "screen",
        [cmd("utilities.clear-caches", "Clear caches", "community", { row: "11.58", basedOn: "Flush" })],
        "Advanced",
      ),
      sub(
        "utilities.checks",
        "Checks",
        "screen",
        [cmd("utilities.cache-watch", "Cache watch", "community", { row: "11.58", basedOn: "Video Cache Monitor" })],
        "Debug",
      ),
      cmd("utilities.live-capture", "Live video capture", "screen", { row: "16.19", basedOn: "Input Grabber" }),
      cmd("utilities.record", "Record output…", "screen", { row: "11.87", basedOn: "Record Client" }),
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      cmd("help.guide", "Help guide", "v11", { row: "11.88", basedOn: "Help Topics" }),
      SEP,
      cmd("help.diagnostics-all", "Export diagnostic bundle (all modules)", "grapix", { native: "export-diagnostics-all" }),
      cmd("help.diagnostics-editor", "Export diagnostic bundle (editor only)", "grapix", { native: "export-diagnostics-editor" }),
    ],
  },
];

/** The eight top-level menus, in order. File, Edit and Help are what every application calls them. */
export const TOP_LEVEL = ["File", "Edit", "Project", "Motion", "Panels", "Layout", "Utilities", "Help"] as const;

/** Names that are XPression's own. No menu, drop-down or item may use one of them as its label. */
export const XPRESSION_NAMES: readonly string[] = [
  "Windows", "Projects", "Animation", "Display", "Tools", "Convert Project Mode", "Project Server", "Increment And Save",
  "Export Package", "Revert", "Undo/Redo History", "Object Align", "Human Interface Devices", "Scripting", "OpenMAM Setup",
  "Clip Store Setup", "Keyboard / GPI Mapping", "Tessera", "Hardware Setup", "Preferences", "Animation Controller",
  "Scene Director", "Key Graph Editor", "Set Keyframe", "Project Manager", "Scene Manager", "Object Manager",
  "Material Manager", "Object Inspector", "Widgets", "Stagger Animations", "Scene Directors", "Clip Browser",
  "Server Channels", "PBus Mapping", "Object Library", "Audio Files", "Sequencer List", "Output Monitors",
  "Online Preview", "Take Inspector", "Object Toolbar", "Status Log", "Flush", "Video Cache Monitor", "Input Grabber",
  "Record Client", "Help Topics", "Open Recent", "Exit", "Advanced", "Debug", "Import", "Select", "Scale", "Pivot",
];

/** Every command in a list of nodes, submenus included, in order. */
export function commandsOf(nodes: readonly MenuNode[]): MenuCommand[] {
  const out: MenuCommand[] = [];
  for (const node of nodes) {
    if (node.kind === "command") out.push(node);
    else if (node.kind === "submenu") out.push(...commandsOf(node.items));
  }
  return out;
}

export function allCommands(menus: readonly Menu[] = APP_MENUS): MenuCommand[] {
  return menus.flatMap((menu) => commandsOf(menu.items));
}

/** Every submenu in a list of nodes, nested ones included. */
export function submenusOf(nodes: readonly MenuNode[]): MenuSubmenu[] {
  const out: MenuSubmenu[] = [];
  for (const node of nodes) {
    if (node.kind === "submenu") out.push(node, ...submenusOf(node.items));
  }
  return out;
}

/** What a command does: one action, or it is waiting for the plan row that builds it. */
export function actionOf(command: MenuCommand): "invoke" | "createKind" | "focusPanel" | "native" | "unbuilt" {
  if (command.invoke !== undefined) return "invoke";
  if (command.createKind !== undefined) return "createKind";
  if (command.focusPanel !== undefined) return "focusPanel";
  if (command.native !== undefined) return "native";
  return "unbuilt";
}

/** The tooltip: where the item comes from, and for an unbuilt one the row that builds it. */
export function menuTitle(command: MenuCommand): string {
  const from = EVIDENCE_LABEL[command.evidence];
  return actionOf(command) === "unbuilt" ? `Not built yet: plan row ${command.row}. ${from}.` : `${from}.`;
}

/** What is wrong with a menu model; empty when it is sound. */
export function menuProblems(menus: readonly Menu[] = APP_MENUS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const shortcuts = new Map<string, string>();
  for (const command of allCommands(menus)) {
    if (ids.has(command.id)) problems.push(`duplicate id ${command.id}`);
    ids.add(command.id);
    const actions = [command.invoke, command.createKind, command.focusPanel, command.native].filter((a) => a !== undefined).length;
    if (actions > 1) problems.push(`${command.id} has more than one action`);
    if (actions === 0 && command.row === undefined) problems.push(`${command.id} has no action and no plan row`);
    if (actions > 0 && command.row !== undefined) problems.push(`${command.id} has an action and also says it is not built`);
    if (command.shortcut !== undefined) {
      const other = shortcuts.get(command.shortcut);
      if (other !== undefined) problems.push(`${command.id} and ${other} share ${command.shortcut}`);
      shortcuts.set(command.shortcut, command.id);
    }
  }
  return problems;
}
