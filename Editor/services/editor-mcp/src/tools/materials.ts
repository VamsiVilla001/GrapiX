/**
 * Material tools.
 *
 * GrapiX has exactly one material model — a Standard (PBR) material. The other
 * type names in the contract are load-only wire aliases that normalise to it,
 * so `create_material` never offers a choice of model: offering one would
 * imply a second shading path that does not exist.
 */

import {
  createMaterialDefinition,
  findMaterialUsage,
  isMaterialCompatible,
  getBindableFaces,
  type Material,
  type SceneDocument
} from "@grapix/shared-types";
import { z } from "zod";
import { heading, lines, paginate, table } from "../format.js";
import { mutateScene, readScene, requireObject } from "../sceneOps.js";
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

const materialIdField = z
  .string()
  .min(1)
  .max(128)
  .describe("Material id, e.g. `mat_ab12cd34`. Get one from grapix_editor_list_materials.");

function describeMaterial(material: Material): Record<string, unknown> {
  return {
    material_id: material.materialId,
    name: material.name,
    type: material.type,
    readiness: material.readiness,
    opacity: material.opacity,
    blend_mode: material.blendMode,
    alpha_mode: material.alphaMode,
    cull_mode: material.cullMode,
    depth_mode: material.depthMode,
    double_sided: material.doubleSided,
    enabled: material.enabled,
    asset_id: material.assetId,
    shader_id: material.shaderId,
    parameters: material.parameters,
    texture_slots: material.textureSlots,
    dynamic: material.dynamic,
    binding: material.binding
  };
}

export const materialTools: RegisteredEditorTool[] = [
  defineTool({
    name: "list_materials",
    title: "List materials in a scene",
    description: `List a scene's materials with readiness, blend and alpha settings, and where each is used.

\`readiness\` matters at publish time: a material that is not READY (or does not have a declared fallback) fails package preflight and cannot be published.

Args:
  - scene_id (string): the scene id.
  - name_contains (string): case-insensitive name filter.
  - limit (number), offset (number): paging (default limit: 25).
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { scene_id, total, count, offset, has_more, materials: [{ material_id, name, type, readiness, blend_mode, alpha_mode, used_by_object_ids }] }`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        name_contains: z.string().max(180).optional(),
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, name_contains, limit, offset, response_format }, { client }) {
      const scene = await readScene(client, scene_id);
      const needle = name_contains?.toLowerCase();
      const filtered = scene.materials.filter(
        (material) => !needle || material.name.toLowerCase().includes(needle)
      );
      const page = paginate(filtered, offset, limit);

      if (page.total === 0) {
        return {
          text:
            scene.materials.length === 0
              ? `"${scene.name}" has no materials. Create one with grapix_editor_create_material.`
              : `No material name contains "${name_contains}". ${scene.materials.length} exist.`
        };
      }

      const withUsage = page.items.map((material) => ({
        ...describeMaterial(material),
        used_by_object_ids: findMaterialUsage(scene, material.materialId).objectIds
      }));

      const data = {
        scene_id: scene.id,
        revision: scene.revision ?? 0,
        total: page.total,
        count: page.count,
        offset: page.offset,
        has_more: page.has_more,
        next_offset: page.next_offset,
        materials: withUsage
      };

      const markdown = lines(
        heading(1, `Materials in ${scene.name}`),
        "",
        table(page.items, [
          { label: "Id", value: (material) => material.materialId },
          { label: "Name", value: (material) => material.name },
          { label: "Readiness", value: (material) => material.readiness },
          { label: "Blend", value: (material) => material.blendMode ?? "normal" },
          { label: "Alpha", value: (material) => material.alphaMode ?? "—" },
          {
            label: "Used by",
            value: (material) => findMaterialUsage(scene, material.materialId).objectIds.length
          }
        ]),
        "",
        page.has_more ? `Pass offset: ${page.next_offset} for more.` : `${page.total} shown.`
      );

      return present(response_format, markdown, data, "Lower `limit` or filter with `name_contains`.");
    }
  }),

  defineTool({
    name: "create_material",
    title: "Create a Standard Material",
    description: `Create a Standard (PBR) material in a scene.

GrapiX has one material model. The type is always the canonical PBR type — the other names in the contract are load-only aliases kept so old scenes still parse, and they normalise to the same model. There is no second shading path to choose.

Args:
  - scene_id (string): the scene id.
  - name (string): material name, 1-180 characters.
  - base_texture_asset_id (string): image asset to bind to the base texture slot.
  - base_color (string): base colour, e.g. '#f5b942'.
  - metalness (number), roughness (number), opacity (number): PBR parameters, 0 to 1.
  - emissive_color (string), emissive_intensity (number): emission.
  - blend_mode, alpha_mode, cull_mode, depth_mode (string): compositing. Check grapix_editor_describe_capabilities first — some declared blend modes are not implemented and composite as 'normal'.
  - double_sided (boolean).
  - expected_revision (number): the revision you read.

Returns:
  JSON shape: { ok: true, material: { material_id, name, type, readiness, ... }, scene: { id, revision } }

On alpha: broadcast transparency is fill and key, not an alpha channel on the wire. Authoring alpha here is correct; the engine splits it into fill and key for SDI.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        name: z.string().min(1).max(180).describe("Material name."),
        base_texture_asset_id: z
          .string()
          .max(128)
          .optional()
          .describe("Image asset id for the base texture slot."),
        base_color: z.string().max(64).optional().describe("Base colour, e.g. '#ffffff'."),
        metalness: z.number().min(0).max(1).optional(),
        roughness: z.number().min(0).max(1).optional(),
        opacity: z.number().min(0).max(1).optional(),
        emissive_color: z.string().max(64).optional(),
        emissive_intensity: z.number().min(0).max(100).optional(),
        blend_mode: z
          .string()
          .max(32)
          .optional()
          .describe("Blend mode. Verify it is implemented before using anything but 'normal'."),
        alpha_mode: z.string().max(32).optional(),
        cull_mode: z.enum(["none", "front", "back"]).optional(),
        depth_mode: z.enum(["disabled", "read", "read-write"]).optional(),
        double_sided: z.boolean().optional(),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler(args, { client, knowledge }) {
      const capabilities = await knowledge.capabilities();
      const warnings: string[] = [];

      if (args.blend_mode && capabilities.blendModes.unimplemented?.includes(args.blend_mode)) {
        warnings.push(
          `Blend mode "${args.blend_mode}" is declared by the contract but not implemented by the ` +
            "renderers; it will composite as `normal`."
        );
      }
      if (args.blend_mode && !capabilities.blendModes.declared.includes(args.blend_mode)) {
        return {
          text:
            `"${args.blend_mode}" is not a MaterialBlendMode. Valid values: ` +
            capabilities.blendModes.declared.join(", ")
        };
      }
      if (args.alpha_mode && !capabilities.alphaModes.declared.includes(args.alpha_mode)) {
        return {
          text:
            `"${args.alpha_mode}" is not a MaterialAlphaMode. Valid values: ` +
            capabilities.alphaModes.declared.join(", ")
        };
      }

      let created: Material | undefined;

      const { summary } = await mutateScene(
        client,
        args.scene_id,
        args.expected_revision,
        (scene: SceneDocument) => {
          if (args.base_texture_asset_id) {
            const asset = scene.assets.find(
              (candidate) => candidate.assetId === args.base_texture_asset_id
            );
            if (!asset) {
              throw new Error(
                `Asset "${args.base_texture_asset_id}" is not in this scene's asset library. ` +
                  "Import it first with grapix_editor_import_asset, then add it to the scene."
              );
            }
          }

          const material = createMaterialDefinition(args.name, {
            baseTextureAssetId: args.base_texture_asset_id
          });

          created = {
            ...material,
            ...(args.opacity !== undefined ? { opacity: args.opacity } : {}),
            ...(args.blend_mode ? { blendMode: args.blend_mode as Material["blendMode"] } : {}),
            ...(args.alpha_mode ? { alphaMode: args.alpha_mode as Material["alphaMode"] } : {}),
            ...(args.cull_mode ? { cullMode: args.cull_mode } : {}),
            ...(args.depth_mode ? { depthMode: args.depth_mode } : {}),
            ...(args.double_sided !== undefined ? { doubleSided: args.double_sided } : {}),
            parameters: {
              ...material.parameters,
              ...(args.base_color !== undefined ? { baseColor: args.base_color } : {}),
              ...(args.metalness !== undefined ? { metalness: args.metalness } : {}),
              ...(args.roughness !== undefined ? { roughness: args.roughness } : {}),
              ...(args.opacity !== undefined ? { opacity: args.opacity } : {}),
              ...(args.emissive_color !== undefined ? { emissiveColor: args.emissive_color } : {}),
              ...(args.emissive_intensity !== undefined
                ? { emissiveIntensity: args.emissive_intensity }
                : {})
            }
          };

          return { ...scene, materials: [...scene.materials, created] };
        }
      );

      return {
        text: lines(
          `Created material \`${created?.materialId}\` ("${args.name}") in "${summary.name}".`,
          ...warnings.map((warning) => `\n**Warning:** ${warning}`),
          "",
          `Scene revision is now ${summary.revision}.`,
          "Assign it with grapix_editor_assign_material."
        ),
        data: {
          ok: true,
          material: created ? describeMaterial(created) : undefined,
          warnings,
          scene: { id: summary.id, revision: summary.revision }
        }
      };
    }
  }),

  defineTool({
    name: "update_material",
    title: "Update a material",
    description: `Change a material's settings, leaving the rest of the scene untouched.

Uses the project service's targeted material patch route.

Args:
  - scene_id (string), material_id (string).
  - name, opacity, blend_mode, alpha_mode, cull_mode, depth_mode, double_sided, enabled: material settings.
  - parameters (object): PBR parameters to merge, e.g. { "baseColor": "#ff0000", "roughness": 0.2 }.
  - readiness (string): READY, FALLBACK_READY, MISSING or ERROR — normally set by the system, not by hand.

Returns:
  JSON shape: { ok: true, material: {...}, warnings: string[], scene: { id, revision } }

Warns when a supplied blend mode is declared but not implemented, because the material will then composite as 'normal' while reporting the value you set.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        material_id: materialIdField,
        name: z.string().min(1).max(180).optional(),
        opacity: z.number().min(0).max(1).optional(),
        blend_mode: z.string().max(32).optional(),
        alpha_mode: z.string().max(32).optional(),
        cull_mode: z.enum(["none", "front", "back"]).optional(),
        depth_mode: z.enum(["disabled", "read", "read-write"]).optional(),
        double_sided: z.boolean().optional(),
        enabled: z.boolean().optional(),
        parameters: z.record(z.unknown()).optional().describe("PBR parameters to merge."),
        readiness: z.string().max(32).optional()
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler(args, { client, knowledge }) {
      const scene = await readScene(client, args.scene_id);
      const existing = scene.materials.find(
        (material) => material.materialId === args.material_id
      );
      if (!existing) {
        return {
          text:
            `Scene "${scene.id}" has no material "${args.material_id}". Materials: ` +
            (scene.materials.map((material) => material.materialId).join(", ") || "none")
        };
      }

      const capabilities = await knowledge.capabilities();
      const warnings: string[] = [];
      if (args.blend_mode && capabilities.blendModes.unimplemented?.includes(args.blend_mode)) {
        warnings.push(
          `Blend mode "${args.blend_mode}" is declared but not implemented; it composites as \`normal\`.`
        );
      }

      const patch: Record<string, unknown> = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.opacity !== undefined ? { opacity: args.opacity } : {}),
        ...(args.blend_mode !== undefined ? { blendMode: args.blend_mode } : {}),
        ...(args.alpha_mode !== undefined ? { alphaMode: args.alpha_mode } : {}),
        ...(args.cull_mode !== undefined ? { cullMode: args.cull_mode } : {}),
        ...(args.depth_mode !== undefined ? { depthMode: args.depth_mode } : {}),
        ...(args.double_sided !== undefined ? { doubleSided: args.double_sided } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.readiness !== undefined ? { readiness: args.readiness } : {}),
        ...(args.parameters
          ? { parameters: { ...(existing.parameters ?? {}), ...args.parameters } }
          : {})
      };

      if (Object.keys(patch).length === 0) {
        return { text: "No settings were supplied, so nothing changed." };
      }

      const response = await client.request<{ ok: boolean; scene: SceneDocument }>(
        `/api/scenes/${encodeURIComponent(args.scene_id)}/materials/${encodeURIComponent(args.material_id)}`,
        { method: "PATCH", json: patch }
      );

      const updated = response.scene.materials.find(
        (material) => material.materialId === args.material_id
      );

      return {
        text: lines(
          `Updated material \`${args.material_id}\` in "${response.scene.name}".`,
          ...Object.keys(patch).map((key) => `- ${key} -> ${JSON.stringify(patch[key])}`),
          ...warnings.map((warning) => `\n**Warning:** ${warning}`),
          "",
          `Scene revision is now ${response.scene.revision ?? 0}.`
        ),
        data: {
          ok: true,
          material: updated ? describeMaterial(updated) : undefined,
          warnings,
          scene: { id: response.scene.id, revision: response.scene.revision ?? 0 }
        }
      };
    }
  }),

  defineTool({
    name: "assign_material",
    title: "Assign a material to an object face",
    description: `Bind a material to one of an object's material slots.

Objects expose named faces: a flat primitive has a single 'main' surface; a slab or extruded mesh exposes front/back/side caps; a glTF mesh exposes its imported material elements. Call with no \`slot\` to list the object's bindable faces first.

Compatibility is checked before writing — a material restricted to certain primitive types is refused for an incompatible object rather than silently ignored at render time.

Args:
  - scene_id (string), object_id (string).
  - material_id (string): the material to bind, or null to clear the slot.
  - slot (string): the face/slot name. Omit to list the object's faces.
  - expected_revision (number): the revision you read.

Returns:
  Face listing: { object_id, faces: [{ slot, label, kind, current_material_id }] }
  Assignment: { ok: true, object_id, slot, material_id, scene: { id, revision } }`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        object_id: z.string().min(1).max(128),
        material_id: z.string().max(128).nullable().optional().describe("Material id, or null to clear."),
        slot: z.string().max(64).optional().describe("Face/slot name. Omit to list the object's faces."),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler(args, { client }) {
      const scene = await readScene(client, args.scene_id);
      const object = requireObject(scene, args.object_id);
      const faces = getBindableFaces(object);

      if (!args.slot) {
        const data = {
          object_id: object.id,
          object_type: object.type,
          faces: faces.map((face) => ({
            slot: face.slotKey,
            label: face.label,
            kind: face.kind,
            primary: face.primary,
            current_material_id: object.materialSlots[face.slotKey] ?? null
          }))
        };

        return {
          text: lines(
            heading(1, `Bindable faces of ${object.name} (${object.type})`),
            "",
            table(data.faces, [
              { label: "Slot", value: (face) => face.slot },
              { label: "Label", value: (face) => face.label },
              { label: "Kind", value: (face) => face.kind },
              { label: "Current", value: (face) => face.current_material_id ?? "—" }
            ]),
            "",
            "Call again with `slot` and `material_id` to assign."
          ),
          data
        };
      }

      const face = faces.find((candidate) => candidate.slotKey === args.slot);
      if (!face) {
        return {
          text:
            `"${args.slot}" is not a face of ${object.type} object \`${object.id}\`. Faces: ` +
            faces.map((candidate) => candidate.slotKey).join(", ")
        };
      }

      if (args.material_id) {
        const material = scene.materials.find(
          (candidate) => candidate.materialId === args.material_id
        );
        if (!material) {
          return {
            text:
              `Scene has no material "${args.material_id}". Materials: ` +
              (scene.materials.map((candidate) => candidate.materialId).join(", ") || "none")
          };
        }
        if (!isMaterialCompatible(material, object.type)) {
          return {
            text:
              `Material "${material.name}" is not compatible with a ${object.type} object. It is ` +
              `restricted to: ${(material.supportedPrimitives ?? []).join(", ") || "unspecified"}.`
          };
        }
      }

      const slotName = args.slot;
      const { summary } = await mutateScene(
        client,
        args.scene_id,
        args.expected_revision,
        (current) => ({
          ...current,
          objects: current.objects.map((candidate) => {
            if (candidate.id !== args.object_id) return candidate;
            const materialSlots = { ...candidate.materialSlots };
            if (args.material_id) materialSlots[slotName] = args.material_id;
            else delete materialSlots[slotName];
            return { ...candidate, materialSlots };
          })
        })
      );

      return {
        text: args.material_id
          ? `Assigned material \`${args.material_id}\` to slot \`${args.slot}\` of \`${args.object_id}\`. Scene revision is now ${summary.revision}.`
          : `Cleared slot \`${args.slot}\` of \`${args.object_id}\`. Scene revision is now ${summary.revision}.`,
        data: {
          ok: true,
          object_id: args.object_id,
          slot: args.slot,
          material_id: args.material_id ?? null,
          scene: { id: summary.id, revision: summary.revision }
        }
      };
    }
  }),

  defineTool({
    name: "delete_material",
    title: "Delete a material",
    description: `Remove a material from a scene and clear every slot that referenced it.

Refuses by default when the material is still in use, because a slot silently reverting to the default material is a visual change that is hard to notice. Pass force: true to delete anyway; every binding to it is cleared in the same write.

Args:
  - scene_id (string), material_id (string).
  - force (boolean): delete even when the material is in use (default: false).
  - expected_revision (number): the revision you read.

Returns:
  JSON shape: { ok: true, material_id, cleared_object_ids: string[], scene: { id, revision } }`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        material_id: materialIdField,
        force: z.boolean().default(false).describe("Delete even when the material is still bound."),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: { ...WRITE, destructiveHint: true },
    async handler({ scene_id, material_id, force, expected_revision }, { client }) {
      const scene = await readScene(client, scene_id);
      const material = scene.materials.find(
        (candidate) => candidate.materialId === material_id
      );
      if (!material) {
        return {
          text:
            `Scene "${scene.id}" has no material "${material_id}". Materials: ` +
            (scene.materials.map((candidate) => candidate.materialId).join(", ") || "none")
        };
      }

      const usage = findMaterialUsage(scene, material_id);
      if (usage.objectIds.length > 0 && !force) {
        return {
          text: lines(
            `"${material.name}" is still bound by ${usage.objectIds.length} object(s):`,
            ...usage.objectIds.map((id, index) => `- \`${id}\` (${usage.objectNames[index]})`),
            "",
            "Reassign them first, or call again with force: true to delete and clear every binding."
          ),
          data: { ok: false, in_use_by: usage.objectIds }
        };
      }

      const { summary } = await mutateScene(client, scene_id, expected_revision, (current) => ({
        ...current,
        materials: current.materials.filter(
          (candidate) => candidate.materialId !== material_id
        ),
        materialInstances: (current.materialInstances ?? []).filter(
          (instance) => instance.baseMaterialId !== material_id
        ),
        objects: current.objects.map((object) => {
          const entries = Object.entries(object.materialSlots).filter(([, binding]) => {
            const boundId = typeof binding === "string" ? binding : binding.materialId;
            return boundId !== material_id;
          });
          return entries.length === Object.keys(object.materialSlots).length
            ? object
            : { ...object, materialSlots: Object.fromEntries(entries) };
        })
      }));

      return {
        text: lines(
          `Deleted material "${material.name}" (\`${material_id}\`) from "${summary.name}".`,
          usage.objectIds.length
            ? `Cleared its binding on: ${usage.objectIds.join(", ")}.`
            : undefined,
          "",
          `Scene revision is now ${summary.revision}. Use grapix_editor_recover_scene to undo.`
        ),
        data: {
          ok: true,
          material_id,
          cleared_object_ids: usage.objectIds,
          scene: { id: summary.id, revision: summary.revision }
        }
      };
    }
  })
];
