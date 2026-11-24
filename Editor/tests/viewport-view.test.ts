// Hand and Zoom (11.105): the buttons, the keys, the menu items and the page's handling, and that the overlay's handles keep
// one size on the screen at any zoom.
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { APP_MENUS, actionOf, commandsOf } from "../src/app-menu";
import { EMPTY_CONTEXT, SHORTCUTS, commandById, decideKey, unavailable, type CommandContext, type KeyFocus, type KeyPress } from "../src/command-registry";
import { buildViewportOverlay, renderViewportOverlay } from "../src/overlay";
import page from "../web/index.html?raw";
import main from "../web/main.ts?raw";

const open: CommandContext = { ...EMPTY_CONTEXT, sceneOpen: true };
const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({
  key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, ...more,
});
const nowhere: KeyFocus = { editing: false, control: false };

function rect(id: string): SceneObject {
  return {
    type: "rect", id, name: id, visible: true, locked: false, opacity: 1, x: 100, y: 100, zDepth: 0, zIndex: 0, layerId: "",
    width: 200, height: 100, rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, strokeWidth: 0, radius: 0,
  } as unknown as SceneObject;
}
const scene = (objects: SceneObject[]): SceneDocument =>
  ({ objects, timeline: { channels: [], phases: [], pathChannels: [] }, canvas: { width: 1920, height: 1080 } }) as unknown as SceneDocument;

describe("the tools and the view commands", () => {
  const view = ["layout.fit", "layout.zoom-in", "layout.zoom-out", "layout.zoom-100"];

  it("are built commands of the registry: Hand and Zoom click their ribbon buttons, the view commands run natively", () => {
    expect(commandById("edit.hand")).toMatchObject({ invoke: "tool-hand", shortcut: "H" });
    expect(commandById("edit.zoom")).toMatchObject({ invoke: "tool-zoom", shortcut: "Z" });
    const natives = { "layout.fit": "view-fit", "layout.zoom-in": "view-zoom-in", "layout.zoom-out": "view-zoom-out", "layout.zoom-100": "view-zoom-100" };
    for (const [id, native] of Object.entries(natives)) {
      expect(commandById(id)?.native, id).toBe(native);
      expect(actionOf(commandById(id)!), id).toBe("native");
    }
  });

  it("have the keys the menu shows, and the View keys use Ctrl", () => {
    const labels: Record<string, string> = { "layout.fit": "Ctrl 0", "layout.zoom-in": "Ctrl =", "layout.zoom-out": "Ctrl -", "layout.zoom-100": "Ctrl 1", "edit.hand": "H", "edit.zoom": "Z" };
    for (const [id, label] of Object.entries(labels)) {
      expect(commandById(id)?.shortcut, id).toBe(label);
      expect(SHORTCUTS.find((s) => s.command === id && s.label !== undefined)?.label, id).toBe(label);
    }
  });

  it("need a scene to look at, and say so in the registry's words", () => {
    for (const id of [...view, "edit.hand", "edit.zoom"]) {
      expect(unavailable(id, EMPTY_CONTEXT), id).toBe("no scene is open");
      expect(unavailable(id, open), id).toBeUndefined();
    }
  });

  it("run from the keys with a scene open, zoom repeats when held, and Ctrl + works as well as Ctrl =", () => {
    expect(decideKey(press("0", { ctrlKey: true }), nowhere, open)).toEqual({ kind: "run", command: "layout.fit" });
    expect(decideKey(press("1", { ctrlKey: true }), nowhere, open)).toEqual({ kind: "run", command: "layout.zoom-100" });
    expect(decideKey(press("=", { ctrlKey: true }), nowhere, open)).toEqual({ kind: "run", command: "layout.zoom-in" });
    expect(decideKey(press("+", { ctrlKey: true, shiftKey: true }), nowhere, open)).toEqual({ kind: "run", command: "layout.zoom-in" });
    expect(decideKey(press("-", { ctrlKey: true }), nowhere, open)).toEqual({ kind: "run", command: "layout.zoom-out" });
    expect(decideKey(press("=", { ctrlKey: true, repeat: true }), nowhere, open)).toEqual({ kind: "run", command: "layout.zoom-in" });
    expect(decideKey(press("-", { ctrlKey: true, repeat: true }), nowhere, open)).toEqual({ kind: "run", command: "layout.zoom-out" });
    expect(decideKey(press("0", { ctrlKey: true, repeat: true }), nowhere, open)).toEqual({ kind: "pass" });
    expect(decideKey(press("h"), nowhere, open)).toEqual({ kind: "run", command: "edit.hand" });
    expect(decideKey(press("z"), nowhere, open)).toEqual({ kind: "run", command: "edit.zoom" });
  });

  it("do not take the keys of a text field, and a Ctrl key with no scene is refused out loud so the browser's own zoom does not take it", () => {
    const typing: KeyFocus = { editing: true, control: false };
    expect(decideKey(press("h"), typing, open)).toEqual({ kind: "pass" });
    expect(decideKey(press("0", { ctrlKey: true }), typing, open)).toEqual({ kind: "pass" });
    expect(decideKey(press("0", { ctrlKey: true }), nowhere, EMPTY_CONTEXT)).toMatchObject({ kind: "refused", reason: "no scene is open", quiet: false });
    expect(decideKey(press("h"), nowhere, EMPTY_CONTEXT)).toMatchObject({ kind: "refused", quiet: true });
  });

  it("are in the Edit and Layout menus, not in a menu of their own, so the bar still has its eight", () => {
    const edit = commandsOf(APP_MENUS.find((m) => m.id === "edit")!.items).map((c) => c.id);
    const layout = commandsOf(APP_MENUS.find((m) => m.id === "layout")!.items).map((c) => c.id);
    expect(edit).toEqual(expect.arrayContaining(["edit.hand", "edit.zoom"]));
    expect(layout).toEqual(expect.arrayContaining(view));
    expect(APP_MENUS).toHaveLength(8);
  });
});

describe("the page's controls", () => {
  it("has a Hand and a Zoom button in the ribbon, each with its icon", async () => {
    expect(page).toMatch(/id="tool-hand"[^>]*data-tool="hand"[^>]*data-menu-item="edit\.hand"/);
    expect(page).toMatch(/id="tool-zoom"[^>]*data-tool="zoom"[^>]*data-menu-item="edit\.zoom"/);
    for (const name of ["tool-hand", "tool-zoom"]) {
      const svg = ((await import(`../web/icons/${name}.svg?raw`)) as { default: string }).default;
      expect(svg, name).toContain("<svg");
    }
  });

  it("has Fit, Zoom out, the percent and Zoom in in the footer, each one a command of the registry", () => {
    const wanted: [string, string, string][] = [
      ["viewer-fit", "layout.fit", "view-fit"],
      ["viewer-zoom-out", "layout.zoom-out", "view-zoom-out"],
      ["viewer-zoom-readout", "layout.zoom-100", "view-zoom-100"],
      ["viewer-zoom-in", "layout.zoom-in", "view-zoom-in"],
    ];
    for (const [id, command, native] of wanted) {
      expect(page, id).toMatch(new RegExp(`id="${id}"[^>]*data-menu-item="${command.replace(".", "\\.")}" data-native="${native}"`));
      expect(commandById(command)?.native, id).toBe(native);
    }
    // Their old stand-in was a label that did nothing.
    expect(page).not.toContain('<span class="viewer-fit">');
  });

});

describe("the page moves the view", () => {
  it("pans with the middle button for any tool, and with the main button for the Hand tool, and zooms where the Zoom tool is clicked", () => {
    expect(main).toMatch(/if \(previewScene && \(event\.button === 1 \|\| \(event\.button === 0 && activeTool === "hand"\)\)\) \{\s*startPan\(event\);\s*return;\s*\}/);
    expect(main).toMatch(/if \(previewScene && event\.button === 0 && activeTool === "zoom"\) \{\s*event\.preventDefault\(\);\s*zoomView\(event\.altKey \? 1 \/ ZOOM_STEP : ZOOM_STEP, paneOffset\(event\.clientX, event\.clientY\)\);\s*return;\s*\}/);
  });

  it("starts a pan from the camera as it is, captures the pointer, and lets the cursor go when it ends", () => {
    expect(main).toMatch(/panning = \{ pointerId: event\.pointerId, x: event\.clientX, y: event\.clientY, camera \};\s*ui\.overlay\.setPointerCapture\(event\.pointerId\);\s*ui\.overlay\.dataset\.panning = "true";/);
    expect(main).toMatch(/if \(ui\.overlay\.hasPointerCapture\(event\.pointerId\)\) ui\.overlay\.releasePointerCapture\(event\.pointerId\);\s*panning = undefined;\s*delete ui\.overlay\.dataset\.panning;/);
  });

  it("takes the pan before any other tool, on the way in and the way out", () => {
    expect(main).toMatch(/function onOverlayPointerMove\(event: PointerEvent\): void \{\s*if \(panning !== undefined && panning\.pointerId === event\.pointerId\) \{\s*movePan\(event\);\s*return;/);
    expect(main).toMatch(/function finishOverlayPointer\(event: PointerEvent, cancelled: boolean\): void \{\s*if \(panning !== undefined && panning\.pointerId === event\.pointerId\) \{\s*endPan\(event\);\s*return;/);
  });

  it("zooms with the wheel at the pointer, moves across with Shift, and turns lines and pages into pixels", () => {
    expect(main).toMatch(/\.addEventListener\("wheel", onViewWheel, \{ passive: false \}\)/);
    expect(main).toMatch(/event\.deltaY \* \(event\.deltaMode === 1 \? 16 : event\.deltaMode === 2 \? 400 : 1\)/);
    expect(main).toMatch(/if \(event\.shiftKey && !event\.ctrlKey\) \{[\s\S]*?setCamera\(panBy\(camera, -pixels, 0, pane, picture\)\);\s*return;\s*\}\s*zoomView\(wheelFactor\(pixels\), paneOffset\(event\.clientX, event\.clientY\)\);/);
    expect(main).toMatch(/function onViewWheel\(event: WheelEvent\): void \{\s*if \(!scene\) return;\s*event\.preventDefault\(\);/);
  });

  it("measures the pane from the middle of the stage, and the picture and pane by their layout size", () => {
    expect(main).toMatch(/x: clientX - \(stage\.left \+ stage\.width \/ 2\), y: clientY - \(stage\.top \+ stage\.height \/ 2\)/);
    expect(main).toMatch(/pane: \{ width: surface\?\.offsetWidth \?\? 0, height: surface\?\.offsetHeight \?\? 0 \},\s*picture: \{ width: ui\.canvas\.offsetWidth, height: ui\.canvas\.offsetHeight \}/);
    expect(main).toMatch(/ui\.viewportBackdrop\.style\.width = `\$\{ui\.canvas\.offsetWidth\}px`;/);
  });

  it("puts the camera on the surface and the percent in the footer, and keeps it inside the pane", () => {
    expect(main).toMatch(/camera = clampPan\(camera, pane, picture\);\s*const surface = viewSurface\(\);\s*if \(surface\) surface\.style\.transform = cameraTransform\(camera\);\s*ui\.viewerZoomReadout\.textContent = zoomLabel\(camera, fitScale\(\)\) \|\| "100%";/);
    expect(main).toMatch(/new ResizeObserver\(\(\) => \{\s*applyBackdrop\(\);\s*syncCamera\(\);\s*\}\)\.observe\(ui\.canvas\);/);
  });

  it("starts another scene at Fit, since the view is the Editor's and not the scene's", () => {
    expect(main).toMatch(/if \(sceneKey !== cameraScene\) \{\s*cameraScene = sceneKey;\s*camera = FIT;\s*syncCamera\(\);\s*\}/);
  });

  it("runs the four view commands, going to Fit, in, out and to 100 percent about the middle", () => {
    expect(main).toMatch(/case "view-fit":\s*setCamera\(FIT\);/);
    expect(main).toMatch(/case "view-zoom-in":\s*zoomView\(ZOOM_STEP\);/);
    expect(main).toMatch(/case "view-zoom-out":\s*zoomView\(1 \/ ZOOM_STEP\);/);
    expect(main).toMatch(/case "view-zoom-100": \{\s*const \{ pane, picture \} = viewSizes\(\);\s*setCamera\(atPercent\(camera, 100, fitScale\(\), pane, picture\)\);/);
  });

  it("gives the overlay the size of a screen pixel, and dims the footer's buttons like the ribbon's", () => {
    expect(main).toContain("unit: overlayUnit(),");
    expect(main).toMatch(/return active !== null && box\.width > 0 \? active\.canvas\.width \/ box\.width : 1;/);
    expect(main).toContain(".creation-tools button[data-menu-item], .viewer-footer button[data-menu-item]");
  });

  it("is not drawn into the document: nothing of the view reaches a command", () => {
    const view = main.slice(main.indexOf("let camera: Camera = FIT;"), main.indexOf("// The Pen tool (11.104)."));
    expect(view).not.toMatch(/runEdits|runCommand|execute\(|shell\(\)\.invoke/);
  });
});

/** A stand-in for the few SVG calls the overlay's renderer makes. */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }
}

describe("the overlay at any zoom", () => {
  const document = scene([rect("a")]);
  const sizes = (unit?: number) => {
    const model = buildViewportOverlay(document, { selectedIds: ["a"], ...(unit === undefined ? {} : { unit }) });
    const svg = new FakeElement("svg");
    renderViewportOverlay({ createElementNS: (_ns: string, tag: string) => new FakeElement(tag) } as unknown as Document, svg as unknown as SVGSVGElement, model);
    const handle = svg.children.find((child) => child.attributes.get("class") === "overlay-handle")!;
    return { unit: model.unit, width: Number(handle.attributes.get("width")), x: Number(handle.attributes.get("x")) };
  };

  it("draws a handle ten canvas pixels wide at one pixel to the pixel, and bigger in canvas pixels when zoomed out", () => {
    expect(sizes().width).toBe(10);
    expect(sizes(1).width).toBe(10);
    expect(sizes(4).width).toBe(40);
  });

  it("makes a handle smaller in canvas pixels when zoomed in, so it keeps one size on the screen", () => {
    expect(sizes(0.25).width).toBe(2.5);
    expect(sizes(0.25).unit).toBe(0.25);
  });

  it("keeps the handle centred on its corner at every zoom", () => {
    // The first handle is the top left corner of a box at (100, 100).
    expect(sizes(1).x).toBe(95);
    expect(sizes(4).x).toBe(80);
    expect(sizes(0.5).x).toBe(97.5);
  });

  it("scales the pen's points and the pivot marker with it too", () => {
    const sketch = { d: "M 0 0", vertices: [{ x: 50, y: 60, first: true }, { x: 90, y: 60, first: false }], handles: [{ x1: 90, y1: 60, x2: 110, y2: 70 }], closing: false };
    const render = (unit: number) => {
      const model = buildViewportOverlay(scene([rect("a")]), { selectedIds: ["a"], pivots: true, pen: sketch, unit });
      const svg = new FakeElement("svg");
      renderViewportOverlay({ createElementNS: (_ns: string, tag: string) => new FakeElement(tag) } as unknown as Document, svg as unknown as SVGSVGElement, model);
      const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
      const nodes = all(svg);
      const byClass = (name: string) => nodes.filter((n) => n.attributes.get("class")?.split(" ").includes(name));
      return {
        firstVertex: Number(byClass("overlay-pen-vertex")[0]!.attributes.get("width")),
        otherVertex: Number(byClass("overlay-pen-vertex")[1]!.attributes.get("width")),
        handleEnd: Number(byClass("overlay-pen-handle-end")[0]!.attributes.get("r")),
        pivotRing: Number(nodes.find((n) => n.tag === "circle" && !n.attributes.has("class"))!.attributes.get("r")),
        pivotArm: Number(nodes.find((n) => n.tag === "line" && !n.attributes.has("class"))!.attributes.get("x2")) - 100,
      };
    };
    expect(render(1)).toEqual({ firstVertex: 14, otherVertex: 10, handleEnd: 4, pivotRing: 9, pivotArm: 16 });
    expect(render(0.5)).toEqual({ firstVertex: 7, otherVertex: 5, handleEnd: 2, pivotRing: 4.5, pivotArm: 8 });
    expect(render(3)).toEqual({ firstVertex: 42, otherVertex: 30, handleEnd: 12, pivotRing: 27, pivotArm: 48 });
  });

  it("uses one for a unit that is not a positive number", () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) expect(sizes(bad).unit, String(bad)).toBe(1);
  });
});
