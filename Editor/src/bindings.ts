// Data binding authoring and preview resolution (build plan 11.19).
//
// A binding is an authored object-property -> data-context path. Resolution is
// strict and all-or-nothing: a missing path, wrong type or unsupported property
// is named rather than leaving one property stale while applying the rest.
// That partial-update failure is especially dangerous for broadcast graphics:
// a name may update while the score beside it remains from the previous take.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";
import type { EditTransaction } from "./inspector";

export type BindingValueKind = "number" | "string" | "boolean";

interface BindableProperty {
  readonly key: string;
  readonly label: string;
  readonly kind: BindingValueKind;
  readonly appliesTo?: readonly SceneObject["type"][];
  readonly accepts?: (value: unknown) => boolean;
  readonly constraint?: string;
}

const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const nonNegative = (value: unknown): boolean => finite(value) && Number(value) >= 0;
const opacity = (value: unknown): boolean => finite(value) && Number(value) >= 0 && Number(value) <= 1;
const nonZero = (value: unknown): boolean => finite(value) && Number(value) !== 0;

// One table drives panel visibility, validation and assignment. Adding a field
// in only one of those places would advertise a binding the preview ignores.
const BINDABLE: readonly BindableProperty[] = [
  { key: "text", label: "Text", kind: "string", appliesTo: ["text"] },
  { key: "assetId", label: "Image asset", kind: "string", appliesTo: ["image"] },
  { key: "x", label: "X", kind: "number" },
  { key: "y", label: "Y", kind: "number" },
  { key: "zDepth", label: "Depth", kind: "number" },
  { key: "rotation", label: "Rotation Z", kind: "number" },
  { key: "rotationX", label: "Rotation X", kind: "number" },
  { key: "rotationY", label: "Rotation Y", kind: "number" },
  { key: "scaleX", label: "Scale X", kind: "number", accepts: nonZero, constraint: "non-zero" },
  { key: "scaleY", label: "Scale Y", kind: "number", accepts: nonZero, constraint: "non-zero" },
  { key: "scaleZ", label: "Scale Z", kind: "number", accepts: nonZero, constraint: "non-zero" },
  { key: "width", label: "Width", kind: "number", accepts: nonNegative, constraint: "zero or greater" },
  { key: "height", label: "Height", kind: "number", accepts: nonNegative, constraint: "zero or greater" },
  { key: "opacity", label: "Opacity", kind: "number", accepts: opacity, constraint: "between 0 and 1" },
  { key: "visible", label: "Visible", kind: "boolean" },
];

function specFor(object: SceneObject, property: string): BindableProperty | undefined {
  return BINDABLE.find(
    (candidate) =>
      candidate.key === property &&
      (candidate.appliesTo === undefined || candidate.appliesTo.includes(object.type)),
  );
}

export function bindableProperties(object: SceneObject): readonly string[] {
  return BINDABLE.filter(
    (spec) => spec.appliesTo === undefined || spec.appliesTo.includes(object.type),
  ).map((spec) => spec.key);
}

const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$|^(0|[1-9][0-9]*)$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export type BindingPathResult =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Parse the stable dot path used on the wire (`match.homeScore`, `teams.0.name`). */
export function parseBindingPath(path: string): BindingPathResult {
  if (path.length === 0) return { ok: false, reason: "binding path is empty" };
  const segments = path.split(".");
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment)) {
      return { ok: false, reason: `binding path segment ${JSON.stringify(segment)} is invalid` };
    }
  }
  return { ok: true, segments };
}

export type DataPathResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

export function resolveDataPath(data: SceneDocument["dataContext"], path: string): DataPathResult {
  const parsed = parseBindingPath(path);
  if (!parsed.ok) return parsed;

  let value: unknown = data;
  for (const segment of parsed.segments) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
        return { ok: false, reason: `${path} addresses array ${segment} by a non-index` };
      }
      const index = Number(segment);
      if (index >= value.length) return { ok: false, reason: `${path} has no value at index ${segment}` };
      value = value[index];
      continue;
    }
    if (value === null || typeof value !== "object") {
      return { ok: false, reason: `${path} continues through a ${typeof value} value` };
    }
    if (!Object.prototype.hasOwnProperty.call(value, segment)) {
      return { ok: false, reason: `${path} is absent from the scene data context` };
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return { ok: true, value };
}

export type BindingIssueCode =
  | "bindingPathNotString"
  | "bindingPathInvalid"
  | "bindingPropertyUnsupported"
  | "bindingTypeMismatch"
  | "bindingValueOutOfRange"
  | "bindingAssetUnknown";

export interface BindingIssue {
  readonly code: BindingIssueCode;
  readonly objectId: string;
  readonly property: string;
  readonly path?: string;
  readonly reason: string;
}

export type BindingResolution =
  | { readonly ok: true; readonly document: SceneDocument }
  | { readonly ok: false; readonly issues: readonly BindingIssue[] };

function valueIssue(
  document: SceneDocument,
  object: SceneObject,
  spec: BindableProperty,
  path: string,
  value: unknown,
): BindingIssue | undefined {
  if (typeof value !== spec.kind || (spec.kind === "number" && !finite(value))) {
    return {
      code: "bindingTypeMismatch",
      objectId: object.id,
      property: spec.key,
      path,
      reason: `${path} is ${value === null ? "null" : typeof value}; ${spec.label} requires ${spec.kind}`,
    };
  }
  if (spec.accepts && !spec.accepts(value)) {
    return {
      code: "bindingValueOutOfRange",
      objectId: object.id,
      property: spec.key,
      path,
      reason: `${path} must be ${spec.constraint ?? "valid for this property"}`,
    };
  }
  if (
    object.type === "image" &&
    spec.key === "assetId" &&
    !document.assets.some((asset) => asset.assetId === value && asset.kind === "image")
  ) {
    return {
      code: "bindingAssetUnknown",
      objectId: object.id,
      property: spec.key,
      path,
      reason: `${path} names image asset ${String(value)}, which the scene does not carry`,
    };
  }
  return undefined;
}

/** Resolve every binding into a preview document without mutating authored data. */
export function resolveSceneBindings(document: SceneDocument): BindingResolution {
  const issues: BindingIssue[] = [];
  const objects = document.objects.map((object) => {
    const bindings = object.bindings ?? {};
    let resolved: SceneObject = object;

    for (const [property, rawPath] of Object.entries(bindings)) {
      if (typeof rawPath !== "string") {
        issues.push({
          code: "bindingPathNotString",
          objectId: object.id,
          property,
          reason: `${property} binding on ${object.id} must be a string path`,
        });
        continue;
      }
      const spec = specFor(object, property);
      if (!spec) {
        issues.push({
          code: "bindingPropertyUnsupported",
          objectId: object.id,
          property,
          path: rawPath,
          reason: `${property} is not a bindable property of ${object.type}`,
        });
        continue;
      }
      const found = resolveDataPath(document.dataContext, rawPath);
      if (!found.ok) {
        issues.push({
          code: "bindingPathInvalid",
          objectId: object.id,
          property,
          path: rawPath,
          reason: found.reason,
        });
        continue;
      }
      const issue = valueIssue(document, object, spec, rawPath, found.value);
      if (issue) {
        issues.push(issue);
        continue;
      }

      // SceneObject's tagged union is intentionally closed; the table above is
      // the narrower runtime proof that this dynamic property is one we own.
      resolved = { ...resolved };
      (resolved as unknown as Record<string, unknown>)[property] = found.value;
    }
    return resolved;
  });

  return issues.length === 0 ? { ok: true, document: { ...document, objects } } : { ok: false, issues };
}

export interface DataField {
  readonly path: string;
  readonly value: unknown;
}

/** Flatten only leaves. Binding an object wholesale is not a supported coercion. */
export function dataFields(data: SceneDocument["dataContext"]): readonly DataField[] {
  const fields: DataField[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, path ? `${path}.${index}` : String(index)));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, path ? `${path}.${key}` : key);
      }
      return;
    }
    fields.push({ path, value });
  };
  walk(data, "");
  return fields.filter((field) => field.path.length > 0);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** The accessible and agent-readable binding panel for one selected object. */
export function bindingPanel(document: SceneDocument, selectedIds: readonly string[]): UiNode {
  const selected = document.objects.filter((object) => selectedIds.includes(object.id));
  if (selected.length !== 1) {
    return {
      id: "bindings",
      role: "region",
      label: "Data bindings",
      description:
        selected.length === 0
          ? "Select one object to edit its bindings"
          : `Select one object; ${selected.length} are selected`,
      children: [],
    };
  }

  const object = selected[0];
  if (!object) throw new Error("selected length and object lookup disagree");
  const propertyNodes: UiNode[] = BINDABLE.filter(
    (spec) => spec.appliesTo === undefined || spec.appliesTo.includes(object.type),
  ).map((spec) => {
    const rawPath = object.bindings?.[spec.key];
    const path = typeof rawPath === "string" ? rawPath : undefined;
    const found = path === undefined ? undefined : resolveDataPath(document.dataContext, path);
    return {
      id: `binding/property/${spec.key}`,
      role: "gridcell",
      label: spec.label,
      value:
        path === undefined
          ? "Not bound"
          : found?.ok
            ? `${path} → ${formatValue(found.value)}`
            : `${path} — ${found?.reason ?? "invalid path"}`,
      actions: [
        { name: "bind", label: path === undefined ? `Bind ${spec.label}` : `Change ${spec.label} binding` },
        {
          name: "removeBinding",
          label: `Remove ${spec.label} binding`,
          ...(path === undefined ? { unavailable: `${spec.label} is not bound` } : {}),
        },
      ],
    };
  });

  const sourceNodes: UiNode[] = dataFields(document.dataContext).map((field) => ({
    id: `binding/data/${field.path}`,
    role: "listitem",
    label: field.path,
    value: `${typeof field.value}: ${formatValue(field.value)}`,
  }));

  return {
    id: "bindings",
    role: "region",
    label: "Data bindings",
    description: `${object.name} (${object.type}); ${sourceNodes.length} data field(s)`,
    children: [
      { id: "binding/properties", role: "group", label: "Bindable properties", children: propertyNodes },
      { id: "binding/data", role: "list", label: "Scene data fields", children: sourceNodes },
    ],
  };
}

export type BindingEditOutcome =
  | { readonly ok: true; readonly document: SceneDocument; readonly transaction: EditTransaction }
  | { readonly ok: false; readonly reason: string };

/** Add, replace or remove one binding as one undoable author gesture. */
export function applyBindingEdit(
  document: SceneDocument,
  objectId: string,
  property: string,
  path: string | undefined,
): BindingEditOutcome {
  const index = document.objects.findIndex((object) => object.id === objectId);
  const object = document.objects[index];
  if (index < 0 || !object) return { ok: false, reason: `no object ${objectId} in this scene` };
  const spec = specFor(object, property);
  if (!spec) return { ok: false, reason: `${property} is not a bindable property of ${object.type}` };

  const previous = object.bindings?.[property];
  if (path === undefined) {
    if (previous === undefined) return { ok: false, reason: `${spec.label} is not bound` };
  } else {
    const found = resolveDataPath(document.dataContext, path);
    if (!found.ok) return found;
    const issue = valueIssue(document, object, spec, path, found.value);
    if (issue) return { ok: false, reason: issue.reason };
    if (previous === path) return { ok: false, reason: `${spec.label} is already bound to ${path}` };
  }

  const bindings = { ...(object.bindings ?? {}) };
  if (path === undefined) delete bindings[property];
  else bindings[property] = path;
  const changed = {
    ...object,
    ...(Object.keys(bindings).length === 0 ? { bindings: undefined } : { bindings }),
  } as SceneObject;
  const objects = [...document.objects];
  objects[index] = changed;

  return {
    ok: true,
    document: { ...document, objects },
    transaction: {
      label: `${path === undefined ? "Remove" : previous === undefined ? "Bind" : "Change"} ${spec.label} binding`,
      changes: [{ objectId, field: `bindings.${property}`, from: previous, to: path }],
    },
  };
}
