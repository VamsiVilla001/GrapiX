import cors from "@fastify/cors";
import type { RendererQualityProfile } from "@grapix/renderer-protocol";
import { GrapixSequenceEngine } from "@grapix/sdk";
import {
  preflightScenePackage,
  type GrapixAutomationAction,
  type GrapixTriggerEvent,
  type DesignImportOptions,
  type FigmaDesignImportSource,
  type RundownDocument,
  type RendererPatch,
  type SceneDocument
} from "@grapix/shared-types";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { inspectAeImport } from "./importers/aeImporter.js";
import { validateImportedAsset } from "./importers/assetValidation.js";
import {
  inspectModelImport,
  type ModelImportProfile
} from "./importers/modelImporter.js";
import { inspectMediaImport } from "./importers/mediaImporter.js";
import { inspectSceneScript } from "./importers/sceneScriptImporter.js";
import {
  DesignImportManager,
  parseDesignImportOptions
} from "./importers/design/designImportManager.js";
import {
  createFileFontDefinition,
  createLinkedFontDefinition,
  parseScriptPermissions,
  type LinkedFontRequest
} from "./fontManager.js";
import {
  resolveRemoteFonts,
  type ResolveRemoteFontRequest
} from "./fonts/remoteFontResolver.js";
import { inspectFontFile } from "./fonts/fontMetadata.js";
import { buildScenePackage } from "./packageBuilder.js";
import { recordOperatorAction } from "./audit.js";
import {
  RenderDaemonClient,
  RenderDaemonRequestError,
  RenderDaemonUnavailableError,
  type RenderDaemonOutputConfig
} from "./renderDaemon.js";
import {
  ensureStorage,
  importAssetBuffer,
  listRundowns,
  listScenes,
  readRundown,
  readScene,
  recoverScene,
  readStoredAsset,
  readStoredAssetContent,
  savePackage,
  saveRundown,
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
    bodyLimit: 512 * 1024 * 1024
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  const allowedOrigins = readAllowedApiOrigins();
  const patchWindows = new Map<string, { startedAt: number; count: number }>();
  const sequenceEngines = new Map<string, GrapixSequenceEngine>();
  const designImportManager = new DesignImportManager();

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

    const apiToken = process.env.GRAPIX_API_TOKEN?.trim();
    if (apiToken && request.url !== "/health") {
      const supplied = readApiToken(request.headers.authorization, request.headers["x-grapix-token"]);
      if (!safeTokenEqual(apiToken, supplied)) {
        return reply.code(401).send({ ok: false, error: "API authentication failed" });
      }
    }

    if (isReadOnlyShowMode() && isMutation(request.method) && !isAllowedShowControl(request.url)) {
      return reply.code(423).send({
        ok: false,
        code: "READ_ONLY_SHOW_MODE",
        error: "Project and asset mutations are locked while read-only show mode is active"
      });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "grapix-api",
    time: new Date().toISOString(),
    showMode: isReadOnlyShowMode() ? "read-only" : "edit",
    authenticationRequired: Boolean(process.env.GRAPIX_API_TOKEN?.trim())
  }));

  app.addHook("onResponse", async (request, reply) => {
    if (!isMutation(request.method)) return;
    await recordOperatorAction({
      timestamp: new Date().toISOString(),
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? request.url.split("?")[0],
      statusCode: reply.statusCode,
      actor: isLoopbackAddress(request.ip) ? "local" : "authenticated-remote",
      remoteAddress: request.ip,
      contentLength: Number(request.headers["content-length"] ?? 0)
    });
  });

  app.post<{
    Querystring: { fileName?: string; mimeType?: string; replaceAssetId?: string };
    Body: Buffer;
  }>("/api/assets/import", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    const mimeType = request.query.mimeType?.trim() || "application/octet-stream";

    if (!fileName || !Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.code(400).send({ ok: false, error: "A non-empty binary file and fileName are required" });
    }
    const validationErrors = validateImportedAsset(request.body, fileName);
    if (validationErrors.length) {
      return reply.code(415).send({
        ok: false,
        code: "ASSET_VALIDATION_FAILED",
        errors: validationErrors
      });
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

  app.post<{
    Querystring: {
      fileName?: string;
      family?: string;
      displayName?: string;
      weight?: string;
      style?: "normal" | "italic" | "oblique";
      license?: string;
    };
    Body: Buffer;
  }>("/api/fonts/import", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    if (!fileName || !Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ ok: false, error: "A font file and fileName are required" });
    }
    const extension = fileName.toLowerCase().split(".").pop() ?? "";
    if (!["otf", "ttf", "woff", "woff2"].includes(extension)) {
      return reply.code(415).send({ ok: false, error: "Font Manager accepts OTF, TTF, WOFF, and WOFF2 files" });
    }
    const validationErrors = validateImportedAsset(request.body, fileName);
    if (validationErrors.length) {
      return reply.code(415).send({ ok: false, code: "FONT_VALIDATION_FAILED", errors: validationErrors });
    }
    const mimeType = fontMimeType(extension);
    let metadata: ReturnType<typeof inspectFontFile>;
    try {
      metadata = inspectFontFile(request.body);
    } catch (error) {
      return reply.code(415).send({
        ok: false,
        code: "FONT_INVALID",
        error: error instanceof Error ? error.message : "Font metadata could not be read"
      });
    }
    const asset = await importAssetBuffer(request.body, fileName, mimeType);
    const font = createFileFontDefinition(asset, {
      family: request.query.family?.trim() || metadata.family,
      displayName: request.query.displayName || metadata.displayName,
      weight: request.query.weight ? Number(request.query.weight) : metadata.weight,
      style: request.query.style || metadata.style,
      license: request.query.license
    });
    return {
      ok: true,
      asset: { ...asset, kind: "font", contentUrl: `/api/assets/${asset.assetId}/content` },
      font
    };
  });

  app.post<{ Body: LinkedFontRequest }>("/api/fonts/link", async (request, reply) => {
    try {
      return {
        ok: true,
        font: createLinkedFontDefinition(request.body)
      };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Invalid font link"
      });
    }
  });

  app.post<{ Body: ResolveRemoteFontRequest }>("/api/fonts/resolve", async (request, reply) => {
    try {
      return {
        ok: true,
        ...(await resolveRemoteFonts(request.body))
      };
    } catch (error) {
      return reply.code(422).send({
        ok: false,
        code: "FONT_RESOLUTION_FAILED",
        error: error instanceof Error ? error.message : "Remote font could not be resolved"
      });
    }
  });

  app.post<{
    Querystring: { fileName?: string; permissions?: string };
    Body: Buffer;
  }>("/api/import/scene-script", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    if (!fileName || !Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ ok: false, error: "A JavaScript file and fileName are required" });
    }
    const report = inspectSceneScript(request.body, fileName);
    if (!report.accepted) {
      return reply.code(422).send({ ok: false, report });
    }
    const asset = await importAssetBuffer(request.body, fileName, "application/javascript");
    return {
      ok: true,
      asset: { ...asset, kind: "script", contentUrl: `/api/assets/${asset.assetId}/content` },
      script: {
        scriptId: `script_${report.checksum.slice(0, 16)}`,
        assetId: asset.assetId,
        apiVersion: 1,
        entrypoint: "default",
        enabled: true,
        checksum: report.checksum,
        permissions: parseScriptPermissions(request.query.permissions),
        execution: "control-sandbox"
      },
      report
    };
  });

  app.post<{
    Querystring: { fileName?: string; profile?: ModelImportProfile };
    Body: Buffer;
  }>("/api/import/model", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    if (!fileName || !Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ ok: false, error: "A binary glTF/GLB body and fileName are required" });
    }
    const validationErrors = validateImportedAsset(request.body, fileName);
    if (validationErrors.length) {
      return reply.code(415).send({ ok: false, code: "ASSET_VALIDATION_FAILED", errors: validationErrors });
    }
    const profile = request.query.profile ?? "PROGRAM_HD";
    const report = inspectModelImport(request.body, fileName, profile);
    if (!report.accepted) {
      return reply.code(422).send({ ok: false, report });
    }
    const asset = await importAssetBuffer(
      request.body,
      fileName,
      fileName.toLowerCase().endsWith(".glb") ? "model/gltf-binary" : "model/gltf+json"
    );
    return {
      ok: true,
      asset: { ...asset, kind: "model", contentUrl: `/api/assets/${asset.assetId}/content` },
      report
    };
  });

  app.post<{
    Querystring: { fileName?: string };
    Body: Buffer;
  }>("/api/import/media", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    if (!fileName || !Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ ok: false, error: "A binary media body and fileName are required" });
    }
    const validationErrors = validateImportedAsset(request.body, fileName);
    if (validationErrors.length) {
      return reply.code(415).send({ ok: false, code: "ASSET_VALIDATION_FAILED", errors: validationErrors });
    }
    const report = inspectMediaImport(request.body, fileName);
    const asset = await importAssetBuffer(request.body, fileName, request.headers["content-type"] ?? "video/mp4");
    return {
      ok: true,
      asset: { ...asset, kind: "video", contentUrl: `/api/assets/${asset.assetId}/content` },
      report
    };
  });

  app.post<{
    Querystring: { fileName?: string };
    Body: unknown;
  }>("/api/import/after-effects", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    if (!fileName) {
      return reply.code(400).send({ ok: false, error: "fileName is required" });
    }
    const report = inspectAeImport(fileName, request.body);
    return reply.code(report.accepted ? 200 : 422).send({
      ok: report.accepted,
      report,
      approvedPaths: ["Lottie", "alpha video", "image sequence manifest", "structured GrapiX conversion"]
    });
  });

  app.post<{
    Querystring: { fileName?: string; options?: string };
    Body: Buffer;
  }>("/api/import/design-file", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    if (!fileName || !Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.code(400).send({ ok: false, error: "A non-empty PSD, AI/PDF, SVG, or exported Figma JSON file is required." });
    }
    try {
      const result = await designImportManager.importFile(
        request.body,
        fileName,
        parseDesignImportOptions(request.query.options)
      );
      return { ok: true, result };
    } catch (error) {
      return reply.code(422).send({
        ok: false,
        code: "DESIGN_IMPORT_FAILED",
        error: error instanceof Error ? error.message : "Design import failed"
      });
    }
  });

  app.post<{
    Body: {
      source: FigmaDesignImportSource;
      options?: Partial<DesignImportOptions>;
    };
  }>("/api/import/figma", async (request, reply) => {
    try {
      const result = await designImportManager.importFigma(request.body.source, request.body.options);
      return { ok: true, result };
    } catch (error) {
      return reply.code(422).send({
        ok: false,
        code: "FIGMA_IMPORT_FAILED",
        error: error instanceof Error ? error.message : "Figma import failed"
      });
    }
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

  app.get("/api/rundowns", async () => ({
    rundowns: await listRundowns()
  }));

  app.post<{ Body: RundownDocument }>("/api/rundowns", async (request, reply) => {
    try {
      return { ok: true, rundown: await saveRundown(request.body) };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Invalid rundown"
      });
    }
  });

  app.get<{ Params: { rundownId: string } }>("/api/rundowns/:rundownId", async (request, reply) => {
    const rundown = await readRundown(request.params.rundownId);
    return rundown
      ? { ok: true, rundown }
      : reply.code(404).send({ ok: false, error: "Rundown not found" });
  });

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

  app.post<{ Params: { sceneId: string } }>("/api/scenes/:sceneId/recover", async (request, reply) => {
    const scene = await recoverScene(request.params.sceneId);
    if (!scene) {
      return reply.code(404).send({ ok: false, error: "No scene backup is available" });
    }
    return { ok: true, scene, recovered: true };
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
    Body: { path: string; value: unknown; expectedRevision?: string };
  }>("/api/scenes/:sceneId/data-patches", async (request, reply) => {
    if (!acceptPatchRate(patchWindows, request.params.sceneId)) {
      return reply.code(429).send({
        ok: false,
        code: "PATCH_RATE_LIMIT",
        error: "At most 120 live-data patches per scene per second are accepted; retry with latest values."
      });
    }
    const patchPath = request.body?.path;
    if (typeof patchPath !== "string") {
      return reply.code(400).send({ ok: false, error: "path must be a string" });
    }

    let previousRevision = "";
    const scene = await updateScene(request.params.sceneId, (currentScene) => {
      previousRevision = currentScene.updatedAt;
      if (request.body.expectedRevision && request.body.expectedRevision !== previousRevision) {
        throw new SceneRevisionConflictError(request.body.expectedRevision, previousRevision);
      }
      return {
        ...currentScene,
        dataContext: setDataPath(currentScene.dataContext, patchPath, request.body.value),
        updatedAt: new Date().toISOString()
      };
    }).catch((error: unknown) => {
      if (error instanceof SceneRevisionConflictError) return error;
      throw error;
    });

    if (scene instanceof SceneRevisionConflictError) {
      return reply.code(409).send({
        ok: false,
        code: "REVISION_MISMATCH",
        expectedRevision: scene.expected,
        actualRevision: scene.actual
      });
    }
    if (!scene) {
      return reply.code(404).send({ ok: false, error: "Scene not found" });
    }

    const patch: RendererPatch = {
      type: "PATCH_DATA_CONTEXT",
      sceneId: scene.id,
      path: patchPath,
      value: request.body.value
    };
    let rendererSync: { synced: boolean; reason?: string } = { synced: true };
    try {
      await renderDaemon.patchScene(patch, previousRevision, scene.updatedAt);
    } catch (error) {
      rendererSync = {
        synced: false,
        reason: error instanceof Error ? error.message : "render daemon patch failed"
      };
    }

    return { ok: true, scene, rendererSync };
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

  app.post<{
    Params: { rundownId: string };
    Body: {
      event: GrapixTriggerEvent;
      sceneData?: Record<string, unknown>;
      execute?: boolean;
    };
  }>("/api/rundowns/:rundownId/events", async (request, reply) => {
    const rundown = await readRundown(request.params.rundownId);
    if (!rundown) return reply.code(404).send({ ok: false, error: "Rundown not found" });
    const engineKey = `rundown:${rundown.rundownId}:${rundown.revision ?? 0}`;
    let engine = sequenceEngines.get(engineKey);
    if (!engine) {
      engine = new GrapixSequenceEngine(rundown);
      sequenceEngines.set(engineKey, engine);
      pruneSequenceEngines(sequenceEngines, `rundown:${rundown.rundownId}:`, engineKey);
    }
    let event: GrapixTriggerEvent;
    try {
      event = normalizeTriggerEvent(request.body?.event);
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Invalid trigger event"
      });
    }
    const evaluation = engine.process(event, request.body.sceneData ?? {});
    const execution = request.body.execute
      ? await executeAutomationActions(evaluation.actions, renderDaemon)
      : [];
    return { ok: true, evaluation, execution, dryRun: !request.body.execute };
  });

  app.post<{
    Params: { sceneId: string };
    Body: { event: GrapixTriggerEvent; execute?: boolean };
  }>("/api/scenes/:sceneId/events", async (request, reply) => {
    const scene = await readScene(request.params.sceneId);
    if (!scene) return reply.code(404).send({ ok: false, error: "Scene not found" });
    const triggers = scene.automation?.triggers ?? [];
    const syntheticRundown: RundownDocument = {
      rundownId: `scene_${scene.id}`,
      name: `${scene.name} automation`,
      version: 1,
      activeSequenceId: "scene_automation",
      variables: {},
      sequences: [{
        sequenceId: "scene_automation",
        name: "Scene automation",
        fps: scene.timeline.fps,
        durationFrames: scene.timeline.durationFrames,
        tracks: [],
        transitions: scene.automation?.transitions ?? [],
        triggers
      }],
      createdAt: scene.createdAt,
      updatedAt: scene.updatedAt
    };
    const engineKey = `scene:${scene.id}:${scene.revision ?? scene.updatedAt}`;
    let engine = sequenceEngines.get(engineKey);
    if (!engine) {
      engine = new GrapixSequenceEngine(syntheticRundown);
      sequenceEngines.set(engineKey, engine);
      pruneSequenceEngines(sequenceEngines, `scene:${scene.id}:`, engineKey);
    }
    let event: GrapixTriggerEvent;
    try {
      event = normalizeTriggerEvent(request.body?.event);
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Invalid trigger event"
      });
    }
    const evaluation = engine.process(event, scene.dataContext);
    const execution = request.body.execute
      ? await executeAutomationActions(evaluation.actions, renderDaemon)
      : [];
    return { ok: true, evaluation, execution, dryRun: !request.body.execute };
  });

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

  app.get("/api/render-daemon/capabilities", async (request, reply) =>
    withDaemon(reply, () => renderDaemon.getCapabilities())
  );

  app.get("/api/render-daemon/heartbeat", async (request, reply) =>
    withDaemon(reply, () => renderDaemon.heartbeat())
  );

  app.post<{ Body: { profile: RendererQualityProfile } }>(
    "/api/render-daemon/resource-profile",
    async (request, reply) =>
      withDaemon(reply, () => renderDaemon.setQualityProfile(request.body.profile))
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

  app.post<{ Params: { sceneId: string } }>(
    "/api/render-daemon/scenes/:sceneId/warm",
    async (request, reply) => {
      const scene = await readScene(request.params.sceneId);
      if (!scene) {
        return reply.code(404).send({ ok: false, error: "Scene not found" });
      }
      return withDaemon(reply, () => renderDaemon.warmScene(scene));
    }
  );

  app.post<{ Params: { sceneId: string } }>(
    "/api/render-daemon/scenes/:sceneId/preview",
    async (request, reply) => {
      const scene = await readScene(request.params.sceneId);
      if (!scene) {
        return reply.code(404).send({ ok: false, error: "Scene not found" });
      }
      return withDaemon(reply, async () => {
        await renderDaemon.warmScene(scene);
        return renderDaemon.setPreview(scene.id, scene.updatedAt);
      });
    }
  );

  app.post<{ Params: { sceneId: string } }>(
    "/api/render-daemon/scenes/:sceneId/take",
    async (request, reply) => {
      const scene = await readScene(request.params.sceneId);
      if (!scene) {
        return reply.code(404).send({ ok: false, error: "Scene not found" });
      }
      return withDaemon(reply, async () => {
        await renderDaemon.warmScene(scene);
        return renderDaemon.take(scene.id, scene.updatedAt);
      });
    }
  );

  app.post<{ Params: { sceneId: string } }>(
    "/api/render-daemon/scenes/:sceneId/release",
    async (request, reply) => {
      const scene = await readScene(request.params.sceneId);
      if (!scene) {
        return reply.code(404).send({ ok: false, error: "Scene not found" });
      }
      return withDaemon(reply, () => renderDaemon.releaseScene(scene.id, scene.updatedAt));
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

class SceneRevisionConflictError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(`expected scene revision ${expected}, current revision is ${actual}`);
  }
}

function acceptPatchRate(
  windows: Map<string, { startedAt: number; count: number }>,
  sceneId: string
): boolean {
  const now = Date.now();
  const current = windows.get(sceneId);
  if (!current || now - current.startedAt >= 1000) {
    windows.set(sceneId, { startedAt: now, count: 1 });
    if (windows.size > 1024) {
      for (const [id, window] of windows) {
        if (now - window.startedAt > 10_000) windows.delete(id);
      }
    }
    return true;
  }
  current.count += 1;
  return current.count <= 120;
}

function setDataPath(
  original: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  if (!path || path.length > 256) throw new Error("data path must contain 1 to 256 characters");
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (!segments.length || segments.length > 32) {
    throw new Error("data path must contain 1 to 32 segments");
  }
  if (segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
    throw new Error("data path contains a reserved segment");
  }
  const clone = structuredClone(original);
  let current: Record<string, unknown> = clone;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined) {
      current[segment] = {};
    } else if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new Error(`data path crosses non-object segment ${segment}`);
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
  return clone;
}

interface AutomationExecutionResult {
  action: GrapixAutomationAction;
  status: "completed" | "deferred" | "failed";
  detail?: string;
}

async function executeAutomationActions(
  actions: GrapixAutomationAction[],
  renderDaemon: RenderDaemonClient
): Promise<AutomationExecutionResult[]> {
  const results: AutomationExecutionResult[] = [];
  for (const action of actions.slice(0, 128)) {
    try {
      switch (action.type) {
        case "warm-scene": {
          const scene = await requireAutomationScene(action.sceneId);
          await renderDaemon.warmScene(scene);
          results.push({ action, status: "completed" });
          break;
        }
        case "preview-scene": {
          const scene = await requireAutomationScene(action.sceneId);
          await renderDaemon.warmScene(scene);
          await renderDaemon.setPreview(scene.id, scene.updatedAt);
          results.push({ action, status: "completed" });
          break;
        }
        case "take-scene": {
          if (action.transitionId) {
            results.push({
              action,
              status: "deferred",
              detail: "The native daemon currently certifies cut only; transitionId remains an explicit future render-compositor gate."
            });
            break;
          }
          const scene = await requireAutomationScene(action.sceneId);
          await renderDaemon.warmScene(scene);
          await renderDaemon.take(scene.id, scene.updatedAt);
          results.push({ action, status: "completed" });
          break;
        }
        case "release-scene": {
          const scene = await requireAutomationScene(action.sceneId);
          await renderDaemon.releaseScene(scene.id, scene.updatedAt);
          results.push({ action, status: "completed" });
          break;
        }
        case "patch-data": {
          let previousRevision = "";
          const scene = await updateScene(action.sceneId, (current) => {
            previousRevision = current.updatedAt;
            return {
              ...current,
              dataContext: setDataPath(current.dataContext, action.path, action.value),
              updatedAt: new Date().toISOString()
            };
          });
          if (!scene) throw new Error(`scene ${action.sceneId} was not found`);
          try {
            await renderDaemon.patchScene({
              type: "PATCH_DATA_CONTEXT",
              sceneId: scene.id,
              path: action.path,
              value: action.value
            }, previousRevision, scene.updatedAt);
            results.push({ action, status: "completed" });
          } catch (error) {
            results.push({
              action,
              status: "completed",
              detail: `Persisted; renderer sync deferred: ${error instanceof Error ? error.message : "daemon unavailable"}`
            });
          }
          break;
        }
        case "emit-event":
          results.push({ action, status: "completed", detail: "Event returned to the caller for fan-out." });
          break;
        case "start-timeline":
        case "pause-timeline":
          results.push({
            action,
            status: "deferred",
            detail: "Timeline-control protocol commands are modeled but not yet implemented by the native playback clock."
          });
          break;
        case "goto-cue":
          results.push({
            action,
            status: "deferred",
            detail: "Cue navigation is maintained by the sequencer client; the API does not invent rundown cursor ownership."
          });
          break;
      }
    } catch (error) {
      results.push({
        action,
        status: "failed",
        detail: error instanceof Error ? error.message : "automation action failed"
      });
    }
  }
  return results;
}

async function requireAutomationScene(sceneId: string): Promise<SceneDocument> {
  const scene = await readScene(sceneId);
  if (!scene) throw new Error(`scene ${sceneId} was not found`);
  return scene;
}

function normalizeTriggerEvent(value: unknown): GrapixTriggerEvent {
  const allowedTypes = new Set([
    "manual", "api", "webhook", "data-change", "timer", "timecode", "keyboard", "scene-event"
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("trigger event must be an object");
  const event = value as Partial<GrapixTriggerEvent>;
  if (!event.type || !allowedTypes.has(event.type)) throw new Error("unsupported trigger event type");
  if (!event.name?.trim() || event.name.length > 128) throw new Error("trigger event name must contain 1 to 128 characters");
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("trigger event payload must be an object");
  }
  if (Buffer.byteLength(JSON.stringify(event.payload), "utf8") > 64 * 1024) {
    throw new Error("trigger event payload exceeds 64 KiB");
  }
  return {
    type: event.type,
    name: event.name.trim(),
    timestampMs: typeof event.timestampMs === "number" && Number.isFinite(event.timestampMs)
      ? event.timestampMs
      : Date.now(),
    payload: structuredClone(event.payload)
  };
}

function pruneSequenceEngines(
  engines: Map<string, GrapixSequenceEngine>,
  prefix: string,
  activeKey: string
): void {
  for (const key of engines.keys()) {
    if (key.startsWith(prefix) && key !== activeKey) engines.delete(key);
  }
  if (engines.size > 512) {
    const first = engines.keys().next().value as string | undefined;
    if (first) engines.delete(first);
  }
}

function fontMimeType(extension: string): string {
  switch (extension) {
    case "otf": return "font/otf";
    case "ttf": return "font/ttf";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function readAllowedApiOrigins(): Set<string> {
  const origins = new Set([
    "grapix://editor",
    // Tauri 2 webview origins: tauri://localhost (macOS/Linux) and
    // http(s)://tauri.localhost (Windows WebView2).
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
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
  if (!isLoopbackHost(host) && !process.env.GRAPIX_API_TOKEN?.trim()) {
    throw new Error("GRAPIX_API_TOKEN is required when the API binds beyond loopback");
  }
  const app = await createApiServer({
    logger: options.logger
  });

  await app.listen({ port, host });

  return app;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function readApiToken(
  authorization: string | undefined,
  header: string | string[] | undefined
): string {
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return Array.isArray(header) ? header[0] ?? "" : header?.trim() ?? "";
}

function safeTokenEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isReadOnlyShowMode(): boolean {
  return process.env.GRAPIX_SHOW_MODE?.trim().toLowerCase() === "read-only";
}

function isMutation(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function isAllowedShowControl(url: string): boolean {
  const path = url.split("?")[0];
  return path.startsWith("/api/render-daemon/")
    || /^\/api\/scenes\/[a-zA-Z0-9_-]+\/(?:data-patches|events)$/.test(path)
    || /^\/api\/rundowns\/[a-zA-Z0-9_-]+\/events$/.test(path);
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

if (isDirectRun()) {
  await startApiServer();
}

function isDirectRun(): boolean {
  const entryPath = process.argv[1];

  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}
