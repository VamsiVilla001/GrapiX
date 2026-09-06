/**
 * Inspect a real After Effects project through the native parser.
 *
 * A development aid, not part of any build: point it at any `.aep` or `.aepx` and it prints what
 * `@grapix/adobe-common-schema`'s reader made of it — a census of compositions, layers, keyframes,
 * masks and effects, the warnings the parser raised, and a couple of decoded samples as evidence
 * the numbers are real rather than zeroed.
 *
 * This exists because the vendored fixtures are tiny metadata-only projects: they prove offsets
 * against After Effects' own output but contain no keyframe, mask or large item tree. A real
 * project is where a decode that is subtly wrong at scale shows itself. Run this against one before
 * trusting a parser change:
 *
 *   node tools/ae/inspect-aep.mjs "C:/path/to/Project.aep"
 *
 * It reads the built package (`dist/`), so run `npm run build -w @grapix/adobe-common-schema` first
 * if the sources changed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distEntry = path.join(repoRoot, "Shared/adobe-common-schema/dist/ae/index.js");
const { parseAepToManifest, parseAepxToManifest } = await import(pathToFileURL(distEntry).href);

// Only run the command-line report when invoked directly; importing this module for
// `summarise`/`collapseWarnings` (the regression test does) must not parse anything.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node tools/ae/inspect-aep.mjs <path-to-.aep|.aepx>");
    process.exit(1);
  }

  const bytes = new Uint8Array(readFileSync(file));
  const name = path.basename(file).replace(/\.[^.]+$/, "") || "After Effects Project";
  const isXml = /\.aepx$/i.test(file);

  console.log(`# ${path.basename(file)}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  const started = Date.now();
  let manifest;
  try {
    manifest = isXml
      ? parseAepxToManifest(Buffer.from(bytes).toString("utf8"), name, file)
      : parseAepToManifest(bytes, name, file);
  } catch (error) {
    console.error(`PARSE THREW: ${error?.name}: ${error?.message}`);
    console.error(error?.stack?.split("\n").slice(0, 6).join("\n"));
    process.exit(2);
  }

  const census = summarise(manifest);
  console.log(`producer=${manifest.producer}  parsed in ${Date.now() - started} ms`);
  console.log(`compositions=${manifest.compositions.length}  assets=${manifest.assets.length}  fonts=${manifest.fonts.length}  warnings=${manifest.warnings.length}`);
  console.log(`\n## census`);
  console.log(`layers=${census.layers}  textLayers=${census.textLayers}  masks=${census.masks}  effects=${census.effects}`);
  console.log(`animated streams=${census.animatedStreams}  keyframes=${census.keyframes}  (spatial=${census.spatialKeyframes})  mask-path keyframes=${census.maskPathKeyframes}`);
  console.log(`interp: linear=${census.interp.linear} bezier=${census.interp.bezier} hold=${census.interp.hold}`);
  console.log(`negative-time keyframes=${census.negativeTimeKeyframes}  min time=${census.minTime}`);
  console.log(`layer types: ${[...census.layerTypes].map(([k, v]) => `${k}:${v}`).join("  ")}`);
  console.log(`animated streams: ${[...census.streamNames].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join("  ")}`);

  console.log(`\n## warnings (${manifest.warnings.length}, collapsed)`);
  for (const [pattern, count] of collapseWarnings(manifest.warnings)) console.log(`  ${count}x  ${pattern}`);
}

/** The same summary the regression test asserts, exported so the two never drift. */
export function summarise(manifest) {
  const interp = { linear: 0, bezier: 0, hold: 0 };
  const layerTypes = new Map();
  const streamNames = new Map();
  let layers = 0, textLayers = 0, masks = 0, effects = 0;
  let animatedStreams = 0, keyframes = 0, spatialKeyframes = 0, maskPathKeyframes = 0;
  let negativeTimeKeyframes = 0, minTime = Infinity;

  for (const comp of manifest.compositions) {
    for (const layer of comp.layers) {
      layers += 1;
      layerTypes.set(layer.type, (layerTypes.get(layer.type) ?? 0) + 1);
      if (layer.text) textLayers += 1;
      for (const stream of layer.streams ?? []) {
        if (!stream.keyframes?.length) continue;
        animatedStreams += 1;
        streamNames.set(stream.property, (streamNames.get(stream.property) ?? 0) + stream.keyframes.length);
        for (const key of stream.keyframes) {
          keyframes += 1;
          interp[key.interpolation] = (interp[key.interpolation] ?? 0) + 1;
          if (key.spatialIn || key.spatialOut) spatialKeyframes += 1;
          if (key.time < 0) negativeTimeKeyframes += 1;
          if (key.time < minTime) minTime = key.time;
        }
      }
      for (const mask of layer.masks ?? []) { masks += 1; maskPathKeyframes += mask.pathKeyframes?.length ?? 0; }
      effects += (layer.effects ?? []).length;
    }
  }

  return {
    compositions: manifest.compositions.length,
    assets: manifest.assets.length,
    fonts: manifest.fonts.length,
    warnings: manifest.warnings.length,
    layers, textLayers, masks, effects,
    animatedStreams, keyframes, spatialKeyframes, maskPathKeyframes,
    negativeTimeKeyframes, minTime: minTime === Infinity ? null : minTime,
    interp, layerTypes, streamNames
  };
}

/** Group warnings by shape (numbers and quoted names blanked) so a repeated one reads as one line. */
export function collapseWarnings(warnings) {
  const counts = new Map();
  for (const warning of warnings) {
    const shape = warning.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "N");
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}
