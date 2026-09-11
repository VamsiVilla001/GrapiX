//! The Editor viewport camera (build plan 11.6; ADR-0002 B.2).
//!
//! The one rule that prevents most bugs: **the scene document is in scene
//! coordinates; DPI affects display only, never the document.** A 1920×1080
//! scene is 1920×1080 whatever monitor it is on.
//!
//! The 2D authoring view is an orthographic camera over the scene's own
//! coordinate space: one scene unit is one canvas pixel at zoom 1, origin at
//! the canvas centre (the graphics convention), Y up. The camera's projection
//! is rebuilt whenever the canvas backing-store size or the device pixel
//! ratio changes — B.2's "recompute on ScaleFactorChanged, don't cache at
//! startup."

import * as THREE from "three";

/// The scene's own coordinate space, from the document canvas. The camera is
/// built against this, never against the display's pixel size.
export interface SceneSpace {
  readonly width: number;
  readonly height: number;
}

/// An orthographic camera fitted to the scene, for the 2D authoring view.
///
/// The frustum is exactly the scene's extent at zoom 1, so a scene unit maps
/// to one canvas pixel before DPI. The canvas CSS size and `devicePixelRatio`
/// size the *renderer*, not the camera — that is what keeps the document in
/// scene coordinates while the display scales.
export function makeOrthographicSceneCamera(scene: SceneSpace): THREE.OrthographicCamera {
  const halfW = scene.width / 2;
  const halfH = scene.height / 2;
  // Left/right/bottom/top are scene coordinates; origin centred, Y up.
  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -1000, 1000);
  camera.position.z = 1;
  return camera;
}

/// The backing-store size for a canvas, from its CSS size and the current
/// device pixel ratio. Recomputed on every scale-factor change and monitor
/// move (B.2): the returned value feeds `renderer.setSize` / `setPixelRatio`,
/// never the camera, and never the document.
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { width: number; height: number } {
  return {
    width: Math.round(cssWidth * devicePixelRatio),
    height: Math.round(cssHeight * devicePixelRatio),
  };
}

/// Scene-coordinate position for an object. The document stores the
/// translate in scene units with a top-left authoring origin (the editor's
/// convention); the camera's space is centred with Y up. This is the single
/// conversion between the two, so it lives in one function.
export function scenePosition(
  scene: SceneSpace,
  x: number,
  y: number,
  zIndex: number,
): { x: number; y: number; z: number } {
  return {
    x: x - scene.width / 2,
    y: scene.height / 2 - y,
    z: zIndex,
  };
}
