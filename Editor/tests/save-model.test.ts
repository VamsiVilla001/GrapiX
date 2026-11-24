// The save model (11.30): where a plain save goes, and that the page and the File menu use it. Which key is which
// save is held by `command-registry.test.ts` (11.31).
import { describe, expect, it } from "vitest";
import type { EditEffect } from "@grapix/contracts";
import { APP_MENUS, type MenuNode } from "../src/app-menu";
import { isFirstSave, saveRoute, versionLabel } from "../src/save-model";
import page from "../web/main.ts?raw";

describe("where a plain save goes", () => {
  it("goes to the stored copy first, then the file, then the open project, then a file the author names", () => {
    expect(saveRoute({ stored: true, file: true, project: true })).toBe("stored");
    expect(saveRoute({ stored: true, file: false, project: false })).toBe("stored");
    expect(saveRoute({ stored: false, file: true, project: true })).toBe("file");
    expect(saveRoute({ stored: false, file: false, project: true })).toBe("project");
    expect(saveRoute({ stored: false, file: false, project: false })).toBe("dialog");
  });

  it("makes a first save of a scene saved nowhere, and of nothing else, when a version is asked for", () => {
    expect(isFirstSave({ stored: false, file: false, project: true })).toBe(true);
    expect(isFirstSave({ stored: false, file: false, project: false })).toBe(true);
    expect(isFirstSave({ stored: true, file: false, project: true })).toBe(false);
    expect(isFirstSave({ stored: false, file: true, project: false })).toBe(false);
  });
});

describe("the line in Activity for a version", () => {
  it("names the scene it made, or says it was the file", () => {
    const stored = { effect: "stored", origin: { project: "news", sceneId: "strap_v002" } } as unknown as EditEffect;
    expect(versionLabel([{ effect: "none" }, stored])).toBe("Saved as the next version: news/strap_v002");
    expect(versionLabel([{ effect: "none" }])).toBe("Saved as the next version of the file");
  });
});

describe("the File menu and the page use them", () => {
  function commands(nodes: readonly MenuNode[]): MenuNode[] {
    return nodes.flatMap((node) => (node.kind === "submenu" ? [node, ...commands(node.items)] : [node]));
  }

  it("shows each key on the item that runs it, and neither item waits on a plan row", () => {
    const all = commands(APP_MENUS.flatMap((menu) => menu.items));
    expect(all.find((node) => node.kind === "command" && node.id === "file.save")).toMatchObject({ native: "save", shortcut: "Ctrl S" });
    const version = all.find((node) => node.kind === "command" && node.id === "file.next-version");
    expect(version).toMatchObject({ native: "save-next-version", shortcut: "Ctrl Shift S" });
    expect((version as { row?: string }).row).toBeUndefined();
  });

  it("runs the keys through the one command table, and both menu items through the same two functions", () => {
    expect(page).toContain("decideKey(");
    expect(page).toMatch(/case "save":\s*void saveInPlace\(\);/);
    expect(page).toMatch(/case "save-next-version":\s*void saveNextVersion\(\);/);
    // A version is asked of Rust as one command; a plain save never is.
    expect(page).toMatch(/to: \{ to: "nextVersion" \}/);
    const plain = page.slice(page.indexOf("async function saveInPlace"), page.indexOf("async function saveNextVersion"));
    expect(plain).not.toContain("nextVersion");
  });
});
