import manifest from "@grapix/render-shaders/manifests/shader-manifest.json";
import solidSource from "@grapix/render-shaders/wgsl/composite_quad.wgsl?raw";
import texturedSource from "@grapix/render-shaders/wgsl/materials/textured.wgsl?raw";
import {
  validateShaderDefinition,
  type ShaderDefinition
} from "@grapix/shared-types";

const sourceByPath: Record<string, string> = {
  "wgsl/composite_quad.wgsl": solidSource,
  "wgsl/materials/textured.wgsl": texturedSource
};

export interface RegisteredShader {
  definition: ShaderDefinition;
  source: string;
}

export const builtInShaders: RegisteredShader[] = manifest.shaders.map((entry) => {
  const source = sourceByPath[entry.sourcePath] ?? "";
  const definition: ShaderDefinition = {
    ...entry,
    supportedPrimitives: entry.supportedPrimitives as ShaderDefinition["supportedPrimitives"],
    parameters: entry.parameters as ShaderDefinition["parameters"],
    validationStatus: "VALID",
    compilationErrors: [],
    builtIn: true,
    updatedAt: new Date(0).toISOString()
  };
  const errors = [...validateShaderDefinition(definition), ...validateWgslSource(source, definition)];
  return {
    definition: {
      ...definition,
      validationStatus: errors.length ? "INVALID" : "VALID",
      compilationErrors: errors
    },
    source
  };
});

export function validateWgslSource(source: string, definition: ShaderDefinition): string[] {
  const errors: string[] = [];
  if (!source.trim()) errors.push("WGSL source is empty.");
  if (source.length > 256 * 1024) errors.push("WGSL source exceeds the 256 KiB safety limit.");
  if (!source.includes(`fn ${definition.vertexEntry}`)) errors.push(`Vertex entry ${definition.vertexEntry} was not found.`);
  if (!source.includes(`fn ${definition.fragmentEntry}`)) errors.push(`Fragment entry ${definition.fragmentEntry} was not found.`);
  if ((source.match(/\{/g)?.length ?? 0) !== (source.match(/\}/g)?.length ?? 0)) errors.push("WGSL braces are unbalanced.");
  return errors;
}

export function shaderSource(shaderId: string): string | undefined {
  return builtInShaders.find((shader) => shader.definition.shaderId === shaderId)?.source;
}
