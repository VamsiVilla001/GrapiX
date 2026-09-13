// The scene and template manager, and the live conformance indicator
// (build plan 11.16 — drift visible as it happens, not at publish).
//
// **Drift is shown continuously, because finding out at publish is too late.**
// By then the author has finished, and the choice is between shipping
// something off-brand and redoing work. The version each published template
// was built against is already recorded on its package manifest (7.6), so the
// comparison costs nothing and can simply always be on screen.
//
// **Unstamped is not "behind".** A package that predates design-system
// stamping has *unknown* conformance. Reporting it as behind would assert a
// fact nobody can verify, and it is a different job to do: one template needs
// re-publishing, the other needs someone to look at it. Rust's `drift_report`
// makes the same distinction and owns the canonical answer; this mirrors it
// for display, because a panel cannot wait for a round trip to colour a row.

import type { UiAction, UiNode } from "./agent-surface";

/// One scene in the project, as the manager needs it.
export interface ManagedScene {
  readonly sceneId: string;
  readonly name: string;
  /// Edited since the last save. Blocks anything that would publish or
  /// discard work.
  readonly unsavedChanges: boolean;
  /// The design-system version the published take was built against, or
  /// `undefined` when it has never been published.
  readonly publishedVersion?: number;
  /// Present and null-ish means published before stamping existed. Kept
  /// separate from "never published", which is not drift at all.
  readonly publishedUnstamped?: boolean;
  /// Present when the file exists but cannot be read as a scene. The row stays
  /// visible so the author can delete it, while actions that need content name
  /// the reason they cannot run.
  readonly unavailableReason?: string;
}

export interface SceneManagerInput {
  readonly project: string;
  readonly scenes: readonly ManagedScene[];
  /// The project's current design-system version, or `undefined` when no
  /// system has been confirmed yet.
  readonly currentDesignSystemVersion?: number;
}

/// How one scene stands against the current design system.
export type Conformance =
  | { readonly kind: "no-system" }
  | { readonly kind: "unpublished" }
  | { readonly kind: "unstamped" }
  | { readonly kind: "current"; readonly version: number }
  | { readonly kind: "behind"; readonly version: number; readonly versionsBehind: number };

/// Classify one scene. Pure, and the single place the distinction is made.
export function conformanceOf(
  scene: ManagedScene,
  currentVersion: number | undefined,
): Conformance {
  if (currentVersion === undefined) return { kind: "no-system" };
  if (scene.publishedUnstamped === true) return { kind: "unstamped" };
  if (scene.publishedVersion === undefined) return { kind: "unpublished" };
  return scene.publishedVersion >= currentVersion
    ? { kind: "current", version: scene.publishedVersion }
    : {
        kind: "behind",
        version: scene.publishedVersion,
        versionsBehind: currentVersion - scene.publishedVersion,
      };
}

/// The sentence an operator reads.
export function conformanceLabel(conformance: Conformance): string {
  switch (conformance.kind) {
    case "no-system":
      return "no design system confirmed";
    case "unpublished":
      return "not published";
    case "unstamped":
      // Deliberately not a number. Claiming a distance here would be inventing
      // one, and the honest answer is that nobody knows.
      return "predates design-system stamping — conformance unknown";
    case "current":
      return `on the current version (v${conformance.version})`;
    case "behind":
      return `v${conformance.version}, ${conformance.versionsBehind} version(s) behind`;
  }
}

function sceneActions(scene: ManagedScene): UiAction[] {
  // Unsaved work blocks anything that would publish it or throw it away.
  // Publishing what is on disk while the author looks at something newer is
  // the kind of near-miss that is only noticed on air.
  const unsaved = scene.unsavedChanges
    ? `${scene.name} has unsaved changes`
    : undefined;
  const unreadable = scene.unavailableReason;
  const publishUnavailable = unreadable ?? unsaved;

  return [
    {
      name: "open",
      label: "Open",
      ...(unreadable === undefined ? {} : { unavailable: unreadable }),
    },
    {
      name: "duplicate",
      label: "Duplicate",
      ...(unreadable === undefined ? {} : { unavailable: unreadable }),
    },
    {
      name: "publish",
      label: "Publish",
      ...(publishUnavailable === undefined ? {} : { unavailable: publishUnavailable }),
    },
    {
      name: "delete",
      label: "Delete",
      ...(unsaved === undefined ? {} : { unavailable: unsaved }),
    },
  ];
}

/// Build the scene / template manager panel.
export function sceneManagerPanel(input: SceneManagerInput): UiNode {
  const items: UiNode[] = input.scenes.map((scene) => {
    const conformance = conformanceOf(scene, input.currentDesignSystemVersion);
    return {
      id: `scene/${scene.sceneId}`,
      role: "listitem",
      label: scene.name,
      description: scene.unavailableReason
        ? `unavailable: ${scene.unavailableReason}`
        : scene.unsavedChanges
          ? "unsaved changes"
          : "saved",
      actions: sceneActions(scene),
      children: [
        {
          // A status rather than a plain cell: drift changes while the author
          // works — someone confirms a new brand pack — and the row must be
          // able to announce that without the author going looking.
          id: `scene/${scene.sceneId}/conformance`,
          role: "status",
          label: `${scene.name} design-system conformance`,
          value: conformanceLabel(conformance),
        },
      ],
    };
  });

  const behind = input.scenes.filter(
    (scene) => conformanceOf(scene, input.currentDesignSystemVersion).kind === "behind",
  ).length;
  const unstamped = input.scenes.filter(
    (scene) => conformanceOf(scene, input.currentDesignSystemVersion).kind === "unstamped",
  ).length;

  return {
    id: "scene-manager",
    role: "region",
    label: `Scenes in ${input.project}`,
    description:
      input.currentDesignSystemVersion === undefined
        ? "no design system confirmed for this project"
        : `design system v${input.currentDesignSystemVersion} · ${behind} behind · ${unstamped} unstamped`,
    children: [
      {
        id: "scene-manager/list",
        role: "list",
        label: "Scenes",
        children: items,
      },
    ],
  };
}
