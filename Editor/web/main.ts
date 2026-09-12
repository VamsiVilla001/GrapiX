// The Editor shell's web layer (build plan 11.1).
//
// This file is wiring, deliberately. Every decision it could get wrong lives
// somewhere already tested:
//
//   - what a scene is, and whether one is valid: the Rust shell, which parses
//     through the same `parse_scene_document` the engine uses (invariant 45);
//   - how the scene is drawn: `Editor/src/viewport.ts`, tested headless;
//   - what a colour means: `Editor/src/color-policy.ts` and the contracts.
//
// What is left here is turning clicks into `invoke` calls and rendering the
// answers. In particular this layer never decides that an object "could not
// be drawn" quietly: `SceneViewport` collects reasons, and they are shown.

import type { SceneDocument } from "@grapix/contracts";
import { SceneViewport } from "../src/viewport";

/** Tauri v2's global bridge. Typed narrowly: this layer uses exactly one
 *  function from it, and pretending to know more would be fiction. */
interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  dialog?: {
    open(options?: Record<string, unknown>): Promise<string | string[] | null>;
    save(options?: Record<string, unknown>): Promise<string | null>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

/** What `cmd_publish` answers with. */
interface PublishResult {
  takeId: string | { 0: string };
  revision: number | { 0: number };
}

/** The shell's structured errors. Every variant carries enough to say what
 *  actually happened; a bare string would let a refusal read as a crash. */
interface ShellError {
  error: string;
  detail?: string;
  path?: string;
  endpoint?: string;
}

const tauri = window.__TAURI__;

// ---------------------------------------------------------------------------
// Element handles. Resolved once; a missing id is a build error, not a
// silently absent feature.
// ---------------------------------------------------------------------------

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the Editor markup is missing #${id}`);
  return element as T;
}

const ui = {
  curtain: need<HTMLDivElement>("not-in-shell"),
  sceneId: need<HTMLInputElement>("scene-id"),
  sceneName: need<HTMLInputElement>("scene-name"),
  newScene: need<HTMLButtonElement>("new-scene"),
  openScene: need<HTMLButtonElement>("open-scene"),
  saveScene: need<HTMLButtonElement>("save-scene"),
  canvas: need<HTMLCanvasElement>("viewport"),
  canvasSize: need<HTMLSpanElement>("canvas-size"),
  objectList: need<HTMLUListElement>("object-list"),
  objectEmpty: need<HTMLParagraphElement>("object-empty"),
  unsupportedPanel: need<HTMLElement>("unsupported-panel"),
  unsupportedList: need<HTMLUListElement>("unsupported-list"),
  endpoint: need<HTMLInputElement>("endpoint"),
  publish: need<HTMLButtonElement>("publish"),
  publishResult: need<HTMLDivElement>("publish-result"),
  log: need<HTMLUListElement>("log"),
};

// ---------------------------------------------------------------------------
// State. One open document, one viewport over it.
// ---------------------------------------------------------------------------

let scene: SceneDocument | null = null;
let viewport: SceneViewport | null = null;
let scenePath: string | null = null;

// ---------------------------------------------------------------------------
// Logging. Append-only, newest first, and it records refusals as refusals.
// ---------------------------------------------------------------------------

type Outcome = "good" | "bad" | "plain";

function log(message: string, outcome: Outcome = "plain"): void {
  const entry = document.createElement("li");
  if (outcome !== "plain") entry.className = outcome;

  const when = document.createElement("span");
  when.className = "log-when";
  when.textContent = new Date().toLocaleTimeString(undefined, { hour12: false });

  const what = document.createElement("span");
  what.className = "log-what";
  what.textContent = message;

  entry.append(when, what);
  ui.log.prepend(entry);

  // A log that grows without bound is a memory leak in a long authoring
  // session. The oldest lines are the least useful.
  while (ui.log.childElementCount > 200) ui.log.lastElementChild?.remove();
}

/** Turn a rejected `invoke` into one operator-facing line.
 *
 *  The shell's errors are structured, so the distinct cases stay distinct:
 *  an unreachable asset plane and a refused document are different problems
 *  and an author can only act differently on them if the message says which
 *  it was (invariant 17). */
function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    const shell = error as ShellError;
    switch (shell.error) {
      case "readScene":
        return `cannot read ${shell.path ?? "the file"}: ${shell.detail ?? ""}`;
      case "writeScene":
        return `cannot write ${shell.path ?? "the file"}: ${shell.detail ?? ""}`;
      case "invalidScene":
        return `scene refused: ${shell.detail ?? ""}`;
      case "invalidEndpoint":
        return `${shell.endpoint ?? "endpoint"} is not a host:port address`;
      case "unreachable":
        return `asset plane unreachable at ${shell.endpoint ?? ""}: ${shell.detail ?? ""}`;
      case "publishRefused":
        return `publication refused: ${shell.detail ?? ""}`;
      default:
        return `${shell.error}: ${shell.detail ?? ""}`;
    }
  }
  return String(error);
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauri) return Promise.reject(new Error("not running inside the Editor shell"));
  return tauri.core.invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// Rendering the open document.
// ---------------------------------------------------------------------------

/** Unwrap a newtype that serde may emit either bare or as a tuple struct. */
function plain(value: unknown): string {
  if (value !== null && typeof value === "object" && "0" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)[0]);
  }
  return String(value);
}

function showScene(next: SceneDocument, path: string | null): void {
  scene = next;
  scenePath = path;

  ui.sceneId.value = next.id;
  ui.sceneName.value = next.name;
  ui.canvasSize.textContent = `${next.canvas.width} × ${next.canvas.height} @ ${next.canvas.frameRate.num}/${next.canvas.frameRate.den}`;

  // The canvas is sized to the scene so one scene unit is one canvas pixel.
  // CSS scales it down to fit; the backing store stays at authored size, so
  // the preview is not resolution-dependent on the window.
  ui.canvas.width = next.canvas.width;
  ui.canvas.height = next.canvas.height;

  viewport?.dispose();
  viewport = new SceneViewport(ui.canvas, next);
  viewport.render();

  renderObjectList(next);
  renderUnsupported(viewport.unsupported);
}

function renderObjectList(document_: SceneDocument): void {
  ui.objectList.replaceChildren();
  ui.objectEmpty.hidden = document_.objects.length > 0;

  for (const object of document_.objects) {
    const row = document.createElement("li");

    const kind = document.createElement("span");
    kind.className = "object-kind";
    kind.textContent = object.type;

    const name = document.createElement("span");
    name.className = "object-name";
    name.textContent = object.name;

    const id = document.createElement("span");
    id.className = "object-id";
    id.textContent = object.id;

    row.append(kind, name, id);
    ui.objectList.append(row);
  }
}

/** Show what the preview could not draw.
 *
 *  Never silently skipped: an object missing from the picture with no
 *  explanation is the failure mode invariant 18 exists to prevent, and the
 *  preview obeys the same rule the engine does. */
function renderUnsupported(reasons: readonly string[]): void {
  ui.unsupportedList.replaceChildren();
  ui.unsupportedPanel.hidden = reasons.length === 0;
  for (const reason of reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    ui.unsupportedList.append(item);
  }
  if (reasons.length > 0) {
    log(`${reasons.length} object(s) not drawn by the preview`, "bad");
  }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function newScene(): Promise<void> {
  const id = ui.sceneId.value.trim() || "untitled";
  const name = ui.sceneName.value.trim() || "Untitled";
  try {
    const created = await invoke<SceneDocument>("cmd_new_scene", { id, name });
    showScene(created, null);
    log(`new scene ${created.id}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function openScene(): Promise<void> {
  try {
    const picked = await tauri?.dialog?.open({
      multiple: false,
      filters: [{ name: "Scene document", extensions: ["json"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;

    const loaded = await invoke<SceneDocument>("cmd_load_scene", { path });
    showScene(loaded, path);
    log(`opened ${path}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function saveScene(): Promise<void> {
  if (!scene) {
    log("nothing to save", "bad");
    return;
  }
  try {
    const path =
      scenePath ??
      (await tauri?.dialog?.save({
        defaultPath: `${scene.id}.json`,
        filters: [{ name: "Scene document", extensions: ["json"] }],
      }));
    if (!path) return;

    // Identity edits apply on save: the fields are the document's, not a
    // separate piece of UI state that could drift from it.
    scene = { ...scene, id: ui.sceneId.value.trim(), name: ui.sceneName.value.trim() };
    await invoke<void>("cmd_save_scene", { path, scene });
    scenePath = path;
    log(`saved ${path}`, "good");
  } catch (error) {
    log(describe(error), "bad");
  }
}

async function publish(): Promise<void> {
  if (!scene) {
    log("nothing to publish", "bad");
    return;
  }
  const endpoint = ui.endpoint.value.trim();
  ui.publish.disabled = true;
  ui.publishResult.hidden = true;

  try {
    scene = { ...scene, id: ui.sceneId.value.trim(), name: ui.sceneName.value.trim() };
    const result = await invoke<PublishResult>("cmd_publish", { endpoint, scene });
    const takeId = plain(result.takeId);
    const revision = plain(result.revision);

    // The revision is the operative fact: Playout takes an exact revision, so
    // reporting "published" without it would leave the operator guessing.
    ui.publishResult.className = "result good";
    ui.publishResult.textContent = `${takeId} revision ${revision}`;
    ui.publishResult.hidden = false;
    log(`published ${takeId} revision ${revision}`, "good");
  } catch (error) {
    const message = describe(error);
    ui.publishResult.className = "result bad";
    ui.publishResult.textContent = message;
    ui.publishResult.hidden = false;
    log(message, "bad");
  } finally {
    ui.publish.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Start.
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  // The curtain is visible in the markup, so this is the only place it comes
  // down: no shell, no Editor. Everything below this line can assume `invoke`
  // actually reaches Rust.
  if (!tauri) return;
  ui.curtain.hidden = true;

  ui.newScene.addEventListener("click", () => void newScene());
  ui.openScene.addEventListener("click", () => void openScene());
  ui.saveScene.addEventListener("click", () => void saveScene());
  ui.publish.addEventListener("click", () => void publish());

  try {
    ui.endpoint.value = await invoke<string>("cmd_default_endpoint");
  } catch {
    // A default that cannot be read is not fatal; the author types one.
    ui.endpoint.value = "";
  }

  ui.sceneId.value = "untitled";
  ui.sceneName.value = "Untitled";
  await newScene();
}

void start();
