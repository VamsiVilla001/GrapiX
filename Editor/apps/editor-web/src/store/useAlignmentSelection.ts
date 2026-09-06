import { objectBoundsInScene } from "@grapix/shared-types";
import { useMemo } from "react";
import { useEditorStore } from "./editorStore";
import type { AlignTarget } from "../tools/alignment";

/**
 * The selection the alignment tools act on, as geometry.
 *
 * This used to reconcile two selections — `uiStore.selectedPathObjectIds` and
 * `editorStore.selectedObjectId` — by unioning them. It did not reconcile so much as accumulate:
 * nothing ever cleared the marquee's set, so a marquee of five objects stayed live here after the
 * author clicked a single object. There is now one selection, and this only resolves its bounds.
 *
 * Hidden objects are dropped and locked ones are kept-but-flagged, matching the store: a locked
 * graphic is the thing you align *to*.
 */
export interface AlignmentSelection {
  objectIds: string[];
  keyObjectId: string | null;
  targets: AlignTarget[];
}

export function useAlignmentSelection(): AlignmentSelection {
  const objects = useEditorStore((state) => state.scene.objects);
  const selectedIds = useEditorStore((state) => state.selectedObjectIds);
  const activeId = useEditorStore((state) => state.selectedObjectId);

  return useMemo(() => {
    const ids = new Set(selectedIds);
    const byId = new Map(objects.map((object) => [object.id, object]));
    const targets = objects
      .filter((object) => ids.has(object.id) && object.visible)
      .map((object) => ({
        id: object.id,
        bounds: objectBoundsInScene(object, byId),
        locked: object.locked
      }));

    return {
      objectIds: targets.map((target) => target.id),
      // Only meaningful as a key when there is something else to bring to it.
      keyObjectId: activeId && targets.length > 1 ? activeId : null,
      targets
    };
  }, [objects, activeId, selectedIds]);
}
