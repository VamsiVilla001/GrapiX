/**
 * Figma prototype interactions → motion timelines.
 *
 * The REST API returns *transitions*, not timelines: "this frame goes to that frame, over this
 * long, with this easing". There are no per-property tracks in it — those only exist inside
 * Figma, which is what the export bridge is for. What can be derived here is nonetheless real
 * motion, because the transition types imply movement GrapiX can express:
 *
 * - **Smart Animate** — the layers of the two frames are matched and their differences *are* the
 *   animation. Diffing them recovers genuine per-property tracks from data the REST API does give.
 * - **Move / Push / Slide** — the destination frame arrives from one edge; the offset is the
 *   frame's own size in the stated direction.
 * - **Dissolve** — the destination fades up.
 * - **Instant** — no motion at all, and reported as such rather than invented.
 *
 * Everything produced here is classified `prototype-transition` (or `smart-animate-converted`)
 * downstream, so the report never claims a designer authored a timeline they did not.
 */
import type {
  DesignImportReport,
  FigmaMotionEasing,
  FigmaMotionNode,
  FigmaMotionTimeline,
  FigmaMotionTrack,
  NormalizedDesignDocument,
  NormalizedDesignNode
} from "@grapix/shared-types";
import { addDesignImportIssue } from "./importReport.js";

/** Properties a Smart Animate diff compares. The first six convert; the rest reach the report. */
const DIFFED_PROPERTIES = [
  "x", "y", "rotation", "scaleX", "scaleY", "opacity",
  "width", "height", "cornerRadius"
] as const;

interface FrameIndex {
  byId: Map<string, NormalizedDesignNode>;
}

/**
 * Every prototype interaction in the document, as motion timelines.
 *
 * Unrecognised transition types are kept with their Figma name rather than mapped to the nearest
 * thing: a type we have never seen is a type whose motion we cannot claim to reproduce, and the
 * report has a state for exactly that.
 */
export function collectPrototypeTimelines(
  document: NormalizedDesignDocument,
  report?: DesignImportReport
): FigmaMotionTimeline[] {
  const index = indexFrames(document);
  const timelines: FigmaMotionTimeline[] = [];

  for (const node of index.byId.values()) {
    for (const interaction of readInteractions(node)) {
      const destination = interaction.destinationId ? index.byId.get(interaction.destinationId) : undefined;

      if (interaction.destinationId && !destination) {
        // The destination is in the file but outside the imported selection. Naming it is the
        // difference between "no motion was found" and "import that frame too".
        if (report) {
          addDesignImportIssue(report, {
            kind: "warning",
            severity: "info",
            message: `${node.name} navigates to a frame that was not imported (${interaction.destinationId}), so its transition has no destination to animate.`,
            sourceNodeId: node.sourceId ?? node.id,
            sourceNodeName: node.name
          });
        }
      }

      const nodes = destination
        ? motionNodesFor(interaction, node, destination)
        : [];

      timelines.push({
        id: `proto_${node.sourceId ?? node.id}_${timelines.length}`,
        name: destination ? `${node.name} → ${destination.name}` : `${node.name} (${interaction.transitionType})`,
        durationMs: interaction.durationMs,
        delayMs: interaction.delayMs,
        trigger: { type: interaction.triggerType, delayMs: interaction.delayMs },
        transition: {
          type: interaction.transitionType,
          durationMs: interaction.durationMs,
          direction: interaction.direction,
          easing: interaction.easing,
          matchLayers: interaction.transitionType === "SMART_ANIMATE"
        },
        sourceFrameId: node.sourceId ?? node.id,
        destinationFrameId: interaction.destinationId,
        sourceVariantId: interaction.sourceVariantId,
        destinationVariantId: interaction.destinationVariantId,
        nodes,
        origin: "rest-prototype"
      });
    }
  }

  return timelines;
}

interface ReadInteraction {
  triggerType: string;
  delayMs?: number;
  transitionType: string;
  durationMs: number;
  direction?: string;
  easing: FigmaMotionEasing;
  destinationId?: string;
  sourceVariantId?: string;
  destinationVariantId?: string;
}

/**
 * A node's interactions, from either shape Figma returns.
 *
 * `interactions` is current. `transitionNodeID`/`transitionDuration`/`transitionEasing` are the
 * older per-node fields, still returned for files authored before the change — and their
 * duration is in **milliseconds** where the modern `transition.duration` is in **seconds**.
 * Getting that wrong makes every legacy prototype import a thousand times too slow.
 */
function readInteractions(node: NormalizedDesignNode): ReadInteraction[] {
  const raw = node.sourceData ?? {};
  const found: ReadInteraction[] = [];

  const interactions = Array.isArray(raw.interactions) ? raw.interactions : [];
  for (const interaction of interactions as Array<Record<string, any>>) {
    const trigger = (interaction?.trigger ?? {}) as Record<string, any>;
    const actions = Array.isArray(interaction?.actions) ? interaction.actions : [];
    for (const action of actions as Array<Record<string, any>>) {
      const transition = (action?.transition ?? {}) as Record<string, any>;
      if (!transition.type && !action?.destinationId) continue;
      found.push({
        triggerType: String(trigger.type ?? "ON_CLICK"),
        delayMs: seconds(trigger.delay),
        transitionType: String(transition.type ?? "INSTANT"),
        durationMs: seconds(transition.duration) ?? 0,
        direction: transition.direction ? String(transition.direction) : undefined,
        easing: readEasing(transition.easing),
        destinationId: action?.destinationId ? String(action.destinationId) : undefined,
        sourceVariantId: node.componentId,
        destinationVariantId: action?.destinationId ? String(action.destinationId) : undefined
      });
    }
  }

  if (!found.length && raw.transitionNodeID) {
    found.push({
      triggerType: "ON_CLICK",
      transitionType: "SMART_ANIMATE",
      // Legacy field, already in milliseconds.
      durationMs: Number.isFinite(Number(raw.transitionDuration)) ? Number(raw.transitionDuration) : 300,
      easing: readEasing(raw.transitionEasing),
      destinationId: String(raw.transitionNodeID)
    });
  }

  return found;
}

/** Figma states transition and delay durations in seconds; the manifest is milliseconds. */
function seconds(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 1000) : undefined;
}

/**
 * Figma easing → the manifest's union.
 *
 * A custom bezier or spring keeps its parameters. A preset keeps its name, and the name is
 * resolved later by `figmaEasingToSceneEasing`, which returns nothing for a curve GrapiX has no
 * equal of — so an unrecognised preset samples instead of silently becoming linear.
 */
function readEasing(value: unknown): FigmaMotionEasing {
  if (typeof value === "string") return { kind: "preset", name: value };
  const easing = (value ?? {}) as Record<string, any>;
  const bezier = easing.easingFunctionCubicBezier;
  if (bezier && ["x1", "y1", "x2", "y2"].every((key) => Number.isFinite(Number(bezier[key])))) {
    return {
      kind: "cubic-bezier",
      points: [Number(bezier.x1), Number(bezier.y1), Number(bezier.x2), Number(bezier.y2)]
    };
  }
  const spring = easing.easingFunctionSpring;
  if (spring && Number.isFinite(Number(spring.stiffness))) {
    return {
      kind: "spring",
      mass: Number(spring.mass) || 1,
      stiffness: Number(spring.stiffness),
      damping: Number(spring.damping) || 10,
      initialVelocity: Number.isFinite(Number(spring.initialVelocity)) ? Number(spring.initialVelocity) : undefined
    };
  }
  if (typeof easing.type === "string") return { kind: "preset", name: easing.type };
  return { kind: "linear" };
}

/** The per-node tracks a transition implies. */
function motionNodesFor(
  interaction: ReadInteraction,
  source: NormalizedDesignNode,
  destination: NormalizedDesignNode
): FigmaMotionNode[] {
  const duration = interaction.durationMs;
  const easing = interaction.easing;
  const destinationId = destination.sourceId ?? destination.id;

  switch (interaction.transitionType) {
    case "SMART_ANIMATE":
    case "SCROLL_ANIMATE":
      return smartAnimateNodes(source, destination, duration, easing);

    case "DISSOLVE":
      return [{
        nodeId: destinationId,
        name: destination.name,
        tracks: [track("opacity", [
          { timeMs: 0, value: 0, easing },
          { timeMs: duration, value: destination.opacity ?? 1 }
        ])]
      }];

    case "MOVE_IN":
    case "SLIDE_IN":
      return [{ nodeId: destinationId, name: destination.name, tracks: [entranceTrack(destination, interaction, "in")] }];

    case "MOVE_OUT":
    case "SLIDE_OUT":
      return [{
        nodeId: source.sourceId ?? source.id,
        name: source.name,
        tracks: [entranceTrack(source, interaction, "out")]
      }];

    // Both frames move: the outgoing one is pushed off as the incoming one arrives.
    case "PUSH":
      return [
        { nodeId: destinationId, name: destination.name, tracks: [entranceTrack(destination, interaction, "in")] },
        { nodeId: source.sourceId ?? source.id, name: source.name, tracks: [entranceTrack(source, interaction, "out")] }
      ];

    // No motion to author. The timeline still exists so the navigation appears in the report.
    case "INSTANT":
    default:
      return [];
  }
}

/**
 * A frame arriving from, or leaving towards, one edge.
 *
 * The travel distance is the frame's own size along the axis, which is what "off screen" means
 * for a prototype whose viewport is the frame.
 */
function entranceTrack(
  frame: NormalizedDesignNode,
  interaction: ReadInteraction,
  direction: "in" | "out"
): FigmaMotionTrack {
  const horizontal = interaction.direction === "LEFT" || interaction.direction === "RIGHT";
  const property = horizontal ? "x" : "y";
  const extent = horizontal ? frame.width : frame.height;
  const sign = interaction.direction === "RIGHT" || interaction.direction === "BOTTOM" ? -1 : 1;
  const settled = horizontal ? frame.x : frame.y;
  const offset = settled + sign * extent * (direction === "in" ? 1 : -1);

  return track(property, direction === "in"
    ? [{ timeMs: 0, value: offset, easing: interaction.easing }, { timeMs: interaction.durationMs, value: settled }]
    : [{ timeMs: 0, value: settled, easing: interaction.easing }, { timeMs: interaction.durationMs, value: offset }]);
}

/**
 * Smart Animate: the difference between two frames *is* the animation.
 *
 * Layers are matched the way Figma matches them — by name, within the same position in the
 * hierarchy — and every property that differs becomes a two-key track on the **destination**
 * node, because that is the object the scene will hold once both frames are imported.
 *
 * Width, height and corner radius are diffed too, even though nothing can be authored from
 * them. They flow through as tracks so the compatibility report can name them; dropping them
 * here would be the silent removal the whole feature exists to avoid.
 */
export function smartAnimateNodes(
  source: NormalizedDesignNode,
  destination: NormalizedDesignNode,
  durationMs: number,
  easing: FigmaMotionEasing
): FigmaMotionNode[] {
  const sourceByPath = new Map<string, NormalizedDesignNode>();
  collectByPath(source, "", sourceByPath);
  const destinationByPath = new Map<string, NormalizedDesignNode>();
  collectByPath(destination, "", destinationByPath);

  const nodes: FigmaMotionNode[] = [];

  for (const [path, destinationNode] of destinationByPath) {
    const sourceNode = sourceByPath.get(path);
    if (!sourceNode) continue;

    const tracks: FigmaMotionTrack[] = [];
    for (const property of DIFFED_PROPERTIES) {
      const from = readProperty(sourceNode, property);
      const to = readProperty(destinationNode, property);
      if (from === undefined || to === undefined) continue;
      if (Math.abs(from - to) < 1e-6) continue;
      tracks.push(track(property, [
        { timeMs: 0, value: from, easing },
        { timeMs: durationMs, value: to }
      ]));
    }

    // A fill change is motion an author will look for, and GrapiX cannot animate paint. It
    // travels as a track so the report says so rather than the import looking incomplete.
    if (JSON.stringify(sourceNode.fills) !== JSON.stringify(destinationNode.fills)) {
      tracks.push({
        property: "fill",
        keyframes: [
          { timeMs: 0, value: sourceNode.fills as unknown as unknown[] },
          { timeMs: durationMs, value: destinationNode.fills as unknown as unknown[] }
        ]
      });
    }

    if (tracks.length) {
      nodes.push({ nodeId: destinationNode.sourceId ?? destinationNode.id, name: destinationNode.name, tracks });
    }
  }

  return nodes;
}

function readProperty(node: NormalizedDesignNode, property: (typeof DIFFED_PROPERTIES)[number]): number | undefined {
  const value = (node as unknown as Record<string, unknown>)[property];
  return typeof value === "number" ? value : undefined;
}

/**
 * Index a subtree by name path.
 *
 * Figma matches Smart Animate layers by name, and a bare name is ambiguous across branches — two
 * groups can each hold a "Title". The path disambiguates without needing ids, which change
 * between a component and its instances.
 */
function collectByPath(node: NormalizedDesignNode, prefix: string, into: Map<string, NormalizedDesignNode>): void {
  for (const child of node.children) {
    const path = `${prefix}/${child.name}`;
    // First writer wins on a duplicate name, matching the document order an author sees.
    if (!into.has(path)) into.set(path, child);
    collectByPath(child, path, into);
  }
}

function track(property: string, keyframes: FigmaMotionTrack["keyframes"]): FigmaMotionTrack {
  return { property, keyframes };
}

function indexFrames(document: NormalizedDesignDocument): FrameIndex {
  const byId = new Map<string, NormalizedDesignNode>();
  const walk = (nodes: NormalizedDesignNode[]): void => {
    for (const node of nodes) {
      byId.set(node.sourceId ?? node.id, node);
      walk(node.children);
    }
  };
  document.pages.forEach((page) => walk(page.nodes));
  return { byId };
}
