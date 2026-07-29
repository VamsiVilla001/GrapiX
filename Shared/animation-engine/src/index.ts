/**
 * `@grapix/animation-engine` — broadcast frame clock and frame-based playback.
 *
 * Three things live here, and they exist to enforce one property: the visible
 * state of a scene is a pure function of `(sceneRevision, frame)`.
 *
 *   clock        exact rational frame rates and a drift-free integer schedule
 *   playback     frame-based playback with markers, continue and pause points,
 *                plus frame-accurate transitions — no setTimeout anywhere
 *   determinism  fingerprinting, so preview/Program parity is asserted rather
 *                than assumed
 *
 * Scene evaluation itself is deliberately not reimplemented: it delegates to
 * `evaluateSceneAtFrame` in `@grapix/shared-types`, which the editor already
 * uses. A second evaluator would drift, and drift here is invisible until air.
 */

export * from "./clock.js";
export * from "./playback.js";
export * from "./determinism.js";
