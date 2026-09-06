/**
 * Node loader hooks for the two Vite import forms the editor's sources use.
 *
 * `shaderRegistry` imports WGSL through `?raw`, which Vite turns into a string module. Node
 * knows neither the query nor the extension, so importing anything that reaches the store
 * fails at load with `ERR_UNKNOWN_FILE_EXTENSION` — which is why no test could import
 * `editorStore` and the save path had no coverage at all.
 *
 * This resolves the same bytes to the same string. It is deliberately narrow: an unknown
 * extension still fails, because a test silently importing an empty stub of a real asset is
 * how a suite ends up proving nothing.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RAW_EXTENSIONS = [".wgsl", ".glsl", ".frag", ".vert", ".css"];

function stripRawQuery(url) {
  const [base, query] = url.split("?");
  return { base, raw: query === "raw" || query?.split("&").includes("raw") };
}

export async function resolve(specifier, context, next) {
  const { base, raw } = stripRawQuery(specifier);
  if (!raw) return next(specifier, context);
  // Resolve the file itself, then put the marker back so `load` still sees it.
  const resolved = await next(base, context);
  return { ...resolved, url: `${resolved.url}?raw`, shortCircuit: true };
}

export async function load(url, context, next) {
  const { base, raw } = stripRawQuery(url);
  if (!raw && !RAW_EXTENSIONS.some((extension) => base.endsWith(extension))) {
    return next(url, context);
  }
  const source = await readFile(fileURLToPath(base), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(source)};`
  };
}
