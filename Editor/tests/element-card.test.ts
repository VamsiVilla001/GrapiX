import { describe, expect, it } from "vitest";

import { animatedWords, colourText, elementCard } from "../src/element-card";

const base = { visible: true, locked: false, opacity: 1, x: 0, y: 0, width: 400, height: 80, strokeWidth: 0, rotation: 0, scaleX: 1, scaleY: 1 };
const solid = (r: number, g: number, b: number, a = 1) => ({ type: "solid", color: { r, g, b, a, space: "srgb" } }) as never;

const doc = (objects: unknown[], over: Record<string, unknown> = {}) =>
  ({
    fonts: [{ fontId: "anybody-bold", displayName: "Anybody Bold" }],
    timeline: { durationFrames: 250, channels: [], pathChannels: [] },
    controls: [],
    objects,
    ...over,
  }) as never;

const text = (over: Record<string, unknown> = {}) =>
  ({ type: "text", id: "name", name: "Name", ...base, text: "ARJUN", fontId: "anybody-bold", size: 36, fill: solid(0.95, 0.94, 0.92), align: "left", verticalAlign: "middle", layout: "point", autoFit: "shrink", ...over }) as never;

const rows = (card: ReturnType<typeof elementCard>, id: string) => card.sections.find((s) => s.id === id)!.rows.map((r) => [r.label, r.value]);

describe("the Style block", () => {
  it("says what a text looks like", () => {
    const card = elementCard(doc([text()]), text());
    expect(card.name).toBe("Name");
    expect(rows(card, "style")).toEqual([["Font", "Anybody Bold · 36"], ["Colour", "#F2F0EB · 100%"], ["Align", "Left · Middle"], ["Box and fit", "Point · shrinks to fit"]]);
  });

  it("names the font by its id when the scene does not carry it", () => {
    expect(rows(elementCard(doc([], { fonts: [] }), text({ fontId: "mystery" })), "style")[0]).toEqual(["Font", "mystery · 36"]);
  });

  it("says what a box looks like: colour, stroke when it has one, size and corner", () => {
    const box = { type: "rect", id: "plate", name: "Name plate", ...base, fill: solid(0, 0, 0, 0.5), stroke: solid(1, 1, 1), strokeWidth: 2, radius: 6 } as never;
    expect(rows(elementCard(doc([box]), box), "style")).toEqual([["Colour", "#000000 · 50%"], ["Stroke", "2 px · #FFFFFF · 100%"], ["Size", "400 × 80"], ["Corner radius", "6"]]);
    const plain = { type: "rect", id: "p", name: "P", ...base, radius: 0 } as never;
    expect(rows(elementCard(doc([plain]), plain), "style")).toEqual([["Colour", "None"], ["Size", "400 × 80"]]);
  });

  it("says what an image does to its picture, and that a group has no look of its own", () => {
    const image = { type: "image", id: "logo", name: "Team logo", ...base, assetId: "a", fit: "contain" } as never;
    expect(rows(elementCard(doc([image]), image), "style")).toEqual([["Fit", "contain"], ["Size", "400 × 80"]]);
    const group = { type: "group", id: "g", name: "Strap", ...base, childIds: [] } as never;
    const card = elementCard(doc([group]), group);
    expect(card.sections[0]!.rows).toEqual([]);
    expect(card.sections[0]!.empty).toContain("elements inside it");
  });
});

describe("the Motion block", () => {
  it("says when nothing moves", () => {
    expect(rows(elementCard(doc([text()]), text()), "motion")).toEqual([["Animated", "Not animated"]]);
  });

  it("names what moves in words, and counts the keys", () => {
    const channels = [
      { objectId: "name", property: "x", keys: [{}, {}] },
      { objectId: "name", property: "y", keys: [{}, {}] },
      { objectId: "name", property: "opacity", keys: [{}, {}, {}] },
      { objectId: "other", property: "rotation", keys: [{}] },
    ];
    expect(rows(elementCard(doc([text()], { timeline: { channels, pathChannels: [] } }), text()), "motion")).toEqual([["Animated", "Position, Opacity"], ["Keyframes", "7"]]);
  });

  it("counts an animated path", () => {
    const pathChannels = [{ objectId: "name", target: { kind: "shape", subpath: 0 }, keys: [{}, {}] }];
    expect(rows(elementCard(doc([text()], { timeline: { channels: [], pathChannels } }), text()), "motion")).toEqual([["Animated", "Path"], ["Keyframes", "2"]]);
  });

  it("puts position, scale, rotation and opacity in the order a person thinks of them", () => {
    expect(animatedWords(["opacity", "scaleX", "y", "rotation", "x"])).toBe("Position, Scale, Rotation, Opacity");
    expect(animatedWords(["effects.glow.radius", "x"])).toBe("Position, Effect");
  });
});

describe("the Data block", () => {
  it("shows what drives the element and who fills it in", () => {
    const bound = text({ bindings: { text: "player.display_name" } });
    const controls = [{ fieldId: "f1", label: "Name", objectId: "name", property: "text", kind: "text" }];
    expect(rows(elementCard(doc([bound], { controls }), bound), "data")).toEqual([["Value", "player.display_name"], ["Filled in by", "the operator, as “Name”"]]);
  });

  it("says when the element is not linked to data", () => {
    const section = elementCard(doc([text()]), text()).sections.find((s) => s.id === "data")!;
    expect(section.rows).toEqual([]);
    expect(section.empty).toBe("Not linked to data.");
  });
});

describe("a colour as a person reads it", () => {
  it("is a hex and an opacity, Gradient, or None", () => {
    expect(colourText(solid(1, 0.5, 0))).toBe("#FF8000 · 100%");
    expect(colourText(undefined)).toBe("None");
    expect(colourText({ type: "none" } as never)).toBe("None");
    expect(colourText({ type: "linear-gradient" } as never)).toBe("Gradient");
  });
});
