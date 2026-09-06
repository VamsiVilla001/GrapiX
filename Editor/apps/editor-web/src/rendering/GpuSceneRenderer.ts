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
  IMPLEMENTED_TEXTURE_FIT_MODES,
  IMPLEMENTED_MASK_MODES,
  type BezierPath,
  type TextSceneObject,
  type ColorValue,
  type MaterialBlendMode,
  type MaterialTextureSlot,
  type ObjectMask,
  type PaintStroke,
  type SceneDocument,
  type SceneObject,
  buildFontFamilyStack,
  fontDefinitionForText,
  normalizeColorValue
} from "@grapix/shared-types";
import type { PreviewRendererCapabilities } from "./ScenePreviewRenderer";
import { isProjectServiceUrl, resolveProjectAssetObjectUrl, resolveProjectAssetUrl } from "../lib/projectAssets";
import { compoundGraphicsPath, shapeTrimActive, shapeVertexCount, trimmedStrokePolylines } from "./shapeGeometry";
import { applyTextCase, hasTextDecoration } from "./textPresentation";
import { isVideoSource, type RenderableSceneObject } from "./sceneMaterial";
import { ThreeSceneLayer } from "./ThreeSceneLayer";
import { projectFontRegistry } from "../fonts/ProjectFontRegistry";

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
function loadDescriptorForSource(source: string, mimeHint?: string): string | { src: string; parser: string } {
  if (source.startsWith("data:")) {
    return source;
  }
  if (mimeHint?.startsWith("image/svg")) {
    return { src: source, parser: "loadSVG" };
  }
  if (mimeHint?.startsWith("image/")) {
    return { src: source, parser: "loadTextures" };
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
 * modes. The engine mirrors Pixi's exact blend equations per
 * Shared/render-shaders/layouts.json, so this mapping is the preview half
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
  /** Blob URLs backing playing videos, released on destroy rather than after load. */
  private readonly videoObjectUrls: string[] = [];
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
      if (
        object.type === "mesh"
        || object.type === "layer"
        || object.type === "group"
        || (["rect", "ellipse", "image"].includes(object.type) && Boolean(object.faceMaterials?.main))
      ) {
        continue;
      }
      if (object.resolvedMaterial && (
        object.resolvedMaterial.material.enabled === false
        || !IMPLEMENTED_BLEND_MODES.includes(object.resolvedMaterial.blendMode)
        || !["opaque", "straight", "premultiplied"].includes(object.resolvedMaterial.alphaMode)
        // Fit modes outside IMPLEMENTED_TEXTURE_FIT_MODES need a transparent border or extra
        // geometry, which this path cannot express, so they are skipped rather than stretched.
        || object.resolvedMaterial.textureSlots.some((slot) => !IMPLEMENTED_TEXTURE_FIT_MODES.includes(slot.fit))
      )) {
        continue;
      }
      const content = await this.createDisplayObject(object, scene);

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

  /**
   * Read the rendered frame back as a canvas.
   *
   * Uses Pixi's extract API against the scene root rather than the whole stage, so
   * nothing the editor adds for interaction can appear in the image. The interaction
   * overlay is SVG and outside the canvas entirely, but extracting the root keeps that
   * true even if that ever changes.
   */
  async captureFrame(): Promise<(CanvasImageSource & { width: number; height: number }) | null> {
    if (!this.initialized) return null;

    try {
      // Render once first: the extract runs outside the ticker, and an un-rendered
      // frame reads back as empty.
      this.app.renderer.render(this.app.stage);
      const pixiCanvas = this.app.renderer.extract.canvas(this.root) as HTMLCanvasElement;
      if (!pixiCanvas.width || !pixiCanvas.height) return null;

      const threeCanvas = this.threeLayer.captureFrame();
      if (!threeCanvas) return pixiCanvas;

      // Materialized planar objects and meshes live on the transparent Three.js layer,
      // not in Pixi's root. A Pixi-only read-back therefore produced an empty thumbnail
      // for fully materialized scenes even though the viewport was correct.
      const composite = document.createElement("canvas");
      composite.width = pixiCanvas.width;
      composite.height = pixiCanvas.height;
      const context = composite.getContext("2d");
      if (!context) return pixiCanvas;
      context.drawImage(pixiCanvas, 0, 0);
      context.drawImage(threeCanvas, 0, 0, composite.width, composite.height);
      return composite;
    } catch {
      // A lost context or an unsupported extract path is not worth an exception here.
      return null;
    }
  }

  destroy(): void {
    this.renderVersion += 1;

    for (const video of this.videoElements.values()) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }

    // Video blobs outlive the load on purpose — a playing element keeps reading from its source —
    // so this is where they are released.
    for (const objectUrl of this.videoObjectUrls) URL.revokeObjectURL(objectUrl);
    this.videoObjectUrls.length = 0;
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

  private async createDisplayObject(object: RenderableSceneObject, scene: SceneDocument): Promise<Container | Graphics | Text> {
    switch (object.type) {
      case "rect":
        return object.materialAssetSource ? this.drawTexturedQuad(object) : drawRect(object);
      case "ellipse":
        return drawEllipse(object);
      case "text":
        return drawText(object, scene);
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

  private async getTexture(rawSource: string, mimeHint?: string): Promise<Texture> {
    /*
     * An imported image is stored in the project as `images/<scene>/<layer>.png` and the scene keeps
     * that path. A relative path would resolve against the page origin — the dev server, or
     * `tauri.localhost` in the shell — so it is resolved to the project service here, once, for
     * every texture the preview draws.
     */
    const source = resolveProjectAssetUrl(rawSource);
    if (this.textureCache.has(source)) {
      return this.textureCache.get(source)!;
    }

    const texturePromise = (
      isVideoSource(source, mimeHint)
        ? this.loadVideoTexture(source)
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

    /*
     * The project service's content routes require the session bearer, and Pixi's loader
     * cannot attach one — `Assets.load(url)` fetches with no init, so an `/api/assets/<id>/
     * content` source answered 401 and resolved to an empty texture on every image the scene
     * drew. `resolveProjectAssetObjectUrl` fetches with the token and hands Pixi a blob URL
     * instead; the texture keeps the decoded bitmap, so the blob is released as soon as the
     * load settles. Remote and data URLs need no fetch and pass through untouched.
     */
    let loadSource = source;
    let objectUrl: string | undefined;
    if (isProjectServiceUrl(source)) {
      try {
        objectUrl = await resolveProjectAssetObjectUrl(source);
        loadSource = objectUrl;
      } catch {
        return Texture.EMPTY;
      }
    }

    try {
      const texture = await Assets.load<Texture>(loadDescriptorForSource(loadSource, mimeHint));
      // PixiJS RESOLVES (not rejects) to null when no load parser matches the
      // URL — e.g. an extension-less API content URL like /api/assets/<id>/content
      // — so a plain `.catch` never fires and the null flows into the sampler
      // and throws "Cannot read properties of null (reading 'source')". Coalesce
      // that null to EMPTY so a bad/unparseable source can never crash a render.
      return texture ?? Texture.EMPTY;
    } catch {
      return Texture.EMPTY;
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }

  /**
   * Fetch a movie the way an image is fetched, then hand it to a video element.
   *
   * The content routes need the session bearer, and a `<video src>` cannot carry one — pointing it
   * straight at `/api/assets/<id>/content` answers 401 and the layer stays blank. The bytes are
   * fetched with the token and played from a blob instead. Unlike an image, the blob is *not*
   * revoked once loading settles: a texture keeps its decoded bitmap, a video keeps reading from
   * its source for as long as it plays, so the URL is released when the renderer is disposed.
   */
  private async loadVideoTexture(source: string): Promise<Texture> {
    if (!source) return Texture.EMPTY;
    if (this.videoElements.has(source)) {
      return Texture.from(this.videoElements.get(source)! as TextureSourceLike);
    }

    let playbackSource = source;
    if (isProjectServiceUrl(source)) {
      try {
        playbackSource = await resolveProjectAssetObjectUrl(source);
        this.videoObjectUrls.push(playbackSource);
      } catch {
        return Texture.EMPTY;
      }
    }
    return this.createVideoTexture(source, playbackSource);
  }

  private createVideoTexture(source: string, playbackSource = source): Texture {
    const existingVideo = this.videoElements.get(source);

    if (existingVideo) {
      return Texture.from(existingVideo as TextureSourceLike);
    }

    const video = document.createElement("video");

    video.src = playbackSource;
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
        } else if (mask.expansion < 0) {
          // Contract, which the mask contract has always allowed and this renderer used to drop:
          // an operator could type a negative expansion, save it, and see nothing change.
          //
          // A stroke centred on the path covers |expansion| to each side of it. Cutting that band
          // removes the inner half from the filled region and the outer half from empty space, so
          // what remains is the region pulled in by exactly |expansion|.
          traceBezierPath(graphics, mask.path);
          graphics.stroke({ color: 0xffffff, width: -mask.expansion * 2, join: "round" });
          graphics.cut();
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
  wrapper.setMask({ mask: maskGraphics, inverse: false, channel: "alpha" });
  return wrapper;
}

function drawShape(object: Extract<SceneObject, { type: "shape" }>): Graphics {
  const graphics = new Graphics();
  /*
   * Every subpath, in one path object, so holes are holes.
   *
   * A compound path is one shape: the letter O is an outer ring and an inner one, and a 48-subpath
   * logo is one drawing. Only `path` was drawn before, so every counter and every extra piece of a
   * logo was silently missing from an imported vector — the single most visible way a vector "does
   * not import exactly".
   *
   * `checkForHoles` is what makes Pixi treat a subpath contained by another as a hole rather than
   * paint over it; it only applies to a path added whole, which is why this builds a `GraphicsPath`
   * instead of drawing into the context directly.
   */
  const drawable = shapeVertexCount(object);
  if (drawable === 0) return graphics;

  graphics.path(compoundGraphicsPath(object));

  // A fill always closes the region (After Effects behaviour), so it renders
  // even for an open path; only the stroke respects open vs closed.
  if (object.fillEnabled && drawable >= 2) {
    graphics.fill(pixiColorValue(object.fillStyle, object.fill));
  }
  if (object.strokeEnabled && object.strokeWidth > 0 && object.stroke !== "transparent") {
    const strokeStyle = pixiStroke(object.strokeStyle, object.stroke, object.strokeWidth, {
      cap: "round",
      join: "round"
    });
    if (shapeTrimActive(object)) {
      // Trim Paths: the stroke draws only the start–end window. The fill above already
      // covered the full region, which is AE's rule — the trim reveals the outline, never
      // the area. One open polyline per piece; a wrapped window on a closed path is two.
      for (const piece of trimmedStrokePolylines(object)) {
        graphics.moveTo(piece[0].x, piece[0].y);
        for (const point of piece.slice(1)) {
          graphics.lineTo(point.x, point.y);
        }
        graphics.stroke(strokeStyle);
      }
    } else {
      graphics.stroke(strokeStyle);
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

/**
 * Underline and strikethrough, drawn as rules.
 *
 * Pixi's text style has no decoration of its own, so the alternative to drawing them is dropping
 * them. Thickness and offset follow the font size, which is what keeps a 200px headline and a 16px
 * caption looking like the same design.
 */
function drawTextDecoration(
  text: Text,
  object: Extract<SceneObject, { type: "text" }>
): Container | Text {
  const decoration = object.textDecoration;
  if (!hasTextDecoration(decoration)) return text;

  const container = new Container();
  const rules = new Graphics();
  const width = text.width;
  const thickness = Math.max(1, object.fontSize * 0.06);
  const colour = pixiColorValue(object.fillStyle, object.fill);

  if (decoration.underline) {
    rules.rect(0, text.height - thickness * 1.5, width, thickness).fill(colour);
  }
  if (decoration.strikethrough) {
    rules.rect(0, text.height / 2 - thickness / 2, width, thickness).fill(colour);
  }

  container.addChild(text, rules);
  return container;
}

async function drawText(
  object: Extract<SceneObject, { type: "text" }>,
  scene: SceneDocument
): Promise<Text | Container> {
  const font = fontDefinitionForText(scene.fonts ?? [], object);
  const fontFamily = buildFontFamilyStack(font, object.fontFamily, object.fallbackFamilies);
  if (object.writingMode && object.writingMode !== "horizontal-tb") {
    return drawVerticalText(object, fontFamily);
  }
  const stroke = normalizeColorValue(object.strokeStyle, object.stroke);
  const hasStroke = object.strokeWidth > 0 && !isTransparentColor(stroke);
  const text = new Text({
    text: bidiIsolate(applyTextCase(object.text, object.textCase), object.direction),
    style: {
      fill: pixiColorValue(object.fillStyle, object.fill),
      ...(hasStroke ? { stroke: pixiStroke(stroke, object.stroke, object.strokeWidth) } : {}),
      fontFamily,
      fontSize: object.fontSize,
      fontWeight: pixiFontWeight(object.fontWeight),
      fontStyle: object.fontStyle,
      letterSpacing: object.letterSpacing,
      lineHeight: object.lineHeight,
      align: object.align,
      wordWrap: object.textLayout !== "point",
      wordWrapWidth: object.width
    }
  });

  if (object.autoFit && object.autoFit !== "none" && text.width > 0 && text.height > 0) {
    const ratio = Math.min(object.width / text.width, object.height / text.height);
    const scale = object.autoFit === "shrink" ? Math.min(1, ratio) : ratio;
    if (Number.isFinite(scale) && scale > 0) text.scale.set(scale);
  }

  if (object.align === "center") {
    text.x = object.width / 2;
    text.anchor.set(0.5, 0);
  }

  if (object.align === "right") {
    text.x = object.width;
    text.anchor.set(1, 0);
  }

  if (object.verticalAlign === "middle") {
    text.y = (object.height - text.height) / 2;
  } else if (object.verticalAlign === "bottom") {
    text.y = object.height - text.height;
  }

  const runtime = font ? projectFontRegistry.get(font.fontId) : undefined;
  if (font && runtime?.status !== "READY") {
    const container = new Container();
    const warning = new Graphics();
    warning.rect(0, 0, Math.max(object.width, text.width), Math.max(object.height, text.height))
      .stroke({ color: "#ff496c", width: 2, alpha: 0.9 });
    container.addChild(text, warning);
    return container;
  }
  // Decoration last, so its rules are measured against the laid-out text.
  return drawTextDecoration(text, object);
}

async function drawVerticalText(
  object: Extract<SceneObject, { type: "text" }>,
  fontFamily: string
): Promise<Sprite> {
  // SVG delegates vertical layout, bidi, ligatures, combining marks, and
  // fallback shaping to the browser text engine. Never split text into
  // characters: doing so breaks Arabic/Indic shaping and emoji clusters.
  const anchor = object.verticalAlign === "middle" ? "middle" : object.verticalAlign === "bottom" ? "end" : "start";
  const y = object.verticalAlign === "middle" ? object.height / 2 : object.verticalAlign === "bottom" ? object.height : 0;
  const x = object.writingMode === "vertical-lr" ? 0 : object.width;
  const color = normalizeColorValue(object.fillStyle, object.fill);
  const fill = color.type === "solid" ? color.color : object.fill;
  const stroke = normalizeColorValue(object.strokeStyle, object.stroke);
  const strokeAttributes = object.strokeWidth > 0 && !isTransparentColor(stroke)
    ? ` stroke="${escapeXml(stroke.type === "solid" ? stroke.color : object.stroke)}" stroke-width="${object.strokeWidth}" paint-order="stroke"`
    : "";
  const decoration = [
    object.textDecoration?.underline ? "underline" : "",
    object.textDecoration?.strikethrough ? "line-through" : ""
  ].filter(Boolean).join(" ") || "none";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, object.width)}" height="${Math.max(1, object.height)}">
<text x="${x}" y="${y}" fill="${escapeXml(fill)}"${strokeAttributes} font-family="${escapeXml(fontFamily)}" font-size="${object.fontSize}" font-weight="${escapeXml(object.fontWeight)}" font-style="${object.fontStyle ?? "normal"}" text-anchor="${anchor}" style="writing-mode:${object.writingMode};white-space:pre-wrap;direction:${object.direction ?? "auto"};letter-spacing:${object.letterSpacing ?? 0}px;word-spacing:${object.wordSpacing ?? 0}px;text-decoration:${decoration}">${escapeXml(object.text)}</text>
</svg>`;
  const image = new Image();
  const source = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    image.src = source;
    await image.decode();
    return new Sprite(Texture.from(image));
  } finally {
    URL.revokeObjectURL(source);
  }
}

function bidiIsolate(value: string, direction: "auto" | "ltr" | "rtl" | undefined): string {
  return direction === "rtl" ? `\u2067${value}\u2069`
    : direction === "ltr" ? `\u2066${value}\u2069`
      : value;
}

function pixiFontWeight(value: string): "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900" {
  const weight = Math.max(100, Math.min(900, Math.round((Number(value) || 400) / 100) * 100));
  return String(weight) as ReturnType<typeof pixiFontWeight>;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;"
  })[character]!);
}

function isTransparentColor(value: ColorValue): boolean {
  return value.type === "none"
    || (value.type === "solid" && (
      value.color === "transparent"
      || /^#[0-9a-f]{6}00$/i.test(value.color)
      || value.color === "#0000"
    ));
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
