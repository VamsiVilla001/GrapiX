/**
 * Prompts: the workflows worth getting right the first time.
 *
 * Each one front-loads the orientation that keeps an agent out of the two
 * expensive mistakes here — authoring a value the renderers ignore, and
 * reaching for a Playout verb the Editor does not have. They are written as
 * instructions to the assistant, with the tool order that actually works.
 */

import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KnowledgeBase } from "./knowledge/index.js";
import { listScenes } from "./sceneOps.js";
import type { ProjectApiClient } from "./projectApiClient.js";

export interface PromptContext {
  knowledge: KnowledgeBase;
  client: ProjectApiClient;
}

function userMessage(text: string): {
  role: "user";
  content: { type: "text"; text: string };
} {
  return { role: "user", content: { type: "text", text } };
}

export function registerPrompts(server: McpServer, context: PromptContext): void {
  const { client } = context;

  const sceneIdArgument = completable(
    z.string().describe("Scene id to work on."),
    async (value) => {
      try {
        const scenes = await listScenes(client);
        return scenes.map((scene) => scene.id).filter((id) => id.includes(value)).slice(0, 100);
      } catch {
        return [];
      }
    }
  );

  server.registerPrompt(
    "grapix_orient",
    {
      title: "Orient me in GrapiX",
      description:
        "Load the architecture, the authority boundary and the capability map before doing anything else."
    },
    () => ({
      messages: [
        userMessage(
          [
            "Before we do anything in GrapiX, orient yourself:",
            "",
            "1. Call `grapix_editor_get_primer` and read all of it.",
            "2. Call `grapix_editor_get_status` to confirm the project service is reachable and whether",
            "   it is in read-only show mode.",
            "3. Summarise back to me, in your own words: the three products and who owns Program; the",
            "   things the Editor cannot do; and any capability list where a declared value is not",
            "   actually implemented by the renderers.",
            "",
            "Do not create or modify anything yet."
          ].join("\n")
        )
      ]
    })
  );

  server.registerPrompt(
    "grapix_build_lower_third",
    {
      title: "Build a data-driven lower third",
      description:
        "Create a broadcast lower third whose text comes from live data, with an animated in-move.",
      argsSchema: {
        name: z.string().describe("Name for the new scene, e.g. 'Match lower third'."),
        primary_text: z
          .string()
          .optional()
          .describe("Placeholder for the main line, e.g. a player name."),
        secondary_text: z.string().optional().describe("Placeholder for the second line."),
        accent_color: z.string().optional().describe("Accent colour, e.g. '#f5b942'.")
      }
    },
    ({ name, primary_text, secondary_text, accent_color }) => ({
      messages: [
        userMessage(
          [
            `Build a broadcast lower third called "${name}".`,
            "",
            "Work in this order and do not skip step 1:",
            "",
            "1. `grapix_editor_get_primer` — note the capability lists, especially any blend or texture",
            "   mode that is declared but not implemented. Do not author one of those.",
            "2. `grapix_editor_create_scene` — 1920x1080, 50 fps. Keep the default transparent",
            "   background: a lower third is keyed over video, not composited onto a colour.",
            "3. `grapix_editor_add_object` — a `rect` plate in the lower third safe area, then the text",
            `   objects. Main line placeholder: "${primary_text ?? "Player Name"}". Second line:`,
            `   "${secondary_text ?? "Team"}".${
              accent_color ? ` Use ${accent_color} as the accent colour.` : ""
            }`,
            "4. `grapix_editor_replace_data_context` — define the live fields, e.g.",
            '   `{ "talent": { "name": "...", "role": "..." } }`.',
            "5. `grapix_editor_bind_object_property` — bind each text object's `text` to its data path.",
            "   Check the reported resolved value; an unresolved binding is an empty graphic on air.",
            "6. `grapix_editor_set_object_animation` — animate `x` and `opacity` for a ~20 frame in-move",
            "   (0.4s at 50 fps). Keep every key inside the timeline duration.",
            "7. `grapix_editor_analyze_scene` — fix everything it reports before you tell me it is done.",
            "",
            "Report the scene id, the data paths an operator must supply, and anything analyze_scene",
            "flagged that you chose not to fix, with your reason."
          ].join("\n")
        )
      ]
    })
  );

  server.registerPrompt(
    "grapix_publish_check",
    {
      title: "Pre-publish review",
      description:
        "Audit a scene for hierarchy, preflight, capability and binding problems before publishing it.",
      argsSchema: { scene_id: sceneIdArgument }
    },
    ({ scene_id }) => ({
      messages: [
        userMessage(
          [
            `Review scene \`${scene_id}\` for publish readiness.`,
            "",
            "1. `grapix_editor_analyze_scene` — hierarchy diagnostics, package preflight and the",
            "   capability audit in one call.",
            "2. `grapix_editor_get_data_context` — confirm every binding resolves. A binding that does",
            "   not resolve renders empty on air.",
            "3. `grapix_editor_list_scene_assets` — flag assets in the library that nothing uses; they",
            "   inflate the package for no benefit.",
            "4. `grapix_editor_list_materials` — every material must be READY or fallback-ready.",
            "",
            "Then give me a go / no-go with the specific blocking items. Do not publish yet.",
            "",
            "Remember what publishing is and is not: it builds a checksum-addressed .gpxpkg. It does",
            "not put anything on air. Playout stages, validates and promotes the package, and an",
            "operator takes it."
          ].join("\n")
        )
      ]
    })
  );

  server.registerPrompt(
    "grapix_explain_boundary",
    {
      title: "Explain why an operation belongs to Playout",
      description:
        "Answer an operational request ('put this on air', 'start the output') with the correct " +
        "architectural reason and the right surface.",
      argsSchema: { request: z.string().describe("What the user asked for.") }
    },
    ({ request }) => ({
      messages: [
        userMessage(
          [
            `The user asked: "${request}"`,
            "",
            "Before answering, call `grapix_editor_describe_authority`.",
            "",
            "If the request is operational — cue, take, continue, clear, output configuration, going to",
            "air — explain that the Editor has no Program or output authority, cite the specific",
            "invariant, and say which product owns it. Note that this is enforced by the render engine",
            "by authenticated role, not by which buttons a UI shows.",
            "",
            "Then tell them what the Editor *can* do toward their goal — typically: author it, analyze",
            "it, and publish a package for Playout to take."
          ].join("\n")
        )
      ]
    })
  );

  server.registerPrompt(
    "grapix_investigate",
    {
      title: "Research a GrapiX question from the source",
      description:
        "Answer a question about GrapiX from its own architecture, contracts and session rules " +
        "rather than from assumption.",
      argsSchema: {
        question: z.string().describe("The question, e.g. 'how is transparency carried to SDI?'")
      }
    },
    ({ question }) => ({
      messages: [
        userMessage(
          [
            `Answer this about GrapiX: ${question}`,
            "",
            "Use the ingested knowledge, not general broadcast knowledge:",
            "",
            "1. `grapix_editor_search_knowledge` with the key terms. Results are ranked by the",
            "   documentation authority order, so read the top hits first.",
            "2. `grapix_editor_read_document` for the sections that matter.",
            "3. `grapix_editor_get_session_rules` filtered on the topic — the rules record what already",
            "   went wrong here and often contain the real answer.",
            "",
            "Cite each claim as `path:line`. If the documents disagree, say so and apply the authority",
            "order: architecture.md wins, then local-v1-system-design.md, then",
            "editor-playout-workspace.md. If the answer is genuinely not in the repository, say that",
            "instead of inferring one."
          ].join("\n")
        )
      ]
    })
  );
}
