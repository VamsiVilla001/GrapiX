import { describe, expect, it } from "vitest";

import { ADD_BUTTONS, EMPTY_GRAPHIC, EMPTY_WORDS, controlledIds, elementTag, isField, kindWord, newElementName } from "../src/elements-list";

const el = (id: string, type: string, bindings?: Record<string, unknown>) => ({ id, type, ...(bindings === undefined ? {} : { bindings }) }) as unknown as Parameters<typeof elementTag>[0];

describe("what each element is called", () => {
  it("calls a rect a box, and an unknown kind by its own name", () => {
    expect(kindWord("rect")).toBe("box");
    expect(kindWord("text")).toBe("text");
    expect(kindWord("paint")).toBe("colour");
    expect(kindWord("hologram")).toBe("hologram");
  });
});

describe("a field is an element an operator can fill in", () => {
  const controlled = controlledIds({ controls: [{ fieldId: "f1", label: "Name", objectId: "name", property: "text", kind: "text" }] } as never);

  it("is one a template control points at, or one a data binding drives", () => {
    expect(isField(el("name", "text"), controlled)).toBe(true);
    expect(isField(el("logo", "image", { assetId: "$team.logo" }), controlled)).toBe(true);
    expect(isField(el("plate", "rect"), controlled)).toBe(false);
    expect(isField(el("plate", "rect", {}), controlled)).toBe(false);
  });

  it("is said on the line after what it is", () => {
    expect(elementTag(el("name", "text"), controlled)).toBe("text · field");
    expect(elementTag(el("logo", "image", { assetId: "$team.logo" }), controlled)).toBe("image · field");
    expect(elementTag(el("plate", "rect"), controlled)).toBe("box");
  });

  it("tolerates a scene with no controls", () => {
    expect(controlledIds({} as never).size).toBe(0);
  });
});

describe("a name for a new element", () => {
  it("is the kind's word, then numbered when taken", () => {
    expect(newElementName("rect", [])).toBe("Box");
    expect(newElementName("rect", [{ name: "Box" }])).toBe("Box 2");
    expect(newElementName("rect", [{ name: "Box" }, { name: "Box 2" }, { name: "Box 4" }])).toBe("Box 3");
    expect(newElementName("text", [{ name: "Box" }])).toBe("Text");
  });
});

describe("an empty graphic says what to do, and offers only what exists", () => {
  it("is not preset, and brings in a drawing rather than promising a Figma import that is not built", () => {
    expect(EMPTY_GRAPHIC.title).toBe("This graphic is empty");
    expect(EMPTY_GRAPHIC.body).toContain("Nothing is preset");
    expect(EMPTY_GRAPHIC.add).toBe("Add a box");
    expect(EMPTY_GRAPHIC.bringIn).toBe("Bring in a drawing…");
    expect(EMPTY_GRAPHIC.bringIn).not.toMatch(/figma/i);
    expect(EMPTY_WORDS).toContain("bring in a drawing");
  });
});

describe("the three buttons", () => {
  it("make a box, some text and an image, in that order", () => {
    expect(ADD_BUTTONS.map((b) => [b.label, b.kind])).toEqual([["+ Box", "rect"], ["+ Text", "text"], ["+ Image", "image"]]);
  });
});
