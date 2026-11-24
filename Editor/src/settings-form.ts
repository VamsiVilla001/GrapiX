// The Settings window's fields (plan row 11.81): every setting of the settings service (2.28), with its
// plain-English label, a line of help, the kind of control and, honestly, whether anything reads it yet.
//
// The two tables are checked by the compiler against the generated settings types, so a setting added to
// the contract cannot be left out of the window: `satisfies Record<keyof UserSettings, ...>` fails to
// compile until the new key has a row here.

import type { MachineSettings, UserSettings } from "@grapix/contracts";

export type FieldKind = "text" | "toggle" | "number" | "choice";

export interface FieldSpec {
  readonly label: string;
  readonly help: string;
  readonly kind: FieldKind;
  /** For a choice: the stored value and the words shown. */
  readonly options?: readonly (readonly [value: string, words: string])[];
  readonly min?: number;
  readonly max?: number;
  /** Left empty on purpose (a text field that may be blank). */
  readonly blankMeans?: string;
  /** What reads this setting, or why nothing does yet. Absent: it is used now. */
  readonly notUsedYet?: string;
}

export const USER_FIELDS = {
  language: {
    label: "Language",
    help: "The language tag of the screens, such as en, en-GB or hi.",
    kind: "text",
    notUsedYet: "Waits for the language files (row 11.91).",
  },
  confirmDeletes: {
    label: "Ask before deleting",
    help: "Show a question before objects or scenes are deleted.",
    kind: "toggle",
    notUsedYet: "Waits for the delete question to be built.",
  },
  defaultAnimationFrames: {
    label: "New scene length (frames)",
    help: "How long the timeline of a new scene is.",
    kind: "number",
    min: 1,
    max: 1_000_000,
    notUsedYet: "A new scene still starts at 250 frames.",
  },
  defaultInterpolation: {
    label: "New key easing",
    help: "The easing a new key starts with.",
    kind: "choice",
    options: [
      ["linear", "Straight (linear)"],
      ["easeInOut", "Smooth start and end"],
      ["bezier", "Curve I draw (bezier)"],
    ],
    notUsedYet: "Keys still start with their own default.",
  },
  startup: {
    label: "When the Editor starts",
    help: "Show the Start window, or open the project that was open last.",
    kind: "choice",
    options: [
      ["showStart", "Show the Start window"],
      ["reopenLast", "Open the last project"],
    ],
  },
  lastUsedFolder: {
    label: "Last folder used",
    help: "Where the next file window opens. It is remembered for you.",
    kind: "text",
    blankMeans: "No folder is remembered yet.",
  },
  penAngleStep: {
    label: "Pen angle step (degrees)",
    help: "The step Shift holds the Pen's points and handles to: 15 as After Effects does, 45 as Illustrator does.",
    kind: "number",
    min: 1,
    max: 90,
  },
  penPickRadius: {
    label: "Pen pick distance (pixels)",
    help: "How near the pointer must be to take a vertex, a handle or a curve, whatever the zoom.",
    kind: "number",
    min: 3,
    max: 24,
  },
  penSnap: {
    label: "Snap pen points",
    help: "Snap points the Pen places and path points you drag to the canvas, other layers and other vertices. Hold Ctrl to turn it off for one drag.",
    kind: "toggle",
  },
  penFitTolerance: {
    label: "Remove point, keep shape: tolerance (pixels)",
    help: "Alt-click with the Delete Vertex tool takes a point out and fits one curve over the two beside it, if the shape moves no more than this.",
    kind: "number",
    min: 1,
    max: 100,
  },
  penDoubleClickEnds: {
    label: "Double click ends a path",
    help: "Double click finishes the path the Pen is drawing. Enter and Escape always do.",
    kind: "toggle",
  },
} as const satisfies Record<keyof UserSettings, FieldSpec>;

export const MACHINE_FIELDS = {
  gpuAdapter: {
    label: "Graphics card",
    help: "The name of the graphics card to draw on. Leave blank to let the engine choose.",
    kind: "text",
    blankMeans: "The engine chooses.",
    notUsedYet: "The engine does not read it yet.",
  },
  antiAlias: {
    label: "Smooth edges",
    help: "Smooth the edges of shapes and text.",
    kind: "toggle",
    notUsedYet: "The engine does not read it yet.",
  },
  textureCacheMb: {
    label: "Picture memory limit (MB)",
    help: "How much memory the picture cache may use.",
    kind: "number",
    min: 64,
    max: 65_536,
    notUsedYet: "The engine does not read it yet.",
  },
  diskCachePath: {
    label: "Cache folder",
    help: "Where the cache on disk lives. Leave blank for the usual place.",
    kind: "text",
    blankMeans: "The usual place.",
    notUsedYet: "The engine does not read it yet.",
  },
  diskCacheMaxMb: {
    label: "Cache size on disk (MB)",
    help: "The most the cache on disk may take. 0 turns it off.",
    kind: "number",
    min: 0,
    max: 4_194_304,
    notUsedYet: "The engine does not read it yet.",
  },
  processPriority: {
    label: "Engine priority",
    help: "How much the computer favours the engine over other programs.",
    kind: "choice",
    options: [
      ["normal", "Normal"],
      ["aboveNormal", "Above normal"],
      ["high", "High"],
    ],
    notUsedYet: "The engine does not read it yet.",
  },
  logLevel: {
    label: "How much the logs say",
    help: "More detail makes bigger log files.",
    kind: "choice",
    options: [
      ["error", "Errors only"],
      ["warn", "Warnings and errors"],
      ["info", "Normal"],
      ["debug", "Everything"],
    ],
    notUsedYet: "The engine does not read it yet.",
  },
  controlAddress: {
    label: "Remote control address",
    help: "The address other systems send commands to. 127.0.0.1 means this computer only.",
    kind: "text",
    notUsedYet: "Waits for remote control (row 6.7).",
  },
  controlPort: {
    label: "Remote control port",
    help: "The port number, 1024 or more.",
    kind: "number",
    min: 1024,
    max: 65_535,
    notUsedYet: "Waits for remote control (row 6.7).",
  },
} as const satisfies Record<keyof MachineSettings, FieldSpec>;

export type Parsed = { readonly ok: true; readonly value: string | number | boolean } | { readonly ok: false; readonly why: string };

/** What the control holds, as the value to send. A number must be a whole number inside its range. */
export function toValue(spec: FieldSpec, raw: string | boolean): Parsed {
  switch (spec.kind) {
    case "toggle":
      return { ok: true, value: raw === true || raw === "true" };
    case "text":
    case "choice":
      return { ok: true, value: String(raw).trim() };
    case "number": {
      const text = String(raw).trim();
      if (!/^-?\d+$/.test(text)) return { ok: false, why: "Type a whole number." };
      const value = Number(text);
      if (spec.min !== undefined && value < spec.min) return { ok: false, why: `Use ${spec.min} or more.` };
      if (spec.max !== undefined && value > spec.max) return { ok: false, why: `Use ${spec.max} or less.` };
      return { ok: true, value };
    }
  }
}

/** The line shown under a field: what reads it, or that it is not used yet. */
export function usageLine(spec: FieldSpec): string {
  return spec.notUsedYet === undefined ? "Used now." : `Saved. Not used yet: ${spec.notUsedYet}`;
}
