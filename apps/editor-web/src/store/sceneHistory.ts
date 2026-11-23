import type { SceneDocument } from "@grapix/shared-types";

/** Each history point owns an exact, detached scene snapshot. Time is metadata, not an undo key. */
export interface SceneHistoryPoint {
  id: number;
  label: string;
  timestamp: number;
  scene: SceneDocument;
  selectedObjectId: string | null;
}

export interface SceneHistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  currentIndex: number;
  totalStates: number;
  entries: Array<{ id: number; label: string; timestamp: number; current: boolean }>;
}

interface Transaction {
  scene: SceneDocument;
  selectedObjectId: string | null;
  label: string;
}

function copyScene(scene: SceneDocument): SceneDocument {
  // A scene is a JSON-compatible document. Never retain a mutable store object as history.
  return structuredClone(scene);
}

/** Ignore metadata-only updates; an unchanged edit must not consume an Undo step. */
function hasDocumentChange(before: SceneDocument, after: SceneDocument): boolean {
  return JSON.stringify({ ...before, updatedAt: "" }) !==
    JSON.stringify({ ...after, updatedAt: "" });
}

function actionLabel(before: SceneDocument, after: SceneDocument): string {
  if (before.id !== after.id) return "Change Scene ID";
  if (before.name !== after.name) return "Rename Scene";
  if (before.objects.length < after.objects.length) return "Add Object";
  if (before.objects.length > after.objects.length) return "Delete Object";
  if (before.assets.length < after.assets.length) return "Import Asset";
  if (before.timeline.keyframes.length < after.timeline.keyframes.length) return "Add Keyframe";
  if (before.timeline.keyframes.length > after.timeline.keyframes.length) return "Delete Keyframe";
  if (before.objects !== after.objects) return "Edit Object";
  if (before.timeline !== after.timeline) return "Edit Timeline";
  if (before.materials !== after.materials) return "Edit Material";
  if (before.dataContext !== after.dataContext) return "Update Data";
  return "Edit Scene";
}

/**
 * Linear document history, with explicit gesture transactions.
 * New edits after Undo invalidate Redo; a drag, scrub or typing session can be one step.
 * Use a bounded number of snapshots to avoid unlimited growth.
 */
export class SceneHistory {
  private states: SceneHistoryPoint[] = [];
  private cursor = 0;
  private nextId = 1;
  private transaction: Transaction | null = null;

  constructor(scene: SceneDocument, selectedObjectId: string | null, private readonly maxUndoSteps = 80) {
    this.reset(scene, selectedObjectId);
  }

  reset(scene: SceneDocument, selectedObjectId: string | null): void {
    this.transaction = null;
    this.states = [this.snapshot(scene, selectedObjectId, "Original")];
    this.cursor = 0;
  }

  private snapshot(scene: SceneDocument, selectedObjectId: string | null, label: string): SceneHistoryPoint {
    return { id: this.nextId++, scene: copyScene(scene), selectedObjectId, label, timestamp: Date.now() };
  }

  hasTransaction(): boolean {
    return this.transaction !== null;
  }

  begin(scene: SceneDocument, selectedObjectId: string | null, label: string): void {
    if (this.transaction) return;
    this.transaction = { scene: copyScene(scene), selectedObjectId, label };
  }

  end(scene: SceneDocument, selectedObjectId: string | null): boolean {
    const tx = this.transaction;
    if (!tx) return false;
    this.transaction = null;
    return this.record(tx.scene, scene, tx.selectedObjectId, selectedObjectId, tx.label);
  }

  record(
    before: SceneDocument,
    after: SceneDocument,
    beforeSelection: string | null,
    afterSelection: string | null,
    label = actionLabel(before, after)
  ): boolean {
    if (this.transaction || !hasDocumentChange(before, after)) return false;

    // The selection could have changed since the previous edit.
    this.states[this.cursor].selectedObjectId = beforeSelection;
    this.states = this.states.slice(0, this.cursor + 1);
    this.states.push(this.snapshot(after, afterSelection, label));
    if (this.states.length > this.maxUndoSteps + 1) {
      this.states.splice(0, this.states.length - (this.maxUndoSteps + 1));
    }
    this.cursor = this.states.length - 1;
    return true;
  }

  undo(): SceneHistoryPoint | null {
    if (this.cursor === 0) return null;
    this.cursor -= 1;
    return this.states[this.cursor];
  }

  redo(): SceneHistoryPoint | null {
    if (this.cursor >= this.states.length - 1) return null;
    this.cursor += 1;
    return this.states[this.cursor];
  }

  /** Jump to a retained point by ID; this does not create another history entry. */
  goTo(id: number): SceneHistoryPoint | null {
    const next = this.states.findIndex((state) => state.id === id);
    if (next < 0) return null;
    this.cursor = next;
    return this.states[next];
  }

  info(): SceneHistoryInfo {
    return {
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.states.length - 1,
      undoLabel: this.cursor > 0 ? this.states[this.cursor].label : null,
      redoLabel: this.cursor < this.states.length - 1 ? this.states[this.cursor + 1].label : null,
      currentIndex: this.cursor,
      totalStates: this.states.length,
      entries: this.states.map((point, index) => ({
        id: point.id, label: point.label, timestamp: point.timestamp, current: index === this.cursor
      }))
    };
  }
}
