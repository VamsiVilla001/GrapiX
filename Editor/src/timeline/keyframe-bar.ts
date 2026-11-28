// The Timeline's KEYFRAME button bar (the new Figma UI, B3; plan row 11.131).
//
// The design's toolbar has `+ Add (K)`, Linear, Ease (F9), Ease in, Ease out, Hold and, at the right, Zoom to fit. Everything
// they do already exists: the easing buttons are the plans the Keys easing select and the F9 chords use (`key-edit.ts`), and a
// key at the playhead is what a property's key toggle sends. This module is the pure part: which buttons there are, which are
// available and the reason one is not, and the one plan that is new (a key on every animated property at once) and the zoom
// that fits the scene. The page draws the buttons and sends what the plans return; nothing here touches the DOM.
//
// **Stagger (11.77)** is the one button the design does not draw: it offsets the selected keys of several elements by the step in the
// Keys group (`stagger.ts`), so it sits before Zoom to fit and is dimmed with its reason until keys of two elements are selected.
//
// **Not built, and not drawn:** the design also has Snap and Markers. Snap is always on in a key drag (there is no switch) and
// the scene has no timeline markers, so those two buttons would do nothing. Plan row 11.131 records them as open (Jev, 24 Nov
// 2026: leave them out until the features exist).
//
// **`+ Add` keys what is already animated.** It adds a key at the playhead on every property the selected elements already
// animate, each at the value its curve has at that frame, so adding a key never moves anything. An element that animates
// nothing is refused with how to start (the property's diamond), rather than keying every property it has.

import type { SceneDocument, SceneEasing, SceneEdit } from "@grapix/contracts";

import { keyframeForValue, propertyLabel, propertyValueAt } from "../keyframe-editor";
import { parseKeyId } from "./model";
import type { EditPlan } from "./key-edit";
import { staggerBlocker } from "./stagger";

export type BarAction = "prev" | "play" | "next" | "add" | "linear" | "ease" | "ease-in" | "ease-out" | "hold" | "stagger" | "fit" | "auto-key";

export interface BarButton {
  readonly action: BarAction;
  readonly label: string;
  /** Said on hover. */
  readonly hint: string;
  /** The button the design draws in the primary style: the one a key press (F9) does too. */
  readonly primary?: boolean;
  /** Pushed to the right edge, with the other buttons that act on the view rather than on keys. */
  readonly right?: boolean;
}

export const BAR_BUTTONS: readonly BarButton[] = [
  // The transport (visibility decision of 26 Nov 2026, Figma B3): the Preview panel's buttons, here where the keys are.
  { action: "prev", label: "Prev", hint: "Previous frame" },
  { action: "play", label: "Play", hint: "Play or pause the preview (Space)" },
  { action: "next", label: "Next", hint: "Next frame" },
  { action: "add", label: "+ Add  (K)", hint: "Add a key at the playhead on every property the selected elements already animate" },
  { action: "linear", label: "Linear", hint: "Linear: constant speed between the selected keys" },
  { action: "ease", label: "Ease  (F9)", hint: "Ease the selected keys on both sides (F9)", primary: true },
  { action: "ease-in", label: "Ease in", hint: "Ease the arriving side of the selected keys (Shift F9)" },
  { action: "ease-out", label: "Ease out", hint: "Ease the leaving side of the selected keys (Ctrl Shift F9)" },
  { action: "hold", label: "Hold", hint: "Hold: the value stays until the next key" },
  {
    action: "stagger",
    label: "Stagger",
    hint: "Offset the selected keys of several elements by the step in Stagger settings (the caret), one element after the next (11.77)",
  },
  { action: "fit", label: "Zoom to fit", hint: "Zoom so the whole scene fits the timeline", right: true },
  // Auto-key (Figma B3; Jev, 26 Nov 2026): the Animation panel's switch, here where the keys are; that panel now waits until opened.
  { action: "auto-key", label: "Auto-key", hint: "Auto-key: a changed property gets a key at the playhead, even one not animated yet", right: true },
];

/**
 * The timeline's right-click menu (visibility decision of 26 Nov 2026): the on-demand groups, each the id of the button that opens
 * its popover. The Motion menu opens the same ones.
 */
export const TIMELINE_MENU: readonly (readonly [string, string])[] = [
  ["stagger-settings", "Stagger settings…"],
  ["timeline-keys-open", "Easing…"],
  ["timeline-presets-open", "Motion presets…"],
  ["timeline-phases-open", "Phases…"],
];

export interface BarButtonState {
  /** Why the button cannot be pressed now. */
  readonly disabled?: string;
  /** The selected keys all have this easing already. */
  readonly active?: boolean;
}

/** The easing a button sets, for the buttons that set one. */
const EASING_OF: Readonly<Partial<Record<BarAction, SceneEasing>>> = { linear: "linear", hold: "hold" };

/** What each button can do for this selection, and why not when it cannot. */
export function barState(
  document: SceneDocument | null,
  selectedKeyIds: readonly string[],
  selectedObjectIds: readonly string[],
  autoKey = false,
): Record<BarAction, BarButtonState> {
  const noKeys = selectedKeyIds.length === 0 ? "Select keys in the timeline first" : undefined;
  const easings = new Set(
    selectedKeyIds.flatMap((id) => {
      const key = parseKeyId(id);
      const channel = key === undefined ? undefined : document?.timeline.channels?.find((c) => c.objectId === key.objectId && c.property === key.property);
      const found = channel?.keys.find((k) => Number(k.frame) === key?.frame);
      return found === undefined ? [] : [found.easing];
    }),
  );
  const same = (easing: SceneEasing): boolean => easings.size === 1 && easings.has(easing);
  const noScene = document === null ? { disabled: "Open a scene first" } : {};
  return {
    prev: noScene,
    play: noScene,
    next: noScene,
    add: document === null ? { disabled: "Open a scene first" } : selectedObjectIds.length === 0 ? { disabled: "Select an element first" } : {},
    linear: { ...(noKeys === undefined ? {} : { disabled: noKeys }), ...(same(EASING_OF.linear!) ? { active: true } : {}) },
    ease: noKeys === undefined ? {} : { disabled: noKeys },
    "ease-in": noKeys === undefined ? {} : { disabled: noKeys },
    "ease-out": noKeys === undefined ? {} : { disabled: noKeys },
    hold: { ...(noKeys === undefined ? {} : { disabled: noKeys }), ...(same(EASING_OF.hold!) ? { active: true } : {}) },
    stagger: (why => (why === undefined ? {} : { disabled: why }))(staggerBlocker(document, selectedKeyIds)),
    fit: document === null ? { disabled: "Open a scene first" } : {},
    // A switch, not an edit: it can be set before a scene is open, and it says whether it is on.
    "auto-key": autoKey ? { active: true } : {},
  };
}

/**
 * A key at the playhead on every property the selected elements already animate, each at its current value. One gesture, so
 * undo takes them all back together. A property that already has a key at that frame is left alone.
 */
export function planAddKeys(
  document: SceneDocument,
  objectIds: readonly string[],
  frame: number,
  easing: SceneEasing,
): EditPlan {
  if (!Number.isInteger(frame) || frame < 0) return { refused: "The playhead is not on a frame." };
  const edits: SceneEdit[] = [];
  let animated = 0;
  let already = 0;
  for (const objectId of objectIds) {
    for (const channel of document.timeline.channels ?? []) {
      if (channel.objectId !== objectId) continue;
      animated += 1;
      if (channel.keys.some((key) => Number(key.frame) === frame)) {
        already += 1;
        continue;
      }
      const value = propertyValueAt(document, objectId, channel.property, frame);
      if (value === undefined) continue;
      edits.push({ edit: "createKeyframe", objectId, property: channel.property, keyframe: keyframeForValue(value, frame, easing) });
    }
  }
  if (animated === 0) {
    return { refused: "Nothing here is animated yet. Click a property's keyframe diamond to start keyframing it." };
  }
  if (edits.length === 0) {
    return { refused: `Every animated property already has a key at frame ${frame}.` };
  }
  const only = edits[0] as { property: string };
  return {
    edits,
    label: edits.length === 1 ? `Add ${propertyLabel(only.property)} key at frame ${frame}` : `Add ${edits.length} keys at frame ${frame}`,
  };
}

/** The zoom slider's range, in pixels per frame. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 40;

/** Pixels per frame that fit the whole scene in `stageWidth`, within the slider's range. */
export function fitZoom(durationFrames: number, stageWidth: number): { readonly pixelsPerFrame: number; readonly fits: boolean } {
  if (!(durationFrames > 0) || !(stageWidth > 0)) return { pixelsPerFrame: ZOOM_MIN, fits: false };
  const whole = Math.floor(stageWidth / durationFrames);
  const pixelsPerFrame = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, whole));
  return { pixelsPerFrame, fits: durationFrames * pixelsPerFrame <= stageWidth };
}
