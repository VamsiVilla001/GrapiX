/**
 * Preflight, publish and service status.
 *
 * "Publish" here means exactly what `docs/architecture.md` says it means:
 * validate the mutable scene, then build a versioned, checksum-addressed
 * `.gpxpkg`. It does **not** load anything into the engine, promote a revision,
 * or put a graphic on air. Playout stages and independently validates the
 * package, promotes the immutable revision, and only then can an operator take
 * it. Publishing never patches a Program instance in place (invariant 6).
 */

import { preflightScenePackage, type ScenePackagePreflight, type SceneDocument } from "@grapix/shared-types";
import { z } from "zod";
import { heading, lines, table } from "../format.js";
import { readScene } from "../sceneOps.js";
import { defineTool, present, responseFormatField, type RegisteredEditorTool } from "../toolkit.js";
import { sceneIdField } from "./scenes.js";
import { PORT_MAP } from "../knowledge/index.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

interface StoredPackageSummary {
  sceneId: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

function renderPreflight(preflight: ScenePackagePreflight): string {
  return lines(
    `- **Result**: ${preflight.ok ? "passes" : "**fails**"}`,
    `- **Ready materials**: ${preflight.readyMaterials}`,
    `- **Fallback-ready materials**: ${preflight.fallbackReadyMaterials}`,
    `- **Missing materials**: ${preflight.missingMaterials}`,
    "",
    preflight.issues.length
      ? table(preflight.issues, [
          { label: "Severity", value: (issue) => issue.severity },
          { label: "Code", value: (issue) => issue.code },
          { label: "Message", value: (issue) => issue.message },
          {
            label: "Where",
            value: (issue) => issue.objectId ?? issue.materialId ?? issue.assetId ?? "—"
          }
        ])
      : "_No issues._"
  );
}

export const publishTools: RegisteredEditorTool[] = [
  defineTool({
    name: "preflight_scene",
    title: "Check whether a scene can be published",
    description: `Run package preflight against a stored scene without building anything.

This is the exact check the publish path runs, so a pass here means publish_scene will not be rejected for content reasons.

Preflight reports missing assets, materials that are neither READY nor fallback-ready, and unbound material slots. Errors block publishing; warnings do not.

Args:
  - scene_id (string): the scene id.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { scene_id, preflight: { ok, issues: [{ severity, code, message, objectId?, materialId?, assetId? }], readyMaterials, fallbackReadyMaterials, missingMaterials } }

For hierarchy and capability problems as well, use grapix_editor_analyze_scene — it runs this plus the resolver and the capability audit.`,
    inputSchema: z.object({ scene_id: sceneIdField, response_format: responseFormatField }).strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, response_format }, { client }) {
      const scene = await readScene(client, scene_id);
      const preflight = preflightScenePackage(scene);

      return present(
        response_format,
        lines(
          heading(1, `Preflight: ${scene.name}`),
          `\`${scene.id}\` · revision ${scene.revision ?? 0}`,
          "",
          renderPreflight(preflight)
        ),
        { scene_id: scene.id, revision: scene.revision ?? 0, preflight },
        "Use response_format: 'json' and read the issues array."
      );
    }
  }),

  defineTool({
    name: "preflight_document",
    title: "Check a scene document that is not stored yet",
    description: `Run package preflight against a SceneDocument passed inline, without storing it.

Use this to validate a document you have just built or converted — from a design import, say — before deciding whether to store it.

Args:
  - scene (object): a complete SceneDocument.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { preflight: { ok, issues, readyMaterials, fallbackReadyMaterials, missingMaterials } }`,
    inputSchema: z
      .object({
        scene: z.record(z.unknown()).describe("A complete SceneDocument object."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene, response_format }, { client }) {
      const response = await client.request<{ ok: boolean; preflight: ScenePackagePreflight }>(
        "/api/preflight",
        { method: "POST", json: scene }
      );

      return present(
        response_format,
        lines(heading(1, "Preflight (unstored document)"), "", renderPreflight(response.preflight)),
        { preflight: response.preflight },
        "Use response_format: 'json'."
      );
    }
  }),

  defineTool({
    name: "publish_scene",
    title: "Build a publishable scene package",
    description: `Validate a stored scene and build a versioned, checksum-addressed .gpxpkg package.

What this does: runs preflight, saves the scene, builds the package, and stores it in the project's package directory. The package manifest pins the video profile, frame rate, colour space, required fonts, shaders and codecs, and a SHA-256 for every packaged file.

What this does NOT do — and cannot, from the Editor:
  - load the package into the render engine
  - promote it to a published Playout revision
  - cue, take or put anything on air
  - touch Program or any output

Those are Playout's, by architecture invariant 4, and the render engine refuses them from an Editor role. Publishing is step 2 of a five-step flow; Playout performs steps 3 to 6 by staging, independently validating, and atomically promoting the package.

Args:
  - scene_id (string): the scene to publish.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok: true, package: { sceneId, fileName, path, sizeBytes, createdAt }, preflight: {...} }

Error handling: a scene that fails preflight is refused with 422 and the full issue list; nothing is written.`,
    inputSchema: z.object({ scene_id: sceneIdField, response_format: responseFormatField }).strict(),
    mutates: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    async handler({ scene_id, response_format }, { client }) {
      const response = await client.request<{
        ok: boolean;
        preflight: ScenePackagePreflight;
        package: StoredPackageSummary;
      }>(`/api/scenes/${encodeURIComponent(scene_id)}/packages`, { method: "POST", long: true });

      return present(
        response_format,
        lines(
          heading(1, `Published ${scene_id}`),
          "",
          `- **Package**: \`${response.package.fileName}\``,
          `- **Path**: \`${response.package.path}\``,
          `- **Size**: ${response.package.sizeBytes} bytes`,
          `- **Created**: ${response.package.createdAt}`,
          "",
          heading(2, "Preflight"),
          renderPreflight(response.preflight),
          "",
          "The package is built and stored. It is **not** on air and not loaded into the engine —",
          "Playout stages, validates and promotes it, and an operator takes it. The Editor has no",
          "Program or output authority."
        ),
        response as unknown as Record<string, unknown>,
        "Use response_format: 'json'."
      );
    }
  }),

  defineTool({
    name: "get_status",
    title: "GrapiX service and server status",
    description: `Report whether the Editor's project service is reachable and how this MCP server is configured.

Check this first when a tool fails with a connection error.

Args: none.

Returns:
  JSON shape: {
    project_service: { reachable, url, show_mode, authentication_required, time },
    mcp_server: { transport, read_only, repository_root, tool_count },
    knowledge: { documents, session_rules },
    ports: [...]
  }

\`show_mode: "read-only"\` means the project service is locked for a show: authoring mutations are refused, and only live-data patches and automation events are accepted.`,
    inputSchema: z.object({}).strict(),
    annotations: READ_ONLY,
    async handler(_args, { client, config, knowledge }) {
      let health:
        | { ok: boolean; service: string; time: string; showMode: string; authenticationRequired: boolean }
        | undefined;
      let reachError: string | undefined;

      try {
        health = await client.health();
      } catch (error) {
        reachError = error instanceof Error ? error.message : String(error);
      }

      const documents = await knowledge.documents();
      const rules = await knowledge.sessionRules();

      const data = {
        project_service: {
          reachable: Boolean(health),
          url: config.projectApiUrl,
          show_mode: health?.showMode,
          authentication_required: health?.authenticationRequired,
          time: health?.time,
          error: reachError
        },
        mcp_server: {
          transport: config.transport,
          read_only: config.readOnly,
          repository_root: config.repositoryRoot,
          api_token_configured: Boolean(config.apiToken)
        },
        knowledge: { documents: documents.length, session_rules: rules.length },
        ports: PORT_MAP
      };

      return {
        text: lines(
          heading(1, "GrapiX status"),
          "",
          heading(2, "Project service"),
          `- **URL**: ${config.projectApiUrl}`,
          health
            ? lines(
                `- **Reachable**: yes (${health.time})`,
                `- **Show mode**: ${health.showMode}`,
                `- **Authentication required**: ${health.authenticationRequired}`
              )
            : `- **Reachable**: no — ${reachError}`,
          "",
          heading(2, "MCP server"),
          `- **Transport**: ${config.transport}`,
          `- **Read-only**: ${config.readOnly}`,
          `- **Repository root**: \`${config.repositoryRoot}\``,
          `- **API token configured**: ${Boolean(config.apiToken)}`,
          "",
          heading(2, "Knowledge"),
          `- **Documents ingested**: ${documents.length}`,
          `- **Session rules loaded**: ${rules.length}`
        ),
        data
      };
    }
  })
];

/** Re-exported for the resource layer, which serves stored scenes by id. */
export type { SceneDocument };
