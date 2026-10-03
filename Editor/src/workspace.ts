// Browser-local state for Rust-owned scene sessions (11.29, 11.36).
//
// **A broadcast is many graphics, not one open file.** Each open scene is a
// session in the Rust workspace (`gx_editor::command::Workspace`), which owns
// its document, origin, file path, undo/redo history and unsaved marks. The
// browser holds the last `SessionView` Rust returned for each one — a
// read-only projection — paired with the place the author is looking:
// selection, collapsed rows, playhead and take-page controls. Those are view
// state, never document content, so switching tabs must keep them and no
// edit may be needed to restore them.

import type { SceneDocument, SceneOrigin, SessionKey, SessionView } from "@grapix/contracts";
import type { TakePageState } from "./take-page";

/** A Rust session projection paired with browser-only view state. */
export interface SceneSession {
  readonly key: SessionKey;
  view: SessionView;
  selection: string[];
  collapsed: string[];
  timelineCollapsed: string[];
  currentFrame: number;
  takePage: TakePageState;
  takePagePreview: SceneDocument | null;
}

export interface Workspace {
  readonly sessions: SceneSession[];
  activeKey?: SessionKey;
}

export function emptyWorkspace(): Workspace {
  return { sessions: [] };
}

export function activeSession(workspace: Workspace): SceneSession | undefined {
  return workspace.sessions.find((session) => session.key === workspace.activeKey);
}

/** The open session showing a stored scene, if any. */
export function sessionFor(workspace: Workspace, origin: SceneOrigin): SceneSession | undefined {
  return workspace.sessions.find(
    (session) =>
      session.view.origin?.project === origin.project &&
      session.view.origin?.sceneId === origin.sceneId,
  );
}

/// Store a projection Rust returned, keeping the session's view state.
///
/// A view for a key already open replaces only the projection: an edit, an
/// undo or a save must not lose the author's selection or playhead. A new key
/// becomes a new session with empty view state. Neither activates anything.
export function applySessionView(workspace: Workspace, view: SessionView): SceneSession {
  const existing = workspace.sessions.find((session) => session.key === view.session);
  if (existing) {
    existing.view = view;
    return existing;
  }
  const session: SceneSession = {
    key: view.session,
    view,
    selection: [],
    collapsed: [],
    timelineCollapsed: [],
    currentFrame: 0,
    takePage: { values: {}, pageId: "", name: "" },
    takePagePreview: null,
  };
  workspace.sessions.push(session);
  return session;
}

/// Forget a session after Rust accepted `CloseScene` for it.
///
/// If it was active, its left neighbour becomes active (or the first, or
/// nothing): the author lands next to the tab they closed, not at an
/// arbitrary end.
export function removeSession(workspace: Workspace, key: SessionKey): SceneSession | undefined {
  const index = workspace.sessions.findIndex((session) => session.key === key);
  if (index < 0) return undefined;
  const [removed] = workspace.sessions.splice(index, 1);
  if (workspace.activeKey === key) {
    const neighbour = workspace.sessions[index - 1] ?? workspace.sessions[0];
    if (neighbour) workspace.activeKey = neighbour.key;
    else delete workspace.activeKey;
  }
  return removed;
}

/// Why a workspace action could not run. Free text, shown to the author.
export type WorkspaceRefusal = { readonly refused: string };

export function isRefused<T>(result: T | WorkspaceRefusal): result is WorkspaceRefusal {
  return typeof result === "object" && result !== null && "refused" in result;
}

export function activate(workspace: Workspace, key: SessionKey): SceneSession | WorkspaceRefusal {
  const session = workspace.sessions.find((candidate) => candidate.key === key);
  if (!session) return { refused: `no open scene ${key}` };
  workspace.activeKey = session.key;
  return session;
}

/// The view state the shell's flat globals carry for the active session.
export interface SessionWorkingCopy {
  readonly selection: string[];
  readonly collapsed: string[];
  readonly timelineCollapsed: string[];
  readonly currentFrame: number;
  readonly takePage: TakePageState;
  readonly takePagePreview: SceneDocument | null;
}

/** Save browser-only view state before leaving a tab. */
export function captureWorkingCopy(session: SceneSession, copy: SessionWorkingCopy): void {
  session.selection = copy.selection;
  session.collapsed = copy.collapsed;
  session.timelineCollapsed = copy.timelineCollapsed;
  session.currentFrame = copy.currentFrame;
  session.takePage = copy.takePage;
  session.takePagePreview = copy.takePagePreview;
}

export interface SceneTab {
  readonly key: SessionKey;
  readonly label: string;
  readonly origin?: string;
  readonly active: boolean;
  readonly dirty: boolean;
}

/// One tab per open scene. The unsaved mark is Rust's: only an edit or a
/// save changes it, never a switch.
export function sceneTabs(workspace: Workspace): SceneTab[] {
  return workspace.sessions.map((session) => ({
    key: session.key,
    label: session.view.document.name || session.view.document.id,
    ...(session.view.origin === undefined
      ? {}
      : { origin: `${session.view.origin.project}/${session.view.origin.sceneId}` }),
    active: session.key === workspace.activeKey,
    dirty: session.view.dirty,
  }));
}
