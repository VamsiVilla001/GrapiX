// Changing a key from the Shortcuts page (row 11.84): the page as DOM over a host that keeps a real keymap, so the page and the rules are held together.
// A small fake document, as the page's own tests use: the view takes the document it draws with.

import { describe, expect, it } from "vitest";

import { allCommands } from "../src/app-menu";
import { SHORTCUTS, commandById } from "../src/command-registry";
import { assignKey, effectiveKeys, removeKey, resetKey, type Keymap } from "../src/keymap";
import { createSettingsWindow, type KeyOutcome, type KeysHost } from "../src/settings-window-view";

class Fake {
  readonly children: Fake[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  className = "";
  textContent = "";
  id = "";
  hidden = false;
  disabled = false;
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
  append(...kids: (Fake | string)[]): void {
    this.children.push(...kids.map((kid) => (typeof kid === "string" ? Object.assign(new Fake("#text"), { textContent: kid }) : kid)));
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
  focus(): void {}
  all(): Fake[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join(" ");
  }
}

/** The document: elements, and the listeners the page puts on it (the page listens for a key in the capture phase while it records one). */
class FakeDocument {
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  createElement(tag: string): Fake {
    return new Fake(tag);
  }
  addEventListener(name: string, fn: (event: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  removeEventListener(name: string, fn: (event: unknown) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((candidate) => candidate !== fn));
  }
  count(name: string): number {
    return (this.listeners.get(name) ?? []).length;
  }
  /** Press a key; returns whether the page stopped it (preventDefault and stopPropagation were both called). */
  key(key: string, extra: Record<string, unknown> = {}): { prevented: boolean; stopped: boolean } {
    const seen = { prevented: false, stopped: false };
    const event = {
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => (seen.prevented = true),
      stopPropagation: () => (seen.stopped = true),
      stopImmediatePropagation: () => undefined,
      ...extra,
    };
    for (const fn of [...(this.listeners.get("keydown") ?? [])]) fn(event);
    return seen;
  }
}

const known: ReadonlySet<string> = new Set(allCommands().map((command) => command.id));
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function open(initial: Keymap = {}) {
  const document = new FakeDocument();
  let keymap: Keymap = initial;
  const calls: string[] = [];
  const host: KeysHost = {
    commands: allCommands().map((command) => command.id),
    state: () => effectiveKeys(SHORTCUTS, keymap, known),
    assign: async (command, key, mode, take): Promise<KeyOutcome> => {
      calls.push(`assign ${command} ${key} ${mode}${take ? " take" : ""}`);
      const result = assignKey(keymap, SHORTCUTS, known, command, key, { mode, take });
      if (result.kind === "done") {
        keymap = result.keymap;
        return { kind: "done" };
      }
      return result.kind === "clash" ? { kind: "clash", key: result.key, holder: result.holder } : { kind: "refused", reason: result.reason };
    },
    remove: async (command, key) => {
      calls.push(`remove ${command} ${key}`);
      keymap = removeKey(keymap, SHORTCUTS, known, command, key);
    },
    reset: async (command) => {
      calls.push(`reset ${command}`);
      keymap = resetKey(keymap, command);
    },
    resetAll: async () => {
      calls.push("resetAll");
      keymap = {};
    },
  };
  const root = new Fake("div");
  const win = createSettingsWindow(document as unknown as Document, root as unknown as HTMLElement, {
    shortcuts: SHORTCUTS,
    labelOf: (command) => commandById(command)?.label,
    keys: host,
    initial: "shortcuts",
  });
  const page = root.all().find((n) => n.id === "settings-page-shortcuts")!;
  const rows = () => page.all().filter((n) => n.className.split(" ").includes("settings-keys-row"));
  const row = (command: string) => rows().find((r) => r.dataset.command === command)!;
  const buttons = (within: Fake) => within.all().filter((n) => n.tag === "button");
  const pressButton = async (within: Fake, text: string) => {
    const target = buttons(within).find((b) => b.textContent === text && !b.disabled);
    if (target === undefined) throw new Error(`no enabled button ${JSON.stringify(text)} in ${within.text()}`);
    target.fire("click");
    await settle();
  };
  const keysOf = (command: string) => row(command).all().filter((n) => n.tag === "kbd").map((k) => k.textContent);
  const status = (command: string) => page.all().find((n) => n.className.split(" ").includes("settings-keys-status") && n.dataset.command === command);
  return { document, root, win, page, rows, row, buttons, pressButton, keysOf, status, calls, keymap: () => keymap };
}

describe("the rows", () => {
  it("list every command that can have a key, the keyless ones too", () => {
    const { rows, keysOf, row } = open();
    expect(rows()).toHaveLength(allCommands().length);
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
    expect(keysOf("edit.redo")).toEqual(["Ctrl Shift Z", "Ctrl Y"]);
    expect(keysOf("file.open-project")).toEqual([]);
    expect(row("file.open-project").text()).toContain("no key");
  });

  it("offer Change and Add key on each, and Reset and a CHANGED chip only on a command the person changed", () => {
    const { row, buttons } = open({ "file.save": ["F2"] });
    expect(buttons(row("file.save")).map((b) => b.textContent)).toEqual(["×", "Change…", "Add key…", "Reset"]);
    expect(row("file.save").text()).toContain("CHANGED");
    expect(buttons(row("edit.undo")).map((b) => b.textContent)).toEqual(["×", "Change…", "Add key…"]);
    expect(row("edit.undo").text()).not.toContain("CHANGED");
  });

  it("say how many were changed in the summary", () => {
    const { page } = open({ "file.save": ["F2"], "edit.undo": ["F5"] });
    expect(page.all().find((n) => n.className.includes("settings-keys-summary"))!.textContent).toContain("2 changed by you.");
  });

  it("can be limited to the ones with a key, or the ones the person changed", () => {
    const { page, rows } = open({ "file.save": ["F2"] });
    const select = page.all().find((n) => n.tag === "select")!;
    select.value = "changed";
    select.fire("change");
    expect(rows().map((r) => r.dataset.command)).toEqual(["file.save"]);
    select.value = "keyed";
    select.fire("change");
    expect(rows().length).toBeGreaterThan(20);
    expect(rows().length).toBeLessThan(allCommands().length);
    expect(rows().every((r) => r.all().some((n) => n.tag === "kbd"))).toBe(true);
  });
});

describe("changing a key", () => {
  it("waits for a key after Change, says so under the row, and takes the next key pressed", async () => {
    const { pressButton, row, status, document, keysOf, calls, keymap } = open();
    await pressButton(row("file.save"), "Change…");
    expect(status("file.save")!.text()).toContain("Press the new key for Save… Escape cancels.");
    expect(document.count("keydown")).toBe(1);
    const stopped = document.key("F2");
    expect(stopped).toEqual({ prevented: true, stopped: true });
    await settle();
    expect(calls).toEqual(["assign file.save F2 replace"]);
    expect(keysOf("file.save")).toEqual(["F2"]);
    expect(row("file.save").text()).toContain("CHANGED");
    expect(status("file.save")).toBeUndefined();
    expect(document.count("keydown")).toBe(0);
    expect(keymap()).toEqual({ "file.save": ["F2"] });
  });

  it("keeps waiting while only a modifier is down, and reads Ctrl and Shift with the key", async () => {
    const { pressButton, row, document, keysOf, calls } = open();
    await pressButton(row("file.open-project"), "Change…");
    document.key("Control", { ctrlKey: true });
    document.key("Shift", { ctrlKey: true, shiftKey: true });
    expect(calls).toEqual([]);
    document.key("O", { ctrlKey: true, shiftKey: true });
    await settle();
    expect(keysOf("file.open-project")).toEqual(["Ctrl Shift O"]);
  });

  it("is cancelled by Escape, changing nothing", async () => {
    const { pressButton, row, document, status, calls, keysOf } = open();
    await pressButton(row("file.save"), "Change…");
    document.key("Escape");
    await settle();
    expect(calls).toEqual([]);
    expect(status("file.save")).toBeUndefined();
    expect(document.count("keydown")).toBe(0);
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
  });

  it("is cancelled by the Cancel button", async () => {
    const { pressButton, row, page, document, status } = open();
    await pressButton(row("file.save"), "Change…");
    await pressButton(status("file.save")!, "Cancel");
    expect(status("file.save")).toBeUndefined();
    expect(document.count("keydown")).toBe(0);
    expect(page.text()).not.toContain("Press the new key");
  });

  it("says why Enter, Tab and Alt cannot be used, and goes on waiting", async () => {
    const { pressButton, row, document, status, calls } = open();
    await pressButton(row("file.save"), "Change…");
    document.key("Enter");
    expect(status("file.save")!.text()).toContain("Enter cannot be given to a command: dialogs and the focus order use it");
    expect(status("file.save")!.text()).toContain("Press the new key for Save");
    document.key("s", { altKey: true });
    expect(status("file.save")!.text()).toContain("Alt is not read for keys here");
    expect(calls).toEqual([]);
    expect(document.count("keydown")).toBe(1);
  });

  it("adds a key beside the ones a command has", async () => {
    const { pressButton, row, document, keysOf } = open();
    await pressButton(row("edit.redo"), "Add key…");
    document.key("F3");
    await settle();
    expect(keysOf("edit.redo")).toEqual(["Ctrl Shift Z", "Ctrl Y", "F3"]);
  });

  it("dims Add key at four keys and says why", () => {
    const { row, buttons } = open({ "file.open-project": ["F1", "F2", "F3", "F4"] });
    const add = buttons(row("file.open-project")).find((b) => b.textContent === "Add key…")!;
    expect(add.disabled).toBe(true);
    expect(add.attributes.get("title")).toBe("A command has at most 4 keys: remove one first.");
  });

  it("takes one key off with its ×, leaving the command's others", async () => {
    const { row, buttons, keysOf, calls } = open();
    const remove = buttons(row("edit.redo")).find((b) => b.attributes.get("aria-label") === "Remove Ctrl Y from Redo")!;
    remove.fire("click");
    await settle();
    expect(calls).toEqual(["remove edit.redo Ctrl Y"]);
    expect(keysOf("edit.redo")).toEqual(["Ctrl Shift Z"]);
  });
});

describe("a key another command has", () => {
  it("is refused by name, with Take it beside the reason, and changes nothing yet", async () => {
    const { pressButton, row, document, status, keysOf } = open();
    await pressButton(row("edit.search"), "Change…");
    document.key("s", { ctrlKey: true });
    await settle();
    expect(status("edit.search")!.text()).toContain("Ctrl S is the key of Save.");
    expect(buttonsText(status("edit.search")!)).toEqual(["Take it", "Cancel"]);
    expect(keysOf("edit.search")).toEqual(["Ctrl K"]);
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
    expect(document.count("keydown")).toBe(0);
  });

  it("moves in one change when it is taken: the other command has none, and both rows say changed", async () => {
    const { pressButton, row, document, status, keysOf, calls } = open();
    await pressButton(row("edit.search"), "Change…");
    document.key("s", { ctrlKey: true });
    await settle();
    await pressButton(status("edit.search")!, "Take it");
    expect(calls).toEqual(["assign edit.search Ctrl S replace", "assign edit.search Ctrl S replace take"]);
    expect(keysOf("edit.search")).toEqual(["Ctrl S"]);
    expect(keysOf("file.save")).toEqual([]);
    expect(row("file.save").text()).toContain("no key");
    expect(row("file.save").text()).toContain("CHANGED");
    expect(status("edit.search")).toBeUndefined();
  });

  it("can be given up: Cancel leaves both commands as they were", async () => {
    const { pressButton, row, document, status, keysOf, keymap } = open();
    await pressButton(row("edit.search"), "Change…");
    document.key("s", { ctrlKey: true });
    await settle();
    await pressButton(status("edit.search")!, "Cancel");
    expect(keymap()).toEqual({});
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
  });
});

function buttonsText(within: Fake): string[] {
  return within.all().filter((n) => n.tag === "button").map((b) => b.textContent);
}

describe("putting keys back", () => {
  it("puts one command back to its own keys with Reset", async () => {
    const { pressButton, row, keysOf, calls } = open({ "file.save": ["F2"] });
    await pressButton(row("file.save"), "Reset");
    expect(calls).toEqual(["reset file.save"]);
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
    expect(row("file.save").text()).not.toContain("CHANGED");
  });

  it("puts every command back with Reset all shortcuts, which is dimmed when nothing was changed", async () => {
    const changed = open({ "file.save": ["F2"], "edit.undo": ["F5"] });
    await changed.pressButton(changed.page, "Reset all shortcuts");
    expect(changed.keymap()).toEqual({});
    expect(changed.keysOf("edit.undo")).toEqual(["Ctrl Z"]);
    const untouched = open();
    const all = untouched.buttons(untouched.page).find((b) => b.textContent === "Reset all shortcuts")!;
    expect(all.disabled).toBe(true);
    expect(all.attributes.get("title")).toBe("No key has been changed.");
  });
});

describe("what is saved for a command this build does not have", () => {
  it("is named and ignored, and can be removed", async () => {
    const { page, pressButton, rows } = open({ "future.command": ["F8"] });
    expect(page.text()).toContain("Saved keys for a command this build does not have, ignored: future.command (F8).");
    expect(rows().some((r) => r.dataset.command === "future.command")).toBe(false);
    await pressButton(page.all().find((n) => n.className.includes("settings-keys-unknown"))!, "Remove");
    expect(page.text()).not.toContain("future.command");
  });

  it("leaves Reset all shortcuts available, so it can be cleared that way too", () => {
    const { page, buttons } = open({ "future.command": ["F8"] });
    expect(buttons(page).find((b) => b.textContent === "Reset all shortcuts")!.disabled).toBe(false);
  });
});

describe("waiting for a key", () => {
  it("stops when another page is chosen, or when the window asks, so no key is taken by a page nobody is looking at", async () => {
    const one = open();
    await one.pressButton(one.row("file.save"), "Change…");
    expect(one.document.count("keydown")).toBe(1);
    one.win.show("general");
    expect(one.document.count("keydown")).toBe(0);
    expect(one.page.text()).not.toContain("Press the new key");

    const two = open();
    await two.pressButton(two.row("file.save"), "Change…");
    two.win.cancelRecording();
    expect(two.document.count("keydown")).toBe(0);
    expect(two.status("file.save")).toBeUndefined();
  });

  it("is only waiting for one command at a time: Change on another moves the wait", async () => {
    const { pressButton, row, status, document } = open();
    await pressButton(row("file.save"), "Change…");
    await pressButton(row("edit.undo"), "Change…");
    expect(status("file.save")).toBeUndefined();
    expect(status("edit.undo")).toBeDefined();
    expect(document.count("keydown")).toBe(1);
  });

  it("draws the keys again when the host says they changed outside the page", () => {
    const { win, keysOf } = open();
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
    win.keysChanged();
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
  });
});
