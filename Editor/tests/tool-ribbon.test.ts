// The tool ribbon (11.102): every button is a command of the one registry, shows the same action as its menu item, has an icon
// that exists, and the page drags with the tool through one batch of edits.
import { describe, expect, it } from "vitest";
import { actionOf, commandsOf, APP_MENUS } from "../src/app-menu";
import { SHORTCUTS, commandById } from "../src/command-registry";
import page from "../web/index.html?raw";
import main from "../web/main.ts?raw";

/** An icon file's text, or nothing when the page names an icon that is not there. */
async function icon(name: string): Promise<string | undefined> {
  try {
    return ((await import(`../web/icons/${name}.svg?raw`)) as { default: string }).default;
  } catch {
    return undefined;
  }
}

interface Button {
  readonly menuItem: string;
  readonly attrs: string;
}

/** The buttons of the ribbon, read from the page. */
function ribbon(): Button[] {
  const start = page.indexOf('class="creation-tools"');
  const end = page.indexOf('<span class="tool-description">', start);
  const block = page.slice(start, end);
  return [...block.matchAll(/<button\b([^>]*)>/g)].map((m) => {
    const attrs = m[1]!;
    return { menuItem: /data-menu-item="([^"]+)"/.exec(attrs)?.[1] ?? "", attrs };
  });
}

const attr = (button: Button, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(button.attrs)?.[1];

describe("the ribbon's buttons", () => {
  it("has the tools, the create buttons and the line-up buttons an author expects", () => {
    expect(ribbon().map((b) => b.menuItem)).toEqual([
      "edit.pointer", "edit.move", "edit.rotate", "edit.resize", "edit.centre", "edit.pen", "edit.path", "edit.vertex-add", "edit.vertex-delete", "edit.vertex-convert", "edit.hand", "edit.zoom",
      "edit.add-object.rect", "edit.add-object.ellipse", "edit.add-object.text",
      "edit.line-up.left", "edit.line-up.centre", "edit.line-up.right",
      "edit.line-up.top", "edit.line-up.middle", "edit.line-up.bottom",
      "edit.line-up.spread-across", "edit.line-up.spread-down",
    ]);
  });

  it("is each a built command of the registry, never a second path", () => {
    for (const button of ribbon()) {
      const command = commandById(button.menuItem);
      expect(command, button.menuItem).toBeDefined();
      expect(actionOf(command!), `${button.menuItem} is built`).not.toBe("unbuilt");
    }
  });

  it("runs the very action its menu item runs", () => {
    for (const button of ribbon()) {
      const command = commandById(button.menuItem)!;
      if (command.native !== undefined) expect(attr(button, "data-native"), button.menuItem).toBe(command.native);
      if (command.createKind !== undefined) expect(attr(button, "data-create-kind"), button.menuItem).toBe(command.createKind);
      // A tool button is the control its menu item clicks.
      if (command.invoke !== undefined) expect(attr(button, "id"), button.menuItem).toBe(command.invoke);
    }
  });

  it("has an icon that exists, and a name for a screen reader", async () => {
    for (const button of ribbon()) {
      const name = attr(button, "data-icon");
      expect(name, button.menuItem).toBeDefined();
      expect(await icon(name!), `${name}.svg`).toContain("<svg");
      expect(attr(button, "aria-label"), button.menuItem).toBeDefined();
    }
    expect(await icon("no-such-icon")).toBeUndefined();
  });

  it("says its key in the tooltip, the same key the menu and the table have", () => {
    for (const button of ribbon()) {
      const command = commandById(button.menuItem)!;
      const title = attr(button, "title") ?? "";
      if (command.shortcut === undefined) {
        expect(title, button.menuItem).not.toMatch(/\([A-Z]\)$/);
        continue;
      }
      expect(title, button.menuItem).toContain(`(${command.shortcut})`);
      expect(SHORTCUTS.find((s) => s.command === command.id)?.label, button.menuItem).toBe(command.shortcut);
    }
  });

  it("marks exactly the Select tool as the one in use at the start", () => {
    const tools = ribbon().filter((b) => attr(b, "data-tool") !== undefined);
    expect(tools.map((b) => [attr(b, "data-tool"), attr(b, "aria-pressed")])).toEqual([
      ["select", "true"], ["move", "false"], ["rotate", "false"], ["scale", "false"], ["pivot", "false"], ["pen", "false"], ["path", "false"], ["vertex-add", "false"], ["vertex-delete", "false"], ["vertex-convert", "false"], ["hand", "false"], ["zoom", "false"],
    ]);
  });

  it("has the Pivot tool, which is the menu's Pivot point and the key Y", () => {
    const pivot = ribbon().find((b) => attr(b, "data-tool") === "pivot");
    expect(pivot?.menuItem).toBe("edit.centre");
    expect(attr(pivot!, "id")).toBe("tool-pivot");
    const centre = commandsOf(APP_MENUS.find((m) => m.id === "edit")!.items).find((c) => c.id === "edit.centre");
    expect(centre).toMatchObject({ invoke: "tool-pivot", shortcut: "Y" });
    expect(centre?.row).toBeUndefined();
  });

  it("has the Pivot panel in the page, with the nine places, the offset, the typed point, the nudge and the keep-in-place choice", () => {
    expect(page).toContain('data-panel="pivot"');
    const places = [...page.matchAll(/data-pivot-place="([^"]+)"/g)].map((m) => m[1]);
    expect(places).toEqual(["top-left", "top", "top-right", "left", "centre", "right", "bottom-left", "bottom", "bottom-right"]);
    for (const id of ["pivot-offset-x", "pivot-offset-y", "pivot-x", "pivot-y", "pivot-step", "pivot-keep", "pivot-reset", "pivot-scope", "pivot-error"]) {
      expect(page, id).toContain(`id="${id}"`);
    }
    expect([...page.matchAll(/data-pivot-nudge="([^"]+)"/g)].map((m) => m[1])).toEqual(["-1,0", "0,-1", "0,1", "1,0"]);
    expect(page).toMatch(/id="pivot-keep" type="checkbox" checked/);
  });
});

describe("the page drives the Pen tool", () => {
  it("is the menu's Pen and the key G, and a ribbon button", () => {
    const pen = ribbon().find((b) => attr(b, "data-tool") === "pen");
    expect(pen?.menuItem).toBe("edit.pen");
    expect(attr(pen!, "id")).toBe("tool-pen");
    const item = commandsOf(APP_MENUS.find((m) => m.id === "edit")!.items).find((c) => c.id === "edit.pen");
    expect(item).toMatchObject({ invoke: "tool-pen", shortcut: "G" });
  });

  it("sends the pointer to the pen, not to the drag tools or the marquee, while the Pen is in use", () => {
    expect(main).toMatch(/if \(activeTool === "pen" && scene\) \{\s*penPointerDown\(event\);\s*return;\s*\}/);
    expect(main).toMatch(/if \(activeTool === "pen" && previewScene && scene\) \{\s*penPointerMove\(event\);\s*return;\s*\}/);
    expect(main).toMatch(/if \(activeTool === "pen"\) \{\s*penPointerUp\(event\);\s*return;\s*\}/);
  });

  it("closes the path on a click on the first point and makes the shape at once", () => {
    // The click closes it; a drag from the first point also sets the tangents it closes with; the release ends it.
    expect(main).toMatch(/if \(nearFirst\(pen, at, penTolerance\(\)\)\) \{[^}]*?pen = closePath\(pen\);\s*penClosing = true;/);
    expect(main).toMatch(/if \(penClosing\) \{\s*penClosing = false;\s*finishPen\(\);\s*return;\s*\}/);
  });

  it("adds a point on press, and a drag after it pulls that point's handles", () => {
    expect(main).toMatch(/pen = addPoint\(pen, at, event\.shiftKey, editorPen\.angle\);\s*penScene = activeSession\(workspace\)\?\.key;\s*penPull = event\.pointerId;/);
    expect(main).toMatch(/if \(penPull === event\.pointerId\) \{[\s\S]*?pen = pullHandles\(pen, at, options\);/);
    expect(main).toMatch(/const options = \{ alt: event\.altKey, shift: event\.shiftKey, degrees: editorPen\.angle \};/);
  });

  it("takes Enter, Backspace, Delete and Escape for the path, ahead of the keys of the keyframes and the selection", () => {
    expect(main).toMatch(/if \(activeTool === "pen" && penKey\(event\)\) return;/);
    expect(main).toMatch(/if \(event\.key === "Enter"\) finishPen\(\);\s*else if \(event\.key === "Backspace" \|\| event\.key === "Delete"\) pen = removeLast\(pen\);\s*else if \(event\.key === "Escape"\) \{/);
    // Escape while a point is being placed takes that point back; with no pull it ends the path and keeps what is placed (spec 7).
    expect(main).toMatch(/\} else if \(pen\.points\.length >= 2\) finishPen\(\);\s*else cancelPen\(\);/);
    // Space while a point is placed moves it instead of playing the preview.
    expect(main).toMatch(/if \(event\.key === " " && penPull !== undefined\) \{\s*penSpace = true;\s*event\.preventDefault\(\);\s*return true;/);
    expect(main).toMatch(/event\.preventDefault\(\);\s*renderOverlayLayer\(\);\s*return true;/);
  });

  it("makes the path one batch that selects the new shape, and says by name why a path is not enough yet", () => {
    expect(main).toMatch(/: resumed === undefined \? penEdits\(scene, pen, `Pen path \$\{shapes \+ 1\}`\) : resumeEdits\(resumed, pen\);\s*if \(isRefused\(outcome\)\) \{\s*log\(`Pen: \$\{outcome\.refused\}`, "bad"\);/);
    expect(main).toMatch(/void runEdits\(outcome\.edits, \{\s*label,\s*select: \(effects\) => \{\s*for \(const effect of effects\) if \(effect\.effect === "objectCreated"\) return \[effect\.objectId\];\s*return resumed === undefined \? undefined : \[resumed\];/);
  });

  it("finishes on a double click without keeping the extra point it makes, and when another tool is chosen", () => {
    expect(main).toMatch(/Math\.hypot\(last\.x - before\.x, last\.y - before\.y\) < 1\) pen = removeLast\(pen\);/);
    expect(main).toMatch(/ui\.overlay\.addEventListener\("dblclick", \(event\) => \{[\s\S]*?if \(activeTool === "pen" && editorPen\.doubleClickEnds && event\.timeStamp - penFinishedAt >= 500\) finishPen\(\);/);
    expect(main).toMatch(/if \(activeTool === "pen" && tool !== "pen" && tool !== "hand" && tool !== "zoom"\) leavePen\(\);/);
    expect(main).toMatch(/function leavePen\(\): void \{\s*if \(pen\.points\.length >= 2\) finishPen\(\);[\s\S]*?if \(activeTool !== "pen"\) cancelPen\(\);/);
  });

  it("closes on a click within ten screen pixels of the first point, whatever the zoom", () => {
    expect(main).toContain("return box.width > 0 ? (10 * canvasWidth) / box.width : 10;");
  });

  it("does not start a new path from the second click of the double click that finished one", () => {
    expect(main).toMatch(/if \(event\.timeStamp - penFinishedAt < 500\) return;/);
    expect(main).toMatch(/penFinishedAt = performance\.now\(\);/);
  });

  it("never finishes a path in another scene than the one it was drawn in", () => {
    expect(main).toMatch(/if \(pen\.points\.length > 0 && penScene !== activeSession\(workspace\)\?\.key\) cancelPen\(\);/);
    expect(main).toMatch(/if \(penScene !== activeSession\(workspace\)\?\.key\) \{\s*log\("Pen: the path was drawn in another scene, so nothing was made\.", "bad"\);\s*cancelPen\(\);\s*return;/);
  });

  it("leaves Delete, Backspace, Enter and Escape alone when no path is being drawn", () => {
    expect(main).toMatch(/function penKey\(event: KeyboardEvent\): boolean \{[^}]*?if \(pen\.points\.length === 0\) return false;/);
  });

  it("gives the path back when the engine refuses the shape", () => {
    expect(main).toMatch(/\.then\(\(done\) => \{[\s\S]*?if \(done === undefined && pen\.points\.length === 0 && activeTool === "pen"\) \{\s*pen = kept;/);
  });

  it("draws the path being drawn, and the segment the pointer would add", () => {
    expect(main).toMatch(/\.\.\.\(pen\.points\.length > 0 && penScene === activeSession\(workspace\)\?\.key \? \{ pen: penSketch\(pen, penHover, penHover !== undefined && nearFirst\(pen, penHover, penTolerance\(\)\)\) \} : \{\}\),/);
    // And only in the scene it was drawn in.
    expect(main).toMatch(/\.\.\.\(pen\.points\.length > 0 && penScene === activeSession\(workspace\)\?\.key \? \{ pen:/);
  });
});

describe("the page drives the Pivot panel", () => {
  it("sends a request through the plan, shows a refusal in the panel and in Activity, and sends one batch", () => {
    expect(main).toMatch(/const plan = pivotPlan\(scene, selection, request, \{ keepInPlace, keyed, frame: currentFrame, view: previewScene \?\? scene \}\);\s*if \(isRefused\(plan\)\) \{\s*ui\.pivotError\.textContent = plan\.refused;\s*ui\.pivotError\.hidden = false;\s*log\(`Pivot: \$\{plan\.refused\}`, "bad"\);\s*return;/);
    expect(main).toMatch(/await runEdits\(plan, pivotLabel\(objects, request, keepInPlace\), "inspector"\);/);
  });

  it("takes the keyed choice, the playhead and the drawn document from the page", () => {
    expect(main).toContain('const keyed = ui.pivotKeyedModify.checked ? "modify" : "insert";');
    expect(main).toContain("{ keepInPlace, keyed, frame: currentFrame, view: previewScene ?? scene }");
  });

  it("sends the panel's requests one after another, so a second is planned from what the first made", () => {
    expect(main).toMatch(/function applyPivot\(request: PivotRequest\): Promise<void> \{\s*pivotQueue = pivotQueue\.then\(\(\) => sendPivot\(request\)\);\s*return pivotQueue;/);
  });

  it("takes the place, the offset, the scope and the step the panel shows", () => {
    expect(main).toMatch(/kind: ui\.pivotScope\.value === "selection" \? "selection" : "grid", place, offset: offset\(\)/);
    expect(main).toMatch(/dx: dx \* step, dy: dy \* step/);
    expect(main).toMatch(/applyPivot\(\{ kind: "reset" \}\)/);
    expect(main).toMatch(/ui\.pivotX\.addEventListener\("change", typed\);\s*ui\.pivotY\.addEventListener\("change", typed\);/);
  });

  it("is drawn with the panels, leaves a field being typed in alone, and marks the place the pivot is on", () => {
    expect(main).toMatch(/function renderPanels\(document_: SceneDocument\): void \{\s*renderProjectManager\(\);\s*renderPivotPanel\(document_\);/);
    expect(main).toMatch(/if \(document\.activeElement !== ui\.pivotX\) ui\.pivotX\.value/);
    expect(main).toMatch(/button\.setAttribute\("aria-pressed", String\(button\.dataset\.pivotPlace === view\.place\)\);/);
  });

  it("marks the pivots on the canvas only while the Pivot tool is in use", () => {
    expect(main).toContain('pivots: activeTool === "pivot",');
  });
});

describe("the page drags with the tool", () => {
  it("starts a tool drag from the pointer over what is drawn, keeping a refusal for the drag", () => {
    expect(main).toMatch(/const begun = beginToolDrag\(activeTool, scene, selection, start, previewScene\);\s*if \(isRefused\(begun\)\) refusal = begun\.refused;\s*else tool = begun;/);
  });

  it("says a refused drag in Activity once when the pointer moves, and still lets a click select", () => {
    expect(main).toMatch(/if \(overlayDrag\.refusal !== undefined\) \{[\s\S]*?overlayDrag\.told = true;\s*log\(`\$\{toolWords\(activeTool\)\}: \$\{overlayDrag\.refusal\}`, "bad"\);[\s\S]*?return;\s*\}/);
    expect(main).toMatch(/if \(overlayDrag\.told !== true\) \{\s*overlayDrag\.told = true;/);
    expect(main).toMatch(/if \(drag\.refusal !== undefined && drag\.moved\) \{\s*renderOverlayLayer\(\);\s*return;\s*\}/);
  });

  it("selects what is under the pointer first when it is not selected, as the Select tool would, but not with Shift or Ctrl", () => {
    expect(main).toMatch(/if \(\(activeTool === "move" \|\| activeTool === "rotate" \|\| activeTool === "scale" \|\| activeTool === "pivot"\) && scene && !additive\) \{/);
    expect(main).toMatch(/if \(hit !== undefined && !isSelectedOrInsideSelected\(hit\)\) setSelection\(\[hit\]\);/);
  });

  it("treats a child of a selected group as the group", () => {
    expect(main).toMatch(/function isSelectedOrInsideSelected\(id: string\): boolean \{\s*if \(selection\.includes\(id\)\) return true;[\s\S]*?if \(selection\.includes\(at\)\) return true;/);
  });

  it("stops the playback clock when a drag starts, so it does not draw over the drag", () => {
    expect(main).toMatch(/if \(tool !== undefined && playback !== undefined\) pausePreview\("moving an object"\);/);
  });

  it("draws the drag on a copy of the document and never writes during it", () => {
    // The picture is drawn as well as updated, or only the selection box would follow the pointer.
    expect(main).toMatch(/toolPreview = previewDocument\(previewScene, toolDragChanges\(overlayDrag\.tool, current, \{ shift: event\.shiftKey \}\)\);\s*viewport\?\.updateDocument\(toolPreview\);\s*viewport\?\.render\(\);/);
    expect(main).toMatch(/if \(previewScene !== null\) \{\s*viewport\?\.updateDocument\(previewScene\);\s*viewport\?\.render\(\);\s*\}/);
  });

  it("sends the whole drag as one batch from the viewport, only when the pointer was released and something changed", () => {
    expect(main).toMatch(/const changes = cancelled \? \[\] : toolDragChanges\(drag\.tool, eventScenePoint\(event\), \{ shift: event\.shiftKey \}\);/);
    expect(main).toMatch(/if \(changes\.length > 0\) void runEdits\(toolDragEdits\(changes\), toolDragLabel\(drag\.tool, changes\), "viewport"\)\.finally\(dropToolPreview\);/);
  });

  it("drops a drag with Escape and keeps the selection", () => {
    expect(main).toMatch(/const dropped = overlayDrag\?\.tool !== undefined \|\| toolPreview !== null;[\s\S]*?dropToolPreview\(\);[\s\S]*?if \(!dropped\) setSelection\(\[\]\);/);
  });

  it("shows the ribbon's states again when an edit has finished, so nothing stays dimmed from the time it was busy", () => {
    expect(main).toMatch(/animationBusy = false;\s*ui\.animationMount\.removeAttribute\("aria-busy"\);[^}]*?showRibbonStates\(\);/);
  });

  it("asks the registry before a tool is chosen, and shows the ribbon's states from it", () => {
    expect(main).toMatch(/if \(id !== undefined && commandUnavailable\(id, commandContext\(\)\) !== undefined\) return;\s*setActiveTool\(button\.dataset\.tool as PageTool\);/);
    expect(main).toContain("function showRibbonStates(): void {");
    // An undo, a redo or a selection changes what can run, so each shows them again.
    expect(main).toMatch(/function updateHistoryButtons\(\): void \{[^}]*?showRibbonStates\(\);/);
    expect(main).toMatch(/function setSelection\(next: readonly string\[\]\): void \{\s*selection = \[\.\.\.new Set\(next\)\];\s*pathSelected = \[\];\s*pathMask = undefined;\s*showRibbonStates\(\);/);
    expect(main).toMatch(/const reason = commandUnavailable\(command\.id, context\);\s*button\.setAttribute\("aria-disabled"/);
  });
});
