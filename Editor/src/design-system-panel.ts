// The design system panel and the import report (build plan 11.14, 11.17).
//
// **11.14's done-when is "palette and type scale are the path of least
// resistance".** That is a statement about ordering, not about locking: the
// tokens come first and are one click, a custom value is further away and
// says what choosing it costs. ADR Part G is explicit that a system which
// blocks legitimate work becomes a system people bypass entirely, so the
// custom path stays open — it is simply never the default.
//
// **11.17's done-when is "nothing substituted without being named".** The
// import report is the whole deliverable: every value the source held that the
// token contract cannot express, with the value itself, so a reviewer can
// judge whether accepting the draft discards a load-bearing brand rule. A
// count would not let them judge anything, which is why nothing here
// summarises.

import type { DesignSystem, DesignSystemDraft } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

/// Which token a field is currently using, if any.
export interface DesignSystemPanelState {
  /// The token name in use, so the panel can mark it selected.
  readonly chosenToken?: string;
}

function colourSwatch(value: { r: number; g: number; b: number }): string {
  const channel = (component: number): string =>
    Math.round(Math.max(0, Math.min(1, component)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`;
}

/// The token palette and scale, offered as editor defaults.
export function designSystemPanel(
  system: DesignSystem,
  state: DesignSystemPanelState = {},
): UiNode {
  const palette: UiNode[] = system.visual.palette.map((token) => ({
    id: `token/color/${token.name}`,
    role: "listitem",
    label: token.name,
    value: colourSwatch(token.value),
    selected: state.chosenToken === token.name,
    actions: [{ name: "choose", label: `Use ${token.name}` }],
  }));

  const spacing: UiNode[] = system.visual.spacing.map((step) => ({
    id: `token/spacing/${step}`,
    role: "listitem",
    label: `${step}`,
    value: `${step}`,
    selected: state.chosenToken === `${step}`,
    actions: [{ name: "choose", label: `Use ${step}` }],
  }));

  return {
    id: "design-system",
    role: "region",
    label: `${system.name} v${system.version}`,
    description: `minimum legible text ${system.visual.minTextSize}`,
    children: [
      // Tokens first, and one action each. The ordering *is* the mechanism:
      // the path of least resistance is whatever is nearest and cheapest.
      { id: "design-system/palette", role: "list", label: "Palette", children: palette },
      { id: "design-system/spacing", role: "list", label: "Spacing scale", children: spacing },
      {
        // Present, last, and honest about what it costs. Refusing outright
        // would make the system something to work around rather than with.
        id: "design-system/custom",
        role: "group",
        label: "Custom value",
        description:
          "leaves the design system; the scene will report a violation at preflight",
        actions: [
          {
            name: "enterCustomValue",
            label: "Enter a custom value",
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The import report (11.17)
// ---------------------------------------------------------------------------

/// Render a retained source value compactly enough to read in a row, without
/// hiding what it was. Objects and arrays keep their JSON shape: a reviewer
/// judging a dropped shadow needs its offsets, not the word "object".
export function describeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/// The draft as a reviewer reads it before confirming.
export function importReportPanel(draft: DesignSystemDraft): UiNode {
  const unexpressible: UiNode[] = draft.unexpressible.map((entry) => ({
    id: `unexpressible/${entry.sourcePath}`,
    role: "listitem",
    label: entry.sourcePath,
    // The reason and the value both travel. A path and a message alone cannot
    // tell a reviewer whether what is being dropped matters.
    description: `${entry.sourceType}: ${entry.reason}`,
    value: describeValue(entry.value),
  }));

  const mapped: UiNode[] = draft.mappings.map((mapping) => ({
    id: `mapped/${mapping.sourcePath}`,
    role: "listitem",
    label: mapping.sourcePath,
    value: mapping.tokenPath,
  }));

  // The store refuses a draft with no legibility floor rather than inventing
  // one. Offering a confirm button the backend will reject would teach the
  // reviewer that refusals are noise.
  const floor = draft.visual.minTextSize;
  const missingFloor =
    floor === null || floor === undefined
      ? "the draft carries no minimum text size, and one is never inferred"
      : undefined;

  return {
    id: "import-report",
    role: "region",
    label: `Import ${draft.name}`,
    description: `${draft.mappings.length} mapped · ${draft.unexpressible.length} not expressible`,
    actions: [
      {
        name: "confirm",
        label: "Confirm as a new version",
        ...(missingFloor === undefined ? {} : { unavailable: missingFloor }),
      },
      { name: "discard", label: "Discard" },
    ],
    children: [
      {
        // An alert, not a status: accepting a draft is irreversible — a
        // version is immutable once confirmed — so what it drops must
        // interrupt rather than wait to be noticed.
        id: "import-report/unexpressible",
        role: unexpressible.length > 0 ? "alert" : "status",
        label: "Not expressible as tokens",
        value:
          unexpressible.length > 0
            ? `${unexpressible.length} value(s) the token contract cannot hold`
            : "everything in the source mapped",
        children: unexpressible,
      },
      {
        id: "import-report/mapped",
        role: "list",
        label: "Mapped",
        children: mapped,
      },
    ],
  };
}
