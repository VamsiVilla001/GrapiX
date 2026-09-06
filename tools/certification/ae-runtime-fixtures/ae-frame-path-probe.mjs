#!/usr/bin/env node
/**
 * AE-F3 pre-work: measure what the live frame path can actually sustain.
 *
 * `AE-F3`'s exit gate asks for **thirty consecutive minutes at a pinned rate** through
 * checkout -> ring -> Program. Before that can be attempted, one number has to exist and does not:
 * how fast the current path can evaluate and publish a 1920x1080 frame at all. This probe measures
 * it against the licensed host, per frame, and reports the distribution rather than an average.
 *
 * It is deliberately a *probe*, not the soak: it drives the adapter's own legacy command channel
 * directly (fast-polling, unlike `send.sh`, whose one-second sleep would cap any measurement at 1 Hz)
 * and it does not pretend to be the production request path — there isn't one yet, which is itself
 * one of the findings.
 *
 * Usage:
 *   node ae-frame-path-probe.mjs --frames 60 [--composition LOWER_THIRD] [--ring] [--rate 2997/100]
 *
 * `--ring` publishes into the AE-F1 shared-memory ring with **no consumer attached**, which is how
 * the bounded ring's back-pressure refusal is observed live rather than asserted.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const stateDir = process.env.GRAPIX_AE_ADAPTER_DIR
  ?? path.join(process.env.LOCALAPPDATA ?? "", "GrapiX", "ae-adapter");
const commandFile = path.join(stateDir, "command.txt");
const sequenceFile = path.join(stateDir, "sequence.txt");
const resultFile = path.join(stateDir, "result.json");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const wantsRing = process.argv.includes("--ring");
const composition = argument("composition", "LOWER_THIRD");
const frameCount = Number(argument("frames", "60"));
const [rateNumerator, rateDenominator] = String(argument("rate", "2997/100")).split("/").map(Number);
const evidencePath = argument("evidence", null);
// A frame that takes seconds has already failed a 29.97 gate, so the default deadline is short: a
// 120-second wait spends the whole probe on one stalled command and hides the distribution.
const commandTimeoutMs = Number(argument("command-timeout-ms", "5000"));

if (!existsSync(stateDir)) {
  throw new Error(`adapter state directory not found: ${stateDir}; is After Effects running with the adapter installed?`);
}
if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
  throw new Error("--frames must be a positive integer");
}

const framePeriodNanos = Math.floor((1_000_000_000 * rateDenominator) / rateNumerator);
let sequence = existsSync(sequenceFile) ? Number(readFileSync(sequenceFile, "utf8").trim()) : 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the reply for `wanted`, tolerating the adapter's atomic replace mid-read. */
function replyFor(wanted) {
  try {
    const text = readFileSync(resultFile, "utf8");
    if (!text.includes(`"sequence":${wanted},`)) return null;
    return JSON.parse(text.trim().split(/\r?\n/).at(-1));
  } catch (error) {
    if (["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(error.code)) return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function command(args, timeoutMs = commandTimeoutMs) {
  sequence += 1;
  const mine = sequence;
  const line = [String(mine), ...args.map((value) => `"${value}"`)].join(" ");
  writeFileSync(commandFile, `${line}\n`);
  writeFileSync(sequenceFile, String(mine));

  const startedAt = process.hrtime.bigint();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = replyFor(mine);
    if (reply) {
      return { reply, roundTripMs: Number(process.hrtime.bigint() - startedAt) / 1e6 };
    }
    // 2 ms, because the thing being measured is tens of milliseconds and the poll must not be the
    // dominant term. `send.sh` sleeps a whole second, which would report 1 Hz for any workload.
    await sleep(2);
  }
  throw new Error(`timed out waiting for sequence ${mine} (${args.join(" ")})`);
}

const health = await command(["ping"]);
const durationFrames = 300; // LOWER_THIRD is 300 frames; the probe cycles inside the composition.

const samples = [];
const failures = [];
let ringPublished = 0;
let ringBackPressured = 0;
let ringRefused = 0;
let payloadBytesWritten = 0;

const probeStartedAt = process.hrtime.bigint();
for (let index = 0; index < frameCount; index += 1) {
  const frame = index % durationFrames;
  const args = ["checkout", composition, String(frame), "8", "premul-black", "argb"];
  if (wantsRing) {
    args.push(
      "ring",
      `probe-${index}`,
      "0",
      String(index + 1),
      String((index + 1) * framePeriodNanos)
    );
  }

  try {
    const { reply, roundTripMs } = await command(args);
    // The adapter answers `ok:true` **with a `reason`** for an unknown verb, so a probe that trusts
    // `ok` alone measures the cost of being misunderstood rather than the cost of a frame. An
    // accepted checkout always reports its own geometry; require that instead of the flag.
    if (reply.ok !== true || reply.reason !== undefined || reply.width === undefined) {
      failures.push({
        frame,
        reason: reply.reason ?? "reply did not describe a checked-out frame",
        aeError: reply.aeError
      });
      continue;
    }

    payloadBytesWritten += Number(reply.payloadBytes ?? 0);
    // The adapter reports a single `outcome` string — `published`, `backpressure`, `refused` or
    // `not-requested` — not booleans.
    const publish = reply.ringPublish ?? null;
    if (publish?.outcome === "published") ringPublished += 1;
    else if (publish?.outcome === "backpressure") ringBackPressured += 1;
    else if (publish?.outcome === "refused") ringRefused += 1;

    samples.push({
      frame,
      roundTripMs,
      renderMs: Number(reply.renderMs ?? 0),
      payloadBytes: Number(reply.payloadBytes ?? 0),
      ring: publish ? { outcome: publish.outcome ?? null, code: publish.code ?? null } : null
    });
  } catch (error) {
    failures.push({ frame, reason: error.message });
  }
}
const elapsedSeconds = Number(process.hrtime.bigint() - probeStartedAt) / 1e9;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return Math.round(sorted[index] * 1000) / 1000;
}

const roundTrips = samples.map((sample) => sample.roundTripMs);
const renders = samples.map((sample) => sample.renderMs);
const sustainedFps = samples.length / elapsedSeconds;
const targetFps = rateNumerator / rateDenominator;

const evidence = {
  phase: "AE-F3",
  kind: "frame-path-throughput-probe",
  recordedAt: new Date().toISOString(),
  claim: "Measures the sustainable rate and per-frame cost of the current checkout path on the licensed host. It is not the AE-F3 soak and closes no gate.",
  host: {
    afterEffectsPid: health.reply.hostPid ?? null,
    driver: `${health.reply.driverMajor ?? "?"}.${health.reply.driverMinor ?? "?"}`,
    stateDir
  },
  request: {
    composition,
    frames: frameCount,
    ringMode: wantsRing,
    ringConsumerAttached: false,
    pinnedRate: `${rateNumerator}/${rateDenominator}`,
    targetFps: Math.round(targetFps * 1000) / 1000
  },
  measured: {
    completed: samples.length,
    failed: failures.length,
    elapsedSeconds: Math.round(elapsedSeconds * 1000) / 1000,
    sustainedFps: Math.round(sustainedFps * 1000) / 1000,
    realTimeRatio: Math.round((sustainedFps / targetFps) * 1000) / 1000,
    roundTripMs: {
      p50: percentile(roundTrips, 0.5),
      p95: percentile(roundTrips, 0.95),
      p99: percentile(roundTrips, 0.99),
      max: percentile(roundTrips, 1)
    },
    aeRenderMs: {
      p50: percentile(renders, 0.5),
      p95: percentile(renders, 0.95),
      max: percentile(renders, 1)
    },
    payloadBytesWritten,
    payloadBytesPerFrame: samples.length > 0 ? Math.round(payloadBytesWritten / samples.length) : 0
  },
  ring: wantsRing
    ? {
        published: ringPublished,
        backPressured: ringBackPressured,
        refusedOther: ringRefused,
        note: "No consumer was attached, so a bounded ring must refuse rather than overwrite once every slot holds a ready frame."
      }
    : null,
  failures: failures.slice(0, 20),
  extrapolation: {
    thirtyMinutesAtPinnedRate: Math.round(targetFps * 1800),
    framesThirtyMinutesWouldTakeAtMeasuredRate: Math.round(sustainedFps * 1800),
    payloadBytesForThirtyMinutesAtPinnedRate:
      samples.length > 0
        ? Math.round((payloadBytesWritten / samples.length) * targetFps * 1800)
        : 0
  }
};

if (evidencePath) {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify(evidence, null, 2));
if (samples.length === 0) process.exitCode = 1;
