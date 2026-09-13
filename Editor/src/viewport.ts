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

import type { ColorValue, SceneDocument, SceneObject } from "@grapix/contracts";
import { PREVIEW_OUTPUT_COLOR_SPACE } from "./color-policy";
import { makeOrthographicSceneCamera, scenePosition, type SceneDepthRange } from "./camera";
import { rec709Decode } from "./color-transfer";

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

  constructor(canvas: HTMLCanvasElement, document: SceneDocument) {
    const space = { width: document.canvas.width, height: document.canvas.height };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // Colour policy (B.1): working space linear, output transform explicit.
    // The adapter selects the transform, never the platform — the preview
    // surface is sRGB; broadcast output is a different adapter, not a flag here.
    this.renderer.outputColorSpace =
      PREVIEW_OUTPUT_COLOR_SPACE === "srgb" ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = makeOrthographicSceneCamera(space, sceneDepthRange(document));

    for (const object of document.objects) {
      const mesh = buildViewportObject(object, space, this.unsupported);
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

  dispose(): void {
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
): THREE.Mesh | null {
  const base = object;

  let mesh: THREE.Mesh;
  switch (object.type) {
    case "rect":
    case "ellipse": {
      const paint = resolvePaint(object.fill);
      if (paint.kind === "unsupported") {
        unsupported.push(`${object.id}: ${paint.reason}`);
        return null;
      }
      if (paint.kind === "none") {
        return null;
      }
      const geometry =
        object.type === "rect"
          ? rectGeometry(object.width, object.height, object.radius)
          : // An ellipse is inscribed in the base box (1.2): the unit circle
            // scaled to its radii.
            new THREE.CircleGeometry(1, 64).scale(object.width / 2, object.height / 2, 1);
      const material = new THREE.MeshBasicMaterial({
        color: paint.color,
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
      // Texture resolution is the asset pipeline's concern; the viewport
      // shows a placeholder plane the size the author gave it until the
      // texture arrives.
      const geometry = new THREE.PlaneGeometry(object.width, object.height);
      const material = new THREE.MeshBasicMaterial({ color: 0x808080, depthTest: true, depthWrite: true });
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
      const material = new THREE.MeshStandardMaterial({
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

  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    const nextTransparent = object.opacity < 1;
    if (material.transparent !== nextTransparent) {
      material.transparent = nextTransparent;
      material.needsUpdate = true;
    }
    material.opacity = object.opacity;
    material.depthWrite = object.opacity >= 1;
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
