import assert from "node:assert/strict";
import test from "node:test";

import {
  checkShaderSupport,
  EXPECTED_LAYOUT_CONTRACT_VERSION,
  FALLBACK_COLOR,
  FALLBACK_SHADER,
  FALLBACK_SHADER_ID,
  requiredFeatures,
  resolveShader,
  SHADER_LIBRARY_CONTRACT_VERSION,
  uniformBlockSize,
  validateShaderManifest
} from "../dist/index.js";

function capabilities(overrides = {}) {
  return {
    features: ["wgsl"],
    minBindGroups: 1,
    maxSampledTextures: 0,
    maxUniformBytes: 320,
    requiresDepthAttachment: false,
    ...overrides
  };
}

function shader(shaderId, overrides = {}) {
  return {
    shaderId,
    name: shaderId,
    sourcePath: "wgsl/composite_quad.wgsl",
    version: 1,
    vertexEntry: "vs_main",
    fragmentEntry: "fs_main",
    userFacing: true,
    uniformBlocks: [],
    textureInputs: [],
    samplers: [],
    capabilities: capabilities(),
    ...overrides
  };
}

function manifest(shaders) {
  return {
    contractVersion: SHADER_LIBRARY_CONTRACT_VERSION,
    layoutContractVersion: EXPECTED_LAYOUT_CONTRACT_VERSION,
    shaders
  };
}

/** The real composite_quad uniform block, from the render-shaders layout. */
function quadUniforms() {
  return {
    name: "QuadUniforms",
    group: 0,
    binding: 0,
    sizeBytes: 304,
    alignBytes: 16,
    fields: [
      { name: "transform", type: "mat4x4<f32>", offsetBytes: 0, sizeBytes: 64 },
      { name: "fill_color", type: "vec4<f32>", offsetBytes: 64, sizeBytes: 16 },
      { name: "params", type: "vec4<f32>", offsetBytes: 80, sizeBytes: 16 },
      { name: "gradient_params", type: "vec4<f32>", offsetBytes: 96, sizeBytes: 16 },
      { name: "gradient_geometry", type: "vec4<f32>", offsetBytes: 112, sizeBytes: 32, arrayLength: 2 },
      { name: "gradient_positions", type: "vec4<f32>", offsetBytes: 144, sizeBytes: 32, arrayLength: 2 },
      { name: "gradient_colors", type: "vec4<f32>", offsetBytes: 176, sizeBytes: 128, arrayLength: 8 }
    ]
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("the real composite_quad layout validates", () => {
  const validation = validateShaderManifest(
    manifest([shader("grapix.material.solid", { uniformBlocks: [quadUniforms()] })])
  );

  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test("a layout contract change is an error, not a warning", () => {
  const validation = validateShaderManifest({
    contractVersion: SHADER_LIBRARY_CONTRACT_VERSION,
    layoutContractVersion: EXPECTED_LAYOUT_CONTRACT_VERSION + 1,
    shaders: [shader("a")]
  });

  assert.equal(validation.valid, false);
  const issue = validation.issues.find((candidate) => candidate.code === "LAYOUT_CONTRACT_MISMATCH");
  // The message says what to do, because a silent mismatch garbles uniforms.
  assert.ok(issue.message.includes("Rust and TypeScript layouts together"));
});

test("a uniform field past the end of its block is caught", () => {
  const validation = validateShaderManifest(
    manifest([
      shader("a", {
        uniformBlocks: [
          {
            name: "Small",
            group: 0,
            binding: 0,
            sizeBytes: 64,
            alignBytes: 16,
            fields: [{ name: "matrix", type: "mat4x4<f32>", offsetBytes: 32, sizeBytes: 64 }]
          }
        ]
      })
    ])
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "UNIFORM_FIELD_OVERFLOW"));
});

test("vec3 and vec4 must be 16-byte aligned, as WGSL requires", () => {
  const validation = validateShaderManifest(
    manifest([
      shader("a", {
        uniformBlocks: [
          {
            name: "Misaligned",
            group: 0,
            binding: 0,
            sizeBytes: 64,
            alignBytes: 16,
            fields: [{ name: "colour", type: "vec4<f32>", offsetBytes: 4, sizeBytes: 16 }]
          }
        ]
      })
    ])
  );

  assert.equal(validation.valid, false);
  const issue = validation.issues.find(
    (candidate) => candidate.code === "UNIFORM_FIELD_ALIGNMENT"
  );
  assert.ok(issue.message.includes("16-byte aligned"));
});

test("overlapping uniform fields are caught", () => {
  const validation = validateShaderManifest(
    manifest([
      shader("a", {
        uniformBlocks: [
          {
            name: "Overlap",
            group: 0,
            binding: 0,
            sizeBytes: 64,
            alignBytes: 16,
            fields: [
              { name: "first", type: "vec4<f32>", offsetBytes: 0, sizeBytes: 32 },
              { name: "second", type: "vec4<f32>", offsetBytes: 16, sizeBytes: 16 }
            ]
          }
        ]
      })
    ])
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "UNIFORM_FIELD_OVERLAP"));
});

test("a block size that is not a multiple of its alignment is caught", () => {
  const validation = validateShaderManifest(
    manifest([
      shader("a", {
        uniformBlocks: [
          { name: "Odd", group: 0, binding: 0, sizeBytes: 100, alignBytes: 16, fields: [] }
        ]
      })
    ])
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "UNIFORM_BLOCK_ALIGNMENT"));
});

test("uniforms, textures, and samplers share one binding space", () => {
  const validation = validateShaderManifest(
    manifest([
      shader("a", {
        uniformBlocks: [
          { name: "U", group: 0, binding: 1, sizeBytes: 16, alignBytes: 16, fields: [] }
        ],
        textureInputs: [
          {
            name: "tex",
            group: 0,
            binding: 1,
            dimension: "2d",
            sampleType: "float",
            required: true
          }
        ],
        samplers: [{ name: "samp", group: 0, binding: 2, filtering: "filtering" }],
        capabilities: capabilities({ maxSampledTextures: 1, maxUniformBytes: 16 })
      })
    ])
  );

  assert.equal(validation.valid, false);
  const issue = validation.issues.find((candidate) => candidate.code === "BINDING_COLLISION");
  assert.ok(issue.message.includes("uniform U"));
  assert.ok(issue.message.includes("texture tex"));
});

test("shader source must live in the render-shaders tree", () => {
  const validation = validateShaderManifest(
    manifest([shader("a", { sourcePath: "/tmp/injected.wgsl" })])
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "SOURCE_PATH_INVALID"));
});

test("duplicate shader ids are rejected", () => {
  const validation = validateShaderManifest(manifest([shader("same"), shader("same")]));
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "DUPLICATE_SHADER_ID"));
});

test("fallbacks must resolve, must not self-reference, and must not chain", () => {
  const missing = validateShaderManifest(
    manifest([shader("a", { fallbackShaderId: "nope" })])
  );
  assert.ok(missing.issues.some((issue) => issue.code === "FALLBACK_MISSING"));

  const self = validateShaderManifest(manifest([shader("a", { fallbackShaderId: "a" })]));
  assert.ok(self.issues.some((issue) => issue.code === "FALLBACK_SELF"));

  // A chain could loop, and a loop at draw time is a hang.
  const chain = validateShaderManifest(
    manifest([
      shader("a", { fallbackShaderId: "b" }),
      shader("b", { fallbackShaderId: "c" }),
      shader("c")
    ])
  );
  assert.equal(chain.valid, false);
  assert.ok(chain.issues.some((issue) => issue.code === "FALLBACK_CHAIN"));
});

test("a compatibility alias must point at a real shader", () => {
  const validation = validateShaderManifest(
    manifest([shader("legacy", { compatibilityAliasFor: "ghost", userFacing: false })])
  );
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "ALIAS_TARGET_MISSING"));
});

test("understated capabilities are caught", () => {
  const validation = validateShaderManifest(
    manifest([
      shader("a", {
        textureInputs: [
          { name: "t", group: 0, binding: 1, dimension: "2d", sampleType: "float", required: true }
        ],
        samplers: [{ name: "s", group: 0, binding: 2, filtering: "filtering" }],
        capabilities: capabilities({ maxSampledTextures: 0 })
      })
    ])
  );

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "CAPABILITY_UNDERSTATED"));
});

test("a filterable texture with no filtering sampler warns", () => {
  const validation = validateShaderManifest(
    manifest([
      shader("a", {
        textureInputs: [
          { name: "t", group: 0, binding: 1, dimension: "2d", sampleType: "float", required: true }
        ],
        samplers: [{ name: "s", group: 0, binding: 2, filtering: "non-filtering" }],
        capabilities: capabilities({ maxSampledTextures: 1 })
      })
    ])
  );

  // A warning, not an error: point sampling is a legitimate choice.
  assert.equal(validation.valid, true);
  assert.ok(validation.issues.some((issue) => issue.code === "SAMPLER_FILTERING_MISSING"));
});

// ---------------------------------------------------------------------------
// Backend support
// ---------------------------------------------------------------------------

function backend(overrides = {}) {
  return {
    features: ["wgsl", "float32-filterable"],
    maxBindGroups: 4,
    maxSampledTexturesPerShaderStage: 16,
    maxUniformBufferBindingSize: 65_536,
    supportsDepthAttachment: true,
    ...overrides
  };
}

test("a shader whose requirements are met is supported", () => {
  const support = checkShaderSupport(shader("a"), backend());
  assert.equal(support.supported, true);
});

test("a missing feature is named individually", () => {
  const support = checkShaderSupport(
    shader("a", { capabilities: capabilities({ features: ["wgsl", "compute", "storage-buffer"] }) }),
    backend()
  );

  assert.equal(support.supported, false);
  assert.ok(support.missing.includes('feature "compute"'));
  assert.ok(support.missing.includes('feature "storage-buffer"'));
});

test("exceeding a backend limit is reported with both numbers", () => {
  const support = checkShaderSupport(
    shader("a", { capabilities: capabilities({ maxSampledTextures: 32 }) }),
    backend({ maxSampledTexturesPerShaderStage: 16 })
  );

  assert.equal(support.supported, false);
  assert.ok(support.missing.some((entry) => entry.includes("32 sampled textures")));
  assert.ok(support.missing.some((entry) => entry.includes("backend allows 16")));
});

test("a required depth attachment is checked", () => {
  const support = checkShaderSupport(
    shader("a", { capabilities: capabilities({ requiresDepthAttachment: true }) }),
    backend({ supportsDepthAttachment: false })
  );

  assert.equal(support.supported, false);
  assert.ok(support.missing.includes("a depth attachment"));
});

// ---------------------------------------------------------------------------
// Resolution and fallbacks
// ---------------------------------------------------------------------------

test("a supported shader resolves to itself with no substitution", () => {
  const resolution = resolveShader("a", manifest([shader("a")]), backend());
  assert.deepEqual(resolution, { shaderId: "a", substituted: false });
});

test("a compatibility alias normalises before any capability check", () => {
  const library = manifest([
    shader("legacy.unlit", { compatibilityAliasFor: "canonical.pbr", userFacing: false }),
    shader("canonical.pbr")
  ]);

  const resolution = resolveShader("legacy.unlit", library, backend());
  assert.equal(resolution.shaderId, "canonical.pbr");
  assert.equal(resolution.substituted, false);
});

test("an unsupported shader falls back and always reports why", () => {
  const library = manifest([
    shader("fancy", {
      capabilities: capabilities({ features: ["wgsl", "compute"] }),
      fallbackShaderId: "simple"
    }),
    shader("simple")
  ]);

  const resolution = resolveShader("fancy", library, backend());
  assert.equal(resolution.shaderId, "simple");
  assert.equal(resolution.substituted, true);
  assert.ok(resolution.reason.includes('feature "compute"'));
});

test("an unknown shader resolves to the conspicuous fallback", () => {
  const resolution = resolveShader("does.not.exist", manifest([shader("a")]), backend());

  assert.equal(resolution.shaderId, FALLBACK_SHADER_ID);
  assert.equal(resolution.substituted, true);
  assert.ok(resolution.reason.includes("not in the library"));
});

test("an unsupported fallback escalates to the library fallback", () => {
  const library = manifest([
    shader("fancy", {
      capabilities: capabilities({ features: ["wgsl", "compute"] }),
      fallbackShaderId: "alsoFancy"
    }),
    shader("alsoFancy", { capabilities: capabilities({ features: ["wgsl", "compute"] }) })
  ]);

  const resolution = resolveShader("fancy", library, backend());
  assert.equal(resolution.shaderId, FALLBACK_SHADER_ID);
  assert.equal(resolution.substituted, true);
});

test("the fallback is deliberately conspicuous and has no fallback of its own", () => {
  // Flat magenta: if this reaches a monitor, the operator can see it.
  assert.deepEqual([...FALLBACK_COLOR], [1, 0, 1, 1]);
  assert.equal(FALLBACK_SHADER.fallbackShaderId, undefined);
  assert.equal(FALLBACK_SHADER.userFacing, false);
  assert.equal(FALLBACK_SHADER.textureInputs.length, 0);
});

test("uniform block size rounds up to its alignment", () => {
  assert.equal(uniformBlockSize({ sizeBytes: 304, alignBytes: 16 }), 304);
  assert.equal(uniformBlockSize({ sizeBytes: 300, alignBytes: 16 }), 304);
});

test("required features are collected across the whole manifest", () => {
  const features = requiredFeatures(
    manifest([
      shader("a", { capabilities: capabilities({ features: ["wgsl", "compute"] }) }),
      shader("b", { capabilities: capabilities({ features: ["wgsl", "depth-texture"] }) })
    ])
  );

  assert.deepEqual(features, ["compute", "depth-texture", "wgsl"]);
});
