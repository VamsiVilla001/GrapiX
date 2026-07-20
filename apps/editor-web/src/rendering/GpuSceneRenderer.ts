import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  TilingSprite,
  type TextureSourceLike,
  type WRAP_MODE
} from "pixi.js";
import {
  IMPLEMENTED_BLEND_MODES,
  type MaterialBlendMode,
  type MaterialTextureSlot,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";
import { isVideoSource, type RenderableSceneObject } from "./sceneMaterial";

/** GrapiX texture wrap mode -> Pixi WebGPU/WebGL address mode. */
function pixiWrapMode(wrap: MaterialTextureSlot["wrap"] | undefined): WRAP_MODE {
  switch (wrap) {
    case "repeat":
      return "repeat";
    case "mirror-repeat":
      return "mirror-repeat";
    default:
      return "clamp-to-edge";
  }
}

interface UvTransform {
  scale: [number, number];
  offset: [number, number];
  rotationDegrees: number;
}

/** Read the UV transform the renderer honours from resolved material parameters. */
function readUvTransform(parameters: Record<string, unknown> | undefined): UvTransform {
  const scale = parameters?.uvScale;
  const offset = parameters?.uvOffset;
  const rotation = parameters?.uvRotation;
  const pair = (value: unknown, fallback: [number, number]): [number, number] =>
    Array.isArray(value) && value.length >= 2 ? [Number(value[0]) || 0, Number(value[1]) || 0] : fallback;

  return {
    scale: pair(scale, [1, 1]),
    offset: pair(offset, [0, 0]),
    rotationDegrees: typeof rotation === "number" ? rotation : 0
  };
}

/** A UV transform needs the tiling path only when it differs from identity. */
function uvTransformActive(uv: UvTransform): boolean {
  return (
    uv.scale[0] !== 1 ||
    uv.scale[1] !== 1 ||
    uv.offset[0] !== 0 ||
    uv.offset[1] !== 0 ||
    uv.rotationDegrees !== 0
  );
}

/**
 * Apply the material's sampler settings (filtering + wrap) to the texture
 * source. Note: the source is shared/cached by URL, so these settings are
 * per-asset in the editor, not strictly per-material — the shader contract
 * lists true per-material samplers (a WebGPU bind group) as future work.
 */
function applyTextureSampler(texture: Texture, slot: MaterialTextureSlot | undefined): void {
  if (!slot || !texture.source) {
    return;
  }

  texture.source.scaleMode = slot.filtering === "nearest" ? "nearest" : "linear";
  texture.source.addressMode = pixiWrapMode(slot.wrap);
}

/**
 * Material blend mode -> PixiJS blend mode. Adobe's darken/lighten are
 * per-channel min/max, which Pixi exposes as the fixed-function "min"/"max"
 * modes. The daemon mirrors Pixi's exact blend equations per
 * packages/render-shaders/layouts.json, so this mapping is the preview half
 * of that contract. Unimplemented modes never reach this function — the
 * render guard skips those objects with a warning.
 */
function pixiBlendMode(blendMode: MaterialBlendMode | undefined): "normal" | "add" | "multiply" | "screen" | "min" | "max" {
  switch (blendMode) {
    case "add":
      return "add";
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "darken":
      return "min";
    case "lighten":
      return "max";
    default:
      return "normal";
  }
}

export interface GpuRendererCapabilities {
  backend: "webgl" | "webgpu" | "unknown";
  maxTextureSize: number;
  rendererName: string;
}

export class GpuSceneRenderer {
  readonly app = new Application();

  private readonly root = new Container();
  private readonly textureCache = new Map<string, Promise<Texture>>();
  private readonly videoElements = new Map<string, HTMLVideoElement>();
  private renderVersion = 0;
  private initialized = false;

  async mount(host: HTMLElement, scene: SceneDocument): Promise<void> {
    await this.app.init({
      width: scene.canvas.width,
      height: scene.canvas.height,
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      preference: "webgl",
      powerPreference: "high-performance",
      resolution: window.devicePixelRatio || 1
    });

    this.app.stage.addChild(this.root);
    this.app.canvas.className = "gpu-render-canvas";
    host.replaceChildren(this.app.canvas);
    this.fitCanvasToHost();
    this.initialized = true;
  }

  resize(scene: SceneDocument): void {
    if (!this.initialized) {
      return;
    }

    this.app.renderer.resize(scene.canvas.width, scene.canvas.height);
    this.fitCanvasToHost();
  }

  /**
   * Pixi's autoDensity writes inline style.width/height equal to the logical
   * canvas size (e.g. 1920px) on every resize. Inline styles beat the
   * .gpu-render-canvas { width: 100% } stylesheet rule, so the canvas
   * overflowed its fitted stage container and only the scene's empty
   * top-left corner was visible on screen. Re-assert the fitted size after
   * every mount/resize; the backing store keeps the full scene resolution.
   */
  private fitCanvasToHost(): void {
    this.app.canvas.style.width = "100%";
    this.app.canvas.style.height = "100%";
  }

  async renderScene(scene: SceneDocument, objects: RenderableSceneObject[]): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const version = ++this.renderVersion;
    const nextRoot = new Container();

    nextRoot.addChild(drawBackground(scene));

    for (const object of objects) {
      if (object.resolvedMaterial && (
        object.resolvedMaterial.material.enabled === false
        || !IMPLEMENTED_BLEND_MODES.includes(object.resolvedMaterial.blendMode)
        || !["opaque", "straight", "premultiplied"].includes(object.resolvedMaterial.alphaMode)
        // wrap (clamp/repeat/mirror) and filtering (linear/nearest) are now
        // applied via the texture sampler + TilingSprite path; only tile and
        // nine-slice fit modes remain unimplemented and are skipped.
        || object.resolvedMaterial.textureSlots.some((slot) => ["tile", "nine-slice"].includes(slot.fit))
      )) {
        continue;
      }
      const displayObject = await this.createDisplayObject(object);

      if (version !== this.renderVersion) {
        destroyContainer(nextRoot);
        return;
      }

      displayObject.x = object.x;
      displayObject.y = object.y;
      displayObject.rotation = degreesToRadians(object.rotation);
      displayObject.alpha = object.opacity;
      displayObject.visible = object.visible;
      displayObject.blendMode = pixiBlendMode(object.resolvedMaterial?.blendMode);

      nextRoot.addChild(displayObject);
    }

    destroyContainer(this.root);
    this.root.removeChildren();
    // Reparent in draw order. Do NOT spread removeChildren() here: Pixi v8
    // returns removed children in REVERSE order, which re-added the
    // full-canvas background quad last — painting it over every scene
    // object and blanking the viewport.
    this.root.addChild(...nextRoot.children.slice());
  }

  getCapabilities(): GpuRendererCapabilities {
    if (!this.initialized) {
      return {
        backend: "unknown",
        maxTextureSize: 0,
        rendererName: "Initializing"
      };
    }

    const canvas = this.app.canvas as HTMLCanvasElement;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");

    return {
      backend: gl ? "webgl" : "unknown",
      maxTextureSize: gl?.getParameter(gl.MAX_TEXTURE_SIZE) as number || 0,
      rendererName: gl?.getParameter(gl.RENDERER) as string || "GPU renderer"
    };
  }

  destroy(): void {
    this.renderVersion += 1;

    for (const video of this.videoElements.values()) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }

    this.videoElements.clear();
    this.textureCache.clear();

    if (this.initialized) {
      // Never pass `true` here: renderer.destroy(true) releases Pixi's
      // GLOBAL resource registry, clearing the shared TexturePool while
      // other GpuSceneRenderer instances (main viewport + material
      // previews) still hold checked-out textures. Their next Text destroy
      // would then crash in TexturePool.returnTexture with
      // "Cannot read properties of undefined (reading 'push')".
      this.app.destroy({ removeView: true }, { children: true });
      this.initialized = false;
    }
  }

  private async createDisplayObject(object: RenderableSceneObject): Promise<Container | Graphics | Text> {
    switch (object.type) {
      case "rect":
        return object.materialAssetSource ? this.drawTexturedQuad(object) : drawRect(object);
      case "ellipse":
        return drawEllipse(object);
      case "text":
        return drawText(object);
      case "image":
        return this.drawImageObject(object);
      case "line":
        return drawLine(object);
      case "mesh":
        return drawMesh(object);
      case "light":
        return drawLight(object);
      case "camera":
        return drawCamera(object);
      case "layer":
        return drawLayer(object);
      case "marker":
        return drawMarker(object);
      case "group":
        return drawGroup(object);
    }
  }

  private async drawImageObject(object: Extract<RenderableSceneObject, { type: "image" }>): Promise<Container> {
    const container = new Container();
    const texture = await this.getTexture(object.src);
    const inner = this.buildTexturedInner(texture, object, object.objectFit);

    const mask = new Graphics().rect(0, 0, object.width, object.height).fill("#ffffff");
    container.addChild(inner, mask);
    container.mask = mask;

    if (object.strokeWidth > 0 && object.stroke !== "transparent") {
      container.addChild(new Graphics().rect(0, 0, object.width, object.height).stroke({
        color: object.stroke,
        width: object.strokeWidth
      }));
    }

    return container;
  }

  private async drawTexturedQuad(object: Extract<RenderableSceneObject, { type: "rect" }>): Promise<Container> {
    const container = new Container();
    const texture = await this.getTexture(object.materialAssetSource!);
    const inner = this.buildTexturedInner(texture, object, "fill");
    const mask = new Graphics().roundRect(0, 0, object.width, object.height, object.radius).fill("#ffffff");
    container.addChild(inner, mask);
    container.mask = mask;
    if (object.strokeWidth > 0 && object.stroke !== "transparent") {
      container.addChild(new Graphics().roundRect(0, 0, object.width, object.height, object.radius).stroke({
        color: object.stroke,
        width: object.strokeWidth
      }));
    }
    return container;
  }

  /**
   * Build the texture display object for a textured rect/image. When the
   * material has a non-identity UV transform (offset / scale / rotation) the
   * texture is drawn through a Pixi TilingSprite — the primitive designed for
   * UV transforms and repeat/mirror wrap, matching the XPression "Texture
   * Coordinates" panel. The default (identity) case keeps the plain Sprite
   * path with its fit-mode sizing, so existing image rendering is unchanged.
   */
  private buildTexturedInner(
    texture: Texture,
    object: RenderableSceneObject,
    fallbackFit: string
  ): Sprite | TilingSprite {
    const slot = object.resolvedMaterial?.textureSlots[0];
    const parameters = object.resolvedMaterial?.parameters;
    const tint = parameters?.tint;
    applyTextureSampler(texture, slot);

    const uv = readUvTransform(parameters);

    if (uvTransformActive(uv)) {
      const tiling = new TilingSprite({ texture, width: object.width, height: object.height });
      const textureWidth = Math.max(1, texture.width || object.width);
      const textureHeight = Math.max(1, texture.height || object.height);
      // Base tileScale makes one copy fill the quad; dividing by UV scale
      // turns UV scale > 1 into that many repeats across the quad.
      tiling.tileScale.set(
        object.width / textureWidth / Math.max(0.0001, Math.abs(uv.scale[0]) || 1),
        object.height / textureHeight / Math.max(0.0001, Math.abs(uv.scale[1]) || 1)
      );
      // UV offset is normalized (0..1) of the quad; convert to tile pixels.
      tiling.tilePosition.set(uv.offset[0] * object.width, uv.offset[1] * object.height);
      tiling.tileRotation = degreesToRadians(uv.rotationDegrees);
      if (typeof tint === "string") {
        tiling.tint = tint;
      }
      return tiling;
    }

    const sprite = new Sprite(texture);
    sizeTextureSprite(
      sprite,
      Math.max(1, texture.width || object.width),
      Math.max(1, texture.height || object.height),
      object.width,
      object.height,
      slot?.fit ?? fallbackFit
    );
    if (typeof tint === "string") {
      sprite.tint = tint;
    }
    return sprite;
  }

  private async getTexture(source: string): Promise<Texture> {
    if (this.textureCache.has(source)) {
      return this.textureCache.get(source)!;
    }

    const texturePromise = isVideoSource(source)
      ? Promise.resolve(this.createVideoTexture(source))
      : Assets.load<Texture>(source).catch(() => Texture.EMPTY);

    this.textureCache.set(source, texturePromise);

    return texturePromise;
  }

  private createVideoTexture(source: string): Texture {
    const existingVideo = this.videoElements.get(source);

    if (existingVideo) {
      return Texture.from(existingVideo as TextureSourceLike);
    }

    const video = document.createElement("video");

    video.src = source;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    this.videoElements.set(source, video);
    void video.play().catch(() => undefined);

    return Texture.from(video as TextureSourceLike);
  }
}

function drawBackground(scene: SceneDocument): Graphics {
  const background = new Graphics();

  background.rect(0, 0, scene.canvas.width, scene.canvas.height).fill(scene.canvas.background);

  return background;
}

function drawRect(object: Extract<SceneObject, { type: "rect" }>): Graphics {
  const graphics = new Graphics();

  graphics.roundRect(0, 0, object.width, object.height, object.radius).fill(object.fill);

  if (object.strokeWidth > 0 && object.stroke !== "transparent") {
    graphics.stroke({ color: object.stroke, width: object.strokeWidth });
  }

  return graphics;
}

function drawEllipse(object: Extract<SceneObject, { type: "ellipse" }>): Graphics {
  const graphics = new Graphics();

  graphics.ellipse(object.width / 2, object.height / 2, object.width / 2, object.height / 2).fill(object.fill);

  if (object.strokeWidth > 0 && object.stroke !== "transparent") {
    graphics.stroke({ color: object.stroke, width: object.strokeWidth });
  }

  return graphics;
}

function drawLine(object: Extract<SceneObject, { type: "line" }>): Graphics {
  const graphics = new Graphics();

  if (object.points.length > 0) {
    graphics.moveTo(object.points[0].x, object.points[0].y);

    for (const point of object.points.slice(1)) {
      graphics.lineTo(point.x, point.y);
    }

    graphics.stroke({
      color: object.stroke,
      width: Math.max(1, object.strokeWidth)
    });
  }

  return graphics;
}

function drawMesh(object: Extract<SceneObject, { type: "mesh" }>): Container {
  switch (object.meshKind) {
    case "cube":
      return drawCubeLike(object);
    case "cylinder":
      return drawCylinder(object);
    case "torus":
      return drawTorus(object);
    case "slab":
      return drawSlab(object);
    case "model":
      return drawModelPlaceholder(object);
  }
}

function drawCubeLike(object: Extract<SceneObject, { type: "mesh" }>): Container {
  const container = new Container();
  const offset = Math.min(object.depth * 0.28, object.width * 0.22, object.height * 0.22);
  const side = new Graphics()
    .poly([
      object.width,
      0,
      object.width + offset,
      offset,
      object.width + offset,
      object.height + offset,
      object.width,
      object.height
    ])
    .fill(adjustHex(object.fill, -24));
  const top = new Graphics()
    .poly([0, 0, offset, offset, object.width + offset, offset, object.width, 0])
    .fill(adjustHex(object.fill, 28));
  const front = new Graphics().rect(0, 0, object.width, object.height).fill(object.fill);

  container.addChild(side, top, front);

  if (object.strokeWidth > 0) {
    container.addChild(new Graphics().rect(0, 0, object.width, object.height).stroke({ color: object.stroke, width: object.strokeWidth }));
  }

  return container;
}

function drawCylinder(object: Extract<SceneObject, { type: "mesh" }>): Container {
  const container = new Container();
  const body = new Graphics().rect(0, object.height * 0.18, object.width, object.height * 0.64).fill(object.fill);
  const top = new Graphics().ellipse(object.width / 2, object.height * 0.18, object.width / 2, object.height * 0.18).fill(adjustHex(object.fill, 28));
  const bottom = new Graphics().ellipse(object.width / 2, object.height * 0.82, object.width / 2, object.height * 0.18).fill(adjustHex(object.fill, -22));

  container.addChild(body, bottom, top);

  return container;
}

function drawTorus(object: Extract<SceneObject, { type: "mesh" }>): Graphics {
  const graphics = new Graphics();
  const radiusX = object.width / 2;
  const radiusY = object.height / 2;

  graphics.ellipse(radiusX, radiusY, radiusX, radiusY).fill(object.fill);
  graphics.ellipse(radiusX, radiusY, radiusX * 0.48, radiusY * 0.48).cut();

  if (object.strokeWidth > 0) {
    graphics.ellipse(radiusX, radiusY, radiusX, radiusY).stroke({ color: object.stroke, width: object.strokeWidth });
  }

  return graphics;
}

function drawSlab(object: Extract<SceneObject, { type: "mesh" }>): Container {
  return drawCubeLike({ ...object, height: Math.max(32, object.height), depth: Math.max(16, object.depth) });
}

function drawModelPlaceholder(object: Extract<SceneObject, { type: "mesh" }>): Container {
  const container = new Container();
  const shell = new Graphics()
    .poly([
      object.width * 0.5,
      0,
      object.width,
      object.height * 0.34,
      object.width * 0.82,
      object.height,
      object.width * 0.18,
      object.height,
      0,
      object.height * 0.34
    ])
    .fill(object.fill)
    .stroke({ color: object.stroke, width: Math.max(1, object.strokeWidth) });
  const inner = new Graphics()
    .poly([
      object.width * 0.5,
      object.height * 0.22,
      object.width * 0.72,
      object.height * 0.42,
      object.width * 0.64,
      object.height * 0.72,
      object.width * 0.36,
      object.height * 0.72,
      object.width * 0.28,
      object.height * 0.42
    ])
    .fill(adjustHex(object.fill, -32));

  container.addChild(shell, inner);

  return container;
}

function drawLight(object: Extract<SceneObject, { type: "light" }>): Container {
  const container = new Container();
  const rays = new Graphics();
  const centerX = object.width / 2;
  const centerY = object.height / 2;

  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI * 2 * index) / 8;
    rays.moveTo(centerX + Math.cos(angle) * 30, centerY + Math.sin(angle) * 30);
    rays.lineTo(centerX + Math.cos(angle) * 56, centerY + Math.sin(angle) * 56);
  }

  rays.stroke({ color: object.color, width: 4 });

  const bulb = new Graphics().circle(centerX, centerY, Math.min(object.width, object.height) * 0.25).fill(object.color);

  if (object.lightKind === "spot") {
    container.addChild(new Graphics().poly([centerX, centerY, object.width, object.height, 0, object.height]).fill({ color: object.color, alpha: 0.2 }));
  }

  if (object.lightKind === "directional") {
    container.addChild(new Graphics().moveTo(0, object.height).lineTo(object.width, 0).stroke({ color: object.color, width: 8 }));
  }

  container.addChild(rays, bulb);

  return container;
}

function drawCamera(object: Extract<SceneObject, { type: "camera" }>): Container {
  const container = new Container();
  const body = new Graphics().roundRect(0, object.height * 0.2, object.width * 0.68, object.height * 0.58, 8).fill(object.fill);
  const lens = new Graphics().circle(object.width * 0.38, object.height * 0.49, object.height * 0.18).fill("#121820").stroke({ color: object.stroke, width: 3 });
  const cone = new Graphics()
    .poly([object.width * 0.68, object.height * 0.36, object.width, object.height * 0.16, object.width, object.height * 0.84, object.width * 0.68, object.height * 0.62])
    .fill(adjustHex(object.fill, -18));

  container.addChild(body, cone, lens);

  if (object.cameraKind === "orthographic") {
    container.addChild(new Graphics().rect(8, 8, object.width - 16, object.height - 16).stroke({ color: object.stroke, width: 2 }));
  }

  return container;
}

function drawLayer(object: Extract<SceneObject, { type: "layer" }>): Graphics {
  const graphics = new Graphics();

  graphics.rect(0, 0, object.width, object.height).fill({ color: object.fill, alpha: 0.16 });
  graphics.rect(0, 0, object.width, object.height).stroke({ color: object.stroke, width: Math.max(1, object.strokeWidth) });
  graphics.rect(12, 12, object.width - 24, object.height - 24).stroke({ color: object.stroke, width: 1 });

  return graphics;
}

function drawMarker(object: Extract<SceneObject, { type: "marker" }>): Container {
  const container = new Container();
  const badge = new Graphics().circle(object.width / 2, object.height / 2, Math.min(object.width, object.height) / 2).fill(object.fill).stroke({
    color: object.stroke,
    width: object.strokeWidth
  });
  const text = new Text({
    text: "E",
    style: {
      fill: "#ffffff",
      fontFamily: "Inter, Arial, sans-serif",
      fontSize: object.height * 0.58,
      fontWeight: "800"
    }
  });

  text.anchor.set(0.5);
  text.x = object.width / 2;
  text.y = object.height / 2;
  container.addChild(badge, text);

  return container;
}

function drawGroup(object: Extract<SceneObject, { type: "group" }>): Graphics {
  const graphics = new Graphics();

  graphics.roundRect(0, 0, object.width, object.height, 12).fill({ color: "#23c7d9", alpha: 0.1 });
  graphics.roundRect(0, 0, object.width, object.height, 12).stroke({ color: object.stroke, width: object.strokeWidth || 2 });

  return graphics;
}

function drawText(object: Extract<SceneObject, { type: "text" }>): Text {
  const text = new Text({
    text: object.text,
    style: {
      fill: object.fill,
      fontFamily: object.fontFamily,
      fontSize: object.fontSize,
      fontWeight: object.fontWeight,
      align: object.align,
      wordWrap: true,
      wordWrapWidth: object.width
    }
  });

  if (object.align === "center") {
    text.x = object.width / 2;
    text.anchor.set(0.5, 0);
  }

  if (object.align === "right") {
    text.x = object.width;
    text.anchor.set(1, 0);
  }

  return text;
}

function sizeTextureSprite(
  sprite: Sprite,
  naturalWidth: number,
  naturalHeight: number,
  targetWidth: number,
  targetHeight: number,
  fit: string
): void {
  if (fit === "stretch") {
    sprite.width = targetWidth;
    sprite.height = targetHeight;
    return;
  }
  const scale = fit === "fit" || fit === "contain"
    ? Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
    : fit === "fill" || fit === "crop" || fit === "cover"
      ? Math.max(targetWidth / naturalWidth, targetHeight / naturalHeight)
      : 1;
  sprite.width = naturalWidth * scale;
  sprite.height = naturalHeight * scale;
  sprite.x = (targetWidth - sprite.width) / 2;
  sprite.y = (targetHeight - sprite.height) / 2;
}

function adjustHex(color: string, amount: number): string {
  if (!color.startsWith("#") || color.length < 7) {
    return color;
  }

  const channel = (offset: number) => Math.min(255, Math.max(0, Number.parseInt(color.slice(offset, offset + 2), 16) + amount));

  return `#${channel(1).toString(16).padStart(2, "0")}${channel(3).toString(16).padStart(2, "0")}${channel(5).toString(16).padStart(2, "0")}`;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function destroyContainer(container: Container): void {
  const children = container.removeChildren();

  for (const child of children) {
    child.destroy({ children: true });
  }
}
