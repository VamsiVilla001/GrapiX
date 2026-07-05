import cors from "@fastify/cors";
import { preflightScenePackage, type SceneDocument } from "@grapix/shared-types";
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { buildScenePackage } from "./packageBuilder.js";
import { ensureStorage, listScenes, readScene, savePackage, saveScene, updateScene } from "./storage.js";

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

  await app.register(cors, {
    origin: true
  });

  app.get("/health", async () => ({
    ok: true,
    service: "grapix-api",
    time: new Date().toISOString()
  }));

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

  await ensureStorage();

  return app;
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
