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
import { makeOrthographicSceneCamera, scenePosition } from "./camera";

/// A viewport over one scene. Owns the renderer, the camera and the meshes
/// built from the document. Dispose with `dispose()`.
export class SceneViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  private readonly meshes: THREE.Mesh[] = [];
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
    this.camera = makeOrthographicSceneCamera(space);

    for (const object of document.objects) {
      const mesh = meshForObject(object, space, this.unsupported);
      if (mesh) {
        this.meshes.push(mesh);
        this.scene.add(mesh);
      }
    }
  }

  /// One frame. The viewport renders on demand (an edit, a scrub), not on a
  /// free-running ticker — the document is the clock's concern, not the
  /// viewport's.
  render(): void {
    this.renderer.render(this.scene, this.camera);
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
  return new THREE.ShapeGeometry(shape, 8);
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
          return { kind: "color", color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace) };
        case "linear":
          return {
            kind: "color",
            color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace),
          };
        case "display-p3":
        case "rec709":
          // Three's colour management has no transform for these, and
          // drawing them as sRGB would be visibly wrong in the saturated
          // colours a broadcast graphic is made of.
          return { kind: "unsupported", reason: `colour space ${space} is not converted here` };
      }
      break;
    }
    case "linear-gradient":
    case "radial-gradient":
      // A gradient needs a texture or a shader; this layer has neither.
      return { kind: "unsupported", reason: `${value.type} needs a texture the viewport cannot build` };
  }
  return { kind: "unsupported", reason: "unrecognised paint" };
}

/// Build a mesh for one scene object, in scene coordinates.
///
/// Returns null for every kind this layer does not draw, and for an object
/// whose paint it cannot reproduce — each case says why, because the switch
/// is exhaustive over the object union: adding a fourteenth kind (1.2) stops
/// this file compiling rather than silently skipping the object
/// (invariant 18). `unsupported` collects the reasons so the shell can show
/// them rather than leaving a hole in the picture unexplained.
function meshForObject(
  object: SceneObject,
  space: { width: number; height: number },
  unsupported: string[],
): THREE.Mesh | null {
  const base = object;
  const pos = scenePosition(space, base.x, base.y, 0);

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
      });
      mesh = new THREE.Mesh(geometry, material);
      break;
    }
    case "image": {
      // Texture resolution is the asset pipeline's concern; the viewport
      // shows a placeholder plane the size the author gave it until the
      // texture arrives.
      const geometry = new THREE.PlaneGeometry(object.width, object.height);
      const material = new THREE.MeshBasicMaterial({ color: 0x808080 });
      mesh = new THREE.Mesh(geometry, material);
      break;
    }
    case "text":
      // Shaped through cosmic-text on the engine (3.6), not drawn as a quad
      // here — 11.6's 2D-beside-3D case covers it.
      return null;
    case "line":
    case "shape":
    case "paint":
      // Vector geometry goes through the path rasteriser (3.5); this layer
      // has no tessellator and will not fake one.
      return null;
    case "mesh":
    case "light":
    case "camera":
      // 3D scene assembly, glTF loading and lighting are 3.7 and the shell's
      // viewport proper; the foundation is 2D only.
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

  mesh.position.set(pos.x, pos.y, pos.z);
  mesh.rotation.z = (base.rotation * Math.PI) / 180;
  mesh.scale.set(base.scaleX, base.scaleY, 1);
  mesh.visible = base.visible;
  return mesh;
}
