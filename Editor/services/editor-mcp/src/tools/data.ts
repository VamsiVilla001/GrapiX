/**
 * Live-data and automation tools.
 *
 * Both are authoring-time operations. Automation here is **evaluated, never
 * executed**: the Editor shows an author what a trigger would do, and the
 * actions themselves — cue, take, continue, clear — belong to Playout
 * (`docs/architecture.md` invariant 4). Every response says so, because a model
 * that sees `action: "take"` in an evaluation result will otherwise reasonably
 * assume something went to air.
 */

import { z } from "zod";
import type { SceneDocument } from "@grapix/shared-types";
import { heading, lines } from "../format.js";
import { readScene } from "../sceneOps.js";
import { defineTool, present, responseFormatField, type RegisteredEditorTool } from "../toolkit.js";
import { sceneIdField } from "./scenes.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

const DRY_RUN_NOTE =
  "This is a dry-run evaluation. The Editor never executes an automation action: Cue, Take, " +
  "Continue, Clear and output control belong to Playout, and the render engine refuses them " +
  "from an Editor role.";

export const dataTools: RegisteredEditorTool[] = [
  defineTool({
    name: "get_data_context",
    title: "Read a scene's data context",
    description: `Read the scene's data context — the live values its bindings resolve against — together with every binding that reads from it.

The report pairs each binding with the value it currently resolves to, so an unresolvable path is visible here rather than as an empty graphic on air.

Args:
  - scene_id (string): the scene id.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { scene_id, data_context, bindings: [{ object_id, object_name, property, path, resolves, value }], unresolved_paths: string[] }`,
    inputSchema: z.object({ scene_id: sceneIdField, response_format: responseFormatField }).strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, response_format }, { client }) {
      const scene = await readScene(client, scene_id);
      const bindings: {
        object_id: string;
        object_name: string;
        property: string;
        path: string;
        resolves: boolean;
        value: unknown;
      }[] = [];

      for (const object of scene.objects) {
        for (const [property, path] of Object.entries(object.bindings ?? {})) {
          if (typeof path !== "string") continue;
          const value = resolvePath(scene.dataContext, path);
          bindings.push({
            object_id: object.id,
            object_name: object.name,
            property,
            path,
            resolves: value !== undefined,
            value
          });
        }
      }

      const unresolved = bindings.filter((entry) => !entry.resolves).map((entry) => entry.path);

      const data = {
        scene_id: scene.id,
        revision: scene.revision ?? 0,
        data_context: scene.dataContext,
        bindings,
        unresolved_paths: [...new Set(unresolved)]
      };

      const markdown = lines(
        heading(1, `Data context of ${scene.name}`),
        "",
        "```json",
        JSON.stringify(scene.dataContext, null, 2),
        "```",
        "",
        heading(2, `Bindings (${bindings.length})`),
        bindings.length
          ? bindings
              .map(
                (entry) =>
                  `- \`${entry.object_id}\`.${entry.property} <- \`${entry.path}\` = ` +
                  (entry.resolves ? `\`${JSON.stringify(entry.value)}\`` : "**unresolved**")
              )
              .join("\n")
          : "_No bindings._",
        unresolved.length
          ? `\n**${new Set(unresolved).size} path(s) do not resolve.** Set them with grapix_editor_set_data_value.`
          : ""
      );

      return present(response_format, markdown, data, "Use response_format: 'json'.");
    }
  }),

  defineTool({
    name: "set_data_value",
    title: "Set one live-data value",
    description: `Set a single value in a scene's data context, by path.

This is the live-data path: it stays available even while the project service is in read-only show mode, because updating a score during a show is not an authoring change.

Args:
  - scene_id (string): the scene id.
  - path (string): dot/bracket path, e.g. 'team.name' or 'scores[0].value'. 1-32 segments.
  - value (any): the value to set. Objects and arrays are allowed.
  - expected_updated_at (string): the scene's \`updatedAt\` timestamp as you read it. This route's revision token is the timestamp, not the numeric revision; supplying it makes the patch fail with 409 instead of overwriting a concurrent change.

Returns:
  JSON shape: { ok: true, path, value, affected_bindings: [{ object_id, property }], scene: { id, revision } }

Rate limit: 120 patches per scene per second. Batch many fields with grapix_editor_replace_data_context instead of calling this in a loop.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        path: z
          .string()
          .min(1)
          .max(256)
          .describe("Dot/bracket path into the data context, e.g. 'team.name'."),
        value: z.unknown().describe("The value to set."),
        expected_updated_at: z
          .string()
          .max(64)
          .optional()
          .describe(
            "The scene's `updatedAt` timestamp as you read it. This route compares timestamps, not revision numbers."
          )
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler({ scene_id, path, value, expected_updated_at }, { client }) {
      const before = await readScene(client, scene_id);

      const response = await client.request<{ ok: boolean; scene: SceneDocument }>(
        `/api/scenes/${encodeURIComponent(scene_id)}/data-patches`,
        {
          method: "PATCH",
          json: {
            path,
            value,
            ...(expected_updated_at !== undefined ? { expectedRevision: expected_updated_at } : {})
          }
        }
      );

      const affected = before.objects.flatMap((object) =>
        Object.entries(object.bindings ?? {})
          .filter(([, boundPath]) => boundPath === path)
          .map(([property]) => ({ object_id: object.id, property }))
      );

      return {
        text: lines(
          `Set \`${path}\` = \`${JSON.stringify(value)}\` in "${response.scene.name}".`,
          affected.length
            ? `\nThis feeds ${affected.length} binding(s): ${affected
                .map((entry) => `${entry.object_id}.${entry.property}`)
                .join(", ")}.`
            : "\n**No binding reads this path yet.** Bind one with grapix_editor_bind_object_property.",
          "",
          `Scene revision is now ${response.scene.revision ?? 0}.`
        ),
        data: {
          ok: true,
          path,
          value,
          affected_bindings: affected,
          scene: { id: response.scene.id, revision: response.scene.revision ?? 0 }
        }
      };
    }
  }),

  defineTool({
    name: "replace_data_context",
    title: "Replace a scene's whole data context",
    description: `Replace the scene's entire data context in one write.

Use this instead of many set_data_value calls: the per-scene patch rate limit is 120/second, and one replacement is both faster and atomic.

Args:
  - scene_id (string): the scene id.
  - data_context (object): the complete new data context.

Returns:
  JSON shape: { ok: true, keys: string[], unresolved_bindings: [{ object_id, property, path }], scene: { id, revision } }

The response lists any binding that no longer resolves against the new context — the check you want before publishing.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        data_context: z.record(z.unknown()).describe("The complete new data context object.")
      })
      .strict(),
    mutates: true,
    annotations: { ...WRITE, destructiveHint: true },
    async handler({ scene_id, data_context }, { client }) {
      const response = await client.request<{ ok: boolean; scene: SceneDocument }>(
        `/api/scenes/${encodeURIComponent(scene_id)}/data-context`,
        { method: "PATCH", json: data_context }
      );

      const unresolved = response.scene.objects.flatMap((object) =>
        Object.entries(object.bindings ?? {})
          .filter(
            ([, path]) => typeof path === "string" && resolvePath(data_context, path) === undefined
          )
          .map(([property, path]) => ({ object_id: object.id, property, path: String(path) }))
      );

      return {
        text: lines(
          `Replaced the data context of "${response.scene.name}".`,
          "",
          `- **Keys**: ${Object.keys(data_context).join(", ") || "none"}`,
          `- **Scene revision**: ${response.scene.revision ?? 0}`,
          unresolved.length
            ? `\n**${unresolved.length} binding(s) no longer resolve:**\n` +
              unresolved
                .map((entry) => `- \`${entry.object_id}\`.${entry.property} <- \`${entry.path}\``)
                .join("\n")
            : "\nEvery binding resolves."
        ),
        data: {
          ok: true,
          keys: Object.keys(data_context),
          unresolved_bindings: unresolved,
          scene: { id: response.scene.id, revision: response.scene.revision ?? 0 }
        }
      };
    }
  }),

  defineTool({
    name: "evaluate_scene_event",
    title: "Evaluate a scene automation trigger (dry run)",
    description: `Send a trigger event to a scene's automation rules and report which triggers matched and what actions they would run.

${DRY_RUN_NOTE}

Args:
  - scene_id (string): the scene id.
  - event_type ('manual' | 'api' | 'webhook' | 'data-change' | 'timer' | 'timecode' | 'keyboard' | 'scene-event').
  - name (string): event name, 1-128 characters.
  - payload (object): event payload, up to 64 KiB.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok, dry_run: true, evaluation: { matched: [{ triggerId, actions }], ... } }

Examples:
  - "Would the score trigger fire?" -> event_type="data-change", name="score", payload={"home":3}
  - "Test the manual in-trigger" -> event_type="manual", name="take-in", payload={}`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        event_type: z
          .enum(["manual", "api", "webhook", "data-change", "timer", "timecode", "keyboard", "scene-event"])
          .describe("Trigger event type."),
        name: z.string().min(1).max(128).describe("Event name the triggers match on."),
        payload: z.record(z.unknown()).default({}).describe("Event payload, up to 64 KiB."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, event_type, name, payload, response_format }, { client }) {
      const response = await client.request<{
        ok: boolean;
        evaluation: Record<string, unknown>;
        dryRun: boolean;
      }>(`/api/scenes/${encodeURIComponent(scene_id)}/events`, {
        method: "POST",
        json: { event: { type: event_type, name, payload } }
      });

      return present(
        response_format,
        lines(
          heading(1, `Evaluated "${name}" (${event_type})`),
          "",
          "```json",
          JSON.stringify(response.evaluation, null, 2),
          "```",
          "",
          `_${DRY_RUN_NOTE}_`
        ),
        { ok: true, dry_run: true, evaluation: response.evaluation },
        "Use response_format: 'json'."
      );
    }
  })
];

function resolvePath(data: Record<string, unknown> | undefined, path: string): unknown {
  if (!data) return undefined;
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current: unknown = data;

  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
