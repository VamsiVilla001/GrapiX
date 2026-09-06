import cors from "@fastify/cors";
import { GrapixSequenceEngine } from "@grapix/sdk";
import {
  preflightScenePackage,
  type GrapixTriggerEvent,
  type DesignImportOptions,
  type FigmaDesignImportSource,
  type RundownDocument,
  type SceneDocument
} from "@grapix/shared-types";
import {
  AePackageError,
  AeRuntimeContainerError,
  type AePackageAnimationAction,
  type CreateAeRuntimeContainerRequest,
  type UpdateAeRuntimeContainerRequest
} from "@grapix/ae-runtime-contract";
import Fastify, { type FastifyInstance } from "fastify";

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
  parseDesignImportOptions,
  parseMotionMode
} from "./importers/design/designImportManager.js";
import {
  listAeGraphicVersions,
  publishAeContainer,
  validateAeContainerPublish
} from "./ae/aePublishService.js";
import { pushAePackageToPlayout } from "./ae/aePlayoutPush.js";
import {
  importAeCompositionAsScene,
  inspectAeProject,
  listAeProjects,
  readAeComposition
} from "./ae/aeProjectBrowser.js";
import {
  closeProject,
  createOrOpenProject,
  currentProject,
  ProjectWorkspaceError
} from "./projectWorkspace.js";
import { releaseImportFootage } from "./ae/aeImportFootage.js";
import { PROJECT_FILE_EXTENSION, projectAssetMimeType } from "@grapix/shared-types";
import nodePath from "node:path";
import { readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises";
import { listProjectAssets, resolveProjectAssetPath } from "./projectAssets.js";
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

import {
  autosaveScene,
  createAeRuntimeContainer,
  ensureStorage,
  forgetAeProjectRoot,
  importAssetBuffer,
  listAeRuntimeContainers,
  listRundowns,
  listSceneAutosaves,
  listScenes,
  readAeRuntimeContainer,
  readProjectImage,
  readRundown,
  readScene,
  readSceneAutosave,
  readStoredAsset,
  readStoredAssetContent,
  recoverScene,
  registerAeProjectPath,
  savePackage,
  saveRundown,
  saveScene,
  updateAeRuntimeContainer,
  updateScene
} from "./storage.js";
import { EditorDiscovery } from "./discovery.js";
import { describeError, DiagnosticsLog, type DiagnosticRecord } from "./diagnostics.js";
import {
  createAuthContext,
  PUBLIC_ROUTES,
  recordAudit,
  requirePermission,
  requireUser
} from "./auth.js";

/**
 * Published in the mDNS TXT record, so a peer can see what it found.
 *
 * A literal rather than a read of `package.json`: the bundled service is a single file with no
 * manifest beside it, and a version that resolves in development but not in an installed build is
 * worse than one that is maintained by hand.
 */
const SERVICE_VERSION = "0.1.0";

declare module "fastify" {
  interface FastifyInstance {
    /** The first administrator's generated password, present only on the run that created it. */
    bootstrapAdminPassword: string | null;
  }
}

export interface ApiServerOptions {
  host?: string;
  port?: number;
  logger?: boolean;
}

/**
 * A slot the listener fills once it knows its port.
 *
 * `createApiServer` is also used by tests and by embedded callers that never listen, and a service
 * with no port has nothing to advertise — so discovery cannot be built here. A caller-owned holder
 * keeps the reference typed and explicit; the alternatives were a Fastify decorator read back
 * through `Reflect`, or every route taking a parameter it does not use.
 */
export interface DiscoveryHolder {
  current: EditorDiscovery | null;
}

export interface CreateApiServerOptions extends Pick<ApiServerOptions, "logger"> {
  discovery?: DiscoveryHolder;
  /** Test-only: lets a suite stand the service up without a configured signing secret. */
  signingSecret?: string;
}

export async function createApiServer(options: CreateApiServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 512 * 1024 * 1024
  });

  // Identity and audit, before any route reads a token. If the signing secret is missing the
  // service cannot verify a single login, so starting anyway would only defer the failure to
  // the first operator who tries to sign in - fail fast instead.
  const auth = await createAuthContext({ ...(options.signingSecret ? { signingSecret: options.signingSecret } : {}) });
  if (auth.bootstrapPassword) {
    // Surfaced once, on the console, for whoever provisions the facility. Never logged to the
    // audit sink, never stored, and the bootstrap admin is expected to change it on first
    // sign-in.
    console.warn(
      `[auth] created the first administrator 'admin' with password: ${auth.bootstrapPassword}\n` +
        "       change it at first sign-in; it is shown this once and stored nowhere."
    );
  }

  app.addHook("onClose", async () => {
    await auth.audit.close();
  });

  // For whoever provisions the service: the generated password for the first administrator,
  // available exactly once, in memory, on the instance that just created it. Not logged, not
  // persisted - a process that wants it reads it here; one that restarts loses it, which is
  // why the operator is told to change it on first sign-in.
  app.decorate("bootstrapAdminPassword", auth.bootstrapPassword);

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  const allowedOrigins = readAllowedApiOrigins();
  const patchWindows = new Map<string, { startedAt: number; count: number }>();
  const sequenceEngines = new Map<string, GrapixSequenceEngine>();
  const discoveryHolder: DiscoveryHolder = options.discovery ?? { current: null };
  const designImportManager = new DesignImportManager();

  // The author console's service-side half. In memory only, bounded, and never on the path
  // of a frame: a diagnostic is an aid to the author in front of the machine, and the log is
  // read back through /api/diagnostics.
  const diagnostics = new DiagnosticsLog();

  // One SSE stream per open console panel. Written on every record so an open console is live
  // and a closed one costs nothing; a missed event costs one fetch, not a lost record, because
  // the UI reconciles with `?since=` against the log itself. Clients that leave without
  // closing are evicted by heartbeat timeout below.
  const diagnosticsClients = new Set<(record: DiagnosticRecord) => void>();
  diagnostics.onRecord((record) => {
    for (const client of diagnosticsClients) {
      try {
        client(record);
      } catch {
        // A dead client loses this record; its next poll reconciles from the log.
      }
    }
  });

  // Every uncaught route failure becomes a record before the generic 500 is sent, so the
  // console shows the throw the route could not explain rather than the UI's "API request
  // failed with 500".
  app.setErrorHandler((error, request, reply) => {
    const detail = describeError(error, "internal");
    diagnostics.record({
      level: "error",
      source: `http ${request.method} ${request.url.split("?")[0]}`,
      detail
    });
    void reply.code(500).send({ ok: false, error: detail.summary });
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
    // Declared, not defaulted. The default preflight answer here was `GET,HEAD,POST`, which
    // blocks the console's DELETE before the browser sends it — the same refusal Playout hit
    // on its own diagnostics route (see playout-control's CORS registration).
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"]
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;

    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).send({
        ok: false,
        error: "Origin is not allowed"
      });
    }

    // Everything except the public routes needs a verified user. `requireUser` either
    // attaches it or sends the 401 itself; the check runs on every request, not once at
    // connect, so an expired or revoked session is refused the moment it is used.
    const path = request.url.split("?")[0];
    if (!PUBLIC_ROUTES.has(path) && !requireUser(auth, request, reply)) {
      return reply;
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
    authenticationRequired: true,
    auditDropped: auth.audit.droppedCounts()
  }));

  // ---------------------------------------------------------------------------
  // Authentication
  //
  // The login that issues the tokens everything else requires. A failed login is audited with
  // the attempt and the address it came from, but never the password that was tried.
  // ---------------------------------------------------------------------------

  app.post<{ Body: { identifier?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
    const identifier = request.body?.identifier?.trim() ?? "";
    const password = request.body?.password ?? "";
    if (!identifier || !password) {
      return reply.code(400).send({ ok: false, error: "a username or email and a password are required" });
    }

    const outcome = await auth.auth.login(identifier, password);
    if ("failure" in outcome) {
      // One message for every failure: distinguishing "no such user" from "wrong password" is
      // a user-enumeration oracle, and the reason is already known to whoever typed it.
      recordAudit(auth, request, {
        action: "auth.login-failed",
        result: "failure",
        username: identifier,
        detail: { reason: outcome.failure }
      });
      return reply.code(401).send({ ok: false, error: "incorrect username or password" });
    }

    recordAudit(auth, request, {
      action: "auth.login",
      result: "success",
      userId: outcome.session.user.id,
      username: outcome.session.user.username,
      role: outcome.session.user.role,
      sessionId: outcome.session.id
    });
    return {
      ok: true,
      user: outcome.session.user,
      sessionId: outcome.session.id,
      accessToken: outcome.tokens.accessToken,
      refreshToken: outcome.tokens.refreshToken,
      expiresAt: outcome.tokens.accessClaims.exp
    };
  });

  app.post<{ Body: { refreshToken?: string } }>("/api/auth/refresh", async (request, reply) => {
    const refreshToken = request.body?.refreshToken?.trim() ?? "";
    if (!refreshToken) {
      return reply.code(400).send({ ok: false, error: "a refresh token is required" });
    }
    const outcome = await auth.auth.refresh(refreshToken);
    if ("failure" in outcome) {
      return reply.code(401).send({ ok: false, error: "session is not valid; sign in again" });
    }
    recordAudit(auth, request, {
      action: "auth.refresh",
      result: "success",
      userId: outcome.session.user.id,
      username: outcome.session.user.username,
      role: outcome.session.user.role,
      sessionId: outcome.session.id
    });
    return {
      ok: true,
      user: outcome.session.user,
      sessionId: outcome.session.id,
      accessToken: outcome.tokens.accessToken,
      refreshToken: outcome.tokens.refreshToken,
      expiresAt: outcome.tokens.accessClaims.exp
    };
  });

  app.post<{ Body: { sessionId?: string } }>("/api/auth/logout", async (request) => {
    // Logout needs the user's session to know what to end, so it is authenticated like
    // everything else; the hook has already attached the user.
    const sessionId = request.body?.sessionId ?? request.grapixUser?.sessionId ?? "";
    const ended = sessionId ? auth.auth.logout(sessionId) : false;
    if (ended) {
      recordAudit(auth, request, { action: "auth.logout", result: "success" });
    }
    return { ok: true, ended };
  });

  app.get("/api/auth/me", async (request) => ({
    ok: true,
    user: request.grapixUser
  }));

  // ---------------------------------------------------------------------------
  // Diagnostics
  //
  // The tail the author console reads. `?since=` is the highest sequence the console already
  // holds, so a live console asks for what it does not have rather than re-fetching the
  // buffer on every event. `latestSequence` is returned even on an empty page so the client
  // can tell "nothing new" from "empty log".
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { since?: string; limit?: string } }>("/api/diagnostics", async (request) => {
    const since = Number(request.query.since);
    const limit = Number(request.query.limit);
    return {
      ok: true,
      records: diagnostics.list({
        ...(Number.isSafeInteger(since) && since > 0 ? { since } : {}),
        ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {})
      }),
      latestSequence: diagnostics.latestSequence(),
      capacity: DiagnosticsLog.CAPACITY
    };
  });

  app.delete("/api/diagnostics", async () => ({
    ok: true,
    cleared: diagnostics.clear(),
    latestSequence: diagnostics.latestSequence()
  }));

  app.get("/api/diagnostics/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // The route sits behind the same CORS check as everything else; the header is what a
      // browser EventSource requires to accept the stream cross-origin.
      ...(request.headers.origin ? { "access-control-allow-origin": request.headers.origin } : {})
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ latestSequence: diagnostics.latestSequence() })}\n\n`);

    const send = (record: DiagnosticRecord) => {
      reply.raw.write(
        `event: diagnostics.logged\ndata: ${JSON.stringify({ sequence: record.sequence, level: record.level })}\n\n`
      );
    };
    diagnosticsClients.add(send);

    // A client that closed without the close event firing — a killed tab, a sleeping laptop —
    // stops answering heartbeats and is evicted, so the set cannot grow with ghosts.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch {
        // close handler below does the cleanup.
      }
    }, 25_000);

    const drop = () => {
      clearInterval(heartbeat);
      diagnosticsClients.delete(send);
    };
    request.raw.on("close", drop);
    reply.raw.on("error", drop);
  });

  // -------------------------------------------------------------------------
  // Local-link discovery
  //
  // The browser UI cannot speak mDNS — there is no multicast API in a page — so it asks this
  // service where Playout is. That keeps one discovery implementation in the repository instead
  // of a second, weaker one written against whatever a page can reach.
  // -------------------------------------------------------------------------

  app.get("/api/discovery", async () => ({
    ok: true,
    discovery: discoveryHolder.current?.status() ?? {
      advertising: false,
      instance: null,
      interfaces: [],
      unavailableReason: "discovery was not started (this service is running without a listener)",
      playout: null,
      discoveredPlayout: []
    }
  }));

  /**
   * Where Playout is.
   *
   * `?refresh=true` re-proves rather than answering from the trust window — what the Editor UI
   * sends after a publish has just failed, because the failure is better evidence than the cache.
   */
  app.get<{ Querystring: { refresh?: string } }>("/api/discovery/playout", async (request, reply) => {
    const discovery = discoveryHolder.current;
    if (!discovery) {
      return reply.code(503).send({
        ok: false,
        error: "This project service is not running a discovery listener, so it cannot locate Playout."
      });
    }
    if (request.query.refresh === "true") await discovery.forgetPlayout();

    const endpoint = await discovery.resolvePlayout();
    if (!endpoint) {
      return reply.code(404).send({
        ok: false,
        error:
          "No Playout control service answered — not at its configured address, not on this machine, and nothing on the local link announced one.",
        remedy:
          "Start Playout (`npm run dev:playout`). If it runs on another machine, check that machine is on the same switch, or set GRAPIX_PLAYOUT_API_URL here.",
        discovery: discovery.status()
      });
    }
    return { ok: true, endpoint };
  });

  // Registered here, before `listen`: Fastify refuses `addHook` on a started instance, and adding
  // it after listening crashed the service on boot. The goodbye matters — a peer that is not told
  // keeps offering an operator an Editor that has closed, for the full record lifetime.
  app.addHook("onClose", async () => {
    await discoveryHolder.current?.stop();
  });

  // Authoring and operations, audited. The hook sees the *result*, which is what makes the
  // log worth keeping: not "a scene was touched" but "this scene edit, by this user, from
  // this machine, succeeded" - or failed, with the status that explains why.
  app.addHook("onResponse", async (request, reply) => {
    if (!isMutation(request.method)) return;
    const route = (request.routeOptions.url ?? request.url.split("?")[0]).toLowerCase();
    const ok = reply.statusCode < 400;

    let action: Parameters<typeof recordAudit>[2]["action"] | null = null;
    let sceneId: string | null = null;
    let revision: number | null = null;

    const body = request.body as Record<string, unknown> | undefined;
    if (route.includes("/api/scenes") && route.includes("publish")) action = "scene.publish";
    else if (route.includes("/api/scenes") || route.includes("/api/projects")) action = "scene.edit";
    else if (route.includes("/api/assets")) action = "asset.upload";
    else if (route.includes("/api/settings") || route.includes("/api/config")) action = "settings.change";
    else if (route.includes("/api/auth/users")) action = "user.change";

    if (typeof body?.sceneId === "string") sceneId = body.sceneId;
    if (typeof body?.id === "string") sceneId = sceneId ?? body.id;
    if (typeof body?.revision === "number") revision = body.revision;

    if (action) {
      recordAudit(auth, request, {
        action,
        result: ok ? "success" : "failure",
        sceneId,
        revision,
        ...(ok ? {} : { error: { code: `HTTP_${reply.statusCode}`, message: `${request.method} ${route}` } }),
        detail: { route: `${request.method} ${route}`, status: reply.statusCode }
      });
    }
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
    const extension = fileName.toLowerCase().split(".").pop();
    if ((extension === "aep" || extension === "aepx") &&
        (!Buffer.isBuffer(request.body) || request.body.length === 0)) {
      return reply.code(400).send({
        ok: false,
        error: "A non-empty binary After Effects project body is required."
      });
    }
    const report = inspectAeImport(fileName, request.body);
    return reply.code(report.accepted ? 200 : 422).send({
      ok: report.accepted,
      report,
      approvedPaths: ["Lottie", "alpha video", "image sequence manifest", "structured GrapiX conversion"]
    });
  });



  app.post<{
    Querystring: { fileName?: string; options?: string; motionMode?: string };
    Body: Buffer;
  }>("/api/import/design-file", async (request, reply) => {
    const fileName = request.query.fileName?.trim();
    if (!fileName || !Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.code(400).send({ ok: false, error: "A non-empty PSD, AI/PDF, SVG, or exported Figma JSON file is required." });
    }
    try {
      /*
       * Only the mode travels here, never a manifest: this route's body is the design's raw
       * bytes, so there is nowhere for a second file to ride. That costs nothing for an exported
       * Figma document, which carries its own prototype data — `design-and-prototype-motion`
       * works on it unchanged. A bridge manifest needs the Figma route, whose body is JSON.
       */
      const result = await designImportManager.importFile(
        request.body,
        fileName,
        parseDesignImportOptions(request.query.options),
        { motionMode: parseMotionMode(request.query.motionMode) }
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

    // The checksum is the bytes' identity, so it is the etag: a replaced asset (same id, new
    // bytes) must not satisfy a cache keyed on the URL. Clients that hold decoded bytes — the
    // Editor's preview blob-URL cache is one — key on this, not on the address.
    return reply
      .type(asset.record.mimeType)
      .header("etag", `"${asset.record.checksum}"`)
      .send(asset.bytes);
  });

  /**
   * Serve a project image by its own path.
   *
   * Imported design images live at `images/<scene>/<file>` and the scene references them by exactly
   * that path — no asset id, no expiring URL. The editor preview, the thumbnail renderer and
   * Playout's publish all read them through here, so one path in the document works everywhere.
   *
   * Wildcard rather than `:scene/:file` so a nested folder is possible later; `readProjectImage`
   * re-validates every segment, because this route reads whatever the scene tells it to.
   */
  app.get<{ Params: { "*": string } }>("/images/*", async (request, reply) => {
    const image = await readProjectImage(`images/${request.params["*"]}`);
    if (!image) return reply.code(404).send({ ok: false, error: "Project image not found" });

    // Immutable in practice: a re-import writes a new name when the bytes differ, so a cached copy
    // can never be the wrong picture.
    return reply

      .type(image.mimeType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(image.bytes);
  });
  const aeContainerFailure = (error: unknown, reply: Parameters<Parameters<typeof app.setErrorHandler>[0]>[2]) => {
    if (!(error instanceof AeRuntimeContainerError)) throw error;
    const status = error.code === "CONTAINER_NOT_FOUND" || error.code === "PROJECT_NOT_FOUND"
      ? 404
      : error.code === "PROJECT_DIGEST_MISMATCH" || error.code === "CONTAINER_ALREADY_EXISTS"
        ? 409
        : 400;
    return reply.code(status).send({ ok: false, code: error.code, error: error.message });
  };

  app.post<{ Body: CreateAeRuntimeContainerRequest }>("/api/ae-runtime/containers", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    try {
      const container = await createAeRuntimeContainer(request.body);
      recordAudit(auth, request, {
        action: "scene.edit",
        result: "success",
        detail: {
          containerId: container.id,
          projectUri: container.projectUri,
          projectDigest: container.projectDigest
        }
      });
      return reply.code(201).send({ ok: true, container });
    } catch (error) {
      return aeContainerFailure(error, reply);
    }
  });

  app.get("/api/ae-runtime/containers", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    try {
      return { ok: true, containers: await listAeRuntimeContainers() };
    } catch (error) {
      return aeContainerFailure(error, reply);
    }
  });

  app.get<{ Params: { containerId: string } }>("/api/ae-runtime/containers/:containerId", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    try {
      const container = await readAeRuntimeContainer(request.params.containerId);
      return container
        ? { ok: true, container }
        : reply.code(404).send({ ok: false, code: "CONTAINER_NOT_FOUND", error: "Runtime container not found" });
    } catch (error) {
      return aeContainerFailure(error, reply);
    }
  });

  app.patch<{
    Params: { containerId: string };
    Body: UpdateAeRuntimeContainerRequest;
  }>("/api/ae-runtime/containers/:containerId", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    try {
      const container = await updateAeRuntimeContainer(request.params.containerId, request.body ?? {});
      if (!container) {
        return reply.code(404).send({
          ok: false,
          code: "CONTAINER_NOT_FOUND",
          error: "Runtime container not found"
        });
      }
      recordAudit(auth, request, {
        action: "scene.edit",
        result: "success",
        detail: { containerId: container.id, status: container.status }
      });
      return { ok: true, container };
    } catch (error) {
      return aeContainerFailure(error, reply);
    }
  });

  /*
   * Publishing an After Effects graphic.
   *
   * `validate` writes nothing and is safe to call as often as an author edits; `publish` allocates
   * the next immutable version. Both take a container id rather than a project path: the container
   * is what carries the declared controls and the digest the publish is checked against, and a
   * path-addressed publish could package a project no container ever validated.
   */
  const aePackageFailure = (error: unknown, reply: Parameters<Parameters<typeof app.setErrorHandler>[0]>[2]) => {
    if (error instanceof AeRuntimeContainerError) return aeContainerFailure(error, reply);
    if (!(error instanceof AePackageError)) throw error;
    const status = error.code === "CONTAINER_NOT_FOUND"
      ? 404
      : error.code === "VERSION_ALREADY_EXISTS"
        ? 409
        : error.code === "VALIDATION_FAILED"
          ? 422
          : 400;
    return reply.code(status).send({
      ok: false,
      code: error.code,
      error: error.message,
      // The refusals travel with the failure: an author told only "publish refused" has to go
      // looking for the reason that was already computed.
      validation: error.validation ?? undefined
    });
  };

  /*
   * The design-time browser: which projects exist, what is inside one, and what a composition's
   * layers offer. Read from the binary rather than from a running After Effects, so an author can
   * choose what to publish without a licensed application open.
   */
  app.get("/api/ae/projects", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    try {
      return { ok: true, projects: await listAeProjects() };
    } catch (error) {
      return aePackageFailure(error, reply);
    }
  });

  /*
   * Choosing a project is what makes it readable.
   *
   * The allowlist still refuses everything outside it; this is the act that adds to it, so an
   * author can point GrapiX at a project without an environment variable having been set before the
   * service started. It takes the path of a `.aep` and registers the folder that holds it — never a
   * folder the caller names directly.
   */
  app.post<{ Body: { path?: string } }>("/api/ae/projects/register", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    const projectPath = request.body?.path?.trim();
    if (!projectPath) return reply.code(400).send({ ok: false, error: "path is required" });
    try {
      const registered = await registerAeProjectPath(projectPath);
      recordAudit(auth, request, {
        action: "scene.edit",
        result: "success",
        detail: { registeredAeRoot: registered.root, projectUri: registered.projectUri }
      });
      return reply.code(201).send({ ok: true, ...registered });
    } catch (error) {
      return aePackageFailure(error, reply);
    }
  });

  app.post<{ Body: { root?: string } }>("/api/ae/projects/forget", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    const root = request.body?.root?.trim();
    if (!root) return reply.code(400).send({ ok: false, error: "root is required" });
    try {
      await forgetAeProjectRoot(root);
      return { ok: true };
    } catch (error) {
      return aePackageFailure(error, reply);
    }
  });
  /* ── Project Workspace routes ────────────────────────────────────────────────────────── */

  app.get("/api/project", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.read")) return reply;
    try {
      return { ok: true, project: await currentProject() };
    } catch (error) {
      return reply.code(500).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  /*
   * Open a project, or create one where the operator pointed.
   *
   * `root` may be either the project directory or the `.gpxpkg` file inside it, because the two
   * dialogs that reach here answer different questions: "choose a folder" gives a directory, and
   * "save project as" gives a file that does not exist yet. Normalising here keeps that difference
   * out of every caller.
   */
  app.post<{ Body: { root?: string; name?: string } }>("/api/project/open", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    const chosen = request.body?.root?.trim();
    if (!chosen) return reply.code(400).send({ ok: false, error: "a project folder or .gpxpkg path is required" });
    const isProjectFile = chosen.toLowerCase().endsWith(PROJECT_FILE_EXTENSION);
    const root = isProjectFile ? nodePath.dirname(chosen) : chosen;
    try {
      const project = await createOrOpenProject(root, request.body?.name, isProjectFile ? chosen : undefined);
      recordAudit(auth, request, { action: "settings.change", result: "success", detail: { openProject: root } });
      return { ok: true, project };
    } catch (error) {
      const statusCode = error instanceof ProjectWorkspaceError && error.code === "ROOT_NOT_FOUND" ? 404 : 400;
      return reply.code(statusCode).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/project/close", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    try {
      await closeProject();
      return { ok: true };
    } catch (error) {
      return reply.code(500).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  /*
   * The project's asset folders, as the Material Manager's library.
   *
   * A read of the directories every time rather than a cached index. The panel refreshes on focus
   * and after an import, and a designer who drops files in with the file manager gets no event we
   * could invalidate a cache with — so the only index that cannot go stale is the one we do not
   * keep. A project with a few thousand assets costs a directory walk, which is cheap next to
   * being wrong about what the operator can see in Explorer.
   *
   * With no project this answers `200` with an empty library and `projectOpen: false`, the same
   * way `listScenes` answers `[]`. A read is a question, and "what is in the library" has a true
   * answer before a project exists. The flag is what lets the panel say *why* it is empty —
   * "save the project first" rather than "no assets" — without making the caller catch an error
   * to find out.
   */
  app.get("/api/project/assets", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.read")) return reply;
    try {
      return { ok: true, projectOpen: true, assets: await listProjectAssets() };
    } catch (error) {
      if (error instanceof ProjectWorkspaceError && error.code === "NO_PROJECT_OPEN") {
        return { ok: true, projectOpen: false, assets: [] };
      }
      return reply.code(500).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  /*
   * Serve one project asset by the path the library gave out.
   *
   * The path is in the query string rather than the URL path because an asset path contains
   * separators and spaces — `Assets/Images/Show A/bg.png` — and encoding that into a route
   * parameter means every consumer has to agree on the encoding. One decode, one containment
   * check, one answer.
   *
   * A single 404 covers every refusal. Distinguishing "outside the project" from "does not exist"
   * would let a caller map the filesystem one request at a time.
   */
  app.get<{ Querystring: { path?: string } }>("/api/project/assets/content", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.read")) return reply;
    const requested = request.query?.path;
    if (!requested) return reply.code(400).send({ ok: false, error: "a project-relative path is required" });

    const resolved = await resolveProjectAssetPath(requested);
    if (!resolved) return reply.code(404).send({ ok: false, error: "Asset not found" });

    const info = await nodeStat(resolved);
    return reply
      .type(projectAssetMimeType(nodePath.basename(resolved)))
      // Size and mtime, not a content hash: this route must not read a 400 MB video to answer a
      // conditional request. Replacing the file in place changes both, which is the case that has
      // to invalidate a cached texture.
      .header("etag", `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`)
      .header("cache-control", "no-cache")
      .send(await nodeReadFile(resolved));
  });


  app.post<{ Body: { projectUri?: string } }>("/api/ae/projects/inspect", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    const projectUri = request.body?.projectUri?.trim();
    if (!projectUri) return reply.code(400).send({ ok: false, error: "projectUri is required" });
    try {
      return { ok: true, project: await inspectAeProject(projectUri) };
    } catch (error) {
      return aePackageFailure(error, reply);
    }
  });

  app.post<{ Body: { projectUri?: string; compositionId?: string } }>(
    "/api/ae/projects/composition",
    async (request, reply) => {
      if (!requirePermission(auth, request, reply, "scene.write")) return reply;
      const projectUri = request.body?.projectUri?.trim();
      const compositionId = request.body?.compositionId?.trim();
      if (!projectUri || !compositionId) {
        return reply.code(400).send({ ok: false, error: "projectUri and compositionId are required" });
      }
      try {
        return { ok: true, ...(await readAeComposition(projectUri, compositionId)) };
      } catch (error) {
        return aePackageFailure(error, reply);
      }
    }
  );

  /*
   * Design-time import: one composition becomes a new, editable scene.
   *
   * Unlike the publish path below — which packages a container for Playout and never touches the
   * Object Manager — this materializes the composition as a native scene the author edits: layers
   * become objects, keyframed transforms become timeline channels. The converted scene is saved
   * through the ordinary scene path so it carries a revision and a backup like any authored scene.
   */
  app.post<{ Body: { projectUri?: string; compositionId?: string; sceneName?: string } }>(
    "/api/ae/projects/import-scene",
    async (request, reply) => {
      if (!requirePermission(auth, request, reply, "scene.write")) return reply;
      const projectUri = request.body?.projectUri?.trim();
      const compositionId = request.body?.compositionId?.trim();
      if (!projectUri || !compositionId) {
        return reply.code(400).send({ ok: false, error: "projectUri and compositionId are required" });
      }
      try {
        const imported = await importAeCompositionAsScene(projectUri, compositionId);
        if (request.body?.sceneName?.trim()) imported.scene.name = request.body.sceneName.trim();
        const summary = await saveScene(imported.scene);
        recordAudit(auth, request, {
          action: "scene.edit",
          result: "success",
          detail: { importedAeScene: imported.scene.id, fromComposition: compositionId, projectUri }
        });
        return reply.code(201).send({
          ok: true,
          sceneId: imported.scene.id,
          scene: imported.scene,
          summary,
          warnings: imported.warnings,
          convertedLayers: imported.convertedLayers
        });
      } catch (error) {
        return aePackageFailure(error, reply);
      }
    }
  );
  /*
   * Import composition as a removable subtree into an existing scene / template.
   */
  app.post<{ Body: { projectUri?: string; compositionId?: string; targetSceneId?: string } }>(
    "/api/ae/projects/import-into-scene",
    async (request, reply) => {
      if (!requirePermission(auth, request, reply, "scene.write")) return reply;
      const projectUri = request.body?.projectUri?.trim();
      const compositionId = request.body?.compositionId?.trim();
      const targetSceneId = request.body?.targetSceneId?.trim();
      if (!projectUri || !compositionId || !targetSceneId) {
        return reply.code(400).send({ ok: false, error: "projectUri, compositionId, and targetSceneId are required" });
      }
      try {
        const targetScene = await readScene(targetSceneId);
        if (!targetScene) return reply.code(404).send({ ok: false, error: `target scene ${targetSceneId} not found` });

        const imported = await importAeCompositionAsScene(projectUri, compositionId);
        const nextObjects = [...targetScene.objects, ...imported.scene.objects];
        const updatedScene = { ...targetScene, objects: nextObjects };
        const summary = await saveScene(updatedScene);

        recordAudit(auth, request, {
          action: "scene.edit",
          result: "success",
          detail: { targetSceneId, fromComposition: compositionId, importId: imported.importId }
        });
        return reply.code(200).send({
          ok: true,
          sceneId: targetSceneId,
          scene: updatedScene,
          importId: imported.importId,
          summary,
          warnings: imported.warnings,
          convertedLayers: imported.convertedLayers
        });
      } catch (error) {
        return aePackageFailure(error, reply);
      }
    }
  );

  /*
   * Remove an imported composition group subtree from a scene and release its collected assets.
   */
  app.post<{ Body: { sceneId?: string; importId?: string } }>(
    "/api/ae/projects/remove-import",
    async (request, reply) => {
      if (!requirePermission(auth, request, reply, "scene.write")) return reply;
      const sceneId = request.body?.sceneId?.trim();
      const importId = request.body?.importId?.trim();
      if (!sceneId || !importId) {
        return reply.code(400).send({ ok: false, error: "sceneId and importId are required" });
      }
      try {
        const scene = await readScene(sceneId);
        if (!scene) return reply.code(404).send({ ok: false, error: `scene ${sceneId} not found` });

        const rootGroupId = `ae-import-${importId}`;
        const rootGroup = scene.objects.find(
          (obj) => obj.id === rootGroupId || obj.importedDesign?.raw?.importId === importId
        );
        if (!rootGroup) {
          return reply.code(404).send({ ok: false, error: `imported composition ${importId} not found in scene ${sceneId}` });
        }

        // Collect all object IDs in the group subtree
        const toRemove = new Set<string>();
        const collectSubtree = (objId: string) => {
          if (toRemove.has(objId)) return;
          toRemove.add(objId);
          const obj = scene.objects.find((o) => o.id === objId);
          if (obj && "childIds" in obj && Array.isArray(obj.childIds)) {
            for (const childId of obj.childIds) collectSubtree(childId);
          }
        };
        collectSubtree(rootGroup.id);

        // Remove collected objects and update parent childIds
        const remainingObjects = scene.objects
          .filter((obj) => !toRemove.has(obj.id))
          .map((obj) => {
            if ("childIds" in obj && Array.isArray(obj.childIds)) {
              return { ...obj, childIds: obj.childIds.filter((cid: string) => !toRemove.has(cid)) };
            }
            return obj;
          });

        const updatedScene = { ...scene, objects: remainingObjects };
        await saveScene(updatedScene);
        const releaseResult = await releaseImportFootage(importId).catch(() => ({ deleted: [], retained: [] }));

        recordAudit(auth, request, {
          action: "scene.edit",
          result: "success",
          detail: { removedImportId: importId, sceneId, deletedObjects: toRemove.size }
        });
        return reply.code(200).send({
          ok: true,
          sceneId,
          scene: updatedScene,
          importId,
          deletedObjectCount: toRemove.size,
          releasedFootage: releaseResult
        });
      } catch (error) {
        return aePackageFailure(error, reply);
      }
    }
  );

  app.post<{ Body: { containerId?: string } }>("/api/ae/publish/validate", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    const containerId = request.body?.containerId?.trim();
    if (!containerId) return reply.code(400).send({ ok: false, error: "containerId is required" });
    try {
      const validation = await validateAeContainerPublish({ containerId });
      return { ok: true, validation };
    } catch (error) {
      return aePackageFailure(error, reply);
    }
  });

  app.post<{
    Body: {
      containerId?: string;
      actions?: AePackageAnimationAction[];
      cueMapDigest?: string;
      collectedFootageDir?: string;
    };
  }>("/api/ae/publish", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    const containerId = request.body?.containerId?.trim();
    if (!containerId) return reply.code(400).send({ ok: false, error: "containerId is required" });
    try {
      const built = await publishAeContainer({
        containerId,
        actions: request.body?.actions,
        cueMapDigest: request.body?.cueMapDigest,
        collectedFootageDir: request.body?.collectedFootageDir
      });
      recordAudit(auth, request, {
        action: "scene.publish",
        result: "success",
        detail: { containerId, version: built.version, files: built.fileCount, bytes: built.totalBytes }
      });
      // The publish is already durable; this is the announcement to Playout. It is awaited so the
      // response can say whether Playout now sees the graphic, but a failed push never fails the
      // publish — the author is told to re-sync instead.
      const playout = await pushAePackageToPlayout(discoveryHolder.current, built.directory);
      return reply.code(201).send({
        ok: true,
        version: built.version,
        manifest: built.manifest,
        validation: built.validation,
        fileCount: built.fileCount,
        totalBytes: built.totalBytes,
        playout
      });
    } catch (error) {
      return aePackageFailure(error, reply);
    }
  });

  app.get<{ Params: { graphicId: string } }>("/api/ae/packages/:graphicId/versions", async (request, reply) => {
    if (!requirePermission(auth, request, reply, "scene.write")) return reply;
    try {
      return { ok: true, versions: await listAeGraphicVersions(request.params.graphicId) };
    } catch (error) {
      return aePackageFailure(error, reply);
    }
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

  /**
   * Take an autosave snapshot of the posted scene.
   *
   * The body is the in-memory scene, not a scene id: the whole point is to capture work that
   * has *not* been saved. Writing to `scenes/` here would defeat the exercise.
   */
  app.post<{
    Params: { sceneId: string };
    Body: { scene?: SceneDocument; maxVersions?: number };
  }>("/api/scenes/:sceneId/autosave", async (request, reply) => {
    const scene = request.body?.scene;
    if (!scene || typeof scene !== "object") {
      return reply.code(400).send({ ok: false, error: "An autosave requires a scene document" });
    }
    if (scene.id !== request.params.sceneId) {
      return reply
        .code(400)
        .send({ ok: false, error: "Scene id in the body does not match the request path" });
    }

    try {
      const entry = await autosaveScene(scene, request.body?.maxVersions ?? 10);
      return { ok: true, autosave: entry };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Autosave failed"
      });
    }
  });

  /**
   * A scene's snapshots, with the revision the service currently holds for it.
   *
   * The revision travels with the list because the comparison it exists for — is this
   * snapshot older than what is stored, and therefore dangerous to restore and publish — is
   * between two numbers this service owns. A client that tracked it instead would be
   * comparing against whatever revision its document was loaded with.
   */
  app.get<{ Params: { sceneId: string } }>("/api/scenes/:sceneId/autosaves", async (request) => {
    const [autosaves, scene] = await Promise.all([
      listSceneAutosaves(request.params.sceneId),
      readScene(request.params.sceneId)
    ]);
    return { ok: true, autosaves, sceneRevision: scene?.revision ?? 0 };
  });

  /**
   * Read one snapshot without restoring it, so the operator can compare revisions before
   * choosing. Restoring is an ordinary save of the returned document.
   */
  app.get<{ Params: { sceneId: string; version: string } }>(
    "/api/scenes/:sceneId/autosaves/:version",
    async (request, reply) => {
      const version = Number(request.params.version);
      if (!Number.isInteger(version)) {
        return reply.code(400).send({ ok: false, error: "Autosave version must be an integer" });
      }
      const scene = await readSceneAutosave(request.params.sceneId, version);
      if (!scene) {
        return reply.code(404).send({ ok: false, error: "No such autosave" });
      }
      return { ok: true, scene };
    }
  );

  app.patch<{
    Params: { sceneId: string; objectId: string };
    Body: Record<string, unknown>;
  }>("/api/scenes/:sceneId/objects/:objectId", async (request, reply) => {
    const scene = await updateScene(request.params.sceneId, (currentScene) => {
      if (!currentScene.objects.some((object) => object.id === request.params.objectId)) {
        throw new SceneElementNotFoundError("Object");
      }
      return {
        ...currentScene,
        updatedAt: new Date().toISOString(),
        objects: currentScene.objects.map((object) =>
          object.id === request.params.objectId ? ({ ...object, ...request.body } as typeof object) : object
        )
      };
    }).catch((error: unknown) => {
      if (error instanceof SceneElementNotFoundError) return error;
      throw error;
    });

    if (scene instanceof SceneElementNotFoundError) {
      return reply.code(404).send({ ok: false, error: `${scene.element} not found` });
    }
    if (!scene) {
      return reply.code(404).send({ ok: false, error: "Scene not found" });
    }

    return { ok: true, scene };
  });

  app.patch<{
    Params: { sceneId: string; materialId: string };
    Body: Record<string, unknown>;
  }>("/api/scenes/:sceneId/materials/:materialId", async (request, reply) => {
    const scene = await updateScene(request.params.sceneId, (currentScene) => {
      if (!currentScene.materials.some((material) => material.materialId === request.params.materialId)) {
        throw new SceneElementNotFoundError("Material");
      }
      return {
        ...currentScene,
        updatedAt: new Date().toISOString(),
        materials: currentScene.materials.map((material) =>
          material.materialId === request.params.materialId ? { ...material, ...request.body } : material
        )
      };
    }).catch((error: unknown) => {
      if (error instanceof SceneElementNotFoundError) return error;
      throw error;
    });

    if (scene instanceof SceneElementNotFoundError) {
      return reply.code(404).send({ ok: false, error: `${scene.element} not found` });
    }
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
      if (error instanceof SceneRevisionConflictError || error instanceof DataPatchInputError) return error;
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
    if (scene instanceof DataPatchInputError) {
      return reply.code(400).send({ ok: false, error: scene.message });
    }
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

  // --- Scene automation (evaluation only) ----------------------------------
  // The Editor evaluates automation so an author can see what a trigger would
  // do. It never executes it: Cue, Take, Continue, Clear and output control
  // belong to Playout, and the engine rejects them from an Editor role. See
  // docs/architecture.md, invariant 4.

  app.post<{
    Params: { rundownId: string };
    Body: {
      event: GrapixTriggerEvent;
      sceneData?: Record<string, unknown>;
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
    return { ok: true, evaluation, dryRun: true };
  });

  app.post<{
    Params: { sceneId: string };
    Body: { event: GrapixTriggerEvent };
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
    return { ok: true, evaluation, dryRun: true };
  });

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


class SceneElementNotFoundError extends Error {
  constructor(readonly element: "Object" | "Material") {
    super(`${element} not found`);
  }
}
class DataPatchInputError extends Error {}

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
  if (!path || path.length > 256) throw new DataPatchInputError("data path must contain 1 to 256 characters");
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (!segments.length || segments.length > 32) {
    throw new DataPatchInputError("data path must contain 1 to 32 segments");
  }
  if (segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
    throw new DataPatchInputError("data path contains a reserved segment");
  }
  const clone = structuredClone(original);
  let current: Record<string, unknown> = clone;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined) {
      current[segment] = {};
    } else if (typeof child !== "object" || child === null || Array.isArray(child)) {
      throw new DataPatchInputError(`data path crosses non-object segment ${segment}`);
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
  return clone;
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
  const discoveryHolder: DiscoveryHolder = { current: null };
  const app = await createApiServer({
    logger: options.logger,
    discovery: discoveryHolder
  });

  await app.listen({ port, host });

  // After listening, so the advertisement carries the port that is actually bound rather than the
  // one that was requested — they differ whenever the caller passes 0.
  const discovery = new EditorDiscovery({
    port: addressPort(app) ?? port,
    version: SERVICE_VERSION,
    onWarning: (message, error) => app.log.warn({ err: error }, `[discovery] ${message}`),
    onRouteChange: (endpoint, previous) => {
      app.log.info(
        `[discovery] Playout is at ${endpoint.url} (${endpoint.route})${
          previous ? `, was ${previous.url} (${previous.route})` : ""
        }`
      );
    }
  });
  discoveryHolder.current = discovery;

  if (await discovery.start()) {
    app.log.info(`[discovery] announcing this Editor on the local link as ${discovery.status().instance}`);
  }

  return app;
}

/**
 * Close cleanly on a signal.
 *
 * The service had no signal handling at all, so every stop was a hard kill: Fastify's `onClose`
 * hooks never ran, and with discovery that means the mDNS goodbye was never sent — a peer kept
 * offering an operator an Editor that had shut down until the record expired two minutes later.
 * Registered only for a direct run, so an embedded caller keeps control of its own lifecycle.
 */
function closeOnSignal(app: FastifyInstance): void {
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}



/** The port Fastify actually bound, when it can be read. */
function addressPort(app: FastifyInstance): number | null {
  const address = app.server.address();
  return typeof address === "object" && address !== null ? address.port : null;
}


function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isReadOnlyShowMode(): boolean {
  return process.env.GRAPIX_SHOW_MODE?.trim().toLowerCase() === "read-only";
}

function isMutation(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function isAllowedShowControl(url: string): boolean {
  const path = url.split("?")[0];
  return /^\/api\/scenes\/[a-zA-Z0-9_-]+\/(?:data-patches|events)$/.test(path)
    || /^\/api\/rundowns\/[a-zA-Z0-9_-]+\/events$/.test(path);
}

if (isDirectRun()) {
  closeOnSignal(await startApiServer());
}

function isDirectRun(): boolean {
  const entryPath = process.argv[1];

  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}
