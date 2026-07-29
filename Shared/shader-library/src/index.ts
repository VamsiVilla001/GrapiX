/**
 * `@grapix/shader-library` — shader metadata, validation, and safe fallbacks.
 *
 * The WGSL itself already lives in `Shared/render-shaders`, together with the
 * byte-layout contract and the TypeScript/Rust drift tests. Duplicating that tree
 * would guarantee the two copies diverge, so this package deliberately does not
 * contain shader source. It contains the things requirement 16 asks for *around*
 * the source:
 *
 *   metadata      uniform, texture, and sampler declarations
 *   versioning    a contract version, checked rather than assumed
 *   capabilities  what a shader needs from a backend, so it can be refused early
 *   validation    structural checks over a manifest
 *   fallbacks     what to draw when a shader cannot be used
 *
 * The fallback rule: a shader that cannot run is replaced by a visibly inert
 * surface and reported, never by a lookalike. An operator must be able to tell
 * from the picture that something is wrong.
 */

export const SHADER_LIBRARY_CONTRACT_VERSION = 1 as const;

/** Layout contract version this package was written against. */
export const EXPECTED_LAYOUT_CONTRACT_VERSION = 5;

// ---------------------------------------------------------------------------
// Capability requirements
// ---------------------------------------------------------------------------

/**
 * Backend features a shader may require.
 *
 * Named individually so a refusal can say *which* feature is missing rather than
 * "unsupported shader".
 */
export const SHADER_FEATURES = [
  "wgsl",
  "float32-filterable",
  "texture-array",
  "storage-buffer",
  "compute",
  "depth-texture",
  "multisample",
  "dual-source-blending",
  "16bit-float",
  "bgra8unorm-storage"
] as const;
export type ShaderFeature = (typeof SHADER_FEATURES)[number];

export interface ShaderCapabilityRequirements {
  features: readonly ShaderFeature[];
  /** Minimum bind groups this shader occupies. */
  minBindGroups: number;
  /** Sampled textures bound at once. */
  maxSampledTextures: number;
  /** Largest uniform buffer, in bytes. */
  maxUniformBytes: number;
  /** True when the shader writes depth. */
  requiresDepthAttachment: boolean;
}

export const DEFAULT_CAPABILITY_REQUIREMENTS: Readonly<ShaderCapabilityRequirements> =
  Object.freeze({
    features: Object.freeze(["wgsl"]) as readonly ShaderFeature[],
    minBindGroups: 1,
    maxSampledTextures: 0,
    maxUniformBytes: 256,
    requiresDepthAttachment: false
  });

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export type ShaderUniformType =
  | "f32"
  | "i32"
  | "u32"
  | "vec2<f32>"
  | "vec3<f32>"
  | "vec4<f32>"
  | "mat3x3<f32>"
  | "mat4x4<f32>";

export interface ShaderUniformField {
  name: string;
  type: ShaderUniformType;
  offsetBytes: number;
  sizeBytes: number;
  /** Array length for repeated fields; absent means scalar. */
  arrayLength?: number;
}

export interface ShaderUniformBlock {
  name: string;
  group: number;
  binding: number;
  sizeBytes: number;
  alignBytes: number;
  fields: readonly ShaderUniformField[];
}

export interface ShaderTextureInput {
  name: string;
  group: number;
  binding: number;
  /** Sampling dimensionality. */
  dimension: "2d" | "2d-array" | "3d" | "cube";
  sampleType: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
  required: boolean;
}

export interface ShaderSamplerInput {
  name: string;
  group: number;
  binding: number;
  filtering: "filtering" | "non-filtering" | "comparison";
}

export interface ShaderMetadata {
  shaderId: string;
  name: string;
  /** Path inside `@grapix/render-shaders`. Never inlined source. */
  sourcePath: string;
  version: number;
  vertexEntry: string;
  fragmentEntry: string;
  /** False for compatibility aliases and internal shaders. */
  userFacing: boolean;
  /** Set when this id normalises to another shader. */
  compatibilityAliasFor?: string;
  uniformBlocks: readonly ShaderUniformBlock[];
  textureInputs: readonly ShaderTextureInput[];
  samplers: readonly ShaderSamplerInput[];
  capabilities: ShaderCapabilityRequirements;
  /** Shader used when this one cannot run. Must not itself have a fallback. */
  fallbackShaderId?: string;
}

export interface ShaderLibraryManifest {
  contractVersion: number;
  layoutContractVersion: number;
  shaders: readonly ShaderMetadata[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ShaderIssueSeverity = "error" | "warning";

export interface ShaderIssue {
  severity: ShaderIssueSeverity;
  code: string;
  message: string;
  shaderId?: string;
}

export interface ShaderValidation {
  valid: boolean;
  issues: ShaderIssue[];
}

/**
 * Structural validation of a shader manifest.
 *
 * Catches the mistakes that would otherwise surface as a driver error or, worse,
 * as silently wrong pixels: overlapping bindings, uniform fields past the end of
 * their block, misalignment, and fallback cycles.
 */
export function validateShaderManifest(manifest: ShaderLibraryManifest): ShaderValidation {
  const issues: ShaderIssue[] = [];

  if (manifest.contractVersion !== SHADER_LIBRARY_CONTRACT_VERSION) {
    issues.push({
      severity: "error",
      code: "CONTRACT_VERSION_MISMATCH",
      message: `manifest contract version ${manifest.contractVersion} does not match ${SHADER_LIBRARY_CONTRACT_VERSION}`
    });
  }

  if (manifest.layoutContractVersion !== EXPECTED_LAYOUT_CONTRACT_VERSION) {
    // A layout change means the Rust and TypeScript byte layouts may disagree,
    // which produces garbled uniforms rather than a clean failure.
    issues.push({
      severity: "error",
      code: "LAYOUT_CONTRACT_MISMATCH",
      message: `manifest declares layout contract ${manifest.layoutContractVersion}; this library expects ${EXPECTED_LAYOUT_CONTRACT_VERSION}. Update the Rust and TypeScript layouts together.`
    });
  }

  const ids = new Set<string>();
  for (const shader of manifest.shaders) {
    if (ids.has(shader.shaderId)) {
      issues.push({
        severity: "error",
        code: "DUPLICATE_SHADER_ID",
        message: `shader id "${shader.shaderId}" appears more than once`,
        shaderId: shader.shaderId
      });
      continue;
    }
    ids.add(shader.shaderId);

    issues.push(...validateShader(shader));
  }

  // Fallbacks must resolve, and must not chain.
  for (const shader of manifest.shaders) {
    if (!shader.fallbackShaderId) continue;

    if (!ids.has(shader.fallbackShaderId)) {
      issues.push({
        severity: "error",
        code: "FALLBACK_MISSING",
        message: `shader "${shader.shaderId}" falls back to unknown shader "${shader.fallbackShaderId}"`,
        shaderId: shader.shaderId
      });
      continue;
    }
    if (shader.fallbackShaderId === shader.shaderId) {
      issues.push({
        severity: "error",
        code: "FALLBACK_SELF",
        message: `shader "${shader.shaderId}" falls back to itself`,
        shaderId: shader.shaderId
      });
      continue;
    }

    const fallback = manifest.shaders.find(
      (candidate) => candidate.shaderId === shader.fallbackShaderId
    );
    if (fallback?.fallbackShaderId) {
      // A chain can loop, and a loop at draw time is a hang rather than a bug
      // report.
      issues.push({
        severity: "error",
        code: "FALLBACK_CHAIN",
        message: `shader "${shader.shaderId}" falls back to "${fallback.shaderId}", which itself has a fallback; chains are not permitted`,
        shaderId: shader.shaderId
      });
    }
  }

  for (const shader of manifest.shaders) {
    if (shader.compatibilityAliasFor && !ids.has(shader.compatibilityAliasFor)) {
      issues.push({
        severity: "error",
        code: "ALIAS_TARGET_MISSING",
        message: `shader "${shader.shaderId}" aliases unknown shader "${shader.compatibilityAliasFor}"`,
        shaderId: shader.shaderId
      });
    }
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function validateShader(shader: ShaderMetadata): ShaderIssue[] {
  const issues: ShaderIssue[] = [];
  const at = (code: string, message: string, severity: ShaderIssueSeverity = "error"): void => {
    issues.push({ severity, code, message, shaderId: shader.shaderId });
  };

  if (!shader.sourcePath.startsWith("wgsl/")) {
    at(
      "SOURCE_PATH_INVALID",
      `sourcePath "${shader.sourcePath}" must be inside the render-shaders wgsl tree`
    );
  }
  if (!shader.vertexEntry || !shader.fragmentEntry) {
    at("ENTRY_POINT_MISSING", "both a vertex and a fragment entry point are required");
  }
  if (shader.version < 1) {
    at("VERSION_INVALID", `version must be at least 1, got ${shader.version}`);
  }

  // Bindings must be unique within a group across uniforms, textures, and
  // samplers: they share one binding space.
  const occupied = new Map<string, string>();
  const claim = (group: number, binding: number, owner: string): void => {
    const key = `${group}:${binding}`;
    const existing = occupied.get(key);
    if (existing) {
      at(
        "BINDING_COLLISION",
        `group ${group} binding ${binding} is claimed by both "${existing}" and "${owner}"`
      );
      return;
    }
    occupied.set(key, owner);
  };

  for (const block of shader.uniformBlocks) {
    claim(block.group, block.binding, `uniform ${block.name}`);

    if (block.alignBytes <= 0 || block.sizeBytes % block.alignBytes !== 0) {
      at(
        "UNIFORM_BLOCK_ALIGNMENT",
        `uniform block "${block.name}" is ${block.sizeBytes} bytes, which is not a multiple of its ${block.alignBytes}-byte alignment`
      );
    }

    for (const field of block.fields) {
      const end = field.offsetBytes + field.sizeBytes;
      if (end > block.sizeBytes) {
        at(
          "UNIFORM_FIELD_OVERFLOW",
          `field "${field.name}" ends at byte ${end}, past the ${block.sizeBytes}-byte block "${block.name}"`
        );
      }

      const required = uniformAlignment(field.type);
      if (field.offsetBytes % required !== 0) {
        at(
          "UNIFORM_FIELD_ALIGNMENT",
          `field "${field.name}" of type ${field.type} is at offset ${field.offsetBytes}, which is not ${required}-byte aligned`
        );
      }

      const expected = uniformSize(field.type) * (field.arrayLength ?? 1);
      if (field.sizeBytes < expected) {
        at(
          "UNIFORM_FIELD_SIZE",
          `field "${field.name}" declares ${field.sizeBytes} bytes but ${field.type} needs ${expected}`
        );
      }
    }

    // Overlapping fields silently corrupt each other.
    const sorted = [...block.fields].sort((a, b) => a.offsetBytes - b.offsetBytes);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      if (previous.offsetBytes + previous.sizeBytes > sorted[i].offsetBytes) {
        at(
          "UNIFORM_FIELD_OVERLAP",
          `fields "${previous.name}" and "${sorted[i].name}" overlap in block "${block.name}"`
        );
      }
    }
  }

  for (const texture of shader.textureInputs) {
    claim(texture.group, texture.binding, `texture ${texture.name}`);
  }
  for (const sampler of shader.samplers) {
    claim(sampler.group, sampler.binding, `sampler ${sampler.name}`);
  }

  const sampledCount = shader.textureInputs.length;
  if (sampledCount > shader.capabilities.maxSampledTextures) {
    at(
      "CAPABILITY_UNDERSTATED",
      `declares ${sampledCount} texture input(s) but capabilities allow only ${shader.capabilities.maxSampledTextures}`
    );
  }

  const largestBlock = shader.uniformBlocks.reduce(
    (largest, block) => Math.max(largest, block.sizeBytes),
    0
  );
  if (largestBlock > shader.capabilities.maxUniformBytes) {
    at(
      "CAPABILITY_UNIFORM_UNDERSTATED",
      `largest uniform block is ${largestBlock} bytes but capabilities declare ${shader.capabilities.maxUniformBytes}`
    );
  }

  const groups = new Set<number>([
    ...shader.uniformBlocks.map((block) => block.group),
    ...shader.textureInputs.map((texture) => texture.group),
    ...shader.samplers.map((sampler) => sampler.group)
  ]);
  if (groups.size > shader.capabilities.minBindGroups) {
    at(
      "CAPABILITY_BIND_GROUPS",
      `uses ${groups.size} bind group(s) but capabilities declare ${shader.capabilities.minBindGroups}`,
      "warning"
    );
  }

  if (!shader.capabilities.features.includes("wgsl")) {
    at("FEATURE_WGSL_MISSING", "every GrapiX shader requires the wgsl feature", "warning");
  }

  if (
    shader.textureInputs.some((texture) => texture.sampleType === "float")
    && shader.samplers.every((sampler) => sampler.filtering !== "filtering")
  ) {
    at(
      "SAMPLER_FILTERING_MISSING",
      "declares a filterable float texture but no filtering sampler",
      "warning"
    );
  }

  return issues;
}

function uniformAlignment(type: ShaderUniformType): number {
  switch (type) {
    case "f32":
    case "i32":
    case "u32":
      return 4;
    case "vec2<f32>":
      return 8;
    case "vec3<f32>":
    case "vec4<f32>":
    case "mat3x3<f32>":
    case "mat4x4<f32>":
      // WGSL rounds vec3 up to 16, which is the classic source of layout bugs.
      return 16;
    default:
      return 16;
  }
}

function uniformSize(type: ShaderUniformType): number {
  switch (type) {
    case "f32":
    case "i32":
    case "u32":
      return 4;
    case "vec2<f32>":
      return 8;
    case "vec3<f32>":
      return 12;
    case "vec4<f32>":
      return 16;
    case "mat3x3<f32>":
      // Three columns, each padded to 16 bytes.
      return 48;
    case "mat4x4<f32>":
      return 64;
    default:
      return 16;
  }
}

// ---------------------------------------------------------------------------
// Backend compatibility
// ---------------------------------------------------------------------------

export interface BackendShaderCapabilities {
  features: readonly string[];
  maxBindGroups: number;
  maxSampledTexturesPerShaderStage: number;
  maxUniformBufferBindingSize: number;
  supportsDepthAttachment: boolean;
}

export type ShaderSupport =
  | { supported: true; warnings: string[] }
  | { supported: false; missing: string[]; fallbackShaderId?: string };

/**
 * Can a backend run this shader?
 *
 * Returns the fallback when it cannot, so the caller has something to draw and a
 * reason to report. Never returns `supported: true` with a silent substitution.
 */
export function checkShaderSupport(
  shader: ShaderMetadata,
  backend: BackendShaderCapabilities
): ShaderSupport {
  const missing: string[] = [];
  const available = new Set(backend.features);

  for (const feature of shader.capabilities.features) {
    if (!available.has(feature)) {
      missing.push(`feature "${feature}"`);
    }
  }

  if (shader.capabilities.minBindGroups > backend.maxBindGroups) {
    missing.push(
      `${shader.capabilities.minBindGroups} bind groups (backend allows ${backend.maxBindGroups})`
    );
  }
  if (shader.capabilities.maxSampledTextures > backend.maxSampledTexturesPerShaderStage) {
    missing.push(
      `${shader.capabilities.maxSampledTextures} sampled textures (backend allows ${backend.maxSampledTexturesPerShaderStage})`
    );
  }
  if (shader.capabilities.maxUniformBytes > backend.maxUniformBufferBindingSize) {
    missing.push(
      `${shader.capabilities.maxUniformBytes}-byte uniform block (backend allows ${backend.maxUniformBufferBindingSize})`
    );
  }
  if (shader.capabilities.requiresDepthAttachment && !backend.supportsDepthAttachment) {
    missing.push("a depth attachment");
  }

  if (missing.length > 0) {
    return {
      supported: false,
      missing,
      ...(shader.fallbackShaderId ? { fallbackShaderId: shader.fallbackShaderId } : {})
    };
  }

  return { supported: true, warnings: [] };
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

/**
 * The last-resort surface.
 *
 * Deliberately conspicuous: flat magenta, no texture, no lighting. If this
 * appears on a monitor, something failed and the operator can see it. A fallback
 * that looked plausible would hide the failure until air.
 */
export const FALLBACK_SHADER_ID = "grapix.material.fallback" as const;

export const FALLBACK_SHADER: ShaderMetadata = Object.freeze({
  shaderId: FALLBACK_SHADER_ID,
  name: "Fallback (unsupported shader)",
  sourcePath: "wgsl/composite_quad.wgsl",
  version: 1,
  vertexEntry: "vs_main",
  fragmentEntry: "fs_main",
  userFacing: false,
  uniformBlocks: Object.freeze([]) as readonly ShaderUniformBlock[],
  textureInputs: Object.freeze([]) as readonly ShaderTextureInput[],
  samplers: Object.freeze([]) as readonly ShaderSamplerInput[],
  capabilities: Object.freeze({
    features: Object.freeze(["wgsl"]) as readonly ShaderFeature[],
    minBindGroups: 1,
    maxSampledTextures: 0,
    maxUniformBytes: 304,
    requiresDepthAttachment: false
  })
});

/** Colour the fallback draws, as linear RGBA. */
export const FALLBACK_COLOR: readonly [number, number, number, number] = Object.freeze([
  1, 0, 1, 1
]);

export interface ShaderResolution {
  shaderId: string;
  /** True when the requested shader was replaced. */
  substituted: boolean;
  /** Populated when substituted, for reporting to the operator. */
  reason?: string;
}

/**
 * Resolve a shader for a backend, substituting a fallback if needed.
 *
 * Substitution is always reported. The caller is expected to surface it as an
 * engine warning, because a magenta lower third with no explanation is only
 * marginally better than a wrong one.
 */
export function resolveShader(
  shaderId: string,
  manifest: ShaderLibraryManifest,
  backend: BackendShaderCapabilities
): ShaderResolution {
  const shader = manifest.shaders.find((candidate) => candidate.shaderId === shaderId);

  if (!shader) {
    return {
      shaderId: FALLBACK_SHADER_ID,
      substituted: true,
      reason: `shader "${shaderId}" is not in the library`
    };
  }

  // Compatibility aliases normalise before any capability check.
  if (shader.compatibilityAliasFor) {
    return resolveShader(shader.compatibilityAliasFor, manifest, backend);
  }

  const support = checkShaderSupport(shader, backend);
  if (support.supported) {
    return { shaderId: shader.shaderId, substituted: false };
  }

  const reason = `shader "${shader.shaderId}" needs ${support.missing.join(", ")}`;

  if (support.fallbackShaderId) {
    const fallback = manifest.shaders.find(
      (candidate) => candidate.shaderId === support.fallbackShaderId
    );
    if (fallback && checkShaderSupport(fallback, backend).supported) {
      return { shaderId: fallback.shaderId, substituted: true, reason };
    }
  }

  return { shaderId: FALLBACK_SHADER_ID, substituted: true, reason };
}

/** Uniform block total size, for allocating a staging buffer. */
export function uniformBlockSize(block: ShaderUniformBlock): number {
  return Math.ceil(block.sizeBytes / block.alignBytes) * block.alignBytes;
}

/** Every distinct feature the manifest requires. Used for capability reporting. */
export function requiredFeatures(manifest: ShaderLibraryManifest): ShaderFeature[] {
  const features = new Set<ShaderFeature>();
  for (const shader of manifest.shaders) {
    for (const feature of shader.capabilities.features) features.add(feature);
  }
  return [...features].sort();
}
