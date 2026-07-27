#!/usr/bin/env node

/**
 * Live local soak harness. It intentionally defaults to 60 seconds; set
 * GRAPIX_SOAK_MINUTES=480 or 1440 for the reviewed 8/24-hour gates.
 * API + native daemon must already be supervised and running.
 */

const api = process.env.GRAPIX_API_URL ?? "http://127.0.0.1:4100";
const durationMinutes = Number(process.env.GRAPIX_SOAK_MINUTES ?? "1");
const durationMs = Math.max(0.05, durationMinutes) * 60_000;
const scenes = Array.from({ length: 80 }, (_, index) => scene(index));
const startedAt = Date.now();
const samples = [];
let takes = 0;
let patches = 0;
let automationActions = 0;

for (const document of scenes) {
  await request("/api/scenes", { method: "POST", body: document });
}

await request("/api/render-daemon/resource-profile", {
  method: "POST",
  body: { profile: "EDITOR_PREVIEW" }
});
await request("/api/render-daemon/output/configure", {
  method: "POST",
  body: {
    width: 640,
    height: 360,
    frameRateNumerator: 60,
    frameRateDenominator: 1,
    scanMode: "p",
    alphaMode: "premultiplied",
    colorFormat: "bgra8",
    colorSpace: "srgb",
    ndiSourceName: "GrapiX Certification",
    recordingName: "certification-soak",
    backend: "null"
  }
});

await request("/api/rundowns", {
  method: "POST",
  body: {
    rundownId: "certification_rundown",
    name: "Certification Rundown",
    version: 1,
    activeSequenceId: "main",
    variables: { armed: true },
    sequences: [{
      sequenceId: "main",
      name: "Main",
      fps: 60,
      durationFrames: 600,
      tracks: [{
        trackId: "program",
        name: "Program",
        role: "program",
        enabled: true,
        cues: [{
          cueId: "automation_take",
          name: scenes[1].name,
          sceneId: scenes[1].id,
          startFrame: 0,
          durationFrames: 300,
          prewarmFrames: 60,
          autoTake: false
        }]
      }],
      transitions: [{
        transitionId: "cut",
        name: "Cut",
        kind: "cut",
        durationFrames: 0,
        easing: "linear"
      }],
      triggers: [{
        triggerId: "armed_take",
        name: "Armed automation Take",
        enabled: true,
        event: { type: "api", name: "certification.take" },
        condition: {
          kind: "compare",
          left: { source: "rundown-variable", path: "armed" },
          operator: "eq",
          right: { source: "literal", value: true }
        },
        actions: [{ type: "take-scene", sceneId: scenes[1].id }],
        priority: 100
      }]
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
});
const automation = await request("/api/rundowns/certification_rundown/events", {
  method: "POST",
  body: {
    event: {
      type: "api",
      name: "certification.take",
      timestampMs: Date.now(),
      payload: {}
    },
    execute: true
  }
});
automationActions = automation.execution.filter((item) => item.status === "completed").length;
if (automationActions !== 1) {
  throw new Error(`automation certification action did not complete: ${JSON.stringify(automation.execution)}`);
}

await request(`/api/render-daemon/scenes/${scenes[0].id}/take`, { method: "POST" });
await request("/api/render-daemon/output/start", { method: "POST" });

try {
  for (let iteration = 0; Date.now() - startedAt < durationMs; iteration += 1) {
    const target = scenes[iteration % scenes.length];
    await request(`/api/render-daemon/scenes/${target.id}/preview`, { method: "POST" });
    await request(`/api/render-daemon/scenes/${target.id}/take`, { method: "POST" });
    takes += 1;
    await request(`/api/scenes/${target.id}/data-patches`, {
      method: "PATCH",
      body: { path: "liveValue", value: iteration }
    });
    patches += 1;
    const status = await request("/api/render-daemon/status");
    samples.push({
      atMs: Date.now() - startedAt,
      framesRendered: status.reply.output.framesRendered,
      framesDropped: status.reply.output.framesDropped,
      averageRenderMs: status.reply.output.averageRenderMs,
      p99RenderMs: status.reply.output.p99RenderMs,
      cacheBytes: status.reply.estimatedCacheBytes,
      assetGpuBytes: status.reply.assetCache.gpuBytes
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  await request("/api/render-daemon/output/stop", { method: "POST" }).catch(() => undefined);
}

const final = samples.at(-1);
const report = {
  startedAt: new Date(startedAt).toISOString(),
  endedAt: new Date().toISOString(),
  requestedMinutes: durationMinutes,
  sceneCount: scenes.length,
  takes,
  patches,
  automationActions,
  samples: samples.length,
  final,
  pass: Boolean(final && final.framesRendered > 0 && final.framesDropped === 0),
  limitations: [
    "This is a local null-output soak unless backend configuration is changed.",
    "Hardware, NDI, DeckLink/AJA, video decode, device-loss, and 8/24-hour certification remain separate gates."
  ]
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;

async function request(path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(value)}`);
  }
  return value;
}

function scene(index) {
  const group = index < 20 ? "simple-2d"
    : index < 35 ? "data-lower-third"
      : index < 45 ? "score-statistics"
        : index < 55 ? "video"
          : index < 65 ? "transition"
            : index < 70 ? "multi-video"
              : index < 75 ? "3d"
                : "mixed-heavy";
  const timestamp = `2026-07-25T00:${String(index).padStart(2, "0")}:00.000Z`;
  return {
    id: `cert_${String(index).padStart(2, "0")}`,
    name: `Certification ${group} ${index}`,
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#07111f" },
    dataContext: { group, liveValue: 0 },
    assets: [],
    materials: [],
    objects: [{
      id: `rect_${index}`, name: "Plate", type: "rect",
      x: 100, y: 700, zDepth: 0, zIndex: 0, layerId: "main",
      width: 800, height: 180, rotation: 0, opacity: 1,
      visible: true, locked: false, fill: "#164e82",
      stroke: "#ffffff", strokeWidth: 0, bindings: {}, materialSlots: {}, radius: 0
    }],
    timeline: { fps: 60, durationFrames: 600, keyframes: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
