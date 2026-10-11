import cors from "@fastify/cors";
import {
  fetchFigmaPayload,
  FigmaRestError,
  importDesignFile,
  mapFigmaPayloadToDesignIR,
  type FigmaImportPayload
} from "@grapix/importers";
import {
  preflightScenePackage,
  type ProfileWorkspaceLayout,
  type SceneDocument
} from "@grapix/shared-types";
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import {
  diffNeedsReview,
  reconcileDesigns,
  type DesignDiff,
  type DesignIR,
  type DesignIRSummary,
  type ImportWarning
} from "@grapix/design-ir";
import { deleteDesignAssets, persistDesignAssets, readDesignAsset } from "./assetStore.js";
import {
  deleteDesign,
  ensureDesignStorage,
  findPreviousDesign,
  listDesigns,
  readDesign,
  saveDesign
} from "./designStore.js";
import { buildScenePackage } from "./packageBuilder.js";
import {
  createProfile,
  deleteProfile,
  ensureProfileStorage,
  launchProfile,
  listProfiles,
  ProfileError,
  readProfileCredential,
  updateProfile
} from "./profileStore.js";
import { ensureStorage, listScenes, readScene, savePackage, saveScene, updateScene } from "./storage.js";

export interface ApiServerOptions {
  host?: string;
  port?: number;
  logger?: boolean;
}

export async function createApiServer(options: Pick<ApiServerOptions, "logger"> = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 200 * 1024 * 1024
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

  // -------------------------------------------------------------------------
  // Profiles. The editor never receives a credential value, only a hint, so every
  // response here goes through toProfilePublic inside the store.
  // -------------------------------------------------------------------------

  app.get("/api/profiles", async () => ({
    ok: true,
    profiles: await listProfiles()
  }));

  app.post<{ Body: { name?: string; description?: string; figmaToken?: string } }>(
    "/api/profiles",
    async (request, reply) =>
      withProfileErrors(reply, async () => ({
        ok: true,
        profile: await createProfile({
          name: request.body?.name ?? "",
          description: request.body?.description,
          figmaToken: request.body?.figmaToken
        })
      }))
  );

  app.patch<{
    Params: { profileId: string };
    Body: {
      name?: string;
      description?: string;
      workspaceLayout?: ProfileWorkspaceLayout | null;
      settings?: Record<string, unknown>;
      figmaToken?: string;
    };
  }>("/api/profiles/:profileId", async (request, reply) =>
    withProfileErrors(reply, async () => ({
      ok: true,
      profile: await updateProfile(request.params.profileId, request.body ?? {})
    }))
  );

  app.post<{ Params: { profileId: string } }>("/api/profiles/:profileId/launch", async (request, reply) =>
    withProfileErrors(reply, async () => ({
      ok: true,
      profile: await launchProfile(request.params.profileId)
    }))
  );

  app.delete<{ Params: { profileId: string } }>("/api/profiles/:profileId", async (request, reply) =>
    withProfileErrors(reply, async () => {
      await deleteProfile(request.params.profileId);

      return { ok: true };
    })
  );

  // -------------------------------------------------------------------------
  // Designs (DesignIR). Immutable once stored.
  // -------------------------------------------------------------------------

  app.get("/api/designs", async () => ({
    ok: true,
    designs: await listDesigns()
  }));

  app.get<{ Params: { designId: string } }>("/api/designs/:designId", async (request, reply) => {
    const design = await readDesign(request.params.designId);

    if (!design) {
      return reply.code(404).send({ ok: false, error: "Design not found" });
    }

    return { ok: true, design };
  });

  app.delete<{ Params: { designId: string } }>("/api/designs/:designId", async (request, reply) => {
    const removed = await deleteDesign(request.params.designId);

    if (!removed) {
      return reply.code(404).send({ ok: false, error: "Design not found" });
    }

    await deleteDesignAssets(request.params.designId);

    return { ok: true };
  });

  /** Serves a stored asset. Sources inside a DesignIR point here. */
  app.get<{ Params: { designId: string; fileName: string } }>(
    "/api/designs/:designId/assets/:fileName",
    async (request, reply) => {
      const asset = await readDesignAsset(request.params.designId, request.params.fileName);

      if (!asset) {
        return reply.code(404).send({ ok: false, error: "Asset not found" });
      }

      // Asset file names are content-addressed by assetId, so they are safe to cache hard.
      return reply
        .header("content-type", asset.mimeType)
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(asset.bytes);
    }
  );

  /**
   * Reconciles two imports of the same source file. Without `against`, diffs the design
   * against the most recent earlier import of the same file.
   */
  app.get<{ Params: { designId: string }; Querystring: { against?: string } }>(
    "/api/designs/:designId/diff",
    async (request, reply) => {
      const design = await readDesign(request.params.designId);

      if (!design) {
        return reply.code(404).send({ ok: false, error: "Design not found" });
      }

      const previous = request.query.against
        ? await readDesign(request.query.against)
        : await findPreviousDesign(design.sourceRef, design.designId);

      if (!previous) {
        return reply.code(404).send({
          ok: false,
          error: "No earlier import of this source file to compare against."
        });
      }

      const diff = reconcileDesigns(previous, design);

      return { ok: true, diff, needsReview: diffNeedsReview(diff) };
    }
  );

  // -------------------------------------------------------------------------
  // Import: Figma via REST fallback. The token stays in this process.
  // -------------------------------------------------------------------------

  app.post<{ Body: { profileId?: string; target?: string; nodeIds?: string[] } }>(
    "/api/imports/figma",
    async (request, reply) => {
      const { profileId, target, nodeIds } = request.body ?? {};

      if (!profileId || !target) {
        return reply.code(400).send({ ok: false, error: "profileId and target are required." });
      }

      try {
        const token = await readProfileCredential(profileId, "figmaToken");

        if (!token) {
          return reply.code(400).send({
            ok: false,
            error: "This profile has no Figma personal access token. Add one in the profile, or import with the plugin."
          });
        }

        const payload = await fetchFigmaPayload({ token, target, nodeIds });

        return { ok: true, ...(await ingestDesign(mapFigmaPayloadToDesignIR(payload))) };
      } catch (error) {
        if (error instanceof FigmaRestError) {
          return reply.code(error.status).send({ ok: false, error: error.message });
        }

        if (error instanceof ProfileError) {
          return reply.code(error.status).send({ ok: false, error: error.message });
        }

        throw error;
      }
    }
  );

  // -------------------------------------------------------------------------
  // Import: Figma via the plugin. Same mapper, higher-fidelity payload.
  // -------------------------------------------------------------------------

  app.post<{ Body: FigmaImportPayload }>("/api/imports/figma/plugin", async (request, reply) => {
    const payload = request.body;

    if (!payload?.nodes?.length) {
      return reply
        .code(400)
        .send({ ok: false, error: "The plugin sent no nodes. Select at least one frame in Figma." });
    }

    const design = mapFigmaPayloadToDesignIR({ ...payload, origin: "plugin" });

    return { ok: true, ...(await ingestDesign(design)) };
  });

  // -------------------------------------------------------------------------
  // Import: PSD and Illustrator file upload, base64 in the body.
  // -------------------------------------------------------------------------

  app.post<{ Body: { fileName?: string; dataBase64?: string } }>(
    "/api/imports/file",
    async (request, reply) => {
      const { fileName, dataBase64 } = request.body ?? {};

      if (!fileName || !dataBase64) {
        return reply.code(400).send({ ok: false, error: "fileName and dataBase64 are required." });
      }

      try {
        const design = await importDesignFile({
          fileName,
          data: new Uint8Array(Buffer.from(dataBase64, "base64"))
        });

        return { ok: true, ...(await ingestDesign(design)) };
      } catch (error) {
        return reply.code(422).send({
          ok: false,
          error: error instanceof Error ? error.message : "Import failed."
        });
      }
    }
  );

  await ensureStorage();
  await ensureProfileStorage();
  await ensureDesignStorage();

  return app;
}

export interface IngestResult {
  design: DesignIRSummary;
  warnings: ImportWarning[];
  /** Present when this source file has been imported before. */
  diff: DesignDiff | null;
  /** True when a rig should not be carried across this diff unreviewed. */
  needsReview: boolean;
  assetsStored: number;
}

/**
 * The one path every importer's output takes.
 *
 * Assets are materialised before the design is stored, because both Figma front-ends hand
 * back sources that cannot be persisted: REST gives signed URLs that expire, and the
 * plugin gives data URIs that would bloat the JSON. Then, if this file has been imported
 * before, the new tree is reconciled against the previous one so the change is reviewable
 * rather than silent.
 */
async function ingestDesign(design: DesignIR): Promise<IngestResult> {
  const persisted = await persistDesignAssets(design);
  const previous = await findPreviousDesign(
    persisted.design.sourceRef,
    persisted.design.designId
  );
  const diff = previous ? reconcileDesigns(previous, persisted.design) : null;
  const summary = await saveDesign(persisted.design);

  return {
    design: summary,
    warnings: persisted.design.warnings,
    diff,
    needsReview: diff ? diffNeedsReview(diff) : false,
    assetsStored: persisted.stored
  };
}

async function withProfileErrors<T>(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  run: () => Promise<T>
): Promise<T | unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProfileError) {
      return reply.code(error.status).send({ ok: false, error: error.message });
    }

    throw error;
  }
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
