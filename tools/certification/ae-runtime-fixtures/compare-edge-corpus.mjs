#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const manifestPath = resolve(process.argv[2] ?? join(here, "v1/edge-corpus.json"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const root = dirname(manifestPath);
const referenceRoot = join(root, "references");
const send = join(repo, "ae-plugin/runtime-adapter/send.sh");
const resultPath = join(root, "edge-corpus-result.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tiffPixels(file) {
  const bytes = readFileSync(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mark = view.getUint16(0, true);
  const little = mark === 0x4949;
  if (!little && mark !== 0x4d4d) throw new Error(`${file}: bad TIFF byte order`);
  const u16 = (offset) => view.getUint16(offset, little);
  const u32 = (offset) => view.getUint32(offset, little);
  if (u16(2) !== 42) throw new Error(`${file}: bad TIFF magic`);
  const typeBytes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const ifd = u32(4);
  const tags = new Map();
  for (let i = 0, count = u16(ifd); i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const valueCount = u32(entry + 4);
    const base = (typeBytes[type] ?? 1) * valueCount <= 4 ? entry + 8 : u32(entry + 8);
    const values = [];
    for (let n = 0; n < valueCount; n += 1) {
      if (type === 3) values.push(u16(base + n * 2));
      else if (type === 4) values.push(u32(base + n * 4));
      else if ([1, 2, 6, 7].includes(type)) values.push(bytes[base + n]);
    }
    tags.set(tag, values);
  }
  const first = (tag) => tags.get(tag)?.[0];
  if ((first(259) ?? 1) !== 1) throw new Error(`${file}: reference TIFF must be uncompressed`);
  if ((first(277) ?? 0) !== 4 || (tags.get(258) ?? []).some((bits) => bits !== 8)) {
    throw new Error(`${file}: reference must be 8-bit RGBA`);
  }
  const offsets = tags.get(273) ?? [];
  const counts = tags.get(279) ?? [];
  if (offsets.length === 0 || offsets.length !== counts.length) throw new Error(`${file}: invalid strips`);
  const payload = Buffer.concat(offsets.map((offset, i) => bytes.subarray(offset, offset + counts[i])));
  const width = first(256);
  const height = first(257);
  if (payload.length !== width * height * 4) throw new Error(`${file}: strip payload does not match geometry`);
  return { width, height, pixels: payload, pixelSha256: sha256(payload) };
}

function checkout(composition, matte) {
  const run = spawnSync("sh", [send, "checkout", composition, "0", "8", matte, "argb"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, TIMEOUT_SECONDS: "150" },
  });
  if (run.status !== 0) throw new Error(`${composition} ${matte}: ${run.stderr || run.stdout}`);
  const lines = run.stdout.trim().split(/\r?\n/);
  const reply = JSON.parse(lines.at(-1));
  if (!reply.ok) throw new Error(`${composition} ${matte}: adapter returned ${run.stdout}`);
  const argb = readFileSync(reply.payloadPath);
  if (argb.length !== reply.width * reply.height * 4) throw new Error(`${composition} ${matte}: raw geometry mismatch`);
  const rgba = Buffer.allocUnsafe(argb.length);
  for (let i = 0; i < argb.length; i += 4) {
    rgba[i] = argb[i + 1];
    rgba[i + 1] = argb[i + 2];
    rgba[i + 2] = argb[i + 3];
    rgba[i + 3] = argb[i];
  }
  return { reply, rgba };
}

function analyse(pixels) {
  const alphaHistogram = Array(256).fill(0);
  const stats = { opaque: 0, transparent: 0, partial: 0, colourAboveAlpha: 0, colourAtZeroAlpha: 0 };
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    const highest = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    alphaHistogram[alpha] += 1;
    if (alpha === 255) stats.opaque += 1;
    else if (alpha === 0) stats.transparent += 1;
    else stats.partial += 1;
    if (highest > alpha) stats.colourAboveAlpha += 1;
    if (alpha === 0 && highest > 0) stats.colourAtZeroAlpha += 1;
  }
  stats.distinctAlphaValues = alphaHistogram.filter((count) => count > 0).length;
  stats.alphaAt128 = alphaHistogram[128];
  return { stats, alphaHistogram };
}

function compare(actual, expected) {
  if (actual.length !== expected.length) return { bytesEqual: false, differingBytes: null, differingPixels: null, worstDelta: null };
  let differingBytes = 0;
  let differingPixels = 0;
  let worstDelta = 0;
  for (let i = 0; i < actual.length; i += 4) {
    let pixelDiffers = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(actual[i + channel] - expected[i + channel]);
      if (delta > 0) { differingBytes += 1; pixelDiffers = true; }
      if (delta > worstDelta) worstDelta = delta;
    }
    if (pixelDiffers) differingPixels += 1;
  }
  return { bytesEqual: differingBytes === 0, differingBytes, differingPixels, worstDelta };
}

function expectCount(label, actual, expected, total, failures) {
  const okay = expected === "all" ? actual === total : expected === "some" ? actual > 0 : actual === expected;
  if (!okay) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

const project = join(root, manifest.fixture.file);
const projectBytes = readFileSync(project);
const projectSha256 = sha256(projectBytes);
if (manifest.fixture.sha256 && manifest.fixture.sha256 !== projectSha256) {
  throw new Error(`fixture digest mismatch: manifest ${manifest.fixture.sha256}, file ${projectSha256}`);
}

// A runner that can report zero comparisons must not be able to exit green (memory rule 247): with an
// emptied or truncated `cases` list every loop below is skipped, `failed` stays false, and the run
// prints PASS having proven nothing. The schema declares `minItems: 7`, but nothing here validates the
// schema, so the floor is asserted explicitly — and distinctly, so seven copies of one case cannot
// stand in for the seven alpha vectors.
if (!Array.isArray(manifest.cases) || manifest.cases.length < 7) {
  throw new Error(`edge corpus requires at least 7 declared cases, found ${Array.isArray(manifest.cases) ? manifest.cases.length : "none"}`);
}
if (new Set(manifest.cases.map(({ composition }) => composition)).size !== manifest.cases.length) {
  throw new Error("edge corpus cases must each name a distinct composition");
}

const cases = [];
let failed = false;
for (const item of manifest.cases) {
  const refManifestPath = join(referenceRoot, item.composition, "manifest.json");
  const refManifest = JSON.parse(readFileSync(refManifestPath, "utf8"));
  const refFile = join(referenceRoot, item.composition, "frames", refManifest.frames[0].file);
  const reference = tiffPixels(refFile);
  if (reference.pixelSha256 !== refManifest.frames[0].pixelSha256) {
    throw new Error(`${item.id}: reference pixel digest does not match its export manifest`);
  }

  const premul = checkout(item.composition, "premul-black");
  const premulBytes = Buffer.from(premul.rgba);
  const straight = checkout(item.composition, "straight");
  const premulAgreement = compare(premulBytes, reference.pixels);
  const straightContrast = compare(straight.rgba, reference.pixels);
  const total = reference.width * reference.height;
  const failures = [];
  const analysis = analyse(premulBytes);
  const stats = analysis.stats;
  if (premul.reply.width !== manifest.render.width || premul.reply.height !== manifest.render.height) {
    failures.push(`checkout geometry ${premul.reply.width}x${premul.reply.height}`);
  }
  if (premul.reply.channelOrder !== "argb" || premul.reply.matteMode !== "premul-black") {
    failures.push(`checkout contract ${premul.reply.channelOrder}/${premul.reply.matteMode}`);
  }
  if (!premul.reply.onHookThread || premul.reply.checkinError !== 0) failures.push("checkout lifetime/thread contract failed");
  if (!premulAgreement.bytesEqual || premulAgreement.worstDelta > manifest.comparison.maxChannelDelta || premulAgreement.differingPixels > manifest.comparison.maxDifferingPixels) {
    failures.push(`premultiplied checkout differs: ${JSON.stringify(premulAgreement)}`);
  }
  if (stats.colourAboveAlpha !== 0 || stats.colourAtZeroAlpha !== 0) failures.push(`premultiplied invariant failed: ${JSON.stringify(stats)}`);
  expectCount(`${item.id}.opaque`, stats.opaque, item.expect.opaque, total, failures);
  expectCount(`${item.id}.transparent`, stats.transparent, item.expect.transparent, total, failures);
  expectCount(`${item.id}.partial`, stats.partial, item.expect.partial, total, failures);
  if (item.expect.alphaIncludes !== undefined && analysis.alphaHistogram[item.expect.alphaIncludes] === 0) {
    failures.push(`${item.id}: alpha ${item.expect.alphaIncludes} is absent`);
  }
  if (item.expect.minDistinctAlphaValues !== undefined && stats.distinctAlphaValues < item.expect.minDistinctAlphaValues) {
    failures.push(`${item.id}: expected at least ${item.expect.minDistinctAlphaValues} alpha values, got ${stats.distinctAlphaValues}`);
  }
  if (item.expect.requireStraightDifference && straightContrast.differingPixels === 0) failures.push("straight-alpha falsification was not sensitive");

  const outcome = failures.length === 0 ? "pass" : "fail";
  if (failures.length > 0) failed = true;
  console.log(`${outcome.toUpperCase()} ${item.id}: premul diff=${premulAgreement.differingPixels}, straight diff=${straightContrast.differingPixels}, partial=${stats.partial}`);
  for (const failure of failures) console.error(`  ${failure}`);
  cases.push({
    id: item.id,
    composition: item.composition,
    outcome,
    failures,
    referencePixelSha256: reference.pixelSha256,
    checkoutPixelSha256: sha256(premulBytes),
    stats,
    premulAgreement,
    straightContrast,
    renderMs: premul.reply.renderMs,
    onHookThread: premul.reply.onHookThread,
    checkinError: premul.reply.checkinError,
  });
}

const record = {
  phase: "BO0a",
  recordedAt: new Date().toISOString(),
  verdict: failed ? "FAIL" : "PASS",
  fixture: basename(project),
  fixtureSha256: projectSha256,
  aeBuild: manifest.fixture.aeBuild,
  contract: manifest.render,
  tolerance: manifest.comparison,
  independence: "Every reference was exported through aerender.exe before this comparator started AE checkout. The comparator only reads those references and invokes adapter checkout.",
  cases,
};
writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`result: ${resultPath}`);
process.exit(failed ? 1 : 0);
