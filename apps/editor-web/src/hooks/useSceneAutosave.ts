import { useEffect, useRef } from "react";
import { saveSceneToApi } from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";

export function useSceneAutosave() {
  const scene = useEditorStore((state) => state.scene);
  const setSaveStatus = useEditorStore((state) => state.setSaveStatus);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }

    setSaveStatus("saving");
    const timeoutId = window.setTimeout(() => {
      saveSceneToApi(scene)
        .then(() => setSaveStatus("saved"))
        .catch((error: unknown) => {
          setSaveStatus("error", error instanceof Error ? error.message : "Autosave failed");
        });
    }, 550);

    return () => window.clearTimeout(timeoutId);
  }, [scene, setSaveStatus]);
}
