/**
 * Re-import reconciliation.
 *
 * The feature that decides whether the product lives: a designer *will* change the artwork
 * after a rig is built, and the rig has to survive it. See docs/middle-layer-arch.md
 * section 5.3.
 *
 * A re-import is never a replacement. It is a match of the new tree against the old one,
 * producing a reviewable diff. Matching runs in strategy order, strongest first, and each
 * match records which strategy found it so the UI can show what it trusted and what it
 * guessed. Anything unmatched is surfaced, never silently dropped.
 *
 * Figma is the reference case because its node ids are stable across edits. The weaker
 * strategies exist for PSD and Illustrator, which have no stable ids at all.
 */

import { hashString, type DesignIR, type DesignNode, type Paint } from "./index.js";

/** Strongest first. The order here is the matching order. */
export type MatchStrategy =
  | "source-node-id"
  | "node-id"
  | "source-path"
  | "name-and-kind"
  | "content-fingerprint";

/** How much a match can be trusted, for sorting the review UI. */
export const STRATEGY_CONFIDENCE: Record<MatchStrategy, number> = {
  "source-node-id": 1,
  "node-id": 0.98,
  "source-path": 0.8,
  "name-and-kind": 0.6,
  "content-fingerprint": 0.45
};

export type ChangeKind =
  | "unchanged"
  | "moved"
  | "resized"
  | "restyled"
  | "text-changed"
  | "tokens-changed"
  | "retyped"
  | "reparented"
  | "visibility-changed";

export interface MatchedNode {
  previousNodeId: string;
  nodeId: string;
  strategy: MatchStrategy;
  confidence: number;
  previousSourcePath: string;
  sourcePath: string;
  changes: ChangeKind[];
}

export interface UnmatchedNode {
  nodeId: string;
  name: string;
  kind: DesignNode["kind"];
  sourcePath: string;
}

export interface DesignDiff {
  previousDesignId: string;
  nextDesignId: string;
  sourceRef: string;
  previousRevision: string;
  nextRevision: string;
  matched: MatchedNode[];
  /** In the new design, with no counterpart in the old one. */
  added: UnmatchedNode[];
  /**
   * In the old design with no counterpart in the new one. Any rig entry pointing at one of
   * these becomes an orphan and needs the manual re-link UI.
   */
  removed: UnmatchedNode[];
  summary: {
    total: number;
    matched: number;
    added: number;
    removed: number;
    changed: number;
    lowConfidence: number;
    byStrategy: Record<MatchStrategy, number>;
  };
}

interface IndexedNode {
  node: DesignNode;
  parentPath: string;
  ordinal: number;
}

export function reconcileDesigns(previous: DesignIR, next: DesignIR): DesignDiff {
  const previousNodes = indexNodes(previous.root);
  const nextNodes = indexNodes(next.root);

  const remainingPrevious = new Map(previousNodes.map((entry) => [entry.node.nodeId, entry]));
  const remainingNext = new Map(nextNodes.map((entry) => [entry.node.nodeId, entry]));
  const matched: MatchedNode[] = [];

  const strategies: Array<{
    strategy: MatchStrategy;
    key: (entry: IndexedNode) => string | null;
  }> = [
    {
      // Native, edit-stable id. This is why Figma is the reference source.
      strategy: "source-node-id",
      key: (entry) => (entry.node.sourceNodeId ? `sid:${entry.node.sourceNodeId}` : null)
    },
    {
      strategy: "node-id",
      key: (entry) => `nid:${entry.node.nodeId}`
    },
    {
      strategy: "source-path",
      key: (entry) => `path:${entry.node.sourcePath}|${entry.node.kind}`
    },
    {
      strategy: "name-and-kind",
      key: (entry) => `name:${entry.node.name}|${entry.node.kind}`
    },
    {
      strategy: "content-fingerprint",
      key: (entry) => `fp:${contentFingerprint(entry.node)}`
    }
  ];

  for (const { strategy, key } of strategies) {
    // Only unique keys on both sides may match: two layers called "Bar" must not be
    // paired arbitrarily, because a wrong match silently moves someone's rig.
    const previousByKey = uniqueIndex(remainingPrevious.values(), key);
    const nextByKey = uniqueIndex(remainingNext.values(), key);

    for (const [candidateKey, previousEntry] of previousByKey) {
      const nextEntry = nextByKey.get(candidateKey);

      if (!nextEntry) {
        continue;
      }

      matched.push({
        previousNodeId: previousEntry.node.nodeId,
        nodeId: nextEntry.node.nodeId,
        strategy,
        confidence: STRATEGY_CONFIDENCE[strategy],
        previousSourcePath: previousEntry.node.sourcePath,
        sourcePath: nextEntry.node.sourcePath,
        changes: detectChanges(previousEntry, nextEntry)
      });

      remainingPrevious.delete(previousEntry.node.nodeId);
      remainingNext.delete(nextEntry.node.nodeId);
    }
  }

  const byStrategy = Object.fromEntries(
    (Object.keys(STRATEGY_CONFIDENCE) as MatchStrategy[]).map((strategy) => [
      strategy,
      matched.filter((entry) => entry.strategy === strategy).length
    ])
  ) as Record<MatchStrategy, number>;

  return {
    previousDesignId: previous.designId,
    nextDesignId: next.designId,
    sourceRef: next.sourceRef,
    previousRevision: previous.sourceRevision,
    nextRevision: next.sourceRevision,
    matched: matched.sort((a, b) => b.confidence - a.confidence),
    added: [...remainingNext.values()].map(describe),
    removed: [...remainingPrevious.values()].map(describe),
    summary: {
      total: nextNodes.length,
      matched: matched.length,
      added: remainingNext.size,
      removed: remainingPrevious.size,
      changed: matched.filter((entry) => !entry.changes.includes("unchanged")).length,
      lowConfidence: matched.filter((entry) => entry.confidence < 0.8).length,
      byStrategy
    }
  };
}

/**
 * True when the diff needs a human before a rig is carried across it: something the rig
 * may point at disappeared, or a match was only a guess.
 */
export function diffNeedsReview(diff: DesignDiff): boolean {
  return diff.summary.removed > 0 || diff.summary.lowConfidence > 0;
}

function indexNodes(root: DesignNode): IndexedNode[] {
  const entries: IndexedNode[] = [];

  const walk = (node: DesignNode, parentPath: string): void => {
    node.children.forEach((child, ordinal) => {
      entries.push({ node: child, parentPath, ordinal });
      walk(child, node.sourcePath);
    });
  };

  // The synthetic root is an import wrapper, not a design node, so it is not diffed.
  walk(root, root.sourcePath);

  return entries;
}

function uniqueIndex(
  entries: Iterable<IndexedNode>,
  key: (entry: IndexedNode) => string | null
): Map<string, IndexedNode> {
  const seen = new Map<string, IndexedNode>();
  const duplicates = new Set<string>();

  for (const entry of entries) {
    const candidate = key(entry);

    if (!candidate) {
      continue;
    }

    if (seen.has(candidate)) {
      duplicates.add(candidate);
      continue;
    }

    seen.set(candidate, entry);
  }

  for (const duplicate of duplicates) {
    seen.delete(duplicate);
  }

  return seen;
}

function detectChanges(previous: IndexedNode, next: IndexedNode): ChangeKind[] {
  const changes: ChangeKind[] = [];
  const a = previous.node;
  const b = next.node;

  if (a.kind !== b.kind) {
    changes.push("retyped");
  }

  if (previous.parentPath !== next.parentPath) {
    changes.push("reparented");
  }

  if (!closeEnough(a.transform[4], b.transform[4]) || !closeEnough(a.transform[5], b.transform[5])) {
    changes.push("moved");
  }

  if (!closeEnough(a.size.width, b.size.width) || !closeEnough(a.size.height, b.size.height)) {
    changes.push("resized");
  }

  if (a.visible !== b.visible) {
    changes.push("visibility-changed");
  }

  if (paintSignature(a.fills) !== paintSignature(b.fills) || !closeEnough(a.opacity, b.opacity)) {
    changes.push("restyled");
  }

  if ((a.text?.plainText ?? "") !== (b.text?.plainText ?? "")) {
    changes.push("text-changed");
  }

  if (tokenSignature(a) !== tokenSignature(b)) {
    changes.push("tokens-changed");
  }

  return changes.length ? changes : ["unchanged"];
}

/** Design coordinates are floats; sub-tenth-pixel drift is not a change worth reporting. */
function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.1;
}

function paintSignature(paints: Paint[]): string {
  return paints
    .map((paint) => {
      const color = paint.color
        ? `${round(paint.color.r)},${round(paint.color.g)},${round(paint.color.b)},${round(paint.color.a)}`
        : "";
      const stops = (paint.stops ?? [])
        .map((stop) => `${round(stop.position)}:${round(stop.color.r)},${round(stop.color.g)},${round(stop.color.b)}`)
        .join(";");

      return `${paint.kind}|${paint.visible ? 1 : 0}|${round(paint.opacity)}|${color}|${stops}|${paint.assetId ?? ""}`;
    })
    .join("//");
}

function tokenSignature(node: DesignNode): string {
  return node.tokens
    .map((token) => `${token.kind}:${token.key ?? ""}:${token.value ?? ""}`)
    .sort()
    .join(",");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Identity of last resort: what the node *is*, independent of where it sits or what it is
 * called. Lets a renamed-and-moved but otherwise untouched layer still match.
 */
function contentFingerprint(node: DesignNode): string {
  return hashString(
    [
      node.kind,
      Math.round(node.size.width),
      Math.round(node.size.height),
      paintSignature(node.fills),
      node.text?.plainText ?? "",
      node.geometry?.paths.join("|") ?? "",
      node.children.length
    ].join("~")
  );
}

function describe(entry: IndexedNode): UnmatchedNode {
  return {
    nodeId: entry.node.nodeId,
    name: entry.node.name,
    kind: entry.node.kind,
    sourcePath: entry.node.sourcePath
  };
}
