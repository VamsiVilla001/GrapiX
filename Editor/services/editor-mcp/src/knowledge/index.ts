/**
 * The knowledge base: everything this server knows about GrapiX, assembled from
 * the repository at load time and refreshed when the sources move.
 *
 * The point of ingesting all of it is that the failure mode of an AI editing a
 * broadcast graphics application is not "cannot find the API" — it is authoring
 * something that validates, saves, and then renders differently on air, or
 * reaching for a verb the Editor is architecturally forbidden to have. Both are
 * documented in this repository. Loading the architecture, the contracts, the
 * capability map and the accumulated session rules is what lets an agent read
 * that before it writes.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { corpusFingerprint, loadCorpus, type KnowledgeDocument } from "./corpus.js";
import {
  buildCapabilityMap,
  capabilityLists,
  renderCapabilityList,
  type CapabilityMap
} from "./capabilities.js";
import { SearchIndex, sectionsFor, type SearchHit, type Section } from "./search.js";

export type { KnowledgeDocument } from "./corpus.js";
export type { CapabilityMap, CapabilityList } from "./capabilities.js";
export type { SearchHit, Section } from "./search.js";

export interface AuthorityBoundary {
  editorMay: string[];
  editorMayNot: string[];
  invariants: string[];
}

export interface KnowledgeSnapshot {
  documents: KnowledgeDocument[];
  capabilities: CapabilityMap;
  index: SearchIndex;
  invariants: string[];
  sessionRules: string[];
  commands: { name: string; script: string }[];
  fingerprint: string;
}

/**
 * The one boundary an agent must not cross. Held as data rather than prose so
 * `describe_authority` and the read-only guard in `server.ts` cannot drift
 * apart, and stated as verbs because that is the form a model acts on.
 */
export const AUTHORITY_BOUNDARY: AuthorityBoundary = {
  editorMay: [
    "create, read and modify authoring scenes, objects, materials, timelines and data contexts",
    "import assets, fonts, 3D models, media, scene scripts and design files",
    "evaluate automation triggers as a dry run, to show an author what a trigger would do",
    "run publish preflight and build a checksum-addressed .gpxpkg scene package"
  ],
  editorMayNot: [
    "Cue, Take, Continue or Clear Program — those belong to Playout alone (invariant 4)",
    "configure or start an output, or touch the Program frame clock (invariants 3 and 4)",
    "replace a published Playout scene in place; publishing creates a new immutable revision (invariant 6)",
    "rasterize production pixels or own GPU state; the Render Engine is the only renderer (invariants 1 and 2)"
  ],
  invariants: []
};

/** Port map from `docs/architecture.md`, including the retired one. */
export const PORT_MAP = [
  { port: 4100, owner: "Editor/services/project-api", note: "the service this MCP server talks to" },
  { port: 4300, owner: "Playout/services/playout-control", note: "stopping it takes Playout off air" },
  { port: "4400-4403", owner: "services/render-engine", note: "protocol v3; the only renderer" },
  { port: "5173 / 5174", owner: "editor-web / playout-web", note: "Vite dev servers" },
  { port: 4200, owner: "retired", note: "the protocol-v2 daemon, deleted 2026-07-29; nothing may bind it" }
];

/** Pulls the numbered invariants out of the canonical architecture document. */
function extractInvariants(architecture: string | undefined): string[] {
  if (!architecture) return [];
  const section = architecture.match(/## Non-negotiable invariants\s*([\s\S]*?)(?=\n## )/);
  if (!section) return [];

  const invariants: string[] = [];
  let current: string | undefined;

  for (const row of section[1].split(/\r?\n/)) {
    const start = row.match(/^\s*(\d+)\.\s+(.*)$/);
    if (start) {
      if (current) invariants.push(current.trim());
      current = `${start[1]}. ${start[2]}`;
      continue;
    }
    if (current && /^\s{3,}\S/.test(row)) current += ` ${row.trim()}`;
    else if (current && row.trim() === "") {
      invariants.push(current.trim());
      current = undefined;
    }
  }
  if (current) invariants.push(current.trim());

  return invariants;
}

/**
 * Pulls the binding "Rules for the next session" out of the root `memory.md`.
 * They are the accumulated record of what already went wrong here, and they are
 * the highest-value thing an agent can read before changing anything.
 */
function extractSessionRules(memory: string | undefined): string[] {
  if (!memory) return [];
  const section = memory.match(/## Rules for the next session\s*([\s\S]*)$/);
  if (!section) return [];

  const rules: string[] = [];
  let current: string | undefined;

  for (const row of section[1].split(/\r?\n/)) {
    const start = row.match(/^\s*(\d+)\.\s+(.*)$/);
    if (start) {
      if (current) rules.push(current.trim());
      current = `${start[1]}. ${start[2]}`;
      continue;
    }
    if (current && row.trim()) current += ` ${row.trim()}`;
  }
  if (current) rules.push(current.trim());

  return rules;
}

async function readRootCommands(
  repositoryRoot: string
): Promise<{ name: string; script: string }[]> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    return Object.entries(manifest.scripts ?? {}).map(([name, script]) => ({ name, script }));
  } catch {
    return [];
  }
}

export class KnowledgeBase {
  private snapshot?: KnowledgeSnapshot;
  private loading?: Promise<KnowledgeSnapshot>;

  constructor(private readonly repositoryRoot: string) {}

  /** Loads once, then re-reads only when a source file's mtime or size moves. */
  async load(): Promise<KnowledgeSnapshot> {
    const fingerprint = await corpusFingerprint(this.repositoryRoot);
    if (this.snapshot && this.snapshot.fingerprint === fingerprint) return this.snapshot;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const [documents, capabilities, commands] = await Promise.all([
        loadCorpus(this.repositoryRoot),
        buildCapabilityMap(this.repositoryRoot),
        readRootCommands(this.repositoryRoot)
      ]);

      const architecture = documents.find((document) => document.relativePath === "docs/architecture.md");
      const memory = documents.find((document) => document.relativePath === "memory.md");
      const invariants = extractInvariants(architecture?.text);

      const snapshot: KnowledgeSnapshot = {
        documents,
        capabilities,
        index: new SearchIndex(documents),
        invariants,
        sessionRules: extractSessionRules(memory?.text),
        commands,
        fingerprint
      };

      AUTHORITY_BOUNDARY.invariants = invariants;
      this.snapshot = snapshot;
      this.loading = undefined;
      return snapshot;
    })();

    return this.loading;
  }

  async documents(): Promise<KnowledgeDocument[]> {
    return (await this.load()).documents;
  }

  async document(id: string): Promise<KnowledgeDocument | undefined> {
    const { documents } = await this.load();
    return documents.find(
      (document) => document.id === id || document.relativePath === id
    );
  }

  async capabilities(): Promise<CapabilityMap> {
    return (await this.load()).capabilities;
  }

  async search(query: string, limit: number, documentIds?: string[]): Promise<SearchHit[]> {
    const { index } = await this.load();
    return index.search(query, limit, documentIds);
  }

  async sections(documentId: string): Promise<Section[]> {
    const document = await this.document(documentId);
    return document ? sectionsFor(document) : [];
  }

  async invariants(): Promise<string[]> {
    return (await this.load()).invariants;
  }

  async sessionRules(): Promise<string[]> {
    return (await this.load()).sessionRules;
  }

  async commands(): Promise<{ name: string; script: string }[]> {
    return (await this.load()).commands;
  }

  /**
   * The orientation document. Everything an agent needs before its first edit,
   * in one read: the product split, the invariants it cannot violate, what this
   * server may and may not do, the capability map with its unimplemented
   * values called out, and where to read further.
   */
  async primer(): Promise<string> {
    const snapshot = await this.load();
    const rows: string[] = [];

    rows.push("# GrapiX — orientation for an AI assistant", "");
    rows.push(
      "GrapiX is a broadcast graphics platform built as three products, in the same relationship",
      "as Viz Artist / Trio / Engine or Ross XPression Designer / Sequencer / Engine:",
      "",
      "| Product | Owns |",
      "| --- | --- |",
      "| **Editor** | Authoring: scenes, materials, assets, fonts, animation, data bindings, validation and durable Publish to Playout. No Program or output authority. |",
      "| **Playout** | Operations: the published scene library, take lists, timecode, automation, Preview/Program control and output configuration. |",
      "| **Render Engine** | Rendering: the only implementation that rasterizes production scene pixels. Owns all GPU state, the rational frame clock, Program and the outputs. |",
      "",
      "`Shared/` holds the contracts all three consume. It is not a fourth product and may not",
      "depend on Editor or Playout.",
      ""
    );

    rows.push("## This MCP server is the Editor, and only the Editor", "");
    rows.push("It may:");
    for (const entry of AUTHORITY_BOUNDARY.editorMay) rows.push(`- ${entry}`);
    rows.push("", "It may not, and no tool here exposes:");
    for (const entry of AUTHORITY_BOUNDARY.editorMayNot) rows.push(`- ${entry}`);
    rows.push(
      "",
      "This is not a UI convention. The render engine authenticates a client's role and rejects",
      "Program and output commands from an Editor role server-side, so asking for one fails at",
      "the engine even if something here offered it.",
      ""
    );

    if (snapshot.invariants.length) {
      rows.push("## Non-negotiable invariants", "");
      for (const invariant of snapshot.invariants) rows.push(`${invariant}`);
      rows.push("");
    }

    rows.push("## Local ports", "");
    rows.push("| Port | Owner | Note |", "| --- | --- | --- |");
    for (const entry of PORT_MAP) {
      rows.push(`| ${entry.port} | ${entry.owner} | ${entry.note} |`);
    }
    rows.push("");

    rows.push("## What a scene can contain", "");
    rows.push(
      "Derived from the contracts in `Shared/shared-types`, not from prose. Where a list",
      "distinguishes *declared* from *implemented*, authoring a declared-but-unimplemented value",
      "produces a scene that saves and validates cleanly and then renders as something else.",
      ""
    );
    for (const entry of capabilityLists(snapshot.capabilities)) {
      rows.push(renderCapabilityList(entry));
    }

    rows.push("## Reading further", "");
    rows.push(
      "Authority order — when two documents disagree, the higher one wins:",
      "",
      "1. `docs/architecture.md` — products, invariants, engine host, protocol v3, recovery, gates",
      "2. `docs/local-v1-system-design.md` — the design review and the M1-M4 plan",
      "3. `docs/editor-playout-workspace.md` — repository ownership and the migration phase log",
      "",
      "Then the subject-specific detail documents, and `memory.md` for the accumulated session",
      `rules (${snapshot.sessionRules.length} of them, all binding).`,
      "",
      `Use \`${"grapix_editor_search_knowledge"}\` to search all ${snapshot.documents.length} ingested documents,`,
      "or read one whole via the `grapix://doc/{id}` resource.",
      ""
    );

    return rows.join("\n");
  }
}
