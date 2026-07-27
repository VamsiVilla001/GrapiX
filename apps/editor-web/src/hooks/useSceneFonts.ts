import { buildFontCss } from "@grapix/shared-types";
import { useEffect } from "react";
import { useEditorStore } from "../store/editorStore";

export function useSceneFonts(): void {
  const assets = useEditorStore((state) => state.scene.assets);
  const fonts = useEditorStore((state) => state.scene.fonts ?? []);

  useEffect(() => {
    const styleId = "grapix-scene-fonts";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.append(style);
    }
    style.textContent = buildFontCss(fonts, (assetId) =>
      assets.find((asset) => asset.assetId === assetId)?.source
      ?? `http://127.0.0.1:4100/api/assets/${encodeURIComponent(assetId)}/content`
    );
  }, [assets, fonts]);
}
