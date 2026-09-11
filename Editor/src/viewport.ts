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

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { PREVIEW_OUTPUT_COLOR_SPACE } from "./color-policy";
import { makeOrthographicSceneCamera, scenePosition } from "./camera";

/// A viewport over one scene. Owns the renderer, the camera and the meshes
/// built from the document. Dispose with `dispose()`.
export class SceneViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  private readonly meshes: THREE.Mesh[] = [];

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
      const mesh = meshForObject(object, space);
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

/// Build a mesh for one scene object, in scene coordinates. Returns null for
/// a group — a container paints no pixels; the hierarchy resolver (1.2) is
/// where children inherit its transform.
function meshForObject(object: SceneObject, space: { width: number; height: number }): THREE.Mesh | null {
  const base = object;
  const pos = scenePosition(space, base.x, base.y, 0);

  let mesh: THREE.Mesh;
  switch (object.type) {
    case "rect": {
      const geometry = new THREE.PlaneGeometry(object.width, object.height);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(object.fill ?? "#000000"),
        transparent: base.opacity < 1,
        opacity: base.opacity,
      });
      mesh = new THREE.Mesh(geometry, material);
      break;
    }
    case "ellipse": {
      const geometry = new THREE.CircleGeometry(1, 64);
      geometry.scale(object.radiusX, object.radiusY, 1);
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(object.fill ?? "#000000"),
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
      const geometry = new THREE.PlaneGeometry(object.width ?? 1, object.height ?? 1);
      const material = new THREE.MeshBasicMaterial({ color: 0x808080 });
      mesh = new THREE.Mesh(geometry, material);
      break;
    }
    case "text":
    case "group":
      // Text renders through the shaped-text path (cosmic-text on the engine;
      // a canvas texture here), not a quad — 11.6's 2D-beside-3D case covers
      // it. Groups paint nothing.
      return null;
  }

  mesh.position.set(pos.x, pos.y, pos.z);
  mesh.rotation.z = (base.rotation * Math.PI) / 180;
  mesh.scale.set(base.scaleX, base.scaleY, 1);
  mesh.visible = base.visible;
  return mesh;
}
