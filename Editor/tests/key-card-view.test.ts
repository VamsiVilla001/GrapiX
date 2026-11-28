import { describe, expect, it } from "vitest";

import { keyCard } from "../src/timeline/key-card";
import { HINT, NAMED_EASINGS, renderKeyCard, type KeyCardHandlers } from "../src/timeline/key-card-view";
import { keyId } from "../src/timeline/model";

class Fake {
  readonly children: Fake[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, (() => void)[]>();
  className = "";
  textContent = "";
  value = "";
  step = "";
  type = "";
  disabled = false;
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...kids: Fake[]): void {
    this.children.push(...kids);
  }
  addEventListener(name: string, fn: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  fire(name: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  all(): Fake[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}
const fakeDocument = { createElement: (tag: string) => new Fake(tag) } as unknown as Document;

const rate = { num: 50, den: 1 };
const EASE = { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 };
const key = (frame: number, value: number, easing = "linear", bezier?: object) => ({ frame, value, easing, ...(bezier === undefined ? {} : { bezier }) });
const doc = {
  objects: [{ id: "plate", name: "Name plate", type: "rect", visible: true, locked: false }],
  timeline: {
    durationFrames: 250,
    phases: [],
    pathChannels: [],
    channels: [
      { objectId: "plate", property: "x", keys: [key(0, 100), key(20, 160, "custom-bezier", EASE), key(60, 300)] },
      { objectId: "plate", property: "y", keys: [key(0, 780), key(20, 800, "ease-in"), key(60, 900)] },
      { objectId: "plate", property: "opacity", keys: [key(0, 0), key(20, 0.5)] },
    ],
  },
} as never;

function calls(): { handlers: KeyCardHandlers; log: unknown[][] } {
  const log: unknown[][] = [];
  return {
    log,
    handlers: { frame: (n) => log.push(["frame", n]), value: (p, v) => log.push(["value", p, v]), easing: (e) => log.push(["easing", e]), influence: (side, p) => log.push(["influence", side, p]), action: (a) => log.push(["action", a]) },
  };
}
const draw = (ids: string[], h: KeyCardHandlers) => renderKeyCard(fakeDocument, keyCard(doc, ids, rate)!, h) as unknown as Fake;
const text = (root: Fake): string => root.all().map((n) => n.textContent).join("|");

describe("a moment's card", () => {
  const { handlers } = calls();
  const root = draw([keyId("plate", "x", 20), keyId("plate", "y", 20)], handlers);

  it("has the design's four sections in order, and its title", () => {
    expect(root.children[0]!.textContent).toBe("Keyframe · Name plate · Position · frame 20");
    const titles = root.all().filter((n) => n.className === "card-title").map((n) => n.textContent);
    expect(titles).toEqual(["Time", "Value", "Interpolation", "Element · Name"]);
  });

  it("says the milliseconds, shows each value with its unit, and the hint", () => {
    const t = text(root);
    expect(t).toContain("20 · 400 ms");
    expect(t).toContain("px");
    expect(root.all().filter((n) => n.className === "key-card-input").map((n) => n.value)).toEqual(["20", "160", "800", "0", "33.3"]); // frame, x, y, then Ease in (the linear segment before it) and Ease out
    expect(t).toContain(HINT);
  });

  it("does not draw the Path row, which the contract cannot hold", () => {
    expect(text(root)).not.toMatch(/\bPath\b/);
  });

  it("offers the Parent, Blend and Matte of the element as buttons that open the timeline's menus", () => {
    const cells = root.all().filter((n) => n.className === "key-card-cell");
    expect(cells.map((c) => [c.dataset.layerColumn, c.dataset.objectId, c.textContent])).toEqual([["parent", "plate", "—"], ["blend", "plate", "Normal"], ["matte", "plate", "—"]]);
  });

  it("shows the current curve when it is mixed, and offers only named easings to choose", () => {
    const select = root.all().find((n) => n.className === "key-card-select")!;
    const options = select.children.map((o) => o.textContent);
    expect(options[0]).toBe("Mixed");
    expect(options.slice(1)).toEqual(NAMED_EASINGS.map((e) => ({ linear: "Linear", hold: "Hold", "ease-in": "Ease in", "ease-out": "Ease out", "ease-in-out": "Ease in-out", bounce: "Bounce", elastic: "Elastic" })[e]).concat(["Back out", "Back in"]));
  });
});

describe("what a change sends", () => {
  it("passes the frame, a value in its shown unit, and a chosen easing to the handlers", () => {
    const { handlers, log } = calls();
    const root = draw([keyId("plate", "opacity", 20)], handlers);
    const inputs = root.all().filter((n) => n.className === "key-card-input");
    inputs[0]!.value = "30";
    inputs[0]!.fire("change");
    inputs[1]!.value = "75";
    inputs[1]!.fire("change");
    const select = root.all().find((n) => n.className === "key-card-select")!;
    select.value = "hold";
    select.fire("change");
    expect(log).toEqual([["frame", 30], ["value", "opacity", 75], ["easing", "hold"]]);
  });

  it("puts the old number back when what was typed is not a number, and sends nothing", () => {
    const { handlers, log } = calls();
    const root = draw([keyId("plate", "x", 20)], handlers);
    const input = root.all().filter((n) => n.className === "key-card-input")[1]!;
    input.value = "abc";
    input.fire("change");
    expect(input.value).toBe("160");
    input.value = "";
    input.fire("change");
    expect(input.value).toBe("160");
    expect(log).toEqual([]);
  });

  it("sends the four buttons' actions and marks the pressed one", () => {
    const { handlers, log } = calls();
    const root = draw([keyId("plate", "x", 20)], handlers);
    const buttons = root.all().filter((n) => n.dataset.keyAction !== undefined);
    expect(buttons.map((b) => b.textContent)).toEqual(["Linear", "Ease", "Hold", "Open graph"]);
    expect(buttons.map((b) => b.attributes.get("aria-pressed"))).toEqual(["false", "true", "false", undefined]);
    expect(buttons[1]!.className).toBe("primary");
    for (const b of buttons) b.fire("click");
    expect(log).toEqual([["action", "linear"], ["action", "ease"], ["action", "hold"], ["action", "graph"]]);
  });
});

describe("a spread's card", () => {
  it("says how many keys and offers only the ease buttons", () => {
    const { handlers } = calls();
    const root = draw([keyId("plate", "x", 0), keyId("plate", "x", 60)], handlers);
    expect(root.children[0]!.textContent).toBe("2 keyframes selected");
    expect(root.all().filter((n) => n.className === "key-card-input")).toHaveLength(0);
    expect(root.all().filter((n) => n.dataset.keyAction !== undefined)).toHaveLength(4);
    expect(text(root)).toContain("frames 0 to 60 on Name plate");
  });
});

describe("the Ease in and Ease out fields", () => {
  it("are number fields in percent that send the typed number, and a dash where there is no curve to edit", () => {
    const { handlers, log } = calls();
    const inputs = (root: Fake, label: string) => root.all().filter((n) => n.tag === "input" && n.attributes.get("aria-label") === `${label} (%)`);
    const mid = draw([keyId("plate", "x", 20)], handlers);
    const out = inputs(mid, "Ease out")[0]!;
    expect(out.value).toBe("33.3");
    out.value = "45";
    out.fire("change");
    const into = inputs(mid, "Ease in")[0];
    // Arriving through a linear segment is a segment, so it can be typed into (it keeps its line).
    expect(into).toBeDefined();
    into!.value = "20";
    into!.fire("change");
    expect(log).toEqual([["influence", "out", 45], ["influence", "in", 20]]);
    // The last key has nothing leaving it: no field, a dash.
    const last = draw([keyId("plate", "opacity", 20)], handlers);
    expect(inputs(last, "Ease out")).toEqual([]);
    expect(text(last)).toContain("—");
  });
});

describe("the Over time select and the Back presets", () => {
  it("offers Back out and Back in beside the named easings, as presets, and says which one a written curve is", () => {
    const { handlers, log } = calls();
    const root = draw([keyId("plate", "x", 20)], handlers);
    const select = root.all().find((n) => n.tag === "select")!;
    const values = select.children.map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining([...NAMED_EASINGS, "preset:back-out", "preset:back-in"]));
    select.value = "preset:back-in";
    select.fire("change");
    expect(log).toEqual([["easing", "preset:back-in"]]);
    // A key whose curve IS Back out reads as that option, and shows no placeholder for "custom".
    const back = { ...(doc as object), timeline: { ...(doc as { timeline?: object }).timeline, channels: [{ objectId: "plate", property: "x", keys: [key(0, 100, "custom-bezier", { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 }), key(20, 160)] }] } } as never;
    const drawn = renderKeyCard(fakeDocument, keyCard(back, [keyId("plate", "x", 0)], rate)!, handlers) as unknown as Fake;
    const sel = drawn.all().find((n) => n.tag === "select")!;
    expect(sel.value).toBe("preset:back-out");
    expect(sel.children.some((o) => o.textContent === "Back out")).toBe(true);
    expect(sel.children.filter((o) => o.textContent === "Back out")).toHaveLength(1);
  });
});
