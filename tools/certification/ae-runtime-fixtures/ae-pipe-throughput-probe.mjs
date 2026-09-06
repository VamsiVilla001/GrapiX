#!/usr/bin/env node
/**
 * Measure the runtime pipe's *dispatch* ceiling, separately from rendering.
 *
 * `AE-F3` measured the frame path at ~21 Hz and showed the cost was dispatch, not pixels: an unknown
 * verb and a full 1920x1080 checkout took the same ~46 ms. Two things caused that, and this probe
 * measures both away from the render path, using `HEALTH` — the cheapest operation the protocol has.
 *
 *   1. The pipe reader waited for each completion before reading the next frame, so only one request
 *      could ever be in flight.
 *   2. The idle hook serviced exactly one request per callback.
 *
 * `--inflight N` sends N requests before reading any reply. With a serial reader the sustained rate is
 * unchanged by N; with a pipelined one it rises until the per-callback batch bound is reached, which is
 * how the two limits are told apart.
 *
 * HEALTH also reports the adapter's own idle cadence, so the run prints the callback period it
 * observed rather than inferring it.
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
if (!sessionId || !token) {
  throw new Error("GRAPIX_AE_RUNTIME_SESSION_ID and GRAPIX_AE_RUNTIME_TOKEN are required");
}
const operations = Number(argument("operations", "600"));
const inFlight = Number(argument("inflight", "8"));
const evidencePath = argument("evidence", null);
const pipeName = `\\\\.\\pipe\\grapix-ae-runtime-${sessionId}`;

function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(data.length);
  return Buffer.concat([head, data]);
}

const socket = net.connect(pipeName);
let buffered = Buffer.alloc(0);
const pending = new Map();
const events = [];
let helloResolve;
const hello = new Promise((resolve) => { helloResolve = resolve; });

socket.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const size = buffered.readUInt32BE(0);
    const value = JSON.parse(buffered.subarray(4, 4 + size));
    buffered = buffered.subarray(4 + size);
    if (value.kind === "hello-ack") { helloResolve(value); continue; }
    if (value.kind === "event") { events.push(value); continue; }
    const waiter = pending.get(value.requestId);
    if (waiter) {
      pending.delete(value.requestId);
      waiter(value);
    }
  }
});

await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
socket.write(frame({
  kind: "hello", protocolMajor: 2, protocolMinor: 0, sessionId, token,
  capabilities: ["project.discovery"]
}));
const ack = await hello;
if (ack.kind !== "hello-ack") throw new Error(`HELLO refused: ${JSON.stringify(ack)}`);

let sequence = 0;
/** Send one request and return a promise for its reply, without waiting for it here. */
function send(operation, payload) {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  const settled = new Promise((resolve) => pending.set(requestId, resolve));
  socket.write(frame({
    kind: "request", protocolMajor: 2, protocolMinor: 0, sessionId, requestId,
    sequence: ++sequence, idempotencyKey: randomUUID(), deadlineUnixMs: Date.now() + 30_000,
    expectedProjectDigest: null, operation, payload
  }));
  return settled.then((reply) => ({
    reply,
    latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6
  }));
}

const before = (await send("HEALTH", {})).reply.result;

// Keep exactly `inFlight` requests outstanding: issue that many, then issue one more per completion.
const latencies = [];
const refusals = [];
let completed = 0;
let issued = 0;
const startedAt = process.hrtime.bigint();

async function pump() {
  while (issued < operations) {
    const mine = send("HEALTH", {});
    issued += 1;
    const { reply, latencyMs } = await mine;
    if (reply.ok) latencies.push(latencyMs);
    else refusals.push(reply.error?.code ?? "unknown");
    completed += 1;
  }
}
await Promise.all(Array.from({ length: Math.max(1, inFlight) }, () => pump()));
const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
const after = (await send("HEALTH", {})).reply.result;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] * 1000) / 1000;
}

const ticks = (after.idleTicks ?? 0) - (before.idleTicks ?? 0);
const idleElapsedMicros = (after.idleElapsedMicros ?? 0) - (before.idleElapsedMicros ?? 0);
const evidence = {
  phase: "AE-F3",
  kind: "pipe-dispatch-throughput-probe",
  recordedAt: new Date().toISOString(),
  claim: "Measures how many runtime-protocol operations the adapter completes per second, away from the render path, at a given client pipelining depth.",
  adapter: {
    sha256: ack.fingerprint?.adapterSha256 ?? null,
    aeVersion: ack.fingerprint?.aeVersion ?? null,
    idleMaxOpsPerCallback: after.idleMaxOpsPerCallback ?? null,
    idleBudgetMicros: after.idleBudgetMicros ?? null
  },
  request: { operation: "HEALTH", operations, inFlight },
  measured: {
    completed,
    refused: refusals.length,
    elapsedSeconds: Math.round(elapsedSeconds * 1000) / 1000,
    operationsPerSecond: Math.round((completed / elapsedSeconds) * 1000) / 1000,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: percentile(latencies, 1)
    }
  },
  idleCadence: {
    callbacks: ticks,
    elapsedMicros: idleElapsedMicros,
    meanPeriodMicros: ticks > 0 ? Math.round(idleElapsedMicros / ticks) : null,
    maxGapMicrosSinceLoad: after.idleMaxGapMicros ?? null,
    operationsPerCallback: ticks > 0 ? Math.round((completed / ticks) * 100) / 100
      : null
  },
  refusalCodes: [...new Set(refusals)]
};

socket.end();
if (evidencePath) {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify(evidence, null, 2));
