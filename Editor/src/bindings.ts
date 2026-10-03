// Data binding authoring and preview resolution (build plan 11.19).
//
// A binding is an authored object-property -> data-context path. Resolution is
// strict and all-or-nothing: a missing path, wrong type or unsupported property
// is named rather than leaving one property stale while applying the rest.
// That partial-update failure is especially dangerous for broadcast graphics:
// a name may update while the score beside it remains from the previous take.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

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

/** The author-facing name of a bindable property, as the panel shows it. */
export function bindingLabel(object: SceneObject, property: string): string {
  return specFor(object, property)?.label ?? property;
}

// ---------------------------------------------------------------------------
// Sample data (11.19). The author supplies the scene's data context as JSON
// text. The text is scanned strictly before anything is parsed, so a refusal
// can name where the input went wrong, and the document is either replaced as
// a whole or not touched at all. `JSON.parse` alone would accept inputs that
// silently change meaning on the way in: a duplicate key keeps only its last
// value, an oversized integer is rounded, and `1e999` becomes Infinity, which
// is written back out as `null`. Each of those is refused by name instead
// (invariant 18).
// ---------------------------------------------------------------------------

export type SampleDataRefusalCode =
  | "sampleDataInvalidJson"
  | "sampleDataNotObject"
  | "sampleDataDuplicateKey"
  | "sampleDataNumberUnrepresentable"
  | "sampleDataTooDeep";

/** Where in the author's text a refusal applies. `line` and `column` are 1-based. */
export interface SampleDataPosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SampleDataRefused {
  readonly ok: false;
  readonly code: SampleDataRefusalCode;
  readonly reason: string;
  readonly position?: SampleDataPosition;
}

export type SampleDataParse =
  | { readonly ok: true; readonly data: SceneDocument["dataContext"] }
  | SampleDataRefused;

/** Nesting beyond this is refused rather than risking the scanner's stack. */
export const SAMPLE_DATA_MAX_DEPTH = 256;

function positionAt(text: string, offset: number): SampleDataPosition {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

class SampleDataScanError extends Error {
  constructor(
    readonly code: SampleDataRefusalCode,
    readonly detail: string,
    readonly offset: number,
  ) {
    super(detail);
  }
}

/** Validate RFC 8259 JSON without building a value; throws at the first fault. */
function scanJson(text: string): void {
  let at = 0;
  const here = (): string => (at >= text.length ? "end of input" : JSON.stringify(text.charAt(at)));
  const fail = (
    detail: string,
    code: SampleDataRefusalCode = "sampleDataInvalidJson",
    offset = at,
  ): never => {
    throw new SampleDataScanError(code, detail, offset);
  };
  const isDigit = (c: string): boolean => c.length === 1 && c >= "0" && c <= "9";
  const whitespace = (): void => {
    while (at < text.length && " \t\n\r".includes(text.charAt(at))) at += 1;
  };
  const digits = (): number => {
    const start = at;
    while (isDigit(text.charAt(at))) at += 1;
    return at - start;
  };
  const string = (): string => {
    const start = at;
    at += 1; // opening quote
    while (at < text.length) {
      const c = text.charAt(at);
      if (c === '"') {
        at += 1;
        return text.slice(start, at);
      }
      if (c === "\\") {
        const escape = text.charAt(at + 1);
        if (escape.length === 1 && '"\\/bfnrt'.includes(escape)) {
          at += 2;
          continue;
        }
        if (escape === "u" && /^[0-9A-Fa-f]{4}$/.test(text.slice(at + 2, at + 6))) {
          at += 6;
          continue;
        }
        fail("expected a valid escape sequence after \\");
      }
      if (text.charCodeAt(at) < 0x20) fail("expected a closing quote; control characters must be escaped");
      at += 1;
    }
    return fail("expected a closing quote before end of input");
  };
  const number = (): void => {
    const start = at;
    if (text.charAt(at) === "-") at += 1;
    if (text.charAt(at) === "0") at += 1;
    else if (digits() === 0) fail("expected a digit");
    let integral = true;
    if (text.charAt(at) === ".") {
      integral = false;
      at += 1;
      if (digits() === 0) fail("expected a digit after the decimal point");
    }
    if (text.charAt(at) === "e" || text.charAt(at) === "E") {
      integral = false;
      at += 1;
      if (text.charAt(at) === "+" || text.charAt(at) === "-") at += 1;
      if (digits() === 0) fail("expected a digit in the exponent");
    }
    const literal = text.slice(start, at);
    const value = Number(literal);
    if (!Number.isFinite(value)) {
      fail(`number ${literal} is out of range`, "sampleDataNumberUnrepresentable", start);
    }
    if (integral && !Number.isSafeInteger(value)) {
      fail(
        `integer ${literal} cannot be represented exactly; quote it as a string`,
        "sampleDataNumberUnrepresentable",
        start,
      );
    }
  };
  const literal = (word: string): void => {
    if (text.startsWith(word, at)) at += word.length;
    else fail(`expected a JSON value, found ${here()}`);
  };
  const value = (depth: number): void => {
    whitespace();
    const c = text.charAt(at);
    if (c === "{" || c === "[") {
      if (depth >= SAMPLE_DATA_MAX_DEPTH) {
        fail(`nesting is deeper than ${SAMPLE_DATA_MAX_DEPTH} levels`, "sampleDataTooDeep");
      }
      if (c === "{") object(depth + 1);
      else array(depth + 1);
    } else if (c === '"') string();
    else if (c === "-" || isDigit(c)) number();
    else if (c === "t") literal("true");
    else if (c === "f") literal("false");
    else if (c === "n") literal("null");
    else fail(`expected a JSON value, found ${here()}`);
  };
  const object = (depth: number): void => {
    at += 1; // {
    const keys = new Set<string>();
    whitespace();
    if (text.charAt(at) === "}") {
      at += 1;
      return;
    }
    for (;;) {
      whitespace();
      if (text.charAt(at) !== '"') fail(`expected a double-quoted property name, found ${here()}`);
      const keyStart = at;
      const key: unknown = JSON.parse(string());
      if (typeof key !== "string") throw new Error("a scanned JSON string decoded to a non-string");
      if (keys.has(key)) {
        fail(`property ${JSON.stringify(key)} appears twice in one object`, "sampleDataDuplicateKey", keyStart);
      }
      keys.add(key);
      whitespace();
      if (text.charAt(at) !== ":") fail(`expected ':' after a property name, found ${here()}`);
      at += 1;
      value(depth);
      whitespace();
      if (text.charAt(at) === ",") {
        at += 1;
        continue;
      }
      if (text.charAt(at) === "}") {
        at += 1;
        return;
      }
      fail(`expected ',' or '}', found ${here()}`);
    }
  };
  const array = (depth: number): void => {
    at += 1; // [
    whitespace();
    if (text.charAt(at) === "]") {
      at += 1;
      return;
    }
    for (;;) {
      value(depth);
      whitespace();
      if (text.charAt(at) === ",") {
        at += 1;
        continue;
      }
      if (text.charAt(at) === "]") {
        at += 1;
        return;
      }
      fail(`expected ',' or ']', found ${here()}`);
    }
  };

  value(0);
  whitespace();
  if (at < text.length) fail(`expected end of input, found ${here()}`);
}

/** Parse author-supplied sample data. The root must be a JSON object. */
export function parseSampleData(text: string): SampleDataParse {
  try {
    scanJson(text);
  } catch (error) {
    if (!(error instanceof SampleDataScanError)) throw error;
    const position = positionAt(text, error.offset);
    return {
      ok: false,
      code: error.code,
      reason: `line ${position.line}, column ${position.column}: ${error.detail}`,
      position,
    };
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`;
    const position = positionAt(text, Math.max(text.search(/\S/), 0));
    return {
      ok: false,
      code: "sampleDataNotObject",
      reason: `line ${position.line}, column ${position.column}: sample data must be a JSON object, not ${kind}`,
      position,
    };
  }
  // The scan proved this text is an RFC 8259 object with no duplicate keys and
  // only exactly-representable numbers, so `JSON.parse` yields exactly the
  // generated `{ [key]?: JsonValue }` shape; its `any` result assigns directly.
  const data: SceneDocument["dataContext"] = JSON.parse(text);
  return { ok: true, data };
}

/** The editable text for a data context: stable, two-space JSON. */
export function formatSampleData(data: SceneDocument["dataContext"]): string {
  return JSON.stringify(data, null, 2);
}

/** Every binding in the scene that does not resolve, by object, property and path. */
export function sceneBindingIssues(document: SceneDocument): readonly BindingIssue[] {
  const resolution = resolveSceneBindings(document);
  return resolution.ok ? [] : resolution.issues;
}

/** One line an author can act on: which binding, which path, and why. */
export function describeBindingIssue(issue: BindingIssue): string {
  const target = `${issue.objectId}.${issue.property}`;
  return issue.path === undefined
    ? `${target}: ${issue.reason}`
    : `${target} → ${issue.path}: ${issue.reason}`;
}


