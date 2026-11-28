// The Publish panel's checks (the new Figma UI, B6; plan row 7.7 Check graphic and 11.67).
//
// What the design shows: Destinations on the left, a "Publish <graphic> to Playout" list of checks in the middle, and a
// "Package" card on the right. What is built here is only what has a rule behind it: every check row is one the shell's
// `cmd_scene_preflight` or the font manager can fail, so a row that says FIX names what to fix, and Publish stays off until
// none does. The design's journey chips and its "Fix next issue" button are not drawn (owner decision, 24 Nov 2026).
//
// The Test row (row 11.153, Figma B6) shows what the engine's record check said, and is drawn only when a text is bound to data.
// Asked of Jev and Laya first (docs/evidence/11.153/jev-laya-publish-test-row.json): a Test that says FIX blocks Publish like the other
// rows (Jev B at 0.75, Laya B at 0.53); before a check, or when the graphic changed since, the row says so in words and never blocks and
// never reads OK (Jev A at 0.98, Laya A); the check runs when the designer asks, on the row or on the Data screen (Jev A at 0.92; Laya
// preferred checking at Publish and differed at 0.43, flagged), one report shared by both.
//
// This module is pure: it reads the scene, the blockers the shell answered with and the facts the page already holds, and
// returns what to draw. The view draws it; nothing here calls the shell.

import type { SceneDocument } from "@grapix/contracts";

import { checkLines, tallyWords, type RecordsState } from "./fit-records";

/** One thing the shell's Check graphic found (`cmd_scene_preflight`). */
export interface Blocker {
  readonly code: string;
  readonly subject: string;
  readonly message: string;
}

export type CheckId = "style" | "data" | "test" | "assets" | "scene";
/** `idle` is a check not made (or out of date): neither OK nor FIX, and it never blocks. */
export type CheckState = "ok" | "fix" | "wait" | "idle";

export interface CheckRow {
  readonly id: CheckId;
  readonly label: string;
  readonly state: CheckState;
  /** What was found, in words: what is fine, or what to fix. */
  readonly text: string;
  /** Every blocker behind a FIX row, one line each. */
  readonly details: readonly string[];
}

export interface Chip {
  readonly text: string;
  readonly tone: "neutral" | "ok" | "warn";
}

export interface PublishView {
  readonly title: string;
  readonly rows: readonly CheckRow[];
  readonly chips: readonly Chip[];
  /** Publish is allowed only once the check has answered and no row says FIX. */
  readonly canPublish: boolean;
  readonly fixCount: number;
  /** The package card: label and value. */
  readonly contents: readonly { readonly label: string; readonly value: string }[];
}

export interface PublishInput {
  readonly name: string;
  readonly sceneId: string;
  readonly document: SceneDocument;
  /** The shell's answer; `undefined` while it has not answered (a check is running, or the shell could not be asked). */
  readonly blockers: readonly Blocker[] | undefined;
  /** Display names of fonts the font manager cannot resolve (these block Publish from every route). */
  readonly fontBlockers: readonly string[];
  readonly engine: "ready" | "not-ready";
  /** The revision last published for this scene, when the project lists one. */
  readonly publishedRevision?: number;
  /** The revision and fingerprint this session published last, when it has. */
  readonly lastPublish?: { readonly revision: number; readonly contentHash: string };
  /** What the record check last said (11.153), stale when the graphic changed since. */
  readonly records?: RecordsState;
}

/** Which check a blocker belongs to, by its refusal code: fonts, bindings, pictures kept in the project, then the rest (the Scene ID). */
export function checkOf(code: string): Exclude<CheckId, "test"> {
  const lower = code.toLowerCase();
  if (lower.includes("font")) return "style";
  if (lower.includes("binding")) return "data";
  if (lower.includes("asset") || lower.includes("package")) return "assets";
  return "scene";
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const OK_TEXT: Readonly<Record<Exclude<CheckId, "test">, string>> = {
  style: "every font the graphic uses is available",
  data: "every bound field has a source",
  assets: "every picture is kept in the project",
  scene: "the Scene ID is valid",
};
const LABEL: Readonly<Record<CheckId, string>> = { style: "Style", data: "Data", test: "Test", assets: "Assets", scene: "Scene" };
const ORDER: readonly Exclude<CheckId, "test">[] = ["style", "data", "assets", "scene"];

function fixText(id: Exclude<CheckId, "test">, count: number): string {
  switch (id) {
    case "style":
      return `${plural(count, "font")} cannot be used`;
    case "data":
      return `${plural(count, "field")} cannot be filled`;
    case "assets":
      return `${plural(count, "picture")} not kept in the project`;
    case "scene":
      return count === 1 ? "the Scene ID is refused" : `${count} problems with the scene`;
  }
}

function bindingNames(document: SceneDocument): string[] {
  const names: string[] = [];
  for (const object of document.objects) {
    for (const property of Object.keys(object.bindings ?? {})) names.push(`${object.name}.${property}`);
  }
  return names;
}

function animatedObjects(document: SceneDocument): number {
  return new Set((document.timeline.channels ?? []).filter((c) => c.keys.length > 0).map((c) => c.objectId)).size;
}

/** The Test row: undefined when no text is bound to data (nothing to test), else what the last check said, in words. */
export function testRow(input: PublishInput): CheckRow | undefined {
  const bound = input.document.objects.some((object) => object.type === "text" && typeof object.bindings?.text === "string");
  if (!bound) return undefined;
  const state = input.records ?? {};
  const row = (rowState: CheckState, text: string, details: readonly string[] = []): CheckRow => ({ id: "test", label: LABEL.test, state: rowState, text, details });
  if (state.checking === true) return row("wait", "checking the records…");
  if (state.report === undefined) return row("idle", state.problem ?? "not checked yet: Check records measures each record's text in its box");
  const count = state.report.records.length;
  if (state.stale === true) return row("idle", `out of date, the graphic changed since the check (it said ${count === 0 ? "no records" : tallyWords(state.report)}): check again`);
  if (count === 0) return row("idle", "no records to test");
  const lines = checkLines(input.document, state.report);
  if (lines.length > 0) return row("fix", tallyWords(state.report), lines);
  return row("ok", count === 1 ? "the record fits" : `all ${count} records fit`);
}

/** The whole panel, from the scene and what has been found. */
export function publishView(input: PublishInput): PublishView {
  const answered = input.blockers !== undefined;
  const byCheck = new Map<Exclude<CheckId, "test">, string[]>();
  for (const blocker of input.blockers ?? []) {
    const id = checkOf(blocker.code);
    byCheck.set(id, [...(byCheck.get(id) ?? []), blocker.message]);
  }
  // A font the font manager cannot resolve blocks Publish whether or not the shell has answered.
  if (input.fontBlockers.length > 0) {
    const lines = input.fontBlockers.map((name) => `font "${name}" is not available`);
    const known = new Set(byCheck.get("style") ?? []);
    byCheck.set("style", [...(byCheck.get("style") ?? []), ...lines.filter((line) => !known.has(line))]);
  }

  const bound = bindingNames(input.document);
  const rows: CheckRow[] = ORDER.map((id) => {
    const found = byCheck.get(id) ?? [];
    if (found.length > 0) return { id, label: LABEL[id], state: "fix", text: fixText(id, found.length), details: found };
    if (!answered) return { id, label: LABEL[id], state: "wait", text: "checking…", details: [] };
    // A graphic with no data fields is a complete graphic: nothing requires a binding to publish (owner, 25 Nov 2026).
    const text = id === "data" && bound.length === 0 ? "no data fields; this graphic publishes as it is" : OK_TEXT[id];
    return { id, label: LABEL[id], state: "ok", text, details: [] };
  });
  const test = testRow(input);
  if (test !== undefined) rows.splice(rows.findIndex((row) => row.id === "data") + 1, 0, test);
  const fixCount = rows.filter((row) => row.state === "fix").length;
  const canPublish = answered && fixCount === 0;

  const next = (input.publishedRevision ?? 0) + 1;
  const chips: Chip[] = [
    { text: input.publishedRevision === undefined ? "NEW GRAPHIC" : `NEW PACKAGE r${next}`, tone: "neutral" },
    fixCount > 0
      ? { text: `${plural(fixCount, "thing").toUpperCase()} TO FIX FIRST`, tone: "warn" }
      : answered
        ? { text: "READY TO PUBLISH", tone: "ok" }
        : { text: "CHECKING", tone: "neutral" },
    { text: input.engine === "ready" ? "ENGINE READY" : "ENGINE NOT READY", tone: input.engine === "ready" ? "ok" : "warn" },
  ];

  const animated = animatedObjects(input.document);
  const canvas = input.document.canvas;
  const rate = canvas.frameRate.den === 1 ? `${canvas.frameRate.num} fps` : `${Math.round((canvas.frameRate.num / canvas.frameRate.den) * 100) / 100} fps`;
  const contents = [
    { label: "Scene ID", value: `${input.sceneId} · same in Playout` },
    { label: "Fields", value: bound.length === 0 ? "none" : bound.join(", ") },
    { label: "Motion", value: animated === 0 ? "no keyframes" : `keyframes on ${plural(animated, "element")}` },
    { label: "Format", value: `${canvas.width}×${canvas.height} · ${rate} · ${input.document.colorDepth} bit` },
    { label: "Fingerprint", value: input.lastPublish === undefined ? "made when published" : `sha-256 ${input.lastPublish.contentHash.slice(0, 4)}…${input.lastPublish.contentHash.slice(-4)}` },
  ];

  return { title: `Publish ${input.name} to Playout`, rows, chips, canPublish, fixCount, contents };
}

/** The fixed sentence under the buttons: what Publish does and does not do. */
export const PUBLISH_NOTE =
  "Publish stays off until the checks pass. A published package is numbered and never changes; editing the graphic afterwards makes the next one. Publishing sends the package to Playout. It never puts anything on air.";

/** Who may do what with a published package (the design's card; the rules are the invariants, not options). */
export const WHO_CAN_DO_WHAT: readonly { readonly label: string; readonly value: string }[] = [
  { label: "Editor", value: "design and publish only" },
  { label: "Playout", value: "cue, continue, cue out, clear" },
  { label: "AI models", value: "read and propose; never cue" },
];
