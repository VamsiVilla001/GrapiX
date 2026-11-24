// Which picture the main viewport shows: the Draft canvas or the engine's frame.
//
// The Draft view (Three.js) cannot draw effects, so it leaves an object that has
// them out (viewport.ts). The engine can (3.22). Rather than show a viewport that
// silently lacks an effect, the viewport takes the engine's frame whenever the
// scene has an enabled effect and the engine has one to show, and says so.
//
// Pure: a value in, a verdict out, so every rule is testable. Selection handles
// stay on the overlay either way (11.7); only the picture beneath them changes.

import type { PreviewStatus } from "./engine-preview";

export type ViewChoice = "auto" | "draft" | "engine";

export interface ViewportSourceInput {
  /** Every object's effect stack: only the enabled ones count. */
  readonly objects: readonly { readonly effects?: readonly { readonly enabled: boolean }[] }[];
  readonly choice: ViewChoice;
  readonly status: PreviewStatus;
  /** True when the engine has any frame to show at all. */
  readonly hasImage: boolean;
  /** The preview clock is running: the engine frame resumes on pause. */
  readonly playing: boolean;
}

export interface ViewportSource {
  readonly source: "draft" | "engine";
  /** Why, in words, when the choice could not be honoured or the draft is missing something. */
  readonly note?: string;
}

export function hasEnabledEffects(objects: ViewportSourceInput["objects"]): boolean {
  return objects.some((object) => (object.effects ?? []).some((effect) => effect.enabled));
}

/** Whether the viewport should be showing the engine's frame, playing or not. */
export function wantsEngineFrame(objects: ViewportSourceInput["objects"], choice: ViewChoice): boolean {
  return choice === "engine" || (choice === "auto" && hasEnabledEffects(objects));
}

export function viewportSource(input: ViewportSourceInput): ViewportSource {
  const effects = hasEnabledEffects(input.objects);
  if (!wantsEngineFrame(input.objects, input.choice)) return { source: "draft" };
  // Playing or paused, the engine frame is the picture: the preview asks for the frame at the
  // playhead on every tick and the scheduler keeps only the latest, so effects stay on screen
  // as fast as the engine renders them.
  if (!input.hasImage || input.status === "unavailable" || input.status === "refused") {
    return {
      source: "draft",
      ...(effects ? { note: "The engine has no frame to show, so the Draft view is drawn without effects." } : {}),
    };
  }
  return { source: "engine" };
}
