/**
 * The architecture guard.
 *
 * `docs/architecture.md` invariants 3 and 4 give Program and output authority to
 * Playout alone. This suite is what keeps a future convenience tool — a
 * `grapix_editor_take_scene` that "just calls Playout" — from being added
 * without anyone noticing. It fails the build rather than the show.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_TOOLS,
  FORBIDDEN_TOOL_VERBS,
  assertEditorAuthority,
  createEditorMcpServer
} from "../dist/server.js";
import { resolveConfig } from "../dist/config.js";

test("no tool exposes a Program or output verb", () => {
  assertEditorAuthority(ALL_TOOLS);

  for (const tool of ALL_TOOLS) {
    const bare = tool.name.replace(/^grapix_editor_/, "");
    for (const verb of FORBIDDEN_TOOL_VERBS) {
      assert.notEqual(bare, verb, `${tool.name} is a forbidden Playout verb`);
      assert.ok(
        !bare.startsWith(`${verb}_`) && !bare.endsWith(`_${verb}`),
        `${tool.name} names the forbidden verb "${verb}"`
      );
    }
  }
});

test("the guard actually rejects a forbidden tool", () => {
  assert.throws(
    () =>
      assertEditorAuthority([
        ...ALL_TOOLS,
        { name: "grapix_editor_take_scene", title: "Take", mutates: true, register() {} }
      ]),
    /invariants 3 and 4/
  );
});

test("every tool is namespaced, titled and uniquely named", () => {
  const seen = new Set();

  for (const tool of ALL_TOOLS) {
    assert.ok(tool.name.startsWith("grapix_editor_"), `${tool.name} is missing the product prefix`);
    assert.ok(tool.title.length > 0, `${tool.name} has no title`);
    assert.ok(!seen.has(tool.name), `${tool.name} is registered twice`);
    seen.add(tool.name);
  }

  assert.ok(ALL_TOOLS.length >= 25, `expected a full tool surface, found ${ALL_TOOLS.length}`);
});

test("knowledge tools come first, so orientation outranks mutation", () => {
  assert.equal(ALL_TOOLS[0].name, "grapix_editor_get_primer");
  const firstMutator = ALL_TOOLS.findIndex((tool) => tool.mutates);
  const lastKnowledge = ALL_TOOLS.map((tool) => tool.name).lastIndexOf(
    "grapix_editor_list_commands"
  );
  assert.ok(firstMutator > lastKnowledge, "a mutating tool is listed before the knowledge tools");
});

test("read-only mode omits every mutating tool rather than failing at call time", () => {
  const base = resolveConfig({ GRAPIX_MCP_READ_ONLY: "true" });
  const { registeredTools } = createEditorMcpServer(base);

  assert.ok(registeredTools.length > 0);
  assert.equal(
    registeredTools.filter((tool) => tool.mutates).length,
    0,
    "a mutating tool survived read-only mode"
  );
  assert.ok(
    registeredTools.some((tool) => tool.name === "grapix_editor_get_primer"),
    "read-only mode dropped the read tools too"
  );
  assert.ok(
    ALL_TOOLS.length > registeredTools.length,
    "read-only mode registered the full surface"
  );
});

test("mutating tools are annotated as writes", () => {
  const writers = ALL_TOOLS.filter((tool) => tool.mutates).map((tool) => tool.name);

  for (const expected of [
    "grapix_editor_create_scene",
    "grapix_editor_add_object",
    "grapix_editor_update_object",
    "grapix_editor_delete_object",
    "grapix_editor_create_material",
    "grapix_editor_import_asset",
    "grapix_editor_publish_scene"
  ]) {
    assert.ok(writers.includes(expected), `${expected} is not marked as mutating`);
  }
});
