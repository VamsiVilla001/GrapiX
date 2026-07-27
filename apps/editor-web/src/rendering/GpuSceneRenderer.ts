import {
  Application,
  Assets,
  BlurFilter,
  Container,
  FillGradient,
  Graphics,
  Sprite,
  Text,
  Texture,
  TilingSprite,
  type FillInput,
  type StrokeInput,
  type TextureSourceLike,
  type WRAP_MODE
} from "pixi.js";
import {
  IMPLEMENTED_BLEND_MODES,
  IMPLEMENTED_MASK_MODES,
  type BezierPath,
  type ColorValue,
  type MaterialBlendMode,
  type MaterialTextureSlot,
  type ObjectMask,
  type PaintStroke,
  type SceneDocument,
  type SceneObject,
  normalizeColorValue
} from "@grapix/shared-types";
import type { PreviewRendererCapabilities } from "./ScenePreviewRenderer";
import { isVideoSource, type RenderableSceneObject } from "./sceneMaterial";
import { ThreeSceneLayer } from "./ThreeSceneLayer";

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
/**
 * Choose how PixiJS should load a texture source. Data URLs carry their MIME
 * inline, so Pixi auto-detects the parser (loadTextures for raster, loadSVG for
 * SVG) with no hint. Imported assets are served as extension-less content URLs
 * (/api/assets/<id>/content), which match no parser by extension — so we force
 * the parser from the asset MIME. Without a MIME we fall back to the bare
 * string and let Pixi's extension heuristic try.
 */
function loadDescriptorForSource(source: string, mimeHint?: string): string | { src: string; loadParser: string } {
  if (source.startsWith("data:")) {
    return source;
  }
  if (mimeHint?.startsWith("image/svg")) {
    return { src: source, loadParser: "loadSVG" };
  }
  if (mimeHint?.startsWith("image/")) {
    return { src: source, loadParser: "loadTextures" };
  }
  return source;
}

function applyTextureSampler(texture: Texture, slot: MaterialTextureSlot | undefined): void {
  if (!slot || !texture?.source) {
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

export class GpuSceneRenderer {
  readonly app = new Application();

  private readonly root = new Container();
  private readonly threeLayer = new ThreeSceneLayer();
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
    this.threeLayer.mount(host, scene);
    this.fitCanvasToHost();
    this.initialized = true;
  }

  resize(scene: SceneDocument): void {
    if (!this.initialized) {
      return;
    }

    this.app.renderer.resize(scene.canvas.width, scene.canvas.height);
    this.threeLayer.resize(scene);
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
      if (object.type === "mesh" || object.type === "layer" || object.type === "group") {
        continue;
      }
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
      const content = await this.createDisplayObject(object);

      if (version !== this.renderVersion) {
        destroyContainer(nextRoot);
        return;
      }

      // AE-style layer masks clip the content (mask path is in object-local space,
      // same as the content, so a wrapper carries the object transform).
      const displayObject = applyObjectMasks(content, object);
      displayObject.x = object.x;
      displayObject.y = object.y;
      displayObject.rotation = degreesToRadians(object.rotation);
      displayObject.scale.set(object.scaleX ?? 1, object.scaleY ?? 1);
      displayObject.pivot.set(object.anchor?.x ?? 0, object.anchor?.y ?? 0);
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
    await this.threeLayer.render(scene, objects);
  }

  getCapabilities(): PreviewRendererCapabilities {
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
      rendererName: `${gl?.getParameter(gl.RENDERER) as string || "GPU renderer"} + Three.js depth layer`
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
    this.threeLayer.destroy();

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
      case "shape":
        return drawShape(object);
      case "paint":
        return drawPaint(object);
      case "mesh":
        throw new Error("Mesh objects are rendered exclusively by the Three.js depth layer.");
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
    const texture = await this.getTexture(object.src, object.materialAssetMime);
    if (texture === Texture.EMPTY) {
      container.addChild(drawMissingTexture(object.width, object.height));
      return container;
    }
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
    const texture = await this.getTexture(object.materialAssetSource!, object.materialAssetMime);
    if (texture === Texture.EMPTY) {
      // A decode/network failure must not make the primitive disappear. Keep
      // its authored fallback colour visible while the cache remains retryable.
      container.addChild(drawRect(object));
      return container;
    }
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

  private async getTexture(source: string, mimeHint?: string): Promise<Texture> {
    if (this.textureCache.has(source)) {
      return this.textureCache.get(source)!;
    }

    const texturePromise = (
      isVideoSource(source)
        ? Promise.resolve(this.createVideoTexture(source))
        : this.loadImageTexture(source, mimeHint)
    ).then((texture) => {
      if (texture === Texture.EMPTY) {
        this.textureCache.delete(source);
      }
      return texture;
    }, () => {
      this.textureCache.delete(source);
      return Texture.EMPTY;
    });

    this.textureCache.set(source, texturePromise);

    return texturePromise;
  }

  private async loadImageTexture(source: string, mimeHint?: string): Promise<Texture> {
    if (!source) {
      return Texture.EMPTY;
    }

    try {
      const texture = await Assets.load<Texture>(loadDescriptorForSource(source, mimeHint));
      // PixiJS RESOLVES (not rejects) to null when no load parser matches the
      // URL — e.g. an extension-less API content URL like /api/assets/<id>/content
      // — so a plain `.catch` never fires and the null flows into the sampler
      // and throws "Cannot read properties of null (reading 'source')". Coalesce
      // that null to EMPTY so a bad/unparseable source can never crash a render.
      return texture ?? Texture.EMPTY;
    } catch {
      return Texture.EMPTY;
    }
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

  background
    .rect(0, 0, scene.canvas.width, scene.canvas.height)
    .fill(pixiColorValue(scene.canvas.backgroundStyle, scene.canvas.background));

  return background;
}

function drawMissingTexture(width: number, height: number): Graphics {
  const graphics = new Graphics();
  const cell = Math.max(12, Math.min(32, Math.round(Math.min(width, height) / 6)));
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      graphics
        .rect(x, y, Math.min(cell, width - x), Math.min(cell, height - y))
        .fill((Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? "#5b246b" : "#25152d");
    }
  }
  graphics
    .moveTo(0, 0)
    .lineTo(width, height)
    .moveTo(width, 0)
    .lineTo(0, height)
    .stroke({ color: "#ff4fd8", width: Math.max(2, Math.min(width, height) / 32) });
  return graphics;
}

function drawRect(object: Extract<SceneObject, { type: "rect" }>): Graphics {
  const graphics = new Graphics();

  graphics
    .roundRect(0, 0, object.width, object.height, object.radius)
    .fill(pixiColorValue(object.fillStyle, object.fill));

  if (object.strokeWidth > 0 && object.stroke !== "transparent") {
    graphics.stroke(pixiStroke(object.strokeStyle, object.stroke, object.strokeWidth));
  }

  return graphics;
}

function drawEllipse(object: Extract<SceneObject, { type: "ellipse" }>): Graphics {
  const graphics = new Graphics();

  graphics
    .ellipse(object.width / 2, object.height / 2, object.width / 2, object.height / 2)
    .fill(pixiColorValue(object.fillStyle, object.fill));

  if (object.strokeWidth > 0 && object.stroke !== "transparent") {
    graphics.stroke(pixiStroke(object.strokeStyle, object.stroke, object.strokeWidth));
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

    graphics.stroke(pixiStroke(object.strokeStyle, object.stroke, Math.max(1, object.strokeWidth)));
  }

  return graphics;
}

/** Trace a bezier path into a Graphics, always treating it as a closed region (masks are closed). */
function traceBezierPath(graphics: Graphics, path: BezierPath): void {
  const { vertices, inTangents, outTangents } = path;
  const count = vertices.length;
  if (count === 0) return;
  graphics.moveTo(vertices[0].x, vertices[0].y);
  for (let index = 0; index < count; index += 1) {
    const from = vertices[index];
    const to = vertices[(index + 1) % count];
    const out = outTangents[index] ?? { x: 0, y: 0 };
    const inn = inTangents[(index + 1) % count] ?? { x: 0, y: 0 };
    graphics.bezierCurveTo(from.x + out.x, from.y + out.y, to.x + inn.x, to.y + inn.y, to.x, to.y);
  }
  graphics.closePath();
}

/**
 * Build the mask Graphics for an object's masks. `add`/`subtract` + `inverted`
 * resolve to reveal-inside vs hide-inside regions; reveal paths are filled
 * (union), hide paths are cut as holes. A hide-only mask reveals everything then
 * cuts (subtract on the full frame).
 */
function buildMaskGraphics(masks: ObjectMask[], object: RenderableSceneObject): Graphics {
  const graphics = new Graphics();
  const isReveal = (mask: ObjectMask) =>
    (["add", "intersect", "lighten"].includes(mask.mode) && !mask.inverted)
    || (["subtract", "darken"].includes(mask.mode) && mask.inverted)
    || mask.mode === "difference";
  const reveal = masks.filter(isReveal);
  const hide = masks.filter((mask) => !isReveal(mask));

  if (reveal.length > 0) {
    for (const mask of reveal) {
      if (mask.type === "paint") {
        drawMaskPaintStrokes(graphics, mask);
      } else {
        traceBezierPath(graphics, mask.path);
        graphics.fill({ color: 0xffffff, alpha: mask.opacity });
        if (mask.expansion > 0) {
          graphics.stroke({
            color: 0xffffff,
            alpha: mask.opacity,
            width: mask.expansion * 2,
            join: "round"
          });
        }
      }
    }
  } else {
    const pad = Math.max(object.width, object.height) * 4 + 4000;
    graphics.rect(-pad, -pad, object.width + pad * 2, object.height + pad * 2).fill({ color: 0xffffff });
  }
  for (const mask of hide) {
    if (mask.type === "paint") {
      drawMaskPaintStrokes(graphics, mask, true);
    } else {
      traceBezierPath(graphics, mask.path);
      graphics.cut();
    }
  }
  return graphics;
}

function drawMaskPaintStrokes(graphics: Graphics, mask: ObjectMask, cut = false): void {
  for (const stroke of mask.paintStrokes ?? []) {
    if (stroke.points.length === 0) continue;
    const shouldCut = cut || stroke.maskMode === "erase";
    const alpha = Math.min(1, Math.max(0, stroke.opacity * mask.opacity));
    for (let index = 0; index < stroke.points.length; index += 1) {
      const point = stroke.points[index];
      const radius = Math.max(0.5, stroke.size * (point.pressure ?? 1) / 2);
      graphics.circle(point.x, point.y, radius);
      if (shouldCut) graphics.cut();
      else graphics.fill({ color: 0xffffff, alpha });
      if (index === 0) continue;
      const previous = stroke.points[index - 1];
      graphics.moveTo(previous.x, previous.y).lineTo(point.x, point.y);
      graphics.stroke({
        color: shouldCut ? 0x000000 : 0xffffff,
        alpha: shouldCut ? 0 : alpha,
        width: Math.max(1, stroke.size * ((previous.pressure ?? 1) + (point.pressure ?? 1)) / 2),
        cap: "round",
        join: "round"
      });
    }
  }
}

/** Wrap content in a masked container when the object has renderable masks; otherwise pass through. */
function applyObjectMasks(
  content: Container | Graphics | Text,
  object: RenderableSceneObject
): Container | Graphics | Text {
  const masks = (object.masks ?? []).filter(
    (mask) => mask.visible !== false
      && mask.mode !== "none"
      && IMPLEMENTED_MASK_MODES.includes(mask.mode)
      && (mask.path.vertices.length >= 3 || Boolean(mask.paintStrokes?.some((stroke) => stroke.points.length > 0)))
  );
  if (masks.length === 0) {
    return content;
  }
  const wrapper = new Container();
  wrapper.addChild(content);
  const maskGraphics = buildMaskGraphics(masks, object);
  const featherX = Math.max(...masks.map((mask) => Math.max(0, mask.feather.x)), 0);
  const featherY = Math.max(...masks.map((mask) => Math.max(0, mask.feather.y)), 0);
  if (featherX > 0 || featherY > 0) {
    maskGraphics.filters = [new BlurFilter({
      strengthX: featherX,
      strengthY: featherY,
      quality: 3
    })];
  }
  wrapper.addChild(maskGraphics);
  wrapper.mask = maskGraphics;
  return wrapper;
}

function drawShape(object: Extract<SceneObject, { type: "shape" }>): Graphics {
  const graphics = new Graphics();
  const { vertices, inTangents, outTangents, closed } = object.path;
  const count = vertices.length;

  if (count > 0) {
    graphics.moveTo(vertices[0].x, vertices[0].y);
    const segments = closed ? count : count - 1;
    for (let index = 0; index < segments; index += 1) {
      const from = vertices[index];
      const to = vertices[(index + 1) % count];
      const out = outTangents[index] ?? { x: 0, y: 0 };
      const inn = inTangents[(index + 1) % count] ?? { x: 0, y: 0 };
      // Cubic bezier from `from` to `to` with relative tangent handles.
      graphics.bezierCurveTo(from.x + out.x, from.y + out.y, to.x + inn.x, to.y + inn.y, to.x, to.y);
    }
    if (closed) {
      graphics.closePath();
    }
    // A fill always closes the region (After Effects behaviour), so it renders
    // even for an open path; only the stroke respects open vs closed.
    if (object.fillEnabled && count >= 2) {
      graphics.fill(pixiColorValue(object.fillStyle, object.fill));
    }
    if (object.strokeEnabled && object.strokeWidth > 0 && object.stroke !== "transparent") {
      graphics.stroke(pixiStroke(object.strokeStyle, object.stroke, object.strokeWidth, {
        cap: "round",
        join: "round"
      }));
    }
  }

  return graphics;
}

function drawPaint(object: Extract<SceneObject, { type: "paint" }>): Graphics {
  const graphics = new Graphics();

  for (const stroke of object.strokes) {
    drawPaintStroke(graphics, stroke);
  }

  return graphics;
}

function drawPaintStroke(graphics: Graphics, stroke: PaintStroke): void {
  if (stroke.points.length === 0) return;
  const color = pixiColorValue(stroke.color, "#ffffff");
  const alpha = Math.min(1, Math.max(0, stroke.opacity * stroke.flow));

  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    graphics
      .circle(point.x, point.y, Math.max(0.5, stroke.size * (point.pressure ?? 1) / 2))
      .fill(pixiFillWithAlpha(color, alpha));
    return;
  }

  for (let index = 1; index < stroke.points.length; index += 1) {
    const from = stroke.points[index - 1];
    const to = stroke.points[index];
    const pressure = ((from.pressure ?? 1) + (to.pressure ?? 1)) / 2;
    graphics
      .moveTo(from.x, from.y)
      .lineTo(to.x, to.y)
      .stroke(pixiStrokeValue(color, Math.max(1, stroke.size * pressure), {
        alpha,
        cap: "round",
        join: "round"
      }));
  }
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

function drawText(object: Extract<SceneObject, { type: "text" }>): Text | Container {
  if (object.writingMode && object.writingMode !== "horizontal-tb") {
    return drawVerticalText(object);
  }
  const text = new Text({
    text: object.text,
    style: {
      fill: pixiColorValue(object.fillStyle, object.fill),
      fontFamily: object.fontFamily,
      fontSize: object.fontSize,
      fontWeight: object.fontWeight,
      fontStyle: object.fontStyle,
      letterSpacing: object.letterSpacing,
      lineHeight: object.lineHeight,
      align: object.align,
      wordWrap: object.textLayout !== "point",
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

function drawVerticalText(object: Extract<SceneObject, { type: "text" }>): Container {
  const container = new Container();
  const characters = Array.from(object.text);
  const advance = Math.max(1, object.lineHeight ?? object.fontSize * 1.2);
  const columns = Math.max(1, Math.ceil(characters.length / Math.max(1, Math.floor(object.height / advance))));
  const rowsPerColumn = Math.max(1, Math.ceil(characters.length / columns));
  const columnAdvance = Math.max(object.fontSize, advance);

  for (let column = 0; column < columns; column += 1) {
    const start = column * rowsPerColumn;
    const glyphs = characters.slice(start, start + rowsPerColumn);
    const contentHeight = glyphs.length * advance;
    const offsetY = object.verticalAlign === "middle"
      ? Math.max(0, (object.height - contentHeight) / 2)
      : object.verticalAlign === "bottom"
        ? Math.max(0, object.height - contentHeight)
        : 0;
    const x = object.writingMode === "vertical-lr"
      ? column * columnAdvance
      : object.width - object.fontSize - column * columnAdvance;

    glyphs.forEach((glyph, row) => {
      const text = new Text({
        text: glyph,
        style: {
          fill: pixiColorValue(object.fillStyle, object.fill),
          fontFamily: object.fontFamily,
          fontSize: object.fontSize,
          fontWeight: object.fontWeight,
          fontStyle: object.fontStyle,
          align: "center"
        }
      });
      text.x = x + object.fontSize / 2;
      text.y = offsetY + row * advance;
      text.anchor.set(0.5, 0);
      container.addChild(text);
    });
  }

  return container;
}

function pixiColorValue(value: ColorValue | string | undefined, fallback: string): string | FillGradient {
  const normalized = normalizeColorValue(value, fallback);
  if (normalized.type === "none") return "transparent";
  if (normalized.type === "solid") return normalized.color;

  const colorStops = normalized.stops.map((stop) => ({
    offset: stop.position,
    color: withAlpha(stop.color, stop.opacity)
  }));
  const textureSpace = normalized.coordinateMode === "scene" ? "global" as const : "local" as const;

  if (normalized.type === "linear-gradient") {
    return new FillGradient({
      type: "linear",
      start: { x: normalized.startX, y: normalized.startY },
      end: { x: normalized.endX, y: normalized.endY },
      colorStops,
      textureSpace
    });
  }

  return new FillGradient({
    type: "radial",
    center: { x: normalized.focalX ?? normalized.centerX, y: normalized.focalY ?? normalized.centerY },
    innerRadius: 0,
    outerCenter: { x: normalized.centerX, y: normalized.centerY },
    outerRadius: normalized.radiusX,
    scale: normalized.radiusX === 0 ? 1 : normalized.radiusY / normalized.radiusX,
    colorStops,
    textureSpace
  });
}

function pixiFillWithAlpha(value: string | FillGradient, alpha: number): FillInput {
  return value instanceof FillGradient ? { fill: value, alpha } : { color: value, alpha };
}

function pixiStroke(
  value: ColorValue | string | undefined,
  fallback: string,
  width: number,
  options: { alpha?: number; cap?: "butt" | "round" | "square"; join?: "miter" | "round" | "bevel" } = {}
): StrokeInput {
  return pixiStrokeValue(pixiColorValue(value, fallback), width, options);
}

function pixiStrokeValue(
  value: string | FillGradient,
  width: number,
  options: { alpha?: number; cap?: "butt" | "round" | "square"; join?: "miter" | "round" | "bevel" } = {}
): StrokeInput {
  return value instanceof FillGradient
    ? { fill: value, width, ...options }
    : { color: value, width, ...options };
}

function withAlpha(color: string, opacity: number): string {
  if (!color.startsWith("#")) return color;
  const rgb = color.length >= 7 ? color.slice(0, 7) : color;
  return `${rgb}${Math.round(Math.min(1, Math.max(0, opacity)) * 255).toString(16).padStart(2, "0")}`;
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
