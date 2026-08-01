/**
 * Asset, font and import tools.
 *
 * Import is two steps on purpose, and the tools keep them separate: the project
 * service stores bytes in the content-addressed asset store, and a scene then
 * references that stored asset in its own library. Collapsing them would make
 * "import once, use in three scenes" impossible to express, and the store's
 * reference counting is what decides when bytes may be evicted.
 */

import { z } from "zod";
import type { AssetLibraryItem, FontDefinition, SceneDocument } from "@grapix/shared-types";
import { findAssetUsageDetails, validateFontDefinition } from "@grapix/shared-types";
import { fileSourceFields, readSource } from "../fileSource.js";
import { heading, lines, paginate, table } from "../format.js";
import { mutateScene, readScene } from "../sceneOps.js";
import {
  defineTool,
  limitField,
  offsetField,
  present,
  responseFormatField,
  type RegisteredEditorTool
} from "../toolkit.js";
import { expectedRevisionField, sceneIdField } from "./scenes.js";

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

interface StoredAssetRecord {
  assetId: string;
  fileName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  importedAt: string;
  duplicate: boolean;
  referenceCount: number;
  referencedByScenes: string[];
}

function describeStoredAsset(record: StoredAssetRecord): Record<string, unknown> {
  return {
    asset_id: record.assetId,
    file_name: record.fileName,
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    checksum: record.checksum,
    imported_at: record.importedAt,
    duplicate: record.duplicate,
    reference_count: record.referenceCount,
    referenced_by_scenes: record.referencedByScenes,
    content_url: `/api/assets/${record.assetId}/content`
  };
}

export const assetTools: RegisteredEditorTool[] = [
  defineTool({
    name: "import_asset",
    title: "Import a file into the asset store",
    description: `Import an image, video, font, script or shader file into the Editor's content-addressed asset store.

Assets are addressed by the SHA-256 of their bytes, so importing the same file twice returns the existing record with duplicate: true instead of storing it again.

This stores the file. It does not add it to a scene — call grapix_editor_add_scene_asset for that, then bind it to a material or an image object.

Args:
  - file_path (string): absolute path, or a path relative to the GrapiX repository root.
  - file_base64 (string) + file_name (string): the bytes directly, when they are not on disk.
  - mime_type (string): content type. Inferred from the extension when omitted.
  - replace_asset_id (string): overwrite an existing asset record in place, keeping its id and every reference to it.

Returns:
  JSON shape: { ok: true, asset: { asset_id, file_name, mime_type, size_bytes, checksum, duplicate, reference_count, content_url } }

Error handling: files that fail import validation are rejected with the specific reason (415), not stored silently.`,
    inputSchema: z
      .object({
        ...fileSourceFields,
        mime_type: z.string().max(180).optional().describe("Content type, e.g. 'image/png'."),
        replace_asset_id: z
          .string()
          .max(128)
          .optional()
          .describe("Replace this existing asset's bytes, keeping its id.")
      })
      .strict(),
    mutates: true,
    annotations: { ...WRITE, openWorldHint: true },
    async handler(args, context) {
      const { bytes, fileName } = await readSource(args, context);
      const response = await context.client.request<{ ok: boolean; asset: StoredAssetRecord }>(
        "/api/assets/import",
        {
          method: "POST",
          long: true,
          binary: { bytes, contentType: args.mime_type ?? "application/octet-stream" },
          query: {
            fileName,
            mimeType: args.mime_type,
            replaceAssetId: args.replace_asset_id
          }
        }
      );

      const asset = response.asset;
      return {
        text: lines(
          asset.duplicate
            ? `"${fileName}" is already in the asset store as \`${asset.assetId}\` (identical checksum).`
            : `Imported "${fileName}" as \`${asset.assetId}\`.`,
          "",
          `- **Size**: ${asset.sizeBytes} bytes`,
          `- **Type**: ${asset.mimeType}`,
          `- **Checksum**: ${asset.checksum}`,
          `- **Referenced by**: ${asset.referenceCount} scene(s)`,
          "",
          "Add it to a scene with grapix_editor_add_scene_asset."
        ),
        data: { ok: true, asset: describeStoredAsset(asset) }
      };
    }
  }),

  defineTool({
    name: "get_asset",
    title: "Read an asset record",
    description: `Read a stored asset's metadata: file name, type, size, checksum, and which scenes reference it.

The bytes themselves are available through the \`grapix://asset/{asset_id}\` resource, so a large binary is never forced into a tool result.

Args:
  - asset_id (string): the stored asset id.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { asset_id, file_name, mime_type, size_bytes, checksum, imported_at, reference_count, referenced_by_scenes, content_url }`,
    inputSchema: z
      .object({
        asset_id: z.string().min(1).max(128).describe("Stored asset id."),
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ asset_id, response_format }, { client }) {
      const record = await client.request<StoredAssetRecord>(
        `/api/assets/${encodeURIComponent(asset_id)}`
      );
      const data = describeStoredAsset(record);

      return present(
        response_format,
        lines(
          heading(1, record.fileName),
          `\`${record.assetId}\``,
          "",
          `- **Type**: ${record.mimeType}`,
          `- **Size**: ${record.sizeBytes} bytes`,
          `- **Checksum**: ${record.checksum}`,
          `- **Imported**: ${record.importedAt}`,
          `- **Referenced by**: ${record.referencedByScenes.join(", ") || "no scene"}`,
          "",
          `Read the bytes via the resource \`grapix://asset/${record.assetId}\`.`
        ),
        data,
        "This is a single record."
      );
    }
  }),

  defineTool({
    name: "list_scene_assets",
    title: "List a scene's asset library",
    description: `List the assets a scene references, with the materials and objects that use each one.

A scene's asset library is separate from the asset store: the store holds bytes, the library is this scene's references to them. An asset in the library that is not used by any material or object is dead weight in the published package.

Args:
  - scene_id (string): the scene id.
  - kind (string): filter by asset kind, e.g. 'image', 'video', 'font', 'model'.
  - limit (number), offset (number): paging.
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { scene_id, total, assets: [{ asset_id, name, kind, mime_type, status, used_by_material_ids, used_by_object_ids }] }`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        kind: z.string().max(32).optional().describe("Filter by AssetKind."),
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, kind, limit, offset, response_format }, { client }) {
      const scene = await readScene(client, scene_id);
      const filtered = scene.assets.filter((asset) => !kind || asset.kind === kind);
      const page = paginate(filtered, offset, limit);

      if (page.total === 0) {
        return {
          text:
            scene.assets.length === 0
              ? `"${scene.name}" references no assets.`
              : `No asset of kind "${kind}". Kinds present: ${[
                  ...new Set(scene.assets.map((asset) => asset.kind))
                ].join(", ")}.`
        };
      }

      const withUsage = page.items.map((asset) => {
        const usage = findAssetUsageDetails(scene, asset.assetId);
        return {
          asset_id: asset.assetId,
          name: asset.name,
          kind: asset.kind,
          mime_type: asset.mimeType,
          size_bytes: asset.sizeBytes,
          status: asset.status,
          storage_asset_id: asset.storageAssetId,
          used_by_material_ids: usage.materialIds,
          used_by_object_ids: usage.objectIds
        };
      });

      const data = {
        scene_id: scene.id,
        total: page.total,
        count: page.count,
        offset: page.offset,
        has_more: page.has_more,
        next_offset: page.next_offset,
        assets: withUsage
      };

      const markdown = lines(
        heading(1, `Assets in ${scene.name}`),
        "",
        table(withUsage, [
          { label: "Id", value: (asset) => asset.asset_id },
          { label: "Name", value: (asset) => asset.name },
          { label: "Kind", value: (asset) => asset.kind },
          { label: "Status", value: (asset) => asset.status ?? "—" },
          {
            label: "Used by",
            value: (asset) =>
              asset.used_by_material_ids.length + asset.used_by_object_ids.length || "unused"
          }
        ])
      );

      return present(response_format, markdown, data, "Filter with `kind` or lower `limit`.");
    }
  }),

  defineTool({
    name: "add_scene_asset",
    title: "Add a stored asset to a scene's library",
    description: `Reference a stored asset from a scene, so materials and objects in that scene can use it.

Args:
  - scene_id (string): the scene id.
  - asset_id (string): id from grapix_editor_import_asset.
  - name (string): display name in the scene library (defaults to the stored file name).
  - kind (string): image, video, font, model, script, shader or other. Inferred from the mime type when omitted.
  - expected_revision (number): the revision you read.

Returns:
  JSON shape: { ok: true, asset: { assetId, name, kind, source }, scene: { id, revision, assetCount } }

The scene stores a reference, not a copy. Deleting the scene does not delete the bytes; the store's reference count tracks that.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        asset_id: z.string().min(1).max(128).describe("Stored asset id."),
        name: z.string().max(180).optional().describe("Display name inside the scene library."),
        kind: z
          .enum(["image", "video", "font", "model", "script", "shader", "audio", "other"])
          .optional()
          .describe("Asset kind. Inferred from the mime type when omitted."),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler(args, { client }) {
      const record = await client.request<StoredAssetRecord>(
        `/api/assets/${encodeURIComponent(args.asset_id)}`
      );

      const kind =
        args.kind ??
        (record.mimeType.startsWith("image/")
          ? "image"
          : record.mimeType.startsWith("video/")
            ? "video"
            : record.mimeType.startsWith("font/")
              ? "font"
              : record.mimeType.includes("gltf")
                ? "model"
                : record.mimeType.includes("javascript")
                  ? "script"
                  : "other");

      let entry: AssetLibraryItem | undefined;

      const { summary } = await mutateScene(
        client,
        args.scene_id,
        args.expected_revision,
        (scene: SceneDocument) => {
          if (scene.assets.some((asset) => asset.assetId === args.asset_id)) {
            throw new Error(
              `"${args.asset_id}" is already in this scene's asset library. Use it directly.`
            );
          }

          entry = {
            assetId: record.assetId,
            storageAssetId: record.assetId,
            name: args.name ?? record.fileName,
            kind: kind as AssetLibraryItem["kind"],
            source: `/api/assets/${record.assetId}/content`,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
            checksum: record.checksum,
            importedAt: record.importedAt,
            status: "READY"
          };

          return { ...scene, assets: [...scene.assets, entry] };
        }
      );

      return {
        text: lines(
          `Added \`${record.assetId}\` ("${entry?.name}") to "${summary.name}" as a ${kind} asset.`,
          "",
          `Scene revision is now ${summary.revision}; ${summary.assetCount} asset(s) referenced.`,
          kind === "image"
            ? "Bind it with grapix_editor_create_material (base_texture_asset_id) or on an image object's `src`."
            : undefined
        ),
        data: {
          ok: true,
          asset: entry as unknown as Record<string, unknown>,
          scene: { id: summary.id, revision: summary.revision, assetCount: summary.assetCount }
        }
      };
    }
  }),

  defineTool({
    name: "import_font",
    title: "Import a font file",
    description: `Import an OTF, TTF, WOFF or WOFF2 font into the asset store and build its font definition.

The font's family, weight and style are read from the file's own metadata, so they match what the renderers will use. Supplied values override the metadata.

Args:
  - file_path (string) or file_base64 + file_name (string): the font file.
  - family (string): override the family name.
  - display_name (string): override the display name.
  - weight (number): 100-900.
  - style ('normal' | 'italic' | 'oblique').
  - license (string): licence note carried with the font.

Returns:
  JSON shape: { ok: true, asset: {...}, font: { fontId, family, displayName, weight, style, faces } }

Fonts must be embedded in the published package: a scene that references a font the render machine does not have is a graphic that renders in a fallback face on air.`,
    inputSchema: z
      .object({
        ...fileSourceFields,
        family: z.string().max(180).optional(),
        display_name: z.string().max(180).optional(),
        weight: z.number().int().min(1).max(1000).optional(),
        style: z.enum(["normal", "italic", "oblique"]).optional(),
        license: z.string().max(500).optional()
      })
      .strict(),
    mutates: true,
    annotations: { ...WRITE, openWorldHint: true },
    async handler(args, context) {
      const { bytes, fileName } = await readSource(args, context);
      const response = await context.client.request<{
        ok: boolean;
        asset: StoredAssetRecord;
        font: Record<string, unknown>;
      }>("/api/fonts/import", {
        method: "POST",
        long: true,
        binary: { bytes },
        query: {
          fileName,
          family: args.family,
          displayName: args.display_name,
          weight: args.weight,
          style: args.style,
          license: args.license
        }
      });

      return {
        text: lines(
          `Imported font "${fileName}".`,
          "",
          `- **Asset**: \`${response.asset.assetId}\``,
          `- **Family**: ${String(response.font.family)}`,
          `- **Definition**: \`${String(response.font.fontId ?? "")}\``,
          "",
          "Add it to a scene with grapix_editor_add_scene_font, then set a text object's `fontId`."
        ),
        data: { ok: true, asset: describeStoredAsset(response.asset), font: response.font }
      };
    }
  }),

  defineTool({
    name: "resolve_remote_font",
    title: "Resolve and cache a remote font",
    description: `Resolve a web font CSS URL (Google Fonts and other trusted hosts) into downloaded, cached font files plus a GrapiX font definition.

The files are fetched and stored locally, so the published package carries the actual font rather than a URL the render machine may not be able to reach.

Args:
  - url (string): the font CSS URL.
  - family (string): family to resolve, when the CSS declares several.
  - weights (number[]): weights to fetch.

Returns:
  JSON shape: { ok: true, font: {...}, assets: [...] }

Error handling: an untrusted host is refused (422 FONT_RESOLUTION_FAILED) rather than fetched.`,
    inputSchema: z
      .object({
        url: z.string().url().max(2048).describe("Font CSS URL."),
        family: z.string().max(180).optional(),
        weights: z.array(z.number().int().min(1).max(1000)).max(20).optional()
      })
      .strict(),
    mutates: true,
    annotations: { ...WRITE, openWorldHint: true },
    async handler(args, { client }) {
      const response = await client.request<Record<string, unknown>>("/api/fonts/resolve", {
        method: "POST",
        long: true,
        json: { url: args.url, family: args.family, weights: args.weights }
      });

      return {
        text: `Resolved fonts from ${args.url}.\n\n\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``,
        data: response
      };
    }
  }),

  defineTool({
    name: "add_scene_font",
    title: "Add a font definition to a scene",
    description: `Add a font definition to a scene's font list so text objects can reference it by \`fontId\`.

Args:
  - scene_id (string): the scene id.
  - font (object): a FontDefinition, as returned by import_font or resolve_remote_font.
  - expected_revision (number): the revision you read.

Returns:
  JSON shape: { ok: true, font_id, scene: { id, revision, fontCount } }

The definition is validated against the shared contract before it is stored; an invalid one is refused with the specific field.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        font: z.record(z.unknown()).describe("A FontDefinition object."),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler({ scene_id, font, expected_revision }, { client }) {
      const definition = font as unknown as FontDefinition;
      if (typeof definition?.fontId !== "string" || typeof definition?.family !== "string") {
        return {
          text:
            "A FontDefinition needs at least `fontId` and `family`. Pass the object returned by " +
            "grapix_editor_import_font or grapix_editor_resolve_remote_font unchanged."
        };
      }

      // Validated against the shared contract before it reaches the scene: a
      // font that fails here would otherwise fail at package preflight, long
      // after the write that introduced it.
      const scene = await readScene(client, scene_id);
      const errors = validateFontDefinition(definition, scene.assets);
      if (errors.length > 0) {
        return {
          text: lines("The font definition is not valid:", ...errors.map((error) => `- ${error}`)),
          data: { ok: false, errors }
        };
      }

      const { summary } = await mutateScene(client, scene_id, expected_revision, (current) => {
        const fonts = current.fonts ?? [];
        if (fonts.some((existing) => existing.fontId === definition.fontId)) {
          throw new Error(`Font "${definition.fontId}" is already in this scene.`);
        }
        return { ...current, fonts: [...fonts, definition] };
      });

      const stored = await readScene(client, scene_id);

      return {
        text:
          `Added font \`${definition.fontId}\` ("${definition.family}") to "${summary.name}". ` +
          `Scene revision is now ${summary.revision}.`,
        data: {
          ok: true,
          font_id: definition.fontId,
          scene: { id: summary.id, revision: summary.revision, fontCount: stored.fonts?.length ?? 0 }
        }
      };
    }
  })
];
