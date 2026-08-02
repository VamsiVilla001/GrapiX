/**
 * Server assembly: capabilities, tool registration and the read-only gate.
 *
 * Every MCP capability this server can honestly offer is declared here — tools,
 * resources (with subscribe and listChanged), prompts, logging and completions.
 * Completions are not declared explicitly: the SDK adds the handler when a
 * `ResourceTemplate` carries a `complete` callback or a prompt argument is
 * `completable`, and both are used.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EditorMcpConfig } from "./config.js";
import { SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from "./constants.js";
import { KnowledgeBase } from "./knowledge/index.js";
import { ProjectApiClient } from "./projectApiClient.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { assetTools } from "./tools/assets.js";
import { dataTools } from "./tools/data.js";
import { importTools } from "./tools/imports.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { materialTools } from "./tools/materials.js";
import { objectTools } from "./tools/objects.js";
import { publishTools } from "./tools/publish.js";
import { rundownTools } from "./tools/rundowns.js";
import { sceneTools } from "./tools/scenes.js";
import type { RegisteredEditorTool, ToolContext } from "./toolkit.js";

/**
 * Registration order is the order a client lists them in, and models weight
 * early tools. Knowledge first is deliberate: the correct first move in this
 * codebase is to read the architecture, not to patch a scene.
 */
export const ALL_TOOLS: RegisteredEditorTool[] = [
  ...knowledgeTools,
  ...sceneTools,
  ...objectTools,
  ...materialTools,
  ...assetTools,
  ...importTools,
  ...dataTools,
  ...publishTools,
  ...rundownTools
];

/**
 * Verbs this server must never expose, checked at startup.
 *
 * `docs/architecture.md` invariants 3 and 4 give Program and output authority
 * to Playout alone. The engine enforces that server-side by authenticated role,
 * so a tool named for one of these would fail at the engine anyway — but it
 * would first tell a model that the Editor can put graphics on air, which is
 * the wrong belief to hand an autonomous agent driving a broadcast system. The
 * guard turns a future mistake into a startup failure instead of a surprise
 * during a show.
 */
export const FORBIDDEN_TOOL_VERBS = [
  "take",
  "cue",
  "continue",
  "clear_program",
  "on_air",
  "output",
  "program"
] as const;

export function assertEditorAuthority(tools: RegisteredEditorTool[]): void {
  const violations = tools
    .map((tool) => tool.name.slice("grapix_editor_".length))
    .filter((name) =>
      FORBIDDEN_TOOL_VERBS.some(
        (verb) => name === verb || name.startsWith(`${verb}_`) || name.endsWith(`_${verb}`)
      )
    );

  if (violations.length > 0) {
    throw new Error(
      "The GrapiX Editor MCP server may not expose Program or output verbs " +
        `(docs/architecture.md invariants 3 and 4). Offending tools: ${violations.join(", ")}.`
    );
  }
}

export interface BuiltServer {
  server: McpServer;
  knowledge: KnowledgeBase;
  client: ProjectApiClient;
  registeredTools: RegisteredEditorTool[];
}

export function createEditorMcpServer(
  config: EditorMcpConfig,
  shared?: { knowledge?: KnowledgeBase; client?: ProjectApiClient }
): BuiltServer {
  assertEditorAuthority(ALL_TOOLS);

  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {}
      },
      instructions:
        "GrapiX is a broadcast graphics platform split into three products: Editor (authoring), " +
        "Playout (operations) and the Render Engine (the only renderer). This server is the Editor. " +
        "It can author scenes, materials, assets, fonts, animation and data bindings, and it can " +
        "publish a checksum-addressed package. It has no Program or output authority: Cue, Take, " +
        "Continue, Clear and output configuration belong to Playout, and the render engine refuses " +
        "them from an Editor role.\n\n" +
        "Read the `grapix://primer` resource, or call grapix_editor_get_primer, before the first " +
        "edit. Several scene enums accept values the renderers do not implement — authoring one " +
        "produces a scene that saves and validates cleanly and then renders as something else. The " +
        "primer and grapix_editor_describe_capabilities name them.\n\n" +
        "Before publishing, run grapix_editor_analyze_scene: it runs the hierarchy resolver, package " +
        "preflight and the capability audit in one call."
    }
  );

  // Shared across HTTP sessions so the corpus is ingested once, not per connection; stdio and
  // tests pass nothing and get their own.
  const knowledge = shared?.knowledge ?? new KnowledgeBase(config.repositoryRoot);
  const client = shared?.client ?? new ProjectApiClient(config);
  const context: ToolContext = { client, config, knowledge };

  // A read-only server omits mutating tools entirely rather than registering
  // them and refusing at call time. An omitted verb is the only signal a model
  // reliably acts on; a tool that always errors just gets retried.
  const registeredTools = config.readOnly
    ? ALL_TOOLS.filter((tool) => !tool.mutates)
    : ALL_TOOLS;

  for (const tool of registeredTools) tool.register(server, context);

  registerResources(server, { knowledge, client });
  registerPrompts(server, { knowledge, client });

  return { server, knowledge, client, registeredTools };
}
