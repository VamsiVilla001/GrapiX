import assert from "node:assert/strict";
import test from "node:test";
import type { FigmaMotionImportReport } from "@grapix/shared-types";
import {
  MOTION_COMPATIBILITY_LABELS,
  canStartMotionImport,
  missingNodeSummary,
  motionManifestDeliverable,
  motionReportGroups,
  parseMotionManifest,
  resolveMotionMode
} from "../src/components/designImportMotion";

test("the file tab falls back to prototype motion rather than requesting a manifest it cannot send", () => {
  // The design-file request body is the design's raw bytes, so a second file has nowhere to ride.
  // Sending full-motion-manifest anyway would earn a warning and no motion.
  assert.equal(resolveMotionMode("full-motion-manifest", "file"), "design-and-prototype-motion");
  assert.equal(resolveMotionMode("full-motion-manifest", "figma"), "full-motion-manifest");
  assert.equal(motionManifestDeliverable("file"), false);
  assert.equal(motionManifestDeliverable("figma"), true);
});

test("the other two modes pass through both tabs unchanged", () => {
  for (const sourceMode of ["file", "figma"] as const) {
    assert.equal(resolveMotionMode("design-only", sourceMode), "design-only");
    assert.equal(resolveMotionMode("design-and-prototype-motion", sourceMode), "design-and-prototype-motion");
  }
});

test("an import that needs a manifest waits for one", () => {
  // Otherwise the import runs, succeeds, and silently lacks the motion the author came for.
  assert.equal(canStartMotionImport("full-motion-manifest", false), false);
  assert.equal(canStartMotionImport("full-motion-manifest", true), true);
  // The fallback mode needs no file, so it must not be blocked by the absence of one.
  assert.equal(canStartMotionImport("design-and-prototype-motion", false), true);
  assert.equal(canStartMotionImport("design-only", false), true);
});

test("a manifest is validated when it is chosen, not when the import fails", () => {
  const manifest = parseMotionManifest(JSON.stringify({
    version: 1,
    generator: "grapix-figma-motion-bridge/1.0.0",
    exportedAt: "2026-08-06T00:00:00.000Z",
    timelines: [{ id: "frame_1:1", name: "Lower Third", durationMs: 400, origin: "bridge-export", nodes: [] }]
  }));
  assert.equal(manifest.timelines.length, 1);

  assert.throws(() => parseMotionManifest("{ not json"), /not valid JSON/);
  assert.throws(() => parseMotionManifest("[]"), /not a GrapiX motion manifest/);
  assert.throws(() => parseMotionManifest("null"), /not a GrapiX motion manifest/);
  // A scene file is the wrong JSON an author is most likely to choose by mistake.
  assert.throws(() => parseMotionManifest(JSON.stringify({ version: 1, objects: [] })), /expected version 1 with a timelines array/);
  assert.throws(() => parseMotionManifest(JSON.stringify({ version: 2, timelines: [] })), /expected version 1/);
});

function report(entries: FigmaMotionImportReport["entries"]): FigmaMotionImportReport {
  return {
    timelines: 1,
    timelinesConverted: 1,
    matchedNodes: 1,
    missingNodes: [],
    channelsCreated: entries.length,
    keyframesCreated: entries.reduce((total, entry) => total + entry.keyframesCreated, 0),
    entries
  };
}

function entry(compatibility: FigmaMotionImportReport["entries"][number]["compatibility"], property: string) {
  return { compatibility, nodeId: "1:1", property, detail: property, keyframesCreated: 2 };
}

test("the report leads with what could not be brought across", () => {
  // The author's question is "what did I lose". Source order does not answer it, and the group
  // needing a decision must not be below three groups that worked.
  const groups = motionReportGroups(report([
    entry("native-editable", "x"),
    entry("unsupported", "cornerRadius"),
    entry("sampled", "opacity"),
    entry("native-editable", "y")
  ]));

  assert.deepEqual(groups.map((group) => group.compatibility), ["unsupported", "sampled", "native-editable"]);
  assert.equal(groups[2].entries.length, 2, "entries of one outcome are collected together");
});

test("empty groups are dropped rather than rendered as headings with nothing under them", () => {
  assert.deepEqual(motionReportGroups(report([])), []);
  const groups = motionReportGroups(report([entry("prototype-transition", "opacity")]));
  assert.equal(groups.length, 1);
});

test("every compatibility outcome has a label", () => {
  // A missing label renders as blank, which reads as "nothing happened" for the exact outcomes
  // the report exists to explain.
  for (const compatibility of ["native-editable", "smart-animate-converted", "prototype-transition", "sampled", "unsupported"] as const) {
    assert.ok(MOTION_COMPATIBILITY_LABELS[compatibility]?.length);
  }
});

test("missing layers are named, and truncated before the sentence stops being read", () => {
  assert.equal(missingNodeSummary(["1:1", "1:2"]), "1:1, 1:2");
  assert.equal(missingNodeSummary([]), "");

  const many = Array.from({ length: 11 }, (_, index) => `1:${index}`);
  const summary = missingNodeSummary(many);
  assert.match(summary, /and 3 more$/);
  assert.equal(summary.startsWith("1:0, 1:1"), true);
});
