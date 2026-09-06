#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const manifestPath = resolve(process.argv[2] ?? join(here, "v1/lower-third.json"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const root = dirname(manifestPath);
const resultPath = join(root, "lower-third-result.json");
const evidencePath = join(repo, "ae-plugin/runtime-adapter/certification/BO0a-lower-third-live.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const project = join(root, manifest.fixture.file);
if (sha256(readFileSync(project)) !== manifest.fixture.sha256) throw new Error("fixture digest mismatch");
if (!Array.isArray(manifest.comparisons) || manifest.comparisons.length === 0) throw new Error("LOWER_THIRD requires at least one declared comparison");
if (new Set(manifest.controls.map(({ id }) => id)).size !== 4) throw new Error("LOWER_THIRD must declare the four distinct controls");
const fromRepo = (relative) => pathToFileURL(join(repo, relative)).href;
const { AeRuntimeClient } = await import(fromRepo("Playout/services/playout-control/dist/aeRuntimeClient.js"));
const { AeControlService } = await import(fromRepo("Playout/services/playout-control/dist/aeControlService.js"));
const { AeRevisionService } = await import(fromRepo("Playout/services/playout-control/dist/aeRevisionService.js"));
const { AeDataRevisionTracker } = await import(fromRepo("Playout/services/playout-control/dist/aeDataRevisionTracker.js"));
const { resolveAeCueMap } = await import(fromRepo("Shared/animation-engine/dist/aeCueMap.js"));
const sessionId = process.env.GRAPIX_AE_RUNTIME_SESSION_ID;
const token = process.env.GRAPIX_AE_RUNTIME_TOKEN;
if (!sessionId || !token) throw new Error("managed runtime session credentials are required");
const client = new AeRuntimeClient({ sessionId, token, capabilities: ["project.discovery", "property.read", "property.write", "data.revision"] });
const rows = [];
let comparisonFailed = false;
const cueResolution = resolveAeCueMap(manifest.cueMap.markers, manifest.cueMap.rate, manifest.cueMap.clock);
// Compared canonically, not by `JSON.stringify` of the raw objects: key *order* is not a contract, and
// treating it as one turns adding a field to a resolved cue - `compositionTime` did exactly this - into a
// certification failure with identical values on both sides. Every value still has to match, and the
// digest above is the authoritative pin.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
if (
  !cueResolution.ok ||
  cueResolution.digest !== manifest.cueMap.digest ||
  JSON.stringify(canonical(cueResolution.cues)) !== JSON.stringify(canonical(manifest.cueMap.resolved))
) {
  throw new Error("declared cue map does not resolve to its pinned exact-time digest");
}
try {
  const hello = await client.connect();
  // A fingerprint that admits an armed fault must never produce certification evidence: the whole
  // point of injection is to make the adapter misbehave, so a run against it proves nothing about the
  // product. A missing field means an adapter that predates it — unknown, and equally not evidence.
  if (hello?.fingerprint?.faultInjection === undefined) {
    throw new Error("adapter fingerprint does not report faultInjection; this build cannot produce certification evidence");
  }
  if (hello.fingerprint.faultInjection !== null) {
    throw new Error(`adapter has a fault armed (${hello.fingerprint.faultInjection}); refusing to record certification evidence`);
  }
  const comps = await client.call("LIST_COMPOSITIONS", {}, { expectedProjectDigest: null });
  const layers = await client.call("LIST_LAYERS", { compositionItemId: manifest.render.compositionItemId }, { expectedProjectDigest: null });
  const composition = comps.result?.find((item) => item.itemId === manifest.render.compositionItemId && item.displayName === manifest.render.composition);
  if (!composition || !layers.ok) throw new Error("live fixture composition discovery mismatch");
  // The adapter reports the composition's own clock as `clock: {frameDuration, timeScale}` from
  // AEGP_GetCompFrameDuration, and omits it when the composition has no usable duration. The float
  // `frameRate` beside it is diagnostic only and is deliberately not compared.
  const liveClock = composition.clock;
  if (liveClock !== undefined) {
    const expected = manifest.render.clock;
    if (
      typeof liveClock?.frameDuration !== "string" || typeof liveClock?.timeScale !== "string"
      || !/^[1-9][0-9]*$/.test(liveClock.frameDuration) || !/^[1-9][0-9]*$/.test(liveClock.timeScale)
      || liveClock.frameDuration !== expected.frameDuration || liveClock.timeScale !== expected.timeScale
    ) {
      throw new Error(`live composition clock mismatch: expected ${expected.frameDuration}/${expected.timeScale}, got ${JSON.stringify(liveClock)}`);
    }
    rows.push({ type: "composition-clock", id: manifest.render.composition, outcome: "pass", expected, actual: liveClock });
  } else {
    rows.push({
      type: "composition-clock",
      id: manifest.render.composition,
      outcome: "not-run",
      reason: "clock unverified live: this AE build's LIST_COMPOSITIONS returned no exact AEGP_GetCompFrameDuration rational, so the manifest's measured clock is unconfirmed against the running composition"
    });
  }
  for (const control of manifest.controls) {
    const layer = layers.result.find((item) => item.layerId === control.target.layerId);
    if (!layer || layer.sourceItemId !== control.target.sourceItemId) throw new Error(`${control.id}: live layer/source mismatch`);
  }

  const validation = { status: "stale", reason: null, validatedProjectDigest: null, structuralFingerprint: null, validatedAt: null };
  const kind = { text: "text", "integer-text": "text", "image-source": "image", colour: "color" };
  const policy = { fast: "immediate", "preload-required": "on-cue" };
  const container = {
    schemaVersion: 1, id: manifest.id, name: manifest.render.composition, projectUri: manifest.fixture.file,
    projectDigest: manifest.fixture.sha256, profile: { aeVersion: manifest.fixture.aeBuild, renderer: "Mercury", workingColorSpace: "sRGB", frameRate: manifest.render.frameRate },
    compositions: [{ itemId: manifest.render.compositionItemId, name: manifest.render.composition, width: manifest.render.width, height: manifest.render.height, clock: manifest.render.clock }],
    cachePolicy: { mode: "none", maxPreparedFrames: 0 }, status: "ready", createdAt: "2026-08-17T00:00:00Z", updatedAt: "2026-08-17T00:00:00Z",
    controls: manifest.controls.map((control) => ({ controlId: control.id, displayName: control.id, kind: kind[control.kind], writable: true, updatePolicy: policy[control.updateClass], target: { ...control.target, propertyPath: control.productionProbe.path }, validation: { ...validation } })),
    dataBindings: manifest.controls.map((control) => ({ controlId: control.id, dataPath: `controls.${control.id}` }))
  };
  const controls = new AeControlService(client);
  for (const control of manifest.controls) {
    try { await controls.validate(container, control.id); rows.push({ type: "control", id: control.id, outcome: "pass" }); }
    catch (error) { rows.push({ type: "control", id: control.id, outcome: "not-run", reason: `${error.code ?? "VALIDATION_FAILED"}: ${error.message}` }); }
  }
  const revision = new AeRevisionService(controls, new AeDataRevisionTracker(join(root, ".runtime-state")), client);
  try {
    await revision.plan(container, { revision: 1, idempotencyKey: "7f1e1bb7-6a33-4956-b4d9-eaa82e4063c4", dataContext: { controls: { PLAYER_NAME: "MAYA RIVERA", SCORE: "042", PLAYER_IMAGE: "portrait-blue", TEAM_COLOR: "#0557FF" } } });
    rows.push({ type: "revision", id: "declared-controls", outcome: "pass" });
  } catch (error) { rows.push({ type: "revision", id: "declared-controls", outcome: "not-run", reason: `${error.code ?? "VALIDATION_FAILED"}: ${error.message}` }); }
  const dependency = await client.call("LIST_EFFECTS", { compositionItemId: manifest.render.compositionItemId, layerId: 17 }, { expectedProjectDigest: null });
  if (dependency.ok) {
    const actual = dependency.result.map((effect) => effect.matchName).sort();
    const expected = [...manifest.expectedDependencies.effects].sort();
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    rows.push({ type: "dependencies", id: "live-report", outcome: pass ? "pass" : "fail", expected, actual });
    comparisonFailed ||= !pass;
  } else rows.push({ type: "dependencies", id: "live-report", outcome: "not-run", reason: `${dependency.error.code}: ${dependency.error.message}` });

  for (const item of manifest.comparisons) {
    const refManifest = JSON.parse(readFileSync(join(root, item.reference, "manifest.json"), "utf8"));
    const ref = readFileSync(join(root, item.reference, "frames", refManifest.frames[0].file));
    const checkout = spawnSync("sh", [join(repo, "ae-plugin/runtime-adapter/send.sh"), "checkout", manifest.render.composition, String(item.frame), "8", item.matteMode, item.channelOrder], { cwd: repo, encoding: "utf8", timeout: 180000, env: { ...process.env, TIMEOUT_SECONDS: "150" } });
    if (checkout.status !== 0) throw new Error(`${item.id}: checkout failed: ${checkout.stderr || checkout.stdout}`);
    const reply = JSON.parse(checkout.stdout.trim().split(/\r?\n/).at(-1));
    const argb = readFileSync(reply.payloadPath);
    const rgba = Buffer.allocUnsafe(argb.length); for (let i = 0; i < argb.length; i += 4) { rgba[i] = argb[i + 1]; rgba[i + 1] = argb[i + 2]; rgba[i + 2] = argb[i + 3]; rgba[i + 3] = argb[i]; }
    const pixels = tiffPixels(ref); let differingPixels = 0; let maxChannelDelta = 0;
    for (let i = 0; i < rgba.length; i += 4) { let differs = false; for (let c = 0; c < 4; c += 1) { const delta = Math.abs(rgba[i + c] - pixels[i + c]); maxChannelDelta = Math.max(maxChannelDelta, delta); differs ||= delta !== 0; } if (differs) differingPixels += 1; }
    const pass = rgba.length === pixels.length && differingPixels <= item.tolerance.maxDifferingPixels && maxChannelDelta <= item.tolerance.maxChannelDelta;
    rows.push({ type: "comparison", id: item.id, outcome: pass ? "pass" : "fail", differingPixels, maxChannelDelta, tolerance: item.tolerance, referencePixelSha256: sha256(pixels), checkoutPixelSha256: sha256(rgba) });
    comparisonFailed ||= !pass;
  }
  for (const gate of manifest.externalGates) rows.push({ type: "external-gate", id: gate, outcome: "not-run", reason: "upstream or external prerequisite remains open" });
} finally { await client.close().catch(() => undefined); }
const record = { phase: "BO0a", fixture: manifest.id, fixtureSha256: manifest.fixture.sha256, recordedAt: new Date().toISOString(), verdict: comparisonFailed ? "FAIL" : "INCOMPLETE", rows };
for (const row of rows) console.log(`${row.outcome.toUpperCase()} ${row.type} ${row.id}${row.reason ? ` — ${row.reason}` : ""}`);
writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`);
writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`);
process.exit(comparisonFailed ? 1 : 0);

function tiffPixels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const little = view.getUint16(0, true) === 0x4949; const u16 = (n) => view.getUint16(n, little); const u32 = (n) => view.getUint32(n, little); const sizes = { 1: 1, 3: 2, 4: 4 }; const tags = new Map(); const ifd = u32(4);
  for (let i = 0; i < u16(ifd); i += 1) { const at = ifd + 2 + i * 12; const type = u16(at + 2); const count = u32(at + 4); const base = (sizes[type] ?? 1) * count <= 4 ? at + 8 : u32(at + 8); const values = []; for (let n = 0; n < count; n += 1) values.push(type === 3 ? u16(base + n * 2) : u32(base + n * 4)); tags.set(u16(at), values); }
  return Buffer.concat((tags.get(273) ?? []).map((offset, i) => bytes.subarray(offset, offset + tags.get(279)[i])));
}
