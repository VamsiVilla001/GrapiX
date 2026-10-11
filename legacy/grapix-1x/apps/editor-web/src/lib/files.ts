import type { SceneDocument } from "@grapix/shared-types";

export function downloadScene(scene: SceneDocument): void {
  const blob = new Blob([JSON.stringify(scene, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${scene.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.scene.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readSceneFile(file: File): Promise<SceneDocument> {
  const text = await file.text();
  return JSON.parse(text) as SceneDocument;
}
