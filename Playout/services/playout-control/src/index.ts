import cors from "@fastify/cors";
import type {
  PlayoutRundownDocument,
  SceneDocument
} from "@grapix/shared-types";
import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineSupervisor } from "./engineSupervisor.js";
import { NativeRendererClient } from "./rendererClient.js";
import { PlayoutRuntime } from "./runtime.js";
import { PlayoutStore, type PublishSceneOptions } from "./store.js";

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serviceDirectory, "../../../..");
const dataRoot = process.env.GRAPIX_PLAYOUT_DATA_DIR?.trim()
  ? path.resolve(process.env.GRAPIX_PLAYOUT_DATA_DIR)
  : path.join(repositoryRoot, "data", "playout");
const port = Number(process.env.GRAPIX_PLAYOUT_PORT ?? 4300);
const host = process.env.GRAPIX_PLAYOUT_HOST ?? "127.0.0.1";

const store = new PlayoutStore(dataRoot);

// The standalone render engine (protocol v3). Playout owns this connection so
// Program keeps rendering when the Editor closes. It reconnects indefinitely, and
// a missing engine never stops the control service from starting.
const engine = new EngineSupervisor();

// Rundown operations prefer the engine and fall back to the v2 daemon. Constructed
// after the supervisor because the runtime consults it on every cue and take.
const runtime = new PlayoutRuntime(store, new NativeRendererClient(), engine);
const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 });

await app.register(cors, {
  origin: (origin, callback) => {
    const allowed =
      origin === undefined ||
      origin === "http://127.0.0.1:5174" ||
      origin === "http://localhost:5174" ||
      origin === "tauri://localhost" ||
      origin === "https://tauri.localhost";
    callback(null, allowed);
  }
});

app.get("/api/playout/health", async () => ({
  ok: true,
  service: "grapix-playout-control",
  dataRoot
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
    return reply.code(201).send(metadata);
  } catch (error) {
    return reply.code(400).send({ error: errorMessage(error) });
  }
});

app.get("/api/playout/rundowns", async () => store.listRundowns());

app.post<{ Body: { name?: string } }>(
  "/api/playout/rundowns/new",
  async (request, reply) =>
    reply.code(201).send(await store.createRundown(request.body?.name))
);

app.get<{ Params: { rundownId: string } }>(
  "/api/playout/rundowns/:rundownId",
  async (request, reply) => {
    const rundown = await store.readRundown(request.params.rundownId);
    if (!rundown) {
      return reply.code(404).send({ error: "rundown not found" });
    }
    return rundown;
  }
);

app.post<{ Body: PlayoutRundownDocument }>(
  "/api/playout/rundowns",
  async (request, reply) => {
    try {
      return await store.saveRundown(request.body);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  }
);

app.post<{
  Params: { action: "cue" | "take" };
  Body: { rundownId: string; itemId: string };
}>("/api/playout/control/:action", async (request, reply) => {
  try {
    const status =
      request.params.action === "cue"
        ? await runtime.cue(request.body.rundownId, request.body.itemId)
        : await runtime.take(request.body.rundownId, request.body.itemId);
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
await app.listen({ host, port });

const shutdown = async () => {
  engine.close();
  runtime.close();
  await app.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
