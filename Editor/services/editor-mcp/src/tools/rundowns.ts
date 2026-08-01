/**
 * Rundown tools.
 *
 * `RundownDocument` is the **Editor's** authoring-time sequencing and automation
 * model, consumed by `@grapix/sdk`. It is not Playout's operator surface:
 * Playout runs a Scene Manager keyed by numeric Take ID plus an optional ordered
 * Take List, and it replaced `PlayoutRundownDocument` entirely. Conflating the
 * two is easy and wrong, so every description here says which one it means.
 */

import type { RundownDocument } from "@grapix/shared-types";
import { z } from "zod";
import { heading, lines, paginate, table } from "../format.js";
import {
  defineTool,
  limitField,
  offsetField,
  present,
  responseFormatField,
  type RegisteredEditorTool
} from "../toolkit.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

interface StoredRundownSummary {
  rundownId: string;
  name: string;
  updatedAt: string;
  sequenceCount: number;
  cueCount: number;
  triggerCount: number;
  revision: number;
}

const rundownIdField = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,128}$/, "rundown ids contain only letters, numbers, underscore or hyphen")
  .describe("Rundown id. Get one from grapix_editor_list_rundowns.");

export const rundownTools: RegisteredEditorTool[] = [
  defineTool({
    name: "list_rundowns",
    title: "List authoring rundowns",
    description: `List the Editor's authoring rundowns — multi-scene sequences with tracks, cues, transitions and triggers.

These are authoring documents. They are not Playout's take list: Playout's operator surface is the Scene Manager, keyed by numeric Take ID, with an optional ordered Take List.

Args:
  - limit (number), offset (number): paging (default limit: 25).
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { total, count, offset, has_more, rundowns: [{ rundownId, name, revision, sequenceCount, cueCount, triggerCount, updatedAt }] }`,
    inputSchema: z
      .object({ limit: limitField, offset: offsetField, response_format: responseFormatField })
      .strict(),
    annotations: READ_ONLY,
    async handler({ limit, offset, response_format }, { client }) {
      const response = await client.request<{ rundowns: StoredRundownSummary[] }>("/api/rundowns");
      const page = paginate(response.rundowns ?? [], offset, limit);

      if (page.total === 0) {
        return { text: "No authoring rundowns exist. Create one with grapix_editor_save_rundown." };
      }

      const data = { ...page, rundowns: page.items };
      const markdown = lines(
        heading(1, "Authoring rundowns"),
        "",
        table(page.items, [
          { label: "Id", value: (rundown) => rundown.rundownId },
          { label: "Name", value: (rundown) => rundown.name },
          { label: "Rev", value: (rundown) => rundown.revision },
          { label: "Sequences", value: (rundown) => rundown.sequenceCount },
          { label: "Cues", value: (rundown) => rundown.cueCount },
          { label: "Triggers", value: (rundown) => rundown.triggerCount },
          { label: "Updated", value: (rundown) => rundown.updatedAt }
        ]),
        "",
        page.has_more ? `Pass offset: ${page.next_offset} for more.` : `${page.total} shown.`
      );

      return present(response_format, markdown, data, "Lower `limit`.");
    }
  }),

  defineTool({
    name: "get_rundown",
    title: "Read an authoring rundown",
    description: `Read one authoring rundown in full: its sequences, tracks, cues, transitions, triggers and variables.

Args:
  - rundown_id (string): the rundown id.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns: the complete RundownDocument.

Limits enforced by the project service: at most 128 sequences, 64 tracks and 256 triggers per sequence, 4096 cues per sequence, and a frame rate between 1 and 120.`,
    inputSchema: z.object({ rundown_id: rundownIdField, response_format: responseFormatField }).strict(),
    annotations: READ_ONLY,
    async handler({ rundown_id, response_format }, { client }) {
      const response = await client.request<{ ok: boolean; rundown: RundownDocument }>(
        `/api/rundowns/${encodeURIComponent(rundown_id)}`
      );
      const rundown = response.rundown;

      const markdown = lines(
        heading(1, rundown.name),
        `\`${rundown.rundownId}\` · revision ${rundown.revision ?? 0} · updated ${rundown.updatedAt}`,
        "",
        `- **Active sequence**: ${rundown.activeSequenceId}`,
        `- **Sequences**: ${rundown.sequences.length}`,
        `- **Variables**: ${Object.keys(rundown.variables ?? {}).join(", ") || "none"}`,
        "",
        heading(2, "Sequences"),
        table(rundown.sequences, [
          { label: "Id", value: (sequence) => sequence.sequenceId },
          { label: "Name", value: (sequence) => sequence.name },
          { label: "fps", value: (sequence) => sequence.fps },
          { label: "Frames", value: (sequence) => sequence.durationFrames },
          { label: "Tracks", value: (sequence) => sequence.tracks.length },
          { label: "Triggers", value: (sequence) => sequence.triggers.length }
        ])
      );

      return present(
        response_format,
        markdown,
        rundown as unknown as Record<string, unknown>,
        "Use response_format: 'markdown' for a summary instead of the full document."
      );
    }
  }),

  defineTool({
    name: "save_rundown",
    title: "Create or replace an authoring rundown",
    description: `Store a complete RundownDocument, creating it or replacing the existing one with the same id.

The project service validates the whole document structurally before storing: duplicate sequence, track or cue ids, invalid frame timings, an out-of-range frame rate or an over-limit collection are all refused with the specific reason.

Args:
  - rundown (object): a complete RundownDocument. \`version\` must be 1.

Returns:
  JSON shape: { ok: true, rundown: { rundownId, name, revision, sequenceCount, cueCount, triggerCount } }

The stored revision increments on every save.`,
    inputSchema: z
      .object({ rundown: z.record(z.unknown()).describe("A complete RundownDocument object.") })
      .strict(),
    mutates: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    },
    async handler({ rundown }, { client }) {
      const response = await client.request<{ ok: boolean; rundown: StoredRundownSummary }>(
        "/api/rundowns",
        { method: "POST", json: rundown }
      );

      return {
        text: lines(
          `Stored rundown "${response.rundown.name}" (\`${response.rundown.rundownId}\`).`,
          "",
          `- **Revision**: ${response.rundown.revision}`,
          `- **Sequences**: ${response.rundown.sequenceCount}`,
          `- **Cues**: ${response.rundown.cueCount}`,
          `- **Triggers**: ${response.rundown.triggerCount}`
        ),
        data: { ok: true, rundown: response.rundown as unknown as Record<string, unknown> }
      };
    }
  }),

  defineTool({
    name: "evaluate_rundown_event",
    title: "Evaluate a rundown trigger (dry run)",
    description: `Send a trigger event to a rundown's sequence engine and report which triggers matched and what actions they would run.

This is a dry-run evaluation only. The Editor never executes an automation action — Cue, Take, Continue, Clear and output control belong to Playout, and the render engine refuses them from an Editor role (docs/architecture.md invariant 4).

Args:
  - rundown_id (string): the rundown id.
  - event_type ('manual' | 'api' | 'webhook' | 'data-change' | 'timer' | 'timecode' | 'keyboard' | 'scene-event').
  - name (string): event name, 1-128 characters.
  - payload (object): event payload, up to 64 KiB.
  - scene_data (object): scene data the conditions evaluate against.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok, dry_run: true, evaluation: { matched: [{ triggerId, actions }], ... } }`,
    inputSchema: z
      .object({
        rundown_id: rundownIdField,
        event_type: z
          .enum(["manual", "api", "webhook", "data-change", "timer", "timecode", "keyboard", "scene-event"])
          .describe("Trigger event type."),
        name: z.string().min(1).max(128).describe("Event name the triggers match on."),
        payload: z.record(z.unknown()).default({}).describe("Event payload, up to 64 KiB."),
        scene_data: z
          .record(z.unknown())
          .default({})
          .describe("Scene data the trigger conditions evaluate against."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler(args, { client }) {
      const response = await client.request<{
        ok: boolean;
        evaluation: Record<string, unknown>;
        dryRun: boolean;
      }>(`/api/rundowns/${encodeURIComponent(args.rundown_id)}/events`, {
        method: "POST",
        json: {
          event: { type: args.event_type, name: args.name, payload: args.payload },
          sceneData: args.scene_data
        }
      });

      return present(
        args.response_format,
        lines(
          heading(1, `Evaluated "${args.name}" (${args.event_type})`),
          "",
          "```json",
          JSON.stringify(response.evaluation, null, 2),
          "```",
          "",
          "_Dry run. The Editor evaluates automation; Playout executes it._"
        ),
        { ok: true, dry_run: true, evaluation: response.evaluation },
        "Use response_format: 'json'."
      );
    }
  })
];
