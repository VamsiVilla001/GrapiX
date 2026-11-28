import { describe, expect, it } from "vitest";

import {
  LIST_TITLE,
  START_NOTE,
  START_TILES,
  formatLine,
  startCardShown,
  startRows,
  startView,
  type ListedGraphic,
} from "../src/start-graphic";
import { renderStartCard } from "../src/start-graphic-view";

class Fake {
  readonly children: Fake[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners: Record<string, Array<() => void>> = {};
  className = "";
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  constructor(readonly tag: string) {}
  append(...kids: Fake[]): void {
    this.children.push(...kids);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  addEventListener(event: string, handler: () => void): void {
    (this.listeners[event] ??= []).push(handler);
  }
  click(): void {
    // A disabled button receives no click, as in a page.
    if (!this.disabled) for (const handler of this.listeners.click ?? []) handler();
  }
  all(): Fake[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  text(): string {
    return this.all().map((n) => n.textContent).join(" ");
  }
}
const fakeDocument = { createElement: (tag: string) => new Fake(tag) } as unknown as Document;

const canvas = (num = 50, den = 1) => ({ canvas: { width: 1920, height: 1080, frameRate: { num, den } }, colorDepth: "32" as const, workingColorSpace: "srgb" as const });

const scenes: ListedGraphic[] = [
  { sceneId: "final-four", name: "Final Four L3", publishedRevision: 2 },
  { sceneId: "bumper", name: "Bumper in" },
  { sceneId: "broken", name: "Lower third", unavailableReason: "scene file is not valid JSON" },
  { sceneId: "open-one", name: "The open one", publishedRevision: 1 },
];

describe("the Start card's tiles", () => {
  it("are the design's four, in its order, and only a blank graphic and an SVG work", () => {
    expect(START_TILES.map((t) => t.id)).toEqual(["blank", "figma", "psd", "svg"]);
    expect(START_TILES.filter((t) => t.action !== undefined).map((t) => [t.id, t.action])).toEqual([
      ["blank", "add-box"],
      ["svg", "bring-in"],
    ]);
  });

  it("shows a Figma frame and a PSD dimmed with the row each waits for, and never as working", () => {
    const waiting = START_TILES.filter((t) => t.action === undefined);
    expect(waiting.map((t) => [t.id, t.waitsOn?.row])).toEqual([
      ["figma", "18.2"],
      ["psd", "11.59"],
    ]);
    for (const tile of waiting) expect(tile.waitsOn?.words).toContain(`row ${tile.waitsOn!.row}`);
  });
});

describe("the Format line", () => {
  it("is the graphic's own size, rate, depth and colour space", () => {
    expect(formatLine(canvas())).toBe("1920×1080 · 50 fps · 32 bit · sRGB");
  });
  it("names a broadcast fraction by its decimal, and the other working space in words", () => {
    expect(formatLine({ ...canvas(30000, 1001), workingColorSpace: "linear-srgb" })).toBe("1920×1080 · 29.97 fps · 32 bit · linear sRGB");
  });
});

describe("the list of the project's graphics", () => {
  it("leaves the open graphic out and keeps the list's order", () => {
    expect(startRows(scenes, "open-one").map((r) => r.sceneId)).toEqual(["final-four", "bumper", "broken"]);
  });

  it("says SENT with its revision, NOT SENT, or WILL NOT OPEN with the file's own reason", () => {
    const rows = startRows(scenes, "open-one");
    expect(rows[0]).toMatchObject({ chip: { text: "Sent r2", tone: "ok" }, openable: true });
    expect(rows[1]).toMatchObject({ chip: { text: "Not sent", tone: "neutral" }, openable: true });
    expect(rows[2]).toMatchObject({ chip: { text: "Will not open", tone: "danger" }, openable: false, detail: "scene file is not valid JSON" });
  });

  it("is titled Graphics in this project, not Recent: the list carries no time of last opening", () => {
    const view = startView({ document: canvas(), scenes, currentSceneId: undefined });
    expect(view.listTitle).toBe(LIST_TITLE);
    expect(view.listTitle).not.toMatch(/recent/i);
  });

  it("draws no chip it cannot stand behind: nothing says ready, stale or font missing", () => {
    const words = startRows(scenes, undefined).map((r) => r.chip.text.toLowerCase());
    for (const word of words) expect(word).not.toMatch(/ready|stale|font/);
  });

  it("says there is nothing to list when the project has no other graphic, or the list has not arrived", () => {
    const none = startView({ document: canvas(), scenes: [{ sceneId: "x", name: "X" }], currentSceneId: "x" });
    expect(none.rows).toEqual([]);
    expect(none.empty).toContain("no other graphic");
    expect(startView({ document: canvas(), scenes: undefined, currentSceneId: undefined }).empty).toBeDefined();
    expect(startView({ document: canvas(), scenes, currentSceneId: undefined }).empty).toBeUndefined();
  });

  it("keeps the promise that nothing is preset", () => {
    expect(START_NOTE).toContain("does not start you from a preset layout");
    expect(START_NOTE).not.toMatch(/event style/i);
  });
});

describe("when the card is drawn", () => {
  it("is drawn over an empty graphic and not over one with an element", () => {
    expect(startCardShown(0, "select")).toBe(true);
    expect(startCardShown(1, "select")).toBe(false);
  });

  it("gets out of the way of the Pen and the path tools, so a path can still be started on an empty graphic", () => {
    for (const tool of ["pen", "path", "vertex-add", "vertex-delete", "vertex-convert"]) expect(startCardShown(0, tool)).toBe(false);
    for (const tool of ["select", "move", "rotate", "scale", "pivot", "hand", "zoom"]) expect(startCardShown(0, tool)).toBe(true);
  });
});

describe("the view", () => {
  const draw = () => {
    const calls: string[] = [];
    const card = renderStartCard(fakeDocument, startView({ document: canvas(), scenes, currentSceneId: "open-one" }), {
      tile: (action) => calls.push(`tile:${action}`),
      open: (id) => calls.push(`open:${id}`),
    }) as unknown as Fake;
    return { card, calls };
  };
  const tile = (card: Fake, id: string) => card.all().find((n) => n.dataset.tile === id)!;
  const row = (card: Fake, id: string) => card.all().find((n) => n.dataset.scene === id)!;

  it("runs the two working tiles", () => {
    const { card, calls } = draw();
    tile(card, "blank").click();
    tile(card, "svg").click();
    expect(calls).toEqual(["tile:add-box", "tile:bring-in"]);
  });

  it("tells a working tile's command in its tooltip: Add a box, Bring in a drawing", () => {
    const { card } = draw();
    expect(tile(card, "blank").title).toBe("Add a box");
    expect(tile(card, "svg").title).toBe("Bring in a drawing…");
  });

  it("dims the two waiting tiles, names the row, and does nothing when pressed", () => {
    const { card, calls } = draw();
    for (const [id, row_] of [["figma", "18.2"], ["psd", "11.59"]] as const) {
      const dimmed = tile(card, id);
      expect(dimmed.disabled).toBe(true);
      expect(dimmed.attributes["aria-disabled"]).toBe("true");
      expect(dimmed.dataset.waitsOn).toBe(row_);
      expect(dimmed.title).toContain(row_);
      dimmed.click();
    }
    expect(calls).toEqual([]);
  });

  it("opens a listed graphic, and shows one that will not open, with its reason, without opening it", () => {
    const { card, calls } = draw();
    row(card, "bumper").click();
    expect(calls).toEqual(["open:bumper"]);
    const broken = row(card, "broken");
    expect(broken.disabled).toBe(true);
    expect(broken.title).toBe("scene file is not valid JSON");
    broken.click();
    expect(calls).toEqual(["open:bumper"]);
  });

  it("does not list the open graphic, and carries each chip's tone", () => {
    const { card } = draw();
    expect(row(card, "open-one")).toBeUndefined();
    const chips = card.all().filter((n) => n.className === "chip");
    expect(chips.map((c) => [c.textContent, c.dataset.tone])).toEqual([
      ["Sent r2", "ok"],
      ["Not sent", "neutral"],
      ["Will not open", "danger"],
    ]);
  });

  it("shows the graphic's own format", () => {
    expect(draw().card.text()).toContain("1920×1080 · 50 fps · 32 bit · sRGB");
  });
});

describe("a graphic that will not open", () => {
  it("is shown as unable to open even when its file once carried a published revision", () => {
    const [row] = startRows([{ sceneId: "x", name: "X", publishedRevision: 3, unavailableReason: "the file is damaged" }], undefined);
    expect(row).toMatchObject({ chip: { text: "Will not open", tone: "danger" }, openable: false });
  });
});
