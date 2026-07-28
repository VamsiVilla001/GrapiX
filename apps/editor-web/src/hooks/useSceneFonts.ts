import { useEffect } from "react";
import { projectFontRegistry } from "../fonts/ProjectFontRegistry";
import { useEditorStore } from "../store/editorStore";

export function useSceneFonts(): void {
  const assets = useEditorStore((state) => state.scene.assets);
  const fonts = useEditorStore((state) => state.scene.fonts ?? []);

  useEffect(() => {
    void projectFontRegistry.sync(fonts, assets);
  }, [assets, fonts]);
}
