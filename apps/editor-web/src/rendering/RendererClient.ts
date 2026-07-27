import type {
  RendererAck,
  RendererCapabilities,
  RendererChannel,
  RendererQualityProfile,
  RendererStatusReply
} from "@grapix/renderer-protocol";
import type {
  RendererPatch,
  SceneDocument
} from "@grapix/shared-types";

export interface TakeOptions {
  transition?: "cut" | "mix";
  durationFrames?: number;
}

/**
 * Control boundary for the authoritative renderer process.
 *
 * The editor preview uses ScenePreviewRenderer instead. Keeping these
 * interfaces separate prevents a preview implementation from accidentally
 * becoming Program output.
 */
export interface RendererClient {
  connect(): Promise<void>;
  disconnect(): void;
  getCapabilities(): Promise<RendererCapabilities>;
  getStatus(): Promise<RendererStatusReply>;
  setQualityProfile(profile: RendererQualityProfile): Promise<RendererAck>;
  loadScene(scene: SceneDocument): Promise<RendererAck>;
  warmScene(scene: SceneDocument): Promise<RendererAck>;
  patchScene(patch: RendererPatch, sceneRevision: string): Promise<RendererAck>;
  setPreview(sceneId: string, sceneRevision: string): Promise<RendererAck>;
  take(sceneId: string, sceneRevision: string, options?: TakeOptions): Promise<RendererAck>;
  play(sceneId: string, channel: RendererChannel): Promise<RendererAck>;
  stop(sceneId: string, channel: RendererChannel): Promise<RendererAck>;
  releaseScene(sceneId: string): Promise<RendererAck>;
}
