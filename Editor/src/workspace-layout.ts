// The dockable workspace layout (build plan 11.5).
//
// **Source of the arrangement.** The product owner selected the broadcast-CG
// card-sort grouping on 2026-09-14: scene and object navigation at left,
// authoring inspectors at right, the scene viewport central, and the timeline
// across the bottom. This is a recorded product decision, not a claim that the
// participant study in 9.4 ran.
//
// **Revised for 11.63 (13 October 2026, at the user's request):** the same
// grouping arranged the way EffectCraft's After Effects-style workspace is —
// project scenes, objects and assets at left; Preview transport, then
// Properties (the inspector), then the remaining authoring panels at right.
// Layout version 2; a layout stored against version 1 is replaced by this
// default, and the replacement is reported.
//
// **Revised for 11.73 (18 November 2026):** a region can hold tab groups, a row
// of tabs with one panel showing, so the right column's thirteen stacked panels
// (twice the height of the screen) become a few groups and every panel is
// reachable without scrolling the column. Layout version 3; the arrangement is
// borrowed from After Effects' tabbed panel groups and XPression's habit of
// keeping each tool one click away. A group is a run of two or more adjacent
// panels of one region; a panel in a group is still in its region's `panels`.
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

/// A run of two or more panels of one region shown as tabs, one at a time.
export interface TabGroup {
  /// Stable name of the group, a lower-case word with hyphens.
  readonly id: string;
  /// The members, in tab order. They are adjacent in the region's `panels`.
  readonly panels: readonly string[];
  /// The panel showing. Always one of `panels`.
  readonly active: string;
}

/// The heights of the entries stacked in a dock (each ungrouped panel and each tab
/// group), as fractions of the dock that add up to one. It is stored with the
/// entries it was measured for, so it can never be applied to different ones.
export interface RegionSplit {
  readonly entries: readonly string[];
  readonly fractions: readonly number[];
}

/// The smallest share of a dock one entry may have: enough for its tab strip or heading.
export const MIN_SPLIT = 0.06;

export interface RegionState {
  /// Absent until the author drags a splitter: the dock then lays its entries out by content.
  readonly split?: RegionSplit;
  readonly panels: readonly string[];
  /// Tab groups over some of `panels`; the rest are shown stacked, as before.
  readonly groups: readonly TabGroup[];
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

export const LAYOUT_VERSION = 3;

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
    left: {
      panels: [
        "scene-manager",
        "object-manager",
        "assets",
        "take-page",
        "control-contract",
        "bindings",
        "publish",
      ],
      // What leaves the Editor for Playout goes with the project, at the left,
      // where the Scene Manager as a list leaves room (11.73; Jev 0.51 for this
      // against 0.31 and 0.18 for the right dock, Laya preferred folding Preview).
      groups: [
        {
          id: "delivery-group",
          panels: ["take-page", "control-contract", "bindings", "publish"],
          active: "take-page",
        },
      ],
      size: 0.19,
      collapsed: false,
    },
    centre: { panels: ["viewport"], groups: [], size: 0.55, collapsed: false },
    right: {
      panels: [
        "preview",
        "unsupported",
        "inspector",
        "animation",
        "effect-controls",
        "text-styles",
        "fonts",
        "effects",
        "materials",
      ],
      // What the author edits and what the author reaches for: one group each,
      // under the Preview, rather than thirteen headers.
      groups: [
        {
          id: "inspector-group",
          panels: ["inspector", "animation", "effect-controls", "text-styles", "fonts"],
          active: "inspector",
        },
        { id: "library-group", panels: ["effects", "materials"], active: "effects" },
      ],
      size: 0.21,
      collapsed: false,
    },
    bottom: { panels: ["timeline"], groups: [], size: 0.34, collapsed: false },
  },
};

export function defaultLayout(): Layout {
  return cloneLayout(CARD_SORT_LAYOUT);
}
/// The mutable shape operations build before handing back a `Layout`.
///
/// Declared rather than cast through `readonly` at each mutation: a cast per
/// write is four places to get wrong, and TypeScript is right to refuse them.
interface MutableGroup {
  id: string;
  panels: string[];
  active: string;
}
interface MutableRegion {
  split?: { entries: string[]; fractions: number[] };
  panels: string[];
  groups: MutableGroup[];
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
    const split = layout.regions[id].split;
    regions[id] = {
      ...(split === undefined ? {} : { split: { entries: [...split.entries], fractions: [...split.fractions] } }),
      panels: [...layout.regions[id].panels],
      groups: layout.regions[id].groups.map((g) => ({ id: g.id, panels: [...g.panels], active: g.active })),
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
  // Moving a panel by itself takes it out of its tab group: that is the
  // gesture for tearing a tab off. Joining a group is `moveToGroup`.
  leaveGroup(next.regions[from], panel);
  const source = next.regions[from].panels;
  source.splice(source.indexOf(panel), 1);
  const destination = next.regions[target].panels;
  const at = index === undefined ? destination.length : clampIndex(index, destination.length);
  destination.splice(at, 0, panel);
  // A panel dropped between a group's members must not split the group.
  for (const group of next.regions[target].groups) arrangeGroup(next.regions[target], group);
  return settle(next);
}

// ---------------------------------------------------------------------------
// Tab groups
// ---------------------------------------------------------------------------

/// The group a panel is in, and the region that holds it.
export function groupOf(
  layout: Layout,
  panel: string,
): { readonly region: RegionId; readonly group: TabGroup } | undefined {
  for (const region of REGIONS) {
    const group = layout.regions[region].groups.find((g) => g.panels.includes(panel));
    if (group) return { region, group };
  }
  return undefined;
}

/// What a region shows, top to bottom: each ungrouped panel, and each group at
/// the place of its first member. `index` is that entry's place in `panels`, so
/// a drop position can be turned back into one.
export type RegionEntry =
  | { readonly kind: "panel"; readonly panel: string; readonly index: number }
  | { readonly kind: "group"; readonly group: TabGroup; readonly index: number };

export function regionEntries(state: RegionState): RegionEntry[] {
  const entries: RegionEntry[] = [];
  const shown = new Set<string>();
  state.panels.forEach((panel, index) => {
    if (shown.has(panel)) return;
    const group = state.groups.find((g) => g.panels.includes(panel));
    if (group) {
      for (const member of group.panels) shown.add(member);
      entries.push({ kind: "group", group, index });
    } else {
      shown.add(panel);
      entries.push({ kind: "panel", panel, index });
    }
  });
  return entries;
}

/// Take a panel out of its group in a region, dissolving a group left with one.
function leaveGroup(region: MutableRegion, panel: string): void {
  const group = region.groups.find((g) => g.panels.includes(panel));
  if (!group) return;
  group.panels.splice(group.panels.indexOf(panel), 1);
  if (group.panels.length < 2) {
    region.groups.splice(region.groups.indexOf(group), 1);
  } else if (group.active === panel) {
    group.active = group.panels[0]!;
  }
}

/// Make a group's members adjacent in the region, in tab order, at the place of
/// whichever member comes first.
function arrangeGroup(region: MutableRegion, group: MutableGroup): void {
  const places = group.panels.map((p) => region.panels.indexOf(p)).filter((i) => i >= 0);
  if (places.length === 0) return;
  const at = Math.min(...places);
  region.panels = region.panels.filter((p) => !group.panels.includes(p));
  region.panels.splice(at, 0, ...group.panels);
}

const GROUP_ID = /^[a-z][a-z0-9-]*$/;

/// Show the tab of a panel that is in a group.
export function activateTab(layout: Layout, panel: string): Layout | LayoutRefusal {
  const found = groupOf(layout, panel);
  if (!found) return { refused: `${panel} is not in a tab group` };
  const next = cloneLayout(layout);
  const group = next.regions[found.region].groups.find((g) => g.id === found.group.id)!;
  group.active = panel;
  return next;
}

/// Make a tab group of two or more ungrouped panels of one region.
export function groupPanels(
  layout: Layout,
  region: RegionId,
  panels: readonly string[],
  id: string,
): Layout | LayoutRefusal {
  if (!REGIONS.includes(region)) return { refused: `no region ${region} in this workspace` };
  if (!GROUP_ID.test(id)) return { refused: `${id} is not a group name (lower-case words with hyphens)` };
  if (REGIONS.some((r) => layout.regions[r].groups.some((g) => g.id === id))) {
    return { refused: `there is already a tab group named ${id}` };
  }
  const members = [...new Set(panels)];
  if (members.length < 2) return { refused: "a tab group needs at least two panels" };
  for (const panel of members) {
    if (PINNED[panel]) return { refused: PINNED[panel]! };
    if (!layout.regions[region].panels.includes(panel)) {
      return { refused: `${panel} is not in the ${region} region` };
    }
    if (groupOf(layout, panel)) return { refused: `${panel} is already in a tab group` };
  }
  const next = cloneLayout(layout);
  const group: MutableGroup = { id, panels: members, active: members[0]! };
  next.regions[region].groups.push(group);
  arrangeGroup(next.regions[region], group);
  return settle(next);
}

/// Put a panel into an existing group, at a tab position, from wherever it is.
/// The dropped tab becomes the one showing.
export function moveToGroup(
  layout: Layout,
  panel: string,
  groupId: string,
  index?: number,
): Layout | LayoutRefusal {
  const from = regionOf(layout, panel);
  if (!from) return { refused: `no panel ${panel} in this workspace` };
  const home = REGIONS.find((r) => layout.regions[r].groups.some((g) => g.id === groupId));
  if (!home) return { refused: `no tab group ${groupId} in this workspace` };
  if (PINNED[panel]) return { refused: PINNED[panel]! };
  const next = cloneLayout(layout);
  const region = next.regions[home];
  const group = region.groups.find((g) => g.id === groupId)!;
  if (group.panels.includes(panel)) {
    // A reorder of the group's own tabs: it never leaves the group.
    group.panels.splice(group.panels.indexOf(panel), 1);
  } else {
    leaveGroup(next.regions[from], panel);
    const source = next.regions[from].panels;
    source.splice(source.indexOf(panel), 1);
    region.panels.push(panel);
  }
  const at = index === undefined ? group.panels.length : clampIndex(index, group.panels.length);
  group.panels.splice(at, 0, panel);
  group.active = panel;
  arrangeGroup(region, group);
  return settle(next);
}

/// Dissolve a group; its panels stay where they are, stacked.
export function ungroup(layout: Layout, groupId: string): Layout | LayoutRefusal {
  const home = REGIONS.find((r) => layout.regions[r].groups.some((g) => g.id === groupId));
  if (!home) return { refused: `no tab group ${groupId} in this workspace` };
  const next = cloneLayout(layout);
  next.regions[home].groups = next.regions[home].groups.filter((g) => g.id !== groupId);
  return settle(next);
}

// ---------------------------------------------------------------------------
// Panel sizes: the splitters between a dock's stacked entries
// ---------------------------------------------------------------------------

/// The name an entry goes by in a split: a group's id, or a panel's.
export function entryId(entry: RegionEntry): string {
  return entry.kind === "group" ? entry.group.id : entry.panel;
}

/// The stacked entries of a dock, in order.
export function entryIds(state: RegionState): string[] {
  return regionEntries(state).map(entryId);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/// Forget a dock's stored sizes when its entries are no longer the ones they were
/// measured for: a size for an arrangement that is gone would be a guess.
function settle(layout: MutableLayout): MutableLayout {
  for (const id of REGIONS) {
    const region = layout.regions[id];
    if (region.split && !sameIds(region.split.entries, entryIds(region))) delete region.split;
  }
  return layout;
}

/// Store the heights of a dock's entries, as the fractions measured while a splitter was dragged.
export function splitRegion(
  layout: Layout,
  region: RegionId,
  entries: readonly string[],
  fractions: readonly number[],
): Layout | LayoutRefusal {
  if (!REGIONS.includes(region)) return { refused: `no region ${region} in this workspace` };
  if (!sameIds(entries, entryIds(layout.regions[region]))) {
    return { refused: `the ${region} dock's panels are not the ones these sizes were measured for` };
  }
  if (entries.length < 2) return { refused: `the ${region} dock has one panel, so there is nothing to divide` };
  if (fractions.length !== entries.length) return { refused: "there must be one size for each panel" };
  if (fractions.some((f) => !Number.isFinite(f) || f < MIN_SPLIT - 1e-9)) {
    return { refused: `a panel cannot take less than ${Math.round(MIN_SPLIT * 100)} % of its dock` };
  }
  const total = fractions.reduce((sum, f) => sum + f, 0);
  const next = cloneLayout(layout);
  next.regions[region].split = { entries: [...entries], fractions: fractions.map((f) => f / total) };
  return next;
}

/// Go back to laying a dock's entries out by content.
export function clearSplit(layout: Layout, region: RegionId): Layout | LayoutRefusal {
  if (!REGIONS.includes(region)) return { refused: `no region ${region} in this workspace` };
  const next = cloneLayout(layout);
  delete next.regions[region].split;
  return next;
}

/// Heights measured on screen, as fractions that add up to one and none below `min`.
/// A panel that is hidden measures nothing and a tiny one measures almost nothing; both
/// are lifted to the smallest share, and the others give up the difference in proportion
/// to what they have above it, so the total stays one. When the dock cannot give every
/// entry the smallest share, they are all equal.
export function floorFractions(heights: readonly number[], min: number = MIN_SPLIT): number[] {
  const n = heights.length;
  if (n === 0) return [];
  const sum = heights.reduce((total, h) => total + (Number.isFinite(h) && h > 0 ? h : 0), 0);
  if (n * min >= 1 || sum <= 0) return heights.map(() => 1 / n);
  let out = heights.map((h) => (Number.isFinite(h) && h > 0 ? h : 0) / sum);
  for (let pass = 0; pass < n; pass += 1) {
    const low = out.map((f) => f < min);
    if (!low.some(Boolean)) break;
    const deficit = out.reduce((total, f, i) => total + (low[i] ? min - f : 0), 0);
    // Positive whenever `n * min < 1`: what the others hold above the smallest share is
    // `1 - n * min` plus what the small ones are short by.
    const room = out.reduce((total, f, i) => total + (low[i] ? 0 : f - min), 0);
    out = out.map((f, i) => (low[i] ? min : f - (deficit * (f - min)) / room));
  }
  return out;
}

/// Move the boundary after entry `index` by `delta` (a fraction of the dock), the way
/// a splitter does in After Effects: the two entries beside it trade height, every
/// other entry keeps its own, and neither goes below `min`.
export function dragSplitter(
  fractions: readonly number[],
  index: number,
  delta: number,
  min: number = MIN_SPLIT,
): number[] {
  const out = [...fractions];
  if (!Number.isInteger(index) || index < 0 || index + 1 >= out.length || !Number.isFinite(delta)) return out;
  const pair = out[index]! + out[index + 1]!;
  if (pair < 2 * min) return out;
  const first = Math.min(pair - min, Math.max(min, out[index]! + delta));
  out[index] = first;
  out[index + 1] = pair - first;
  return out;
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

  if (parsed.version < LAYOUT_VERSION) {
    // Arranged against an earlier default. Reconciling it would keep the old
    // arrangement and bolt the new panels on at the end, which is neither
    // what the author built nor the new default; the default is used and the
    // replacement is said out loud.
    return {
      layout: defaultLayout(),
      notes: [
        `the stored layout is version ${parsed.version}, arranged for an earlier default; the version ${LAYOUT_VERSION} default has been used`,
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
    next.regions[id].groups = restoreGroups(id, stored, panels, notes);
    for (const group of next.regions[id].groups) arrangeGroup(next.regions[id], group);
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

  // Sizes last, once every panel has its place: they are kept only for the very
  // entries they were measured for.
  for (const id of REGIONS) {
    const stored = parsed.regions[id]?.split;
    if (stored === undefined) continue;
    const entries = entryIds(next.regions[id]);
    const fractions: unknown = stored?.fractions;
    const valid =
      Array.isArray(stored?.entries) &&
      sameIds(stored.entries as string[], entries) &&
      Array.isArray(fractions) &&
      fractions.length === entries.length &&
      entries.length >= 2 &&
      fractions.every((f) => typeof f === "number" && Number.isFinite(f) && f >= MIN_SPLIT - 1e-9);
    if (!valid) {
      notes.push(`dropped the stored panel sizes of the ${id} dock: its panels are not the ones they were measured for`);
      continue;
    }
    const list = fractions as number[];
    const total = list.reduce((sum, f) => sum + f, 0);
    next.regions[id].split = { entries, fractions: list.map((f) => f / total) };
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

/// A stored region's tab groups, reconciled against the panels it really holds:
/// members this build no longer has or that sit in another group are dropped, a
/// group left with fewer than two panels dissolves, and each loss is said.
function restoreGroups(
  region: RegionId,
  stored: Partial<RegionState>,
  panels: readonly string[],
  notes: string[],
): MutableGroup[] {
  const groups: MutableGroup[] = [];
  const claimed = new Set<string>();
  const names = new Set<string>();
  for (const raw of Array.isArray(stored.groups) ? stored.groups : []) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    const members: string[] = [];
    for (const panel of Array.isArray(raw?.panels) ? raw.panels : []) {
      if (typeof panel !== "string" || claimed.has(panel) || !panels.includes(panel)) {
        notes.push(`dropped ${String(panel)} from tab group ${id || "?"}: it is not a panel of the ${region} region`);
        continue;
      }
      claimed.add(panel);
      members.push(panel);
    }
    if (!GROUP_ID.test(id) || names.has(id)) {
      for (const member of members) claimed.delete(member);
      notes.push(`dropped a tab group of the ${region} region: ${id ? `${id} is a repeated or invalid name` : "it had no name"}`);
      continue;
    }
    if (members.length < 2) {
      for (const member of members) claimed.delete(member);
      notes.push(`dissolved tab group ${id}: fewer than two panels remain`);
      continue;
    }
    names.add(id);
    const active = typeof raw.active === "string" && members.includes(raw.active) ? raw.active : members[0]!;
    groups.push({ id, panels: members, active });
  }
  return groups;
}

export function persistLayout(storage: LayoutStorage, layout: Layout): void {
  storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}
