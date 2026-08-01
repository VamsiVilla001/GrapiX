/**
 * A real MCP client against a real spawned server.
 *
 * Unit tests over the tool table would pass while the wire format was broken,
 * so this suite launches `dist/index.js` as a subprocess exactly as Claude,
 * Codex, Gemini or Kimi would, and drives it with the official client: the
 * handshake, the declared capabilities, every list, a resource read, a
 * completion, and two tool calls.
 *
 * It deliberately does not require the project service to be running. The
 * knowledge half of this server is fully useful without it, and the one tool
 * here that needs it is asserted to fail *informatively* rather than to
 * succeed.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(packageRoot, "dist", "index.js");

let client;
let transport;

before(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    stderr: "pipe"
  });

  client = new Client({ name: "grapix-editor-mcp-tests", version: "0.1.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

test("the server declares every capability it implements", () => {
  const capabilities = client.getServerCapabilities();

  assert.ok(capabilities.tools, "tools capability is missing");
  assert.ok(capabilities.resources, "resources capability is missing");
  assert.ok(capabilities.prompts, "prompts capability is missing");
  assert.ok(capabilities.logging, "logging capability is missing");
  assert.ok(capabilities.completions, "completions capability is missing");
  assert.equal(capabilities.resources.subscribe, true);
  assert.equal(capabilities.resources.listChanged, true);

  const version = client.getServerVersion();
  assert.equal(version.name, "grapix-editor-mcp-server");
});

test("the instructions state the authority boundary up front", () => {
  const instructions = client.getInstructions();

  assert.match(instructions, /no Program or output authority/);
  assert.match(instructions, /Cue, Take, Continue, Clear/);
  assert.match(instructions, /primer/);
});

test("every tool carries a schema, a description and annotations", async () => {
  const { tools } = await client.listTools();

  assert.ok(tools.length >= 25, `expected a full tool surface, found ${tools.length}`);

  for (const tool of tools) {
    assert.ok(tool.name.startsWith("grapix_editor_"), `${tool.name} is not namespaced`);
    assert.ok(tool.description?.length > 80, `${tool.name} has a thin description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} has no object input schema`);
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    assert.equal(
      typeof tool.annotations.readOnlyHint,
      "boolean",
      `${tool.name} does not declare readOnlyHint`
    );
  }
});

test("tool input schemas forbid unknown properties", async () => {
  const { tools } = await client.listTools();
  const primer = tools.find((tool) => tool.name === "grapix_editor_get_primer");

  assert.equal(primer.inputSchema.additionalProperties, false);
});

test("the primer tool returns the orientation document", async () => {
  const result = await client.callTool({
    name: "grapix_editor_get_primer",
    arguments: { include_capabilities: true }
  });

  assert.ok(!result.isError, JSON.stringify(result.content));
  const text = result.content[0].text;
  assert.match(text, /orientation for an AI assistant/);
  assert.match(text, /may not, and no tool here exposes/);
  assert.match(text, /Non-negotiable invariants/);
});

test("describe_authority returns structured content as well as prose", async () => {
  const result = await client.callTool({
    name: "grapix_editor_describe_authority",
    arguments: { response_format: "json" }
  });

  assert.ok(!result.isError);
  assert.ok(result.structuredContent, "no structuredContent was returned");
  assert.ok(Array.isArray(result.structuredContent.editor_may_not));
  assert.ok(
    result.structuredContent.editor_may_not.some((entry) => /Cue, Take/.test(entry)),
    "the Playout boundary is not in the structured payload"
  );
  assert.ok(result.structuredContent.invariants.length >= 8);
});

test("knowledge search finds a real answer and cites its source", async () => {
  const result = await client.callTool({
    name: "grapix_editor_search_knowledge",
    arguments: { query: "scene package manifest checksum", limit: 5, response_format: "json" }
  });

  assert.ok(!result.isError);
  const payload = result.structuredContent;
  assert.ok(payload.items.length > 0, "no sections matched");
  assert.ok(payload.items[0].path.length > 0);
  assert.ok(payload.items[0].start_line >= 1);
});

test("an unknown document id answers with the ids that exist", async () => {
  const result = await client.callTool({
    name: "grapix_editor_read_document",
    arguments: { document_id: "does-not-exist" }
  });

  assert.ok(!result.isError, "an unknown id should be a normal answer, not a protocol error");
  assert.match(result.content[0].text, /Available ids/);
  assert.match(result.content[0].text, /docs-architecture/);
});

test("invalid arguments are rejected by the declared schema", async () => {
  const result = await client.callTool({
    name: "grapix_editor_search_knowledge",
    arguments: { query: "x" }
  });

  assert.ok(result.isError, "a one-character query passed a min(2) constraint");
});

test("a tool that needs the project service fails with an actionable message", async () => {
  const result = await client.callTool({
    name: "grapix_editor_list_scenes",
    arguments: {}
  });

  // Either the service is running locally and this succeeds, or it is not and
  // the failure must name the command that starts it. Both are correct; a bare
  // "fetch failed" is not.
  if (result.isError) {
    assert.match(result.content[0].text, /npm run dev|GRAPIX_API_URL/);
  } else {
    assert.ok(result.structuredContent);
  }
});

test("resources include the primer, the capability map and the document template", async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((resource) => resource.uri);

  assert.ok(uris.includes("grapix://primer"));
  assert.ok(uris.includes("grapix://capabilities"));
  assert.ok(uris.includes("grapix://authority"));
  assert.ok(uris.includes("grapix://rules"));
  assert.ok(
    uris.some((uri) => uri.startsWith("grapix://doc/")),
    "the document template listed nothing"
  );

  const { resourceTemplates } = await client.listResourceTemplates();
  const templates = resourceTemplates.map((template) => template.uriTemplate);
  assert.ok(templates.includes("grapix://doc/{documentId}"));
  assert.ok(templates.includes("grapix://scene/{sceneId}"));
  assert.ok(templates.includes("grapix://asset/{assetId}"));
});

test("reading a document resource returns the file itself", async () => {
  const result = await client.readResource({ uri: "grapix://doc/docs-architecture" });

  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].mimeType, "text/markdown");
  assert.match(result.contents[0].text, /# GrapiX Local V1 Architecture/);
  assert.match(result.contents[0].text, /Non-negotiable invariants/);
});

test("the capability resource is machine-readable", async () => {
  const result = await client.readResource({ uri: "grapix://capabilities" });
  const map = JSON.parse(result.contents[0].text);

  assert.ok(Array.isArray(map.objects.declared));
  assert.ok(Array.isArray(map.blendModes.implemented));
  assert.equal(map.materials.canonicalType, "pbr");
});

test("completion offers real document ids", async () => {
  const result = await client.complete({
    ref: { type: "ref/resource", uri: "grapix://doc/{documentId}" },
    argument: { name: "documentId", value: "docs-" }
  });

  assert.ok(result.completion.values.length > 0, "no completions were offered");
  assert.ok(result.completion.values.every((value) => value.includes("docs-")));
});

test("prompts cover orientation, authoring, review and the boundary", async () => {
  const { prompts } = await client.listPrompts();
  const names = prompts.map((prompt) => prompt.name);

  for (const expected of [
    "grapix_orient",
    "grapix_build_lower_third",
    "grapix_publish_check",
    "grapix_explain_boundary",
    "grapix_investigate"
  ]) {
    assert.ok(names.includes(expected), `prompt ${expected} is missing`);
  }
});

test("a prompt renders with its arguments applied", async () => {
  const result = await client.getPrompt({
    name: "grapix_build_lower_third",
    arguments: { name: "Match strap", accent_color: "#f5b942" }
  });

  const text = result.messages[0].content.text;
  assert.match(text, /Match strap/);
  assert.match(text, /#f5b942/);
  assert.match(text, /grapix_editor_get_primer/);
  assert.match(text, /analyze_scene/);
});

test("the boundary prompt sends the model to describe_authority first", async () => {
  const result = await client.getPrompt({
    name: "grapix_explain_boundary",
    arguments: { request: "put this graphic on air" }
  });

  const text = result.messages[0].content.text;
  assert.match(text, /grapix_editor_describe_authority/);
  assert.match(text, /no Program or output authority/);
});
