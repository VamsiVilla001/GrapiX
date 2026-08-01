/**
 * Object tools: add, update, move, delete, group and bind.
 *
 * `update_object` goes through the project service's targeted PATCH route,
 * which merges into one object and leaves the rest of the document alone. The
 * whole-document tools here (add, delete, reorder) go through `mutateScene` and
 * carry the revision guard, because they rewrite the object array.
 */

import { z } from "zod";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { heading, lines, paginate, table } from "../format.js";
import { createSceneObject, mutateScene, readScene, requireObject, withColorStyles } from "../sceneOps.js";
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

const objectIdField = z
  .string()
  .min(1)
  .max(128)
  .describe("Object id, e.g. `text_ab12cd34`. Get one from grapix_editor_list_objects.");

/** Transform and appearance fields common to every object type. */
const commonObjectFields = {
  name: z.string().min(1).max(180).optional().describe("Display name."),
  x: z.number().optional().describe("X position in scene pixels."),
  y: z.number().optional().describe("Y position in scene pixels."),
  width: z.number().min(0).optional().describe("Width in scene pixels."),
  height: z.number().min(0).optional().describe("Height in scene pixels."),
  z_depth: z.number().optional().describe("Z position in scene pixels (3D depth, not stacking order)."),
  rotation: z.number().optional().describe("Rotation about Z in degrees."),
  rotation_x: z.number().optional().describe("Rotation about X in degrees."),
  rotation_y: z.number().optional().describe("Rotation about Y in degrees."),
  scale_x: z.number().optional().describe("Local X scale, unitless."),
  scale_y: z.number().optional().describe("Local Y scale, unitless."),
  scale_z: z.number().optional().describe("Local Z scale, unitless."),
  opacity: z.number().min(0).max(1).optional().describe("Opacity, 0 to 1."),
  visible: z.boolean().optional().describe("Whether the object renders."),
  locked: z.boolean().optional().describe("Whether the editor allows direct manipulation."),
  fill: z.string().max(64).optional().describe("Fill colour. Written to both fill and fillStyle."),
  stroke: z.string().max(64).optional().describe("Stroke colour. Written to both stroke and strokeStyle."),
  stroke_width: z.number().min(0).optional().describe("Stroke width in scene pixels."),
  z_index: z.number().int().optional().describe("Stacking order within the layer; higher draws later.")
};

/** Maps the snake_case tool arguments onto the camelCase scene contract. */
function toObjectPatch(args: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, string> = {
    name: "name",
    x: "x",
    y: "y",
    width: "width",
    height: "height",
    z_depth: "zDepth",
    rotation: "rotation",
    rotation_x: "rotationX",
    rotation_y: "rotationY",
    scale_x: "scaleX",
    scale_y: "scaleY",
    scale_z: "scaleZ",
    opacity: "opacity",
    visible: "visible",
    locked: "locked",
    stroke_width: "strokeWidth",
    z_index: "zIndex"
  };

  const patch: Record<string, unknown> = {};
  for (const [argument, field] of Object.entries(map)) {
    if (args[argument] !== undefined) patch[field] = args[argument];
  }

  // fill/stroke must set both representations; the renderers read the rich one
  // first, so writing only the string paints the previous style (memory.md 88).
  const colored = withColorStyles(patch as { fill?: string; stroke?: string }, {
    ...(typeof args.fill === "string" ? { fill: args.fill } : {}),
    ...(typeof args.stroke === "string" ? { stroke: args.stroke } : {})
  });

  return { ...colored, ...((args.properties as Record<string, unknown>) ?? {}) };
}

function describeObject(object: SceneObject): Record<string, unknown> {
  return {
    id: object.id,
    name: object.name,
    type: object.type,
    x: object.x,
    y: object.y,
    z_depth: object.zDepth,
    z_index: object.zIndex,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    opacity: object.opacity,
    visible: object.visible,
    locked: object.locked,
    layer_id: object.layerId,
    fill: object.fill,
    stroke: object.stroke,
    bindings: object.bindings,
    material_slots: object.materialSlots,
    animated_properties: Object.keys(object.animation ?? {})
  };
}

export const objectTools: RegisteredEditorTool[] = [
  defineTool({
    name: "list_objects",
    title: "List objects in a scene",
    description: `List a scene's objects with their transform, visibility, material bindings and animated properties.

Args:
  - scene_id (string): the scene id.
  - type (string): filter to one object type, e.g. 'text', 'mesh', 'light'.
  - name_contains (string): case-insensitive name filter.
  - limit (number), offset (number): paging (default limit: 25).
  - response_format ('markdown' | 'json'): output format (default: 'markdown').

Returns:
  JSON shape: { scene_id, total, count, offset, has_more, next_offset?, objects: [{ id, name, type, x, y, width, height, opacity, visible, bindings, material_slots, animated_properties }] }

Call grapix_editor_describe_capabilities for the full list of object types.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        type: z.string().max(32).optional().describe("Filter to one SceneObjectType."),
        name_contains: z.string().max(180).optional().describe("Case-insensitive name filter."),
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, type, name_contains, limit, offset, response_format }, { client }) {
      const scene = await readScene(client, scene_id);
      const needle = name_contains?.toLowerCase();
      const filtered = scene.objects.filter(
        (object) =>
          (!type || object.type === type) &&
          (!needle || object.name.toLowerCase().includes(needle))
      );
      const page = paginate(filtered, offset, limit);

      if (page.total === 0) {
        const types = [...new Set(scene.objects.map((object) => object.type))];
        return {
          text:
            `No objects match. The scene has ${scene.objects.length} object(s)` +
            (types.length ? ` of type(s): ${types.join(", ")}.` : ".")
        };
      }

      const data = {
        scene_id: scene.id,
        revision: scene.revision ?? 0,
        total: page.total,
        count: page.count,
        offset: page.offset,
        has_more: page.has_more,
        next_offset: page.next_offset,
        objects: page.items.map(describeObject)
      };

      const markdown = lines(
        heading(1, `Objects in ${scene.name}`),
        `\`${scene.id}\` · revision ${scene.revision ?? 0}`,
        "",
        table(page.items, [
          { label: "Id", value: (object) => object.id },
          { label: "Name", value: (object) => object.name },
          { label: "Type", value: (object) => object.type },
          { label: "x,y", value: (object) => `${object.x},${object.y}` },
          { label: "w x h", value: (object) => `${object.width} x ${object.height}` },
          { label: "Opacity", value: (object) => object.opacity },
          { label: "Visible", value: (object) => object.visible },
          { label: "Animated", value: (object) => Object.keys(object.animation ?? {}).join(" ") || "—" }
        ]),
        "",
        page.has_more ? `Pass offset: ${page.next_offset} for more.` : `${page.total} shown.`
      );

      return present(response_format, markdown, data, "Filter with `type` or lower `limit`.");
    }
  }),

  defineTool({
    name: "get_object",
    title: "Read one object",
    description: `Read a single object's complete record, including type-specific fields, masks, keyframe channels and material slots.

Args:
  - scene_id (string): the scene id.
  - object_id (string): the object id.
  - response_format ('markdown' | 'json'): output format (default: 'json' is usually more useful here).

Returns: the complete SceneObject as stored.

Error handling: lists the scene's object ids and types when the id does not exist.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        object_id: objectIdField,
        response_format: responseFormatField
      })
      .strict(),
    annotations: READ_ONLY,
    async handler({ scene_id, object_id, response_format }, { client }) {
      const scene = await readScene(client, scene_id);
      const object = requireObject(scene, object_id);

      return present(
        response_format,
        lines(
          heading(1, `${object.name} (${object.type})`),
          `\`${object.id}\` in scene \`${scene.id}\` revision ${scene.revision ?? 0}`,
          "",
          "```json",
          JSON.stringify(object, null, 2),
          "```"
        ),
        object as unknown as Record<string, unknown>,
        "This is a single object; there is no narrower request."
      );
    }
  }),

  defineTool({
    name: "add_object",
    title: "Add an object to a scene",
    description: `Create an object and append it to a scene.

Every required field for the chosen type is filled from the contract defaults, so the result is valid for both renderers without further edits. Colours are written to both the legacy string and the rich style value, which is what the renderers actually read.

Args:
  - scene_id (string): the scene id.
  - type (string): one of text, rect, ellipse, image, line, shape, paint, mesh, light, camera, layer, marker, group.
  - name, x, y, width, height, rotation, opacity, visible, fill, stroke, stroke_width: common fields.
  - properties (object): type-specific fields. Examples:
      text  -> { "text": "Home", "fontSize": 48, "fontFamily": "Inter", "fontWeight": "700", "align": "left" }
      rect  -> { "radius": 8 }
      image -> { "src": "asset_...", "objectFit": "contain" }
      mesh  -> { "meshKind": "slab", "depth": 40 }
      light -> { "lightKind": "spot", "intensity": 2, "color": "#ffffff" }
  - expected_revision (number): the revision you read; the write is refused if it moved.

Returns:
  JSON shape: { ok: true, object: { id, name, type, ... }, scene: { id, revision, objectCount } }

Examples:
  - Lower-third plate: type="rect", x=140, y=742, width=640, height=120, fill="#10305080", properties={"radius":8}
  - Bound name field: type="text", properties={"text":"Player Name"}, then bind_object_property with property="text", path="team.name"`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        type: z
          .enum([
            "text",
            "rect",
            "ellipse",
            "image",
            "line",
            "shape",
            "paint",
            "mesh",
            "light",
            "camera",
            "layer",
            "marker",
            "group"
          ])
          .describe("Object type."),
        ...commonObjectFields,
        layer_id: z.string().max(128).optional().describe("Layer this object belongs to (default: 'main')."),
        properties: z
          .record(z.unknown())
          .optional()
          .describe("Type-specific fields, merged over the contract defaults."),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler(args, { client }) {
      let created: SceneObject | undefined;

      const { summary } = await mutateScene(
        client,
        args.scene_id,
        args.expected_revision,
        (scene: SceneDocument) => {
          created = createSceneObject(scene, {
            type: args.type,
            name: args.name,
            x: args.x,
            y: args.y,
            width: args.width,
            height: args.height,
            zDepth: args.z_depth,
            rotation: args.rotation,
            opacity: args.opacity,
            visible: args.visible,
            locked: args.locked,
            fill: args.fill,
            stroke: args.stroke,
            strokeWidth: args.stroke_width,
            layerId: args.layer_id,
            properties: args.properties
          });
          return { ...scene, objects: [...scene.objects, created] };
        }
      );

      return {
        text: lines(
          `Added ${args.type} \`${created?.id}\` to "${summary.name}".`,
          "",
          `- **Scene revision**: ${summary.revision}`,
          `- **Objects**: ${summary.objectCount}`,
          "",
          "Pass `expected_revision: " + summary.revision + "` on the next write."
        ),
        data: {
          ok: true,
          object: created ? describeObject(created) : undefined,
          scene: { id: summary.id, revision: summary.revision, objectCount: summary.objectCount }
        }
      };
    }
  }),

  defineTool({
    name: "update_object",
    title: "Update an object",
    description: `Change one object's properties, leaving the rest of the scene untouched.

Uses the project service's targeted patch route, so it does not rewrite the document and cannot clobber a concurrent change to a different object.

Args:
  - scene_id (string), object_id (string).
  - name, x, y, width, height, z_depth, rotation, rotation_x, rotation_y, scale_x, scale_y, scale_z, opacity, visible, locked, fill, stroke, stroke_width, z_index: common fields.
  - properties (object): type-specific fields, e.g. { "text": "Updated", "fontSize": 56 }.

Returns:
  JSON shape: { ok: true, object: {...}, scene: { id, revision } }

Note on rotation: rotationX and rotationY are 3D rotations and are not inherited by container objects; rotationZ is read from meshes only. Which properties a given object type honours is defined by the Editor's objectPropertySupport table — see grapix_editor_describe_capabilities.

Error handling: an unknown object_id returns the scene's object ids and types.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        object_id: objectIdField,
        ...commonObjectFields,
        properties: z.record(z.unknown()).optional().describe("Type-specific fields to merge.")
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler(args, { client }) {
      const { scene_id, object_id, ...rest } = args;
      const patch = toObjectPatch(rest as Record<string, unknown>);

      if (Object.keys(patch).length === 0) {
        return { text: "No properties were supplied, so nothing changed." };
      }

      // Confirm the object exists first: the patch route maps over the object
      // array and quietly succeeds when nothing matches, which would report a
      // successful edit that never happened.
      const before = await readScene(client, scene_id);
      requireObject(before, object_id);

      const response = await client.request<{ ok: boolean; scene: SceneDocument }>(
        `/api/scenes/${encodeURIComponent(scene_id)}/objects/${encodeURIComponent(object_id)}`,
        { method: "PATCH", json: patch }
      );

      const updated = requireObject(response.scene, object_id);

      return {
        text: lines(
          `Updated \`${object_id}\` in "${response.scene.name}".`,
          "",
          ...Object.keys(patch).map((key) => `- ${key} -> ${JSON.stringify(patch[key])}`),
          "",
          `Scene revision is now ${response.scene.revision ?? 0}.`
        ),
        data: {
          ok: true,
          object: describeObject(updated),
          scene: { id: response.scene.id, revision: response.scene.revision ?? 0 }
        }
      };
    }
  }),

  defineTool({
    name: "delete_object",
    title: "Delete objects from a scene",
    description: `Remove one or more objects from a scene.

Deletion is scoped: removing a container also removes it from its parent's child list and detaches its children, so the hierarchy stays resolvable. Material and asset definitions are never removed — deleting the only object that used a material does not delete the material.

The project service backs up the previous revision before writing, so grapix_editor_recover_scene undoes this.

Args:
  - scene_id (string): the scene id.
  - object_ids (string[]): ids to remove, 1-200.
  - expected_revision (number): the revision you read; the write is refused if it moved.

Returns:
  JSON shape: { ok: true, deleted: string[], not_found: string[], scene: { id, revision, objectCount } }`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        object_ids: z.array(z.string().min(1).max(128)).min(1).max(200).describe("Object ids to delete."),
        expected_revision: expectedRevisionField
      })
      .strict(),
    mutates: true,
    annotations: { ...WRITE, destructiveHint: true },
    async handler({ scene_id, object_ids, expected_revision }, { client }) {
      const targets = new Set(object_ids);
      let deleted: string[] = [];
      let notFound: string[] = [];

      const { summary } = await mutateScene(client, scene_id, expected_revision, (scene) => {
        const existing = new Set(scene.objects.map((object) => object.id));
        deleted = object_ids.filter((id) => existing.has(id));
        notFound = object_ids.filter((id) => !existing.has(id));

        const objects = scene.objects
          .filter((object) => !targets.has(object.id))
          .map((object) => {
            if (!("childIds" in object) || !Array.isArray(object.childIds)) return object;
            const remaining = object.childIds.filter((childId) => !targets.has(childId));
            return remaining.length === object.childIds.length
              ? object
              : { ...object, childIds: remaining };
          });

        return { ...scene, objects };
      });

      return {
        text: lines(
          deleted.length
            ? `Deleted ${deleted.length} object(s) from "${summary.name}": ${deleted.join(", ")}.`
            : "Nothing was deleted.",
          notFound.length ? `Not present in the scene: ${notFound.join(", ")}.` : undefined,
          "",
          `Scene revision is now ${summary.revision}; ${summary.objectCount} object(s) remain.`,
          "Use grapix_editor_recover_scene to undo this."
        ),
        data: {
          ok: true,
          deleted,
          not_found: notFound,
          scene: { id: summary.id, revision: summary.revision, objectCount: summary.objectCount }
        }
      };
    }
  }),

  defineTool({
    name: "bind_object_property",
    title: "Bind an object property to live data",
    description: `Bind an object property to a path in the scene's data context, so the value comes from live data at air time instead of being authored.

This is the core of a broadcast template: a name field bound to \`team.name\` renders whatever the operator or automation puts there, without republishing the scene.

Args:
  - scene_id (string), object_id (string).
  - property (string): the bindable property — text, src, fill, stroke, visible, x, y, width, height, zDepth, rotation, rotationX, rotationY, rotationZ, scaleX, scaleY, scaleZ, anchor, opacity, path.
  - data_path (string): dot/bracket path into the data context, e.g. 'team.name' or 'scores[0].value'. Pass null to remove the binding.

Returns:
  JSON shape: { ok: true, object_id, bindings: {...}, resolved_value: unknown, scene: { id, revision } }

The response includes the value the binding currently resolves to, so an unresolvable path is visible immediately rather than at air time.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        object_id: objectIdField,
        property: z
          .enum([
            "text", "src", "fill", "stroke", "visible", "x", "y", "width", "height", "zDepth",
            "rotation", "rotationX", "rotationY", "rotationZ", "scaleX", "scaleY", "scaleZ",
            "anchor", "opacity", "path"
          ])
          .describe("The bindable property."),
        data_path: z
          .string()
          .max(256)
          .nullable()
          .describe("Data-context path, e.g. 'team.name'. Pass null to remove the binding.")
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler({ scene_id, object_id, property, data_path }, { client }) {
      const before = await readScene(client, scene_id);
      const object = requireObject(before, object_id);

      const bindings = { ...object.bindings };
      if (data_path === null) delete bindings[property];
      else bindings[property] = data_path;

      const response = await client.request<{ ok: boolean; scene: SceneDocument }>(
        `/api/scenes/${encodeURIComponent(scene_id)}/objects/${encodeURIComponent(object_id)}`,
        { method: "PATCH", json: { bindings } }
      );

      const resolved = data_path === null ? undefined : resolvePath(before.dataContext, data_path);

      return {
        text: lines(
          data_path === null
            ? `Removed the \`${property}\` binding from \`${object_id}\`.`
            : `Bound \`${property}\` of \`${object_id}\` to \`${data_path}\`.`,
          data_path !== null
            ? resolved === undefined
              ? `\n**The path does not resolve yet.** The data context has keys: ${
                  Object.keys(before.dataContext ?? {}).join(", ") || "none"
                }. Set a value with grapix_editor_set_data_value.`
              : `\nCurrent value: \`${JSON.stringify(resolved)}\``
            : undefined,
          "",
          `Scene revision is now ${response.scene.revision ?? 0}.`
        ),
        data: {
          ok: true,
          object_id,
          bindings,
          resolved_value: resolved,
          scene: { id: response.scene.id, revision: response.scene.revision ?? 0 }
        }
      };
    }
  }),

  defineTool({
    name: "set_object_animation",
    title: "Set keyframes on an object property",
    description: `Replace the keyframe channel for one animatable property of an object.

GrapiX animates through per-property channels (After Effects style), not whole-object keyframe snapshots. Animatable properties are: opacity, x, y, zDepth, rotationX, rotationY, rotation, rotationZ, scaleX, scaleY, scaleZ.

Args:
  - scene_id (string), object_id (string).
  - property (string): the animatable property.
  - keys (array): [{ frame: number, value: number, easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' }]. Pass an empty array to remove the channel and make the property static again.

Returns:
  JSON shape: { ok: true, object_id, property, key_count, animated_properties: string[], scene: { id, revision } }

Note: frames are timeline frames at the scene's fps. A 20-frame move at 50 fps is 0.4 seconds. Keys are sorted by frame before storing.`,
    inputSchema: z
      .object({
        scene_id: sceneIdField,
        object_id: objectIdField,
        property: z
          .enum([
            "opacity", "x", "y", "zDepth", "rotationX", "rotationY", "rotation",
            "rotationZ", "scaleX", "scaleY", "scaleZ"
          ])
          .describe("The animatable property."),
        keys: z
          .array(
            z
              .object({
                frame: z.number().int().min(0).max(1_000_000).describe("Timeline frame."),
                value: z.number().describe("Property value at that frame."),
                easing: z
                  .enum(["linear", "ease-in", "ease-out", "ease-in-out"])
                  .default("linear")
                  .describe("Easing into the next key.")
              })
              .strict()
          )
          .max(2000)
          .describe("Keyframes. An empty array removes the channel.")
      })
      .strict(),
    mutates: true,
    annotations: WRITE,
    async handler({ scene_id, object_id, property, keys }, { client }) {
      const before = await readScene(client, scene_id);
      const object = requireObject(before, object_id);

      const animation = { ...(object.animation ?? {}) };
      if (keys.length === 0) {
        delete animation[property];
      } else {
        animation[property] = {
          keys: [...keys]
            .sort((left, right) => left.frame - right.frame)
            .map((key, index) => ({
              id: `key_${property}_${index}`,
              frame: key.frame,
              value: key.value,
              easing: key.easing
            }))
        };
      }

      const response = await client.request<{ ok: boolean; scene: SceneDocument }>(
        `/api/scenes/${encodeURIComponent(scene_id)}/objects/${encodeURIComponent(object_id)}`,
        { method: "PATCH", json: { animation } }
      );

      const outOfRange = keys.filter((key) => key.frame > before.timeline.durationFrames);

      return {
        text: lines(
          keys.length
            ? `Set ${keys.length} key(s) on \`${property}\` of \`${object_id}\`.`
            : `Removed the \`${property}\` channel from \`${object_id}\`; it is static again.`,
          outOfRange.length
            ? `\n**${outOfRange.length} key(s) fall past the timeline end (${before.timeline.durationFrames} frames).** ` +
              "Extend the timeline with grapix_editor_update_scene_settings, or they will never play."
            : undefined,
          "",
          `Animated properties are now: ${Object.keys(animation).join(", ") || "none"}.`,
          `Scene revision is now ${response.scene.revision ?? 0}.`
        ),
        data: {
          ok: true,
          object_id,
          property,
          key_count: keys.length,
          animated_properties: Object.keys(animation),
          scene: { id: response.scene.id, revision: response.scene.revision ?? 0 }
        }
      };
    }
  })
];

/** Local copy of the data-path walk, used only to preview a binding's value. */
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
