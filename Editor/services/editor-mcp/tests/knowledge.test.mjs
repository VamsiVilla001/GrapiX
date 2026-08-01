/**
 * Knowledge ingestion.
 *
 * These assert that the server reads the repository rather than a snapshot of
 * it, and that the two facts most likely to stop an agent producing a broken
 * scene survive the pipeline: the architecture invariants, and the gap between
 * a declared enum value and an implemented one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeBase } from "../dist/knowledge/index.js";
import { extractStringUnion } from "../dist/knowledge/capabilities.js";
import { SearchIndex } from "../dist/knowledge/search.js";
import { resolveConfig } from "../dist/config.js";

const { repositoryRoot } = resolveConfig();
const knowledge = new KnowledgeBase(repositoryRoot);

test("the corpus loads the architecture, the contracts and the handoff", async () => {
  const documents = await knowledge.documents();
  const paths = documents.map((document) => document.relativePath);

  assert.ok(paths.includes("docs/architecture.md"), "the canonical architecture is missing");
  assert.ok(paths.includes("memory.md"), "the durable handoff is missing");
  assert.ok(
    paths.includes("Shared/shared-types/src/index.ts"),
    "the scene contract source is missing"
  );
  assert.ok(documents.length >= 20, `expected a full corpus, found ${documents.length}`);
});

test("authority order is preserved, so the canonical document outranks the details", async () => {
  const documents = await knowledge.documents();
  const architecture = documents.find((entry) => entry.relativePath === "docs/architecture.md");
  const detail = documents.find((entry) => entry.relativePath === "docs/material-system.md");

  assert.equal(architecture.authority, 1);
  assert.ok(detail.authority > architecture.authority);
});

test("the non-negotiable invariants are extracted whole", async () => {
  const invariants = await knowledge.invariants();

  assert.ok(invariants.length >= 8, `expected at least 8 invariants, found ${invariants.length}`);
  assert.match(invariants[0], /^1\. /);
  assert.ok(
    invariants.some((entry) => /only client allowed to\s+Cue, Take/.test(entry.replace(/\s+/g, " "))),
    "the Playout-authority invariant did not survive extraction"
  );
});

test("the binding session rules are extracted", async () => {
  const rules = await knowledge.sessionRules();

  assert.ok(rules.length >= 20, `expected the rule list, found ${rules.length}`);
  assert.match(rules[rules.length - 1], /^\d+\. /);
});

test("the capability map separates declared from implemented", async () => {
  const capabilities = await knowledge.capabilities();

  assert.ok(capabilities.objects.declared.includes("text"));
  assert.ok(capabilities.objects.declared.includes("mesh"));

  // The point of the whole capability layer: TextureFitMode declares eight
  // values and the renderers implement fewer. A regression that reported them
  // as equal would let an agent author a mode that silently draws as stretch.
  assert.ok(capabilities.textureFitModes.declared.length > 0);
  assert.ok(capabilities.textureFitModes.implemented.length > 0);
  assert.ok(
    capabilities.textureFitModes.declared.length >=
      capabilities.textureFitModes.implemented.length,
    "more modes are implemented than declared, which cannot be true"
  );
  for (const mode of capabilities.textureFitModes.implemented) {
    assert.ok(
      capabilities.textureFitModes.declared.includes(mode),
      `${mode} is implemented but not declared`
    );
  }

  assert.equal(capabilities.materials.canonicalType, "pbr");
  assert.ok(capabilities.animatableProperties.implemented.includes("opacity"));
  assert.ok(capabilities.project.resolutionPresets.some((preset) => preset.id === "hd-1080"));
});

test("only pure string-literal unions are extracted", () => {
  const source = [
    'export type Simple = "a" | "b";',
    'export type Mixed = { kind: "x" } | "y";',
    "export type Numeric = 1 | 2;"
  ].join("\n");

  assert.deepEqual(extractStringUnion(source, "Simple"), ["a", "b"]);
  assert.deepEqual(extractStringUnion(source, "Mixed"), [], "a union with object members leaked");
  assert.deepEqual(extractStringUnion(source, "Numeric"), []);
  assert.deepEqual(extractStringUnion(source, "Absent"), []);
});

test("search surfaces the canonical architecture early for an architecture question", async () => {
  const hits = await knowledge.search("Program output authority Playout invariant", 10);

  assert.ok(hits.length > 0, "no sections matched a term that is definitely in the corpus");
  assert.ok(
    hits.slice(0, 3).some((hit) => hit.relativePath === "docs/architecture.md"),
    `architecture.md was not in the top 3: ${hits.slice(0, 3).map((hit) => hit.relativePath).join(", ")}`
  );
  assert.ok(hits[0].snippet.length > 0);
  assert.ok(hits[0].startLine >= 1);
  assert.equal(typeof hits[0].authority, "number", "hits must carry authority so callers can rank");
});

test("authority breaks a tie toward the canonical document", () => {
  // Two sections with identical text: only the authority rank differs, so the
  // bias is the whole difference between them. This is what the ranking
  // promises — not that authority 1 always outranks a stronger match.
  const shared = "The render engine owns Program and the outputs.";
  const index = new SearchIndex([
    {
      id: "detail",
      relativePath: "docs/detail.md",
      title: "Detail",
      category: "detail",
      authority: 5,
      text: `# Detail\n\n${shared}`,
      sizeBytes: shared.length,
      modifiedAt: new Date(0).toISOString()
    },
    {
      id: "canonical",
      relativePath: "docs/architecture.md",
      title: "Architecture",
      category: "architecture",
      authority: 1,
      text: `# Architecture\n\n${shared}`,
      sizeBytes: shared.length,
      modifiedAt: new Date(0).toISOString()
    }
  ]);

  const hits = index.search("render engine Program outputs", 5);

  assert.ok(hits.length >= 2);
  assert.equal(hits[0].relativePath, "docs/architecture.md");
  assert.ok(hits[0].score > hits[1].score);
});

test("search returns section-level hits, not whole documents", async () => {
  const hits = await knowledge.search("premultiplied alpha", 5);

  assert.ok(hits.length > 0);
  for (const hit of hits) {
    assert.ok(hit.text.length < 20_000, `section from ${hit.relativePath} was not split`);
    assert.ok(hit.heading.length > 0);
  }
});

test("the primer states the boundary and the capability caveat", async () => {
  const primer = await knowledge.primer();

  assert.match(primer, /Editor/);
  assert.match(primer, /Playout/);
  assert.match(primer, /Render Engine/);
  assert.match(primer, /may not/);
  assert.match(primer, /Cue, Take, Continue or Clear/);
  assert.match(primer, /Non-negotiable invariants/);
  assert.match(primer, /Declared but NOT rendered|What a scene can contain/);
});

test("a second load reuses the cached snapshot", async () => {
  const first = await knowledge.load();
  const second = await knowledge.load();

  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first, second, "the corpus was re-read despite an unchanged fingerprint");
});
