// What a person has typed into the scene's identity fields and not yet applied (the new Figma UI, row 11.67; the identifiers of row 1.13).
//
// A scene has three things a person reads as "its name", and they are different:
//  - the Name: what the scene is called (`setSceneName`);
//  - the Scene ID: a label shown and edited in both applications, which no reference holds (`setSceneLabel`);
//  - the file name: the scene's key in the project, an address that is chosen once, when the scene is first saved to a project, and never
//    changed afterwards (`setSceneId`); the field is read-only (and the page hides it) once the scene belongs to a project.
//
// Identity is document content, so it changes only through edits; the page sends the ones this returns just before a save or a publish
// uses them, and shows the tab as unsaved while any is waiting.

import type { SceneDocument, SceneEdit } from "../../Shared/generated-ts/src";

export interface TypedIdentity {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  /** The scene belongs to a project: its key is its address and is not edited. */
  readonly idLocked: boolean;
}

/** The edits that make the document say what was typed. Nothing is returned for a field that already says it. */
export function identityEdits(document: Pick<SceneDocument, "id" | "name" | "sceneLabel">, typed: TypedIdentity): SceneEdit[] {
  const edits: SceneEdit[] = [];
  const id = typed.id.trim();
  const name = typed.name.trim();
  const label = typed.label.trim();
  if (!typed.idLocked && id !== document.id) edits.push({ edit: "setSceneId", id });
  if (name !== document.name) edits.push({ edit: "setSceneName", name });
  if (label !== (document.sceneLabel ?? "")) edits.push({ edit: "setSceneLabel", label });
  return edits;
}

/** The edits in words, for the activity line: "file name news-1 and Scene ID 7". */
export function describeIdentityEdits(edits: readonly SceneEdit[]): string {
  return edits
    .map((edit) => {
      switch (edit.edit) {
        case "setSceneId":
          return `file name ${edit.id}`;
        case "setSceneName":
          return `name ${edit.name}`;
        case "setSceneLabel":
          return edit.label === "" ? "no Scene ID" : `Scene ID ${edit.label}`;
        default:
          return edit.edit;
      }
    })
    .join(" and ");
}
