// The change history list (plan row 11.82): what each step of a scene's history is called, and which
// row the scene is on.
//
// Rust owns the history (services/editor/src/command.rs) and sends facts: each step's edits by their
// wire names, the part of the app that made them, and whether the step is applied. The words are here.
// Both tables are checked by the compiler against the generated contract types, so a new kind of edit
// or a new part of the app cannot reach the list without a name: `satisfies Record<...>` fails to
// compile until it has one.

import type { EditorModule, HistoryStep, HistoryView, SceneEdit } from "@grapix/contracts";

type EditKind = SceneEdit["edit"];

/** Plain words for every kind of edit, as a line of the history list. */
export const EDIT_WORDS = {
  createObject: "Add item",
  deleteObject: "Delete item",
  duplicateObject: "Duplicate item",
  renameObject: "Rename item",
  setObjectField: "Change value",
  setObjectVisible: "Show or hide item",
  setObjectLocked: "Lock or unlock item",
  editProperty: "Change value",
  createKeyframe: "Add key",
  updateKeyframe: "Change key",
  moveKeyframe: "Move key",
  removeKeyframe: "Delete key",
  applyPreset: "Apply motion preset",
  setPhase: "Set timeline phase",
  removePhase: "Remove timeline phase",
  declareControl: "Add template control",
  removeControl: "Remove template control",
  replaceControl: "Change template control",
  saveTextStyle: "Save text style",
  applyTextStyle: "Apply text style",
  setBinding: "Change data link",
  replaceDataContext: "Change sample data",
  relinkMaterial: "Swap material",
  deleteMaterial: "Delete material",
  relinkAsset: "Relink file",
  setAssetColorSpace: "Set picture colour space",
  setSceneName: "Rename scene",
  setSceneId: "Change scene id",
  setSceneLabel: "Change scene label",
  addFonts: "Add fonts",
  removeFont: "Remove font",
  updateFont: "Change font settings",
  replaceFont: "Replace font",
  addAssets: "Add files",
  setCanvas: "Change canvas",
  createShape: "Draw shape",
  setGroupChildren: "Change group",
  setObjectMasks: "Change masks",
  setClipChild: "Change clip",
  setTrackMatte: "Change track matte",
  setPreserveTransparency: "Change preserve underlying transparency",
  setTrim: "Trim path",
  setPaint: "Change colour",
  setStroke: "Change outline",
  setBlendMode: "Change blend mode",
  setAnchor: "Move pivot",
  setEffects: "Change effects",
  setShapePath: "Reshape",
  editPath: "Edit path",
  setPathKey: "Set path key",
  removePathKey: "Remove path key",
  movePathKey: "Move path key",
  createColourKey: "Add colour key",
  updateColourKey: "Change colour key",
  moveColourKey: "Move colour key",
  removeColourKey: "Remove colour key",
  setTextAnimator: "Change text animator",
  applyTextAnimatorPreset: "Apply text animator preset",
  linkPaths: "Link paths",
  unlinkPath: "Unlink path",
  removeSubpath: "Remove subpath",
  addGuide: "Add guide",
  moveGuide: "Move guide",
  removeGuide: "Remove guide",
} as const satisfies Record<EditKind, string>;

/** The part of the app a step came from, in the words of that panel's own heading. */
export const MODULE_WORDS = {
  scene: "Scene",
  viewport: "Composition",
  objectManager: "Elements",
  inspector: "Properties",
  timeline: "Timeline",
  animation: "Animation",
  materials: "Materials",
  fonts: "Fonts",
  textStyles: "Text styles",
  assets: "Assets",
  takePage: "Take page",
  bindings: "Data",
  controlContract: "Template controls",
} as const satisfies Record<EditorModule, string>;

function editWords(kind: string): string {
  // A kind this page has no word for (a newer engine) is shown by its own name, never hidden.
  return (EDIT_WORDS as Readonly<Record<string, string>>)[kind] ?? kind;
}

/** One step in words: what it did, how much of it, and what it was about. */
export function stepTitle(step: HistoryStep): string {
  const [first, ...rest] = step.edits;
  if (first === undefined) return "Change";
  let title = editWords(first);
  if (rest.length > 0) {
    title = rest.every((kind) => kind === first)
      ? `${title} (${step.edits.length} times)`
      : `${title} and ${rest.length} more`;
  }
  return step.about === undefined ? title : `${title}: ${step.about}`;
}

export interface HistoryRow {
  /** The step a click goes to. Absent on the first row, the scene as opened. */
  readonly step?: number;
  readonly title: string;
  /** The part of the app that made the step. Empty on the first row. */
  readonly from: string;
  /** False for a step that is undone and can be redone. The first row is always applied. */
  readonly applied: boolean;
  /** The scene is in the state just after this row. */
  readonly current: boolean;
}

/** The list's rows, oldest first, with the scene as opened on top.
 *
 *  One row is current when the applied steps are the first ones and the undone steps the rest, which
 *  is always so unless a part of the app undid its own step from under later ones. Then no row is
 *  current: the scene is not in the state just after any single row, and a click on a row puts it
 *  there (every step up to that row applied). */
export function historyRows(view: HistoryView): HistoryRow[] {
  const appliedCount = view.steps.filter((step) => step.applied).length;
  const inOrder = view.steps.every((step, index) => step.applied === index < appliedCount);
  const opening: HistoryRow = {
    title: view.folded === 0 ? "Scene as opened" : `Scene as opened, and ${view.folded} older ${view.folded === 1 ? "change" : "changes"}`,
    from: "",
    applied: true,
    current: inOrder && appliedCount === 0,
  };
  return [
    opening,
    ...view.steps.map((step, index) => ({
      step: step.id,
      title: stepTitle(step),
      from: MODULE_WORDS[step.module],
      applied: step.applied,
      current: inOrder && index === appliedCount - 1,
    })),
  ];
}

/** The line above the list: how much there is, how much of it is undone, and the limit once it bites. */
export function historySummary(view: HistoryView): string {
  const total = view.steps.length;
  if (total === 0 && view.folded === 0) return "No changes yet. Each change to this scene will be listed here.";
  const undone = view.steps.filter((step) => !step.applied).length;
  const parts = [`${total} ${total === 1 ? "change" : "changes"}`];
  if (undone > 0) parts.push(`${undone} undone`);
  let line = `${parts.join(", ")}. Click a line to take the scene there.`;
  if (view.folded > 0) line += ` Only the last ${view.limit} can be undone.`;
  return line;
}
