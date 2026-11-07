// The scene import report (11.17): every element is listed with its tier and
// what it became, and every substitution is shown with its replacement and
// reason. Nothing the pipeline reported can be left out of the panel.

import { describe, expect, it } from "vitest";

import type { ImportReport } from "@grapix/contracts";

import type { UiNode } from "../src/agent-surface";
import { sceneImportPanel, tierCounts, worstSeverity, worstTier } from "../src/import-panel";

const EVERY_TIER: ImportReport = {
  sourceFormat: "svg",
  sourceName: "brand.svg",
  sourceHash: "b11b7df2fd035d701dd5bf39f41cf4b8aac0b1b851e5a4c5949b40468fe2ae49",
  entries: [
    { sourceId: "background", sourceName: "background", tier: "native", objectId: "background", substitutions: [] },
    {
      sourceId: "lower-third", sourceName: "lower-third", tier: "container", objectId: "lower-third",
      substitutions: [{ sourceFeature: "svg:g", replacedWith: "an empty group rectangle", reason: "groups have no first-class container yet", severity: "warning" }],
    },
    {
      sourceId: "swoosh", sourceName: "swoosh", tier: "flattened", objectId: "swoosh",
      substitutions: [{ sourceFeature: "svg:path", replacedWith: "its bounding rectangle", reason: "vector paths are not editable", severity: "warning" }],
    },
    {
      sourceId: "logo", sourceName: "logo", tier: "rasterized",
      substitutions: [{ sourceFeature: "svg:image", replacedWith: "nothing; the raster was not imported", reason: "embedded raster data needs an asset import", severity: "error" }],
    },
  ],
};

function walk(node: UiNode): UiNode[] {
  return [node, ...(node.children ?? []).flatMap(walk)];
}

describe("scene import report", () => {
  it("names the least faithful tier and the most serious substitution", () => {
    expect(worstTier(EVERY_TIER)).toBe("rasterized");
    expect(worstSeverity(EVERY_TIER)).toBe("error");
    expect(tierCounts(EVERY_TIER)).toBe("1 native · 1 container · 1 flattened · 1 rasterized");
  });

  it("lists every element with its tier and what it became", () => {
    const panel = sceneImportPanel(EVERY_TIER);
    const items = walk(panel).filter((node) => node.role === "listitem");
    expect(items.map((item) => [item.label, item.value, item.description])).toEqual([
      ["background", "Native", "became background"],
      ["lower-third", "Container", "became lower-third"],
      ["swoosh", "Flattened", "became swoosh"],
      ["logo", "Rasterized", "dropped, no object"],
    ]);
  });

  it("shows every substitution with its replacement, reason and severity", () => {
    const nodes = walk(sceneImportPanel(EVERY_TIER)).filter((node) => node.id.includes("/substitution/"));
    expect(nodes).toHaveLength(3);
    for (const [at, entry] of EVERY_TIER.entries.slice(1).entries()) {
      const substitution = entry.substitutions[0]!;
      expect(nodes[at]!.label).toBe(`${substitution.sourceFeature} → ${substitution.replacedWith}`);
      expect(nodes[at]!.description).toBe(substitution.reason);
      expect(nodes[at]!.value).toBe(substitution.severity);
    }
    expect(nodes.map((node) => node.role)).toEqual(["status", "status", "alert"]);
  });

  it("interrupts when something was lost, and says so plainly when nothing was", () => {
    const panel = sceneImportPanel(EVERY_TIER);
    const summary = walk(panel).find((node) => node.id === "scene-import/summary")!;
    expect(summary.role).toBe("alert");
    expect(summary.value).toBe("3 substitution(s); the least faithful element is rasterized.");
    expect(panel.label).toBe("Imported brand.svg");

    const clean: ImportReport = { ...EVERY_TIER, entries: [EVERY_TIER.entries[0]!] };
    const quiet = walk(sceneImportPanel(clean)).find((node) => node.id === "scene-import/summary")!;
    expect(quiet.role).toBe("status");
    expect(quiet.value).toBe("Everything imported natively; nothing was substituted.");
  });

  it("keeps ids unique when a source repeats an element id", () => {
    const repeated: ImportReport = { ...EVERY_TIER, entries: [EVERY_TIER.entries[0]!, EVERY_TIER.entries[0]!] };
    const ids = walk(sceneImportPanel(repeated)).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
