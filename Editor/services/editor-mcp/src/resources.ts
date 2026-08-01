/**
 * Resources: addressable reads that do not need a tool call.
 *
 * The split against tools is deliberate. A resource is a stable, URI-addressed
 * document that a client can attach to context on its own — `grapix://primer`,
 * a whole architecture document, a scene as JSON, an asset's bytes. Anything
 * involving validation, side effects or a decision stays a tool.
 *
 * Templates carry `complete` callbacks so a client can offer real document and
 * scene ids rather than making the user guess them.
 */

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AUTHORITY_BOUNDARY, PORT_MAP, type KnowledgeBase } from "./knowledge/index.js";
import { capabilityLists, renderCapabilityList } from "./knowledge/capabilities.js";
import { listScenes, readScene } from "./sceneOps.js";
import type { ProjectApiClient } from "./projectApiClient.js";

export interface ResourceContext {
  knowledge: KnowledgeBase;
  client: ProjectApiClient;
}

function jsonResource(uri: string, value: unknown): {
  contents: { uri: string; mimeType: string; text: string }[];
} {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

function textResource(uri: string, text: string, mimeType = "text/markdown"): {
  contents: { uri: string; mimeType: string; text: string }[];
} {
  return { contents: [{ uri, mimeType, text }] };
}

export function registerResources(server: McpServer, context: ResourceContext): void {
  const { knowledge, client } = context;

  server.registerResource(
    "primer",
    "grapix://primer",
    {
      title: "GrapiX orientation primer",
      description:
        "Everything an assistant needs before its first GrapiX edit: the three-product split, the " +
        "architecture invariants, what the Editor may and may not do, and the full capability map " +
        "with declared-but-unimplemented values called out.",
      mimeType: "text/markdown"
    },
    async (uri) => textResource(uri.href, await knowledge.primer())
  );

  server.registerResource(
    "authority",
    "grapix://authority",
    {
      title: "Editor authority boundary",
      description:
        "The verbs the Editor owns and the verbs it does not, with the invariants that fix the line " +
        "and the local port map.",
      mimeType: "application/json"
    },
    async (uri) =>
      jsonResource(uri.href, {
        editor_may: AUTHORITY_BOUNDARY.editorMay,
        editor_may_not: AUTHORITY_BOUNDARY.editorMayNot,
        invariants: await knowledge.invariants(),
        ports: PORT_MAP
      })
  );

  server.registerResource(
    "capabilities",
    "grapix://capabilities",
    {
      title: "Scene capability map",
      description:
        "What a GrapiX scene can contain, derived from the Shared contracts: object types, " +
        "properties, materials, textures, masks, assets, triggers and project settings — with the " +
        "implemented subset of each list.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, await knowledge.capabilities())
  );

  server.registerResource(
    "capabilities-markdown",
    "grapix://capabilities.md",
    {
      title: "Scene capability map (readable)",
      description: "The capability map rendered as markdown, for reading rather than parsing.",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const map = await knowledge.capabilities();
      return textResource(
        uri.href,
        ["# GrapiX scene capabilities", "", ...capabilityLists(map).map(renderCapabilityList)].join("\n")
      );
    }
  );

  server.registerResource(
    "session-rules",
    "grapix://rules",
    {
      title: "Binding project rules",
      description:
        "The numbered 'Rules for the next session' from memory.md. Each records something that " +
        "already went wrong in this codebase; all of them are binding.",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const rules = await knowledge.sessionRules();
      return textResource(
        uri.href,
        ["# Binding session rules", "", ...rules.map((rule) => `- ${rule}`)].join("\n")
      );
    }
  );

  server.registerResource(
    "documents",
    new ResourceTemplate("grapix://doc/{documentId}", {
      list: async () => {
        const documents = await knowledge.documents();
        return {
          resources: documents.map((document) => ({
            uri: `grapix://doc/${document.id}`,
            name: document.title,
            description: `${document.relativePath} · authority ${document.authority} · ${document.category}`,
            mimeType: document.relativePath.endsWith(".ts") ? "text/x-typescript" : "text/markdown"
          }))
        };
      },
      complete: {
        documentId: async (value) => {
          const documents = await knowledge.documents();
          const needle = value.toLowerCase();
          return documents
            .map((document) => document.id)
            .filter((id) => id.includes(needle))
            .slice(0, 100);
        }
      }
    }),
    {
      title: "Ingested GrapiX document",
      description:
        "Any architecture document, README, contract source or the durable handoff, read whole by id."
    },
    async (uri, variables) => {
      const id = String(variables.documentId);
      const document = await knowledge.document(id);
      if (!document) {
        const available = (await knowledge.documents()).map((entry) => entry.id).join(", ");
        throw new Error(`No ingested document "${id}". Available: ${available}`);
      }
      return textResource(
        uri.href,
        document.text,
        document.relativePath.endsWith(".ts") ? "text/x-typescript" : "text/markdown"
      );
    }
  );

  server.registerResource(
    "scenes",
    new ResourceTemplate("grapix://scene/{sceneId}", {
      list: async () => {
        try {
          const scenes = await listScenes(client);
          return {
            resources: scenes.map((scene) => ({
              uri: `grapix://scene/${scene.id}`,
              name: scene.name,
              description: `revision ${scene.revision} · ${scene.objectCount} objects · updated ${scene.updatedAt}`,
              mimeType: "application/json"
            }))
          };
        } catch {
          // The project service may not be running. An empty list is the honest
          // answer; the status tool explains why.
          return { resources: [] };
        }
      },
      complete: {
        sceneId: async (value) => {
          try {
            const scenes = await listScenes(client);
            return scenes
              .map((scene) => scene.id)
              .filter((id) => id.includes(value))
              .slice(0, 100);
          } catch {
            return [];
          }
        }
      }
    }),
    {
      title: "Authoring scene document",
      description: "A complete stored SceneDocument as JSON, by scene id.",
      mimeType: "application/json"
    },
    async (uri, variables) => jsonResource(uri.href, await readScene(client, String(variables.sceneId)))
  );

  server.registerResource(
    "assets",
    new ResourceTemplate("grapix://asset/{assetId}", { list: undefined }),
    {
      title: "Stored asset bytes",
      description:
        "The raw bytes of a stored asset. Text and JSON assets are returned as text; everything " +
        "else is returned base64-encoded as a blob."
    },
    async (uri, variables) => {
      const assetId = String(variables.assetId);
      const { bytes, contentType } = await client.requestRaw(
        `/api/assets/${encodeURIComponent(assetId)}/content`
      );

      const isText =
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("javascript") ||
        contentType.includes("svg");

      if (isText) {
        return {
          contents: [
            { uri: uri.href, mimeType: contentType, text: Buffer.from(bytes).toString("utf8") }
          ]
        };
      }

      return {
        contents: [
          { uri: uri.href, mimeType: contentType, blob: Buffer.from(bytes).toString("base64") }
        ]
      };
    }
  );
}
