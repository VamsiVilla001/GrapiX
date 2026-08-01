/**
 * Reads the repository's own writing into a document corpus.
 *
 * This is deliberately read-from-source rather than a bundled snapshot. A
 * checked-in copy of `docs/architecture.md` would be wrong the first time
 * someone edited the original, and an agent that cites a stale invariant is
 * worse than one that cites none. Everything here is loaded from the working
 * tree and re-read when its mtime moves.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Authority rank, mirroring `docs/README.md`. Lower wins when two documents
 * disagree, and search results are ordered by it so the canonical answer is
 * read first.
 */
export const AUTHORITY_ORDER: Record<string, number> = {
  "docs/architecture.md": 1,
  "docs/local-v1-system-design.md": 2,
  "docs/editor-playout-workspace.md": 3
};

export type DocumentCategory =
  | "architecture"
  | "detail"
  | "ledger"
  | "readme"
  | "session-rules"
  | "contract";

export interface KnowledgeDocument {
  /** Stable slug used in `grapix://doc/{id}`. */
  id: string;
  /** Repository-relative path, POSIX separators. */
  relativePath: string;
  title: string;
  category: DocumentCategory;
  /** 1 is canonical; higher numbers are subordinate. */
  authority: number;
  text: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface SourceSpec {
  relativePath: string;
  category: DocumentCategory;
  title?: string;
}

/** Files outside `docs/` that are still part of the application's knowledge. */
const EXTRA_SOURCES: SourceSpec[] = [
  { relativePath: "README.md", category: "readme", title: "GrapiX repository overview" },
  { relativePath: "Editor/README.md", category: "readme", title: "Editor product overview" },
  { relativePath: "Playout/README.md", category: "readme", title: "Playout product overview" },
  { relativePath: "Shared/README.md", category: "readme", title: "Shared contract packages" },
  { relativePath: "memory.md", category: "session-rules", title: "Durable project handoff and rules" }
];

/** Contract sources whose public surface is worth exposing verbatim. */
const CONTRACT_SOURCES: SourceSpec[] = [
  { relativePath: "Shared/shared-types/src/index.ts", category: "contract", title: "Scene, material, font and automation types" },
  { relativePath: "Shared/shared-types/src/project.ts", category: "contract", title: "Project settings, resolutions and colour spaces" },
  { relativePath: "Shared/shared-types/src/designImport.ts", category: "contract", title: "Design-import contracts" },
  { relativePath: "Shared/scene-model/src/patch.ts", category: "contract", title: "Scene patches" },
  { relativePath: "Shared/scene-model/src/revision.ts", category: "contract", title: "Scene revision ingestion" },
  { relativePath: "Shared/scene-model/src/separation.ts", category: "contract", title: "Scene state separation rules" },
  { relativePath: "Shared/grapix-sdk/src/index.ts", category: "contract", title: "Sequencing, triggers and the scene-script SDK" },
  { relativePath: "Shared/render-protocol/src/messages.ts", category: "contract", title: "Render protocol v3 messages" },
  { relativePath: "Shared/render-protocol/src/capabilities.ts", category: "contract", title: "Render protocol capabilities" },
  { relativePath: "Shared/output-contracts/src/index.ts", category: "contract", title: "Output contracts" },
  { relativePath: "Shared/stage-model/src/index.ts", category: "contract", title: "Stage model" },
  { relativePath: "Shared/surface-model/src/index.ts", category: "contract", title: "Surface model" },
  { relativePath: "Shared/animation-engine/src/clock.ts", category: "contract", title: "Rational frame clock" }
];

function slugFor(relativePath: string): string {
  return relativePath
    .replace(/\.[^./]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** First markdown heading, or a humanised filename when the file has none. */
function titleFor(relativePath: string, text: string, fallback?: string): string {
  if (fallback) return fallback;
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(relativePath).replace(/\.[^./]+$/, "");
}

function categorise(relativePath: string): DocumentCategory {
  if (AUTHORITY_ORDER[relativePath]) return "architecture";
  if (relativePath === "docs/architecture-review-compliance.md" || relativePath === "docs/project-memory.md") {
    return "ledger";
  }
  return "detail";
}

function authorityFor(relativePath: string, category: DocumentCategory): number {
  const explicit = AUTHORITY_ORDER[relativePath];
  if (explicit) return explicit;
  switch (category) {
    case "session-rules":
      return 4;
    case "detail":
      return 5;
    case "contract":
      return 6;
    case "readme":
      return 7;
    default:
      return 8;
  }
}

async function loadDocument(
  repositoryRoot: string,
  spec: SourceSpec
): Promise<KnowledgeDocument | undefined> {
  const absolute = path.join(repositoryRoot, spec.relativePath);
  let text: string;
  let stats: Awaited<ReturnType<typeof stat>>;

  try {
    [text, stats] = await Promise.all([readFile(absolute, "utf8"), stat(absolute)]);
  } catch {
    // A missing optional source is normal: `Playout/README.md` predates nothing
    // and a shallow checkout may omit it. Silently skipping keeps the corpus
    // usable rather than failing the whole server over one absent file.
    return undefined;
  }

  return {
    id: slugFor(spec.relativePath),
    relativePath: spec.relativePath,
    title: titleFor(spec.relativePath, text, spec.title),
    category: spec.category,
    authority: authorityFor(spec.relativePath, spec.category),
    text,
    sizeBytes: stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString()
  };
}

export async function loadCorpus(repositoryRoot: string): Promise<KnowledgeDocument[]> {
  const docsDirectory = path.join(repositoryRoot, "docs");
  let docFiles: string[] = [];
  try {
    docFiles = (await readdir(docsDirectory)).filter((file) => file.endsWith(".md"));
  } catch {
    docFiles = [];
  }

  const specs: SourceSpec[] = [
    ...docFiles.map((file) => {
      const relativePath = `docs/${file}`;
      return { relativePath, category: categorise(relativePath) };
    }),
    ...EXTRA_SOURCES,
    ...CONTRACT_SOURCES
  ];

  const documents = await Promise.all(specs.map((spec) => loadDocument(repositoryRoot, spec)));

  return documents
    .filter((document): document is KnowledgeDocument => document !== undefined)
    .sort((left, right) => left.authority - right.authority || left.relativePath.localeCompare(right.relativePath));
}

/**
 * Newest mtime across the corpus sources, used to decide whether a cached
 * corpus is still current without re-reading every file's contents.
 */
export async function corpusFingerprint(repositoryRoot: string): Promise<string> {
  const docsDirectory = path.join(repositoryRoot, "docs");
  const candidates: string[] = [
    path.join(repositoryRoot, "memory.md"),
    path.join(repositoryRoot, "README.md"),
    ...CONTRACT_SOURCES.map((spec) => path.join(repositoryRoot, spec.relativePath))
  ];

  try {
    for (const file of await readdir(docsDirectory)) {
      if (file.endsWith(".md")) candidates.push(path.join(docsDirectory, file));
    }
  } catch {
    // No docs directory: the fingerprint is still valid over what remains.
  }

  const stamps = await Promise.all(
    candidates.map(async (file) => {
      try {
        const stats = await stat(file);
        return `${path.basename(file)}:${stats.mtimeMs}:${stats.size}`;
      } catch {
        return "";
      }
    })
  );

  return stamps.filter(Boolean).join("|");
}
