import type { SceneDocument } from "@grapix/shared-types";
import { GpuSceneRenderer } from "./GpuSceneRenderer";
import type {
  PreviewRendererCapabilities,
  ScenePreviewRenderer
} from "./ScenePreviewRenderer";
import type { RenderableSceneObject } from "./sceneMaterial";

/**
 * Keeps PixiJS contained behind the editor-preview boundary. Feature
 * components construct the interface through the factory below and can later
 * switch to a worker/WebGPU/3D preview without changing their React code.
 */
class PixiPreviewRendererAdapter implements ScenePreviewRenderer {
  readonly debugHandle: GpuSceneRenderer;

  constructor() {
    this.debugHandle = new GpuSceneRenderer();
  }

  mount(host: HTMLElement, scene: SceneDocument): Promise<void> {
    return this.debugHandle.mount(host, scene);
  }

  renderScene(scene: SceneDocument, objects: RenderableSceneObject[]): Promise<void> {
    return this.debugHandle.renderScene(scene, objects);
  }

  resize(scene: SceneDocument): void {
    this.debugHandle.resize(scene);
  }

  getCapabilities(): PreviewRendererCapabilities {
    return this.debugHandle.getCapabilities();
  }

  captureFrame(): Promise<(CanvasImageSource & { width: number; height: number }) | null> {
    return this.debugHandle.captureFrame();
  }

  destroy(): void {
    this.debugHandle.destroy();
  }
}

export function createEditorPreviewRenderer(): ScenePreviewRenderer {
  return new PixiPreviewRendererAdapter();
}
