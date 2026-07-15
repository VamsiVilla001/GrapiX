import cors from "@fastify/cors";
import { preflightScenePackage, type SceneDocument } from "@grapix/shared-types";
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { buildScenePackage } from "./packageBuilder.js";
import {
  RenderDaemonClient,
  RenderDaemonRequestError,
  RenderDaemonUnavailableError,
  type RenderDaemonOutputConfig
} from "./renderDaemon.js";
import {
  ensureStorage,
  importAssetBuffer,
  listScenes,
  readScene,
  readStoredAsset,
  readStoredAssetContent,
  savePackage,
  saveScene,
  updateScene
} from "./storage.js";

export interface ApiServerOptions {
  host?: string;
  port?: number;
  logger?: boolean;
}

export async function createApiServer(options: Pick<ApiServerOptions, "logger"> = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 50 * 1024 * 1024
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  const allowedOrigins = readAllowedApiOrigins();

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;

    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({
        ok: false,
        error: "Origin is not allowed"
      });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "grapix-api",
    time: new Date().toISOString()
  }));

  app.post<{
    Querystring: { fileName?: string; mimeType?: string; replaceAssetId?: string };
    Body: Buffer;
  }>("/api/assets/import", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    const mimeType = request.query.mimeType?.trim() || "application/octet-stream";

    if (!fileName || !Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.code(400).send({ ok: false, error: "A non-empty binary file and fileName are required" });
    }

    const asset = await importAssetBuffer(
      request.body,
      fileName,
      mimeType,
      request.query.replaceAssetId
    );
    return {
      ok: true,
      asset: {
        ...asset,
        contentUrl: `/api/assets/${asset.assetId}/content`
      }
    };
  });

  app.get<{ Params: { assetId: string } }>("/api/assets/:assetId", async (request, reply) => {
    const asset = await readStoredAsset(request.params.assetId);
    return asset ?? reply.code(404).send({ ok: false, error: "Asset not found" });
  });

  app.get<{ Params: { assetId: string } }>("/api/assets/:assetId/content", async (request, reply) => {
    const asset = await readStoredAssetContent(request.params.assetId);
    if (!asset) return reply.code(404).send({ ok: false, error: "Asset content not found" });

    return reply.type(asset.record.mimeType).send(asset.bytes);
  });

  app.get("/api/scenes", async () => ({
    scenes: await listScenes()
  }));

  app.post<{ Body: SceneDocument }>("/api/scenes", async (request) => {
    const summary = await saveScene(request.body);

    return {
      ok: true,
      scene: summary
    };
  });

  app.get<{ Params: { sceneId: string } }>("/api/scenes/:sceneId", async (request, reply) => {
    const scene = await readScene(request.params.sceneId);

    if (!scene) {
      return reply.code(404).send({
        ok: false,
        error: "Scene not found"
      });
    }

    return {
      ok: true,
      scene
    };
  });

  app.patch<{
    Params: { sceneId: string; objectId: string };
    Body: Record<string, unknown>;
  }>("/api/scenes/:sceneId/objects/:objectId", async (request, reply) => {
    const scene = await updateScene(request.params.sceneId, (currentScene) => ({
      ...currentScene,
      updatedAt: new Date().toISOString(),
      objects: currentScene.objects.map((object) =>
        object.id === request.params.objectId ? ({ ...object, ...request.body } as typeof object) : object
      )
    }));

    if (!scene) {
      return reply.code(404).send({ ok: false, error: "Scene not found" });
    }

    return { ok: true, scene };
  });

  app.patch<{
    Params: { sceneId: string; materialId: string };
    Body: Record<string, unknown>;
  }>("/api/scenes/:sceneId/materials/:materialId", async (request, reply) => {
    const scene = await updateScene(request.params.sceneId, (currentScene) => ({
      ...currentScene,
      updatedAt: new Date().toISOString(),
      materials: currentScene.materials.map((material) =>
        material.materialId === request.params.materialId ? { ...material, ...request.body } : material
      )
    }));

    if (!scene) {
      return reply.code(404).send({ ok: false, error: "Scene not found" });
    }

    return { ok: true, scene };
  });

  app.patch<{
    Params: { sceneId: string };
    Body: Record<string, unknown>;
  }>("/api/scenes/:sceneId/data-context", async (request, reply) => {
    const scene = await updateScene(request.params.sceneId, (currentScene) => ({
      ...currentScene,
      dataContext: request.body,
      updatedAt: new Date().toISOString()
    }));

    if (!scene) {
      return reply.code(404).send({ ok: false, error: "Scene not found" });
    }

    return { ok: true, scene };
  });

  app.patch<{
    Params: { sceneId: string };
    Body: SceneDocument["timeline"];
  }>("/api/scenes/:sceneId/timeline", async (request, reply) => {
    const scene = await updateScene(request.params.sceneId, (currentScene) => ({
      ...currentScene,
      timeline: request.body,
      updatedAt: new Date().toISOString()
    }));

    if (!scene) {
      return reply.code(404).send({ ok: false, error: "Scene not found" });
    }

    return { ok: true, scene };
  });

  app.post<{ Body: SceneDocument }>("/api/preflight", async (request) => ({
    ok: true,
    preflight: preflightScenePackage(request.body)
  }));

  app.post<{ Body: SceneDocument }>("/api/packages", async (request, reply) => {
    const preflight = preflightScenePackage(request.body);

    if (!preflight.ok) {
      return reply.code(422).send({
        ok: false,
        preflight
      });
    }

    await saveScene(request.body);
    const builtPackage = await buildScenePackage(request.body);
    const storedPackage = await savePackage(
      request.body.id,
      builtPackage.fileName,
      builtPackage.buffer
    );

    return {
      ok: true,
      preflight: builtPackage.preflight,
      package: storedPackage
    };
  });

  app.post<{ Params: { sceneId: string } }>("/api/scenes/:sceneId/packages", async (request, reply) => {
    const scene = await readScene(request.params.sceneId);

    if (!scene) {
      return reply.code(404).send({ ok: false, error: "Scene not found" });
    }

    const preflight = preflightScenePackage(scene);

    if (!preflight.ok) {
      return reply.code(422).send({
        ok: false,
        preflight
      });
    }

    const builtPackage = await buildScenePackage(scene);
    const storedPackage = await savePackage(scene.id, builtPackage.fileName, builtPackage.buffer);

    return {
      ok: true,
      preflight: builtPackage.preflight,
      package: storedPackage
    };
  });

  // --- Render daemon bridge (optional service) -----------------------------
  // The Rust render daemon (services/render-daemon) is optional in this
  // phase: these routes answer 503 when it is not running and never affect
  // the rest of the API. See services/render-daemon/README.md.

  const renderDaemon = new RenderDaemonClient();

  app.addHook("onClose", async () => {
    renderDaemon.close();
  });

  const withDaemon = async (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, action: () => Promise<unknown>) => {
    try {
      return { ok: true, reply: await action() };
    } catch (error) {
      if (error instanceof RenderDaemonUnavailableError) {
        return reply.code(503).send({ ok: false, error: error.message });
      }

      if (error instanceof RenderDaemonRequestError) {
        return reply.code(422).send({ ok: false, code: error.code, error: error.message });
      }

      throw error;
    }
  };

  app.get("/api/render-daemon/status", async (request, reply) =>
    withDaemon(reply, () => renderDaemon.getStatus())
  );

  app.post<{ Body: SceneDocument }>("/api/render-daemon/scene", async (request, reply) =>
    withDaemon(reply, () => renderDaemon.loadScene(request.body))
  );

  app.post<{ Params: { sceneId: string } }>(
    "/api/render-daemon/scenes/:sceneId/load",
    async (request, reply) => {
      const scene = await readScene(request.params.sceneId);

      if (!scene) {
        return reply.code(404).send({ ok: false, error: "Scene not found" });
      }

      return withDaemon(reply, () => renderDaemon.loadScene(scene));
    }
  );

  app.post<{ Body: RenderDaemonOutputConfig }>(
    "/api/render-daemon/output/configure",
    async (request, reply) => withDaemon(reply, () => renderDaemon.configureOutput(request.body))
  );

  app.post("/api/render-daemon/output/start", async (request, reply) =>
    withDaemon(reply, () => renderDaemon.startOutput())
  );

  app.post("/api/render-daemon/output/stop", async (request, reply) =>
    withDaemon(reply, () => renderDaemon.stopOutput())
  );

  await ensureStorage();

  return app;
}

function readAllowedApiOrigins(): Set<string> {
  const origins = new Set([
    "grapix://editor",
    "http://127.0.0.1:5173",
    "http://localhost:5173"
  ]);

  for (const origin of (process.env.GRAPIX_API_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmedOrigin = origin.trim();
    if (trimmedOrigin) {
      origins.add(trimmedOrigin);
    }
  }

  const editorUrl = process.env.GRAPIX_EDITOR_URL;
  if (editorUrl) {
    try {
      const origin = new URL(editorUrl).origin;
      if (origin !== "null") {
        origins.add(origin);
      }
    } catch {
      // The Electron launcher will report an invalid editor URL separately.
    }
  }

  return origins;
}

export async function startApiServer(options: ApiServerOptions = {}): Promise<FastifyInstance> {
  const port = options.port ?? Number(process.env.GRAPIX_API_PORT ?? 4100);
  const host = options.host ?? process.env.GRAPIX_API_HOST ?? "127.0.0.1";
  const app = await createApiServer({
    logger: options.logger
  });

  await app.listen({ port, host });

  return app;
}

if (isDirectRun()) {
  await startApiServer();
}

function isDirectRun(): boolean {
  const entryPath = process.argv[1];

  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}
