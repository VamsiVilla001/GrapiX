import cors from "@fastify/cors";
import type {
  PlayoutTakeList,
  SceneDocument
} from "@grapix/shared-types";
import {
  AeDataRevisionRefusal,
  AePackageReadError,
  readAePackage,
  type AeDataRevisionRequest,
  type AeDynamicControl
} from "@grapix/ae-runtime-contract";
import Fastify, { type FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineSupervisor } from "./engineSupervisor.js";
import { AeRuntimeSupervisor } from "./aeRuntimeSupervisor.js";
import { AeControlRefusal, AeControlService } from "./aeControlService.js";
import { AeContainerStore } from "./aeContainerStore.js";
import { AeCueService, AeCueServiceRefusal } from "./aeCueService.js";
import { AePackageStore } from "./aePackageStore.js";
import { attachAeContainerToEngine } from "./aeEngineAttach.js";
import { AeDataRevisionTracker } from "./aeDataRevisionTracker.js";
import { AeRevisionService } from "./aeRevisionService.js";
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
import { DiagnosticsLog, describeError, PlayoutOperationError } from "./diagnostics.js";
import { PlayoutDiscovery } from "./discovery.js";
import {
  createPlayoutAuth,
  PUBLIC_ROUTES,
  recordPlayoutAudit,
  requirePermission,
  requireUser
} from "./auth.js";

/** Published in the mDNS TXT record. Kept by hand: the bundled service ships without a manifest. */
const SERVICE_VERSION = "0.2.0";

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

// Everything the operator console shows. Populated by every route that refuses a command
// and by the engine link, so a failure that flashed past during a take can still be read
// afterwards. In memory only, bounded, and never on the path of a frame.
const diagnostics = new DiagnosticsLog();

// Identity and audit are created before the renderer connection because that connection is a
// long-lived Playout service actor. It receives a newly minted, short-lived credential on every
// connection attempt; it never borrows an operator's browser session and no static bearer is
// stored on disk.
const auth = await createPlayoutAuth();
if (auth.bootstrapPassword) {
  console.warn(
    `[auth] created the first administrator 'admin' with password: ${auth.bootstrapPassword}\n` +
      "       change it at first sign-in; it is shown this once and stored nowhere."
  );
}

// The standalone render engine (protocol v3). Playout owns this connection so Program keeps
// rendering when the Editor closes. The credential provider renews authority on every retry,
// including a reconnect days after the process started.
const engine = new EngineSupervisor({
  diagnostics,
  authTokenFactory: auth.issueEngineAccessToken
});
const aeRuntime = new AeRuntimeSupervisor({
  dataRoot: path.join(dataRoot, "ae-runtime"),
  diagnostics
});
const aeContainers = new AeContainerStore(dataRoot);
const aePackages = new AePackageStore(dataRoot, aeContainers);
const aeControls = new AeControlService(aeRuntime);
const aeCues = new AeCueService(aeRuntime);
const aeRevisions = new AeDataRevisionTracker(dataRoot);
const aeRevisionService = new AeRevisionService(aeControls, aeRevisions, aeRuntime);

// Rundown operations run against the engine and nothing else. Constructed after the
// supervisor because the runtime consults it on every cue and take.
const runtime = new PlayoutRuntime(store, engine);

// The live link to every attached operator UI. Publishes and other library changes are
// pushed, so the UI never shows a stale library waiting for someone to press refresh.
const events = new PlayoutEventBus();

// The console is live for the same reason the library is: an operator watching a take fail
// should not have to press anything to see why. Only the sequence travels — the UI fetches
// the records, so a missed event costs one stale render rather than a lost diagnostic.
diagnostics.onRecord((record) => {
  events.emit({ kind: "diagnostics.logged", detail: { sequence: record.sequence, level: record.level } });
});

// Local-link discovery. Announces this control service and finds Editors, so the two halves can
// still address each other with no DNS, no DHCP and no router — or on one machine with no network
// at all. Started below, after the port is bound, and it never blocks startup.
const discovery = new PlayoutDiscovery({ port, version: SERVICE_VERSION, diagnostics });

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
  },
  // Declared, not defaulted. The default preflight answer here was `GET,HEAD,POST`, so every
  // DELETE route this service serves — removing a published scene, clearing the diagnostics
  // log — was blocked by the browser before it was sent, and surfaced in the operator UI as a
  // bare "Failed to fetch" with no status to point at the cause.
  methods: ["GET", "HEAD", "POST", "DELETE"]
});

// Every non-public route needs a verified user. `requireUser` either attaches it or sends
// the 401 itself; the check runs per request so an expired session is refused the moment it
// is used, not whenever the operator next opens the window.
app.addHook("onRequest", async (request, reply) => {
  const route = request.url.split("?")[0];
  if (PUBLIC_ROUTES.has(route)) return;
  if (!requireUser(auth, request, reply)) return reply;
});

app.addHook("onClose", async () => {
  await aeRuntime.stop();
  await auth.audit.close();
});

// ---------------------------------------------------------------------------
// Authentication
//
// The login that issues the tokens everything else requires. A failed login is audited with
// the attempt and the address, never the password.
// ---------------------------------------------------------------------------

app.post<{ Body: { identifier?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
  const identifier = request.body?.identifier?.trim() ?? "";
  const password = request.body?.password ?? "";
  if (!identifier || !password) {
    return reply.code(400).send({ ok: false, error: "a username or email and a password are required" });
  }
  const outcome = await auth.auth.login(identifier, password);
  if ("failure" in outcome) {
    recordPlayoutAudit(auth, request, {
      action: "auth.login-failed",
      result: "failure",
      username: identifier,
      detail: { reason: outcome.failure }
    });
    return reply.code(401).send({ ok: false, error: "incorrect username or password" });
  }
  recordPlayoutAudit(auth, request, {
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
  recordPlayoutAudit(auth, request, {
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
  const sessionId = request.body?.sessionId ?? request.grapixUser?.sessionId ?? "";
  const ended = sessionId ? auth.auth.logout(sessionId) : false;
  if (ended) recordPlayoutAudit(auth, request, { action: "auth.logout", result: "success" });
  return { ok: true, ended };
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
    return refuse(reply, 400, error, {
      source: "library/publish",
      fallbackCode: "scene.publish-rejected",
      context: { sceneId: request.body?.scene?.id, sceneName: request.body?.scene?.name }
    });
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
        return refuse(reply, error.reason === "NOT_FOUND" ? 404 : 409, error, {
          source: "library/remove",
          fallbackCode: `scene.remove-refused.${error.reason.toLowerCase()}`,
          remedy:
            error.reason === "ON_AIR"
              ? "Take the scene off Program first, then remove it."
              : "Remove the take-list entries that reference it, or repeat the removal with force.",
          context: { sceneId, force, reason: error.reason },
          // `reason` stays a top-level field: the operator UI already branches on it.
          body: { reason: error.reason }
        });
      }
      return refuse(reply, 400, error, {
        source: "library/remove",
        fallbackCode: "scene.remove-failed",
        context: { sceneId, force }
      });
    }
  }
);

/**
 * Sync scenes from the Editor project service into Playout.
 *
 * The address is resolved rather than assumed: configured first, then what worked last, then this
 * machine, then whatever announced itself on the link. That is what lets an operator still fetch
 * from an Editor on the same switch when DNS, DHCP or the gateway is gone — the failure this whole
 * discovery path exists for.
 */
app.post("/api/playout/scenes/sync-editor", async (request, reply) => {
  const endpoint = await discovery.resolveEditor();
  if (!endpoint) {
    return refuse(
      reply,
      502,
      new PlayoutOperationError({
        code: "editor.not-found",
        summary: "No Editor project service answered, at its configured address or anywhere on this link",
        remedy:
          "Start the Editor (`npm run dev`). If it runs on another machine, check that machine is on the same switch — Playout will find it by name announcement even without DNS — or set GRAPIX_EDITOR_API_URL.",
        context: {
          configured: process.env.GRAPIX_EDITOR_API_URL || "http://127.0.0.1:4100",
          discovery: discovery.status()
        }
      }),
      { source: "library/sync-editor" }
    );
  }

  try {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1]?.trim();
    const result = await store.syncFromEditor(endpoint.url, bearer);
    if (result.syncedCount > 0 || result.updatedCount > 0) {
      events.emit({
        kind: "library.changed",
        detail: { reason: "synced-editor", count: result.syncedCount + result.updatedCount }
      });
    }
    return { ...result, route: endpoint.route, isFallback: endpoint.isFallback };
  } catch (error) {
    // The endpoint answered a health check and then failed a real request, so it is no longer
    // trustworthy: the next attempt re-proves instead of returning here out of habit.
    await discovery.forgetEditor();
    return refuse(reply, 502, error, {
      source: "library/sync-editor",
      fallbackCode: "editor.sync-failed",
      remedy:
        "Start the Editor project service (`npm run dev` in the Editor, port 4100) — or set GRAPIX_EDITOR_API_URL if it runs elsewhere — then press Fetch again. Scenes already published to Playout are unaffected.",
      context: { editorUrl: endpoint.url, route: endpoint.route }
    });
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
// Diagnostics — what the operator console reads
// ---------------------------------------------------------------------------

/**
 * The diagnostics tail.
 *
 * `?since=` is the highest sequence the console already holds, so a live console asks for
 * what it does not have rather than re-fetching the buffer on every event. `latestSequence`
 * is returned even when nothing matched, so a client can tell "up to date" from "the service
 * restarted and its log is empty".
 */
app.get<{ Querystring: { since?: string; limit?: string } }>(
  "/api/playout/diagnostics",
  async (request) => {
    const since = Number(request.query.since);
    const limit = Number(request.query.limit);
    return {
      records: diagnostics.list({
        ...(Number.isSafeInteger(since) && since > 0 ? { since } : {}),
        ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {})
      }),
      latestSequence: diagnostics.latestSequence(),
      capacity: DiagnosticsLog.CAPACITY
    };
  }
);

app.delete("/api/playout/diagnostics", async () => ({
  cleared: diagnostics.clear(),
  latestSequence: diagnostics.latestSequence()
}));

// ---------------------------------------------------------------------------
// Local-link discovery
// ---------------------------------------------------------------------------

/**
 * What discovery knows.
 *
 * Exposed because "which Editor is this library coming from?" becomes a real question the moment a
 * fallback address can be in use, and an operator should be able to read the answer rather than
 * infer it. `?refresh=true` re-proves the endpoint instead of answering from the trust window.
 */
app.get<{ Querystring: { refresh?: string } }>("/api/playout/discovery", async (request) => {
  if (request.query.refresh === "true") await discovery.forgetEditor();
  const editor = await discovery.resolveEditor();
  return { ...discovery.status(), editor };
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
      return refuse(reply, 400, error, {
        source: "take-list/save",
        fallbackCode: "take-list.save-rejected",
        context: { takeListId: request.body?.takeListId, entries: request.body?.entries?.length }
      });
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

  // Putting something on Program is `playout.program`, checked per command, not only at
  // login - an operator whose role was narrowed since they signed in must be refused here.
  if (!requirePermission(auth, request, reply, "playout.program")) return reply;

  const auditAction =
    action === "cue" ? "playout.cue" : action === "take" ? "playout.take-online" : "playout.take-offline";

  try {
    if (action === "take-out") {
      const status = await runtime.takeOut();
      events.emit({ kind: "runtime.changed", detail: { action } });
      recordPlayoutAudit(auth, request, { action: "playout.take-offline", result: "success" });
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
    recordPlayoutAudit(auth, request, {
      action: auditAction,
      result: "success",
      detail: {
        target: target.kind === "scene" ? `take:${target.takeId}` : `${target.takeListId}/${target.entryId}`
      }
    });
    return status;
  } catch (error) {
    return refuse(reply, 503, error, {
      source: `control/${action}`,
      fallbackCode: `control.${action}-failed`,
      context: {
        action,
        ...(request.body?.takeId !== undefined ? { takeId: request.body.takeId } : {}),
        ...(request.body?.takeListId ? { takeListId: request.body.takeListId } : {}),
        ...(request.body?.entryId ? { entryId: request.body.entryId } : {}),
        engine: engine.status().url,
        engineState: engine.status().state
      },
      // The UI applies this to its transport state, so a failed take still shows the truth.
      body: { status: runtime.getStatus() }
    });
  }
});

// ---------------------------------------------------------------------------
// Render engine (protocol v3)
// ---------------------------------------------------------------------------

// An AE package is immutable at its publisher; ingest records the verified version Playout
// accepted, then the operator can load that exact project without resolving a shared root again.
app.post<{ Body: { versionRoot?: string } }>(
  "/api/playout/ae-packages/ingest",
  async (request, reply) => {
    if (!requirePermission(auth, request, reply, "playout.program")) return reply;
    const versionRoot = request.body?.versionRoot;
    if (typeof versionRoot !== "string" || !versionRoot.trim()) {
      return refuse(
        reply,
        422,
        new PlayoutOperationError({
          code: "ae-package.version-root-invalid",
          summary: "An AE package ingest needs an absolute versionRoot",
          remedy: "Publish the graphic from Editor again and send the version directory it returns."
        }),
        { source: "ae-package/ingest" }
      );
    }

    try {
      const ingested = await aePackages.ingest(versionRoot);
      events.emit({
        kind: "library.changed",
        detail: {
          graphicId: ingested.manifest.id,
          version: ingested.manifest.version,
          reason: "ae-package-ingested"
        }
      });
      recordPlayoutAudit(auth, request, {
        action: "ae-package.ingest",
        result: "success",
        detail: {
          graphicId: ingested.manifest.id,
          version: ingested.manifest.version,
          containerId: ingested.container.id
        }
      });
      return {
        ok: true,
        graphicId: ingested.manifest.id,
        version: ingested.manifest.version,
        containerId: ingested.container.id
      };
    } catch (error) {
      return refuse(reply, error instanceof AePackageReadError ? 422 : 503, error, {
        source: "ae-package/ingest",
        fallbackCode: error instanceof AePackageReadError
          ? `ae-package.${error.code.toLowerCase()}`
          : "ae-package.ingest-failed",
        context: { versionRoot }
      });
    }
  }
);

app.get("/api/playout/ae-packages", async () => ({
  ok: true,
  packages: await aePackages.list()
}));

app.get<{ Params: { graphicId: string } }>(
  "/api/playout/ae-packages/:graphicId",
  async (request, reply) => {
    const graphic = await aePackages.read(request.params.graphicId);
    if (!graphic) {
      return reply.code(404).send({
        ok: false,
        code: "AE_PACKAGE_NOT_FOUND",
        error: "Published AE package not found"
      });
    }
    return { ok: true, package: graphic };
  }
);

app.post<{ Params: { graphicId: string } }>(
  "/api/playout/ae-packages/:graphicId/load",
  async (request, reply) => {
    if (!requirePermission(auth, request, reply, "playout.program")) return reply;
    const graphic = await aePackages.read(request.params.graphicId);
    if (!graphic) {
      return reply.code(404).send({
        ok: false,
        code: "AE_PACKAGE_NOT_FOUND",
        error: "Published AE package not found"
      });
    }

    const container = await aeContainers.read(graphic.graphicId);
    if (!container) {
      return reply.code(404).send({
        ok: false,
        code: "CONTAINER_NOT_FOUND",
        error: "AE runtime container not found"
      });
    }

    try {
      const verified = await readAePackage(graphic.versionRoot);
      const composition = verified.manifest.compositions.find(
        (candidate) => candidate.itemId === verified.manifest.mainComposition.itemId
      );
      if (!composition) {
        throw new PlayoutOperationError({
          code: "ae-package.main-composition-missing",
          summary: "The published AE package does not contain its declared main composition",
          remedy: "Republish the graphic from Editor after selecting a main composition.",
          context: { graphicId: graphic.graphicId, version: graphic.latestVersion }
        });
      }

      // The same per-launch credentials start AE and authorize the engine's shared-memory link.
      const sessionId = randomUUID();
      const token = randomBytes(32).toString("hex");
      const state = await aeRuntime.start({
        projectPath: verified.projectPath,
        projectDigest: verified.manifest.projectDigest,
        sessionId,
        token
      });
      await attachAeContainerToEngine(engine.engineController, engine.id, {
        sessionId,
        token,
        compositionItemId: verified.manifest.mainComposition.itemId,
        clock: composition.clock,
        format: {
          width: verified.manifest.mainComposition.width,
          height: verified.manifest.mainComposition.height
        }
      });
      await aeContainers.write({
        ...container,
        status: "ready",
        updatedAt: new Date().toISOString()
      });
      recordPlayoutAudit(auth, request, {
        action: "ae-package.load",
        result: "success",
        detail: {
          graphicId: graphic.graphicId,
          version: graphic.latestVersion,
          containerId: container.id,
          compositionItemId: composition.itemId
        }
      });
      return { ok: true, state };
    } catch (error) {
      return refuse(reply, error instanceof AePackageReadError ? 422 : 503, error, {
        source: "ae-package/load",
        fallbackCode: error instanceof AePackageReadError
          ? `ae-package.${error.code.toLowerCase()}`
          : "ae-package.load-failed",
        context: {
          graphicId: graphic.graphicId,
          version: graphic.latestVersion,
          containerId: container.id
        }
      });
    }
  }
);

app.get("/api/playout/ae-runtime/containers", async () => ({
  ok: true,
  containers: await aeContainers.list()
}));

/**
 * Drive a published graphic to one of its declared cue points.
 *
 * This is the operator's animation control: CUE parks on the pre-roll, IN plays the entrance, OUT
 * the exit, CONTINUE:<id> interrupts a hold. Every seek is digest-pinned — the cue map recorded at
 * ingest must still resolve to the same digest, or the project moved and the old timings are
 * refused rather than played.
 */
app.post<{
  Params: { graphicId: string };
  Body: { role?: "CUE" | "IN" | "HOLD" | "CONTINUE" | "UPDATE" | "OUT" | "END"; id?: string | null };
}>("/api/playout/ae-packages/:graphicId/cue", async (request, reply) => {
  if (!requirePermission(auth, request, reply, "playout.program")) return reply;
  const graphic = await aePackages.read(request.params.graphicId);
  if (!graphic) {
    return reply.code(404).send({ ok: false, code: "AE_PACKAGE_NOT_FOUND", error: "Published AE package not found" });
  }
  const container = await aeContainers.read(graphic.graphicId);
  if (!container) {
    return reply.code(404).send({ ok: false, code: "CONTAINER_NOT_FOUND", error: "AE runtime container not found" });
  }
  const recorded = await aePackages.readCueMap(graphic.graphicId);
  if (!recorded) {
    return reply.code(422).send({
      ok: false,
      code: "CUE_MAP_NOT_DECLARED",
      error: "This graphic declared no GRAPIX: cue markers, so there is no cue to drive to"
    });
  }
  const role = request.body?.role;
  if (!role) return reply.code(400).send({ ok: false, error: "role is required" });

  try {
    const result = await aeCues.setTime(container, recorded, {
      cueMapDigest: recorded.cueMapDigest,
      role,
      ...(request.body?.id !== undefined ? { id: request.body.id } : {})
    });
    recordPlayoutAudit(auth, request, {
      action: "ae-runtime.control-write",
      result: "success",
      detail: { graphicId: graphic.graphicId, containerId: container.id, role, id: request.body?.id ?? null }
    });
    return { ok: true, result };
  } catch (error) {
    recordPlayoutAudit(auth, request, {
      action: "ae-runtime.control-refused",
      result: "denied",
      detail: {
        graphicId: graphic.graphicId,
        containerId: container.id,
        role,
        code: error instanceof AeCueServiceRefusal ? error.code : "CUE_FAILED"
      }
    });
    return reply.code(error instanceof AeCueServiceRefusal ? 422 : 503).send({
      ok: false,
      code: error instanceof AeCueServiceRefusal ? error.code : "CUE_FAILED",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post<{
  Params: { containerId: string };
  Body: { controlId?: string; value?: unknown; policy?: AeDynamicControl["updatePolicy"]; revision?: number };
}>("/api/playout/ae-runtime/containers/:containerId/controls", async (request, reply) => {
  if (!requirePermission(auth, request, reply, "playout.program")) return reply;
  const container = await aeContainers.read(request.params.containerId);
  if (!container) return reply.code(404).send({ ok: false, code: "CONTAINER_NOT_FOUND", error: "Runtime container not found" });
  const controlId = request.body?.controlId ?? "";
  try {
    const result = await aeControls.write(container, {
      controlId,
      value: request.body?.value,
      policy: request.body?.policy ?? "immediate",
      ...(request.body?.revision !== undefined ? { revision: request.body.revision } : {})
    });
    await aeContainers.write({ ...container, updatedAt: new Date().toISOString() });
    recordPlayoutAudit(auth, request, {
      action: "ae-runtime.control-write",
      result: "success",
      detail: { containerId: container.id, controlId, revision: request.body?.revision ?? null }
    });
    return { ok: true, result, container };
  } catch (error) {
    const code = error instanceof AeControlRefusal ? error.code : "CONTROL_VALIDATION_FAILED";
    recordPlayoutAudit(auth, request, {
      action: "ae-runtime.control-refused",
      result: "denied",
      detail: { containerId: container.id, controlId, code }
    });
    return reply.code(error instanceof AeControlRefusal ? 422 : 503).send({
      ok: false,
      code,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get<{ Params: { containerId: string } }>(
  "/api/playout/ae-runtime/containers/:containerId/revision",
  async (request, reply) => {
    if (!requirePermission(auth, request, reply, "playout.program")) return reply;
    const container = await aeContainers.read(request.params.containerId);
    if (!container) return reply.code(404).send({ ok: false, code: "CONTAINER_NOT_FOUND", error: "Runtime container not found" });
    return { ok: true, state: await aeRevisions.read(container.id) };
  }
);

app.post<{
  Params: { containerId: string };
  Body: Partial<AeDataRevisionRequest>;
}>("/api/playout/ae-runtime/containers/:containerId/revision", async (request, reply) => {
  if (!requirePermission(auth, request, reply, "playout.program")) return reply;
  const container = await aeContainers.read(request.params.containerId);
  if (!container) return reply.code(404).send({ ok: false, code: "CONTAINER_NOT_FOUND", error: "Runtime container not found" });

  const body = request.body ?? {};
  if (
    typeof body.baseRevision !== "number" ||
    typeof body.revision !== "number" ||
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.length < 8 ||
    body.dataContext === null ||
    typeof body.dataContext !== "object" ||
    Array.isArray(body.dataContext)
  ) {
    return reply.code(422).send({
      ok: false,
      code: "REVISION_MEMBER_INVALID",
      error: "a revision needs baseRevision, revision, an idempotency key and a complete data context"
    });
  }

  const revisionRequest: AeDataRevisionRequest = {
    baseRevision: body.baseRevision,
    revision: body.revision,
    idempotencyKey: body.idempotencyKey,
    dataContext: body.dataContext as Record<string, unknown>
  };

  try {
    const { application, reservation } = await aeRevisionService.apply(container, revisionRequest, {
      reserve: (count) => auth.audit.reserve("ae-runtime.revision-applied", count)
    });

    if (application.duplicate) {
      // A recognised retry is acknowledged, not re-applied, and says so rather than reporting a write.
      return { ok: true, duplicate: true, state: application.state, result: null };
    }

    try {
      for (const member of application.members) {
        recordPlayoutAudit(auth, request, {
          action: "ae-runtime.revision-applied",
          result: "success",
          revision: application.state.acceptedRevision,
          detail: {
            containerId: container.id,
            controlId: member.control.controlId,
            dataPath: member.dataPath,
            updatePolicy: member.control.updatePolicy
          }
        }, reservation);
      }
      recordPlayoutAudit(auth, request, {
        action: "ae-runtime.revision-applied",
        result: "success",
        revision: application.state.acceptedRevision,
        detail: { containerId: container.id, members: application.members.length, idempotencyKey: revisionRequest.idempotencyKey }
      }, reservation);
    } finally {
      reservation?.release();
    }

    await aeContainers.write({ ...container, updatedAt: new Date().toISOString() });
    events.emit({ kind: "runtime.changed", detail: { action: "ae-runtime.revision" } });
    return { ok: true, duplicate: false, state: application.state, result: application.result };
  } catch (error) {
    const refusal = error instanceof AeDataRevisionRefusal ? error : null;
    recordPlayoutAudit(auth, request, {
      action: "ae-runtime.revision-refused",
      result: "denied",
      revision: revisionRequest.revision,
      detail: {
        containerId: container.id,
        code: refusal?.code ?? "REVISION_MEMBER_INVALID",
        controlId: refusal?.controlId ?? null
      }
    });
    return reply.code(refusal ? 409 : 503).send({
      ok: false,
      code: refusal?.code ?? "REVISION_MEMBER_INVALID",
      error: error instanceof Error ? error.message : String(error),
      ...(refusal?.controlId ? { controlId: refusal.controlId } : {})
    });
  }
});

app.get("/api/playout/ae-runtime", async () => aeRuntime.status());

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
    return refuse(reply, 503, error, { source: "engine/status", fallbackCode: "engine.status-failed" });
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
      return refuse(reply, 503, error, {
        source: "engine/diagnostics",
        fallbackCode: "engine.diagnostics-failed",
        context: { includeTiles: request.query.tiles === "true" }
      });
    }
  }
);

app.post("/api/playout/engine/connect", async (_request, reply) => {
  const connected = await engine.connect();
  if (!connected) {
    const status = engine.status();
    return refuse(
      reply,
      503,
      new PlayoutOperationError({
        code: "engine.connect-failed",
        summary: `Cannot reach the render engine at ${status.url}`,
        ...(status.lastError ? { cause: status.lastError } : {}),
        remedy: "Start the engine with `npm run dev:engine`, then press Connect again.",
        context: { url: status.url, reconnectAttempts: status.reconnectAttempts }
      }),
      { source: "engine/connect" }
    );
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
      return refuse(reply, 503, error, {
        source: "engine/load-scene",
        fallbackCode: "engine.load-failed",
        context: { sceneId: request.body.sceneId, version: request.body.version ?? "latest" }
      });
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
    return refuse(reply, 503, error, { source: "engine/outputs", fallbackCode: "engine.outputs-failed" });
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
    const refusedByEngine = message.includes("not enabled") || message.includes("exceeds");
    return refuse(reply, refusedByEngine ? 409 : 503, error, {
      source: "engine/configure-output",
      fallbackCode: refusedByEngine ? "output.refused" : "output.configure-failed",
      ...(refusedByEngine
        ? {
            remedy:
              "The engine will not carry this output as asked. Enable the adapter in the engine's configuration, or lower the format to within the limit named above."
          }
        : {}),
      context: {
        outputId: body.outputId,
        adapterId: body.adapterId,
        format: `${body.width}x${body.height}`,
        startRequested: body.start === true
      }
    });
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
    const liveRefusal = message.includes("live and running");
    return refuse(reply, liveRefusal ? 409 : 503, error, {
      source: `engine/output-${action}`,
      fallbackCode: liveRefusal ? "output.remove-refused" : `output.${action}-failed`,
      ...(liveRefusal ? { remedy: "Stop the output first, then remove it." } : {}),
      context: { outputId, action }
    });
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
    return refuse(reply, 503, error, {
      source: `engine/command-${action}`,
      fallbackCode: `engine.${action}-failed`,
      context: { action }
    });
  }
});

app.setErrorHandler((error, request, reply) => {
  app.log.error(error);
  // An error that reaches here was not anticipated by a route, which makes it the one most
  // worth keeping: the console gets the stack, and the reply still carries the summary.
  const detail = describeError(error, "internal");
  const record = diagnostics.record({
    level: "error",
    source: `http${request.url ? ` ${request.method} ${request.url}` : ""}`,
    detail
  });
  reply.code(500).send({ error: detail.summary, detail, diagnosticSequence: record.sequence });
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

// After the port is bound, so the announcement carries an address that is actually accepting
// connections. Never awaited for success: discovery being unavailable is a degraded fallback, not
// a failed service, and it says so in the console either way.
await discovery.start();

const shutdown = async () => {
  // Event streams first: an open SSE socket keeps node alive, so closing Fastify while one
  // is attached hangs the shutdown instead of ending it. An MJPEG monitor is the same
  // shape of problem, and it also owes the engine a streamStop.
  events.close();
  await monitors.close();
  await discovery.stop();
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
 * Refuse a request, and make sure the operator can still find out why.
 *
 * Two failures used to be possible at every one of these catch sites: the UI received one
 * string with no context, and once the operator dismissed the banner the reason was gone. So
 * every refusal does both halves — it answers with structured `detail`, and it appends a
 * record to the console log.
 *
 * `remedy` and `context` here are the route's contribution. A detail that already carries
 * them (a `PlayoutOperationError` thrown deeper, which knows more) keeps its own.
 */
function refuse(
  reply: FastifyReply,
  status: number,
  error: unknown,
  where: {
    source: string;
    fallbackCode?: string;
    remedy?: string;
    context?: Record<string, unknown>;
    /** Extra fields the existing response shape promises, e.g. `status` on a control refusal. */
    body?: Record<string, unknown>;
  }
): FastifyReply {
  const described = describeError(error, where.fallbackCode ?? "internal");
  const detail = {
    ...described,
    ...(described.remedy === undefined && where.remedy !== undefined ? { remedy: where.remedy } : {}),
    ...(where.context ? { context: { ...where.context, ...described.context } } : {})
  };
  // The sequence travels with the refusal so the operator UI can open its console straight
  // on this record instead of keeping a second copy of the same failure.
  const record = diagnostics.record({ level: "error", source: where.source, detail });
  return reply
    .code(status)
    .send({ error: detail.summary, detail, diagnosticSequence: record.sequence, ...where.body });
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
