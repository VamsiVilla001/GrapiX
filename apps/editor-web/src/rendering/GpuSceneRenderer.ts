import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  type TextureSourceLike
} from "pixi.js";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import { isVideoSource, type RenderableSceneObject } from "./sceneMaterial";

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
    this.initialized = true;
  }

  resize(scene: SceneDocument): void {
    if (!this.initialized) {
      return;
    }

    this.app.renderer.resize(scene.canvas.width, scene.canvas.height);
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
        || !["normal", "add"].includes(object.resolvedMaterial.blendMode)
        || !["opaque", "straight", "premultiplied"].includes(object.resolvedMaterial.alphaMode)
        || object.resolvedMaterial.textureSlots.some((slot) => slot.wrap !== "clamp" || slot.filtering !== "linear" || ["tile", "nine-slice"].includes(slot.fit))
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
      displayObject.blendMode = object.resolvedMaterial?.blendMode === "add" ? "add" : "normal";

      nextRoot.addChild(displayObject);
    }

    destroyContainer(this.root);
    this.root.removeChildren();
    this.root.addChild(...nextRoot.removeChildren());
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
      this.app.destroy(true, { children: true });
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
    const sprite = new Sprite(texture);
    const naturalWidth = Math.max(1, texture.width || object.width);
    const naturalHeight = Math.max(1, texture.height || object.height);
    const materialFit = object.resolvedMaterial?.textureSlots[0]?.fit;
    sizeTextureSprite(sprite, naturalWidth, naturalHeight, object.width, object.height, materialFit ?? object.objectFit);
    applyTextureMaterial(sprite, object);

    const mask = new Graphics().rect(0, 0, object.width, object.height).fill("#ffffff");
    container.addChild(sprite, mask);
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
    const sprite = new Sprite(texture);
    sizeTextureSprite(
      sprite,
      Math.max(1, texture.width || object.width),
      Math.max(1, texture.height || object.height),
      object.width,
      object.height,
      object.resolvedMaterial?.textureSlots[0]?.fit ?? "fill"
    );
    applyTextureMaterial(sprite, object);
    const mask = new Graphics().roundRect(0, 0, object.width, object.height, object.radius).fill("#ffffff");
    container.addChild(sprite, mask);
    container.mask = mask;
    if (object.strokeWidth > 0 && object.stroke !== "transparent") {
      container.addChild(new Graphics().roundRect(0, 0, object.width, object.height, object.radius).stroke({
        color: object.stroke,
        width: object.strokeWidth
      }));
    }
    return container;
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

function applyTextureMaterial(sprite: Sprite, object: RenderableSceneObject): void {
  const parameters = object.resolvedMaterial?.parameters;
  const tint = parameters?.tint;
  const uvScale = parameters?.uvScale;
  const uvOffset = parameters?.uvOffset;
  if (typeof tint === "string") {
    sprite.tint = tint;
  }

  if (Array.isArray(uvScale) && uvScale.length >= 2) {
    const scaleX = Math.max(0.001, Math.abs(Number(uvScale[0]) || 1));
    const scaleY = Math.max(0.001, Math.abs(Number(uvScale[1]) || 1));
    sprite.width /= scaleX;
    sprite.height /= scaleY;
  }

  if (Array.isArray(uvOffset) && uvOffset.length >= 2) {
    sprite.x -= (Number(uvOffset[0]) || 0) * object.width;
    sprite.y -= (Number(uvOffset[1]) || 0) * object.height;
  }
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
