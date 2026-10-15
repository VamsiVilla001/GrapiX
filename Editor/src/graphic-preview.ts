// Scene Manager thumbnails reuse the existing authoring viewport. One shared
// WebGL context serves every tile; production render parity remains Phase 13.
import * as THREE from "three";
import type { AnimationSurface, SceneDocument } from "@grapix/contracts";
import { resolveSceneBindings } from "./bindings";
import { previewSceneAt } from "./preview-playback";
import { SceneViewport } from "./viewport";

export interface GraphicPreview {
  readonly src: string;
  readonly note: string;
}

export function graphicPreviewFrame(scene: Pick<SceneDocument, "timeline">): number {
  const hold = scene.timeline.phases.find((phase) => phase.kind === "hold");
  const build = scene.timeline.phases.find((phase) => phase.kind === "in");
  const frame = Number(hold?.startFrame ?? build?.endFrame ?? Math.floor(Number(scene.timeline.durationFrames) / 2));
  return Math.max(0, Math.min(Number(scene.timeline.durationFrames), frame));
}

export class GraphicPreviewRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(1);
  }

  capture(scene: SceneDocument, surface: AnimationSurface | null): GraphicPreview {
    if (this.renderer.getContext().isContextLost()) throw new Error("WebGL context lost");
    const bindings = resolveSceneBindings(scene);
    if (!bindings.ok) throw new Error("Preview unavailable: unresolved graphic bindings");
    const frame = graphicPreviewFrame(scene);
    const evaluated = previewSceneAt(bindings.document, frame, surface);
    if (evaluated.issues.length) throw new Error(evaluated.issues.join("; "));
    const width = 320;
    const height = Math.max(1, Math.round(width * scene.canvas.height / scene.canvas.width));
    this.renderer.setSize(width, height, false);
    const viewport = new SceneViewport(this.canvas, evaluated.document, this.renderer);
    try {
      viewport.render();
      if (this.renderer.getContext().isContextLost()) throw new Error("WebGL context lost");
      const partial = viewport.unsupported.length > 0;
      const missing = scene.objects.filter((object) => viewport.unsupported.some((reason) => reason.startsWith(`${object.id}:`)))
        .map((object) => `${object.name} (${object.type})`);
      return {
        // Capture in the render task: the default WebGL buffer is transient.
        src: this.canvas.toDataURL("image/png"),
        note: `${partial ? "Partial authoring preview" : "Authoring preview"} · frame ${frame}${partial ? ` · Not shown: ${missing.join(", ") || "some graphic content"}` : ""}`,
      };
    } finally { viewport.dispose(); }
  }
}
