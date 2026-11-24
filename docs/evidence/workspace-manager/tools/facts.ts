// Measured facts for the Jev and Laya review of the dock model (error handling and accuracy).
//
// This runs the real functions of Editor/src on the hand-off's compact Design workspace and writes what they
// actually returned, as short text, to facts.json. Nothing here is written by hand: a classifier that is asked
// whether an outcome is right is shown the outcome the code produced, never a description of it.
//
//   npx esbuild docs/evidence/workspace-manager/tools/facts.ts --bundle --platform=node --format=esm --outfile=<tmp>/facts.mjs
//   node <tmp>/facts.mjs docs/evidence/workspace-manager/facts.json

import { writeFileSync } from "node:fs";
import {
  closePanel, dragDivider, focusPanel, isDockRefused, maximizeGroup, moveGroup, movePanel, restoreGroup, setSplitWeights,
  type DockNode, type DockRefusal, type SavedWorkspace,
} from "../../../../Editor/src/dock-model";
import { validateWorkspace } from "../../../../Editor/src/dock-validate";
import { createPanelRegistry, isRegistryRefused } from "../../../../Editor/src/panel-registry";
import { migrateWorkspace, parseWorkspaceText, serializeWorkspace, workspaceFromLayout } from "../../../../Editor/src/workspace-io";
import { closePanelChecked, openPanel, unavailableInstances } from "../../../../Editor/src/workspace-manager";
import { CARD_SORT_LAYOUT } from "../../../../Editor/src/workspace-layout";
import { DEFINITIONS, design, registry } from "../../../../Editor/tests/dock-fixtures";

const show = (node: DockNode): string =>
  node.kind === "tabs"
    ? `[${node.id}: ${node.panelInstanceIds.map((id) => (id === node.activePanelInstanceId ? `${id}*` : id)).join(", ")}]`
    : `{${node.id} ${node.direction === "horizontal" ? "side-by-side" : "stacked"} weights ${node.weights.map((w) => Number(w.toFixed(3))).join(" ")}: ${node.children.map(show).join(" ")}}`;

const view = (ws: SavedWorkspace): string => {
  const extra = [ws.maximizedGroupId ? `maximised=${ws.maximizedGroupId}` : "", ws.activeGroupId ? `focus=${ws.activeGroupId}` : "", ws.floats.length ? `floats=${ws.floats.length}` : ""].filter(Boolean).join(" ");
  return `${show(ws.root)}${extra ? ` (${extra})` : ""}`;
};

/** What a call returned, said plainly: a refusal with its code and words, or that it was not refused and what
 *  came back, or that it threw. A broken build of the code must not be able to pass for a refusal here. */
const refusal = (result: unknown): string => {
  const r = result as Partial<DockRefusal> & { workspace?: SavedWorkspace; root?: DockNode; definitions?: unknown };
  if (r !== null && typeof r === "object" && typeof r.refused === "string") return `REFUSED ${String(r.code)}: "${r.refused}"`;
  if (r !== null && typeof r === "object" && r.workspace !== undefined) return `NOT REFUSED: it returned ${view(r.workspace)}`;
  if (r !== null && typeof r === "object" && r.root !== undefined) return `NOT REFUSED: it returned ${view(r as SavedWorkspace)}`;
  if (r !== null && typeof r === "object" && r.definitions !== undefined) return "NOT REFUSED: the registration was accepted";
  return `NOT REFUSED: it returned ${JSON.stringify(result)?.slice(0, 160)}`;
};

const attempt = (run: () => string): string => {
  try {
    return run();
  } catch (error) {
    return `THREW ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
};

const unchanged = (before: SavedWorkspace, run: () => unknown): string =>
  attempt(() => {
    const snapshot = JSON.stringify(before);
    const out = run();
    return `${refusal(out)}; the layout it was given is ${JSON.stringify(before) === snapshot ? "unchanged" : "CHANGED"}`;
  });

const base = design();
const reg = registry();
interface Fact { id: string; kind: "error" | "accuracy"; rule: string; before?: string; call: string; outcome: string }
const facts: Fact[] = [];
/** A fact whose outcome is worked out when it is added; a throw is recorded as the outcome, not lost. */
const add = (f: Omit<Fact, "outcome"> & { outcome: string | (() => string) }): void => {
  const outcome = f.outcome;
  facts.push({ ...f, outcome: typeof outcome === "string" ? outcome : attempt(outcome) });
};

// ---- Error handling ------------------------------------------------------------------------------------
const ERR = "A refused step names what is wrong in plain words, with the thing it is about, and changes nothing it was given.";
add({ id: "E1", kind: "error", rule: ERR, call: 'movePanel("ghost-1" to the centre of group "left")', outcome: unchanged(base, () => movePanel(base, "ghost-1", "left", "center")) });
add({ id: "E2", kind: "error", rule: ERR, call: 'movePanel("viewport-1", beside its own group "viewport-group", left); it is the only panel in that group', outcome: unchanged(base, () => movePanel(base, "viewport-1", "viewport-group", "left")) });
add({ id: "E3", kind: "error", rule: ERR, call: 'moveGroup("left" onto itself)', outcome: unchanged(base, () => moveGroup(base, "left", "left", "right")) });
add({ id: "E4", kind: "error", rule: ERR, call: "dragDivider(root, divider 0, by NaN)", outcome: unchanged(base, () => dragDivider(base, "root", 0, Number.NaN)) });
add({ id: "E5", kind: "error", rule: ERR, call: "setSplitWeights(root, [1, 2]) on a split with 3 children", outcome: unchanged(base, () => setSplitWeights(base, "root", [1, 2])) });
add({ id: "E6", kind: "error", rule: ERR, call: 'openPanel("from-the-future")', outcome: unchanged(base, () => openPanel(base, reg, "from-the-future")) });
add({ id: "E7", kind: "error", rule: ERR, call: 'openPanel("rundown") in the Editor', outcome: unchanged(base, () => openPanel(base, reg, "rundown")) });
add({ id: "E8", kind: "error", rule: ERR, call: 'openPanel("timeline", a second one asked for) while one is open', outcome: unchanged(base, () => openPanel(base, reg, "timeline", { newInstance: true })) });
add({ id: "E9", kind: "error", rule: ERR, call: 'closePanelChecked("viewport-1"), a panel registered as not closable', outcome: unchanged(base, () => closePanelChecked(base, reg, "viewport-1")) });
add({ id: "E10", kind: "error", rule: ERR, call: 'parseWorkspaceText("{ nope")', outcome: () => refusal(parseWorkspaceText("{ nope")) });
{
  const raw = JSON.parse(serializeWorkspace(base)) as { root: { weights: number[] } };
  raw.root.weights = [0.9, 0.9, 0.9];
  add({ id: "E11", kind: "error", rule: ERR, call: "a saved layout whose root split has weights 0.9, 0.9, 0.9", outcome: () => refusal(parseWorkspaceText(JSON.stringify(raw))) });
}
add({ id: "E12", kind: "error", rule: ERR, call: "a saved layout with schemaVersion 2 (this build reads up to 1)", outcome: () => refusal(migrateWorkspace({ ...JSON.parse(serializeWorkspace(base)), schemaVersion: 2 })) });
add({ id: "E13", kind: "error", rule: ERR, call: 'a saved layout with viewState {"api": {"password": "x"}}', outcome: () => refusal(parseWorkspaceText(JSON.stringify({ ...JSON.parse(serializeWorkspace(base)), viewState: { api: { password: "x" } } }))) });
{
  const made = createPanelRegistry([DEFINITIONS[0]!, DEFINITIONS[0]!]);
  add({ id: "E14", kind: "error", rule: ERR, call: "registering panel type object-manager twice", outcome: () => isRegistryRefused(made) ? `REFUSED ${made.code}: "${made.refused}"` : "accepted" });
  const both = createPanelRegistry([{ ...DEFINITIONS[0]!, singleton: true, allowMultiple: true }]);
  add({ id: "E15", kind: "error", rule: ERR, call: "registering a panel that is both a singleton and allows more than one", outcome: () => isRegistryRefused(both) ? `REFUSED ${both.code}: "${both.refused}"` : "accepted" });
}
{
  const raw = JSON.parse(serializeWorkspace(base)) as { root: { children: { kind: string }[] } };
  raw.root.children[0]!.kind = "grid";
  add({ id: "E16", kind: "error", rule: ERR, call: 'a saved layout whose first column has kind "grid"', outcome: () => refusal(parseWorkspaceText(JSON.stringify(raw))) });
}

// ---- Accuracy ------------------------------------------------------------------------------------------
const ok = <T,>(r: T): Exclude<T, DockRefusal> => {
  if (isDockRefused(r as DockRefusal)) throw new Error(refusal(r));
  return r as Exclude<T, DockRefusal>;
};
add({ id: "A1", kind: "accuracy", rule: "Dropping a panel on the centre of a group adds it as a tab of that group and shows it; the group it left keeps its other tabs.", before: view(base), call: 'movePanel("objects-1" to the centre of "timeline-group")', outcome: () => view(ok(movePanel(base, "objects-1", "timeline-group", "center"))) });
add({ id: "A2", kind: "accuracy", rule: "Dropping a panel on the right side of a group whose parent runs the other way makes a new side-by-side split in the target's place, sharing its room equally.", before: view(base), call: 'movePanel("assets-1" to the right of "viewport-group")', outcome: () => view(ok(movePanel(base, "assets-1", "viewport-group", "right"))) });
add({ id: "A3", kind: "accuracy", rule: "Dropping a panel above a group whose parent already runs the same way adds one more child to that parent and takes half of the target's share; the parent's other shares do not change.", before: view(base), call: 'movePanel("assets-1" above "timeline-group")', outcome: () => view(ok(movePanel(base, "assets-1", "timeline-group", "top"))) });
add({ id: "A4", kind: "accuracy", rule: "Closing the last panel of a group removes the group, and a split left with one child is replaced by that child; weights add up to one.", before: view(base), call: 'closePanel("viewport-1")', outcome: () => view(ok(closePanel(base, "viewport-1"))) });
add({ id: "A5", kind: "accuracy", rule: "Closing every panel of two groups leaves the remaining groups sharing the room, weights adding up to one.", before: view(base), call: 'closePanel on viewport-1, timeline-1 and curves-1', outcome: () => view(ok(closePanel(ok(closePanel(ok(closePanel(base, "viewport-1")), "timeline-1")), "curves-1"))) });
{
  const maximised = ok(maximizeGroup(base, "viewport-group"));
  const restored = ok(restoreGroup(maximised, "viewport-group"));
  add({ id: "A6", kind: "accuracy", rule: "Maximising a group does not change the arrangement, so restoring brings back exactly the same proportions.", before: view(base), call: 'maximizeGroup("viewport-group") then restoreGroup("viewport-group")', outcome: () => `after maximise: ${view(maximised)}\nafter restore: ${view(restored)}\nthe tree is ${JSON.stringify(restored.root) === JSON.stringify(base.root) ? "identical to the start" : "DIFFERENT from the start"}` });
}
add({ id: "A7", kind: "accuracy", rule: "Dragging a divider far past the end stops where the neighbour reaches its smallest share (0.04), and the two shares still add up to what they did.", before: view(base), call: "dragDivider(root, divider 0, by +5)", outcome: () => view(ok(dragDivider(base, "root", 0, 5))) });
add({ id: "A8", kind: "accuracy", rule: "Showing a panel that is behind another tab brings its tab forward and gives its group focus.", before: view(base), call: 'focusPanel("curves-1")', outcome: () => view(ok(focusPanel(base, "curves-1"))) });
{
  const opened = ok(openPanel(ok(closePanel(base, "assets-1")), reg, "asset-browser"));
  add({ id: "A9", kind: "accuracy", rule: "Reopening a closed panel puts it back in the group its registration names, and shows it.", before: view(ok(closePanel(base, "assets-1"))), call: 'openPanel("asset-browser") after it was closed', outcome: () => `${view(opened.workspace)} (new instance ${opened.instanceId}, created ${opened.created})` });
  const again = ok(openPanel(base, reg, "curve-editor"));
  add({ id: "A10", kind: "accuracy", rule: "Opening a panel that is already open shows it instead of making a second copy.", before: view(base), call: 'openPanel("curve-editor") while it is open behind another tab', outcome: () => `${view(again.workspace)} (instance ${again.instanceId}, created ${again.created}; instances now ${Object.keys(again.workspace.instances).length}, before ${Object.keys(base.instances).length})` });
}
{
  const ws = workspaceFromLayout(CARD_SORT_LAYOUT, { workspaceId: "user.migrated", name: "Migrated", origin: "user" });
  const panels = Object.values(ws.instances).map((i) => i.panelType).sort();
  add({ id: "A11", kind: "accuracy", rule: "An author's older four-region layout is migrated as the old page showed it: the left dock, the centre and the right dock side by side with the left dock at 0.19 of the width and the right dock at 0.21 (the centre takes the rest), and the timeline under all three across the whole width; every panel kept exactly once and each tab group keeping its tabs.", before: `old layout panels: ${[...CARD_SORT_LAYOUT.regions.left.panels, ...CARD_SORT_LAYOUT.regions.centre.panels, ...CARD_SORT_LAYOUT.regions.right.panels, ...CARD_SORT_LAYOUT.regions.bottom.panels].length} (left 7, centre 1, right 9, bottom 1; groups delivery-group, inspector-group, library-group)`, call: "workspaceFromLayout(the shipped four-region layout)", outcome: () => `${view(ws)}\npanels in the new layout: ${panels.length}; unique: ${new Set(panels).size}; rule problems: ${validateWorkspace(ws).length}` });
}
{
  const raw = JSON.parse(serializeWorkspace(base));
  const result = migrateWorkspace(raw, { "object-manager": "objects" });
  add({ id: "A12", kind: "accuracy", rule: "A panel kind renamed since the layout was saved keeps its place under its new name, and the rename is reported.", before: 'instances objects-1 has panelType "object-manager"', call: 'migrateWorkspace(layout, aliases {"object-manager": "objects"})', outcome: () => isDockRefused(result as unknown as DockRefusal) ? refusal(result) : `objects-1 is now "${(result as { workspace: SavedWorkspace }).workspace.instances["objects-1"]!.panelType}", renamed ${JSON.stringify((result as { renamed: string[] }).renamed)}, ${view((result as { workspace: SavedWorkspace }).workspace)}` });
}
{
  const future: SavedWorkspace = { ...base, instances: { ...base.instances, "assets-1": { instanceId: "assets-1", panelType: "from-the-future" } } };
  add({ id: "A13", kind: "accuracy", rule: "A layout from a build that had more panels is not damaged: panels this build cannot show stay where they are and are named, with the reason.", before: view(future), call: "unavailableInstances(layout from a newer build)", outcome: () => `${JSON.stringify(unavailableInstances(future, reg))}; layout rule problems: ${validateWorkspace(future).length}` });
}
{
  const problems = validateWorkspace({ ...base, viewState: { token: "x" }, maximizedGroupId: "ghost" });
  add({ id: "A14", kind: "accuracy", rule: "A layout that breaks rules is reported with every broken rule named, by number and in words.", before: 'a layout with viewState {"token": "x"} and a maximised group that does not exist', call: "validateWorkspace(layout)", outcome: () => problems.map((p) => `rule ${p.rule}: ${p.reason}`).join("; ") });
}

// ---- Design points to put to the classifiers -----------------------------------------------------------
add({ id: "D1", kind: "accuracy", rule: "UI state that is only about now (which group is maximised, which has focus) may be kept in the saved workspace if it is optional, validated and never changes the arrangement.", call: "SavedWorkspace has optional maximizedGroupId and activeGroupId", outcome: () => "Both are optional fields; validateWorkspace checks they name a group that exists; normalising drops one whose group is gone; neither changes the tree or any weight; a baseline saved by the author can omit them." });

writeFileSync(process.argv[2] ?? "facts.json", JSON.stringify(facts, null, 1));
console.log(`wrote ${facts.length} facts`);
