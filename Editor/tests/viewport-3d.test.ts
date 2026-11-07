// A 2D object renders between two 3D objects (11.6's done-when).
//
// These headless assertions pin the scene assembly and depth-buffer contract.
// The real WebGL smoke below the unit gate exercises the resulting pixels.

import { describe, expect, it } from "vitest";
import * as THREE from "three";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { makeOrthographicSceneCamera, scenePosition } from "../src/camera";
import {
  buildViewportObject,
  resolveMeshGeometry,
  sceneDepthRange,
} from "../src/viewport";

const HD = { width: 1920, height: 1080 };
type MeshObject = Extract<SceneObject, { type: "mesh" }>;

function base(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    x: 960,
    y: 540,
    zDepth: 0,
    zIndex: 0,
    layerId: "",
    width: 400,
    height: 200,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
  };
}

const fill = {
  type: "solid",
  color: { r: 0.5, g: 0.5, b: 0.5, a: 1, space: "srgb" },
};

function mesh3d(id: string, zDepth: number, meshKind: MeshObject["meshKind"] = "cube"): MeshObject {
  return {
    type: "mesh",
    meshKind,
    depth: 40,
    animationLoop: false,
    ...base(id),
    zDepth,
    fill,
  } as unknown as MeshObject;
}

function rect2d(id: string, zDepth: number, zIndex = 0): SceneObject {
  return {
    type: "rect",
    radius: 0,
    ...base(id),
    zDepth,
    zIndex,
    fill,
  } as unknown as SceneObject;
}

function documentWith(objects: SceneObject[]): SceneDocument {
  return {
    id: "sandwich",
    name: "2D between two 3D",
    canvas: { ...HD, frameRate: { num: 50, den: 1 } },
    objects,
  } as unknown as SceneDocument;
}

function mustBuild(object: SceneObject): THREE.Mesh {
  const unsupported: string[] = [];
  const built = buildViewportObject(object, HD, unsupported);
  expect(unsupported).toEqual([]);
  expect(built).not.toBeNull();
  return built!;
}

describe("layer blend modes (3.20)", () => {
  it("names a non-normal blend mode instead of drawing it as normal", () => {
    const unsupported: string[] = [];
    const overlay = { ...rect2d("plate", 0), blendMode: "overlay" } as unknown as SceneObject;
    expect(buildViewportObject(overlay, HD, unsupported)).toBeNull();
    expect(unsupported).toEqual(["plate: blend mode overlay awaits the engine-rendered viewport (13.5)"]);
    // Normal, explicit or omitted, still draws.
    mustBuild({ ...rect2d("normal", 0), blendMode: "normal" } as unknown as SceneObject);
    mustBuild(rect2d("omitted", 0));
  });

  it("names an effect stack instead of drawing the layer without it (3.22)", () => {
    const unsupported: string[] = [];
    const graded = { ...rect2d("plate", 0), effects: [{ effectId: "g", enabled: true, effect: "levels" }] } as unknown as SceneObject;
    expect(buildViewportObject(graded, HD, unsupported)).toBeNull();
    expect(unsupported).toEqual(["plate: effects (levels) await the engine-rendered viewport (13.5)"]);
    mustBuild({ ...rect2d("bare", 0), effects: [] } as unknown as SceneObject);
  });
});

describe("2D and 3D share one depth-tested scene", () => {
  it("places the plane between the two meshes on the view axis", () => {
    const back = mustBuild(mesh3d("back", -100));
    const middle = mustBuild(rect2d("middle", 0));
    const front = mustBuild(mesh3d("front", 100));

    expect(back.position.z).toBeLessThan(middle.position.z);
    expect(middle.position.z).toBeLessThan(front.position.z);

    const middleMaterial = middle.material as THREE.MeshBasicMaterial;
    expect(middleMaterial.depthTest).toBe(true);
    expect(middleMaterial.depthWrite).toBe(true);
  });

  it("keeps zIndex as draw order without moving a plane through geometry", () => {
    const low = mustBuild(rect2d("low", 0, -100_000));
    const high = mustBuild(rect2d("high", 0, 100_000));
    expect(low.position.z).toBe(0);
    expect(high.position.z).toBe(0);
    expect(low.renderOrder).toBe(-100_000);
    expect(high.renderOrder).toBe(100_000);
  });

  it("fits the real camera view around all three surfaces", () => {
    const objects = [mesh3d("back", -100), rect2d("middle", 0), mesh3d("front", 100)];
    const range = sceneDepthRange(documentWith(objects));
    const camera = makeOrthographicSceneCamera(HD, range);

    const inFrustum = (z: number): boolean => {
      const clip = new THREE.Vector3(0, 0, z)
        .applyMatrix4(camera.matrixWorldInverse)
        .applyMatrix4(camera.projectionMatrix);
      return clip.z >= -1 && clip.z <= 1;
    };

    expect(camera.position.z).toBeGreaterThan(range.max);
    expect(inFrustum(range.min)).toBe(true);
    expect(inFrustum(0)).toBe(true);
    expect(inFrustum(range.max)).toBe(true);
  });

  it("builds real volume for the primitive meshes", () => {
    const geometry = resolveMeshGeometry(mesh3d("sphere", 0, "sphere"));
    expect(geometry.kind).toBe("geometry");
    if (geometry.kind !== "geometry") return;
    geometry.geometry.computeBoundingBox();
    const size = geometry.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(400, 4);
    expect(size.y).toBeCloseTo(200, 4);
    expect(size.z).toBeCloseTo(40, 4);
    geometry.geometry.dispose();
  });

  it("names geometry it cannot reproduce instead of drawing a plausible box", () => {
    const slab = resolveMeshGeometry(mesh3d("slab", 0, "slab"));
    const model = resolveMeshGeometry(mesh3d("model", 0, "model"));
    expect(slab).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("slab") });
    expect(model).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("model") });
  });

  it("scenePosition carries depth unchanged", () => {
    expect(scenePosition(HD, 960, 540, -100).z).toBe(-100);
    expect(scenePosition(HD, 960, 540, 100).z).toBe(100);
  });
});
