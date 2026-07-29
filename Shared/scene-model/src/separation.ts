/**
 * State separation.
 *
 * `SceneDocument` is the single source of truth for scene *content*, and
 * requirement 12 says what must therefore stay out of it: PixiJS display
 * objects, React components, DOM elements, wgpu resources, and any other native
 * renderer handle.
 *
 * That rule is easy to state and easy to violate by accident — one `ref` stashed
 * on an object during a drag and the document stops being serialisable. So this
 * module both *declares* the separation and *checks* it, and the check runs
 * before publishing rather than after something fails to serialise on the wire.
 */

import type { SceneDocument } from "@grapix/shared-types";

/** Which layer owns a piece of state. Each is persisted separately. */
export const STATE_DOMAINS = [
  /** Project-wide settings: colour management, defaults, paths. */
  "project",
  /** Stage: logical canvas, surfaces, viewports, outputs. */
  "stage",
  /** Scene content: objects, materials, assets, timeline. */
  "scene",
  /** Editor-only: selection, tool, zoom, guides, panel layout. */
  "editor",
  /** Operator-only: which page is cued, operator data entry. */
  "operator",
  /** Playout: rundown position, on-air state, timecode. */
  "playout",
  /** Asset lifecycle: cache paths, decode state, GPU residency. */
  "asset",
  /** Animation runtime: current frame, transition state, markers. */
  "animation"
] as const;

export type StateDomain = (typeof STATE_DOMAINS)[number];

/** Where each domain lives, so nothing is stored twice. */
export const STATE_DOMAIN_OWNERS: Readonly<Record<StateDomain, string>> = Object.freeze({
  project: "project service (services/api-server)",
  stage: "StageDocument (@grapix/stage-model)",
  scene: "SceneDocument (@grapix/shared-types)",
  editor: "editor stores (apps/editor-web), never persisted into a scene",
  operator: "playout control service",
  playout: "playout control service",
  asset: "asset manager and the engine's asset cache",
  animation: "engine scene runtime, derived from scene + frame"
});

export type SceneSeparationIssueSeverity = "error" | "warning";

export interface SceneSeparationIssue {
  severity: SceneSeparationIssueSeverity;
  code: string;
  /** Path within the document where the problem was found. */
  path: string;
  message: string;
}

export interface SceneSeparationReport {
  clean: boolean;
  issues: SceneSeparationIssue[];
  /** Nodes inspected, so a truncated walk is visible rather than silent. */
  inspectedNodes: number;
  truncated: boolean;
}

const MAX_INSPECTED_NODES = 200_000;

/**
 * Detect renderer objects, functions, and cycles inside a scene document.
 *
 * Errors are things that cannot cross a process boundary at all. Warnings are
 * things that *can* serialise but should not be in a scene — editor chrome, for
 * instance, which the renderer must ignore.
 */
export function checkSceneSeparation(scene: SceneDocument): SceneSeparationReport {
  const issues: SceneSeparationIssue[] = [];
  const seen = new WeakSet<object>();
  let inspectedNodes = 0;
  let truncated = false;

  const walk = (value: unknown, path: string): void => {
    if (truncated) return;

    inspectedNodes += 1;
    if (inspectedNodes > MAX_INSPECTED_NODES) {
      truncated = true;
      issues.push({
        severity: "warning",
        code: "WALK_TRUNCATED",
        path,
        message: `stopped after ${MAX_INSPECTED_NODES} nodes; document is unusually large`
      });
      return;
    }

    if (value === null || value === undefined) return;

    const type = typeof value;

    if (type === "function") {
      issues.push({
        severity: "error",
        code: "FUNCTION_IN_SCENE",
        path,
        message: "functions cannot be serialised and must not live in a SceneDocument"
      });
      return;
    }

    if (type === "symbol" || type === "bigint") {
      issues.push({
        severity: "error",
        code: "UNSERIALISABLE_PRIMITIVE",
        path,
        message: `${type} values cannot be sent to the render engine`
      });
      return;
    }

    if (type === "number" && !Number.isFinite(value as number)) {
      issues.push({
        severity: "error",
        code: "NON_FINITE_NUMBER",
        path,
        message: "NaN and Infinity do not survive JSON serialisation"
      });
      return;
    }

    if (type !== "object") return;

    const object = value as object;

    if (seen.has(object)) {
      issues.push({
        severity: "error",
        code: "CYCLIC_REFERENCE",
        path,
        message: "cyclic references cannot be serialised; something holds a back-pointer"
      });
      return;
    }
    seen.add(object);

    const rendererObject = identifyRendererObject(object);
    if (rendererObject) {
      issues.push({
        severity: "error",
        code: "RENDERER_OBJECT_IN_SCENE",
        path,
        message: `${rendererObject} must not be stored in a SceneDocument; use a renderer adapter instead`
      });
      return;
    }

    if (Array.isArray(object)) {
      for (const [index, item] of object.entries()) {
        walk(item, `${path}[${index}]`);
      }
      return;
    }

    for (const [key, item] of Object.entries(object)) {
      walk(item, path ? `${path}.${key}` : key);
    }
  };

  walk(scene, "");

  // Editor chrome is serialisable but is not scene content. It is explicitly
  // documented as ignored by render output, so this stays a warning.
  if (scene.canvas.editorViewport) {
    issues.push({
      severity: "warning",
      code: "EDITOR_STATE_IN_SCENE",
      path: "canvas.editorViewport",
      message:
        "editor viewport chrome is saved with the project; the render engine ignores it and it is stripped before publishing"
    });
  }

  return {
    clean: !issues.some((issue) => issue.severity === "error"),
    issues,
    inspectedNodes,
    truncated
  };
}

/**
 * Recognise a renderer or host object by shape.
 *
 * Structural rather than `instanceof`, because this code also runs in Node where
 * `HTMLElement` and `GPUTexture` are not defined, and because a PixiJS object
 * arriving from a different bundle would fail an identity check anyway.
 */
function identifyRendererObject(value: object): string | undefined {
  const record = value as Record<string, unknown>;

  // DOM
  if (typeof record.nodeType === "number" && typeof record.nodeName === "string") {
    return "a DOM node";
  }
  // React element
  if ("$$typeof" in record) {
    return "a React element";
  }
  // PixiJS display object
  if (
    typeof record.renderPipeId === "string"
    || (record.parent !== undefined && Array.isArray(record.children) && "worldTransform" in record)
  ) {
    return "a PixiJS display object";
  }
  // Three.js object
  if (record.isObject3D === true || record.isBufferGeometry === true || record.isMaterial === true) {
    return "a Three.js object";
  }
  // WebGPU / wgpu handles
  if (
    typeof record.destroy === "function"
    && (record.usage !== undefined || record.mapState !== undefined)
  ) {
    return "a GPU resource handle";
  }
  // Binary payloads. Assets are referenced by URI and hash, never inlined.
  if (
    value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || (typeof Blob !== "undefined" && value instanceof Blob)
  ) {
    return "raw binary data";
  }
  // Anything with a non-plain prototype is a class instance we cannot round-trip.
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== null
    && prototype !== Object.prototype
    && prototype !== Array.prototype
    && !(value instanceof Date)
  ) {
    return `a class instance (${prototype?.constructor?.name ?? "unknown"})`;
  }

  return undefined;
}

/**
 * Strip editor-only state before publishing to an engine.
 *
 * Returns a new document; the input is untouched. This is the boundary where an
 * authoring document becomes a render document.
 */
export function sanitizeSceneForEngine(scene: SceneDocument): {
  scene: SceneDocument;
  removed: string[];
} {
  const removed: string[] = [];
  const canvas = { ...scene.canvas };

  if (canvas.editorViewport) {
    delete canvas.editorViewport;
    removed.push("canvas.editorViewport");
  }

  return { scene: { ...scene, canvas }, removed };
}

/**
 * Does this document survive a JSON round trip byte for byte?
 *
 * The blunt end-to-end check. `checkSceneSeparation` explains *why* something
 * fails; this confirms the document is actually transportable.
 */
export function isSceneTransportable(scene: SceneDocument): boolean {
  try {
    const encoded = JSON.stringify(scene);
    if (encoded === undefined) return false;
    return JSON.stringify(JSON.parse(encoded)) === encoded;
  } catch {
    return false;
  }
}
