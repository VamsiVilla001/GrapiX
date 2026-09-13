// The timeline's row model (11.10, extended for 11.22).
//
// Built from `SceneDocument.timeline.channels`, which 11.20 put in the shared
// contract, so the timeline and the inspector read the same channels and
// cannot disagree about what is animated (invariant 27).
//
// **Selection drives what is shown.** Selecting objects reveals their property
// tracks and nothing else; selecting nothing shows the whole document, because
// an empty timeline would be a worse default than a full one. Each object gets
// a collapsible group row, so a scene with forty animated objects is navigable
// rather than a wall of tracks.
//
// Each track carries a `KeyIndex` — the drawing representation — which is what
// keeps repaint off the O(keys) path. `sourceKeys` is a borrowed reference to
// the authored array, never a copy.

import type { RationalRate, SceneDocument, SceneKeyframe } from "@grapix/contracts";

import { propertyLabel } from "../keyframe-editor";
import { buildKeyIndex, type KeyIndex } from "./key-index";

export interface TimelineTrack {
  readonly objectId: string;
  readonly objectName: string;
  readonly property: string;
  /// "Opacity" — the property alone; the group row carries the object name.
  readonly label: string;
  readonly keys: KeyIndex;
  /// The channel's keys as authored. A reference to the existing array, never
  /// a copy: the speed graph needs values and easings, which the index does
  /// not carry, and copying would reintroduce the per-key cost the index
  /// exists to remove.
  readonly sourceKeys: readonly SceneKeyframe[];
}

/// A displayed row: either an object's collapsible group header, or one of its
/// property tracks.
export type TimelineRow =
  | {
      readonly kind: "object";
      readonly objectId: string;
      readonly label: string;
      readonly collapsed: boolean;
      readonly trackCount: number;
    }
  | {
      readonly kind: "track";
      readonly objectId: string;
      readonly property: string;
      readonly label: string;
      /// Index into `TimelineModel.tracks`, so a row can open its speed graph.
      readonly track: number;
    };

export interface TimelineModel {
  /// Every track in the model, group rows excluded. Indexed by `row.track`.
  readonly tracks: readonly TimelineTrack[];
  /// What the panel renders, in order, including group headers.
  readonly rows: readonly TimelineRow[];
  readonly durationFrames: number;
  readonly frameRate: RationalRate;
  /// Total keys across every track. Reported for diagnostics only; nothing in
  /// the render path is allowed to be proportional to it.
  readonly keyCount: number;
}

export interface TimelineModelOptions {
  /// Objects selected in the viewport. Non-empty restricts the timeline to
  /// their tracks (11.22's "selection automatically reveals property tracks").
  readonly selectedIds?: readonly string[];
  /// Objects whose tracks are collapsed away.
  readonly collapsedIds?: readonly string[];
}

export function timelineModel(
  document: SceneDocument,
  options: TimelineModelOptions = {},
): TimelineModel {
  const selected = options.selectedIds ?? [];
  const collapsed = options.collapsedIds ?? [];
  const names = new Map(document.objects.map((object) => [object.id, object.name]));
  const channels = document.timeline.channels ?? [];

  const tracks: TimelineTrack[] = [];
  let keyCount = 0;
  for (const channel of channels) {
    // Selection-driven: with a selection, only its objects appear. Without
    // one, the whole document does.
    if (selected.length > 0 && !selected.includes(channel.objectId)) continue;
    keyCount += channel.keys.length;
    tracks.push({
      objectId: channel.objectId,
      objectName: names.get(channel.objectId) ?? channel.objectId,
      property: channel.property,
      label: propertyLabel(channel.property),
      keys: buildKeyIndex(channel.keys),
      sourceKeys: channel.keys,
    });
  }

  // Stable order: an author's rows must not reshuffle because a channel was
  // appended. Object name first, then property, both already fixed strings.
  tracks.sort((left, right) =>
    left.objectName === right.objectName
      ? left.property.localeCompare(right.property)
      : left.objectName.localeCompare(right.objectName),
  );

  const rows: TimelineRow[] = [];
  let index = 0;
  while (index < tracks.length) {
    const objectId = tracks[index]!.objectId;
    const owned: number[] = [];
    while (index < tracks.length && tracks[index]!.objectId === objectId) {
      owned.push(index);
      index += 1;
    }
    const isCollapsed = collapsed.includes(objectId);
    rows.push({
      kind: "object",
      objectId,
      label: tracks[owned[0]!]!.objectName,
      collapsed: isCollapsed,
      trackCount: owned.length,
    });
    if (isCollapsed) continue;
    for (const track of owned) {
      rows.push({
        kind: "track",
        objectId,
        property: tracks[track]!.property,
        label: tracks[track]!.label,
        track,
      });
    }
  }

  return {
    tracks,
    rows,
    durationFrames: Number(document.timeline.durationFrames),
    frameRate: document.canvas.frameRate,
    keyCount,
  };
}

/// The stable identity of one key: object, property and frame.
///
/// Frame is enough to identify a key within a channel because
/// `move_keyframe` refuses a move onto an occupied frame, so frames are
/// unique per channel by contract (11.20).
export function keyId(objectId: string, property: string, frame: number): string {
  return `${objectId}/${property}/${frame}`;
}

export function parseKeyId(
  id: string,
): { objectId: string; property: string; frame: number } | undefined {
  const parts = id.split("/");
  if (parts.length !== 3) return undefined;
  const frame = Number(parts[2]);
  if (!Number.isFinite(frame)) return undefined;
  return { objectId: parts[0]!, property: parts[1]!, frame };
}
