// The engine preview's scheduler (build plan 11.65).
//
// The Editor's draft viewport cannot draw effects, shaped text or masks; the
// engine can. The Preview shows the engine's frame of the document being edited,
// and this module decides *when to ask* and *what the Preview may claim*:
//
// - **Latest only** (Jev 0.76, Laya agreed). At most one render is in flight and
//   one is pending: a newer request replaces the pending one, so a burst of edits
//   costs two renders, the first and the last, never a backlog, and the picture
//   always converges on the latest state.
// - **Never stale as current** (Jev 0.98). While a newer edit is rendering the
//   last frame stays visible but its status is `stale`, not `current`; an engine
//   that cannot be reached or declines makes the status `unavailable` or
//   `refused`, with the reason in words. A frame is `current` only when it is the
//   frame of the latest request.
//
// Pure: no timers, no DOM, no shell. The caller supplies how to render, how to
// turn bytes into a URL and how to name an error, so every rule is testable.

export type PreviewStatus = "idle" | "rendering" | "current" | "stale" | "unavailable" | "refused";

export interface PreviewState {
  readonly status: PreviewStatus;
  /** The last frame the engine drew, if any. Shown only with a status that says whether it is current. */
  readonly imageUrl?: string;
  /** The request key of the frame in `imageUrl`. */
  readonly shownKey?: string;
  /** The request key of the latest request. */
  readonly requestedKey?: string;
  /** Why the preview is not current, in words. */
  readonly detail?: string;
  /** How long the last completed render took, in milliseconds. */
  readonly renderMs?: number;
}

export interface Failure {
  readonly status: "unavailable" | "refused";
  readonly detail: string;
}

export interface PreviewDeps<P> {
  /** Draw `payload` on the engine and return the PNG bytes, or throw. */
  render(payload: P): Promise<Uint8Array | ArrayBuffer>;
  makeUrl(bytes: Uint8Array | ArrayBuffer): string;
  revokeUrl(url: string): void;
  onState(state: PreviewState): void;
  /** Name a thrown error: the engine could not be reached, or it declined. */
  classify(error: unknown): Failure;
  now?(): number;
}

export interface EnginePreview<P> {
  /** Ask for the frame `key` names. A repeat of the latest key while it is rendering or current is ignored. */
  request(key: string, payload: P): void;
  /** Forget everything (a scene closed): the image is released and the state is idle. */
  clear(): void;
  state(): PreviewState;
}

export function createEnginePreview<P>(deps: PreviewDeps<P>): EnginePreview<P> {
  const now = deps.now ?? (() => Date.now());
  let state: PreviewState = { status: "idle" };
  let latest: string | undefined;
  let inFlight = false;
  let pending: { key: string; payload: P } | undefined;
  /** Bumped by `clear`, so a render that finishes after it is dropped. */
  let epoch = 0;

  const publish = (next: PreviewState): void => {
    state = next;
    deps.onState(state);
  };

  const withImage = (status: PreviewStatus, extra: Partial<PreviewState> = {}): PreviewState => ({
    status,
    ...(state.imageUrl === undefined ? {} : { imageUrl: state.imageUrl }),
    ...(state.shownKey === undefined ? {} : { shownKey: state.shownKey }),
    ...(latest === undefined ? {} : { requestedKey: latest }),
    ...(state.renderMs === undefined ? {} : { renderMs: state.renderMs }),
    ...extra,
  });

  const start = (key: string, payload: P): void => {
    inFlight = true;
    const mine = epoch;
    const began = now();
    // With a frame already on screen it is now out of date; with none we are drawing the first.
    publish(
      state.imageUrl === undefined
        ? withImage("rendering", { detail: "drawing the first engine frame" })
        : withImage("stale", { detail: "a newer edit is being drawn" }),
    );
    deps.render(payload).then(
      (bytes) => {
        if (mine !== epoch) return;
        inFlight = false;
        const url = deps.makeUrl(bytes);
        if (state.imageUrl !== undefined) deps.revokeUrl(state.imageUrl);
        const renderMs = Math.max(0, now() - began);
        const newer = pending;
        if (latest === key && newer === undefined) {
          publish({ status: "current", imageUrl: url, shownKey: key, requestedKey: key, renderMs });
        } else {
          // The frame that arrived is not the latest: it is shown, and it says so.
          state = { status: "stale", imageUrl: url, shownKey: key, ...(latest === undefined ? {} : { requestedKey: latest }), renderMs };
          pending = undefined;
          if (newer) start(newer.key, newer.payload);
          else publish(withImage("stale", { detail: "a newer edit is being drawn" }));
        }
      },
      (error: unknown) => {
        if (mine !== epoch) return;
        inFlight = false;
        const failure = deps.classify(error);
        const newer = pending;
        pending = undefined;
        publish(withImage(failure.status, { detail: failure.detail }));
        // A newer edit asks again: the engine may be back.
        if (newer) start(newer.key, newer.payload);
      },
    );
  };

  return {
    request(key, payload) {
      if (key === latest && (inFlight || state.status === "current")) return;
      latest = key;
      if (inFlight) {
        pending = { key, payload };
        // The frame on screen is no longer the latest.
        if (state.imageUrl !== undefined && state.status === "current") {
          publish(withImage("stale", { detail: "a newer edit is being drawn" }));
        }
        return;
      }
      start(key, payload);
    },
    clear() {
      epoch += 1;
      if (state.imageUrl !== undefined) deps.revokeUrl(state.imageUrl);
      latest = undefined;
      pending = undefined;
      inFlight = false;
      publish({ status: "idle" });
    },
    state: () => state,
  };
}

/** The words a status carries on screen. A frame is never labelled current unless it is. */
export function statusWords(state: PreviewState): { readonly word: string; readonly tone: "ok" | "warn" | "bad" | "idle" } {
  switch (state.status) {
    case "current":
      return { word: "Current", tone: "ok" };
    case "rendering":
      return { word: "Drawing…", tone: "idle" };
    case "stale":
      return { word: "Out of date", tone: "warn" };
    case "unavailable":
      return { word: "Engine unavailable", tone: "bad" };
    case "refused":
      return { word: "Engine declined", tone: "bad" };
    default:
      return { word: "No frame yet", tone: "idle" };
  }
}

/** The width and height written in a PNG's header, or `undefined` if it is not a PNG. */
export function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The lines of the engine hover card (visibility decision of 26 Nov 2026, Figma B2v2): the status in words, what the engine said when it
 * is not current, and the last frame's draw time. The chip stays one word; the rest is on hover or focus.
 */
export function engineHoverLines(state: PreviewState): string[] {
  const lines = [statusWords(state).word];
  const detail = state.detail?.trim() ?? "";
  if (detail !== "") lines.push(detail);
  if (state.renderMs !== undefined && Number.isFinite(state.renderMs) && state.renderMs >= 0) {
    lines.push(`Last frame drawn in ${Math.round(state.renderMs)} ms`);
  }
  return lines;
}
