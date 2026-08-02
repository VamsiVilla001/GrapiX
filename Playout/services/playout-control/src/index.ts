import cors from "@fastify/cors";
import type {
  PlayoutTakeList,
  SceneDocument
} from "@grapix/shared-types";
import Fastify from "fastify";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineSupervisor } from "./engineSupervisor.js";
import { readAllowedPlayoutOrigins } from "./origins.js";
import { PlayoutEventBus } from "./events.js";
import {
  isMonitorChannel,
  isMonitorStreamTier,
  isMonitorView,
  MonitorHub
} from "./monitorHub.js";
import { duplicateInstanceMessage, inspectPort } from "./preflight.js";
import { PlayoutRuntime, type PlayoutTarget } from "./runtime.js";
import { PlayoutStore, SceneRemovalRefused, type PublishSceneOptions } from "./store.js";

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serviceDirectory, "../../../..");
const dataRoot = process.env.GRAPIX_PLAYOUT_DATA_DIR?.trim()
  ? path.resolve(process.env.GRAPIX_PLAYOUT_DATA_DIR)
  : path.join(repositoryRoot, "data", "playout");
const port = Number(process.env.GRAPIX_PLAYOUT_PORT ?? 4300);
const host = process.env.GRAPIX_PLAYOUT_HOST ?? "127.0.0.1";

// Before anything else, and specifically before the engine supervisor exists.
//
// `EngineSupervisor` connects from its constructor and Fastify binds last, so a duplicate
// launch would spend its entire startup as a phantom engine client — fighting the running
// service for the connection and making the engine look broken — and only then die on
// `EADDRINUSE`. Checking the port first costs one short probe and turns that into one line.
const occupant = await inspectPort(host, port);
if (occupant.occupied) {
  console.error(duplicateInstanceMessage(host, port, occupant));
  process.exit(1);
}

const startedAtMs = Date.now();
// mtime of the bundle this process loaded. Reported so a stale process serving the port is
// visible instead of being mistaken for a fix that did not work.
const buildAtMs = await stat(fileURLToPath(import.meta.url))
  .then((info) => info.mtimeMs)
  .catch(() => 0);

const store = new PlayoutStore(dataRoot);

// The standalone render engine (protocol v3). Playout owns this connection so
// Program keeps rendering when the Editor closes. It reconnects indefinitely, and
// a missing engine never stops the control service from starting.
const engine = new EngineSupervisor();

// Rundown operations run against the engine and nothing else. Constructed after the
// supervisor because the runtime consults it on every cue and take.
const runtime = new PlayoutRuntime(store, engine);

// The live link to every attached operator UI. Publishes and other library changes are
// pushed, so the UI never shows a stale library waiting for someone to press refresh.
const events = new PlayoutEventBus();

// Channel monitoring. Frames only flow while an operator is watching a panel, so this
// costs nothing on an unattended station. Started before any engine exists: the
// subscription outlives connections, so it picks up whichever engine appears.
const monitors = new MonitorHub(engine.engineController, { profileId: engine.id });
monitors.start();
const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 });

const allowedOrigins = readAllowedPlayoutOrigins();

await app.register(cors, {
  origin: (origin, callback) => {
    callback(null, origin === undefined || allowedOrigins.has(origin));
  }
});

/**
 * Liveness, plus enough to answer "is this the build I just made?".
 *
 * That question cost me an hour: a failed restart left an older process serving this port, so
 * a fix looked inert while I hunted it in source. `buildAtMs` is the mtime of the bundle this
 * process is actually running, so comparing it with the file on disk settles it immediately.
 */
app.get("/api/playout/health", async () => ({
  ok: true,
  service: "grapix-playout-control",
  dataRoot,
  pid: process.pid,
  startedAtMs: startedAtMs,
  /** Modification time of the running bundle, not of the source on disk. */
  buildAtMs: buildAtMs,
  /** Attached operator UIs. Zero means nothing would see a live library update. */
  liveSubscribers: events.subscriberCount()
}));

app.get("/api/playout/status", async () => runtime.checkConnection());

app.get("/api/playout/scenes", async () => store.listScenes());

app.get<{
  Params: { sceneId: string };
  Querystring: { version?: string };
}>("/api/playout/scenes/:sceneId", async (request, reply) => {
  const version = request.query.version
    ? Number(request.query.version)
    : undefined;
  const scene = await store.readScene(request.params.sceneId, version);
  if (!scene) {
    return reply.code(404).send({ error: "published scene not found" });
  }
  return scene;
});

app.post<{
  Body: { scene: SceneDocument; options?: PublishSceneOptions };
}>("/api/playout/scenes", async (request, reply) => {
  try {
    const metadata = await store.publishScene(
      request.body.scene,
      request.body.options
    );
    // Tell every attached operator UI immediately. Without this a publish landed in the
    // library and the operator kept looking at a list that did not contain it until they
    // happened to press refresh.
    events.emit({
      kind: "library.changed",
      detail: { sceneId: metadata.sceneId, version: metadata.version, reason: "published" }
    });
    return reply.code(201).send(metadata);
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

/**
 * Remove every published version of a scene.
 *
 * Fail-closed on the on-air check. The engine is the authority on what is on Program and
 * Preview, so if it cannot be reached this refuses rather than assuming the channels are
 * clear: the engine keeps rendering when this service restarts, so "I cannot see it" is not
 * the same as "nothing is on air".
 */
app.delete<{ Params: { sceneId: string }; Querystring: { force?: string } }>(
  "/api/playout/scenes/:sceneId",
  async (request, reply) => {
    const { sceneId } = request.params;
    const force = request.query.force === "true";

    let onAirSceneIds: string[] = [];
    const engineStatus = engine.status();
    if (engineStatus.connected) {
      try {
        const runtimeStatus = runtime.getStatus();
        onAirSceneIds = [runtimeStatus.programRef, runtimeStatus.previewRef]
          .filter((v): v is string => typeof v === "string" && v.startsWith("scene:take-"))
          .map((v) => v.replace("scene:take-", ""));
      } catch {
        onAirSceneIds = [];
      }
    } else {
      // Disconnected engine has no scenes rendering on GPU
      onAirSceneIds = [];
    }

    try {
      const removal = await store.removeScene(sceneId, { onAirSceneIds, force });
      events.emit({
        kind: "library.changed",
        detail: { sceneId, reason: "removed", versionsRemoved: removal.versionsRemoved }
      });
      return removal;
    } catch (error) {
      if (error instanceof SceneRemovalRefused) {
        return reply
          .code(error.reason === "NOT_FOUND" ? 404 : 409)
          .send({ error: error.message, reason: error.reason });
      }
      return reply.code(400).send({ error: errorMessage(error) });
    }
  }
);

/**
 * Sync scenes from the Editor project service (port 4100) into Playout.
 */
app.post("/api/playout/scenes/sync-editor", async (_request, reply) => {
  try {
    const result = await store.syncFromEditor();
    if (result.syncedCount > 0 || result.updatedCount > 0) {
      events.emit({
        kind: "library.changed",
        detail: { reason: "synced-editor", count: result.syncedCount + result.updatedCount }
      });
    }
    return result;
  } catch (error) {
    return reply.code(502).send({ error: errorMessage(error) });
  }
});

/**
 * The live link to the operator UI.
 *
 * Long-lived: the route hands the socket to the bus and returns without a body, so Fastify
 * must not be allowed to serialise a reply.
 */
app.get("/api/playout/events", async (request, reply) => {
  events.subscribe(reply);
  return reply;
});

// ---------------------------------------------------------------------------
// Channel monitors
// ---------------------------------------------------------------------------

/** Per-channel, per-view monitor state, so the UI can tell "no signal" from "not watching". */
app.get("/api/playout/monitors", async () => ({ channels: monitors.status() }));

/**
 * Watch a channel as MJPEG.
 *
 * `?view=fill` (default) is the colour an audience sees. `?view=key` is the greyscale matte
 * a downstream keyer cuts — the broadcast way to verify transparency, since SDI carries no
 * alpha and fill/key travel as separate signals. `?tier=confidence` keeps operator panels
 * small; `?tier=output` requests native project resolution for a windowed virtual output.
 *
 * `multipart/x-mixed-replace` rather than a WebSocket or base64 over the event bus,
 * because an `<img>` consumes it directly: the browser decodes JPEG off the main thread
 * and there is no per-frame JavaScript. On a station with two monitors open for a whole
 * show that difference is the operator UI staying responsive.
 *
 * The socket is handed to the monitor hub and the handler returns without a body, so
 * Fastify must not try to serialise a reply.
 */
app.get<{
  Params: { channel: string };
  Querystring: { view?: string; tier?: string };
}>(
  "/api/playout/monitor/:channel",
  async (request, reply) => {
    const { channel } = request.params;
    if (!isMonitorChannel(channel)) {
      return reply.code(404).send({ error: `unknown monitor channel ${channel}` });
    }
    const requestedView = request.query.view ?? "fill";
    if (!isMonitorView(requestedView)) {
      // Refused rather than defaulted to fill: an operator who asked for the key and was
      // shown the fill would be told the wrong thing about what is on air.
      return reply
        .code(400)
        .send({ error: `monitor view must be "fill" or "key"; got "${requestedView}"` });
    }
    const requestedTier = request.query.tier ?? "confidence";
    if (!isMonitorStreamTier(requestedTier)) {
      return reply
        .code(400)
        .send({
          error: `monitor tier must be "confidence" or "output"; got "${requestedTier}"`
        });
    }

    const boundary = "grapixframe";
    reply.raw.writeHead(200, {
      "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
      "cache-control": "no-store, no-transform",
      pragma: "no-cache",
      connection: "keep-alive",
      // Same reason as the event stream: the operator UI is always another origin.
      "access-control-allow-origin": request.headers.origin ?? "*"
    });
    // Sent now, not with the first frame. Node buffers the header until the first body
    // write, so a monitor opened on an empty channel would leave the client waiting on
    // headers for a frame that may never come — the request must succeed immediately and
    // then simply carry no parts until there is something to render.
    reply.raw.flushHeaders();

    const detach = monitors.subscribe(channel, requestedView, (frame) => {
      // Drop rather than queue. A monitor behind on the socket must show the next frame
      // late, not accumulate a backlog that grows memory and shows the past.
      if (reply.raw.writableNeedDrain) return;
      try {
        reply.raw.write(
          `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.bytes.length}\r\n\r\n`
        );
        reply.raw.write(frame.bytes);
        reply.raw.write("\r\n");
      } catch {
        // Socket died mid-write. The close handler below releases the stream.
      }
    }, requestedTier);

    reply.raw.on("close", detach);
    reply.raw.on("error", detach);
    return reply;
  }
);

// ---------------------------------------------------------------------------
// Take Lists
// ---------------------------------------------------------------------------

app.get("/api/playout/take-lists", async () => store.listTakeLists());

app.post<{ Body: { name?: string } }>(
  "/api/playout/take-lists/new",
  async (request, reply) =>
    reply.code(201).send(await store.createTakeList(request.body?.name))
);

app.get<{ Params: { takeListId: string } }>(
  "/api/playout/take-lists/:takeListId",
  async (request, reply) => {
    const takeList = await store.readTakeList(request.params.takeListId);
    if (!takeList) {
      return reply.code(404).send({ error: "take list not found" });
    }
    return takeList;
  }
);

app.post<{ Body: PlayoutTakeList }>(
  "/api/playout/take-lists",
  async (request, reply) => {
    try {
      const saved = await store.saveTakeList(request.body);
      events.emit({
        kind: "sequence.changed",
        detail: { takeListId: saved.takeListId, entries: saved.entries.length }
      });
      return saved;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  }
);

// ---------------------------------------------------------------------------
// Operator commands
// ---------------------------------------------------------------------------

/**
 * Cue, Take In, Take Out and Continue.
 *
 * A command names either a Scene Manager Take ID or a Take List entry. The body is validated
 * into a `PlayoutTarget` here so a malformed command is refused at the edge rather than
 * resolved into a surprising scene deeper in.
 */
app.post<{
  Params: { action: "cue" | "take" | "take-out" | "continue" };
  Body: { takeId?: number; takeListId?: string; entryId?: string };
}>("/api/playout/control/:action", async (request, reply) => {
  const { action } = request.params;

  try {
    if (action === "take-out") {
      const status = await runtime.takeOut();
      events.emit({ kind: "runtime.changed", detail: { action } });
      return status;
    }

    if (action === "continue") {
      const { takeListId } = request.body;
      if (!takeListId) {
        return reply.code(400).send({ error: "continue requires a takeListId" });
      }
      const advanced = await runtime.advanceCursor(takeListId);
      if (!advanced) {
        return reply.code(404).send({ error: "take list not found" });
      }
      events.emit({ kind: "sequence.changed", detail: { takeListId } });
      return { takeList: advanced, status: runtime.getStatus() };
    }

    const target = readTarget(request.body);
    if (!target) {
      return reply.code(400).send({
        error: "a command must name either a takeId or a takeListId with an entryId"
      });
    }

    const status = action === "cue" ? await runtime.cue(target) : await runtime.take(target);
    events.emit({ kind: "runtime.changed", detail: { action } });
    return status;
  } catch (error) {
    return reply.code(503).send({
      error: errorMessage(error),
      status: runtime.getStatus()
    });
  }
});

// ---------------------------------------------------------------------------
// Render engine (protocol v3)
// ---------------------------------------------------------------------------

app.get("/api/playout/engine", async () => engine.status());

app.get("/api/playout/engine/capabilities", async (_request, reply) => {
  const capabilities = engine.engineCapabilities();
  if (!capabilities) {
    return reply
      .code(503)
      .send({ error: "engine capabilities have not been negotiated yet" });
  }
  return capabilities;
});

app.get("/api/playout/engine/status", async (_request, reply) => {
  try {
    return await engine.requireConnected().status(engine.id);
  } catch (error) {
    return reply.code(503).send({ error: errorMessage(error) });
  }
});

app.get<{ Querystring: { tiles?: string } }>(
  "/api/playout/engine/diagnostics",
  async (request, reply) => {
    try {
      const controller = engine.requireConnected();
      // The per-tile table can be thousands of rows, so it is opt-in.
      const includeTiles = request.query.tiles === "true";
      return await controller.diagnostics(engine.id, includeTiles);
    } catch (error) {
      return reply.code(503).send({ error: errorMessage(error) });
    }
  }
);

app.post("/api/playout/engine/connect", async (_request, reply) => {
  const connected = await engine.connect();
  if (!connected) {
    return reply
      .code(503)
      .send({ error: engine.status().lastError ?? "connection failed" });
  }
  return engine.status();
});

/**
 * Publish a stored scene to the engine and prepare it.
 *
 * Playout supplies a published scene; it never authors one. Preparation is kept
 * separate from taking online, because an unprepared scene must not go on air.
 */
app.post<{ Body: { sceneId: string; version?: number; stageId?: string } }>(
  "/api/playout/engine/scenes",
  async (request, reply) => {
    try {
      const controller = engine.requireConnected();
      const scene = await store.readScene(
        request.body.sceneId,
        request.body.version
      );
      if (!scene) {
        return reply.code(404).send({ error: "published scene not found" });
      }

      await controller.load(engine.id, scene.scene, request.body.stageId);
      await controller.prepare(engine.id, scene.scene.id);
      return { loaded: scene.scene.id, revision: scene.scene.revision ?? 0 };
    } catch (error) {
      return reply.code(503).send({ error: errorMessage(error) });
    }
  }
);

/**
 * Output configuration.
 *
 * Two kinds exist and the difference is never implied: a live output (NDI or SDI)
 * puts pixels in front of an audience, and the virtual output renders the on-air
 * graphic headlessly so an operator can confirm a take without any risk of it going
 * out. The engine reports `live` per output and per adapter; this surface passes that
 * through untouched rather than deriving it from a name.
 */
app.get("/api/playout/engine/outputs", async (_request, reply) => {
  try {
    return await engine.requireConnected().outputs(engine.id);
  } catch (error) {
    return reply.code(503).send({ error: errorMessage(error) });
  }
});

app.post<{
  Body: {
    outputId: string;
    adapterId: string;
    width?: number;
    height?: number;
    frameRate?: { numerator: number; denominator: number };
    alphaMode?: "premultiplied" | "straight" | "opaque";
    colorSpace?: string;
    options?: Record<string, string | number | boolean>;
    /** Start it immediately. Off by default: configuring is not going on air. */
    start?: boolean;
  };
}>("/api/playout/engine/outputs", async (request, reply) => {
  const body = request.body ?? ({} as Record<string, never>);
  if (!body.outputId || !body.adapterId) {
    return reply.code(400).send({ error: "outputId and adapterId are required" });
  }
  // Dimensions are required rather than defaulted: an output that quietly inherited
  // 1920x1080 while the project is UHD would reach air at the wrong size.
  if (!body.width || !body.height) {
    return reply.code(400).send({
      error: "width and height are required; send the project resolution"
    });
  }

  try {
    const controller = engine.requireConnected();
    const format = {
      width: body.width,
      height: body.height,
      frameRate: body.frameRate ?? { numerator: 50, denominator: 1 },
      ...(body.alphaMode ? { alphaMode: body.alphaMode } : {}),
      ...(body.colorSpace ? { colorSpace: body.colorSpace } : {})
    };

    const warnings = await controller.configureOutput(
      engine.id,
      body.outputId,
      body.adapterId,
      format,
      body.options
    );

    if (body.start === true) {
      warnings.push(...(await controller.startOutput(engine.id, body.outputId)));
    }

    return { outputs: (await controller.outputs(engine.id)).outputs, warnings };
  } catch (error) {
    // The engine refusing an adapter the deployment did not enable is correct
    // behaviour, not a service fault.
    const message = errorMessage(error);
    const code = message.includes("not enabled") || message.includes("exceeds") ? 409 : 503;
    return reply.code(code).send({ error: message });
  }
});

app.post<{
  Params: { outputId: string; action: string };
}>("/api/playout/engine/outputs/:outputId/:action", async (request, reply) => {
  const { outputId, action } = request.params;

  try {
    const controller = engine.requireConnected();

    switch (action) {
      case "start": {
        const warnings = await controller.startOutput(engine.id, outputId);
        return { outputs: (await controller.outputs(engine.id)).outputs, warnings };
      }
      case "stop":
        await controller.stopOutput(engine.id, outputId);
        break;
      case "remove":
        await controller.removeOutput(engine.id, outputId);
        break;
      default:
        return reply.code(400).send({
          error: `unknown output action "${action}"`,
          supported: ["start", "stop", "remove"]
        });
    }

    return { outputs: (await controller.outputs(engine.id)).outputs, warnings: [] };
  } catch (error) {
    const message = errorMessage(error);
    // "live and running; stop it before removing it" is a deliberate refusal.
    const code = message.includes("live and running") ? 409 : 503;
    return reply.code(code).send({ error: message });
  }
});

/**
 * The operational verb set, and nothing else.
 *
 * There is deliberately no endpoint here that edits scene content: Playout's
 * authority is operations, and the command surface enforces that by omission.
 */
app.post<{
  Params: { action: string };
  Body: {
    sceneId?: string;
    sceneRevision?: number;
    channel?: "preview" | "program" | "auxiliary";
    overrideUnprepared?: boolean;
    transitionId?: string;
    durationFrames?: number;
    markerName?: string;
    data?: Record<string, unknown>;
    force?: boolean;
  };
}>("/api/playout/engine/command/:action", async (request, reply) => {
  const body = request.body ?? {};
  const { action } = request.params;

  const requireScene = (): string => {
    if (!body.sceneId) {
      throw new Error("sceneId is required for this command");
    }
    return body.sceneId;
  };

  try {
    const controller = engine.requireConnected();
    const channel = body.channel ?? "program";

    switch (action) {
      case "cue":
        await controller.cue(
          engine.id,
          requireScene(),
          body.sceneRevision ?? 0,
          body.channel ?? "preview"
        );
        break;

      case "take": {
        const result = await controller.takeOnline(
          engine.id,
          requireScene(),
          body.sceneRevision ?? 0,
          {
            ...(body.transitionId ? { transitionId: body.transitionId } : {}),
            ...(body.overrideUnprepared ? { overrideUnprepared: true } : {})
          }
        );
        if (!result.accepted) {
          // A refused Take is a 409, not a 500: the engine behaved correctly.
          return reply.code(409).send({
            error: result.refusedReason ?? "take refused",
            overridden: result.overridden
          });
        }
        return { ...engine.status(), overridden: result.overridden };
      }

      case "offair":
        await controller.takeOffline(engine.id, requireScene(), body.transitionId);
        break;

      case "continue":
        await controller.continueScene(
          engine.id,
          requireScene(),
          channel,
          body.markerName
        );
        break;

      case "update":
        await controller.update(
          engine.id,
          requireScene(),
          body.sceneRevision ?? 0,
          body.data ?? {}
        );
        break;

      case "stop":
        await controller.stop(engine.id, requireScene(), channel);
        break;

      case "clear":
        await controller.clear(engine.id, channel, body.transitionId);
        break;

      case "transition": {
        const sceneId = requireScene();
        if (!body.transitionId) {
          return reply.code(400).send({ error: "transitionId is required" });
        }
        // Frames, never milliseconds: 25 frames is exactly one second at 25 fps
        // whether the renderer is keeping up or not.
        await controller.transition(
          engine.id,
          sceneId,
          body.transitionId,
          body.durationFrames ?? 0,
          { channel }
        );
        break;
      }

      case "unload":
        await controller.unload(engine.id, requireScene(), body.force === true);
        break;

      default:
        return reply.code(400).send({
          error: `unknown engine command "${action}"`,
          supported: [
            "cue",
            "take",
            "offair",
            "continue",
            "update",
            "stop",
            "clear",
            "transition",
            "unload"
          ]
        });
    }

    return engine.status();
  } catch (error) {
    return reply.code(503).send({ error: errorMessage(error) });
  }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code(500).send({ error: errorMessage(error) });
});

await store.ensure();

try {
  await app.listen({ host, port });
} catch (error) {
  // The preflight above catches the ordinary duplicate launch. This is the race: another
  // process took the port between the probe and this bind. Release the engine before
  // exiting — the supervisor has been connected since module load, and leaving it to be
  // torn down by process exit is what made a duplicate launch look like an engine fault.
  const addressInUse =
    typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
  if (addressInUse) {
    console.error(duplicateInstanceMessage(host, port, await inspectPort(host, port)));
    engine.close();
    runtime.close();
    await monitors.close();
    process.exit(1);
  }
  throw error;
}

const shutdown = async () => {
  // Event streams first: an open SSE socket keeps node alive, so closing Fastify while one
  // is attached hangs the shutdown instead of ending it. An MJPEG monitor is the same
  // shape of problem, and it also owes the engine a streamStop.
  events.close();
  await monitors.close();
  engine.close();
  runtime.close();
  await app.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read an operator target out of a request body.
 *
 * Returns null when the body names neither or both, so an ambiguous command is refused rather
 * than silently resolved to whichever field the code happened to check first.
 */
function readTarget(body: {
  takeId?: number;
  takeListId?: string;
  entryId?: string;
}): PlayoutTarget | null {
  const hasTakeId = Number.isSafeInteger(body.takeId);
  const hasEntry = Boolean(body.takeListId && body.entryId);

  if (hasTakeId === hasEntry) {
    return null;
  }
  if (hasTakeId) {
    return { kind: "scene", takeId: body.takeId as number };
  }
  return {
    kind: "entry",
    takeListId: body.takeListId as string,
    entryId: body.entryId as string
  };
}
