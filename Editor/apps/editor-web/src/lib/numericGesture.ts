import { useRef, useState } from "react";
import { capturePointer, releasePointer } from "./pointerCapture";

/**
 * One numeric editing gesture, shared by the Object Manager's grid cells and the Inspector's fields.
 *
 * The two panels edit the same properties and used to do it differently: the grid scrubbed
 * horizontally, held Shift for fine control, and opened a history transaction on focus so a whole drag
 * was one undo step — while the Inspector wrote on every keystroke, had no scrub at all, and deposited a
 * history entry per character. An author moving between them met two conventions for one act, and
 * "undo" meant different amounts of work depending on which panel they had used.
 *
 * The gesture is split in two on purpose. `reduceScrub` is pure arithmetic with no React and no DOM, so
 * the rules that are easy to get wrong — the dead zone, the Shift factor, the commit-only-if-moved
 * decision — are asserted directly. `useNumericGesture` is the thin React shell that owns a pointer and
 * a transaction.
 */

/** Pixels of travel before a press becomes a drag. Below this, a click stays a click. */
export const SCRUB_DEAD_ZONE_PX = 2;

/** Shift multiplies the step by this. One tenth, matching the grid's shipped behaviour. */
export const SCRUB_FINE_FACTOR = 0.1;

export interface ScrubOrigin {
  /** Value when the press began. Every delta is measured from here, never from the last frame. */
  startValue: number;
  startX: number;
  /** True once the pointer has travelled past the dead zone. */
  active: boolean;
}

export interface ScrubInput {
  clientX: number;
  shiftKey: boolean;
  /** The property's step: how much one pixel of travel is worth before the fine factor. */
  step: number;
  min?: number;
  max?: number;
}

export interface ScrubOutcome {
  /** True when the gesture is now a drag; latch it so a slow return past the dead zone stays a drag. */
  active: boolean;
  /** The value to show, or null when the pointer has not travelled far enough to mean anything. */
  value: number | null;
}

/**
 * What a pointer move means.
 *
 * Measuring from `startValue` rather than accumulating per move is what keeps a scrub reversible: drag
 * right then back to where you started and the value returns exactly, with no drift from rounding a
 * hundred small deltas.
 */
export function reduceScrub(origin: ScrubOrigin, input: ScrubInput): ScrubOutcome {
  const travel = input.clientX - origin.startX;
  if (!origin.active && Math.abs(travel) < SCRUB_DEAD_ZONE_PX) {
    return { active: false, value: null };
  }
  const sensitivity = input.shiftKey ? SCRUB_FINE_FACTOR : 1;
  return {
    active: true,
    value: scrubNumericValue(origin.startValue, travel, input.step, sensitivity, input.min, input.max)
  };
}

/**
 * A scrubbed value, rounded to the precision its step implies.
 *
 * Moved here from `modules/object-manager/services/` when the Inspector became the second caller: a
 * copy in each panel is how the two came to disagree about the fine factor in the first place.
 */
export function scrubNumericValue(
  startValue: number,
  deltaPixels: number,
  step: number,
  sensitivity = 1,
  min?: number,
  max?: number
): number {
  const finiteStep = Number.isFinite(step) && step > 0 ? step : 1;
  const finiteSensitivity = Number.isFinite(sensitivity) && sensitivity > 0 ? sensitivity : 1;
  const candidate = startValue + deltaPixels * finiteStep * finiteSensitivity;
  const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, candidate));
  const precision = Math.min(8, Math.max(0, decimalPlaces(finiteStep) + 2));
  return Number(clamped.toFixed(precision));
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

export interface NumericGestureOptions {
  /** Current value, in the units the control displays. */
  value: number;
  step: number;
  min?: number;
  max?: number;
  /** Opens a history transaction, so the whole gesture is one undo step. */
  onBeginEdit: (label: string) => void;
  /** Closes it. Compares against its own snapshot, so an unchanged scene deposits nothing. */
  onCommitEdit: () => void;
  /**
   * Abandons it, restoring the scene as it was when the edit began and depositing nothing.
   *
   * Not `onChange(snapshotOfThisNumber)`: that was the first implementation and it could only restore
   * the one value this field displays. On a **mixed** field across a selection there is no such value —
   * writing one would turn "twelve different X positions" into twelve identical ones, which is the
   * invented data the mixed field exists to avoid. Restoring the scene restores every object the
   * gesture touched, and a mixed field becomes mixed again because no write survives.
   */
  onCancelEdit: () => void;
  onChange: (value: number) => void;
  /** History label for the transaction this gesture opens. */
  label: string;
}

export interface NumericGesture {
  /** True while a drag is in progress, for the caller's styling. */
  scrubbing: boolean;
  /** The value the author was looking at when the edit began, for Escape. */
  revert: () => void;
  handlers: {
    onFocus: () => void;
    onBlur: () => void;
    onKeyDown: (event: { key: string; stopPropagation: () => void; currentTarget: HTMLElement }) => void;
    onPointerDown: (event: NumericPointerEvent) => void;
    onPointerMove: (event: NumericPointerEvent) => void;
    onPointerUp: (event: NumericPointerEvent) => void;
    onPointerCancel: (event: NumericPointerEvent) => void;
  };
}

export interface NumericPointerEvent {
  button?: number;
  pointerId: number;
  clientX: number;
  shiftKey: boolean;
  currentTarget: HTMLElement;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * The gesture, as React handlers.
 *
 * Two rules earn their place here rather than in each caller. **A transaction opens on focus and closes
 * on blur**, so typing four characters is one undo step rather than four. And **an unguarded
 * `setPointerCapture` throws** on a released or synthetic pointer and abandons the rest of the handler,
 * which is how a gesture silently does nothing — `capturePointer` is the guarded form.
 */
export function useNumericGesture(options: NumericGestureOptions): NumericGesture {
  const origin = useRef<(ScrubOrigin & { pointerId: number }) | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const beginTransaction = () => options.onBeginEdit(options.label);

  const endTransaction = () => options.onCommitEdit();

  // Escape restores the scene as the edit found it. The store holds that snapshot, so this field does
  // not need to keep a second copy of one number — and a batch reverts in full rather than in part.
  const revert = () => options.onCancelEdit();

  return {
    scrubbing,
    revert,
    handlers: {
      onFocus: beginTransaction,
      onBlur: endTransaction,
      onKeyDown: (event) => {
        // A live field owns its own keys, or a panel-scoped Delete deletes the object being typed into.
        event.stopPropagation();
        if (event.key === "Enter") {
          endTransaction();
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Escape") {
          revert();
          event.currentTarget.blur();
        }
      },
      onPointerDown: (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        event.stopPropagation();
        beginTransaction();
        origin.current = {
          active: false,
          pointerId: event.pointerId,
          startValue: options.value,
          startX: event.clientX
        };
        capturePointer(event.currentTarget, event.pointerId);
      },
      onPointerMove: (event) => {
        const current = origin.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const outcome = reduceScrub(current, {
          clientX: event.clientX,
          shiftKey: event.shiftKey,
          step: options.step,
          min: options.min,
          max: options.max
        });
        if (!outcome.active) return;
        if (!current.active) {
          current.active = true;
          setScrubbing(true);
        }
        event.preventDefault();
        if (outcome.value !== null) options.onChange(outcome.value);
      },
      onPointerUp: (event) => {
        const current = origin.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const wasDrag = current.active;
        origin.current = null;
        setScrubbing(false);
        releasePointer(event.currentTarget, event.pointerId);
        // A press that never moved leaves the field focused and typing; its transaction closes on blur.
        if (wasDrag) {
          event.preventDefault();
          endTransaction();
        }
      },
      onPointerCancel: (event) => {
        const current = origin.current;
        if (!current || current.pointerId !== event.pointerId) return;
        origin.current = null;
        setScrubbing(false);
        endTransaction();
      }
    }
  };
}
