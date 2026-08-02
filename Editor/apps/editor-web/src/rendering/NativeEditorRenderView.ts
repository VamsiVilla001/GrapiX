import type { EditorViewFrameMetadata } from "@grapix/render-protocol";

/** A decoded native Engine frame. Pixels stay premultiplied BGRA until this adapter paints them. */
export interface NativeEditorFrame {
  metadata: EditorViewFrameMetadata;
  pixels: Uint8Array;
}

/**
 * Decode the Engine's binary authoring-frame envelope:
 * `[u32 big-endian metadata bytes][UTF-8 metadata][raw BGRA8 premultiplied]`.
 *
 * The caller must compare `viewGeneration` and `frameId`; arrival order is not a
 * valid freshness signal across a reconnect or viewport resize.
 */
export function decodeNativeEditorFrame(packet: Uint8Array): NativeEditorFrame {
  if (packet.byteLength < 4) throw new Error("native editor frame is missing its metadata length");
  const headerBytes = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, false);
  const pixelOffset = 4 + headerBytes;
  if (pixelOffset > packet.byteLength) throw new Error("native editor frame metadata exceeds packet length");

  const metadata = JSON.parse(new TextDecoder().decode(packet.subarray(4, pixelOffset))) as EditorViewFrameMetadata;
  if (
    !metadata.frameId ||
    metadata.pixelFormat !== "bgra8-premultiplied" ||
    metadata.alphaMode !== "premultiplied" ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1
  ) {
    throw new Error("native editor frame metadata is invalid");
  }
  const pixels = packet.subarray(pixelOffset);
  const expectedBytes = metadata.width * metadata.height * 4;
  if (pixels.byteLength !== expectedBytes) {
    throw new Error(`native editor frame has ${pixels.byteLength} bytes; expected ${expectedBytes}`);
  }
  return { metadata, pixels };
}

/**
 * Browser-only projection of native Engine frames. This owns no scene renderer:
 * canvas is a presentation surface while all scene preparation and pixels remain
 * engine-owned. Bounds and picking metadata are retained for Editor overlays.
 */
export class NativeEditorRenderView {
  readonly canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D | null = this.canvas.getContext("2d", { alpha: true });
  private generation = -1;
  private latestFrameId: string | null = null;
  private currentMetadata: EditorViewFrameMetadata | null = null;

  mount(host: HTMLElement): void {
    this.canvas.className = "native-editor-render-view";
    host.replaceChildren(this.canvas);
  }

  metadata(): EditorViewFrameMetadata | null {
    return this.currentMetadata;
  }

  /** Reject stale frame generations rather than letting an old socket paint a new view. */
  present(frame: NativeEditorFrame): boolean {
    if (frame.metadata.viewGeneration < this.generation) return false;
    if (frame.metadata.viewGeneration === this.generation && frame.metadata.frameId === this.latestFrameId) {
      return false;
    }
    if (!this.context) throw new Error("native editor render canvas is unavailable");

    this.canvas.width = frame.metadata.width;
    this.canvas.height = frame.metadata.height;
    // Canvas ImageData is RGBA while Engine frames are BGRA. Swizzle into a tightly
    // scoped presentation buffer; scene/picking data never enters the browser renderer.
    const image = this.context.createImageData(frame.metadata.width, frame.metadata.height);
    for (let source = 0; source < frame.pixels.length; source += 4) {
      image.data[source] = frame.pixels[source + 2];
      image.data[source + 1] = frame.pixels[source + 1];
      image.data[source + 2] = frame.pixels[source];
      image.data[source + 3] = frame.pixels[source + 3];
    }
    this.context.putImageData(image, 0, 0);
    this.generation = frame.metadata.viewGeneration;
    this.latestFrameId = frame.metadata.frameId;
    this.currentMetadata = frame.metadata;
    return true;
  }

  destroy(): void {
    this.currentMetadata = null;
    this.latestFrameId = null;
    this.context = null;
    this.canvas.remove();
  }
}
