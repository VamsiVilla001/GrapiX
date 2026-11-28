// Which toolbar groups are on screen now (the visibility decision of 26 Nov 2026, docs/design/ui-visibility-2026-11-26.md; Figma
// "Editor UI v2", B2v2 Pen active).
//
// The core tools are always there. The rest is on demand, never removed: the path tools (Pen mode, Edit path, Add, Delete and Convert
// vertex, and what the Pen will make) show while the Pen or path editing is the tool; Hand and Zoom are reached by their keys (H, Z)
// and show only while one of them is the tool, so the person can see which tool the pointer has; the line-up and spread buttons
// show when two or more elements are selected, the only time they can act. Every one of them is also a menu item, and its key works
// whether or not its button is on screen.

export const PATH_CONTEXT_TOOLS: readonly string[] = ["pen", "path", "vertex-add", "vertex-delete", "vertex-convert"];

export interface ToolbarContext {
  /** The path tools and the Pen's mode and note. */
  readonly pen: boolean;
  readonly hand: boolean;
  readonly zoom: boolean;
  /** Line up and spread. */
  readonly lineUp: boolean;
}

export function toolbarContext(tool: string, selectedCount: number): ToolbarContext {
  return {
    pen: PATH_CONTEXT_TOOLS.includes(tool),
    hand: tool === "hand",
    zoom: tool === "zoom",
    lineUp: selectedCount >= 2,
  };
}
