export type ModelImportProfile = "EDITOR_PREVIEW" | "PROGRAM_HD" | "PROGRAM_UHD" | "SAFE_MODE";

export interface ModelImportReport {
  format: "glTF 2.0" | "GLB 2.0";
  profile: ModelImportProfile;
  accepted: boolean;
  errors: string[];
  warnings: string[];
  dependencies: string[];
  extensionsUsed: string[];
  unsupportedExtensions: string[];
  materialNames: string[];
  metrics: {
    triangles: number;
    meshes: number;
    primitives: number;
    materials: number;
    textures: number;
    lights: number;
    cameras: number;
    animations: number;
    skins: number;
    bones: number;
  };
  processing: {
    boundsCalculated: boolean;
    normalsPresent: boolean;
    tangentsPresent: boolean;
    mipmapsRequired: boolean;
    lodGenerationRecommended: boolean;
    estimatedVramBytes: number;
  };
}

type Gltf = Record<string, unknown> & {
  asset?: { version?: string };
  accessors?: Array<{ count?: number }>;
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number>; indices?: number; mode?: number }> }>;
  materials?: Array<{ name?: string }>;
  textures?: unknown[];
  images?: Array<{ uri?: string; bufferView?: number }>;
  buffers?: Array<{ uri?: string; byteLength?: number }>;
  animations?: unknown[];
  skins?: Array<{ joints?: number[] }>;
  cameras?: unknown[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: { KHR_lights_punctual?: { lights?: unknown[] } };
};

const SUPPORTED_EXTENSIONS = new Set([
  "KHR_lights_punctual",
  "KHR_materials_unlit",
  "KHR_texture_transform"
]);

const PROFILE_LIMITS: Record<ModelImportProfile, ModelImportReport["metrics"]> = {
  EDITOR_PREVIEW: { triangles: 250_000, meshes: 128, primitives: 256, materials: 128, textures: 128, lights: 8, cameras: 16, animations: 64, skins: 16, bones: 256 },
  PROGRAM_HD: { triangles: 1_000_000, meshes: 256, primitives: 512, materials: 256, textures: 256, lights: 16, cameras: 32, animations: 128, skins: 32, bones: 512 },
  PROGRAM_UHD: { triangles: 500_000, meshes: 128, primitives: 256, materials: 128, textures: 128, lights: 8, cameras: 16, animations: 64, skins: 16, bones: 256 },
  SAFE_MODE: { triangles: 100_000, meshes: 64, primitives: 128, materials: 64, textures: 64, lights: 4, cameras: 8, animations: 16, skins: 8, bones: 128 }
};

export function inspectModelImport(
  bytes: Buffer,
  fileName: string,
  profile: ModelImportProfile = "PROGRAM_HD"
): ModelImportReport {
  const extension = fileName.toLowerCase().split(".").pop();
  const format = extension === "glb" ? "GLB 2.0" : "glTF 2.0";
  const errors: string[] = [];
  const warnings: string[] = [];
  let gltf: Gltf;

  try {
    gltf = extension === "glb" ? parseGlb(bytes) : JSON.parse(bytes.toString("utf8")) as Gltf;
  } catch (error) {
    return emptyReport(format, profile, [
      error instanceof Error ? error.message : "model is not valid glTF"
    ]);
  }

  if (!gltf.asset?.version?.startsWith("2.")) errors.push("only glTF 2.x assets are accepted");
  const accessors = gltf.accessors ?? [];
  const primitives = (gltf.meshes ?? []).flatMap((mesh) => mesh.primitives ?? []);
  let triangles = 0;
  let normalsPresent = true;
  let tangentsPresent = true;
  for (const primitive of primitives) {
    const elementCount = primitive.indices === undefined
      ? accessors[primitive.attributes?.POSITION ?? -1]?.count ?? 0
      : accessors[primitive.indices]?.count ?? 0;
    triangles += primitive.mode === undefined || primitive.mode === 4
      ? Math.floor(elementCount / 3)
      : 0;
    normalsPresent &&= primitive.attributes?.NORMAL !== undefined;
    tangentsPresent &&= primitive.attributes?.TANGENT !== undefined;
  }

  const dependencies = [
    ...(gltf.buffers ?? []).map((buffer) => buffer.uri),
    ...(gltf.images ?? []).map((image) => image.uri)
  ].filter((uri): uri is string => Boolean(uri && !uri.startsWith("data:")));
  for (const dependency of dependencies) {
    if (dependency.includes("..") || dependency.startsWith("/") || /^[a-z]+:/i.test(dependency)) {
      errors.push(`unsafe external model dependency ${dependency}`);
    } else {
      errors.push(`external model dependency ${dependency} must be embedded before import`);
    }
  }

  const extensionsUsed = [...new Set([...(gltf.extensionsUsed ?? []), ...(gltf.extensionsRequired ?? [])])].sort();
  const unsupportedExtensions = extensionsUsed.filter((extensionName) => !SUPPORTED_EXTENSIONS.has(extensionName));
  if (unsupportedExtensions.length) {
    errors.push(`unsupported glTF extensions: ${unsupportedExtensions.join(", ")}`);
  }

  const metrics: ModelImportReport["metrics"] = {
    triangles,
    meshes: gltf.meshes?.length ?? 0,
    primitives: primitives.length,
    materials: gltf.materials?.length ?? 0,
    textures: gltf.textures?.length ?? 0,
    lights: gltf.extensions?.KHR_lights_punctual?.lights?.length ?? 0,
    cameras: gltf.cameras?.length ?? 0,
    animations: gltf.animations?.length ?? 0,
    skins: gltf.skins?.length ?? 0,
    bones: (gltf.skins ?? []).reduce((sum, skin) => sum + (skin.joints?.length ?? 0), 0)
  };
  const limits = PROFILE_LIMITS[profile];
  const materialNames = (gltf.materials ?? []).map((material, index) =>
    material.name?.trim() || `Material ${index + 1}`
  );
  for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) {
    if (metrics[key] > limits[key]) {
      errors.push(`${key} count ${metrics[key]} exceeds ${profile} limit ${limits[key]}`);
    }
  }
  if (!normalsPresent && primitives.length) warnings.push("missing normals must be generated by the offline model worker");
  if (!tangentsPresent && primitives.length) warnings.push("missing tangents must be generated for normal-mapped materials");
  if (metrics.animations) warnings.push("animations are accepted but require timeline-driven native glTF playback before Take");

  const declaredBufferBytes = (gltf.buffers ?? []).reduce((sum, buffer) => sum + (buffer.byteLength ?? 0), 0);
  const estimatedVramBytes = Math.ceil(declaredBufferBytes * 1.35 + metrics.textures * 4 * 1024 * 1024);
  return {
    format,
    profile,
    accepted: errors.length === 0,
    errors,
    warnings,
    dependencies,
    extensionsUsed,
    unsupportedExtensions,
    materialNames,
    metrics,
    processing: {
      boundsCalculated: true,
      normalsPresent,
      tangentsPresent,
      mipmapsRequired: metrics.textures > 0,
      lodGenerationRecommended: triangles > limits.triangles * 0.5,
      estimatedVramBytes
    }
  };
}

function parseGlb(bytes: Buffer): Gltf {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "glTF") {
    throw new Error("invalid GLB magic/header");
  }
  const version = bytes.readUInt32LE(4);
  const declaredLength = bytes.readUInt32LE(8);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  if (declaredLength !== bytes.length) throw new Error("GLB declared length does not match file length");

  let offset = 12;
  let json: string | undefined;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > bytes.length) throw new Error("GLB chunk exceeds file length");
    if (chunkType === 0x4e4f534a) json = bytes.toString("utf8", offset, offset + length).trim();
    offset += length;
  }
  if (!json) throw new Error("GLB is missing its JSON chunk");
  return JSON.parse(json) as Gltf;
}

function emptyReport(
  format: ModelImportReport["format"],
  profile: ModelImportProfile,
  errors: string[]
): ModelImportReport {
  return {
    format,
    profile,
    accepted: false,
    errors,
    warnings: [],
    dependencies: [],
    extensionsUsed: [],
    unsupportedExtensions: [],
    materialNames: [],
    metrics: { triangles: 0, meshes: 0, primitives: 0, materials: 0, textures: 0, lights: 0, cameras: 0, animations: 0, skins: 0, bones: 0 },
    processing: { boundsCalculated: false, normalsPresent: false, tangentsPresent: false, mipmapsRequired: false, lodGenerationRecommended: false, estimatedVramBytes: 0 }
  };
}
