// The dockable workspace layout (build plan 11.5).
//
// **Source of the arrangement.** The product owner selected the broadcast-CG
// card-sort grouping on 2026-09-14: scene and object navigation at left,
// authoring inspectors at right, the scene viewport central, and the timeline
// across the bottom. This is a recorded product decision, not a claim that the
// participant study in 9.4 ran.
//
// The model owns the ordinary engineering around that arrangement: regions,
// panel moves, collapse, resize, persistence, reconciliation and reset.
// Authors may customise it without changing scene state.
//
// **A layout is a workspace preference, not scene state.** It persists per
// user and is untouched by opening, switching or closing a scene. Putting it
// on the document would make two authors' files differ over where somebody
// parked a panel, which is the same argument that keeps selection and collapse
// state off the scene in 11.29.

/// Where a panel can be docked. `centre` holds the viewport and is not a
/// general destination — see `REQUIRED_PANELS`.
export type RegionId = "left" | "centre" | "right" | "bottom";

export const REGIONS: readonly RegionId[] = ["left", "centre", "right", "bottom"];

/// Panels that may not be moved or hidden, with the reason.
///
/// The viewport is the one surface the Editor cannot be operated without, and
/// a workspace that can hide it is a workspace that can be broken into a state
/// with no way back except clearing storage.
export const PINNED: Readonly<Record<string, string>> = {
  viewport: "the viewport is the Editor's primary surface and cannot be docked away",
};

/// Regions that must never end up empty, and why.
export const REQUIRED_REGIONS: readonly RegionId[] = ["centre"];

export interface RegionState {
  readonly panels: readonly string[];
  /// Fraction of the workspace this region takes, 0–1. Interpreted by the
  /// shell against its own axis; the model only keeps it in range.
  readonly size: number;
  readonly collapsed: boolean;
}

export interface Layout {
  /// Bumped when the shape of this type changes. A stored layout from a newer
  /// schema is refused rather than partially applied.
  readonly version: number;
  readonly regions: Readonly<Record<RegionId, RegionState>>;
}

export const LAYOUT_VERSION = 1;

/// Why a layout operation could not run. Free text, shown to the author and
/// returned to an agent verbatim — the same shape `Editor/src/workspace.ts`
/// uses for open scenes.
export type LayoutRefusal = { readonly refused: string };

export function isRefused<T>(result: T | LayoutRefusal): result is LayoutRefusal {
  return typeof result === "object" && result !== null && "refused" in result;
}

// ---------------------------------------------------------------------------
// Product-owner-selected card-sort layout.
// ---------------------------------------------------------------------------

export const CARD_SORT_LAYOUT: Layout = {
  version: LAYOUT_VERSION,
  regions: {
    left: { panels: ["scene-manager", "object-manager"], size: 0.2, collapsed: false },
    centre: { panels: ["viewport"], size: 0.55, collapsed: false },
    right: {
      panels: [
        "inspector",
        "control-contract",
        "take-page",
        "bindings",
        "fonts",
        "text-styles",
        "materials",
        "assets",
        "animation",
        "publish",
      ],
      size: 0.25,
      collapsed: false,
    },
    bottom: { panels: ["timeline"], size: 0.3, collapsed: false },
  },
};

export function defaultLayout(): Layout {
  return cloneLayout(CARD_SORT_LAYOUT);
}
/// The mutable shape operations build before handing back a `Layout`.
///
/// Declared rather than cast through `readonly` at each mutation: a cast per
/// write is four places to get wrong, and TypeScript is right to refuse them.
interface MutableRegion {
  panels: string[];
  size: number;
  collapsed: boolean;
}
interface MutableLayout {
  version: number;
  regions: Record<RegionId, MutableRegion>;
}

function cloneLayout(layout: Layout): MutableLayout {
  const regions = {} as Record<RegionId, MutableRegion>;
  for (const id of REGIONS) {
    regions[id] = {
      panels: [...layout.regions[id].panels],
      size: layout.regions[id].size,
      collapsed: layout.regions[id].collapsed,
    };
  }
  return { version: layout.version, regions };
}
export function regionOf(layout: Layout, panel: string): RegionId | undefined {
  return REGIONS.find((id) => layout.regions[id].panels.includes(panel));
}

export function allPanels(layout: Layout): string[] {
  return REGIONS.flatMap((id) => layout.regions[id].panels);
}

/// Move a panel to a region, optionally at an index.
///
/// Every failure is named: an unknown panel, an unknown region, a pinned
/// panel, or a move that would empty a required region. A move that silently
/// did nothing would leave the author dragging a panel that never lands and
/// no explanation for it.
export function movePanel(
  layout: Layout,
  panel: string,
  target: RegionId,
  index?: number,
): Layout | LayoutRefusal {
  const from = regionOf(layout, panel);
  if (!from) return { refused: `no panel ${panel} in this workspace` };
  if (!REGIONS.includes(target)) return { refused: `no region ${target} in this workspace` };
  if (PINNED[panel] && from !== target) return { refused: PINNED[panel]! };
  if (
    from !== target &&
    REQUIRED_REGIONS.includes(from) &&
    layout.regions[from].panels.length === 1
  ) {
    return { refused: `the ${from} region cannot be left empty` };
  }

  const next = cloneLayout(layout);
  const source = next.regions[from].panels;
  source.splice(source.indexOf(panel), 1);
  const destination = next.regions[target].panels;
  const at = index === undefined ? destination.length : clampIndex(index, destination.length);
  destination.splice(at, 0, panel);
  return next;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return length;
  return Math.min(length, Math.max(0, Math.floor(index)));
}

/// Resize a region. The fraction is clamped rather than refused: a drag past
/// the edge is a gesture that ran out of room, not an error worth a message.
export function resizeRegion(
  layout: Layout,
  region: RegionId,
  size: number,
): Layout | LayoutRefusal {
  if (!REGIONS.includes(region)) return { refused: `no region ${region} in this workspace` };
  const next = cloneLayout(layout);
  const clamped = Number.isFinite(size) ? Math.min(0.9, Math.max(0.05, size)) : 0.2;
  next.regions[region].size = clamped;
  return next;
}

export function setCollapsed(
  layout: Layout,
  region: RegionId,
  collapsed: boolean,
): Layout | LayoutRefusal {
  if (!REGIONS.includes(region)) return { refused: `no region ${region} in this workspace` };
  if (collapsed && REQUIRED_REGIONS.includes(region)) {
    return { refused: `the ${region} region cannot be collapsed` };
  }
  const next = cloneLayout(layout);
  next.regions[region].collapsed = collapsed;
  return next;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// The storage this needs. Injected so the restore rules — the part with the
/// interesting failure modes — are testable without a browser.
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAYOUT_STORAGE_KEY = "grapix.editor.layout";

export interface RestoreResult {
  readonly layout: Layout;
  /// What was wrong with the stored layout, in words. Empty when it restored
  /// cleanly. Reported rather than swallowed: a panel silently vanishing
  /// because a stored layout named it is the failure invariant 18 forbids.
  readonly notes: readonly string[];
}

/// Restore a layout, reconciling it against the panels that exist now.
///
/// The reconciliation is the point. Panels are added and removed between
/// builds, so a stored layout is always slightly wrong; the choice is between
/// reporting that and crashing on it.
export function restoreLayout(
  storage: LayoutStorage,
  knownPanels: readonly string[],
): RestoreResult {
  const raw = storage.getItem(LAYOUT_STORAGE_KEY);
  if (!raw) return { layout: defaultLayout(), notes: [] };

  let parsed: Layout;
  try {
    parsed = JSON.parse(raw) as Layout;
  } catch (error) {
    return {
      layout: defaultLayout(),
      notes: [`the stored layout was unreadable and has been reset: ${String(error)}`],
    };
  }

  if (typeof parsed?.version !== "number" || !parsed.regions) {
    return { layout: defaultLayout(), notes: ["the stored layout had no recognisable shape"] };
  }
  if (parsed.version > LAYOUT_VERSION) {
    // Refused, not partially applied: a newer schema may mean something
    // different by the same field, and guessing produces a layout nobody
    // authored.
    return {
      layout: defaultLayout(),
      notes: [
        `the stored layout is version ${parsed.version}, newer than this build understands (${LAYOUT_VERSION}); the default has been used`,
      ],
    };
  }

  const notes: string[] = [];
  const known = new Set(knownPanels);
  const seen = new Set<string>();
  const next = cloneLayout(CARD_SORT_LAYOUT);

  for (const id of REGIONS) {
    const stored = parsed.regions[id];
    if (!stored) {
      notes.push(`the stored layout had no ${id} region; the default was used for it`);
      continue;
    }
    const panels: string[] = [];
    for (const panel of stored.panels ?? []) {
      if (!known.has(panel)) {
        notes.push(`dropped ${panel} from the stored layout: this build has no such panel`);
        continue;
      }
      if (seen.has(panel)) {
        notes.push(`dropped a duplicate ${panel} from the stored layout`);
        continue;
      }
      seen.add(panel);
      panels.push(panel);
    }
    next.regions[id].panels = panels;
    if (typeof stored.size === "number" && Number.isFinite(stored.size)) {
      next.regions[id].size = Math.min(0.9, Math.max(0.05, stored.size));
    }
    next.regions[id].collapsed = stored.collapsed === true;
  }

  // A panel this build has that the stored layout never mentioned is new since
  // the layout was saved. It goes back to wherever the default puts it, rather
  // than being lost.
  for (const panel of knownPanels) {
    if (seen.has(panel)) continue;
    const home = regionOf(CARD_SORT_LAYOUT, panel) ?? "right";
    next.regions[home].panels.push(panel);
    notes.push(`added ${panel} to ${home}: it is new since the layout was saved`);
  }

  for (const id of REQUIRED_REGIONS) {
    if (next.regions[id].panels.length === 0) {
      const restored = CARD_SORT_LAYOUT.regions[id].panels.filter((p) => known.has(p));
      next.regions[id].panels = [...restored];
      next.regions[id].collapsed = false;
      notes.push(`the ${id} region was empty in the stored layout and has been restored`);
    }
  }

  return { layout: next, notes };
}

export function persistLayout(storage: LayoutStorage, layout: Layout): void {
  storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}
