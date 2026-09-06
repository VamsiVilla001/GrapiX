import * as THREE from "three";
import {
  normalizeSlabProperties,
  resolveSceneObjectHierarchy,
  resolveTextureFit,
  textureWrapForFit,
  TEXTURE_FIT_IDENTITY
} from "@grapix/shared-types";
import type {
  CameraSceneObject,
  LightSceneObject,
  MeshSceneObject,
  SceneDocument,
  SceneObject,
  Vec2,
  Vec3
} from "@grapix/shared-types";
import type { RenderableSceneObject, ResolvedFaceMaterial } from "./sceneMaterial";
import { createSlabGeometry } from "./slabGeometry";
import { resolveProjectAssetObjectUrl } from "../lib/projectAssets";

const DEFAULT_FOV = 45;
const MIN_CAMERA_NEAR = 0.01;
const MIN_CAMERA_FAR_SPAN = 0.01;
/**
 * GrapiX authors distance in scene pixels, while Three.js punctual lights use
 * inverse-square physical units. Scaling by the squared canvas size keeps an
 * authored intensity around 1 useful at normal broadcast-scene distances and
 * preserves the same relative result between HD and UHD canvases.
 */
const PUNCTUAL_LIGHT_SCENE_SCALE = 0.04;
const primitivePositionCache = new Map<string, THREE.BufferAttribute>();

export interface ProjectedMeshBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  center: Vec2;
}

type ThreeRenderableSceneObject =
  | Extract<RenderableSceneObject, { type: "mesh" }>
  | Extract<RenderableSceneObject, { type: "rect" | "ellipse" | "image" }>;

/**
 * Canvas Y (down-positive) to three.js world Y (up-positive).
 *
 * A negation, which is numerically what reflecting the content root did — the difference is that
 * this moves only the position and leaves the object's geometry, UVs and winding untouched.
 */
function canvasToWorldY(y: number): number {
  return -y;
}

/**
 * Canvas rotation to world rotation, for axes the Y negation reverses.
 *
 * Reflecting Y conjugates a rotation: Rz(t) becomes Rz(-t) and Rx(t) becomes Rx(-t), while Ry is
 * unchanged. The reflection applied that for free, so removing it means applying it here or every
 * rotated object would spin the opposite way.
 */
function canvasToWorldAngleDegrees(degrees: number): number {
  return -degrees;
}

/**
 * Depth-buffered 3D layer used by the editor viewport. Pixi remains the 2D
 * broadcast compositor; real mesh primitives live here so Z translation,
 * perspective, face occlusion, and XYZ rotation are actual 3D transforms.
 */

export class ThreeSceneLayer {
  private renderer: THREE.WebGLRenderer | null = null;
  private host: HTMLElement | null = null;
  private readonly scene = new THREE.Scene();
  private camera: THREE.Camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 16 / 9, 1, 20_000);
  private readonly lighting = new THREE.Group();
  private readonly content = new THREE.Group();
  private readonly textureLoader = new THREE.TextureLoader();
  private renderVersion = 0;
  private destroyed = false;

  constructor() {
    this.lighting.name = "Scene lighting";
    addThreeChild(this.scene, this.lighting, "3D lighting root");
    addThreeChild(this.scene, this.content, "3D content root");
    // GrapiX authors canvas coordinates with +Y pointing down; three.js uses a right-handed
    // +Y-up world. Lighting is reflected at its root because a light has no geometry — only
    // positions and directions — so a reflection there is exactly the coordinate change wanted.
    //
    // Content is NOT reflected. It used to be (`content.scale.y = -1`), which placed objects
    // correctly and quietly broke every textured surface: reflecting a parent mirrors its
    // children's geometry, so a quad showed its texture upside down *and* had its triangle
    // winding inverted, which under back-face culling showed the mirrored back face. Together
    // those read as a texture flipped both vertically and horizontally. The camera-rotation
    // trick this replaced had the same defect for the same reason.
    //
    // So content converts the axis where the axis actually lives — in the positions, via
    // `canvasToWorldY` — and leaves geometry handedness alone.
    this.lighting.scale.y = -1;
  }

  mount(host: HTMLElement, scene: SceneDocument): void {
    this.host = host;
    this.resize(scene);
  }

  resize(scene: SceneDocument): void {
    this.camera = resolveSceneCamera(scene);
    this.renderer?.setSize(scene.canvas.width, scene.canvas.height, false);
    if (this.renderer) this.fitCanvasToHost();
  }

  async render(scene: SceneDocument, objects: RenderableSceneObject[]): Promise<void> {
    if (this.destroyed) return;
    const version = ++this.renderVersion;
    const next = new THREE.Group();
    const surfaceObjects = objects.filter((object): object is ThreeRenderableSceneObject =>
      object.visible && (
        object.type === "mesh"
        || (["rect", "ellipse", "image"].includes(object.type) && Boolean(object.faceMaterials?.main))
      )
    );
    const lightObjects = objects.filter((object): object is Extract<RenderableSceneObject, { type: "light" }> =>
      object.type === "light" && object.visible
    );

    for (const object of surfaceObjects) {
      const rendered = object.type === "mesh"
        ? await this.createMeshObject(object)
        : await this.createPlanarObject(object);
      if (version !== this.renderVersion || this.destroyed) {
        disposeObject3d(rendered);
        disposeObject3d(next);
        return;
      }
      addThreeChild(next, rendered, `scene object ${object.id}`);
    }

    disposeObject3d(this.content);
    this.content.clear();
    for (const child of next.children.slice()) {
      addThreeChild(this.content, child, "rendered 3D scene object");
    }
    rebuildSceneLighting(this.lighting, scene, lightObjects);
    this.camera = resolveSceneCamera(scene, objects);
    if (surfaceObjects.length > 0) {
      this.ensureRenderer(scene);
    }
    if (this.renderer) {
      this.renderer.shadowMap.enabled = lightObjects.some((light) =>
        Boolean(light.castShadow) && light.opacity > 0 && light.intensity > 0
      );
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Return the current transparent 3D layer for viewport/thumbnail compositing.
   * Render immediately before read-back because WebGL drawing buffers are not retained.
   */
  captureFrame(): HTMLCanvasElement | null {
    if (!this.renderer) return null;
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }

  destroy(): void {
    this.destroyed = true;
    this.renderVersion += 1;
    disposeObject3d(this.content);
    this.content.clear();
    clearSceneLighting(this.lighting);
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = null;
    this.host = null;
  }

  private fitCanvasToHost(): void {
    if (!this.renderer) return;
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
  }

  private ensureRenderer(scene: SceneDocument): void {
    if (this.renderer || !this.host) return;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance"
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "gpu-three-canvas";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.renderer.setSize(scene.canvas.width, scene.canvas.height, false);
    this.fitCanvasToHost();
    this.host.appendChild(this.renderer.domElement);
  }

  private async createMeshObject(object: Extract<RenderableSceneObject, { type: "mesh" }>): Promise<THREE.Object3D> {
    if (object.meshKind === "model" && object.src) {
      const imported = await this.loadModel(object);
      if (imported) return imported;
    }

    const geometry = geometryForObject(object);
    const materials = await materialsForObject(object, this.textureLoader);
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return applyObjectTransform(mesh, object);
  }

  private async createPlanarObject(
    object: Extract<RenderableSceneObject, { type: "rect" | "ellipse" | "image" }>
  ): Promise<THREE.Object3D> {
    const geometry = object.type === "ellipse"
      ? new THREE.CircleGeometry(0.5, 64).scale(object.width, object.height, 1)
      : new THREE.PlaneGeometry(object.width, object.height);
    const material = await createMaterial(
      object.faceMaterials?.main,
      object.fill,
      object.opacity,
      this.textureLoader,
      // A planar object's face IS its width x height, so its fit mode is exactly resolvable.
      { width: object.width, height: object.height }
    );
    const surface = new THREE.Mesh(geometry, material);
    surface.castShadow = true;
    surface.receiveShadow = true;
    surface.position.set(
      object.width / 2 - (object.anchor?.x ?? 0),
      canvasToWorldY(object.height / 2 - (object.anchor?.y ?? 0)),
      0
    );

    const root = new THREE.Group();
    root.name = object.name;
    root.userData.sceneObjectId = object.id;
    root.position.set(object.x, canvasToWorldY(object.y), object.zDepth);
    root.rotation.z = THREE.MathUtils.degToRad(
      canvasToWorldAngleDegrees(object.rotation ?? 0)
    );
    root.scale.set(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1);
    addThreeChild(root, surface, `physical 2D surface for ${object.id}`);
    return root;
  }

  private async loadModel(object: Extract<RenderableSceneObject, { type: "mesh" }>): Promise<THREE.Object3D | null> {
    try {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      // Same rewrite the texture path needs: a model stored in the project is addressed by a
      // relative path the loader would otherwise resolve against the page origin.
      const gltf = await new GLTFLoader().loadAsync(await resolveProjectAssetObjectUrl(object.src!));
      const model = gltf.scene.clone(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const fit = Math.min(
        object.width / Math.max(size.x, 0.0001),
        object.height / Math.max(size.y, 0.0001),
        object.depth / Math.max(size.z, 0.0001)
      );
      model.position.sub(center);
      model.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // Preserve authored GLTF materials by default. GrapiX can override the
      // entire model through "main", or one imported glTF material element
      // through element:N without flattening the other PBR surfaces.
      const importedMaterials = await gltf.parser.getDependencies("material") as THREE.Material[];
      const materialIndices = new Map(importedMaterials.map((material, index) => [material.uuid, index]));
      // An imported glTF surface carries its own UVs and arbitrary geometry, so there is no
      // width x height to fit a texture against; the authored UV transform is the whole story.
      const mainOverride = object.materialSlots.main
        ? await createMaterial(object.faceMaterials?.main, object.fill, object.opacity, this.textureLoader, null)
        : null;
      const elementOverrides = await Promise.all((object.materialElements ?? []).map(async (_, index) => {
        const slot = `element:${index}`;
        return object.materialSlots[slot]
          ? createMaterial(object.faceMaterials?.[slot], object.fill, object.opacity, this.textureLoader, null)
          : null;
      }));

      if (mainOverride || elementOverrides.some(Boolean)) {
        model.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
            const replacements = sourceMaterials.map((source) => {
              const materialIndex = materialIndices.get(source.uuid) ?? -1;
              return (elementOverrides[materialIndex] ?? mainOverride)?.clone() ?? source;
            });
            child.material = Array.isArray(child.material) ? replacements : replacements[0];
          }
        });
      }
      mainOverride?.dispose();
      for (const override of elementOverrides) override?.dispose();

      const fitted = new THREE.Group();
      addThreeChild(fitted, model, `imported model ${object.id}`);
      fitted.scale.setScalar(fit);
      return applyObjectTransform(fitted, object);
    } catch {
      return null;
    }
  }
}

function createFallbackKeyLight(): THREE.DirectionalLight {
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(-700, -900, 1600);
  return light;
}

function createSyntheticCamera(scene: SceneDocument): THREE.PerspectiveCamera {
  const { width, height } = scene.canvas;
  const focalDistance = (height / 2) / Math.tan(THREE.MathUtils.degToRad(DEFAULT_FOV / 2));
  const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, width / height, 1, focalDistance + 20_000);
  camera.aspect = width / height;
  camera.near = Math.max(1, focalDistance / 2000);
  camera.far = focalDistance + 20_000;
  camera.position.set(width / 2, -height / 2, focalDistance);
  camera.up.set(0, 1, 0);
  camera.lookAt(width / 2, -height / 2, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function resolveSceneCamera(
  scene: SceneDocument,
  objects: readonly SceneObject[] = scene.objects
): THREE.Camera {
  const active = scene.activeCameraId
    ? objects.find((object): object is CameraSceneObject =>
      object.id === scene.activeCameraId && object.type === "camera" && object.visible
    )
    : undefined;
  if (!active) {
    return createSyntheticCamera(scene);
  }

  const width = Math.max(1, finiteNumber(scene.canvas.width, 1));
  const height = Math.max(1, finiteNumber(scene.canvas.height, 1));
  const fallbackFar = Math.max(20_000, Math.max(width, height) * 10);
  const near = clampFinite(active.near, 1, MIN_CAMERA_NEAR, fallbackFar);
  const far = clampFinite(active.far, fallbackFar, near + MIN_CAMERA_FAR_SPAN, 1_000_000_000);
  const zoom = clampFinite(active.zoom, 1, 0.01, 100);
  const camera = active.cameraKind === "orthographic"
    ? new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, near, far)
    : new THREE.PerspectiveCamera(
      clampFinite(active.fov, DEFAULT_FOV, 1, 179),
      width / height,
      near,
      far
    );
  camera.zoom = zoom;

  const position = new THREE.Vector3(
    finiteNumber(active.x, width / 2),
    -finiteNumber(active.y, height / 2),
    finiteNumber(active.zDepth, 0)
  );
  const authoredTarget = sceneVector(active.target, { x: width / 2, y: height / 2, z: 0 });
  const target = new THREE.Vector3(authoredTarget.x, -authoredTarget.y, authoredTarget.z);
  if (position.distanceToSquared(target) < 0.000001) {
    target.z = position.z - 1;
  }
  camera.position.copy(position);
  const authoredUp = sceneVector(active.up, { x: 0, y: -1, z: 0 });
  camera.up.copy(safeCameraUp(
    position,
    target,
    new THREE.Vector3(authoredUp.x, -authoredUp.y, authoredUp.z)
  ));
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function rebuildSceneLighting(
  lighting: THREE.Group,
  scene: SceneDocument,
  objects: readonly LightSceneObject[]
): void {
  clearSceneLighting(lighting);
  if (objects.length === 0) {
    addThreeChild(lighting, new THREE.HemisphereLight(0xffffff, 0x1b2430, 1.7), "fallback hemisphere light");
    addThreeChild(lighting, createFallbackKeyLight(), "fallback key light");
    return;
  }

  for (const object of objects) {
    const rendered = createSceneLight(scene, object);
    addThreeChild(lighting, rendered, `scene light ${object.id}`);
  }
}

function createSceneLight(scene: SceneDocument, object: LightSceneObject): THREE.Group {
  const root = new THREE.Group();
  root.name = object.name;
  root.userData.sceneObjectId = object.id;
  const color = safeColor(object.color);
  const opacity = clampFinite(object.opacity, 1, 0, 1);
  const authoredIntensity = Math.max(0, finiteNumber(object.intensity, 1)) * opacity;
  const range = Math.max(0, finiteNumber(object.range, 0));
  const decay = Math.max(0, finiteNumber(object.decay, 2));
  const position = new THREE.Vector3(
    finiteNumber(object.x, scene.canvas.width / 2),
    finiteNumber(object.y, scene.canvas.height / 2),
    finiteNumber(object.zDepth, 0)
  );

  if (object.lightKind === "point") {
    const light = new THREE.PointLight(
      color,
      authoredIntensity * punctualLightScale(scene),
      range,
      decay
    );
    light.position.copy(position);
    light.castShadow = Boolean(object.castShadow);
    configureLightShadow(light, scene, range);
    addThreeChild(root, light, `point light ${object.id}`);
    return root;
  }

  const targetPosition = sceneVector(object.target, {
    x: scene.canvas.width / 2,
    y: scene.canvas.height / 2,
    z: 0
  });
  const target = new THREE.Object3D();
  target.name = `${object.name} Target`;
  target.position.copy(targetPosition);

  if (object.lightKind === "spot") {
    const coneAngle = clampFinite(object.coneAngleDeg, 45, 1, 179);
    const light = new THREE.SpotLight(
      color,
      authoredIntensity * punctualLightScale(scene),
      range,
      THREE.MathUtils.degToRad(coneAngle / 2),
      clampFinite(object.penumbra, 0.25, 0, 1),
      decay
    );
    light.position.copy(position);
    light.target = target;
    light.castShadow = Boolean(object.castShadow);
    configureLightShadow(light, scene, range);
    addThreeChild(root, light, `spot light ${object.id}`);
    addThreeChild(root, target, `spot light target ${object.id}`);
    return root;
  }

  const light = new THREE.DirectionalLight(color, authoredIntensity);
  light.position.copy(position);
  light.target = target;
  light.castShadow = Boolean(object.castShadow);
  configureLightShadow(light, scene, range);
  addThreeChild(root, light, `directional light ${object.id}`);
  addThreeChild(root, target, `directional light target ${object.id}`);
  return root;
}

function configureLightShadow(
  light: THREE.DirectionalLight | THREE.PointLight | THREE.SpotLight,
  scene: SceneDocument,
  range: number
): void {
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.0001;
  light.shadow.camera.near = MIN_CAMERA_NEAR;
  light.shadow.camera.far = Math.max(
    light.shadow.camera.near + MIN_CAMERA_FAR_SPAN,
    range || Math.max(scene.canvas.width, scene.canvas.height) * 10
  );
  if (light instanceof THREE.DirectionalLight) {
    const extent = Math.max(scene.canvas.width, scene.canvas.height);
    light.shadow.camera.left = -extent;
    light.shadow.camera.right = extent;
    light.shadow.camera.top = extent;
    light.shadow.camera.bottom = -extent;
  }
  light.shadow.camera.updateProjectionMatrix();
}

function clearSceneLighting(lighting: THREE.Group): void {
  lighting.traverse((child) => {
    if (
      child instanceof THREE.DirectionalLight
      || child instanceof THREE.PointLight
      || child instanceof THREE.SpotLight
    ) {
      child.shadow.map?.dispose();
    }
  });
  lighting.clear();
}

function punctualLightScale(scene: SceneDocument): number {
  const extent = Math.max(1, scene.canvas.width, scene.canvas.height);
  return extent * extent * PUNCTUAL_LIGHT_SCENE_SCALE;
}

function sceneVector(value: Vec3 | undefined, fallback: Vec3): THREE.Vector3 {
  return new THREE.Vector3(
    finiteNumber(value?.x, fallback.x),
    finiteNumber(value?.y, fallback.y),
    finiteNumber(value?.z, fallback.z)
  );
}

function safeCameraUp(
  position: THREE.Vector3,
  target: THREE.Vector3,
  candidate: THREE.Vector3
): THREE.Vector3 {
  const up = candidate.lengthSq() > 0.000001
    ? candidate.normalize()
    : new THREE.Vector3(0, -1, 0);
  const viewDirection = target.clone().sub(position).normalize();
  if (Math.abs(viewDirection.dot(up)) < 0.999) {
    return up;
  }
  return Math.abs(viewDirection.y) < 0.9
    ? new THREE.Vector3(0, -1, 0)
    : new THREE.Vector3(1, 0, 0);
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function geometryForObject(object: MeshSceneObject): THREE.BufferGeometry {
  switch (object.meshKind) {
    case "sphere":
      return new THREE.SphereGeometry(0.5, 48, 32).scale(object.width, object.height, object.depth);
    case "cylinder":
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 1, false)
        .scale(object.width, object.height, object.depth);
    case "torus":
      // The unit torus has an outer diameter of 1 and a Z thickness of 0.3.
      return new THREE.TorusGeometry(0.35, 0.15, 20, 64)
        .scale(object.width, object.height, object.depth / 0.3);
    case "slab":
      return createSlabGeometry(object);
    case "cube":
    case "model":
    default:
      return new THREE.BoxGeometry(object.width, object.height, object.depth);
  }
}

function primitivePositions(object: MeshSceneObject): THREE.BufferAttribute {
  const geometryKey = [
    object.meshKind,
    object.width,
    object.height,
    object.depth,
    object.meshKind === "slab" ? JSON.stringify(normalizeSlabProperties(object.slab)) : ""
  ].join(":");
  const cached = primitivePositionCache.get(geometryKey);
  if (cached) return cached;
  const geometry = geometryForObject(object);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  geometry.dispose();
  primitivePositionCache.set(geometryKey, positions);
  if (primitivePositionCache.size > 64) {
    const oldestKey = primitivePositionCache.keys().next().value;
    if (oldestKey !== undefined) primitivePositionCache.delete(oldestKey);
  }
  return positions;
}

async function materialsForObject(
  object: Extract<RenderableSceneObject, { type: "mesh" }>,
  loader: THREE.TextureLoader
): Promise<THREE.Material | THREE.Material[]> {
  const objectCullMode = object.meshKind === "slab"
    ? normalizeSlabProperties(object.slab).culling
    : undefined;
  // "main" is the primary front face, whose extent is the object's width x height. Bevel,
  // extrusion and side faces are sized from depth and bevel geometry, so they get no fit surface
  // rather than a plausible-looking wrong one.
  const face = (slot: string, fallback: string) =>
    createMaterial(
      object.faceMaterials?.[slot],
      fallback,
      object.opacity,
      loader,
      slot === "main" ? { width: object.width, height: object.height } : null,
      objectCullMode
    );

  if (object.meshKind === "slab") {
    return Promise.all([
      face("main", object.fill),
      face("face:bevel", adjustHex(object.fill, 18)),
      face("face:extrusion", adjustHex(object.fill, -12)),
      face("face:back-bevel", adjustHex(object.fill, -20)),
      face("face:back", adjustHex(object.fill, -30))
    ]);
  }

  if (object.meshKind === "cube") {
    // BoxGeometry groups: +X, -X, +Y, -Y, +Z, -Z. GrapiX world Y points down,
    // so +Y is the visual bottom and -Y is the visual top.
    return Promise.all([
      face("face:right", adjustHex(object.fill, -8)),
      face("face:left", adjustHex(object.fill, -18)),
      face("face:bottom", adjustHex(object.fill, -25)),
      face("face:top", adjustHex(object.fill, 18)),
      face("main", object.fill),
      face("face:back", adjustHex(object.fill, -30))
    ]);
  }

  if (object.meshKind === "cylinder") {
    return Promise.all([
      face("main", object.fill),
      face("face:cap-top", adjustHex(object.fill, 18)),
      face("face:cap-bottom", adjustHex(object.fill, -18))
    ]);
  }

  return face("main", object.fill);
}

/**
 * `surface` is the drawn extent of the face in canvas units, used to resolve the texture's fit
 * mode. Pass `null` when the caller genuinely does not know it: a cube or slab face is not the
 * object's width x height, and guessing would crop textures by an invented amount. A null surface
 * keeps the authored UV transform exactly as it is today.
 */
async function createMaterial(
  face: ResolvedFaceMaterial | undefined,
  fallback: string,
  objectOpacity: number,
  loader: THREE.TextureLoader,
  surface: { width: number; height: number } | null,
  cullModeOverride?: "back" | "front" | "none"
): Promise<THREE.MeshStandardMaterial> {
  const descriptor = describeMeshSurfaceMaterial(face, fallback, objectOpacity);
  const resolved = face?.resolved;
  const cullMode = cullModeOverride ?? descriptor.cullMode;
  const side = descriptor.doubleSided || cullMode === "none"
    ? THREE.DoubleSide
    : cullMode === "front"
      ? THREE.BackSide
      : THREE.FrontSide;
  const common = {
    // Textured surfaces default to a white tint so the image retains its
    // authored colour. Solid/unbound surfaces retain their object fallback.
    color: descriptor.color,
    opacity: descriptor.opacity,
    transparent: descriptor.transparent,
    alphaTest: resolved?.alphaMode === "alpha-test" ? 0.5 : 0,
    side,
    depthTest: descriptor.depthTest,
    depthWrite: descriptor.depthWrite
  };
  // XPression-style material resources all describe the same physical
  // surface. Colour and texture are inputs to that surface, not separate
  // unlit/lit/PBR material families.
  const material = new THREE.MeshStandardMaterial({
    ...common,
    metalness: descriptor.metalness,
    roughness: descriptor.roughness,
    emissive: descriptor.emissiveColor,
    emissiveIntensity: descriptor.emissiveIntensity
  });

  if (face?.assetSource) {
    try {
      /*
       * Resolve and authenticate before the loader sees it.
       *
       * A scene stores an asset by the path the project knows it by — `Assets/Images/key.png`
       * through the content route, or `images/<scene>/<layer>.png` for an imported design — and
       * both are relative. Handing either straight to `TextureLoader` resolves it against the
       * *page* origin: the Vite dev server, or `tauri.localhost` in the shell. Vite answers
       * `index.html` with a 200, so the load does not even fail loudly — the decode fails, the
       * catch below keeps the authored colour, and a textured surface renders as flat white.
       *
       * `resolveProjectAssetObjectUrl` points it at the project service, attaches the session
       * bearer the content routes require, and hands back a blob URL, which is the only form a
       * header-less loader can use. Data URLs and remote sources pass straight through.
       */
      const texture = await loader.loadAsync(await resolveProjectAssetObjectUrl(face.assetSource));
      texture.colorSpace = resolved?.material.colorSpace === "linear"
        ? THREE.LinearSRGBColorSpace
        : THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      applyTextureCoordinates(texture, resolved, surface);
      material.map = texture;
      material.needsUpdate = true;
    } catch {
      // Keep the authored face colour when a preview texture cannot be decoded.
    }
  }

  return material;
}

export interface MeshSurfaceMaterialDescriptor {
  lit: boolean;
  color: string;
  opacity: number;
  transparent: boolean;
  depthTest: boolean;
  depthWrite: boolean;
  cullMode: "none" | "front" | "back";
  doubleSided: boolean;
  metalness: number;
  roughness: number;
  emissiveColor: string;
  emissiveIntensity: number;
}

/**
 * Pure physical-surface description shared by WebGL construction and
 * regression tests. Every assigned material consumes scene lighting; texture
 * presence only changes the base-colour input.
 */
export function describeMeshSurfaceMaterial(
  face: ResolvedFaceMaterial | undefined,
  fallback: string,
  objectOpacity: number
): MeshSurfaceMaterialDescriptor {
  const resolved = face?.resolved;
  const materialOpacity = face?.opacity ?? 1;
  const opacity = Math.max(0, Math.min(1, objectOpacity * materialOpacity));
  const transparent = opacity < 1 || Boolean(face?.assetSource && resolved?.alphaMode !== "opaque");
  return {
    lit: true,
    color: String(safeColor(face?.color ?? (face?.assetSource ? "#ffffff" : fallback))),
    opacity,
    transparent,
    // Mesh surfaces always depth-test so real 3D faces occlude one another.
    // Transparent surfaces do not write depth: otherwise an alpha-zero texel
    // can hide geometry behind it even though the texel itself is invisible.
    depthTest: true,
    depthWrite: !transparent,
    cullMode: resolved?.material.cullMode ?? "back",
    doubleSided: Boolean(resolved?.material.doubleSided),
    metalness: Math.max(0, Math.min(1, numericParameter(resolved?.parameters.metalness, 0.08))),
    roughness: Math.max(0.04, Math.min(1, numericParameter(resolved?.parameters.roughness, 0.62))),
    emissiveColor: String(safeColor(String(resolved?.parameters.emissiveColor ?? "#000000"))),
    emissiveIntensity: Math.max(0, Math.min(10, numericParameter(resolved?.parameters.emissiveIntensity, 0)))
  };
}

function applyTextureCoordinates(
  texture: THREE.Texture,
  resolved: ResolvedFaceMaterial["resolved"] | undefined,
  surface: { width: number; height: number } | null
): void {
  const slot = resolved?.textureSlots[0];
  if (!slot) return;
  // The fit mode can override the authored wrap: a tile is defined by sampling past 1.0, and
  // clamp would smear the edge row across the surface rather than repeating.
  const wrap = textureWrapForFit(slot.fit, slot.wrap);
  texture.wrapS = textureWrap(wrap);
  texture.wrapT = textureWrap(wrap);
  texture.magFilter = slot.filtering === "nearest" ? THREE.NearestFilter : THREE.LinearFilter;
  texture.minFilter = slot.filtering === "nearest" ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;

  // The fit mode picks the rectangle of the texture the surface samples, which is where the
  // image's own resolution finally matters: a 256x128 texture on a 360x210 quad is cropped, not
  // squashed. `image` is populated because this runs after the loader resolves; without it there
  // is no resolution to respect, so the authored transform stands alone.
  const image = texture.image as { width?: number; height?: number } | undefined;
  const fit = surface && image?.width && image?.height
    ? resolveTextureFit(slot.fit, {
      surfaceWidth: surface.width,
      surfaceHeight: surface.height,
      textureWidth: image.width,
      textureHeight: image.height
    })
    : TEXTURE_FIT_IDENTITY;

  const uvScale = vector2Parameter(resolved.parameters.uvScale, slot.uvScale);
  const uvOffset = vector2Parameter(resolved.parameters.uvOffset, slot.uvOffset);
  const uvRotation = numericParameter(resolved.parameters.uvRotation, slot.uvRotation);
  // Authored scale narrows the fitted rectangle rather than replacing it, so a fit crop and a
  // deliberate UV zoom compose instead of one silently discarding the other.
  const repeatX = (slot.flipX ? -1 : 1) * uvScale[0] * fit.repeat[0];
  const repeatY = (slot.flipY ? -1 : 1) * uvScale[1] * fit.repeat[1];
  texture.repeat.set(repeatX, repeatY);
  texture.offset.set(
    fit.offset[0] + uvOffset[0] + (slot.flipX ? fit.repeat[0] : 0),
    fit.offset[1] + uvOffset[1] + (slot.flipY ? fit.repeat[1] : 0)
  );
  texture.center.set(slot.uvPivot[0], slot.uvPivot[1]);
  texture.rotation = THREE.MathUtils.degToRad(uvRotation);
  texture.needsUpdate = true;
}

function textureWrap(wrap: "clamp" | "repeat" | "mirror-repeat"): THREE.Wrapping {
  if (wrap === "repeat") return THREE.RepeatWrapping;
  if (wrap === "mirror-repeat") return THREE.MirroredRepeatWrapping;
  return THREE.ClampToEdgeWrapping;
}

function numericParameter(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function vector2Parameter(value: unknown, fallback: [number, number]): [number, number] {
  return Array.isArray(value) && value.length >= 2 &&
    typeof value[0] === "number" && typeof value[1] === "number"
    ? [value[0], value[1]]
    : fallback;
}

function applyObjectTransform<T extends THREE.Object3D>(rendered: T, object: MeshSceneObject): THREE.Group {
  const anchor = object.anchor3d ?? {
    x: object.anchor?.x ?? 0,
    y: object.anchor?.y ?? 0,
    z: object.depth / 2
  };
  const contentOffset = new THREE.Vector3(
    object.width / 2 - anchor.x,
    canvasToWorldY(object.height / 2 - anchor.y),
    object.depth / 2 - anchor.z
  );
  rendered.position.copy(contentOffset);

  const root = new THREE.Group();
  root.name = object.name;
  root.userData.sceneObjectId = object.id;
  root.position.set(object.x, canvasToWorldY(object.y), object.zDepth);
  root.rotation.set(
    // X and Z reverse with the Y axis; Y does not. Getting this wrong is invisible on an
    // unrotated object and obvious on a rotated one, which is the worst way to find out.
    THREE.MathUtils.degToRad(canvasToWorldAngleDegrees(object.rotationX ?? 0)),
    THREE.MathUtils.degToRad(object.rotationY ?? 0),
    THREE.MathUtils.degToRad(
      canvasToWorldAngleDegrees(object.rotationZ ?? object.rotation ?? 0)
    ),
    "XYZ"
  );
  root.scale.set(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1);
  addThreeChild(root, rendered, `mesh content for ${object.id}`);
  return root;
}

export function projectMeshBounds(scene: SceneDocument, object: MeshSceneObject): ProjectedMeshBounds {
  const camera = resolveSceneCamera(scene, resolveSceneObjectHierarchy(scene.objects).objects);
  const anchor = object.anchor3d ?? {
    x: object.anchor?.x ?? 0,
    y: object.anchor?.y ?? 0,
    z: object.depth / 2
  };
  // Must compose exactly as `applyObjectTransform` does, including the Y negation and the
  // reversed X/Z rotations: this is what selection handles and hit-testing are drawn from, so a
  // mismatch puts the handles somewhere the object is not.
  const transform = new THREE.Matrix4().compose(
    new THREE.Vector3(object.x, canvasToWorldY(object.y), object.zDepth),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(canvasToWorldAngleDegrees(object.rotationX ?? 0)),
      THREE.MathUtils.degToRad(object.rotationY ?? 0),
      THREE.MathUtils.degToRad(
        canvasToWorldAngleDegrees(object.rotationZ ?? object.rotation ?? 0)
      ),
      "XYZ"
    )),
    new THREE.Vector3(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1)
  );
  const contentOffset = new THREE.Vector3(
    object.width / 2 - anchor.x,
    canvasToWorldY(object.height / 2 - anchor.y),
    object.depth / 2 - anchor.z
  );
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includeLocalPoint = (point: THREE.Vector3) => {
    const projected = projectPoint(scene, camera, point.add(contentOffset).applyMatrix4(transform));
    minX = Math.min(minX, projected.x);
    minY = Math.min(minY, projected.y);
    maxX = Math.max(maxX, projected.x);
    maxY = Math.max(maxY, projected.y);
  };

  if (object.meshKind === "model") {
    // Imported model geometry loads asynchronously. Its authored fit box remains the synchronous
    // selection fallback until the Render View exposes loaded mesh bounds.
    for (const x of [0, object.width]) {
      for (const y of [0, object.height]) {
        for (const z of [0, object.depth]) {
          includeLocalPoint(new THREE.Vector3(
            x - object.width / 2,
            canvasToWorldY(y - object.height / 2),
            z - object.depth / 2
          ));
        }
      }
    }
  } else {
    // Project the actual primitive surface rather than its enclosing box. A rotated sphere is
    // still a sphere; rotating the old box made its selection handles stretch even though the
    // rendered pixels did not.
    const positions = primitivePositions(object);
    const point = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 1) {
      point.set(positions.getX(index), positions.getY(index), positions.getZ(index));
      includeLocalPoint(point);
    }
  }

  const center = projectPoint(
    scene,
    camera,
    new THREE.Vector3(object.x, canvasToWorldY(object.y), object.zDepth)
  );
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    center: { x: center.x, y: center.y }
  };
}

function projectPoint(
  scene: SceneDocument,
  camera: THREE.Camera,
  point: THREE.Vector3
): THREE.Vector3 {
  // `point` is already in three.js world space: callers convert canvas Y through
  // `canvasToWorldY` exactly as the renderer does. This used to negate Y itself to match the
  // content root's reflection, which meant the axis convention lived in two places.
  const projected = point.clone().project(camera);
  return new THREE.Vector3(
    (projected.x * 0.5 + 0.5) * scene.canvas.width,
    (-projected.y * 0.5 + 0.5) * scene.canvas.height,
    projected.z
  );
}

function safeColor(value: string): THREE.ColorRepresentation {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#8fa7bd";
}

function adjustHex(color: string, delta: number): string {
  const normalized = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return color;
  const channels = [0, 2, 4].map((offset) =>
    Math.max(0, Math.min(255, parseInt(normalized.slice(offset, offset + 2), 16) + delta))
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function disposeObject3d(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry?.dispose();
    disposeMaterial(child.material);
  });
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  for (const item of Array.isArray(material) ? material : [material]) {
    const textured = item as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
    textured.map?.dispose();
    item.dispose();
  }
}

function addThreeChild(parent: THREE.Object3D, child: THREE.Object3D, label: string): void {
  if (!child?.isObject3D) {
    throw new Error(`Invalid Three.js node for ${label}`);
  }
  parent.add(child);
}
