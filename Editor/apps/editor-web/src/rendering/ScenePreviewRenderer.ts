import type { SceneDocument } from "@grapix/shared-types";
import type { RenderableSceneObject } from "./sceneMaterial";

export interface PreviewRendererCapabilities {
  backend: "webgl" | "webgpu" | "unknown";
  maxTextureSize: number;
  rendererName: string;
}

/**
 * Editor-only rendering seam. Implementations draw an authoring preview into
 * a DOM host; they are never the authoritative Program output.
 */
export interface ScenePreviewRenderer {
  mount(host: HTMLElement, scene: SceneDocument): Promise<void>;
  renderScene(scene: SceneDocument, objects: RenderableSceneObject[]): Promise<void>;
  resize(scene: SceneDocument): void;
  getCapabilities(): PreviewRendererCapabilities;
  destroy(): void;

  /**
   * Read the current frame back as an image source, for a library thumbnail.
   *
   * Optional: a renderer that cannot read pixels back returns null rather than
   * failing, and the caller publishes without a thumbnail.
   */
  captureFrame?(): Promise<CanvasImageSource & { width: number; height: number } | null>;

  /** Optional implementation handle exposed only for local diagnostics. */
  readonly debugHandle?: unknown;
}
