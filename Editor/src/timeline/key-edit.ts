// Selecting, moving, deleting and pasting keys (11.22).
//
// Everything here is pure: it turns a gesture into the ordered `SceneEdit`
// batch that would perform it, and the caller sends it as **one** command,
// which Rust applies atomically as one history entry. That
// split is deliberate — "one undo per gesture" is then a property of the
// returned list rather than of whoever remembered to batch.
//
// **Collision behaviour is explicit, and it is the contract's.**
// `move_keyframe` in `gx_contracts::animation` refuses a move onto an occupied
// frame with `DuplicateKeyframeFrame`. Nothing here silently overwrites or
// nudges aside: a drag that would land two keys on one frame is reported by
// name, because a key quietly destroyed is motion an author cannot get back.
// `planMove` detects it up front so the refusal can be shown before anything
// is written, and the same rule still guards the write underneath.

import type { CubicBezier, SceneEasing, SceneEdit } from "@grapix/contracts";
import { wireFrame } from "../command-client";
import { keyId, parseKeyId, type TimelineModel } from "./model";
import { countInSpan } from "./key-index";

/** A gesture's ordered edits are one Rust history entry. */
export interface Gesture {
  readonly edits: readonly SceneEdit[];
  readonly label: string;
}

/// A gesture that cannot be performed, and why.
export interface EditRefused {
  readonly refused: string;
}

export type EditPlan = Gesture | EditRefused;

export function isRefused(plan: EditPlan): plan is EditRefused {
  return "refused" in plan;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/// Snap a frame to the nearest interesting position within `tolerance`.
///
/// Candidates are the playhead and the keys already on the target channel —
/// the two things an author is actually trying to line up with. Integer frames
/// are not a "snap": they are the only positions that exist, so a frame is
/// always rounded regardless.
export function snapFrame(
  frame: number,
  candidates: readonly number[],
  tolerance: number,
): number {
  const rounded = Math.round(frame);
  let best = rounded;
  let bestDistance = tolerance + 1;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - rounded);
    if (distance <= tolerance && distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export const SNAP_TOLERANCE_FRAMES = 3;

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/// Keys inside a frame span on the given tracks — the marquee result.
export function keysInSpan(
  model: TimelineModel,
  trackIndices: readonly number[],
  firstFrame: number,
  lastFrame: number,
): string[] {
  const found: string[] = [];
  for (const index of trackIndices) {
    const track = model.tracks[index];
    if (!track) continue;
    const from = Math.min(firstFrame, lastFrame);
    const to = Math.max(firstFrame, lastFrame);
    if (countInSpan(track.keys, from, to) === 0) continue;
    for (const frame of track.keys.frames) {
      if (frame >= from && frame <= to) {
        found.push(keyId(track.objectId, track.property, frame));
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

/// Move every selected key by `delta` frames.
///
/// Refuses the whole gesture rather than part of it. A partial move would
/// leave a selection the author cannot undo in one step and cannot reason
/// about — some keys moved, some refused, and no single state to return to.
export function planMove(
  model: TimelineModel,
  selected: readonly string[],
  delta: number,
): EditPlan {
  if (selected.length === 0) return { refused: "no keys are selected" };
  if (delta === 0) return { refused: "the keys did not move" };

  const parsed = selected.map(parseKeyId).filter((key) => key !== undefined);
  if (parsed.length !== selected.length) return { refused: "a selected key is unreadable" };

  // Where every key ends up, and what each channel will hold afterwards.
  const moving = new Map<string, Set<number>>();
  for (const key of parsed) {
    const channel = `${key!.objectId}/${key!.property}`;
    if (!moving.has(channel)) moving.set(channel, new Set());
    moving.get(channel)!.add(key!.frame);
  }

  for (const key of parsed) {
    const target = key!.frame + delta;
    if (target < 0) {
      return { refused: `frame ${target} is before the start of the timeline` };
    }
    if (target > model.durationFrames) {
      return {
        refused: `frame ${target} is outside the ${model.durationFrames}-frame timeline`,
      };
    }
    const track = model.tracks.find(
      (candidate) =>
        candidate.objectId === key!.objectId && candidate.property === key!.property,
    );
    if (!track) return { refused: `no track for ${key!.objectId}.${key!.property}` };

    // A landing frame is a collision only if an *unselected* key already holds
    // it: keys moving together vacate their own frames.
    const selectedOnChannel = moving.get(`${key!.objectId}/${key!.property}`)!;
    const occupied = track.keys.frames.includes(target) && !selectedOnChannel.has(target);
    if (occupied) {
      return {
        refused: `frame ${target} on ${key!.objectId}.${key!.property} already has a key`,
      };
    }
  }

  // Move in an order that never transiently collides: rightward moves start
  // from the rightmost key, leftward from the leftmost. Without this, sliding
  // a run of keys one frame right would refuse on its own neighbour.
  const ordered = [...parsed].sort((left, right) =>
    delta > 0 ? right!.frame - left!.frame : left!.frame - right!.frame,
  );

  return {
    edits: ordered.map((key) => ({
      edit: "moveKeyframe",
      objectId: key!.objectId,
      property: key!.property,
      fromFrame: wireFrame(key!.frame),
      toFrame: wireFrame(key!.frame + delta),
    })),
    label:
      selected.length === 1
        ? `Move key ${delta > 0 ? "+" : ""}${delta} frames`
        : `Move ${selected.length} keys ${delta > 0 ? "+" : ""}${delta} frames`,
  };
}

/// Delete every selected key.
export function planDelete(selected: readonly string[]): EditPlan {
  if (selected.length === 0) return { refused: "no keys are selected" };
  const parsed = selected.map(parseKeyId).filter((key) => key !== undefined);
  if (parsed.length !== selected.length) return { refused: "a selected key is unreadable" };

  return {
    edits: parsed.map((key) => ({
      edit: "removeKeyframe",
      objectId: key!.objectId,
      property: key!.property,
      frame: wireFrame(key!.frame),
    })),
    label: selected.length === 1 ? "Delete key" : `Delete ${selected.length} keys`,
  };
}

/// Assign an easing to every selected key (11.23).
///
/// Each key keeps its own frame and value — only the outgoing curve changes —
/// so this reads the authored key and rewrites it rather than inventing one.
/// A custom bezier without control points is refused here as well as in Rust,
/// so the author sees why before a round trip.
export function planSetEasing(
  model: TimelineModel,
  selected: readonly string[],
  easing: SceneEasing,
  bezier?: CubicBezier,
): EditPlan {
  if (selected.length === 0) return { refused: "no keys are selected" };
  if (easing === "custom-bezier" && bezier === undefined) {
    return { refused: "a custom bezier needs its control points" };
  }

  const edits: SceneEdit[] = [];
  for (const id of selected) {
    const key = parseKeyId(id);
    if (!key) return { refused: "a selected key is unreadable" };
    const track = model.tracks.find(
      (candidate) => candidate.objectId === key.objectId && candidate.property === key.property,
    );
    const source = track?.sourceKeys.find((candidate) => Number(candidate.frame) === key.frame);
    if (!source) {
      return { refused: `no key on ${key.objectId}.${key.property} at frame ${key.frame}` };
    }
    edits.push({
      edit: "updateKeyframe",
      objectId: key.objectId,
      property: key.property,
      keyframe: {
        frame: wireFrame(key.frame),
        value: source.value,
        easing,
        ...(easing === "custom-bezier" && bezier !== undefined ? { bezier } : {}),
      },
    });
  }

  return {
    edits,
    label:
      selected.length === 1
        ? `Set easing to ${easing}`
        : `Set easing to ${easing} on ${selected.length} keys`,
  };
}

/// One copied key: its channel, its offset from the copy origin, and its value.
export interface ClipboardKey {
  readonly objectId: string;
  readonly property: string;
  readonly offset: number;
  readonly value: number;
  readonly easing: SceneEasing;
  readonly bezier?: CubicBezier;
}

/// Copy the selection, with frames stored **relative** to the earliest key.
///
/// Relative because paste lands at the playhead: an author who copies a run
/// and pastes it later expects the run's shape, not its original frames.
export function planCopy(model: TimelineModel, selected: readonly string[]): ClipboardKey[] {
  const parsed = selected.map(parseKeyId).filter((key) => key !== undefined);
  if (parsed.length === 0) return [];
  const origin = Math.min(...parsed.map((key) => key!.frame));

  const copied: ClipboardKey[] = [];
  for (const key of parsed) {
    const track = model.tracks.find(
      (candidate) =>
        candidate.objectId === key!.objectId && candidate.property === key!.property,
    );
    const source = track?.sourceKeys.find((candidate) => Number(candidate.frame) === key!.frame);
    if (!source) continue;
    copied.push({
      objectId: key!.objectId,
      property: key!.property,
      offset: key!.frame - origin,
      value: source.value,
      easing: source.easing,
      ...(source.bezier === undefined ? {} : { bezier: source.bezier }),
    });
  }
  return copied;
}

/// Paste the clipboard with its earliest key at `atFrame`.
///
/// Existing keys at the landing frames are reported rather than overwritten,
/// for the same reason a colliding move is: a key silently replaced is motion
/// the author cannot recover.
export function planPaste(
  model: TimelineModel,
  clipboard: readonly ClipboardKey[],
  atFrame: number,
): EditPlan {
  if (clipboard.length === 0) return { refused: "the clipboard is empty" };

  const edits: SceneEdit[] = [];
  for (const key of clipboard) {
    const frame = atFrame + key.offset;
    if (frame > model.durationFrames) {
      return {
        refused: `pasting here would put a key at frame ${frame}, outside the ${model.durationFrames}-frame timeline`,
      };
    }
    const track = model.tracks.find(
      (candidate) => candidate.objectId === key.objectId && candidate.property === key.property,
    );
    if (track?.keys.frames.includes(frame)) {
      return {
        refused: `frame ${frame} on ${key.objectId}.${key.property} already has a key`,
      };
    }
    edits.push({
      edit: "createKeyframe",
      objectId: key.objectId,
      property: key.property,
      keyframe: {
        frame: wireFrame(frame),
        value: key.value,
        easing: key.easing,
        ...(key.bezier === undefined ? {} : { bezier: key.bezier }),
      },
    });
  }

  return {
    edits,
    label: clipboard.length === 1 ? `Paste key at ${atFrame}` : `Paste ${clipboard.length} keys at ${atFrame}`,
  };
}
