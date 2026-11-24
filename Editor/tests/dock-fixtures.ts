// Shared fixtures for the dock model tests: the hand-off's compact Design workspace, a registry for it, and a
// deep freeze so a test can prove an operation changed nothing it was given.
import type { SavedWorkspace } from "../src/dock-model";
import { createPanelRegistry, isRegistryRefused, type PanelDefinition, type PanelRegistry } from "../src/panel-registry";

/** left | (viewport over timeline+curves) | right, as in the hand-off's example. */
export function design(): SavedWorkspace {
  return {
    schemaVersion: 1,
    workspaceId: "factory.editor.design",
    app: "editor",
    name: "Design",
    origin: "factory",
    root: {
      kind: "split",
      id: "root",
      direction: "horizontal",
      weights: [0.2, 0.6, 0.2],
      children: [
        { kind: "tabs", id: "left", panelInstanceIds: ["objects-1", "assets-1"], activePanelInstanceId: "objects-1" },
        {
          kind: "split",
          id: "center",
          direction: "vertical",
          weights: [0.68, 0.32],
          children: [
            { kind: "tabs", id: "viewport-group", panelInstanceIds: ["viewport-1"], activePanelInstanceId: "viewport-1" },
            { kind: "tabs", id: "timeline-group", panelInstanceIds: ["timeline-1", "curves-1"], activePanelInstanceId: "timeline-1" },
          ],
        },
        { kind: "tabs", id: "right", panelInstanceIds: ["inspector-1", "bindings-1"], activePanelInstanceId: "inspector-1" },
      ],
    },
    floats: [],
    instances: {
      "objects-1": { instanceId: "objects-1", panelType: "object-manager" },
      "assets-1": { instanceId: "assets-1", panelType: "asset-browser" },
      "viewport-1": { instanceId: "viewport-1", panelType: "scene-viewport" },
      "timeline-1": { instanceId: "timeline-1", panelType: "timeline" },
      "curves-1": { instanceId: "curves-1", panelType: "curve-editor" },
      "inspector-1": { instanceId: "inspector-1", panelType: "inspector" },
      "bindings-1": { instanceId: "bindings-1", panelType: "data-bindings" },
    },
    viewState: {},
  };
}

const base = { app: "editor", allowClose: true, allowFloat: true, allowMultiple: false, singleton: true } as const;

export const DEFINITIONS: readonly PanelDefinition[] = [
  { ...base, type: "object-manager", title: "Objects", defaultPlacement: { groupHint: "left", tabIndex: 0 } },
  { ...base, type: "asset-browser", title: "Assets", defaultPlacement: { groupHint: "left" } },
  { ...base, type: "scene-viewport", title: "Composition", singleton: false, allowMultiple: true, allowClose: false, minSize: { width: 320, height: 220 }, defaultPlacement: { groupHint: "viewport-group" } },
  { ...base, type: "timeline", title: "Timeline", minSize: { width: 300, height: 220 }, defaultPlacement: { groupHint: "timeline-group" } },
  { ...base, type: "curve-editor", title: "Curves", defaultPlacement: { groupHint: "timeline-group" } },
  { ...base, type: "inspector", title: "Properties", singleton: false, allowMultiple: true, supportsContextPin: true, minSize: { width: 240, height: 200 }, defaultPlacement: { groupHint: "right" } },
  { ...base, type: "data-bindings", title: "Data bindings", defaultPlacement: { groupHint: "right" } },
  { ...base, type: "import-report", title: "Import report" },
  { ...base, type: "rundown", title: "Rundown", app: "playout" },
  { ...base, type: "conformance", title: "Conformance", capability: "conformance" },
  { ...base, type: "anywhere", title: "Anywhere", app: "both" },
];

export function registry(definitions: readonly PanelDefinition[] = DEFINITIONS): PanelRegistry {
  const made = createPanelRegistry(definitions);
  if (isRegistryRefused(made)) throw new Error(made.refused);
  return made;
}

/** Freeze a value all the way down, so a function that writes to it throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** The result of an operation that must have worked, or a thrown error naming the refusal. */
export function ok<T>(result: T): Exclude<T, { refused: string }> {
  if (typeof result === "object" && result !== null && "refused" in result) throw new Error(`refused: ${(result as { refused: string }).refused}`);
  return result as Exclude<T, { refused: string }>;
}
