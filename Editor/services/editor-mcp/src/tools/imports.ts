/**
 * Structured import tools: 3D models, media, design files, Figma and scene
 * scripts.
 *
 * Each of these returns a **compatibility report** as well as an asset, and the
 * report is the point. A glTF that exceeds the Program budget, a video whose
 * alpha mode cannot be determined, a Photoshop layer effect with no GrapiX
 * equivalent — all of them import successfully and then look wrong on air. The
 * tools surface the report rather than reducing the result to "imported".
 */

import { z } from "zod";
import { fileSourceFields, readSource } from "../fileSource.js";
import { heading, lines } from "../format.js";
import { defineTool, responseFormatField, present, type RegisteredEditorTool } from "../toolkit.js";

const IMPORT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

interface ImportResponse {
  ok: boolean;
  asset?: { assetId: string; fileName: string; mimeType: string; sizeBytes: number; checksum: string };
  report?: Record<string, unknown>;
  result?: Record<string, unknown>;
  script?: Record<string, unknown>;
}

function reportSummary(report: Record<string, unknown> | undefined): string {
  if (!report) return "_No report returned._";
  return `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

export const importTools: RegisteredEditorTool[] = [
  defineTool({
    name: "import_model",
    title: "Import a glTF/GLB 3D model",
    description: `Import a glTF or GLB model, checked against a render profile budget.

The importer inspects the model before storing it and reports triangle count, material elements, texture sizes and anything that exceeds the chosen profile. A model that fails inspection is rejected (422) rather than stored — an over-budget mesh on Program costs frames, and finding that out at air time is not acceptable.

Args:
  - file_path (string) or file_base64 + file_name (string): the .gltf or .glb file.
  - profile ('PROGRAM_HD' | 'PROGRAM_UHD' | 'CUSTOM'): budget to check against (default: 'PROGRAM_HD').
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok, asset: { assetId, ... }, report: { accepted, triangles, materials, warnings, ... } }

The report lists the model's material elements. Those become independently bindable faces on a mesh object — see grapix_editor_assign_material.`,
    inputSchema: z
      .object({
        ...fileSourceFields,
        profile: z
          .enum(["PROGRAM_HD", "PROGRAM_UHD", "CUSTOM"])
          .default("PROGRAM_HD")
          .describe("Render profile whose budget the model is checked against."),
        response_format: responseFormatField
      })
      .strict(),
    mutates: true,
    annotations: IMPORT,
    async handler(args, context) {
      const { bytes, fileName } = await readSource(args, context);
      const response = await context.client.request<ImportResponse>("/api/import/model", {
        method: "POST",
        long: true,
        binary: { bytes },
        query: { fileName, profile: args.profile }
      });

      return present(
        args.response_format,
        lines(
          heading(1, `Imported model "${fileName}"`),
          `Asset \`${response.asset?.assetId}\` · profile ${args.profile}`,
          "",
          heading(2, "Compatibility report"),
          reportSummary(response.report)
        ),
        response as unknown as Record<string, unknown>,
        "Use response_format: 'json' and read the report fields you need."
      );
    }
  }),

  defineTool({
    name: "import_media",
    title: "Import a video or media file",
    description: `Import a video file and report its codec, alpha and audio characteristics.

Alpha handling matters here. Broadcast transparency is fill and key — a separate greyscale key signal, not an alpha channel on the wire — so the report tells you whether the source carries usable transparency and how it will be interpreted. A file whose alpha mode cannot be determined is reported as 'unknown' rather than assumed.

Args:
  - file_path (string) or file_base64 + file_name (string): the media file.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok, asset: {...}, report: { codec, width, height, frameRate, hasAlpha, hasAudio, warnings } }`,
    inputSchema: z.object({ ...fileSourceFields, response_format: responseFormatField }).strict(),
    mutates: true,
    annotations: IMPORT,
    async handler(args, context) {
      const { bytes, fileName } = await readSource(args, context);
      const response = await context.client.request<ImportResponse>("/api/import/media", {
        method: "POST",
        long: true,
        binary: { bytes, contentType: "video/mp4" },
        query: { fileName }
      });

      return present(
        args.response_format,
        lines(
          heading(1, `Imported media "${fileName}"`),
          `Asset \`${response.asset?.assetId}\``,
          "",
          heading(2, "Report"),
          reportSummary(response.report)
        ),
        response as unknown as Record<string, unknown>,
        "Use response_format: 'json'."
      );
    }
  }),

  defineTool({
    name: "import_design_file",
    title: "Import a PSD, AI/PDF, SVG or exported Figma file",
    description: `Import a design file and convert it into GrapiX objects, with a compatibility report.

Accepts Photoshop (.psd), Illustrator/PDF (.ai, .pdf), SVG, and exported Figma JSON. Text, shapes, paths, groups and images convert to native objects; effects and features with no GrapiX equivalent are listed in the report rather than approximated silently.

The result is a converted document — it is not yet a stored scene. Review the report, then store it with grapix_editor_replace_scene or build a scene from the converted objects.

Args:
  - file_path (string) or file_base64 + file_name (string): the design file.
  - options (object): importer options. Supported keys: preserveHierarchy, keepTextEditable, importHiddenLayers, assetMode ("embed" | "link"), convertComponents, missingFontPolicy ("preserve-name" | "replace"), replacementFontFamily, unsupportedFeaturePolicy ("closest-editable" | "nested-composition" | "rasterize-layer"), scale, targetWidth, targetHeight, selectedPageIds, selectedNodeIds. Unknown keys are rejected.
  - response_format ('markdown' | 'json'): output format (default: 'json' is usually more useful).

Returns:
  JSON shape: { ok, result: { document, report: { converted, skipped, warnings } } }

Error handling: an unsupported or corrupt file returns 422 DESIGN_IMPORT_FAILED with the parser's reason.`,
    inputSchema: z
      .object({
        ...fileSourceFields,
        options: z.record(z.unknown()).optional().describe("Strict DesignImportOptions object; unknown keys are rejected by the API."),
        response_format: responseFormatField
      })
      .strict(),
    mutates: true,
    annotations: IMPORT,
    async handler(args, context) {
      const { bytes, fileName } = await readSource(args, context);
      const response = await context.client.request<ImportResponse>("/api/import/design-file", {
        method: "POST",
        long: true,
        binary: { bytes },
        query: {
          fileName,
          options: args.options ? JSON.stringify(args.options) : undefined
        }
      });

      return present(
        args.response_format,
        lines(
          heading(1, `Imported design file "${fileName}"`),
          "",
          reportSummary(response.result)
        ),
        response as unknown as Record<string, unknown>,
        "Use response_format: 'json' and read `result.report` first."
      );
    }
  }),

  defineTool({
    name: "import_figma",
    title: "Import a Figma link",
    description: `Import a Figma design/Dev Mode link, either as native document JSON over the REST API (editable layers) or through the local Figma Desktop MCP server (screenshot, no token).

The file key and node ids are extracted from the link, so paste it as copied. Branch, /file, /proto and /board links all work, and a bare file key is accepted.

Args:
  - source (object): { "url": "https://www.figma.com/design/<key>/<name>?node-id=1-2", "nodeIds": ["3:4"], "transport": "auto" | "rest" | "desktop-mcp", "accessToken": "figd_...", "tokenKind": "personal" | "oauth" }.
    url is required. nodeIds are unioned with IDs in the link (explicit IDs first; duplicates removed). With no IDs, REST imports the whole file; Desktop MCP rejects the request rather than importing the current Figma selection. Desktop MCP also verifies the linked file key when its metadata exposes one and reports unverified provenance otherwise.
    transport defaults to "auto": REST when a token is available, Desktop MCP otherwise.
    accessToken is used for this request only and is never stored; FIGMA_ACCESS_TOKEN on the project service works instead.
  - options (object): importer options.
  - response_format ('markdown' | 'json'): output format (default: 'json').

Returns:
  JSON shape: { ok, result: { document, scenes, report } }

Transport differences that matter: **REST** returns Figma's own document JSON, so text stays text, vectors stay paths (geometry=paths), components/auto-layout/effects survive, and image fills resolve through /v1/files/:key/images; it needs a token with the file_content:read scope. **Desktop MCP** (127.0.0.1:3845, Figma Desktop in Dev Mode) needs no token but exposes only sparse XML and a rendered screenshot, so each node arrives as one image and the report records the raster fallback. Asking for transport "rest" without a token fails with that explanation rather than silently rasterizing.`,
    inputSchema: z
      .object({
        source: z.record(z.unknown()).describe("Figma source descriptor."),
        options: z.record(z.unknown()).optional().describe("Design importer options."),
        response_format: responseFormatField
      })
      .strict(),
    mutates: true,
    annotations: IMPORT,
    async handler(args, { client }) {
      const response = await client.request<ImportResponse>("/api/import/figma", {
        method: "POST",
        long: true,
        json: { source: args.source, options: args.options }
      });

      return present(
        args.response_format,
        lines(heading(1, "Imported from Figma"), "", reportSummary(response.result)),
        response as unknown as Record<string, unknown>,
        "Use response_format: 'json'."
      );
    }
  }),

  defineTool({
    name: "import_scene_script",
    title: "Import a scene script",
    description: `Import a JavaScript scene script, statically inspected against the SDK trust boundary.

Scripts run in a control sandbox with declared permissions — they can read and write scene data and respond to events, they cannot reach the renderer, the network or the file system. The source is parsed into an AST (TypeScript compiler) and walked for forbidden globals and APIs, including computed access such as globalThis['pro'+'cess'] — it is not a regex over the raw text. Inspection is a strong static gate, not a proof: it rejects the known escape hatches before the script is ever stored, and the sandbox is the second line of defense.

Args:
  - file_path (string) or file_base64 + file_name (string): the .js/.mjs file.
  - permissions (string): comma-separated permissions to request, e.g. "read-scene-data,write-scene-data".
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok, asset: {...}, script: { scriptId, apiVersion, checksum, permissions, execution }, report: { accepted, findings } }

Error handling: a rejected script returns 422 with the specific finding — an unpermitted global, an unsupported import, a disallowed API.`,
    inputSchema: z
      .object({
        ...fileSourceFields,
        permissions: z
          .string()
          .max(500)
          .optional()
          .describe("Comma-separated SceneScriptPermission values to request."),
        response_format: responseFormatField
      })
      .strict(),
    mutates: true,
    annotations: IMPORT,
    async handler(args, context) {
      const { bytes, fileName } = await readSource(args, context);
      const response = await context.client.request<ImportResponse>("/api/import/scene-script", {
        method: "POST",
        long: true,
        binary: { bytes, contentType: "application/javascript" },
        query: { fileName, permissions: args.permissions }
      });

      return present(
        args.response_format,
        lines(
          heading(1, `Imported scene script "${fileName}"`),
          `Script \`${String(response.script?.scriptId ?? "")}\` · asset \`${response.asset?.assetId}\``,
          "",
          heading(2, "Inspection report"),
          reportSummary(response.report)
        ),
        response as unknown as Record<string, unknown>,
        "Use response_format: 'json'."
      );
    }
  }),

  defineTool({
    name: "inspect_after_effects_import",
    title: "Check an After Effects import path",
    description: `Check whether an After Effects composition can be brought into GrapiX, and by which route.

There is no direct .aep import. The supported routes are Lottie, an alpha video, an image-sequence manifest, or a structured GrapiX conversion. This tool inspects a candidate and reports which route applies and what would be lost.

Args:
  - file_name (string): the file being considered, e.g. "titles.json" or "titles.aep".
  - body (object): optional parsed contents to inspect (e.g. Lottie JSON).
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { ok, report: { accepted, route, findings }, approvedPaths: string[] }

This inspects only. It stores nothing.`,
    inputSchema: z
      .object({
        file_name: z.string().min(1).max(255).describe("File name being considered."),
        body: z.record(z.unknown()).optional().describe("Parsed file contents to inspect."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(args, { client }) {
      const response = await client.request<ImportResponse & { approvedPaths: string[] }>(
        "/api/import/after-effects",
        { method: "POST", json: args.body ?? {}, query: { fileName: args.file_name } }
      );

      return present(
        args.response_format,
        lines(
          heading(1, `After Effects import check: ${args.file_name}`),
          "",
          `Approved routes: ${response.approvedPaths.join(", ")}`,
          "",
          heading(2, "Report"),
          reportSummary(response.report)
        ),
        response as unknown as Record<string, unknown>,
        "Use response_format: 'json'."
      );
    }
  })
];
