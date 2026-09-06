/**
 * Easing — one specification, two implementations.
 *
 * The twin is `services/render-engine/src/easing.rs`. They are one specification in two
 * languages, exactly like `resolveTextureFit`/`resolve_texture_fit` and the tile system: the
 * Editor previews with this file and Program renders with that one, so a curve that differs by
 * a thousandth is a graphic that eases differently on air than it did in the viewport. Both
 * sides are checked against `Shared/animation-engine/fixtures/easing-vectors.json`, which is
 * generated once and never regenerated to make a test pass.
 *
 * ## Why closed forms rather than a table
 *
 * Every curve here is a closed form or a fixed-iteration solve, written with the same
 * operations in the same order in both languages. IEEE 754 doubles then agree to well inside
 * the 1e-9 the conformance test demands. A lookup table would have to agree on its sampling
 * too, and would be wrong between samples.
 *
 * ## Why this lives in `shared-types` and not `animation-engine`
 *
 * `animation-engine` depends on `shared-types`, and the evaluator that consumes easing
 * (`sampleChannel`, `evaluateSceneAtFrame`) lives here. Putting the implementation in
 * `animation-engine` would force this package to keep its own copy — a second TypeScript
 * easing implementation, which is the drift this phase exists to remove. `@grapix/animation-engine`
 * re-exports it, so the package boundary reads the way the plan intended.
 *
 * ## Compatibility
 *
 * `ease-in`, `ease-out` and `ease-in-out` are the three curves scenes on disk already use, and
 * they are quadratic. They keep that exact shape and are aliases of the `-quad` forms. Adding a
 * name here never changes a curve that already existed.
 */

/**
 * Every easing a keyframe may name.
 *
 * Kebab-case, matching the three values already written into scene documents. The bare
 * `ease-in`/`ease-out`/`ease-in-out` are quadratic for compatibility; `ease` is the CSS default
 * curve, which is not the same thing.
 */
export type SceneKeyframeEasing =
  | "linear"
  | "hold"
  | "ease"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "ease-in-quad" | "ease-out-quad" | "ease-in-out-quad"
  | "ease-in-cubic" | "ease-out-cubic" | "ease-in-out-cubic"
  | "ease-in-quart" | "ease-out-quart" | "ease-in-out-quart"
  | "ease-in-quint" | "ease-out-quint" | "ease-in-out-quint"
  | "ease-in-sine" | "ease-out-sine" | "ease-in-out-sine"
  | "ease-in-expo" | "ease-out-expo" | "ease-in-out-expo"
  | "ease-in-circ" | "ease-out-circ" | "ease-in-out-circ"
  | "ease-in-back" | "ease-out-back" | "ease-in-out-back"
  | "ease-in-elastic" | "ease-out-elastic" | "ease-in-out-elastic"
  | "ease-in-bounce" | "ease-out-bounce" | "ease-in-out-bounce";

/** Every easing name, in the order the fixture and any picker should list them. */
export const SCENE_KEYFRAME_EASINGS: readonly SceneKeyframeEasing[] = [
  "linear",
  "hold",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "ease-in-quad", "ease-out-quad", "ease-in-out-quad",
  "ease-in-cubic", "ease-out-cubic", "ease-in-out-cubic",
  "ease-in-quart", "ease-out-quart", "ease-in-out-quart",
  "ease-in-quint", "ease-out-quint", "ease-in-out-quint",
  "ease-in-sine", "ease-out-sine", "ease-in-out-sine",
  "ease-in-expo", "ease-out-expo", "ease-in-out-expo",
  "ease-in-circ", "ease-out-circ", "ease-in-out-circ",
  "ease-in-back", "ease-out-back", "ease-in-out-back",
  "ease-in-elastic", "ease-out-elastic", "ease-in-out-elastic",
  "ease-in-bounce", "ease-out-bounce", "ease-in-out-bounce"
];

export function isSceneKeyframeEasing(value: unknown): value is SceneKeyframeEasing {
  return typeof value === "string" && (SCENE_KEYFRAME_EASINGS as readonly string[]).includes(value);
}

// --- constants, named so the Rust twin can be compared line by line ---------

/** `back` overshoot, the classic Penner constant. */
const BACK_C1 = 1.70158;
const BACK_C3 = BACK_C1 + 1;
const BACK_C2 = BACK_C1 * 1.525;
/** `elastic` angular frequencies. */
const ELASTIC_C4 = (2 * Math.PI) / 3;
const ELASTIC_C5 = (2 * Math.PI) / 4.5;
/** `bounce` gravity constant and segment width. */
const BOUNCE_N1 = 7.5625;
const BOUNCE_D1 = 2.75;

/**
 * Solve a CSS-style cubic-bezier for `y` at `x`.
 *
 * A fixed iteration count with no early exit, deliberately: an epsilon-based break can take a
 * different number of steps in two languages and land a fraction apart, and this has to match
 * the Rust twin to 1e-9. Eight Newton steps from `x` as the initial guess is well converged for
 * every curve declared here; the derivative guard keeps a flat region from dividing by zero.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const curveX = (t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
  };
  const curveY = (t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
  };
  const slopeX = (t: number) => {
    const u = 1 - t;
    return 3 * u * u * (x1 - 0) + 6 * u * t * (x2 - x1) + 3 * t * t * (1 - x2);
  };

  let t = x;
  for (let step = 0; step < 8; step += 1) {
    const dx = curveX(t) - x;
    const d = slopeX(t);
    if (Math.abs(d) < 1e-12) break;
    t -= dx / d;
  }
  return curveY(t < 0 ? 0 : t > 1 ? 1 : t);
}

/**
 * Evaluate an easing at `t`.
 *
 * `t` is clamped to [0,1] because a caller that computed a position outside the segment has
 * already made its mistake; extrapolating an elastic curve past 1 produces a value nobody
 * authored. An unrecognised name returns `undefined` rather than falling back to linear — the
 * caller decides, and `sampleChannel` holds the previous value and reports it.
 */
export function applyEasing(easing: string, t: number): number | undefined {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (easing) {
    case "linear":
      return c;
    // A hold key keeps its value for the whole segment and steps at the next key. Expressed as
    // an easing so every path through the evaluator treats it the same way.
    case "hold":
      return c < 1 ? 0 : 1;
    case "ease":
      return cubicBezier(0.25, 0.1, 0.25, 1, c);

    case "ease-in":
    case "ease-in-quad":
      return c * c;
    case "ease-out":
    case "ease-out-quad":
      return 1 - (1 - c) * (1 - c);
    case "ease-in-out":
    case "ease-in-out-quad":
      return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;

    case "ease-in-cubic":
      return c * c * c;
    case "ease-out-cubic":
      return 1 - Math.pow(1 - c, 3);
    case "ease-in-out-cubic":
      return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;

    case "ease-in-quart":
      return c * c * c * c;
    case "ease-out-quart":
      return 1 - Math.pow(1 - c, 4);
    case "ease-in-out-quart":
      return c < 0.5 ? 8 * c * c * c * c : 1 - Math.pow(-2 * c + 2, 4) / 2;

    case "ease-in-quint":
      return c * c * c * c * c;
    case "ease-out-quint":
      return 1 - Math.pow(1 - c, 5);
    case "ease-in-out-quint":
      return c < 0.5 ? 16 * c * c * c * c * c : 1 - Math.pow(-2 * c + 2, 5) / 2;

    case "ease-in-sine":
      return 1 - Math.cos((c * Math.PI) / 2);
    case "ease-out-sine":
      return Math.sin((c * Math.PI) / 2);
    case "ease-in-out-sine":
      return -(Math.cos(Math.PI * c) - 1) / 2;

    case "ease-in-expo":
      return c === 0 ? 0 : Math.pow(2, 10 * c - 10);
    case "ease-out-expo":
      return c === 1 ? 1 : 1 - Math.pow(2, -10 * c);
    case "ease-in-out-expo":
      if (c === 0) return 0;
      if (c === 1) return 1;
      return c < 0.5 ? Math.pow(2, 20 * c - 10) / 2 : (2 - Math.pow(2, -20 * c + 10)) / 2;

    case "ease-in-circ":
      return 1 - Math.sqrt(1 - Math.pow(c, 2));
    case "ease-out-circ":
      return Math.sqrt(1 - Math.pow(c - 1, 2));
    case "ease-in-out-circ":
      return c < 0.5
        ? (1 - Math.sqrt(1 - Math.pow(2 * c, 2))) / 2
        : (Math.sqrt(1 - Math.pow(-2 * c + 2, 2)) + 1) / 2;

    case "ease-in-back":
      return BACK_C3 * c * c * c - BACK_C1 * c * c;
    case "ease-out-back":
      return 1 + BACK_C3 * Math.pow(c - 1, 3) + BACK_C1 * Math.pow(c - 1, 2);
    case "ease-in-out-back":
      return c < 0.5
        ? (Math.pow(2 * c, 2) * ((BACK_C2 + 1) * 2 * c - BACK_C2)) / 2
        : (Math.pow(2 * c - 2, 2) * ((BACK_C2 + 1) * (c * 2 - 2) + BACK_C2) + 2) / 2;

    case "ease-in-elastic":
      if (c === 0) return 0;
      if (c === 1) return 1;
      return -Math.pow(2, 10 * c - 10) * Math.sin((c * 10 - 10.75) * ELASTIC_C4);
    case "ease-out-elastic":
      if (c === 0) return 0;
      if (c === 1) return 1;
      return Math.pow(2, -10 * c) * Math.sin((c * 10 - 0.75) * ELASTIC_C4) + 1;
    case "ease-in-out-elastic":
      if (c === 0) return 0;
      if (c === 1) return 1;
      return c < 0.5
        ? -(Math.pow(2, 20 * c - 10) * Math.sin((20 * c - 11.125) * ELASTIC_C5)) / 2
        : (Math.pow(2, -20 * c + 10) * Math.sin((20 * c - 11.125) * ELASTIC_C5)) / 2 + 1;

    case "ease-in-bounce":
      return 1 - bounceOut(1 - c);
    case "ease-out-bounce":
      return bounceOut(c);
    case "ease-in-out-bounce":
      return c < 0.5 ? (1 - bounceOut(1 - 2 * c)) / 2 : (1 + bounceOut(2 * c - 1)) / 2;

    default:
      return undefined;
  }
}

function bounceOut(t: number): number {
  if (t < 1 / BOUNCE_D1) return BOUNCE_N1 * t * t;
  if (t < 2 / BOUNCE_D1) {
    const shifted = t - 1.5 / BOUNCE_D1;
    return BOUNCE_N1 * shifted * shifted + 0.75;
  }
  if (t < 2.5 / BOUNCE_D1) {
    const shifted = t - 2.25 / BOUNCE_D1;
    return BOUNCE_N1 * shifted * shifted + 0.9375;
  }
  const shifted = t - 2.625 / BOUNCE_D1;
  return BOUNCE_N1 * shifted * shifted + 0.984375;
}

// --- diagnostics ------------------------------------------------------------

/**
 * A fault the evaluator found while sampling.
 *
 * Reported through a sink rather than thrown or logged: this package has no dependencies and
 * runs in a browser, an installer-bundled service and a test alike, so it cannot know what a
 * diagnostics log is. The Editor and the control service install a listener that forwards to
 * their own console; a host that installs none loses nothing but the message.
 */
export interface AnimationDiagnostic {
  code: "animation.unknown-easing";
  message: string;
  /** The offending value, verbatim, so the report can name what was written. */
  value: string;
  frame: number;
  objectId?: string;
  property?: string;
}

const animationDiagnosticListeners = new Set<(diagnostic: AnimationDiagnostic) => void>();

export function onAnimationDiagnostic(listener: (diagnostic: AnimationDiagnostic) => void): () => void {
  animationDiagnosticListeners.add(listener);
  return () => animationDiagnosticListeners.delete(listener);
}

/**
 * Faults already reported, so a per-frame sampler cannot flood the console.
 *
 * The evaluator runs this property every time the scene is sampled — fifty times a second
 * during playback. One real fault would then push hundreds of identical records a second and
 * push everything else out of a bounded console, which turns a useful report into a denial of
 * service against itself. A fault is therefore reported once per object, property and offending
 * value; `resetAnimationDiagnostics` clears the memo when a host loads a different scene.
 */
const reportedAnimationFaults = new Set<string>();

export function resetAnimationDiagnostics(): void {
  reportedAnimationFaults.clear();
}

/**
 * Report a fault once, never throwing.
 *
 * A listener that throws — or one that is slow — must not be able to stop a scene evaluating.
 * The caller has already decided what to render.
 */
export function reportAnimationDiagnostic(diagnostic: AnimationDiagnostic): void {
  const fault = `${diagnostic.code}|${diagnostic.objectId ?? ""}|${diagnostic.property ?? ""}|${diagnostic.value}`;
  if (reportedAnimationFaults.has(fault)) return;
  reportedAnimationFaults.add(fault);

  for (const listener of animationDiagnosticListeners) {
    try {
      listener(diagnostic);
    } catch {
      // A diagnostic that fails to deliver must not become the fault it was reporting.
    }
  }
}
