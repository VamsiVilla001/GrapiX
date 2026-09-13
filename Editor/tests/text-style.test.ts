import { describe, expect, it } from "vitest";
import type { SceneDocument } from "@grapix/contracts";

import { textStylePanel, textStyleUsers } from "../src/text-style";

function document(): SceneDocument {
  return {
    id: "score",
    name: "Scoreboard",
    textStyles: [
      {
        styleId: "headline",
        name: "Headline",
        fontId: "inter",
        size: 48,
        lineHeight: null,
        letterSpacing: null,
        textCase: "upper",
        fill: null,
        stroke: null,
        strokeWidth: null,
      },
    ],
    objects: [
      {
        type: "text",
        id: "title",
        name: "Title",
        fontId: "inter",
        size: 48,
        textCase: "upper",
        lineHeight: 1.2,
        letterSpacing: 10,
      },
      {
        type: "text",
        id: "subtitle",
        name: "Subtitle",
        fontId: "inter",
        size: 30,
        textCase: "original",
        lineHeight: 1.2,
        letterSpacing: 10,
      },
    ],
  } as unknown as SceneDocument;
}

describe("text style panel", () => {
  it("lists each style with the text objects currently using its literal bundle", () => {
    expect(textStyleUsers(document(), "headline")).toEqual(["title"]);

    const panel = textStylePanel(document(), { selectedObjectIds: ["title"] });
    const style = panel.children?.[0]?.children?.[0];
    expect(style?.label).toBe("Headline");
    expect(style?.children?.[0]?.value).toBe("title");
    expect(style?.actions?.map((action) => action.name)).toEqual(["apply", "reveal"]);
  });

  it("names why saving or applying is unavailable instead of silently narrowing selection", () => {
    const panel = textStylePanel(document(), { selectedObjectIds: [] });
    expect(panel.actions?.[0]?.unavailable).toContain("select exactly one text object");
    expect(panel.children?.[0]?.children?.[0]?.actions?.[0]?.unavailable).toContain(
      "select one or more objects",
    );
  });
});
