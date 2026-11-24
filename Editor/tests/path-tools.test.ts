// The page's side of the path tools (11.107) and the Pen's spec modifiers (11.104): that the pointer and keys reach the pure
// models, one gesture is one editPath edit, and the overlay shows what is edited. The models have their own tests.
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { APP_MENUS, commandsOf } from "../src/app-menu";
import { SHORTCUTS, decideKey, unavailable } from "../src/command-registry";
import { buildViewportOverlay, renderViewportOverlay } from "../src/overlay";
import { pathEditSketch, editTarget, isRefused } from "../src/path-edit";
import { EDIT_WORDS } from "../src/history-list";
import html from "../web/index.html?raw";
import main from "../web/main.ts?raw";


const z = { x: 0, y: 0 };
const shape = {
  id: "s", name: "Shape", type: "shape", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 100, height: 100, locked: false, visible: true,
  path: { closed: true, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], inTangents: [z, z, z], outTangents: [z, z, z] },
} as unknown as SceneObject;
const doc = { canvas: { width: 1920, height: 1080 }, objects: [shape] } as unknown as SceneDocument;

describe("the path tools are commands of the registry", () => {
  const ids = ["edit.path", "edit.vertex-add", "edit.vertex-delete", "edit.vertex-convert"];
  const items = commandsOf(APP_MENUS.find((m) => m.id === "edit")!.items);

  it("have a menu item, a ribbon button and a key each", () => {
    const expected: Record<string, [string, string, string]> = {
      "edit.path": ["tool-path", "A", "path"],
      "edit.vertex-add": ["tool-vertex-add", "=", "vertex-add"],
      "edit.vertex-delete": ["tool-vertex-delete", "-", "vertex-delete"],
      "edit.vertex-convert": ["tool-vertex-convert", "C", "vertex-convert"],
    };
    for (const id of ids) {
      const [button, key, tool] = expected[id]!;
      expect(items.find((c) => c.id === id)).toMatchObject({ invoke: button, shortcut: key });
      expect(html).toContain(`id="${button}"`);
      expect(html).toContain(`data-tool="${tool}"`);
      expect(html).toContain(`data-menu-item="${id}"`);
      expect(SHORTCUTS.find((s) => s.command === id)).toMatchObject({ label: key, quiet: true });
    }
  });

  it("are refused with no scene, and take their keys quietly", () => {
    const ctx = { sceneOpen: true, projectOpen: true, selectionCount: 0, canUndo: false, canRedo: false, busy: false } as never;
    const none = { sceneOpen: false, projectOpen: false, selectionCount: 0, canUndo: false, canRedo: false, busy: false } as never;
    for (const id of ids) {
      expect(unavailable(id, none)).toBeDefined();
      expect(unavailable(id, ctx)).toBeUndefined();
    }
    const press = (key: string) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false });
    expect(decideKey(press("a"), { editing: false, control: false }, ctx)).toMatchObject({ command: "edit.path" });
    expect(decideKey(press("a"), { editing: false, control: false }, none)).toMatchObject({ quiet: true });
  });

  it("show up in the history under their own words", () => {
    expect(EDIT_WORDS.editPath).toBe("Edit path");
  });
});

describe("the page sends the pointer to the path tools", () => {
  it("routes down, move, up, keys and double click, and leaves the tools' state when another tool is chosen", () => {
    expect(main).toMatch(/if \(isPathTool\(activeTool\) && scene\) \{\s*pathPointerDown\(event\);\s*return;\s*\}/);
    expect(main).toMatch(/if \(isPathTool\(activeTool\) && previewScene && scene\) \{\s*pathPointerMove\(event\);\s*return;\s*\}/);
    expect(main).toMatch(/if \(isPathTool\(activeTool\)\) \{\s*pathPointerUp\(event, cancelled\);\s*return;\s*\}/);
    expect(main).toMatch(/if \(isPathTool\(activeTool\) && pathKey\(event\)\) return;/);
    expect(main).toMatch(/if \(activeTool === "path"\) pathDoubleClick\(event\);/);
    expect(main).toMatch(/if \(!isPathTool\(tool\) && tool !== "hand" && tool !== "zoom"\) \{\s*dropPathState\(\);\s*pathMask = undefined;\s*\}/);
  });

  it("sends a whole gesture as ONE editPath edit, and keeps the preview up until Rust has answered", () => {
    // 11.112: the frame goes with the edit when the path is animated or being keyed.
    expect(main).toMatch(/const frame = pathEditFrame\(target, subpath, pathKeying\);/);
    expect(main).toMatch(/void runEdits\(\[editPathEdit\(id, subpath, op, target\.mask, frame, pathEditRevision\(target, subpath\)\)\], \{ label: `\$\{label\} of \$\{target\.object\.name\}\$\{frame === undefined \? "" : ` at frame \$\{frame\}`\}` \}, "viewport"\)/);
    expect(main).toMatch(/\.finally\(\(\) => \{\s*pathPreview = undefined;\s*renderOverlayLayer\(\);/);
    // Moving does not send anything until the pointer is up.
    const move = /function pathPointerMove[\s\S]*?\n\}/.exec(main)![0];
    expect(move).not.toContain("runEdits");
    expect(move).not.toContain("sendPathOp");
  });

  it("keeps the vertex selection after an edit that does not change the vertex count, and clears it after one that does", () => {
    expect(main).toMatch(/const keeps = op\.op === "moveVertices" \|\| op\.op === "setHandle" \|\| op\.op === "reshapeSegment" \|\| op\.op === "convertVertex" \|\| op\.op === "setVertexKind";/);
    expect(main).toMatch(/if \(!keeps\) pathSelected = \[\];/);
  });

  it("drops a drag with Escape, then the selection, and takes Delete for the selected vertices", () => {
    expect(main).toMatch(/if \(pathGesture !== undefined\) \{[\s\S]*?pathGesture = undefined;\s*pathPreview = undefined;\s*marquee = undefined;\s*\} else if \(pathSelected\.length > 0\) pathSelected = \[\];\s*else return false;/);
    expect(main).toMatch(/\(event\.key === "Delete" \|\| event\.key === "Backspace"\) && pathSelected\.length > 0/);
  });

  it("picks within ten screen pixels, whatever the zoom", () => {
    expect(main).toMatch(/const pathRadius = \(\): number => editorPen\.pick \* overlayUnit\(\);/);
  });

  it("does nothing on a locked, grouped or non-shape selection but say why", () => {
    expect(main).toMatch(/if \(isRefused\(target\)\) \{\s*if \(selection\.length > 0\) log\(`\$\{toolWords\(activeTool\)\}: \$\{target\.refused\}`, "bad"\);/);
  });
});

describe("the pen's spec modifiers", () => {
  it("carry a path on from an end of the selected open shape, only where the canvas and the path agree", () => {
    expect(main).toMatch(/if \(pen\.points\.length === 0 && tryResume\(at\)\) \{/);
    expect(main).toMatch(/const placed = where\.x === 0 && where\.y === 0 && where\.rotation === 0 && where\.scaleX === 1 && where\.scaleY === 1 && where\.anchorX === 0 && where\.anchorY === 0;/);
    expect(main).toMatch(/if \(object\.compoundPaths !== undefined && object\.compoundPaths\.length > 0\) return false;/);
  });

  it("stop Space and the pull from clashing with play, and forget them when the pointer lets go", () => {
    expect(main).toMatch(/ui\.overlay\.addEventListener\("keyup", \(event\) => \{\s*if \(event\.key === " " && penSpace\) penSpace = false;/);
    expect(main).toMatch(/penPull = undefined;\s*penSpace = false;\s*penLastAt = undefined;/);
  });
});

describe("the overlay shows the path being edited", () => {
  const target = editTarget(doc, ["s"]);
  if (isRefused(target)) throw new Error(target.refused);

  it("draws it, and leaves out the box handles that would sit in the way", () => {
    const sketch = pathEditSketch(target, [{ subpath: 0, index: 1 }]);
    const edited = buildViewportOverlay(doc, { selectedIds: ["s"], pathEdit: sketch });
    expect(edited.primitives.some((p) => p.kind === "pathEdit")).toBe(true);
    expect(edited.primitives.some((p) => p.kind === "handle")).toBe(false);
    expect(edited.primitives.some((p) => p.kind === "selection")).toBe(true);
    const plain = buildViewportOverlay(doc, { selectedIds: ["s"] });
    expect(plain.primitives.filter((p) => p.kind === "handle")).toHaveLength(8);
    expect(plain.primitives.some((p) => p.kind === "pathEdit")).toBe(false);
  });
});

describe("the gaps the mutants found", () => {
  it("passes the edited path to the overlay, and swaps corner and smooth only on a vertex", () => {
    expect(main).toMatch(/\.\.\.pathSketchFor\(active\),/);
    expect(main).toMatch(/const planned = clickOp\(hit\.kind === "vertex" \? "convert" : "add", hit, target\);/);
  });

  it("draws a selected vertex as selected and the rest plainly", () => {
    class Fake {
      readonly attributes = new Map<string, string>();
      readonly children: Fake[] = [];
      constructor(readonly tag: string) {}
      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
      append(...c: Fake[]): void {
        this.children.push(...c);
      }
      replaceChildren(...c: Fake[]): void {
        this.children.length = 0;
        this.children.push(...c);
      }
    }
    const target = editTarget(doc, ["s"]);
    if (isRefused(target)) throw new Error(target.refused);
    const model = buildViewportOverlay(doc, { selectedIds: ["s"], pathEdit: pathEditSketch(target, [{ subpath: 0, index: 1 }]) });
    const svg = new Fake("svg");
    renderViewportOverlay({ createElementNS: (_n: string, tag: string) => new Fake(tag) } as unknown as Document, svg as unknown as SVGSVGElement, model);
    const all = (n: Fake): Fake[] => [n, ...n.children.flatMap(all)];
    const classes = all(svg).map((n) => n.attributes.get("class")).filter((c) => c?.startsWith("overlay-path-vertex"));
    expect(classes).toEqual(["overlay-path-vertex", "overlay-path-vertex is-selected", "overlay-path-vertex"]);
  });
});
