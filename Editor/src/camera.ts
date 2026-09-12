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
/// Inclusive depth extent of the scene graph, in scene units.
///
/// The viewport derives this from every object's authored geometry before it
/// creates the camera. Fitting the near/far planes to the document prevents a
/// valid deep object from disappearing behind a hard-coded clipping plane.
export interface SceneDepthRange {
  readonly min: number;
  readonly max: number;
}


/// An orthographic camera fitted to the scene and its authored depth.
///
/// The XY frustum is exactly the scene's extent at zoom 1, so a scene unit
/// maps to one canvas pixel before DPI. The camera sits beyond the nearest
/// authored surface and looks down -Z through the full depth range. Keeping
/// the view transform explicit matters: applying only the projection matrix
/// can make an object behind the camera appear to be inside the clip volume.
export function makeOrthographicSceneCamera(
  scene: SceneSpace,
  depth: SceneDepthRange = { min: 0, max: 0 },
): THREE.OrthographicCamera {
  const halfW = scene.width / 2;
  const halfH = scene.height / 2;
  const minDepth = Math.min(depth.min, depth.max);
  const maxDepth = Math.max(depth.min, depth.max);
  const margin = Math.max(1, scene.width, scene.height);
  const cameraZ = maxDepth + margin;
  const near = 0.1;
  const far = cameraZ - minDepth + margin;

  const camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, near, far);
  camera.position.set(0, 0, cameraZ);
  camera.lookAt(0, 0, (minDepth + maxDepth) / 2);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
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

/// Scene-coordinate position for an object. The document stores X/Y in scene
/// units with a top-left authoring origin; Three uses a centred, Y-up space.
/// `zDepth` remains the actual view-axis coordinate.
///
/// Draw order is intentionally absent. `zIndex` belongs on
/// `Object3D.renderOrder`; adding it to Z would let a 2D ordering hint move an
/// object through real 3D geometry.
export function scenePosition(
  scene: SceneSpace,
  x: number,
  y: number,
  zDepth = 0,
): { x: number; y: number; z: number } {
  return {
    x: x - scene.width / 2,
    y: scene.height / 2 - y,
    z: zDepth,
  };
}
