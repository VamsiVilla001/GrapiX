import type { SceneObjectType } from "./index.js";

/**
 * Which renderers actually consume which object property — one contract, both languages.
 *
 * This exists because a parity note was **confidently wrong in the operator's favour**. The Object
 * Inspector's shape section stated that both renderers fill non-zero, while the native renderer
 * branches on `evenodd` (`services/render-daemon/src/scene/mesh_prepare.rs:1366`) and the browser
 * Preview never reads `fillRule` at all. A control that lies about what a renderer will do is worse
 * than a control with no explanation, and a claim restated in a panel drifts from the renderer that
 * moved on.
 *
 * So the claim lives here, next to the enums that already work this way — `IMPLEMENTED_BLEND_MODES`,
 * `IMPLEMENTED_TEXTURE_FIT_MODES`, `IMPLEMENTED_MASK_MODES`, `IMPLEMENTED_OBJECT_EFFECTS` — and the
 * panel reads both the verdict *and its wording* from it. Two rules follow, and the Editor's audit
 * test enforces them:
 *
 * 1. A property marked `neither` MUST NOT have an enabled control. Authoring a value no renderer
 *    consumes is the defect rule 82 exists for.
 * 2. A property whose support is not `both` MUST carry its note, so the gap is named where the author
 *    is standing rather than discovered on air.
 *
 * **This table is an exception table, not a census.** An absent entry means "no claim has been made",
 * which the Editor treats as today's behaviour. Every entry below was verified against renderer source
 * by the 2026-08-08 Object Inspector council; the file:line for each is in the comment beside it and in
 * `docs/object-inspector-plan.md`. Add an entry when you verify one — never to record a hope.
 */

export type RendererSupport =
  /** Both the browser Preview and the native Program renderer consume it. */
  | "both"
  /** The browser Preview consumes it; a published scene does not. */
  | "preview"
  /** The native Program renderer consumes it; the browser Preview does not. */
  | "program"
  /** Neither renderer consumes it. It may be stored, but it must not be authorable. */
  | "neither"
  /**
   * Authoring or session state that no renderer is expected to consume — a name, a lock, a colour
   * label. Distinct from `neither`, which is a value that was *meant* to reach the screen and does
   * not. Marking these keeps the audit honest: without the distinction, `locked` would read as a
   * defect.
   */
  | "editor";

export interface PropertySupport {
  support: RendererSupport;
  /**
   * What the Inspector says next to the control. Held here so the verdict and the wording cannot
   * disagree — the exact failure this contract was written for.
   */
  note?: string;
}

/**
 * Object types the native Program renderer prepares.
 *
 * From `services/render-daemon/src/scene/document.rs:435-448`: `mesh`, `light`, `text` and `shape` are
 * prepared by their own passes, `rect` and `ellipse` are prepared here, and **every other type is
 * counted as unsupported**. So no property of an `image`, `line`, `paint`, `camera` or `marker` object
 * reaches a published frame, however well the Preview draws it.
 */
export const PROGRAM_OBJECT_TYPES: readonly SceneObjectType[] = Object.freeze([
  "rect",
  "ellipse",
  "text",
  "shape",
  "mesh",
  "light"
]);

/**
 * Containers, which are never drawn themselves.
 *
 * `resolveSceneObjectHierarchy` folds a container's transform into its descendants before publication,
 * so a group's position genuinely reaches Program — indirectly. They are therefore exempt from the
 * type-level downgrade below, which would otherwise call an inherited transform Preview-only.
 */
export const CONTAINER_OBJECT_TYPES: readonly SceneObjectType[] = Object.freeze(["layer", "group"]);

/** Applies to every object type unless a type-specific entry overrides it. */
const ANY_TYPE: Readonly<Record<string, PropertySupport>> = {
  // `IMPLEMENTED_OBJECT_EFFECTS` is empty: no renderer draws a layer style.
  effects: {
    support: "neither",
    note: "No GrapiX renderer draws layer styles yet, in Preview or on air. The values are kept so an imported design round-trips."
  },
  name: { support: "editor" },
  locked: { support: "editor" }
};


/**
 * The rotation and scale properties, declared unread for a type that has no geometry to turn.
 *
 * A helper rather than fourteen hand-written rows, because the *reason* is one reason: a light is aimed
 * by its target and a camera by its own, and neither has a shape whose axes could be scaled. Written out
 * individually, the fourteenth would eventually disagree with the first.
 */
function UNREAD_ORIENTATION(kind: "light" | "camera"): Readonly<Record<string, PropertySupport>> {
  const note = kind === "light"
    ? "A light is aimed by its target, not turned or scaled. Neither renderer reads this."
    : "A camera is aimed by its target, not turned or scaled. Neither renderer reads this.";
  const entry: PropertySupport = { support: "neither", note };
  return {
    rotation: entry,
    rotationX: entry,
    rotationY: entry,
    rotationZ: entry,
    scaleX: entry,
    scaleY: entry,
    scaleZ: entry
  };
}
const BY_TYPE: Readonly<Partial<Record<SceneObjectType, Readonly<Record<string, PropertySupport>>>>> = {
    text: {
      // `GpuSceneRenderer.ts:965` applies `applyTextCase`; no `text_case` step exists in the native
      // renderer, so a published scene keeps the authored characters.
      textCase: {
        support: "preview",
        note: "Preview applies letter case. The Program renderer has no text-case step, so a published scene shows the characters as typed."
      },
      // `GpuSceneRenderer.ts:965,1037,1050-1053` resolves direction; `document.rs:869-955` prepares no
      // direction field.
      direction: {
        support: "preview",
        note: "Preview resolves writing direction. Program does not, so a right-to-left run publishes in logical order."
      },
      // Preview reads it only on the vertical SVG path (`GpuSceneRenderer.ts:1037`); Program never.
      wordSpacing: {
        support: "preview",
        note: "Preview applies word spacing to vertical text only, and Program does not apply it at all."
      },
      // No consumer in either renderer's text preparation.
      paragraphSpacing: {
        support: "neither",
        note: "Neither renderer applies paragraph spacing yet — the same gap as first-line indent and overflow."
      },
      textIndent: {
        support: "neither",
        note: "Neither renderer applies a first-line indent yet."
      },
      overflow: {
        support: "neither",
        note: "Neither renderer clips overflowing text yet."
      },
      // `GpuSceneRenderer.ts:959-960,1023-1037` distinguishes vertical-rl from vertical-lr;
      // `document.rs:951-955` reduces every non-horizontal mode to one whole-run rotation.
      writingMode: {
        support: "both",
        note: "Both renderers switch between horizontal and vertical, but only Preview distinguishes vertical-rl from vertical-lr."
      },
      verticalAlign: {
        support: "both",
        note: "Honoured by both for horizontal text; vertical runs are aligned by Preview only."
      },
      autoFit: { support: "both" },
      textLayout: { support: "both" }
    },

    shape: {
      // The corrected claim. `mesh_prepare.rs:1366` branches on `evenodd`; Preview never reads the
      // field (`grep -c fillRule GpuSceneRenderer.ts` → 0).
      fillRule: {
        support: "program",
        note: "Program tessellates even-odd fills; Preview ignores the rule and always fills non-zero, so an even-odd shape can differ between Preview and air."
      },
      // `drawShape` builds its path from `path`/`compoundPaths` and reads neither dimension.
      width: {
        support: "neither",
        note: "A shape is drawn from its path. Neither renderer reads its width or height."
      },
      height: {
        support: "neither",
        note: "A shape is drawn from its path. Neither renderer reads its width or height."
      },
      trimStart: { support: "both" },
      trimEnd: { support: "both" },
      trimOffset: { support: "both" }
    },

    line: {
      // `drawLine` consumes `points` and the stroke only.
      width: {
        support: "neither",
        note: "A line is drawn from its points. Neither renderer reads its width or height."
      },
      height: {
        support: "neither",
        note: "A line is drawn from its points. Neither renderer reads its width or height."
      }
    },

    paint: {
      // `drawPaint` iterates strokes, applying colour, opacity × flow, size and pressure only.
      paintBlendMode: {
        support: "neither",
        note: "Preview draws each brush stroke from its own colour and flow, and Program does not draw paint objects at all, so a layer blend mode changes nothing."
      },
      width: {
        support: "neither",
        note: "A paint layer is drawn from its strokes. Neither renderer reads its width or height."
      },
      height: {
        support: "neither",
        note: "A paint layer is drawn from its strokes. Neither renderer reads its width or height."
      }
    },

    mesh: {
      anchor3d: { support: "both" },
      // No imported-clip sampler exists in either renderer.
      timeScale: {
        support: "neither",
        note: "Neither renderer samples imported model animation tracks yet."
      },
      frameOffset: {
        support: "neither",
        note: "Neither renderer samples imported model animation tracks yet."
      },
      animationLoop: {
        support: "neither",
        note: "Neither renderer samples imported model animation tracks yet."
      }
    },

    light: {
      // `ThreeSceneLayer.ts:150-152,430,457,467` enables shadow mapping; no `cast_shadow` consumer was
      // found in the native renderer.
      castShadow: {
        support: "preview",
        note: "Preview casts shadows. Program does not render shadows yet, so a published frame shows none."
      },
      decay: { support: "both" },
      penumbra: { support: "both" },
      /*
       * A light's opacity is not transparency: both renderers multiply its intensity by it
       * (`ThreeSceneLayer.ts:412-413`, `document.rs:1092`), so 0 is off and 0.5 is half power. Declared
       * rather than left to the default, because the Inspector offered no control for it at all — an
       * effective dimmer that could only be reached by editing the file.
       */
      opacity: {
        support: "both",
        note: "A light's opacity scales its intensity in both renderers, so 0 is dark and 0.5 is half power."
      },
      ...UNREAD_ORIENTATION("light"),
    },

    /*
     * A camera is positioned and aimed: `x`, `y`, `zDepth`, `target`, `up`, and the lens properties.
     * Nothing turns or scales it, and it has no pixels of its own to fade. Those seven properties were
     * animatable for every type, so the Timeline offered channels on a camera that draw nothing.
     */
    camera: {
      ...UNREAD_ORIENTATION("camera"),
      opacity: {
        support: "neither",
        note: "A camera has no pixels of its own, so neither renderer reads its opacity. Fade the objects it sees, or the output."
      }
    },

    marker: {
      // The only other `eventName` in the Editor is the Automation panel's own trigger names.
      eventName: {
        support: "neither",
        note: "Nothing subscribes to a marker event name yet — not a renderer, and not scene automation, which names its own triggers."
      }
    }
  };

/**
 * What the renderers do with one property of one object type.
 *
 * Resolution order, and the middle step is the one that earns its keep: a type the native renderer
 * never prepares cannot honour *any* of its properties, so every property of an `image`, `line`,
 * `paint`, `camera` or `marker` is Preview-only unless something more specific is known. That saves
 * writing `preview` thirty times and, more importantly, keeps the claim tied to the one verified fact
 * it follows from.
 *
 * Returns `undefined` when no claim has been made, which the Editor reads as "behave as before".
 */
export function propertyRendererSupport(
  objectType: SceneObjectType,
  property: string
): PropertySupport | undefined {
  const specific = BY_TYPE[objectType]?.[property];
  if (specific) return specific;

  const any = ANY_TYPE[property];
  if (any) return any;

  if (!PROGRAM_OBJECT_TYPES.includes(objectType) && !CONTAINER_OBJECT_TYPES.includes(objectType)) {
    return {
      support: "preview",
      note: `Program does not render ${objectType} objects, so nothing authored here reaches a published frame.`
    };
  }

  return undefined;
}

/** True when a control for this property must not be enabled. */
export function isPropertyAuthorable(objectType: SceneObjectType, property: string): boolean {
  return propertyRendererSupport(objectType, property)?.support !== "neither";
}

/** Every property this contract makes a claim about, for a given type. Used by the Editor's audit. */
export function claimedProperties(objectType: SceneObjectType): string[] {
  return [...new Set([...Object.keys(BY_TYPE[objectType] ?? {}), ...Object.keys(ANY_TYPE)])].sort();
}
