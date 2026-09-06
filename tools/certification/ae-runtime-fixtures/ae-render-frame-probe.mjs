#!/usr/bin/env node
/**
 * Measure the *frame* path over the runtime protocol: `RENDER_FRAME`, pipelined, into the AE-F1 ring.
 *
 * `AE-F3` measured the legacy file channel at ~21 fps and proved the cost was dispatch rather than
 * pixels. The dispatch fix lifted operations 8x on `HEALTH`; this probe answers the question that
 * actually gates the soak — how many 1920x1080 frames per second survive when the operation being
 * pipelined is a *render*, whose cost is real.
 *
 * Requires `ae-ring-drain` running against the same session: a four-slot ring with no consumer refuses
 * after four frames, and a rate measured that way is the refusal path, not the frame path.
 *
 * Usage:
 *   node ae-render-frame-probe.mjs --item 1 --frames 300 --inflight 4 [--rate 2997/100]
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const sessionId = process.env.GRAPIX_AE_RUNTIME_SESSION_ID;
const token = process.env.GRAPIX_AE_RUNTIME_TOKEN;
if (!sessionId || !token) throw new Error("GRAPIX_AE_RUNTIME_SESSION_ID and GRAPIX_AE_RUNTIME_TOKEN are required");

const compositionItemId = Number(argument("item", "1"));
const frameCount = Number(argument("frames", "300"));
const inFlight = Math.max(1, Number(argument("inflight", "4")));
const durationFrames = Number(argument("duration-frames", "300"));
const [rateNumerator, rateDenominator] = String(argument("rate", "2997/100")).split("/").map(Number);
const evidencePath = argument("evidence", null);
const pipeName = `\\\\.\\pipe\\grapix-ae-runtime-${sessionId}`;
const framePeriodNanos = Math.floor((1_000_000_000 * rateDenominator) / rateNumerator);

function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(data.length);
  return Buffer.concat([head, data]);
}

const socket = net.connect(pipeName);
let buffered = Buffer.alloc(0);
const pending = new Map();
const events = { ready: 0, failed: 0, codes: new Set() };
let helloResolve;
const hello = new Promise((resolve) => { helloResolve = resolve; });

socket.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const size = buffered.readUInt32BE(0);
    const value = JSON.parse(buffered.subarray(4, 4 + size));
    buffered = buffered.subarray(4 + size);
    if (value.kind === "hello-ack") { helloResolve(value); continue; }
    if (value.kind === "event") {
      if (value.event === "RENDER_READY") events.ready += 1;
      if (value.event === "RENDER_FAILED") {
        events.failed += 1;
        if (value.detail?.error?.code) events.codes.add(value.detail.error.code);
      }
      continue;
    }
    const waiter = pending.get(value.requestId);
    if (waiter) { pending.delete(value.requestId); waiter(value); }
  }
});

await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
socket.write(frame({
  kind: "hello", protocolMajor: 2, protocolMinor: 0, sessionId, token,
  capabilities: ["project.discovery", "render.readiness"]
}));
const ack = await hello;
if (ack.kind !== "hello-ack") throw new Error(`HELLO refused: ${JSON.stringify(ack)}`);

let sequence = 0;
function send(operation, payload, deadlineMs = 60_000) {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  const settled = new Promise((resolve) => pending.set(requestId, resolve));
  socket.write(frame({
    kind: "request", protocolMajor: 2, protocolMinor: 0, sessionId, requestId,
    sequence: ++sequence, idempotencyKey: randomUUID(), deadlineUnixMs: Date.now() + deadlineMs,
    expectedProjectDigest: null, operation, payload
  }));
  return settled.then((reply) => ({ reply, latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6 }));
}

const before = (await send("HEALTH", {})).reply.result;
const compositions = (await send("LIST_COMPOSITIONS", {})).reply.result ?? [];
const composition = compositions.find((entry) => entry.itemId === compositionItemId) ?? compositions[0];
if (!composition) throw new Error("the open project reports no compositions");
if (!composition.clock) throw new Error(`composition ${composition.displayName} reports no exact clock`);
const clock = composition.clock;

const latencies = [];
const refusals = [];
const ringOutcomes = new Map();
let issued = 0;
let completed = 0;

async function pump() {
  while (issued < frameCount) {
    const index = issued;
    issued += 1;
    const compositionFrame = index % durationFrames;
    const { reply, latencyMs } = await send("RENDER_FRAME", {
      compositionItemId: composition.itemId,
      // Exact instant in the composition's own scale: frame x frameDuration, never a float.
      time: { value: String(BigInt(clock.frameDuration) * BigInt(compositionFrame)), scale: clock.timeScale },
      dataRevision: 0,
      renderRequestId: `probe-${index}`,
      frameId: index + 1,
      presentationDeadlineNanos: String((index + 1) * framePeriodNanos)
    });
    completed += 1;
    if (reply.ok) {
      latencies.push(latencyMs);
      const outcome = reply.result?.ringPublish?.outcome ?? "none";
      ringOutcomes.set(outcome, (ringOutcomes.get(outcome) ?? 0) + 1);
    } else {
      refusals.push(reply.error?.code ?? "unknown");
    }
  }
}

const startedAt = process.hrtime.bigint();
await Promise.all(Array.from({ length: inFlight }, () => pump()));
const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
const after = (await send("HEALTH", {})).reply.result;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] * 1000) / 1000;
}

const ticks = (after.idleTicks ?? 0) - (before.idleTicks ?? 0);
const targetFps = rateNumerator / rateDenominator;
const measuredFps = latencies.length / elapsedSeconds;
const evidence = {
  phase: "AE-F3",
  kind: "render-frame-throughput-probe",
  recordedAt: new Date().toISOString(),
  claim: "Measures 1920x1080 RENDER_FRAME throughput over the runtime protocol, pipelined, with the ring drained by ae-ring-drain. It is not the 30-minute soak and closes no gate.",
  adapter: {
    sha256: ack.fingerprint?.adapterSha256 ?? null,
    aeVersion: ack.fingerprint?.aeVersion ?? null,
    idleMaxOpsPerCallback: after.idleMaxOpsPerCallback ?? null,
    idleBudgetMicros: after.idleBudgetMicros ?? null
  },
  request: {
    composition: composition.displayName,
    compositionItemId: composition.itemId,
    geometry: `${composition.width}x${composition.height}`,
    clock,
    frames: frameCount,
    inFlight,
    pinnedRate: `${rateNumerator}/${rateDenominator}`,
    targetFps: Math.round(targetFps * 1000) / 1000
  },
  measured: {
    completed,
    rendered: latencies.length,
    refused: refusals.length,
    elapsedSeconds: Math.round(elapsedSeconds * 1000) / 1000,
    framesPerSecond: Math.round(measuredFps * 1000) / 1000,
    realTimeRatio: Math.round((measuredFps / targetFps) * 1000) / 1000,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: percentile(latencies, 1)
    }
  },
  idleCadence: {
    callbacks: ticks,
    meanPeriodMicros: ticks > 0 ? Math.round(((after.idleElapsedMicros ?? 0) - (before.idleElapsedMicros ?? 0)) / ticks) : null,
    framesPerCallback: ticks > 0 ? Math.round((latencies.length / ticks) * 100) / 100 : null,
    // The cost of a bigger budget: if servicing a batch starves After Effects' own callback, the worst
    // gap between callbacks grows. Throughput that arrives by wedging the host is not throughput.
    maxGapMicros: after.idleMaxGapMicros ?? null
  },
  ring: Object.fromEntries(ringOutcomes),
  renderEvents: { ready: events.ready, failed: events.failed, failureCodes: [...events.codes] },
  refusalCodes: [...new Set(refusals)],
  payloadWritten: false
};

socket.end();
if (evidencePath) {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify(evidence, null, 2));
