// The Start card over an empty graphic (the new Figma UI, B1 Start; plan rows 11.43 and 11.64).
//
// The owner decided (25 Nov 2026) that the Start screen fills the empty-graphic view rather than being a tab. What is drawn is only
// what the Editor can stand behind, asked of Jev and Laya before it was written (docs/evidence/figma-ui/jev-laya-start.json):
//   - tiles: a blank graphic and an SVG work; a Figma frame (row 18.2, brought in through an agent's Figma connection) and a PSD (row
//     11.59) are shown dimmed with the row that owns them, as the menus do for a command that waits for a row;
//   - a Format line that is the open graphic's own canvas, rate, depth and colour space (there is no Event in the contracts);
//   - the project's other graphics, named "Graphics in this project" and not "Recent" because the scene list carries no time of last
//     opening, each with what the list can state: SENT vN, NOT SENT, or WILL NOT OPEN. The design's READY TO SEND, DATA STALE and FONT
//     MISSING chips are not drawn: nothing here knows a graphic's data is stale (no Data Hub), and font state is resolved only for the
//     graphic that is open. No step chips and no Fix next issue (owner, 24 Nov).
//
// Pure: it reads the scene and the project's scene list and returns what to draw. The view draws it; nothing here calls the shell.

import type { SceneDocument } from "@grapix/contracts";

import { EMPTY_GRAPHIC } from "./elements-list";

export type TileId = "blank" | "svg" | "figma" | "psd";
export type TileAction = "add-box" | "bring-in";

export interface StartTile {
  readonly id: TileId;
  readonly title: string;
  readonly body: string;
  /** What a click does; absent for a tile that waits for a row. */
  readonly action?: TileAction;
  /** The words of the command a working tile runs (its tooltip). */
  readonly hint?: string;
  /** The row a dimmed tile waits for, and what that means in words (the tooltip). */
  readonly waitsOn?: { readonly row: string; readonly words: string };
}

export const START_TITLE = "Start a graphic";
export const LIST_TITLE = "Graphics in this project";

export const START_TILES: readonly StartTile[] = [
  { id: "blank", title: "Blank graphic", body: "You set the size and format, then design the layout yourself", action: "add-box", hint: EMPTY_GRAPHIC.add },
  { id: "figma", title: "From a Figma frame", body: "bring in a frame and keep it linked", waitsOn: { row: "18.2", words: "A Figma frame comes in through an approved AI agent's Figma connection; there is no button for it in the Editor yet (row 18.2)." } },
  { id: "psd", title: "From a PSD", body: "layers and layer styles come in", waitsOn: { row: "11.59", words: "PSD import is not built yet (row 11.59)." } },
  { id: "svg", title: "From an SVG", body: "vector artwork", action: "bring-in", hint: EMPTY_GRAPHIC.bringIn },
];

/** The fixed sentence under the tiles: nothing is preset. */
export const START_NOTE = "GrapiX does not start you from a preset layout; every graphic is laid out by you.";
/** What the list says when the project holds no other graphic. */
export const NO_OTHER_GRAPHICS = "This project has no other graphic yet. A graphic you save, or bring in, is listed here.";
/** The sentence under the list: what each chip says. */
export const LIST_NOTE = "Each graphic shows whether it has been sent to Playout: SENT with its revision, or NOT SENT.";

/** One graphic as the project's scene list gives it. */
export interface ListedGraphic {
  readonly sceneId: string;
  readonly name: string;
  readonly publishedRevision?: number;
  readonly unavailableReason?: string;
}

export interface StartRow {
  readonly sceneId: string;
  readonly name: string;
  readonly chip: { readonly text: string; readonly tone: "ok" | "neutral" | "danger" };
  /** A graphic whose file will not parse is shown and named, not opened. */
  readonly openable: boolean;
  /** Why it will not open, in the file's own words; empty when it does. */
  readonly detail: string;
}

export interface StartView {
  readonly title: string;
  readonly tiles: readonly StartTile[];
  readonly format: string;
  readonly note: string;
  readonly listTitle: string;
  readonly rows: readonly StartRow[];
  readonly listNote: string;
  /** Said instead of the rows when there are none. */
  readonly empty: string | undefined;
}

const SPACE_WORDS: Readonly<Record<SceneDocument["workingColorSpace"], string>> = { srgb: "sRGB", "linear-srgb": "linear sRGB" };

/** The open graphic's own format, in the words the header uses: size, rate, bit depth, colour space. */
export function formatLine(document: Pick<SceneDocument, "canvas" | "colorDepth" | "workingColorSpace">): string {
  const { width, height, frameRate } = document.canvas;
  const rate = frameRate.den === 1 ? frameRate.num : Math.round((frameRate.num / frameRate.den) * 100) / 100;
  return `${width}×${height} · ${rate} fps · ${document.colorDepth} bit · ${SPACE_WORDS[document.workingColorSpace]}`;
}

/** The project's other graphics, in the order the list gives them, each with the one chip the list can state. */
export function startRows(scenes: readonly ListedGraphic[], currentSceneId: string | undefined): StartRow[] {
  return scenes
    .filter((listed) => listed.sceneId !== currentSceneId)
    .map((listed) => {
      if (listed.unavailableReason !== undefined) {
        return { sceneId: listed.sceneId, name: listed.name, chip: { text: "Will not open", tone: "danger" as const }, openable: false, detail: listed.unavailableReason };
      }
      if (listed.publishedRevision !== undefined) {
        return { sceneId: listed.sceneId, name: listed.name, chip: { text: `Sent r${listed.publishedRevision}`, tone: "ok" as const }, openable: true, detail: "" };
      }
      return { sceneId: listed.sceneId, name: listed.name, chip: { text: "Not sent", tone: "neutral" as const }, openable: true, detail: "" };
    });
}

export interface StartInput {
  readonly document: Pick<SceneDocument, "canvas" | "colorDepth" | "workingColorSpace">;
  /** The project's graphics; `undefined` when there is no project open or the list has not arrived. */
  readonly scenes: readonly ListedGraphic[] | undefined;
  readonly currentSceneId: string | undefined;
}

export function startView(input: StartInput): StartView {
  const rows = input.scenes === undefined ? [] : startRows(input.scenes, input.currentSceneId);
  return {
    title: START_TITLE,
    tiles: START_TILES,
    format: formatLine(input.document),
    note: START_NOTE,
    listTitle: LIST_TITLE,
    rows,
    listNote: LIST_NOTE,
    empty: rows.length === 0 ? NO_OTHER_GRAPHICS : undefined,
  };
}

/** The tools that draw on the stage: with one armed the card gets out of the way, so a path can still be started on an empty graphic. */
const DRAWING_TOOLS: ReadonlySet<string> = new Set(["pen", "path", "vertex-add", "vertex-delete", "vertex-convert"]);

/** The Start card is drawn only while the graphic has no element and no tool that draws on the stage is armed. */
export function startCardShown(objectCount: number, activeTool: string): boolean {
  return objectCount === 0 && !DRAWING_TOOLS.has(activeTool);
}
