// The dock panels that are on demand (visibility decision of 26 Nov 2026, docs/design/ui-visibility-2026-11-26.md; Figma "Editor UI
// v2"). Every panel keeps its place in the layout and its state: the page only hides the ones nothing calls for, and shows one the
// moment it is called (the Panels menu, a Library tab, the tool, or the selection).
//
//   - Pivot, Masks and Effect Controls stand under Properties when the tool or the selection has something for them: Pivot while
//     the Pivot tool is in use, Masks when a selected element has masks or the Pen is about to draw one, Effect Controls when a
//     selected element has effects.
//   - The Animation panel waits until opened (Motion > Motion controls): the diamonds on the Properties rows key a property, and
//     Auto-key is the KEYFRAME bar's toggle (Jev, 26 Nov 2026, docs/evidence/figma-ui/jev-laya-properties-sections.json).
//   - The Preview's transport is in the timeline's bar and Not drawn is the viewport footer's chip, so both panels wait until opened.
//   - Text styles, Fonts, Effects & Presets, Materials and the Scenes list are the library: opened from the Library's tabs, the Panels
//     menu, File > Open or the + on the scene tabs.
//
// Going back to Properties (its tab) puts the opened ones of that group away again.

export interface OnDemandInput {
  /** The tool the pointer has. */
  readonly tool: string;
  /** Whether a selected element has masks. */
  readonly selectionHasMasks: boolean;
  /** Whether a selected element has effects. */
  readonly selectionHasEffects: boolean;
  /** Whether the next Pen path will be a mask. */
  readonly penMakesMask: boolean;
  /** The panels the person opened by hand. */
  readonly opened: ReadonlySet<string>;
}

/** Shown only when the tool or the selection calls for them, or when opened. */
export const CONTEXT_PANELS = ["pivot", "masks", "effect-controls"] as const;
/** Shown only when opened. */
export const OPENED_ONLY_PANELS = ["preview", "unsupported", "animation", "text-styles", "fonts", "effects", "materials", "scene-manager"] as const;

const PATH_TOOLS = ["pen", "path", "vertex-add", "vertex-delete", "vertex-convert"];

/** The dock panels to hide now. */
export function hiddenPanels(input: OnDemandInput): Set<string> {
  const hidden = new Set<string>();
  const wanted: Record<(typeof CONTEXT_PANELS)[number], boolean> = {
    pivot: input.tool === "pivot",
    masks: input.selectionHasMasks || (PATH_TOOLS.includes(input.tool) && input.penMakesMask),
    "effect-controls": input.selectionHasEffects,
  };
  for (const panel of CONTEXT_PANELS) if (!wanted[panel] && !input.opened.has(panel)) hidden.add(panel);
  for (const panel of OPENED_ONLY_PANELS) if (!input.opened.has(panel)) hidden.add(panel);
  return hidden;
}

/** The tab a group shows: its active one, or when that is hidden the first of its members that is not; undefined when all are hidden. */
export function shownTab(members: readonly string[], active: string, hidden: ReadonlySet<string>): string | undefined {
  if (!hidden.has(active)) return active;
  return members.find((member) => !hidden.has(member));
}

/** The opened panels left after the person goes back to `panel`'s tab: going back to Properties puts its group's opened ones away. */
export function afterTab(opened: ReadonlySet<string>, panel: string, groupMembers: readonly string[]): Set<string> {
  if (panel !== "inspector") return new Set(opened);
  return new Set([...opened].filter((id) => !groupMembers.includes(id)));
}

/**
 * The context panels drawn as sections under Properties (Figma B3d v2, "Properties, one list"): while Properties is the group's
 * shown tab, each of its context panels that is called for stands below the list in the same column, in the group's order, and
 * its tab is not drawn. None when another tab is shown.
 */
export function sectionsUnder(members: readonly string[], shown: string | undefined, hidden: ReadonlySet<string>): string[] {
  if (shown !== "inspector") return [];
  return members.filter((member) => (CONTEXT_PANELS as readonly string[]).includes(member) && !hidden.has(member));
}
