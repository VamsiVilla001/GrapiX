//! The Editor viewport: a Three.js renderer over the scene document
//! (build plan 11.6; ADR-0002 A.1 — Three.js on WebGL2 is the sole browser
//! renderer).
//!
//! This module is deliberately thin: the policy lives in `color-policy.ts`
//! and `camera.ts` (both testable headless), and this file is the wiring that
//! needs a GL context. It builds a WebGL2 renderer with the colour policy
//! applied, an orthographic camera over the scene's coordinate space, and one
//! mesh per scene object, positioned in scene coordinates.
//!
//! What it does not do: hit-testing, overlays, or the render loop's frame
//! scheduling — those are 11.7 (overlay layer) and the Tauri shell's concern.
//! And per Phase 13's direction, this layer is structured so the engine can
//! take over the raster later (13.5): the scene graph here is a viewport
//! convenience, not the production pixel path (invariant 2 — only the engine
//! rasterizes production pixels).

import * as THREE from "three";

import type {
  BlendMode,
  ColorValue,
  MaterialTextureSlot,
  SceneDocument,
  SceneObject,
  SourceColorSpace,
} from "@grapix/contracts";
import { PREVIEW_OUTPUT_COLOR_SPACE } from "./color-policy";
import { makeOrthographicSceneCamera, scenePosition, type SceneDepthRange } from "./camera";
import { rec709Decode } from "./color-transfer";
import {
  planPreviewMaterial,
  resolveObjectMaterial,
  type AssetSources,
  type PreviewMaterialPlan,
  type PreviewSide,
  type PreviewTexture,
} from "./material-preview";

/// A viewport over one scene. Owns the renderer, the camera and the meshes
/// built from the document. Dispose with `dispose()`.
export class SceneViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly rendered = new Map<
    string,
    {
      readonly mesh: THREE.Mesh;
      readonly type: SceneObject["type"];
      width: number;
      height: number;
      depth: number;
    }
  >();
  /// Objects this layer could not draw, and why — a gradient it has no
  /// texture for, a colour space it cannot convert. Read by the shell so a
  /// missing object is explained rather than merely absent.
  readonly unsupported: string[] = [];

  /// The video elements the moving textures read, and every texture this
  /// viewport allocated. Held so the playhead can drive the first and
  /// `dispose` can release both.
  private readonly videos: PreviewVideo[] = [];
  private readonly textures: THREE.Texture[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    document: SceneDocument,
    sources: AssetSources = new Map(),
    onTextureLoad?: () => void,
  ) {
    const space = { width: document.canvas.width, height: document.canvas.height };
    const context: PreviewContext = {
      document,
      sources,
      videos: this.videos,
      textures: this.textures,
      ...(onTextureLoad === undefined ? {} : { onTextureLoad }),
    };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // Colour policy (B.1): working space linear, output transform explicit.
    // The adapter selects the transform, never the platform — the preview
    // surface is sRGB; broadcast output is a different adapter, not a flag here.
    this.renderer.outputColorSpace =
      PREVIEW_OUTPUT_COLOR_SPACE === "srgb" ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = makeOrthographicSceneCamera(space, sceneDepthRange(document));

    for (const object of document.objects) {
      const mesh = buildViewportObject(object, space, this.unsupported, context);
      if (mesh) {
        this.meshes.push(mesh);
        this.rendered.set(object.id, {
          mesh,
          type: object.type,
          width: object.width,
          height: object.height,
          depth: object.type === "mesh" ? object.depth : 0,
        });
        this.scene.add(mesh);
      }
    }

    // 11.6 needs the 3D objects to read as geometry, not black silhouettes.
    // Authored scene lights belong to 3.7; these two viewport-only lights make
    // shape and occlusion visible without pretending to reproduce Program.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x1b2430, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-700, 900, 1600);
    this.scene.add(key);
  }

  /// One frame. The viewport renders on demand (an edit, a scrub), not on a
  /// free-running ticker — the document is the clock's concern, not the
  /// viewport's.
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /// Update the already-allocated scene graph for one evaluated preview frame.
  ///
  /// Transform/opacity animation mutates Three objects in place. Geometry is
  /// rebuilt only when an authored width or height channel actually changes;
  /// recreating the renderer or every mesh on each animation callback would
  /// turn a 50 fps preview into allocator pressure rather than useful work.
  updateDocument(document: SceneDocument): string[] {
    const issues: string[] = [];
    const space = { width: document.canvas.width, height: document.canvas.height };
    const seen = new Set<string>();
    for (const object of document.objects) {
      const rendered = this.rendered.get(object.id);
      if (!rendered) continue;
      seen.add(object.id);
      if (rendered.type !== object.type) {
        issues.push(
          `${object.id}: preview object kind changed from ${rendered.type} to ${object.type}`,
        );
        continue;
      }
      const depth = object.type === "mesh" ? object.depth : 0;
      if (
        rendered.width !== object.width ||
        rendered.height !== object.height ||
        rendered.depth !== depth
      ) {
        const geometry = resizedViewportGeometry(object);
        if (geometry === undefined) {
          issues.push(`${object.id}: animated size cannot be represented by the viewport`);
        } else {
          rendered.mesh.geometry.dispose();
          rendered.mesh.geometry = geometry;
          rendered.width = object.width;
          rendered.height = object.height;
          rendered.depth = depth;
        }
      }
      applyViewportObjectState(rendered.mesh, object, space);
    }
    for (const [id, rendered] of this.rendered) {
      if (!seen.has(id)) {
        rendered.mesh.visible = false;
        issues.push(`${id}: evaluated preview no longer contains this rendered object`);
      }
    }
    return issues;
  }

  /// Put every moving texture at one instant of the preview.
  ///
  /// The material names the clip; the timeline says which frame of it is on
  /// screen (1.3). A paused element does not push new pixels on its own, so
  /// the texture is marked dirty once the seek lands.
  setPreviewTime(seconds: number): void {
    for (const video of this.videos) {
      if (!Number.isFinite(seconds) || video.element.readyState < 1) continue;
      const duration = video.element.duration;
      // A clip shorter than the scene repeats rather than holding its last
      // frame, matching the loop the element was created with.
      const at = Number.isFinite(duration) && duration > 0 ? seconds % duration : seconds;
      if (Math.abs(video.element.currentTime - at) < 1e-3) continue;
      video.element.currentTime = at;
      video.texture.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const video of this.videos) {
      video.element.pause();
      // Dropping the source releases the decoded bytes; a data URL left on a
      // detached element keeps the whole clip in memory for the session.
      video.element.removeAttribute("src");
      video.element.load();
      video.texture.dispose();
    }
    this.videos.length = 0;
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      const material = mesh.material;
      (Array.isArray(material) ? material : [material]).forEach((m) => m.dispose());
    }
    this.renderer.dispose();
  }
}

/// The geometry of a rectangle with the base box and an authored corner
/// radius. Pure geometry, so it is tested headless; the radius is clamped to
/// half the shorter side, which is the largest radius the box can hold.
///
/// A rounded rect is built as a shape rather than a plane because dropping the
/// radius would be a silent approximation of what the author asked for, and
/// the engine's rasteriser (3.5) will honour it.
export function rectGeometry(width: number, height: number, radius: number): THREE.BufferGeometry {
  if (radius <= 0) {
    return new THREE.PlaneGeometry(width, height);
  }
  return new THREE.ShapeGeometry(rectShape(width, height, radius), 8);
}

/// What the viewport could make of an authored paint.
///
/// A discriminated result rather than a `THREE.Color | null`, because the
/// three answers are genuinely different: nothing was authored, the author
/// turned the paint off, or this layer cannot reproduce what was authored.
/// Collapsing the third into "draw black" is the silent substitution
/// invariant 18 forbids, and collapsing it into "draw nothing" hides a
/// defect the operator needs to see.
export type PaintResolution =
  | { kind: "color"; color: THREE.Color }
  | { kind: "none" }
  | { kind: "unsupported"; reason: string };

/// Convert an authored paint (1.4) into something Three.js can draw.
///
/// The colour is handed to Three in the space it was tagged with and Three
/// converts it, rather than this file re-deriving the sRGB curve — a second
/// implementation of a transfer function is exactly the drift invariant 27
/// exists to stop, and the authoritative one is in `gx-contracts::color`.
export function resolvePaint(value: ColorValue | undefined): PaintResolution {
  if (value === undefined) {
    return { kind: "none" };
  }
  switch (value.type) {
    case "none":
      return { kind: "none" };
    case "solid": {
      const { r, g, b, space } = value.color;
      switch (space) {
        case "srgb":
          return {
            kind: "color",
            color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
          };
        case "linear":
          return {
            kind: "color",
            color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace),
          };
        case "rec709":
          // Rec.709 and sRGB share D65 primaries but not transfer curves.
          // Decode through the engine-matched broadcast curve, then hand the
          // resulting channels to Three in the linear working space.
          return {
            kind: "color",
            color: new THREE.Color().setRGB(
              rec709Decode(r),
              rec709Decode(g),
              rec709Decode(b),
              THREE.LinearSRGBColorSpace,
            ),
          };
        case "display-p3":
          // P3 shares sRGB's transfer curve but not its primaries. Decoding
          // alone and treating the channels as linear sRGB would be a silent
          // gamut substitution. Three r185 has no P3 colour-space transform,
          // so keep naming the unsupported case until 3.3 owns the matrix.
          return {
            kind: "unsupported",
            reason: "Display P3 needs the 3.3 primary conversion",
          };
      }
    }
    case "linear-gradient":
    case "radial-gradient":
      // A gradient needs a texture or a shader; this layer has neither.
      return { kind: "unsupported", reason: `${value.type} needs a texture the viewport cannot build` };
  }
  return { kind: "unsupported", reason: "unrecognised paint" };
}

/// Conservative Z extent of every authored surface.
///
/// A mesh uses half its scaled bounding-box diagonal, so rotating it cannot
/// push a corner beyond the camera's fitted near/far planes. Planar objects
/// sit exactly at zDepth. The range includes invisible objects because making
/// one visible must not require rebuilding the camera merely to unclip it.
export function sceneDepthRange(document: SceneDocument): SceneDepthRange {
  let min = 0;
  let max = 0;
  for (const object of document.objects) {
    const radius =
      object.type === "mesh"
        ? Math.hypot(
            object.width * object.scaleX,
            object.height * object.scaleY,
            object.depth * object.scaleZ,
          ) / 2
        : 0;
    min = Math.min(min, object.zDepth - radius);
    max = Math.max(max, object.zDepth + radius);
  }
  return { min, max };
}

/// Build one viewport object in scene coordinates.
///
/// Returns null for every kind this layer does not draw, and records every
/// visually unsupported case by name. Exporting the pure scene-assembly step
/// lets the depth contract run headlessly; only WebGL allocation remains in
/// `SceneViewport`.
export function buildViewportObject(
  object: SceneObject,
  space: { width: number; height: number },
  unsupported: string[],
  context?: PreviewContext,
): THREE.Mesh | null {
  const base = object;

  // An authored material, if this object binds one. Resolved before the
  // geometry because it decides whether an unfilled object is still drawn:
  // a rect with no `fill` but a material bound to its slot paints what the
  // material says, and returning null would lose it.
  const resolved = context
    ? resolveObjectMaterial(context.document, object)
    : ({ kind: "none" } as const);
  if (resolved.kind === "unsupported") {
    unsupported.push(`${object.id}: ${resolved.reason}`);
    return null;
  }
  const plan =
    resolved.kind === "material"
      ? planPreviewMaterial(resolved.material, base.opacity, context!.sources)
      : undefined;
  if (plan?.kind === "unsupported") {
    unsupported.push(`${object.id}: ${plan.reason}`);
    return null;
  }
  const planned = plan?.kind === "plan" ? plan : undefined;
  // The material's own paint. The object's `fill` is not it: a rect bound to a
  // shared brand material must show the brand colour, not whatever fill the
  // rect carried before it was assigned.
  const materialPaint = planned ? resolvePaint(planned.color) : undefined;
  if (materialPaint?.kind === "unsupported") {
    unsupported.push(`${object.id}: material colour — ${materialPaint.reason}`);
    return null;
  }
  // A material whose paint is off and which declares no texture paints
  // nothing. `none` is a value, not an absence (1.4), so this is the authored
  // answer rather than a failure — the same silence an unfilled rect gets.
  if (
    planned &&
    materialPaint?.kind === "none" &&
    planned.textures.length === 0 &&
    planned.missingTextures.length === 0
  ) {
    return null;
  }

  let mesh: THREE.Mesh;
  switch (object.type) {
    case "rect":
    case "ellipse": {
      const paint = resolvePaint(object.fill);
      if (paint.kind === "unsupported") {
        unsupported.push(`${object.id}: ${paint.reason}`);
        return null;
      }
      // No fill and no material is nothing to draw. No fill but a bound
      // material is a material-painted object, which is the normal case once
      // a library exists.
      if (paint.kind === "none" && planned === undefined) {
        return null;
      }
      const geometry =
        object.type === "rect"
          ? rectGeometry(object.width, object.height, object.radius)
          : // An ellipse is inscribed in the base box (1.2): the unit circle
            // scaled to its radii.
            new THREE.CircleGeometry(1, 64).scale(object.width / 2, object.height / 2, 1);
      const material = planned
        ? buildPlannedMaterial(
            planned,
            materialPaint ?? paint,
            object.width / Math.max(object.height, 1e-6),
            context!,
            unsupported,
            object.id,
          )
        : new THREE.MeshBasicMaterial({
            // `paint.kind` is "color" here: the only way to reach this arm
            // with no paint is to have a material, and that takes the branch
            // above.
            color: paint.kind === "color" ? paint.color : new THREE.Color(0xffffff),
            transparent: base.opacity < 1,
            opacity: base.opacity,
            depthTest: true,
            // Opaque planes participate fully in the depth buffer. Transparent
            // planes test against nearer geometry but do not hide surfaces that
            // still need to blend through them.
            depthWrite: base.opacity >= 1,
          });
      mesh = new THREE.Mesh(geometry, material);
      break;
    }
    case "image": {
      const geometry = new THREE.PlaneGeometry(object.width, object.height);
      const aspect = object.width / Math.max(object.height, 1e-6);
      // An image object addresses its own asset; a material bound to its slot
      // paints over that, which is how a video wall or a tinted still is
      // authored. Either way the bytes come from the same library.
      const imageTexture =
        planned === undefined ? imageObjectTexture(object, aspect, context) : undefined;
      if (imageTexture?.ok === false) {
        unsupported.push(`${object.id}: ${imageTexture.reason}`);
      }
      const material = planned
        ? buildPlannedMaterial(
            planned,
            materialPaint ?? { kind: "none" },
            aspect,
            context!,
            unsupported,
            object.id,
          )
        : new THREE.MeshBasicMaterial({
            // Still a grey plane when the bytes are not here: the size and
            // position are authored facts worth showing, and the missing
            // texture is reported rather than implied by the colour.
            ...(imageTexture?.ok ? { map: imageTexture.texture } : { color: 0x808080 }),
            transparent: base.opacity < 1,
            opacity: base.opacity,
            depthTest: true,
            depthWrite: base.opacity >= 1,
          });
      mesh = new THREE.Mesh(geometry, material);
      break;
    }
    case "text":
      // Shaped through cosmic-text on the engine (3.6), not drawn as a quad
      // here — the 2D-in-3D case below is a rect, the load-bearing one.
      return null;
    case "line":
    case "shape":
    case "paint":
      // Vector geometry goes through the path rasteriser (3.5); this layer
      // has no tessellator and will not fake one.
      return null;
    case "mesh": {
      // 3D primitives are real geometry here. An imported glTF model is the
      // asset pipeline's (3.7), so it is named rather than faked with a box.
      const primitive = resolveMeshGeometry(object);
      if (primitive.kind === "unsupported") {
        unsupported.push(`${object.id}: ${primitive.reason}`);
        return null;
      }
      const paint = resolvePaint(object.fill);
      if (paint.kind === "unsupported") {
        unsupported.push(`${object.id}: ${paint.reason}`);
        return null;
      }
      const material = planned
        ? buildPlannedMaterial(
            planned,
            materialPaint ?? paint,
            object.width / Math.max(object.height, 1e-6),
            context!,
            unsupported,
            object.id,
          )
        : new THREE.MeshStandardMaterial({
            color: paint.kind === "color" ? paint.color : new THREE.Color(0x9aa4ae),
            transparent: base.opacity < 1,
            opacity: base.opacity,
            depthTest: true,
            depthWrite: base.opacity >= 1,
            flatShading: true,
          });
      mesh = new THREE.Mesh(primitive.geometry, material);
      break;
    }
    case "light":
    case "camera":
      // A light or camera has no appearance of its own; its effect arrives
      // with 3.7's scene assembly. Drawing an icon here would be the engine
      // preview pretending to be a level editor.
      return null;
    case "layer":
    case "group":
      // Containers paint nothing. `resolveHierarchy` (1.2) is where their
      // transform reaches the objects that do.
      return null;
    case "marker":
      // A timeline marker emits an event; it has no appearance.
      return null;
  }

  if (planned) {
    // The per-frame update multiplies the object's animated opacity back onto
    // the material's own, and must not overwrite the transparency and depth
    // decisions the plan made. Without this, an authored `depth: read` surface
    // would silently become depth-writing the first time the playhead moved.
    mesh.userData.materialPlan = {
      opacity: planned.opacity / Math.max(object.opacity, 1e-6),
      transparent: planned.transparent,
      depthWrite: planned.depthWrite,
    };
  }
  applyViewportObjectState(mesh, object, space);
  return mesh;
}

function applyViewportObjectState(
  mesh: THREE.Mesh,
  object: SceneObject,
  space: { width: number; height: number },
): void {
  // zDepth is real geometry. zIndex remains a render-order hint, so a large
  // 2D index can never move a plane through a 3D surface.
  const position = scenePosition(space, object.x, object.y, object.zDepth);
  mesh.position.set(position.x, position.y, position.z);
  mesh.renderOrder = object.zIndex;
  mesh.rotation.z = (object.rotation * Math.PI) / 180;
  // Meshes are the only objects whose X/Y rotations compose. The two fields
  // still exist on every base, so non-meshes explicitly remain in-plane.
  mesh.rotation.x = object.type === "mesh" ? (object.rotationX * Math.PI) / 180 : 0;
  mesh.rotation.y = object.type === "mesh" ? (object.rotationY * Math.PI) / 180 : 0;
  mesh.scale.set(object.scaleX, object.scaleY, object.scaleZ);
  mesh.visible = object.visible;

  const plan = mesh.userData.materialPlan as
    | { opacity: number; transparent: boolean; depthWrite: boolean }
    | undefined;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    // An authored material decides transparency and depth; the object's
    // opacity only scales it. Without a material, the object's own opacity is
    // the whole story and the old rules apply.
    const nextTransparent = plan ? plan.transparent || object.opacity < 1 : object.opacity < 1;
    if (material.transparent !== nextTransparent) {
      material.transparent = nextTransparent;
      material.needsUpdate = true;
    }
    material.opacity = plan ? plan.opacity * object.opacity : object.opacity;
    material.depthWrite = plan ? plan.depthWrite : object.opacity >= 1;
  }
}

function resizedViewportGeometry(object: SceneObject): THREE.BufferGeometry | undefined {
  switch (object.type) {
    case "rect":
      return rectGeometry(object.width, object.height, object.radius);
    case "ellipse":
      return new THREE.CircleGeometry(1, 64).scale(object.width / 2, object.height / 2, 1);
    case "image":
      return new THREE.PlaneGeometry(object.width, object.height);
    case "mesh": {
      const resolved = resolveMeshGeometry(object);
      return resolved.kind === "geometry" ? resolved.geometry : undefined;
    }
    default:
      return undefined;
  }
}

/// Result of resolving authored mesh geometry.
///
/// Slabs and imported models carry information this thin viewport cannot yet
/// reproduce. Returning a named refusal instead of a plausible box preserves
/// invariant 18.
export type MeshGeometryResolution =
  | { kind: "geometry"; geometry: THREE.BufferGeometry }
  | { kind: "unsupported"; reason: string };

export function resolveMeshGeometry(
  object: Extract<SceneObject, { type: "mesh" }>,
): MeshGeometryResolution {
  const w = object.width;
  const h = object.height;
  const d = object.depth;
  switch (object.meshKind) {
    case "cube":
      return { kind: "geometry", geometry: new THREE.BoxGeometry(w, h, d) };
    case "sphere":
      return {
        kind: "geometry",
        geometry: new THREE.SphereGeometry(0.5, 48, 32).scale(w, h, d),
      };
    case "cylinder":
      return {
        kind: "geometry",
        geometry: new THREE.CylinderGeometry(0.5, 0.5, 1, 48).scale(w, h, d),
      };
    case "torus":
      return {
        kind: "geometry",
        geometry: new THREE.TorusGeometry(0.35, 0.15, 20, 64).scale(w, h, d / 0.3),
      };
    case "slab":
      return {
        kind: "unsupported",
        reason: "slab bevel, skew and culling need the 3.7 scene assembler",
      };
    case "model":
      return {
        kind: "unsupported",
        reason: "model assets load through 3.7, not this layer",
      };
  }
}

/// The 2D outline of a rounded rect. Kept separate from triangulation so a
/// future exact slab extrusion can reuse the authored outline.
function rectShape(width: number, height: number, radius: number): THREE.Shape {
  const r = Math.min(radius, width / 2, height / 2);
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.absarc(x + width - r, y + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(x + width, y + height - r);
  shape.absarc(x + width - r, y + height - r, r, 0, Math.PI / 2, false);
  shape.lineTo(x + r, y + height);
  shape.absarc(x + r, y + height - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + r);
  shape.absarc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2, false);
  return shape;
}

// ---------------------------------------------------------------------------
// Authored materials in the preview (11.12).
//
// The decisions are in `material-preview.ts`, which is pure and tested
// headless. What is left here is the part that needs a GL context and a DOM:
// allocating textures, and holding the video elements a moving texture reads.
// ---------------------------------------------------------------------------

/// A video texture and the element behind it, kept so the playhead can drive
/// it and so both can be released on dispose.
interface PreviewVideo {
  readonly element: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
}

/// Three's blending for a mode the preview can composite.
///
/// Only the modes `FIXED_FUNCTION_BLEND_MODES` names reach here — the plan
/// refuses the rest by name — so there is no "nearest match" branch. That
/// absence is the point: a default arm is where `overlay` became `screen`.
function applyBlending(material: THREE.Material, mode: BlendMode): void {
  switch (mode) {
    case "normal":
      material.blending = THREE.NormalBlending;
      return;
    case "add":
      material.blending = THREE.AdditiveBlending;
      return;
    case "multiply":
      material.blending = THREE.MultiplyBlending;
      return;
    case "screen":
      // src + dst·(1 − src): the screen formula written as a factor pair.
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.AddEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneMinusSrcColorFactor;
      return;
    case "darken":
    case "lighten":
      // min/max are blend *equations*, not factor pairs; the factors are
      // ignored by the hardware for these two.
      material.blending = THREE.CustomBlending;
      material.blendEquation = mode === "darken" ? THREE.MinEquation : THREE.MaxEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneFactor;
      return;
    default:
      // Unreachable: `planPreviewMaterial` refuses every other mode before a
      // plan exists. Throwing rather than picking one keeps it that way.
      throw new Error(`blend mode ${mode} reached the preview without a plan`);
  }
}

function sideOf(side: PreviewSide): THREE.Side {
  switch (side) {
    case "front":
      return THREE.FrontSide;
    case "back":
      return THREE.BackSide;
    case "double":
      return THREE.DoubleSide;
  }
}

/// The Three colour space for an authored source space, or a named refusal.
///
/// The same two gaps `resolvePaint` names, for the same reason: Rec.709 and
/// P3 are not sRGB, and handing their channels to Three as if they were is a
/// silent substitution rather than a colour conversion.
function textureColorSpace(
  space: SourceColorSpace,
): { ok: true; value: string } | { ok: false; reason: string } {
  switch (space) {
    case "srgb":
      return { ok: true, value: THREE.SRGBColorSpace };
    case "linear":
      return { ok: true, value: THREE.LinearSRGBColorSpace };
    case "rec709":
      return { ok: false, reason: "a Rec.709 texture needs the engine's decode, not Three's" };
    case "display-p3":
      return { ok: false, reason: "Display P3 needs the 3.3 primary conversion" };
  }
}

function wrapOf(wrap: MaterialTextureSlot["wrap"]): THREE.Wrapping {
  switch (wrap) {
    case "clamp":
      return THREE.ClampToEdgeWrapping;
    case "repeat":
      return THREE.RepeatWrapping;
    case "mirror-repeat":
      return THREE.MirroredRepeatWrapping;
  }
}

/// The UV transform for a fit mode, given the texture and the box it fills.
///
/// Only the modes the contract calls plain UV transforms are handled; the plan
/// carries the rest to the caller, which names them. `tile` is the wrap mode's
/// job and needs no transform of its own.
function applyFit(texture: THREE.Texture, fit: MaterialTextureSlot["fit"], aspect: number): void {
  // The decoded picture's own aspect, once it has decoded. Before that the
  // box's aspect is used, which makes the first frame a stretch rather than a
  // wrongly cropped picture; `onTextureLoad` redraws with the real ratio.
  const image = texture.image as { width?: number; height?: number } | undefined;
  const ratio =
    image?.width && image?.height ? image.width / image.height : aspect;
  const scale = ratio / aspect;
  switch (fit) {
    case "stretch":
    case "original":
    case "tile":
      return;
    case "contain":
      // Fit inside: shrink the sampled region on the long axis so the whole
      // picture lands in the box, letterboxing the rest.
      if (scale > 1) {
        texture.repeat.set(1, scale);
        texture.offset.set(0, (1 - scale) / 2);
      } else {
        texture.repeat.set(1 / scale, 1);
        texture.offset.set((1 - 1 / scale) / 2, 0);
      }
      return;
    case "cover":
    case "crop":
      if (scale > 1) {
        texture.repeat.set(1 / scale, 1);
        texture.offset.set((1 - 1 / scale) / 2, 0);
      } else {
        texture.repeat.set(1, scale);
        texture.offset.set(0, (1 - scale) / 2);
      }
      return;
    default:
      return;
  }
}

/// What the preview needs in order to draw authored materials.
///
/// Optional throughout: the viewport still draws a scene whose objects carry
/// no material binding, which is what every scene did before 11.12 and what
/// the depth tests below still exercise.
export interface PreviewContext {
  readonly document: SceneDocument;
  readonly sources: AssetSources;
  /// Called once a texture's bytes have decoded. A data URL still decodes
  /// asynchronously, so without this the first frame draws untextured and
  /// nothing ever asks for a second one.
  readonly onTextureLoad?: () => void;
  /// Collects the video elements a moving texture reads, so the playhead can
  /// drive them and dispose can release them.
  readonly videos: PreviewVideo[];
  /// Textures allocated here, for disposal.
  readonly textures: THREE.Texture[];
}

/// Build one texture from an asset's bytes.
///
/// Returns the named reason instead of a texture when the authored colour
/// space is one this layer cannot convert — the same refusal `resolvePaint`
/// makes, because a texture handed to Three in the wrong space is the same
/// silent substitution as a colour handed over in the wrong space.
function buildTexture(
  texture: PreviewTexture,
  aspect: number,
  context: PreviewContext,
): { ok: true; texture: THREE.Texture } | { ok: false; reason: string } {
  const space = textureColorSpace(texture.colorSpace);
  if (!space.ok) return { ok: false, reason: `${texture.slot}: ${space.reason}` };

  let built: THREE.Texture;
  if (texture.moving) {
    // A moving texture is an element the browser decodes, not bytes this
    // layer parses. It starts paused at its first frame: which frame is
    // shown is the timeline's decision, never the material's (1.3), and
    // `setPreviewTime` is how the playhead states it.
    const element = window.document.createElement("video");
    element.src = texture.source.dataUrl;
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    element.preload = "auto";
    const video = new THREE.VideoTexture(element);
    context.videos.push({ element, texture: video });
    element.addEventListener("loadeddata", () => {
      video.needsUpdate = true;
      context.onTextureLoad?.();
    });
    built = video;
  } else {
    built = new THREE.TextureLoader().load(texture.source.dataUrl, () => {
      context.onTextureLoad?.();
    });
  }

  built.colorSpace = space.value;
  built.wrapS = wrapOf(texture.wrap);
  built.wrapT = wrapOf(texture.wrap);
  const filtering =
    texture.filtering === "nearest" ? THREE.NearestFilter : THREE.LinearFilter;
  built.magFilter = filtering;
  built.minFilter = filtering;
  // `tile` is the wrap mode's job, and clamping a tiled texture would show one
  // copy with stretched edges rather than the repeat the author asked for.
  if (texture.fit === "tile" && texture.wrap === "clamp") {
    built.wrapS = THREE.RepeatWrapping;
    built.wrapT = THREE.RepeatWrapping;
  }
  applyFit(built, texture.fit, aspect);
  context.textures.push(built);
  return { ok: true, texture: built };
}

/// The texture an `image` object addresses directly.
///
/// An image object names its asset itself rather than through a material, so
/// it gets the same bytes by the same route. Its authored `fit` is the one
/// the material texture slot carries; the source space is the library's,
/// which for a still is the space the import tagged.
function imageObjectTexture(
  object: Extract<SceneObject, { type: "image" }>,
  aspect: number,
  context: PreviewContext | undefined,
): { ok: true; texture: THREE.Texture } | { ok: false; reason: string } | undefined {
  if (!context) return undefined;
  const source = context.sources.get(object.assetId);
  if (!source) return undefined;
  return buildTexture(
    {
      slot: "baseColor",
      source,
      fit: object.fit,
      wrap: "clamp",
      filtering: "linear",
      // An image asset carries no per-object space tag; the preview surface
      // is sRGB (B.1) and that is what the import records for a still.
      colorSpace: "srgb",
      moving: source.mediaType.startsWith("video/"),
    },
    aspect,
    context,
  );
}

/// Turn a plan into the Three material that draws it.
function buildPlannedMaterial(
  plan: PreviewMaterialPlan,
  paint: PaintResolution,
  aspect: number,
  context: PreviewContext,
  unsupported: string[],
  objectId: string,
): THREE.Material {
  const color = paint.kind === "color" ? paint.color : new THREE.Color(0xffffff);
  const maps: Partial<Record<string, THREE.Texture>> = {};
  for (const texture of plan.textures) {
    const built = buildTexture(texture, aspect, context);
    if (!built.ok) {
      unsupported.push(`${objectId}: ${built.reason}`);
      continue;
    }
    maps[texture.slot] = built.texture;
  }
  for (const missing of plan.missingTextures) {
    // The bytes never arrived. Said out loud, because a flat colour where a
    // logo should be looks exactly like a material with no texture.
    unsupported.push(`${objectId}: texture ${missing} has no bytes in the asset library`);
  }

  const shared = {
    color,
    transparent: plan.transparent,
    opacity: plan.opacity,
    depthTest: plan.depthTest,
    depthWrite: plan.depthWrite,
    side: sideOf(plan.side),
    premultipliedAlpha: plan.premultipliedAlpha,
    ...(plan.alphaTest === undefined ? {} : { alphaTest: plan.alphaTest }),
    ...(maps.baseColor ? { map: maps.baseColor } : {}),
  };

  const material = plan.lit
    ? new THREE.MeshStandardMaterial({
        ...shared,
        metalness: plan.lighting?.metallic ?? 0,
        roughness: plan.lighting?.roughness ?? 0.5,
        emissiveIntensity: plan.lighting?.emissiveIntensity ?? 1,
        ...(maps.normal ? { normalMap: maps.normal } : {}),
        ...(maps.roughness ? { roughnessMap: maps.roughness } : {}),
        ...(maps.metallic ? { metalnessMap: maps.metallic } : {}),
        ...(maps.emissive ? { emissiveMap: maps.emissive } : {}),
        ...(maps.occlusion ? { aoMap: maps.occlusion } : {}),
      })
    : new THREE.MeshBasicMaterial(shared);
  applyBlending(material, plan.blending);
  return material;
}
