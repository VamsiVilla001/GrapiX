// The scene workspace: open scenes as first-class entities (build plan 11.29).
//
// **A broadcast is many graphics, not one open file.** Before this module the
// Editor held a single implicit document in shell globals, so opening a second
// scene destroyed the first one's selection, playhead, collapse state and —
// worst — its undo history. An author who switched away and back could not
// undo their own work, and there was no error message for it because nothing
// had failed: the history was simply gone.
//
// **A scene owns its state; the panels are its children.** Viewport, object
// manager, inspector, timeline, animation and bindings all render the *active*
// session. That makes the scene the top of the UI hierarchy rather than a
// sibling of the panels, which is how every broadcast CG editor models it and
// is what makes switching cheap and lossless.
//
// **Undo is per scene, and that is a correctness property, not a nicety.**
// One shared history would let Ctrl+Z in a lower-third restore a document
// belonging to a different graphic. This module makes that unrepresentable:
// there is no global stack to reach.
//
// The state here is deliberately view state, not document state. A collapsed
// group is not a property of the scene, and saving it would make two authors'
// files differ over something neither would call an edit.

import type { SceneDocument } from "@grapix/contracts";

/// Where an open scene came from, and therefore where saving sends it back.
///
/// A scene opened from a project is addressed by project and id; one created
/// or opened from a file is not, and must not pretend to be — a save that
/// guessed a project would write a graphic into the wrong show.
export interface SceneOrigin {
  readonly project: string;
  readonly sceneId: string;
}

/// One open scene and everything the panels need to render it.
///
/// `document` is the authored truth. Everything beside it is the author's
/// place in that document, which is exactly what switching must preserve.
export interface SceneSession {
  /// Stable for the lifetime of the session, independent of the document id:
  /// renaming a scene must not detach the tab the author is looking at.
  readonly key: string;
  document: SceneDocument;
  /// Absent for a scene that is not bound to a project.
  origin?: SceneOrigin;
  /// A file path, when the scene was opened from or saved to one.
  path: string | null;
  selection: string[];
  collapsed: string[];
  currentFrame: number;
  /// Whole-document snapshots. One gesture is one entry, so one undo reverses
  /// exactly one gesture.
  undoStack: SceneDocument[];
  redoStack: SceneDocument[];
  /// Edited since the last save to its origin.
  dirty: boolean;
}

export interface Workspace {
  readonly sessions: SceneSession[];
  /// The session the panels render. `undefined` only when nothing is open.
  activeKey?: string;
}

/// The ceiling on a single scene's history. A runaway stack is a memory leak
/// in a long session, and the oldest gesture is the least likely to be undone.
export const MAX_HISTORY = 200;

export function emptyWorkspace(): Workspace {
  return { sessions: [] };
}

let nextKey = 0;

/// A fresh session key. Monotonic rather than random so a test can predict it
/// and two sessions opened in one tick cannot collide.
export function newSessionKey(): string {
  nextKey += 1;
  return `session-${nextKey}`;
}

export function activeSession(workspace: Workspace): SceneSession | undefined {
  return workspace.sessions.find((session) => session.key === workspace.activeKey);
}

export function sessionFor(
  workspace: Workspace,
  origin: SceneOrigin,
): SceneSession | undefined {
  return workspace.sessions.find(
    (session) =>
      session.origin?.project === origin.project &&
      session.origin?.sceneId === origin.sceneId,
  );
}

/// Open a document as a new session, or reveal the one already showing it.
///
/// Opening the same project scene twice returns the existing session rather
/// than a second copy: two sessions over one stored scene would give the
/// author two divergent histories for one graphic and no way to say which
/// wins on save.
export function openSession(
  workspace: Workspace,
  document: SceneDocument,
  options: { origin?: SceneOrigin; path?: string | null } = {},
): SceneSession {
  const existing = options.origin ? sessionFor(workspace, options.origin) : undefined;
  if (existing) {
    workspace.activeKey = existing.key;
    return existing;
  }
  const session: SceneSession = {
    key: newSessionKey(),
    document,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    path: options.path ?? null,
    selection: [],
    collapsed: [],
    currentFrame: 0,
    undoStack: [],
    redoStack: [],
    dirty: false,
  };
  workspace.sessions.push(session);
  workspace.activeKey = session.key;
  return session;
}

/// Why a workspace action could not run. Free text, shown to the author and
/// returned to an agent verbatim: both need the specific condition.
export type WorkspaceRefusal = { readonly refused: string };

export function isRefused<T>(result: T | WorkspaceRefusal): result is WorkspaceRefusal {
  return typeof result === "object" && result !== null && "refused" in result;
}

/// Make one open scene active.
///
/// Switching never touches either document. Because each session already
/// carries its own place in its own scene, there is nothing to save or
/// restore and nothing that can be lost in the exchange.
export function activate(workspace: Workspace, key: string): SceneSession | WorkspaceRefusal {
  const session = workspace.sessions.find((candidate) => candidate.key === key);
  if (!session) return { refused: `no open scene ${key}` };
  workspace.activeKey = session.key;
  return session;
}

/// Close an open scene.
///
/// Unsaved work blocks the close by name. Discarding an author's edits because
/// they clicked the wrong tab is exactly the silent loss invariant 18 forbids;
/// `force` is the explicit confirmation, and the caller must have asked.
export function closeSession(
  workspace: Workspace,
  key: string,
  options: { force?: boolean } = {},
): SceneSession | WorkspaceRefusal {
  const index = workspace.sessions.findIndex((candidate) => candidate.key === key);
  if (index === -1) return { refused: `no open scene ${key}` };
  const session = workspace.sessions[index]!;
  if (session.dirty && options.force !== true) {
    return {
      refused: `${session.document.name} has unsaved changes; save it or close it explicitly`,
    };
  }
  workspace.sessions.splice(index, 1);
  if (workspace.activeKey === key) {
    // Prefer the neighbour on the left, which is where the author's attention
    // already was; falling back to the new first session keeps something open
    // whenever anything remains.
    const neighbour = workspace.sessions[index - 1] ?? workspace.sessions[0];
    // Deleted rather than set to `undefined`: "no scene is active" is the
    // absence of a key, and the two must not become separately representable.
    if (neighbour) workspace.activeKey = neighbour.key;
    else delete workspace.activeKey;
  }
  return session;
}

/// Record a completed edit on one session.
///
/// The session is named explicitly rather than assumed to be the active one:
/// an edit that landed while the author switched tabs must still be recorded
/// against the scene it actually changed.
export function commit(session: SceneSession, next: SceneDocument): void {
  session.undoStack.push(session.document);
  if (session.undoStack.length > MAX_HISTORY) session.undoStack.shift();
  session.redoStack = [];
  session.document = next;
  session.dirty = true;
}

export function undo(session: SceneSession): SceneDocument | undefined {
  const previous = session.undoStack.pop();
  if (!previous) return undefined;
  session.redoStack.push(session.document);
  session.document = previous;
  session.dirty = true;
  return previous;
}

export function redo(session: SceneSession): SceneDocument | undefined {
  const next = session.redoStack.pop();
  if (!next) return undefined;
  session.undoStack.push(session.document);
  session.document = next;
  session.dirty = true;
  return next;
}

/// Mark a session saved to its origin, and bind it to that origin.
export function markSaved(session: SceneSession, origin?: SceneOrigin): void {
  if (origin) session.origin = origin;
  session.dirty = false;
}

/// What the scene switcher shows for one open scene.
export interface SceneTab {
  readonly key: string;
  readonly label: string;
  /// Project-qualified origin, or `undefined` for an unbound scene. Shown so
  /// two scenes with the same name in different shows are distinguishable.
  readonly origin?: string;
  readonly active: boolean;
  readonly dirty: boolean;
}

export function sceneTabs(workspace: Workspace): SceneTab[] {
  return workspace.sessions.map((session) => ({
    key: session.key,
    label: session.document.name || session.document.id,
    ...(session.origin === undefined
      ? {}
      : { origin: `${session.origin.project}/${session.origin.sceneId}` }),
    active: session.key === workspace.activeKey,
    dirty: session.dirty,
  }));
}
