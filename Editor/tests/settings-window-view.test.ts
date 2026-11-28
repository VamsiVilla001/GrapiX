// Plan row 11.81 (Figma E4): the Settings window's nav and pages as DOM, with a small fake document (the Editor's own way: the view takes
// the document it draws with). Nothing here calls the shell.
import { describe, expect, it } from "vitest";

import { SHORTCUTS, commandById, type Shortcut } from "../src/command-registry";
import { createSettingsWindow } from "../src/settings-window-view";

let focused: Fake | undefined;

class Fake {
  readonly children: Fake[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  className = "";
  textContent = "";
  id = "";
  hidden = false;
  value = "";
  type = "";
  placeholder = "";
  constructor(readonly tag: string) {}
  get classList() {
    const self = this;
    return {
      toggle(name: string, on: boolean) {
        const names = new Set(self.className.split(/\s+/).filter((n) => n !== ""));
        if (on) names.add(name);
        else names.delete(name);
        self.className = [...names].join(" ");
      },
      add(name: string) {
        this.toggle(name, true);
      },
      contains: (name: string) => self.className.split(/\s+/).includes(name),
    };
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...kids: Fake[]): void {
    this.children.push(...kids);
  }
  replaceChildren(...kids: Fake[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  addEventListener(name: string, fn: (event: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  fire(name: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
  focus(): void {
    focused = this;
  }
  all(): Fake[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join(" ");
  }
}
const fakeDocument = { createElement: (tag: string) => new Fake(tag) } as unknown as Document;

function open(shortcuts: readonly Shortcut[] = SHORTCUTS) {
  focused = undefined;
  const root = new Fake("div");
  const window = createSettingsWindow(fakeDocument, root as unknown as HTMLElement, { shortcuts, labelOf: (command) => commandById(command)?.label });
  const tabs = root.all().filter((n) => n.attributes.get("role") === "tab");
  const panels = root.all().filter((n) => n.attributes.get("role") === "tabpanel");
  const search = root.all().find((n) => n.tag === "input")!;
  return { root, window, tabs, panels, search };
}
const press = (tab: Fake, key: string) => tab.fire("keydown", { key, preventDefault: () => undefined });
const tabNamed = (tabs: Fake[], page: string) => tabs.find((t) => t.dataset.page === page)!;
const panelNamed = (panels: Fake[], page: string) => panels.find((p) => p.id === `settings-page-${page}`)!;

describe("the nav", () => {
  it("is a vertical tab list of General, Shortcuts and AI and MCP access, with General shown first", () => {
    const { root, tabs, panels, window } = open();
    const list = root.all().find((n) => n.attributes.get("role") === "tablist")!;
    expect(list.attributes.get("aria-orientation")).toBe("vertical");
    expect(tabs.map((t) => t.textContent)).toEqual(["General", "Shortcuts", "AI and MCP access"]);
    expect(window.current).toBe("general");
    expect(tabs.map((t) => t.attributes.get("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((t) => t.attributes.get("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(panels.map((p) => p.hidden)).toEqual([false, true, true]);
  });

  it("puts the grid class on the element it is given, with the nav and the pages as its two children, so the stylesheet applies", () => {
    const { root } = open();
    expect(root.classList.contains("settings-window")).toBe(true);
    expect(root.children.map((c) => c.className)).toEqual(["settings-nav", "settings-pages"]);
  });

  it("ties each tab to its panel both ways", () => {
    const { tabs, panels } = open();
    for (const tab of tabs) {
      const panel = panels.find((p) => p.id === tab.attributes.get("aria-controls"))!;
      expect(panel.attributes.get("aria-labelledby")).toBe(tab.id);
    }
  });

  it("shows a page when its tab is clicked and hides the others", () => {
    const { tabs, panels, window } = open();
    tabNamed(tabs, "shortcuts").fire("click");
    expect(window.current).toBe("shortcuts");
    expect(panels.map((p) => p.hidden)).toEqual([true, false, true]);
    expect(tabs.map((t) => t.attributes.get("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabNamed(tabs, "shortcuts").classList.contains("is-selected")).toBe(true);
  });

  it("moves with the arrow keys, Home and End, wraps at the ends, and moves focus with the selection", () => {
    const { tabs, window } = open();
    press(tabNamed(tabs, "general"), "ArrowDown");
    expect(window.current).toBe("shortcuts");
    expect(focused).toBe(tabNamed(tabs, "shortcuts"));
    press(tabNamed(tabs, "shortcuts"), "End");
    expect(window.current).toBe("ai");
    press(tabNamed(tabs, "ai"), "ArrowDown");
    expect(window.current).toBe("general");
    press(tabNamed(tabs, "general"), "ArrowUp");
    expect(window.current).toBe("ai");
    press(tabNamed(tabs, "ai"), "Home");
    expect(window.current).toBe("general");
    press(tabNamed(tabs, "general"), "a");
    expect(window.current).toBe("general");
  });

  it("shows General for an id that is not a page", () => {
    const { window } = open();
    window.show("shortcuts");
    expect(window.show("nonsense")).toBe("general");
    expect(window.current).toBe("general");
  });

  it("can open on another page", () => {
    focused = undefined;
    const root = new Fake("div");
    const window = createSettingsWindow(fakeDocument, root as unknown as HTMLElement, { shortcuts: SHORTCUTS, labelOf: () => undefined, initial: "shortcuts" });
    expect(window.current).toBe("shortcuts");
  });
});

describe("what belongs to one page only", () => {
  it("is told which page is shown, once at the start and again on every change, including a page asked for by a wrong id", () => {
    const seen: string[] = [];
    const root = new Fake("div");
    const window = createSettingsWindow(fakeDocument, root as unknown as HTMLElement, {
      shortcuts: SHORTCUTS,
      labelOf: () => undefined,
      onShow: (id) => seen.push(id),
    });
    expect(seen).toEqual(["general"]);
    window.show("shortcuts");
    window.show("nonsense");
    window.show("ai");
    expect(seen).toEqual(["general", "shortcuts", "general", "ai"]);
  });
});

describe("the General page", () => {
  it("is an element for the Editor's own settings, the same one for the life of the window, inside the General panel", () => {
    const { window, panels, tabs } = open();
    expect(panelNamed(panels, "general").children).toEqual([window.general]);
    tabNamed(tabs, "ai").fire("click");
    tabNamed(tabs, "general").fire("click");
    expect(panelNamed(panels, "general").children).toEqual([window.general]);
    expect(window.general.children).toEqual([]);
  });
});

describe("a page that is not built", () => {
  it("is dimmed in the nav, names its row in the tooltip, and when chosen says what it waits for", () => {
    const { tabs, panels } = open();
    const tab = tabNamed(tabs, "ai");
    expect(tab.classList.contains("is-soon")).toBe(true);
    expect(tab.attributes.get("title")).toBe("Not built yet (row 8.14).");
    expect(tabNamed(tabs, "general").classList.contains("is-soon")).toBe(false);
    tab.fire("click");
    const text = panelNamed(panels, "ai").text();
    expect(text).toContain("Not built yet (row 8.14).");
    expect(text).toContain("no role can cue, take out, clear or change what is on air");
  });

  it("draws no role table, token field or audit button: nothing in it can be pressed", () => {
    const { panels } = open();
    const inside = panelNamed(panels, "ai").all();
    expect(inside.filter((n) => ["button", "input", "select", "table"].includes(n.tag))).toEqual([]);
  });
});

describe("the Shortcuts page", () => {
  const rowsOf = (panels: Fake[]) => panelNamed(panels, "shortcuts").all().filter((n) => n.className.includes("settings-keys-row"));
  const summaryOf = (panels: Fake[]) => panelNamed(panels, "shortcuts").all().find((n) => n.className.includes("settings-keys-summary"))!;

  it("has one row for each command in the Editor's table, with all its keys, and says how many", () => {
    const { panels } = open();
    const commands = new Set(SHORTCUTS.map((s) => s.command));
    const rows = rowsOf(panels);
    expect(rows).toHaveLength(commands.size);
    const redo = rows.find((r) => r.dataset.command === "edit.redo")!;
    expect(redo.all().filter((n) => n.tag === "kbd").map((k) => k.textContent)).toEqual(["Ctrl Shift Z", "Ctrl Y"]);
    expect(summaryOf(panels).textContent).toBe(`${commands.size} commands, ${SHORTCUTS.length} keys. No two commands share a key.`);
  });

  it("can be searched, and the count follows", () => {
    const { panels, search } = open();
    search.value = "ctrl s";
    search.fire("input");
    expect(rowsOf(panels).map((r) => r.dataset.command)).toEqual(["file.save"]);
    expect(summaryOf(panels).textContent).toContain("1 of ");
    search.value = "";
    search.fire("input");
    expect(rowsOf(panels).length).toBe(new Set(SHORTCUTS.map((s) => s.command)).size);
  });

  it("says when nothing matches, in words", () => {
    const { panels, search } = open();
    search.value = "zzzz";
    search.fire("input");
    expect(rowsOf(panels)).toEqual([]);
    expect(panelNamed(panels, "shortcuts").text()).toContain('No command or key matches "zzzz".');
  });

  it("shows no clash chip for the Editor's own table", () => {
    const { panels } = open();
    expect(panelNamed(panels, "shortcuts").all().filter((n) => n.className.includes("settings-clash"))).toEqual([]);
  });

  it("shows a CLASH chip that names the other command when two commands share a key, and says so under the table", () => {
    const clash: Shortcut[] = [
      { chord: { key: "k", ctrl: true, shift: false }, command: "edit.search" },
      { chord: { key: "k", ctrl: true, shift: false }, command: "file.save" },
    ];
    const { panels } = open(clash);
    const chips = panelNamed(panels, "shortcuts").all().filter((n) => n.className.includes("settings-clash"));
    expect(chips.map((c) => c.textContent)).toEqual(["CLASH", "CLASH"]);
    expect(chips[0]?.attributes.get("title")).toContain("file.save");
    expect(chips[0]?.dataset.tone).toBe("bad");
    expect(summaryOf(panels).textContent).toContain("2 commands share a key with another");
  });

  it("without a host that changes keys, says plainly that they cannot be changed, and offers nothing to press but the search", () => {
    const { panels } = open();
    const page = panelNamed(panels, "shortcuts");
    expect(page.text()).toContain("Keys cannot be changed from here.");
    expect(page.all().filter((n) => ["button", "select", "textarea"].includes(n.tag))).toEqual([]);
    expect(page.all().filter((n) => n.tag === "input").map((n) => n.type)).toEqual(["search"]);
  });

  it("names the search box for a screen reader", () => {
    const { search } = open();
    expect(search.attributes.get("aria-label")).toBe("Search shortcuts");
    expect(search.placeholder).toBe("Search commands or keys");
  });
});
