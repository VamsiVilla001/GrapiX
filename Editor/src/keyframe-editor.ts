// Keyframe authoring panel: diamonds, Auto-Key and multi-select (11.21).
//
// Mutation rules do not live here. The browser sends value edits and keyframe
// toggles to the Editor shell, which calls the Rust contract that MCP and the
// engine share. This module is the projection: it turns the current selection,
// playhead and scene into an accessible panel and the intents the wiring
// dispatches. Properties, object kinds and easing names arrive through
// `AnimationSurface`; none is restated in TypeScript.

import type {
  AnimationSurface,
  CubicBezier,
  KeyframeChannel,
  SceneDocument,
  SceneEasing,
  SceneKeyframe,
  SceneObject,
} from "@grapix/contracts";

/// Whether a keyframe exists at the playhead across the whole selection.
export type KeyState = "none" | "all" | "partial";

export interface KeyframeRow {
  readonly property: string;
  readonly label: string;
  /// Shared base value across the selection, or `null` when they differ.
  readonly value: number | null;
  /// Selected objects that carry this property.
  readonly objectIds: readonly string[];
  /// Of those, the ones with a key at the current playhead.
  readonly objectsWithKey: readonly string[];
  readonly keyState: KeyState;
  /// Single-selection extras, present only when exactly one object is selected.
  readonly channel?: KeyframeChannel;
  readonly currentKey?: SceneKeyframe;
}

export type KeyframePanelModel =
  | {
      readonly available: false;
      readonly reason: string;
      readonly currentFrame: number;
      readonly durationFrames: number;
    }
  | {
      readonly available: true;
      readonly objectIds: readonly string[];
      readonly summary: string;
      readonly single: boolean;
      readonly currentFrame: number;
      readonly durationFrames: number;
      readonly rows: readonly KeyframeRow[];
    };

export interface KeyframeContextItem {
  readonly property: string;
  readonly label: string;
  readonly action: "create" | "remove";
}

/// The objects a diamond toggle should act on, and whether it adds or removes.
export interface ToggleIntent {
  readonly action: "create" | "remove";
  readonly objectIds: readonly string[];
}

function asFrame(value: bigint | number): number {
  return Number(value);
}

export function clampFrame(frame: number, durationFrames: bigint | number): number {
  const duration = Math.max(0, asFrame(durationFrames));
  if (!Number.isFinite(frame)) return 0;
  return Math.min(duration, Math.max(0, Math.round(frame)));
}

export function propertyLabel(property: string): string {
  const words = property.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function baseValueOf(
  document: SceneDocument,
  objectId: string,
  property: string,
): number | undefined {
  const object = document.objects.find((candidate) => candidate.id === objectId);
  if (!object) return undefined;
  const value = (object as unknown as Record<string, unknown>)[property];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function channelFor(
  document: SceneDocument,
  objectId: string,
  property: string,
): KeyframeChannel | undefined {
  return (document.timeline.channels ?? []).find(
    (channel) => channel.objectId === objectId && channel.property === property,
  );
}

function keyAt(
  document: SceneDocument,
  objectId: string,
  property: string,
  frame: number,
): SceneKeyframe | undefined {
  return channelFor(document, objectId, property)?.keys.find(
    (key) => asFrame(key.frame) === frame,
  );
}

function selectedObjects(
  document: SceneDocument,
  selectedIds: readonly string[],
): SceneObject[] {
  return document.objects.filter((object) => selectedIds.includes(object.id));
}

export function keyframePanelModel(
  document: SceneDocument,
  selectedIds: readonly string[],
  surface: AnimationSurface | null,
  requestedFrame: number,
): KeyframePanelModel {
  const durationFrames = asFrame(document.timeline.durationFrames);
  const currentFrame = clampFrame(requestedFrame, durationFrames);
  if (!surface) {
    return { available: false, reason: "Animation contract unavailable", currentFrame, durationFrames };
  }
  if (selectedIds.length === 0) {
    return { available: false, reason: "Select an object to edit keyframes", currentFrame, durationFrames };
  }

  const selected = selectedObjects(document, selectedIds);
  const animatable = selected.filter((object) => surface.objectKinds.includes(object.type));
  if (animatable.length === 0) {
    const kinds = [...new Set(selected.map((object) => object.type))].join(", ");
    return {
      available: false,
      reason: `${kinds} ${selected.length === 1 ? "does" : "do"} not expose editable keyframes`,
      currentFrame,
      durationFrames,
    };
  }

  const rows = surface.properties.flatMap((property): KeyframeRow[] => {
    const withProp = animatable.filter(
      (object) => baseValueOf(document, object.id, property) !== undefined,
    );
    if (withProp.length === 0) return [];
    const objectIds = withProp.map((object) => object.id);
    const values = objectIds.map((id) => baseValueOf(document, id, property)!);
    const allEqual = values.every((value) => Object.is(value, values[0]));
    const objectsWithKey = objectIds.filter(
      (id) => keyAt(document, id, property, currentFrame) !== undefined,
    );
    const keyState: KeyState =
      objectsWithKey.length === 0
        ? "none"
        : objectsWithKey.length === objectIds.length
          ? "all"
          : "partial";
    const single = objectIds.length === 1;
    const channel = single ? channelFor(document, objectIds[0]!, property) : undefined;
    const currentKey = single ? keyAt(document, objectIds[0]!, property, currentFrame) : undefined;
    return [
      {
        property,
        label: propertyLabel(property),
        value: allEqual ? values[0]! : null,
        objectIds,
        objectsWithKey,
        keyState,
        ...(channel === undefined ? {} : { channel }),
        ...(currentKey === undefined ? {} : { currentKey }),
      },
    ];
  });

  const summary =
    animatable.length === 1
      ? `${animatable[0]!.name} · ${animatable[0]!.type} · frame ${currentFrame}`
      : `${animatable.length} objects · frame ${currentFrame}`;

  return {
    available: true,
    objectIds: animatable.map((object) => object.id),
    summary,
    single: animatable.length === 1,
    currentFrame,
    durationFrames,
    rows,
  };
}

/// What toggling a row's diamond should do: remove when every object already
/// has a key, otherwise create on those that do not (bringing a partial or
/// empty selection to a consistent keyed state).
export function toggleIntent(row: KeyframeRow): ToggleIntent {
  if (row.keyState === "all") {
    return { action: "remove", objectIds: row.objectIds };
  }
  const missing = row.objectIds.filter((id) => !row.objectsWithKey.includes(id));
  return { action: "create", objectIds: missing };
}

export function keyframeContextItems(
  model: KeyframePanelModel,
  onlyProperty?: string,
): readonly KeyframeContextItem[] {
  if (!model.available) return [];
  return model.rows
    .filter((row) => onlyProperty === undefined || row.property === onlyProperty)
    .map((row) => {
      const intent = toggleIntent(row);
      return {
        property: row.property,
        label: `${intent.action === "remove" ? "Remove" : "Add"} ${row.label} key at frame ${model.currentFrame}`,
        action: intent.action,
      };
    });
}

export function keyframeForValue(
  value: number,
  frame: number,
  easing: SceneEasing = "ease-in-out",
): SceneKeyframe {
  return {
    // `ts-rs` maps Rust u64 to bigint, while serde/Tauri carries a JSON
    // number. Keep the runtime wire value serialisable and contain that
    // generator mismatch at this boundary.
    frame: frame as unknown as bigint,
    value,
    easing,
  };
}

export function customBezierFromInputs(values: readonly number[]): CubicBezier | undefined {
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return undefined;
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return undefined;
  return { x1, y1, x2, y2 };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function button(document: Document, label: string, action: string, property?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.dataset.animationAction = action;
  if (property !== undefined) element.dataset.property = property;
  return element;
}

function numberInput(document: Document, className: string, value: number | null, label: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = className;
  input.value = value === null ? "" : String(value);
  if (value === null) input.placeholder = "Mixed";
  input.setAttribute("aria-label", label);
  return input;
}

const DIAMOND: Record<KeyState, string> = { none: "◇", all: "◆", partial: "◈" };

/// Render the panel from the pure model. Every actionable element carries
/// `data-animation-action`; the wiring dispatches those to Rust and never
/// mutates a channel itself.
export function renderKeyframePanel(
  document: Document,
  model: KeyframePanelModel,
  surface: AnimationSurface | null,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "animation-editor";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Keyframe editor");

  if (!model.available) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = model.reason;
    root.append(empty);
    return root;
  }

  const summary = document.createElement("p");
  summary.className = "animation-summary";
  summary.textContent = model.summary;
  root.append(summary);

  const list = document.createElement("div");
  list.className = "keyframe-rows";
  list.setAttribute("role", "grid");
  list.setAttribute("aria-label", "Keyframes");

  for (const row of model.rows) {
    const element = document.createElement("div");
    element.className = `keyframe-row${row.keyState !== "none" ? " has-current-key" : ""}`;
    element.dataset.property = row.property;
    element.setAttribute("role", "row");

    const heading = document.createElement("div");
    heading.className = "keyframe-row-head";
    const intent = toggleIntent(row);
    const toggle = button(document, DIAMOND[row.keyState], intent.action, row.property);
    toggle.classList.add("keyframe-toggle", row.keyState);
    toggle.title =
      intent.action === "remove"
        ? `Remove ${row.label} key at frame ${model.currentFrame}`
        : `Add ${row.label} key at frame ${model.currentFrame}`;
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", String(row.keyState === "all"));

    const name = document.createElement("span");
    name.className = "keyframe-property";
    name.textContent = row.label;

    // The base value is editable: Auto-Key decides whether an edit also keys.
    const value = numberInput(document, "keyframe-authored-value", row.value, `${row.label} value`);
    value.step = "any";
    value.dataset.animationAction = "value";
    value.dataset.property = row.property;

    heading.append(toggle, name, value);
    element.append(heading);

    if (model.single && row.channel && row.channel.keys.length > 0) {
      const strip = document.createElement("div");
      strip.className = "keyframe-strip";
      strip.setAttribute("aria-label", `${row.label} keyframes`);
      for (const key of row.channel.keys) {
        const frame = asFrame(key.frame);
        const chip = button(document, `◆ ${frame}`, "seek", row.property);
        chip.className = frame === model.currentFrame ? "keyframe-chip current" : "keyframe-chip";
        chip.dataset.frame = String(frame);
        chip.setAttribute("aria-label", `${row.label} key at frame ${frame}`);
        strip.append(chip);
      }
      element.append(strip);
    }

    if (model.single && row.currentKey) {
      const editor = document.createElement("div");
      editor.className = "keyframe-detail";

      const keyValue = numberInput(document, "keyframe-value", row.currentKey.value, `${row.label} key value`);
      keyValue.step = "any";

      const easing = document.createElement("select");
      easing.className = "keyframe-easing";
      easing.setAttribute("aria-label", `${row.label} easing`);
      for (const name of surface?.easings ?? []) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = propertyLabel(name);
        option.selected = name === row.currentKey.easing;
        easing.append(option);
      }

      const bezier = document.createElement("div");
      bezier.className = "bezier-controls";
      bezier.dataset.bezierControls = "";
      bezier.hidden = row.currentKey.easing !== "custom-bezier";
      const currentBezier = row.currentKey.bezier ?? { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
      for (const [name, control] of Object.entries(currentBezier)) {
        const input = numberInput(document, `bezier-${name}`, control, name);
        input.step = "0.01";
        if (name === "x1" || name === "x2") {
          input.min = "0";
          input.max = "1";
        }
        bezier.append(input);
      }

      const moveTo = numberInput(document, "keyframe-move-to", model.currentFrame, `Move ${row.label} key to frame`);
      moveTo.min = "0";
      moveTo.max = String(model.durationFrames);
      moveTo.step = "1";

      editor.append(
        keyValue,
        easing,
        bezier,
        moveTo,
        button(document, "Apply", "update", row.property),
        button(document, "Move", "move", row.property),
      );
      element.append(editor);
    }

    list.append(element);
  }
  root.append(list);
  return root;
}
