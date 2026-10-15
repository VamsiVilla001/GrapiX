// Scene Manager: one saved container, multiple independent graphics (11.64).
// Storage addresses a container as a project and a graphic as a scene;
// stable addresses preserve existing files and Rust command history.
import type { UiAction, UiNode } from "./agent-surface";

export interface ManagedScene {
  readonly sceneId: string;
  readonly name: string;
  readonly unsavedChanges: boolean;
  readonly open?: boolean;
  readonly active?: boolean;
  readonly publishedRevision?: number;
  readonly unavailableReason?: string;
  readonly preview?: { readonly src?: string; readonly note: string };
}

export interface SceneManagerInput {
  readonly project: string;
  readonly scenes: readonly ManagedScene[];
  readonly query?: string;
}

export function graphicStatus(scene: ManagedScene): string {
  if (scene.unavailableReason) return `Unavailable: ${scene.unavailableReason}`;
  const state = scene.unsavedChanges ? "Unsaved changes" : "Saved";
  const open = scene.active ? "Editing · " : scene.open ? "Open · " : "";
  const published = scene.publishedRevision === undefined ? "" : ` · Published r${scene.publishedRevision}`;
  return `${open}${state}${published}`;
}

function sceneActions(scene: ManagedScene): UiAction[] {
  const unsaved = scene.unsavedChanges ? `${scene.name} has unsaved changes` : undefined;
  const unreadable = scene.unavailableReason;
  const publishUnavailable = unreadable ?? unsaved;
  return [
    { name: "open", label: scene.active ? "Editing" : "Open", ...(unreadable === undefined ? {} : { unavailable: unreadable }) },
    { name: "duplicate", label: "Duplicate", ...(unreadable === undefined ? {} : { unavailable: unreadable }) },
    { name: "publish", label: "Publish", ...(publishUnavailable === undefined ? {} : { unavailable: publishUnavailable }) },
    { name: "delete", label: "Delete", ...(unsaved === undefined ? {} : { unavailable: unsaved }) },
  ];
}

export function sceneManagerPanel(input: SceneManagerInput): UiNode {
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const matching = input.scenes.filter((scene) =>
    `${scene.name}\n${scene.sceneId}`.toLocaleLowerCase().includes(query));
  return {
    id: "scene-manager",
    role: "region",
    label: `Scene: ${input.project}`,
    description: `${input.scenes.length} graphic(s) · independent layers and timelines`,
    children: [{
      id: "scene-manager/list", role: "list", label: "Graphics",
      children: matching.map((scene) => ({
        id: `scene/${scene.sceneId}`, role: "listitem", label: scene.name,
        description: graphicStatus(scene), actions: sceneActions(scene),
        children: [
          { id: `scene/${scene.sceneId}/preview`, role: "group", label: `${scene.name} preview`,
            description: scene.preview?.note ?? "Loading authoring preview…",
            ...(scene.preview?.src === undefined ? {} : { image: { src: scene.preview.src, alt: `${scene.name}: ${scene.preview.note}` } }),
            children: [{ id: `scene/${scene.sceneId}/preview-note`, role: "status", label: `${scene.name} preview status`, value: scene.preview?.note ?? "Loading authoring preview…" }],
          },
          { id: `scene/${scene.sceneId}/status`, role: "status", label: `${scene.name} status`, value: graphicStatus(scene) },
        ],
      })),
    }],
  };
}
