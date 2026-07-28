import {
  normalizeSlabProperties,
  type MeshSceneObject
} from "@grapix/shared-types";
import * as THREE from "three";

export const SLAB_MATERIAL_INDEX = {
  face: 0,
  bevel: 1,
  extrusion: 2,
  backBevel: 3,
  backFace: 4
} as const;

interface ProfilePoint {
  x: number;
  y: number;
  rawX: number;
  rawY: number;
}

interface Vertex {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
}

interface GeometryBucket {
  positions: number[];
  uvs: number[];
}

/**
 * Builds the five independently materialled regions used by an XPression slab:
 * face, front bevel, extrusion, back bevel and back face.
 */
export function createSlabGeometry(object: MeshSceneObject): THREE.BufferGeometry {
  const slab = normalizeSlabProperties(object.slab);
  const width = Math.max(1, finite(object.width, 1));
  const height = Math.max(1, finite(object.height, 1));
  const extrusion = Math.max(0.01, finite(object.depth, 0.01));
  const radius = clamp(finite(slab.cornerRadius, 0), 0, Math.min(width, height) / 2);
  const cornerSegments = Math.round(clamp(finite(slab.cornerSegments, 6), 1, 32));
  const skew = clamp(finite(slab.skew, 0), -width * 2, width * 2);
  const rounded = radius > 0.0001;
  const outer = createProfile(width, height, radius, cornerSegments, skew, 0, rounded);

  const frontSize = slab.frontBevel.enabled
    ? clamp(finite(slab.frontBevel.size, 0), 0, Math.min(width, height) / 2 - 0.001)
    : 0;
  const backSize = slab.backBevel.enabled
    ? clamp(finite(slab.backBevel.size, 0), 0, Math.min(width, height) / 2 - 0.001)
    : 0;
  const requestedFrontDepth = slab.frontBevel.enabled
    ? clamp(finite(slab.frontBevel.depth, 0), 0, extrusion)
    : 0;
  const requestedBackDepth = slab.backBevel.enabled
    ? clamp(finite(slab.backBevel.depth, 0), 0, extrusion)
    : 0;
  const depthScale = requestedFrontDepth + requestedBackDepth > extrusion
    ? extrusion / (requestedFrontDepth + requestedBackDepth)
    : 1;
  const frontDepth = requestedFrontDepth * depthScale;
  const backDepth = requestedBackDepth * depthScale;
  const front = frontSize > 0
    ? createProfile(width, height, Math.max(0, radius - frontSize), cornerSegments, skew, frontSize, rounded)
    : outer;
  const back = backSize > 0
    ? createProfile(width, height, Math.max(0, radius - backSize), cornerSegments, skew, backSize, rounded)
    : outer;

  const frontZ = extrusion / 2;
  const frontWallZ = frontZ - frontDepth;
  const backZ = -extrusion / 2;
  const backWallZ = backZ + backDepth;
  const buckets: GeometryBucket[] = Array.from({ length: 5 }, () => ({ positions: [], uvs: [] }));
  const capUv = (point: ProfilePoint): [number, number] => {
    if (slab.skewTexture) {
      return [
        clamp((point.rawX + width / 2) / width, 0, 1),
        clamp((point.rawY + height / 2) / height, 0, 1)
      ];
    }
    const visualWidth = width + Math.abs(skew);
    return [
      clamp((point.x + visualWidth / 2) / visualWidth, 0, 1),
      clamp((point.y + height / 2) / height, 0, 1)
    ];
  };

  addCap(buckets[SLAB_MATERIAL_INDEX.face], front, frontZ, true, capUv);
  if (frontDepth > 0.0001 && frontSize > 0.0001) {
    addRing(
      buckets[SLAB_MATERIAL_INDEX.bevel],
      front,
      frontZ,
      outer,
      frontWallZ,
      extrusion,
      capUv
    );
  }
  addRing(
    buckets[SLAB_MATERIAL_INDEX.extrusion],
    outer,
    frontWallZ,
    outer,
    backWallZ,
    extrusion,
    capUv
  );
  if (backDepth > 0.0001 && backSize > 0.0001) {
    addRing(
      buckets[SLAB_MATERIAL_INDEX.backBevel],
      outer,
      backWallZ,
      back,
      backZ,
      extrusion,
      capUv
    );
  }
  addCap(buckets[SLAB_MATERIAL_INDEX.backFace], back, backZ, false, capUv);

  const positions: number[] = [];
  const uvs: number[] = [];
  const geometry = new THREE.BufferGeometry();
  for (let materialIndex = 0; materialIndex < buckets.length; materialIndex += 1) {
    const bucket = buckets[materialIndex];
    if (bucket.positions.length === 0) continue;
    const start = positions.length / 3;
    positions.push(...bucket.positions);
    uvs.push(...bucket.uvs);
    geometry.addGroup(start, bucket.positions.length / 3, materialIndex);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createProfile(
  width: number,
  height: number,
  radius: number,
  cornerSegments: number,
  skew: number,
  inset: number,
  rounded: boolean
): ProfilePoint[] {
  const profileWidth = Math.max(0.001, width - inset * 2);
  const profileHeight = Math.max(0.001, height - inset * 2);
  if (!rounded) {
    return [
      profilePoint(profileWidth / 2, -profileHeight / 2, height, skew),
      profilePoint(profileWidth / 2, profileHeight / 2, height, skew),
      profilePoint(-profileWidth / 2, profileHeight / 2, height, skew),
      profilePoint(-profileWidth / 2, -profileHeight / 2, height, skew)
    ];
  }

  const effectiveRadius = clamp(Math.max(radius, 0.0001), 0.0001, Math.min(profileWidth, profileHeight) / 2);
  const centers: Array<[number, number, number]> = [
    [profileWidth / 2 - effectiveRadius, -profileHeight / 2 + effectiveRadius, -90],
    [profileWidth / 2 - effectiveRadius, profileHeight / 2 - effectiveRadius, 0],
    [-profileWidth / 2 + effectiveRadius, profileHeight / 2 - effectiveRadius, 90],
    [-profileWidth / 2 + effectiveRadius, -profileHeight / 2 + effectiveRadius, 180]
  ];
  const points: ProfilePoint[] = [];
  for (const [centerX, centerY, startAngle] of centers) {
    for (let step = 0; step <= cornerSegments; step += 1) {
      const angle = THREE.MathUtils.degToRad(startAngle + (step / cornerSegments) * 90);
      points.push(profilePoint(
        centerX + Math.cos(angle) * effectiveRadius,
        centerY + Math.sin(angle) * effectiveRadius,
        height,
        skew
      ));
    }
  }
  return points;
}

function profilePoint(rawX: number, rawY: number, fullHeight: number, skew: number): ProfilePoint {
  return {
    rawX,
    rawY,
    x: rawX + (rawY / Math.max(fullHeight, 0.001)) * skew,
    y: rawY
  };
}

function addCap(
  bucket: GeometryBucket,
  profile: ProfilePoint[],
  z: number,
  front: boolean,
  uvForPoint: (point: ProfilePoint) => [number, number]
): void {
  const points = profile.map((point) => new THREE.Vector2(point.x, point.y));
  for (const triangle of THREE.ShapeUtils.triangulateShape(points, [])) {
    const [a, b, c] = triangle.map((index) => vertex(profile[index], z, uvForPoint));
    const cross = triangleCrossZ(a, b, c);
    const wantsPositive = front;
    if ((cross >= 0) === wantsPositive) {
      addTriangle(bucket, a, b, c);
    } else {
      addTriangle(bucket, a, c, b);
    }
  }
}

function addRing(
  bucket: GeometryBucket,
  frontProfile: ProfilePoint[],
  frontZ: number,
  backProfile: ProfilePoint[],
  backZ: number,
  extrusion: number,
  uvForPoint: (point: ProfilePoint) => [number, number]
): void {
  if (frontProfile.length !== backProfile.length) {
    throw new Error("Slab profile rings must have matching tessellation");
  }
  const count = frontProfile.length;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const frontUv = uvForPoint(frontProfile[index]);
    const nextUv = uvForPoint(frontProfile[next]);
    const frontV = clamp((frontZ + extrusion / 2) / extrusion, 0, 1);
    const backV = clamp((backZ + extrusion / 2) / extrusion, 0, 1);
    const a = vertex(frontProfile[index], frontZ, () => [frontUv[0], frontV]);
    const b = vertex(backProfile[index], backZ, () => [frontUv[0], backV]);
    const c = vertex(backProfile[next], backZ, () => [nextUv[0], backV]);
    const d = vertex(frontProfile[next], frontZ, () => [nextUv[0], frontV]);
    addTriangle(bucket, a, b, c);
    addTriangle(bucket, a, c, d);
  }
}

function vertex(
  point: ProfilePoint,
  z: number,
  uvForPoint: (point: ProfilePoint) => [number, number]
): Vertex {
  const [u, v] = uvForPoint(point);
  return { x: point.x, y: point.y, z, u, v };
}

function addTriangle(bucket: GeometryBucket, a: Vertex, b: Vertex, c: Vertex): void {
  for (const point of [a, b, c]) {
    bucket.positions.push(point.x, point.y, point.z);
    bucket.uvs.push(point.u, point.v);
  }
}

function triangleCrossZ(a: Vertex, b: Vertex, c: Vertex): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
