// The on-demand toolbar groups (visibility decision of 26 Nov 2026): which show for which tool and selection, and that the page's
// markup holds them where the rule says, hidden until called.

import { describe, expect, it } from "vitest";

import { PATH_CONTEXT_TOOLS, toolbarContext } from "../src/toolbar-context";

describe("which toolbar groups show", () => {
  it("shows the path tools while the Pen or any path tool is the tool, and not otherwise", () => {
    for (const tool of ["pen", "path", "vertex-add", "vertex-delete", "vertex-convert"]) expect(toolbarContext(tool, 0).pen, tool).toBe(true);
    for (const tool of ["select", "move", "rotate", "scale", "pivot", "hand", "zoom"]) expect(toolbarContext(tool, 0).pen, tool).toBe(false);
    expect(PATH_CONTEXT_TOOLS).toHaveLength(5);
  });

  it("shows Hand and Zoom only while each is the tool", () => {
    expect(toolbarContext("hand", 0)).toMatchObject({ hand: true, zoom: false });
    expect(toolbarContext("zoom", 0)).toMatchObject({ hand: false, zoom: true });
    expect(toolbarContext("select", 0)).toMatchObject({ hand: false, zoom: false });
  });

  it("shows line up and spread from two selected elements", () => {
    expect(toolbarContext("select", 0).lineUp).toBe(false);
    expect(toolbarContext("select", 1).lineUp).toBe(false);
    expect(toolbarContext("select", 2).lineUp).toBe(true);
    expect(toolbarContext("pen", 5).lineUp).toBe(true);
  });
});

describe("the markup", () => {
  it("holds the path tools and the Pen's note in one group, hidden at start, and Hand, Zoom and line up hidden too", async () => {
    const nodeFs = "node:fs";
    const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL, encoding: string): string };
    const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const group = /<span id="pen-context"[^>]*hidden>([\s\S]*?)<\/span>\s*<button hidden id="tool-hand"/.exec(html);
    expect(group, "the pen context group").not.toBeNull();
    for (const id of ["pen-creates", "tool-path", "tool-vertex-add", "tool-vertex-delete", "tool-vertex-convert", "pen-creates-note"]) expect(group![1], id).toContain(`id="${id}"`);
    expect(html).toMatch(/<button hidden id="tool-zoom"/);
    expect(html).toMatch(/<div id="line-up-tools"[^>]*hidden>/);
    // The note no longer sits in the viewer footer.
    expect(html.match(/id="pen-creates-note"/g)).toHaveLength(1);
    expect(/<div class="viewer-footer"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "").not.toContain("pen-creates-note");
  });
});
