// The key a menu item shows follows the keys in force (row 11.84): the person's change when there is one, the Editor's own label when the page gives none.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commandById } from "../src/command-registry";
import { commandButton, useShortcutLabels } from "../src/app-menu-view";

class Fake {
  readonly children: Fake[] = [];
  readonly dataset: Record<string, string> = {};
  textContent = "";
  title = "";
  type = "";
  constructor(readonly tag: string) {}
  append(...kids: Fake[]): void {
    this.children.push(...kids);
  }
  setAttribute(): void {}
}

beforeEach(() => vi.stubGlobal("document", { createElement: (tag: string) => new Fake(tag) }));
afterEach(() => {
  useShortcutLabels(undefined);
  vi.unstubAllGlobals();
});

const keyShown = (id: string): string | undefined => {
  const button = commandButton(commandById(id)!) as unknown as Fake;
  return button.children.find((child) => child.tag === "kbd")?.textContent;
};

describe("a menu item's key", () => {
  it("is the menu model's own label until the page gives the keys in force", () => {
    expect(keyShown("file.save")).toBe("Ctrl S");
    expect(keyShown("file.open-project")).toBeUndefined();
  });

  it("is the key in force: a changed key, a key given to a command that had none, and none for a command whose key was taken off", () => {
    useShortcutLabels((command) => ({ "file.save": "F2", "file.open-project": "Ctrl O" })[command]);
    expect(keyShown("file.save")).toBe("F2");
    expect(keyShown("file.open-project")).toBe("Ctrl O");
    expect(keyShown("edit.undo")).toBeUndefined(); // a command the page gives no key: it shows none, not its old label
  });

  it("goes back to the model's labels when the page stops giving any", () => {
    useShortcutLabels(() => "F9");
    useShortcutLabels(undefined);
    expect(keyShown("file.save")).toBe("Ctrl S");
  });
});
