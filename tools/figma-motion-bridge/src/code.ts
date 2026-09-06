/**
 * GrapiX Motion Bridge — the Figma half of the motion import.
 *
 * The REST API cannot see a Motion timeline. It returns prototype *interactions* — two frames are
 * related and take 300 ms — and never a layer's per-property tracks, because those live only in
 * the document model, on `node.animations`. This plugin is the only place that data can be read,
 * so it reads it and writes `grapix-figma-motion.json` for the Editor's import dialog.
 *
 * The plugin deliberately does almost nothing itself: it walks the document, hands nodes to
 * `buildMotionManifest` from `@grapix/shared-types`, and lets the UI download the result. Every
 * decision worth testing — units, axis splitting, easing, what is unsupported — lives in that
 * shared converter, where a test suite can reach it. Nothing in a Figma plugin can be unit-tested
 * outside Figma, so nothing that matters should live here.
 *
 * `networkAccess` is `none` in the manifest: an author's unreleased design never leaves their
 * machine, and a motion export cannot become an exfiltration path.
 */
import {
  buildMotionManifest,
  type FigmaBridgeFrameInput,
  type FigmaBridgeNodeInput
} from "@grapix/shared-types";

/**
 * The Motion members this plugin reads.
 *
 * `animations` and `timelines` are beta and absent from the published typings, so they are
 * declared here rather than cast away at each use — a compile error when Figma renames one is
 * worth more than a silent `any`.
 */
interface MotionCapableNode extends SceneNode {
  animations?: Record<string, { timelineDuration?: number; tracks?: unknown[] } | undefined>;
  timelines?: readonly { id: string; duration?: number; name?: string }[];
}

interface ExportableFrame {
  id: string;
  name: string;
  type: string;
  pageName: string;
  /** Shown in the picker so an author can see which frames carry motion before exporting. */
  animatedNodeCount: number;
}

figma.showUI(__html__, { width: 380, height: 520, themeColors: true });

/**
 * Candidate frames, across every page.
 *
 * All pages rather than the current one: a broadcast file keeps its lower thirds on one page and
 * its bugs on another, and an export that silently covered only the page that happened to be open
 * would look like a plugin that lost half the motion.
 */
async function collectFrames(): Promise<{ frames: ExportableFrame[]; nodes: Map<string, FigmaBridgeFrameInput> }> {
  await figma.loadAllPagesAsync();

  const frames: ExportableFrame[] = [];
  const nodes = new Map<string, FigmaBridgeFrameInput>();

  for (const page of figma.root.children) {
    for (const child of page.children) {
      if (child.type !== "FRAME" && child.type !== "COMPONENT" && child.type !== "COMPONENT_SET") continue;

      const animated = collectAnimatedNodes(child);
      frames.push({
        id: child.id,
        name: child.name,
        type: child.type,
        pageName: page.name,
        animatedNodeCount: animated.length
      });
      nodes.set(child.id, { id: child.id, name: child.name, type: child.type, nodes: animated });
    }
  }

  return { frames, nodes };
}

/**
 * A frame and every descendant that animates.
 *
 * The frame itself is included: a Motion track on the frame is how a whole lower third slides on,
 * and it is the node the imported scene's root object corresponds to.
 *
 * Nodes with no `animations` are dropped here rather than passed on, so a 400-layer frame does not
 * cross the bridge as 400 empty entries — the manifest's `missingNodes` report is about layers the
 * *import* could not match, and padding it with layers that never moved would bury the real ones.
 */
function collectAnimatedNodes(root: SceneNode): FigmaBridgeNodeInput[] {
  const collected: FigmaBridgeNodeInput[] = [];

  const visit = (node: SceneNode) => {
    const motion = node as MotionCapableNode;
    const animations = motion.animations;
    if (animations && Object.keys(animations).length > 0) {
      collected.push({
        id: node.id,
        name: node.name,
        // Cast at the boundary: the structural input type in shared-types is the contract, and
        // the beta API's own typings do not exist to check against.
        animations: animations as FigmaBridgeNodeInput["animations"],
        timelines: motion.timelines
      });
    }
    // Recursion is driven by `children` with no type filter and no depth limit: a container that
    // does not animate can still hold a layer that does.
    if ("children" in node) for (const child of node.children) visit(child as SceneNode);
  };

  visit(root);
  return collected;
}

async function respondWithFrames() {
  const { frames } = await collectFrames();
  figma.ui.postMessage({ type: "frames", frames, fileName: figma.root.name });
}

async function respondWithExport(selectedIds: string[]) {
  const { nodes } = await collectFrames();
  const chosen = selectedIds
    .map((id) => nodes.get(id))
    .filter((frame): frame is FigmaBridgeFrameInput => Boolean(frame));

  if (!chosen.length) {
    figma.ui.postMessage({ type: "error", message: "Select at least one frame to export." });
    return;
  }

  const manifest = buildMotionManifest(chosen, {
    generator: `grapix-figma-motion-bridge/${GENERATOR_VERSION}`,
    fileKey: figma.fileKey,
    fileName: figma.root.name,
    exportedAt: new Date().toISOString()
  });

  figma.ui.postMessage({
    type: "manifest",
    // Pretty-printed: an author who wants to see what left their document should be able to read
    // it, and the file is small enough that the bytes do not matter.
    json: JSON.stringify(manifest, null, 2),
    summary: {
      timelines: manifest.timelines.length,
      nodes: manifest.timelines.reduce((total, timeline) => total + timeline.nodes.length, 0),
      tracks: manifest.timelines.reduce(
        (total, timeline) => total + timeline.nodes.reduce((count, node) => count + node.tracks.length, 0),
        0
      )
    }
  });
}

/**
 * Stamped into `generator` so a manifest from a mismatched build is identifiable.
 *
 * Bumped by hand when the conversion changes shape, which is the point: the importer can then say
 * "this file came from an older bridge" instead of failing on a field that moved.
 */
const GENERATOR_VERSION = "1.0.0";

figma.ui.onmessage = async (message: { type: string; frameIds?: string[] }) => {
  try {
    if (message.type === "request-frames") await respondWithFrames();
    else if (message.type === "export") await respondWithExport(message.frameIds ?? []);
    else if (message.type === "close") figma.closePlugin();
  } catch (error) {
    // A thrown error in a plugin closes nothing and shows nothing, so the UI has to be told.
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "The motion export failed."
    });
  }
};

void respondWithFrames();
