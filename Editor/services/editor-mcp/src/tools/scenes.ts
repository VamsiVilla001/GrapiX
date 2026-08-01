/**
 * Scene-level tools: list, read, create, replace, recover and analyse.
 *
 * `analyze_scene` is the one worth reading twice. It runs the same hierarchy
 * resolver and package preflight the Editor and the publish path use, so an
 * agent can find a cyclic parent, an unbound material or a missing asset before
 * it publishes rather than after a preflight rejection.
 */

import {
  evaluateSceneAtFrame,
  preflightScenePackage,
  resolveSceneObjectHierarchy,
  type SceneDocument
} from "@grapix/shared-types";
import { z } from "zod";
import { heading, lines, paginate, table } from "../format.js";
import {
  createSceneDocument,
  listScenes,
  mutateScene,
  readScene,
  saveScene
} from "../sceneOps.js";
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

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

export const sceneIdField = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,128}$/, "scene ids contain only letters, numbers, underscore or hyphen")
  .describe("Scene id, e.g. `scene_ab12cd34`. Get one from grapix_editor_list_scenes.");

export const expectedRevisionField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "The scene revision you read. The write is refused if the scene changed since, instead of overwriting another editor's work."
  );

/** Scene fields worth summarising without dumping the whole document. */
function sceneOverview(scene: SceneDocument): Record<string, unknown> {
  return {
    id: scene.id,
    name: scene.name,
    revision: scene.revision ?? 0,
    canvas: { width: scene.canvas.width, height: scene.canvas.height, background: scene.canvas.background },
    timeline: {
      fps: scene.timeline.fps,
      duration_frames: scene.timeline.durationFrames,
      frame_rate: scene.timeline.frameRate,
      marker_count: scene.timeline.markers?.length ?? 0,
      keyframe_count: scene.timeline.keyframes.length
    },
    counts: {
      objects: scene.objects.length,
      materials: scene.materials.length,
      assets: scene.assets.length,
      fonts: scene.fonts?.length ?? 0,
      shaders: scene.shaders?.length ?? 0,
      triggers: scene.automation?.triggers?.length ?? 0
    },
    active_camera_id: scene.activeCameraId,
    stage_id: scene.stageId,
    data_context_keys: Object.keys(scene.dataContext ?? {}),
    updated_at: scene.updatedAt
  };
}

export const sceneTools: RegisteredEditorTool[] = [
  defineTool({
    name: "list_scenes",
    title: "List authoring scenes",
    description: `List every authoring scene held by the Editor's project service, newest first.

These are mutable authoring documents. They are not the published scenes Playout takes to air — publishing creates a separate immutable, checksum-addressed revision (invariant 6).

Args:
  - limit (number): maximum scenes to return, 1-200 (default: 25).
  - offset (number): scenes to skip.
  - name_contains (string): case-insensitive filter on scene name.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { total, count, offset, has_more, next_offset?, scenes: [{ id, name, revision, updatedAt, objectCount, materialCount, assetCount }] }

Error handling: reports how to start the project service if it is not reachable.`,
    inputSchema: z
      .object({
        limit: limitField,
        offset: offsetField,
        name_contains: z.string().max(180).optional().describe("Case-insensitive name filter."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ limit, offset, name_contains, response_format }, { client }) {
      const all = await listScenes(client);
      const needle = name_contains?.toLowerCase();
      const filtered = needle
        ? all.filter((scene) => scene.name.toLowerCase().includes(needle))
        : all;
      const page = paginate(filtered, offset, limit);

      if (page.total === 0) {
        return {
          text: needle
            ? `No scene name contains "${name_contains}". ${all.length} scenes exist.`
            : "No scenes exist yet. Create one with grapix_editor_create_scene."
        };
      }

      const data = { ...page, scenes: page.items };
      const markdown = lines(
        heading(1, "Authoring scenes"),
        "",
        table(page.items, [
          { label: "Id", value: (scene) => scene.id },
          { label: "Name", value: (scene) => scene.name },
          { label: "Rev", value: (scene) => scene.revision },
          { label: "Objects", value: (scene) => scene.objectCount },
          { label: "Materials", value: (scene) => scene.materialCount },
          { label: "Assets", value: (scene) => scene.assetCount },
          { label: "Updated", value: (scene) => scene.updatedAt }
        ]),
        "",
        page.has_more
          ? `Showing ${page.count} of ${page.total}. Pass offset: ${page.next_offset}.`
          : `${page.total} scene${page.total === 1 ? "" : "s"}.`
      );

      return present(response_format, markdown, data, "Lower `limit` or filter with `name_contains`.");
    }
  }),

  defineTool({
    name: "get_scene",
    title: "Read a scene",
    description: `Read one authoring scene.

A full scene document is large. The default returns an overview — canvas, timeline, counts, data-context keys and the active camera — which is what most questions need. Ask for specific sections with \`include\`, or the whole document with include: ["all"].

Args:
  - scene_id (string): the scene id.
  - include (array): any of 'objects', 'materials', 'assets', 'fonts', 'timeline', 'data_context', 'automation', 'shaders', 'all'. Default: overview only.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { id, name, revision, canvas, timeline, counts, data_context_keys, ...requested sections }

The \`revision\` in the response is what to pass as \`expected_revision\` on a following write, so a concurrent edit is refused rather than overwritten.

Examples:
  - "What is in this scene?" -> include omitted
  - "Show me the text objects" -> include: ["objects"]
  - "Give me the whole document to copy" -> include: ["all"], response_format: "json"`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        include: z
          .array(
            z.enum([
              "objects",
              "materials",
              "assets",
              "fonts",
              "timeline",
              "data_context",
              "automation",
              "shaders",
              "all"
            ])
          )
          .max(9)
          .default([])
          .describe("Sections to include beyond the overview."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, include, response_format }, { client }) {
      const scene = await readScene(client, scene_id);
      const wants = (section: string): boolean =>
        include.includes("all") || include.includes(section as never);

      if (include.includes("all")) {
        return present(
          response_format,
          `${heading(1, scene.name)}\n\n\`\`\`json\n${JSON.stringify(scene, null, 2)}\n\`\`\``,
          scene as unknown as Record<string, unknown>,
          "Request specific sections with `include` instead of 'all'."
        );
      }

      const data: Record<string, unknown> = sceneOverview(scene);
      if (wants("objects")) data.objects = scene.objects;
      if (wants("materials")) data.materials = scene.materials;
      if (wants("assets")) data.assets = scene.assets;
      if (wants("fonts")) data.fonts = scene.fonts ?? [];
      if (wants("timeline")) data.timeline_detail = scene.timeline;
      if (wants("data_context")) data.data_context = scene.dataContext;
      if (wants("automation")) data.automation = scene.automation ?? null;
      if (wants("shaders")) data.shaders = scene.shaders ?? [];

      const markdown = lines(
        heading(1, scene.name),
        `\`${scene.id}\` · revision ${scene.revision ?? 0} · updated ${scene.updatedAt}`,
        "",
        `- **Canvas**: ${scene.canvas.width} x ${scene.canvas.height}, background \`${scene.canvas.background}\``,
        `- **Timeline**: ${scene.timeline.fps} fps, ${scene.timeline.durationFrames} frames`,
        `- **Objects**: ${scene.objects.length} · **Materials**: ${scene.materials.length} · **Assets**: ${scene.assets.length}`,
        `- **Data context keys**: ${Object.keys(scene.dataContext ?? {}).join(", ") || "none"}`,
        scene.activeCameraId ? `- **Active camera**: ${scene.activeCameraId}` : undefined,
        "",
        wants("objects")
          ? lines(
              heading(2, "Objects"),
              table(scene.objects, [
                { label: "Id", value: (object) => object.id },
                { label: "Name", value: (object) => object.name },
                { label: "Type", value: (object) => object.type },
                { label: "x,y", value: (object) => `${object.x},${object.y}` },
                { label: "w x h", value: (object) => `${object.width} x ${object.height}` },
                { label: "Visible", value: (object) => object.visible }
              ]),
              ""
            )
          : undefined,
        wants("materials")
          ? lines(
              heading(2, "Materials"),
              table(scene.materials, [
                { label: "Id", value: (material) => material.materialId },
                { label: "Name", value: (material) => material.name },
                { label: "Type", value: (material) => material.type },
                { label: "Readiness", value: (material) => material.readiness }
              ]),
              ""
            )
          : undefined,
        wants("assets")
          ? lines(
              heading(2, "Assets"),
              table(scene.assets, [
                { label: "Id", value: (asset) => asset.assetId },
                { label: "Name", value: (asset) => asset.name },
                { label: "Kind", value: (asset) => asset.kind },
                { label: "Status", value: (asset) => asset.status ?? "—" }
              ]),
              ""
            )
          : undefined,
        wants("data_context")
          ? lines(heading(2, "Data context"), "```json", JSON.stringify(scene.dataContext, null, 2), "```", "")
          : undefined,
        `Pass \`expected_revision: ${scene.revision ?? 0}\` on the next write to this scene.`
      );

      return present(response_format, markdown, data, "Request fewer sections in `include`.");
    }
  }),

  defineTool({
    name: "analyze_scene",
    title: "Analyse a scene for correctness and publish readiness",
    description: `Run the Editor's own checks over a scene and report what would block it.

Three checks, all using the shared implementations rather than reimplementations:
  1. **Hierarchy resolution** — the same resolver the renderers use. Reports missing children, self-references, objects claimed by two parents, and cycles.
  2. **Package preflight** — the exact check the publish path runs. Reports missing assets, unready materials and unbound slots as errors or warnings.
  3. **Capability audit** — flags any authored value that is declared by the contract but not implemented by the renderers, e.g. a texture fit mode that will silently draw as stretch.

Args:
  - scene_id (string): the scene id.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { scene_id, ok, hierarchy: { renderable, containers, diagnostics: [...] }, preflight: { ok, issues, readyMaterials, missingMaterials, ... }, capability_warnings: [{ objectId?, materialId?, field, value, effect }] }

Use before publish_scene: publishing rejects a scene that fails preflight, and this reports the same issues with the objects that caused them.`,
    inputSchema: z.object({ scene_id: sceneIdField, response_format: responseFormatField }).strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, response_format }, { client, knowledge }) {
      const scene = await readScene(client, scene_id);
      const hierarchy = resolveSceneObjectHierarchy(scene.objects);
      const preflight = preflightScenePackage(scene);
      const capabilities = await knowledge.capabilities();

      const capabilityWarnings: {
        objectId?: string;
        materialId?: string;
        field: string;
        value: string;
        effect: string;
      }[] = [];

      const unimplemented = (name: keyof typeof capabilities): string[] => {
        const entry = capabilities[name];
        return entry && typeof entry === "object" && "unimplemented" in entry
          ? entry.unimplemented ?? []
          : [];
      };

      const badBlend = unimplemented("blendModes");
      const badFit = unimplemented("textureFitModes");
      const badMask = unimplemented("maskModes");

      for (const material of scene.materials) {
        if (material.blendMode && badBlend.includes(material.blendMode)) {
          capabilityWarnings.push({
            materialId: material.materialId,
            field: "blendMode",
            value: material.blendMode,
            effect: "Declared but not implemented; the renderers composite it as `normal`."
          });
        }
        for (const slot of material.textureSlots ?? []) {
          if (slot.fit && badFit.includes(slot.fit)) {
            capabilityWarnings.push({
              materialId: material.materialId,
              field: `textureSlots.${slot.name}.fit`,
              value: slot.fit,
              effect: "Declared but not implemented; the renderers sample it as `stretch`."
            });
          }
        }
      }

      for (const object of scene.objects) {
        for (const mask of object.masks ?? []) {
          if (mask.mode && badMask.includes(mask.mode)) {
            capabilityWarnings.push({
              objectId: object.id,
              field: "mask.mode",
              value: mask.mode,
              effect: "Declared but not implemented; composition falls back to a deterministic reveal/hide."
            });
          }
        }
      }

      const ok =
        preflight.ok && hierarchy.diagnostics.length === 0 && capabilityWarnings.length === 0;

      const data = {
        scene_id: scene.id,
        revision: scene.revision ?? 0,
        ok,
        hierarchy: {
          renderable: hierarchy.renderableObjects.length,
          containers: hierarchy.containerObjects.length,
          diagnostics: hierarchy.diagnostics
        },
        preflight,
        capability_warnings: capabilityWarnings
      };

      const markdown = lines(
        heading(1, `Analysis: ${scene.name}`),
        `\`${scene.id}\` · revision ${scene.revision ?? 0}`,
        "",
        ok
          ? "**Ready.** No hierarchy diagnostics, no preflight errors, no unimplemented values."
          : "**Not ready.** See below.",
        "",
        heading(2, "Hierarchy"),
        `- ${hierarchy.renderableObjects.length} renderable, ${hierarchy.containerObjects.length} containers`,
        hierarchy.diagnostics.length
          ? hierarchy.diagnostics
              .map((entry) => `- **${entry.code}** ${entry.parentId} -> ${entry.childId}: ${entry.message}`)
              .join("\n")
          : "- No diagnostics.",
        "",
        heading(2, "Package preflight"),
        `- ${preflight.ok ? "Passes" : "**Fails**"} · ${preflight.readyMaterials} ready materials, ${preflight.missingMaterials} missing`,
        preflight.issues.length
          ? preflight.issues
              .map(
                (issue) =>
                  `- **${issue.severity}** \`${issue.code}\` ${issue.message}` +
                  (issue.objectId ? ` (object ${issue.objectId})` : "") +
                  (issue.materialId ? ` (material ${issue.materialId})` : "") +
                  (issue.assetId ? ` (asset ${issue.assetId})` : "")
              )
              .join("\n")
          : "- No issues.",
        "",
        heading(2, "Capability audit"),
        capabilityWarnings.length
          ? capabilityWarnings
              .map(
                (warning) =>
                  `- \`${warning.field}\` = \`${warning.value}\`` +
                  (warning.objectId ? ` on object ${warning.objectId}` : "") +
                  (warning.materialId ? ` on material ${warning.materialId}` : "") +
                  ` — ${warning.effect}`
              )
              .join("\n")
          : "- Every authored value is implemented by the renderers."
      );

      return present(response_format, markdown, data, "Use response_format: 'json' and read the issue list.");
    }
  }),

  defineTool({
    name: "evaluate_scene_at_frame",
    title: "Evaluate a scene at a frame",
    description: `Compute the scene as it would be at one timeline frame, with keyframe channels and data bindings applied.

This is the Editor's own evaluator (\`evaluateSceneAtFrame\` from the shared contracts) run locally — it reads the scene and computes, it does not render and it does not touch the engine. Use it to answer "where is this object at frame 30" or "does this binding resolve" without a renderer.

Args:
  - scene_id (string): the scene id.
  - frame (number): timeline frame, 0-based.
  - object_ids (string[]): restrict the reported objects.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { scene_id, frame, objects: [{ id, name, type, x, y, width, height, rotation, opacity, visible, text? }] }

Note: this is an evaluation, not a render. Pixel-accurate confirmation requires the render engine; see docs/pixel-parity.md.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        frame: z.number().int().min(0).max(1_000_000).describe("Timeline frame, 0-based."),
        object_ids: z.array(z.string()).max(200).optional().describe("Restrict to these object ids."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, frame, object_ids, response_format }, { client }) {
      const scene = await readScene(client, scene_id);

      if (frame > scene.timeline.durationFrames) {
        return {
          text:
            `Frame ${frame} is past the end of the timeline (${scene.timeline.durationFrames} frames ` +
            `at ${scene.timeline.fps} fps). Evaluating anyway; values hold at their last keyframe.`
        };
      }

      const evaluated = evaluateSceneAtFrame(scene, frame);
      const filter = object_ids?.length ? new Set(object_ids) : undefined;
      const objects = evaluated.objects.filter((object) => !filter || filter.has(object.id));

      const data = {
        scene_id: scene.id,
        frame,
        fps: scene.timeline.fps,
        objects: objects.map((object) => ({
          id: object.id,
          name: object.name,
          type: object.type,
          x: object.x,
          y: object.y,
          width: object.width,
          height: object.height,
          rotation: object.rotation,
          opacity: object.opacity,
          visible: object.visible,
          ...(object.type === "text" ? { text: object.text } : {})
        }))
      };

      const markdown = lines(
        heading(1, `${scene.name} at frame ${frame}`),
        `${scene.timeline.fps} fps · ${scene.timeline.durationFrames} frames`,
        "",
        table(data.objects, [
          { label: "Id", value: (object) => object.id },
          { label: "Name", value: (object) => object.name },
          { label: "Type", value: (object) => object.type },
          { label: "x,y", value: (object) => `${object.x},${object.y}` },
          { label: "Opacity", value: (object) => object.opacity },
          { label: "Visible", value: (object) => object.visible }
        ])
      );

      return present(response_format, markdown, data, "Restrict with `object_ids`.");
    }
  }),

  defineTool({
    name: "create_scene",
    title: "Create a scene",
    description: `Create a new, empty authoring scene and store it.

The scene is created with square pixels, a progressive timeline and a transparent background — the correct defaults for broadcast graphics, where the graphic is keyed over video rather than composited onto a colour.

Args:
  - name (string): scene name, 1-180 characters.
  - width (number), height (number): canvas size in pixels (default: 1920 x 1080).
  - background (string): CSS colour (default: '#00000000', fully transparent).
  - fps (number): frame rate (default: 50).
  - duration_frames (number): timeline length (default: two seconds at the chosen fps).

Returns:
  JSON shape: { ok: true, scene: { id, name, revision, objectCount, ... } }

The returned id is what every other scene tool takes. Add content with grapix_editor_add_object.`,
    inputSchema: z
      .object({
        name: z.string().min(1).max(180).describe("Scene name."),
        width: z.number().int().min(16).max(50_000).default(1920).describe("Canvas width in pixels."),
        height: z.number().int().min(16).max(50_000).default(1080).describe("Canvas height in pixels."),
        background: z
          .string()
          .max(64)
          .default("#00000000")
          .describe("Canvas background colour. Default is fully transparent, for keying over video."),
        fps: z.number().min(1).max(120).default(50).describe("Timeline frame rate."),
        duration_frames: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .optional()
          .describe("Timeline length in frames. Defaults to two seconds.")
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler({ name, width, height, background, fps, duration_frames }, { client }) {
      const scene = createSceneDocument({
        name,
        width,
        height,
        background,
        fps,
        durationFrames: duration_frames
      });
      const summary = await saveScene(client, scene);

      return {
        text: lines(
          heading(1, `Created "${summary.name}"`),
          "",
          `- **Id**: \`${summary.id}\``,
          `- **Revision**: ${summary.revision}`,
          `- **Canvas**: ${width} x ${height}`,
          `- **Timeline**: ${fps} fps, ${scene.timeline.durationFrames} frames`,
          "",
          "Add content with grapix_editor_add_object."
        ),
        data: { ok: true, scene: summary as unknown as Record<string, unknown> }
      };
    }
  }),

  defineTool({
    name: "update_scene_settings",
    title: "Update scene canvas, timeline and camera",
    description: `Change a scene's name, canvas, timeline or active camera.

This changes settings only. It never moves objects: converting a template's canvas is not the same operation as conforming it, and scaling scene content to a new resolution is an authoring decision with three different correct answers (fit, stretch, canvas-only). If you need content scaled, say so explicitly and move the objects yourself.

Args:
  - scene_id (string): the scene id.
  - expected_revision (number): the revision you read; the write is refused if it moved.
  - name (string), width (number), height (number), background (string): canvas settings.
  - fps (number), duration_frames (number): timeline settings.
  - active_camera_id (string): id of a camera object in this scene.

Returns:
  JSON shape: { ok: true, scene: { id, name, revision, ... }, changed: string[] }`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        expected_revision: expectedRevisionField,
        name: z.string().min(1).max(180).optional(),
        width: z.number().int().min(16).max(50_000).optional(),
        height: z.number().int().min(16).max(50_000).optional(),
        background: z.string().max(64).optional(),
        fps: z.number().min(1).max(120).optional(),
        duration_frames: z.number().int().min(1).max(1_000_000).optional(),
        active_camera_id: z.string().max(128).optional()
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler(args, { client }) {
      const changed: string[] = [];

      const { summary } = await mutateScene(
        client,
        args.scene_id,
        args.expected_revision,
        (scene) => {
          const next = { ...scene };
          if (args.name !== undefined) {
            next.name = args.name;
            changed.push("name");
          }
          if (args.width !== undefined || args.height !== undefined || args.background !== undefined) {
            next.canvas = {
              ...next.canvas,
              ...(args.width !== undefined ? { width: args.width } : {}),
              ...(args.height !== undefined ? { height: args.height } : {}),
              ...(args.background !== undefined ? { background: args.background } : {})
            };
            changed.push("canvas");
          }
          if (args.fps !== undefined || args.duration_frames !== undefined) {
            next.timeline = {
              ...next.timeline,
              ...(args.fps !== undefined
                ? { fps: args.fps, frameRate: { numerator: args.fps, denominator: 1 } }
                : {}),
              ...(args.duration_frames !== undefined ? { durationFrames: args.duration_frames } : {})
            };
            changed.push("timeline");
          }
          if (args.active_camera_id !== undefined) {
            const camera = next.objects.find(
              (object) => object.id === args.active_camera_id && object.type === "camera"
            );
            if (!camera) {
              throw new Error(
                `"${args.active_camera_id}" is not a camera object in this scene. Cameras: ` +
                  (next.objects
                    .filter((object) => object.type === "camera")
                    .map((object) => object.id)
                    .join(", ") || "none")
              );
            }
            next.activeCameraId = args.active_camera_id;
            changed.push("activeCameraId");
          }
          return next;
        }
      );

      if (changed.length === 0) {
        return { text: "No settings were supplied, so nothing changed." };
      }

      return {
        text: `Updated ${changed.join(", ")} on "${summary.name}". Revision is now ${summary.revision}.`,
        data: { ok: true, scene: summary as unknown as Record<string, unknown>, changed }
      };
    }
  }),

  defineTool({
    name: "replace_scene",
    title: "Replace a whole scene document",
    description: `Store a complete SceneDocument, replacing the stored one.

This is the escape hatch for edits the targeted tools do not cover. It overwrites everything, so prefer add_object / update_object / update_material for ordinary changes — they preserve the parts you did not touch.

The project service keeps a backup of the previous revision before every write, and grapix_editor_recover_scene restores it.

Args:
  - scene (object): a complete SceneDocument. \`version\` must be 1; \`id\` must match an existing scene, or a new one is created.
  - expected_revision (number): the revision you read; the write is refused if it moved.

Returns:
  JSON shape: { ok: true, scene: { id, name, revision, objectCount, ... } }

Error handling: the project service validates the document and returns the specific structural failure; a bad object type or missing required field is rejected rather than stored.`,
    inputSchema: z
      .object({
        scene: z
          .record(z.unknown())
          .describe("A complete SceneDocument object. See the grapix://contract/scene resource."),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: { ...WRITE, destructiveHint: true },
    async handler({ scene, expected_revision }, { client }) {
      const document = scene as unknown as SceneDocument;

      if (document.version !== 1) {
        return {
          text: `SceneDocument.version must be 1, received ${JSON.stringify(document.version)}.`
        };
      }
      if (typeof document.id !== "string" || !document.id) {
        return { text: "SceneDocument.id is required. Use grapix_editor_create_scene for a new scene." };
      }

      if (expected_revision !== undefined) {
        const current = await readScene(client, document.id);
        if ((current.revision ?? 0) !== expected_revision) {
          return {
            text:
              `The scene is at revision ${current.revision ?? 0}, not ${expected_revision}. ` +
              "Re-read it, reapply the change, and pass the new revision."
          };
        }
      }

      const summary = await saveScene(client, {
        ...document,
        updatedAt: new Date().toISOString()
      });

      return {
        text: `Replaced "${summary.name}" (\`${summary.id}\`). Revision is now ${summary.revision}.`,
        data: { ok: true, scene: summary as unknown as Record<string, unknown> }
      };
    }
  }),

  defineTool({
    name: "recover_scene",
    title: "Recover a scene from its last backup",
    description: `Restore a scene from the backup the project service wrote before its most recent change.

Every scene write is preceded by a backup, so this undoes the last save. It creates a new revision rather than rewinding the counter, so the recovery itself is auditable.

Args:
  - scene_id (string): the scene id.

Returns:
  JSON shape: { ok: true, recovered: true, scene: { id, name, revision, ... } }

Error handling: returns "No scene backup is available" when the scene has never been overwritten.`,
    inputSchema: z.object({ scene_id: sceneIdField }).strict(),
    mutates: true,
    annotations: { ...WRITE, destructiveHint: true },
    async handler({ scene_id }, { client }) {
      const response = await client.request<{ ok: boolean; scene: SceneDocument; recovered: boolean }>(
        `/api/scenes/${encodeURIComponent(scene_id)}/recover`,
        { method: "POST" }
      );

      return {
        text:
          `Recovered "${response.scene.name}" from backup. It is now revision ` +
          `${response.scene.revision ?? 0} with ${response.scene.objects.length} objects.`,
        data: { ok: true, recovered: true, scene: sceneOverview(response.scene) }
      };
    }
  })
];
