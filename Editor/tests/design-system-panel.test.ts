// The design system panel (11.14) and the import report (11.17).
//
// 11.17's done-when is "nothing substituted without being named", and the
// failure it guards is a report that summarises. A reviewer confirming a brand
// pack is making an irreversible decision — a version is immutable once
// confirmed — so every value the token contract could not hold must be on
// screen with the value itself, not counted and collapsed.

import { describe, expect, it } from "vitest";

import type { DesignSystem, DesignSystemDraft } from "@grapix/contracts";
import { agentView, findNode } from "../src/agent-surface";
import {
  describeValue,
  designSystemPanel,
  importReportPanel,
} from "../src/design-system-panel";

const system: DesignSystem = {
  name: "Brand",
  version: 3,
  visual: {
    palette: [
      { name: "primary", value: { r: 0.1, g: 0.5, b: 0.9, a: 1, space: "srgb" } },
      { name: "ink", value: { r: 0, g: 0, b: 0, a: 1, space: "srgb" } },
    ],
    spacing: [8, 16, 24],
    minTextSize: 18,
  },
  motion: { duration: [], easing: [], stagger: [] },
} as unknown as DesignSystem;

function draft(overrides: Partial<DesignSystemDraft> = {}): DesignSystemDraft {
  return {
    name: "Brand",
    visual: { palette: [], spacing: [16], minTextSize: 18 },
    motion: { duration: [], easing: [], stagger: [] },
    brief: "",
    mappings: [{ sourcePath: "space.base", tokenPath: "visual.spacing.base" }],
    unexpressible: [],
    source: { kind: "w3c", sha256: "abc", document: "{}" },
    ...overrides,
  } as unknown as DesignSystemDraft;
}

describe("tokens as the path of least resistance (11.14)", () => {
  it("every palette token and spacing step is directly choosable", () => {
    const panel = designSystemPanel(system);

    const palette = findNode(panel, "design-system/palette")!;
    expect((palette.children ?? []).map((token) => token.label)).toEqual(["primary", "ink"]);
    for (const token of palette.children ?? []) {
      expect(token.actions!.map((action) => action.name)).toEqual(["choose"]);
    }

    const spacing = findNode(panel, "design-system/spacing")!;
    expect((spacing.children ?? []).map((step) => step.value)).toEqual(["8", "16", "24"]);
  });

  it("a custom value is possible, comes last, and says what it costs", () => {
    // Part G: a system that blocks legitimate work is one people bypass
    // entirely. So the escape hatch stays open — it is simply not the default.
    const panel = designSystemPanel(system);
    const order = (panel.children ?? []).map((child) => child.id);
    expect(order).toEqual([
      "design-system/palette",
      "design-system/spacing",
      "design-system/custom",
    ]);

    const custom = findNode(panel, "design-system/custom")!;
    const action = custom.actions!.find((a) => a.name === "enterCustomValue")!;
    expect(action.unavailable).toBeUndefined();
    expect(custom.description).toContain("leaves the design system");
  });

  it("the chosen token is marked selected", () => {
    const panel = designSystemPanel(system, { chosenToken: "ink" });
    expect(findNode(panel, "token/color/ink")!.selected).toBe(true);
    expect(findNode(panel, "token/color/primary")!.selected).toBe(false);
  });
});

describe("the import report names everything it could not express (11.17)", () => {
  const unexpressible = [
    {
      sourcePath: "effect.card",
      sourceType: "shadow",
      reason: "this token type has no GrapiX equivalent",
      value: { offsetX: "0px", blur: "4px" },
    },
    {
      sourcePath: "grid.columns",
      sourceType: "untyped",
      reason: "the source declares no type, and a type is never inferred",
      value: 12,
    },
    {
      sourcePath: "type.body",
      sourceType: "fontSize",
      reason: "the token contract holds a legibility floor, not a type ramp",
      value: "24px",
    },
  ];

  it("every entry appears with its path, type, reason and value", () => {
    const panel = importReportPanel(
      draft({ unexpressible } as unknown as Partial<DesignSystemDraft>),
    );
    const list = findNode(panel, "import-report/unexpressible")!;

    expect(list.children).toHaveLength(3);
    for (const entry of unexpressible) {
      const row = findNode(panel, `unexpressible/${entry.sourcePath}`)!;
      expect(row, `${entry.sourcePath} must be listed`).toBeDefined();
      expect(row.description).toContain(entry.sourceType);
      expect(row.description).toContain(entry.reason);
      // The value itself, because that is what a reviewer judges.
      expect(row.value).toBe(describeValue(entry.value));
    }
    // The shadow's offsets survive rather than becoming "object".
    expect(findNode(panel, "unexpressible/effect.card")!.value).toContain("blur");
  });

  it("what could not be expressed interrupts rather than waits to be noticed", () => {
    const withLoss = importReportPanel(
      draft({ unexpressible } as unknown as Partial<DesignSystemDraft>),
    );
    expect(findNode(withLoss, "import-report/unexpressible")!.role).toBe("alert");

    const clean = importReportPanel(draft());
    expect(findNode(clean, "import-report/unexpressible")!.role).toBe("status");
    expect(findNode(clean, "import-report/unexpressible")!.value).toBe(
      "everything in the source mapped",
    );
  });

  it("what was mapped is shown beside it, so the halves are comparable", () => {
    const panel = importReportPanel(draft());
    const mapped = findNode(panel, "import-report/mapped")!;
    expect((mapped.children ?? []).map((row) => [row.label, row.value])).toEqual([
      ["space.base", "visual.spacing.base"],
    ]);
  });
});

describe("the UI does not offer what the store will refuse", () => {
  it("confirm is unavailable without a legibility floor, and says so", () => {
    const noFloor = importReportPanel(
      draft({ visual: { palette: [], spacing: [], minTextSize: null } } as unknown as Partial<DesignSystemDraft>),
    );
    const confirm = noFloor.actions!.find((action) => action.name === "confirm")!;
    expect(confirm.unavailable).toContain("minimum text size");

    // Discarding is always possible: a draft you cannot confirm is exactly
    // the one you most need to be able to throw away.
    expect(noFloor.actions!.find((a) => a.name === "discard")!.unavailable).toBeUndefined();
  });

  it("confirm is available once the floor is present", () => {
    const panel = importReportPanel(draft());
    expect(panel.actions!.find((action) => action.name === "confirm")!.unavailable).toBeUndefined();
  });
});

describe("an agent reviewing an import sees what a human sees", () => {
  it("the whole unexpressible list survives the agent projection", () => {
    const panel = importReportPanel(
      draft({
        unexpressible: [
          {
            sourcePath: "effect.card",
            sourceType: "shadow",
            reason: "no equivalent",
            value: { blur: "4px" },
          },
        ],
      } as unknown as Partial<DesignSystemDraft>),
    );
    const view = agentView(panel);

    const list = view.children.find((child) => child.id === "import-report/unexpressible")!;
    expect(list.children).toHaveLength(1);
    expect(list.children[0]!.label).toBe("effect.card");
    expect(list.children[0]!.value).toContain("blur");
  });
});
