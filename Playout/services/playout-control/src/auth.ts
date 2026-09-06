/**
 * Identity and audit for the Playout control service.
 *
 * The same shared account system the Editor and the engine use - which is the entire design.
 * An operator is one person whether they are signing into Playout or Editor, and the engine
 * trusts a token minted at either door because there is one store and one signing key.
 *
 * Playout's routes map to permissions more sharply than the Editor's: taking a scene online
 * is `playout.program`, managing outputs is `output.manage`, and both are enforced per
 * request, not only at login, because an operator's session can outlive a role change.
 */
import {
  AuditLog,
  AuthService,
  UserStore,
  issueAccessToken,
  newSessionId,
  roleHasPermission,
  signingKeyFromSecret,
  type AuditEntry,
  type AuditReservation,
  type Permission,
  type UserRole
} from "@grapix/auth-contract";
import type { FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serviceDirectory, "../../../..");

/** Playout's durable state lives beside its scene library, in the shared data root. */
export function playoutDataRoot(): string {
  return process.env.GRAPIX_PLAYOUT_DATA_DIR?.trim()
    ? path.resolve(process.env.GRAPIX_PLAYOUT_DATA_DIR)
    : path.join(repositoryRoot, "data", "playout");
}

/**
 * The account store is shared with the Editor, so it lives at the repository data root rather
 * than inside Playout's own directory - an operator created in one product must sign into the
 * other without a second account.
 */
export function accountDataRoot(): string {
  if (process.env.GRAPIX_ACCOUNT_DATA_ROOT?.trim()) {
    return path.resolve(process.env.GRAPIX_ACCOUNT_DATA_ROOT);
  }
  return process.env.GRAPIX_DATA_ROOT?.trim()
    ? path.resolve(process.env.GRAPIX_DATA_ROOT)
    : path.join(repositoryRoot, "data");
}

export interface PlayoutAuthContext {
  store: UserStore;
  auth: AuthService;
  audit: AuditLog;
  bootstrapPassword: string | null;
  /** Mint a fresh service credential for each render-engine connection attempt. */
  issueEngineAccessToken: () => string;
}

function signingSecret(): Buffer {
  const secret =
    process.env.GRAPIX_AUTH_SECRET?.trim() ??
    (process.env.GRAPIX_AUTH_SECRET_FILE
      ? readFileSync(path.resolve(process.env.GRAPIX_AUTH_SECRET_FILE), "utf8").trim()
      : undefined);
  if (!secret) {
    throw new Error(
      "no token signing secret is configured. Set GRAPIX_AUTH_SECRET, or GRAPIX_AUTH_SECRET_FILE - the same secret the engine verifies against"
    );
  }
  return signingKeyFromSecret(secret);
}

export async function createPlayoutAuth(): Promise<PlayoutAuthContext> {
  const store = new UserStore(UserStore.defaultPath(accountDataRoot()));
  await store.load();

  const audit = new AuditLog({
    directory: path.join(playoutDataRoot(), "logs"),
    onWarning: (message, error) => {
      console.warn(`[audit] ${message}`, error instanceof Error ? error.message : error);
    }
  });
  await audit.open();

  const signingKey = signingSecret();
  const auth = new AuthService(store, signingKey);

  let bootstrapPassword: string | null = null;
  const bootstrap = await store.ensureBootstrapAdmin();
  if (bootstrap) bootstrapPassword = bootstrap.password;

  const serviceSessionId = `svc_playout_${process.pid}_${newSessionId()}`;
  const issueEngineAccessToken = (): string => issueAccessToken(
    {
      userId: "svc_playout",
      username: "grapix-playout-service",
      role: "admin",
      sessionId: serviceSessionId,
      // Enough authority to deliver published scenes and operate outputs, but not to manage
      // human accounts or read their audit log.
      permissions: [
        "scene.read",
        "scene.write",
        "stage.write",
        "asset.write",
        "playout.preview",
        "playout.program",
        "output.manage",
        "engine.diagnose"
      ],
      ttlSeconds: 300
    },
    signingKey
  ).token;

  return { store, auth, audit, bootstrapPassword, issueEngineAccessToken };
}

// ---------------------------------------------------------------------------
// Request identity
// ---------------------------------------------------------------------------

export interface RequestUser {
  id: string;
  username: string;
  role: string;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    grapixUser?: RequestUser;
  }
}

const PUBLIC_ROUTES = new Set(["/api/playout/health", "/api/auth/login", "/api/auth/refresh"]);

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

export function requireUser(context: PlayoutAuthContext, request: FastifyRequest, reply: FastifyReply): boolean {
  const token = readBearer(request);
  if (!token) {
    void reply.code(401).send({ ok: false, error: "authentication required", code: "UNAUTHENTICATED" });
    return false;
  }
  const verified = context.auth.verifyAccess(token);
  if ("failure" in verified) {
    void reply.code(401).send({ ok: false, error: "session is not valid; sign in again", code: "SESSION_EXPIRED" });
    return false;
  }
  request.grapixUser = {
    id: verified.claims.sub,
    username: verified.claims.usr,
    role: verified.claims.role,
    sessionId: verified.claims.sid
  };
  return true;
}

export function requirePermission(
  context: PlayoutAuthContext,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission
): boolean {
  if (!request.grapixUser) return requireUser(context, request, reply);
  if (!roleHasPermission(request.grapixUser.role as UserRole, permission)) {
    recordPlayoutAudit(context, request, {
      action: "auth.permission-denied",
      result: "denied",
      detail: { permission, route: request.url }
    });
    void reply.code(403).send({ ok: false, error: `the ${permission} permission is required`, code: "FORBIDDEN" });
    return false;
  }
  return true;
}

export function recordPlayoutAudit(
  context: PlayoutAuthContext,
  request: FastifyRequest,
  entry: Omit<AuditEntry, "ipAddress" | "deviceName" | "userId" | "username" | "role" | "sessionId"> & Partial<Pick<AuditEntry, "userId" | "username" | "role" | "sessionId">>,
  /** Capacity claimed before the action ran, for records that may not be dropped. */
  reservation?: AuditReservation | null
): void {
  const user = request.grapixUser;
  context.audit.record({
    ipAddress: request.ip ?? null,
    deviceName: (request.headers["x-grapix-device"] as string | undefined) ?? null,
    userId: entry.userId ?? user?.id ?? null,
    username: entry.username ?? user?.username ?? null,
    role: entry.role ?? user?.role ?? null,
    sessionId: entry.sessionId ?? user?.sessionId ?? null,
    action: entry.action,
    result: entry.result,
    connectionId: entry.connectionId ?? null,
    sceneId: entry.sceneId ?? null,
    revision: entry.revision ?? null,
    error: entry.error ?? null,
    detail: entry.detail
  }, reservation);
}

export { PUBLIC_ROUTES };
