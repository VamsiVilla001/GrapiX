import { useEffect, useRef } from "react";
import { saveSceneToApi } from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";

/**
 * Saves the latest scene after edits settle.
 * Writes are serialized so an earlier save can't finish after a newer Undo/Redo
 * and overwrite the restored state on disk.
 */
export function useSceneAutosave() {
  const scene = useEditorStore((state) => state.scene);
  const setSaveStatus = useEditorStore((state) => state.setSaveStatus);
  const firstRun = useRef(true);
  const sequence = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }

    const version = ++sequence.current;
    setSaveStatus("saving");
    const timeoutId = window.setTimeout(() => {
      // Queue the latest snapshot after any prior save, ignoring superseded requests.
      queue.current = queue.current.catch(() => undefined).then(async () => {
        if (version !== sequence.current) return;
        try {
          await saveSceneToApi(scene);
          if (version === sequence.current) setSaveStatus("saved");
        } catch (error) {
          if (version === sequence.current) {
            setSaveStatus("error", error instanceof Error ? error.message : "Autosave failed");
          }
        }
      });
    }, 550);

    return () => window.clearTimeout(timeoutId);
  }, [scene, setSaveStatus]);
}
