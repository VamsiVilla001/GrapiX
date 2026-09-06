/**
 * Identity and audit for the Editor service.
 *
 * Wires the shared account system into Fastify: the login routes, the hook that turns a bearer
 * token into a per-request user, and the audit sink every route and the console both feed.
 *
 * The account store and the signing key are shared with the render engine and with Playout,
 * because an operator is one person whichever product they are sitting at - and because the
 * whole point of the tokens is that the engine trusts a login no matter which door it came in
 * through. Two separate account systems would be two answers to "who is allowed to take this
 * scene to air", and the one that is wrong is never the one you find first.
 */
import {
  AuditLog,
  AuthService,
  UserStore,
  roleHasPermission,
  signingKeyFromSecret,
  type AuditEntry,
  type Permission,
  type UserRole
} from "@grapix/auth-contract";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

/** Where the service keeps its durable state. Shared with the scene storage. */
export function serviceDataRoot(): string {
  return process.env.GRAPIX_DATA_ROOT?.trim()
    ? path.resolve(process.env.GRAPIX_DATA_ROOT)
    : path.join(workspaceRoot, "data");
}

/**
 * Accounts are product-wide, while scenes/assets remain Editor-owned.
 *
 * Desktop Editor and Desktop Playout have different Tauri AppData directories. Pointing the
 * user store at `GRAPIX_DATA_ROOT` therefore created two unrelated `admin` accounts even though
 * both services claimed to share identity. The shells now provide this dedicated common root.
 */
export function accountDataRoot(): string {
  return process.env.GRAPIX_ACCOUNT_DATA_ROOT?.trim()
    ? path.resolve(process.env.GRAPIX_ACCOUNT_DATA_ROOT)
    : serviceDataRoot();
}

export interface AuthContext {
  store: UserStore;
  auth: AuthService;
  audit: AuditLog;
  /** The bootstrapped admin password, shown once at first run and never again. */
  bootstrapPassword: string | null;
}

/** Read the signing secret from config, refusing a short one. */
function signingSecret(): Buffer {
  const secret =
    process.env.GRAPIX_AUTH_SECRET?.trim() ??
    (process.env.GRAPIX_AUTH_SECRET_FILE ? readSecretFile(process.env.GRAPIX_AUTH_SECRET_FILE) : undefined);
  if (!secret) {
    throw new Error(
      "no token signing secret is configured. Set GRAPIX_AUTH_SECRET, or GRAPIX_AUTH_SECRET_FILE - the same secret the engine verifies against"
    );
  }
  return signingKeyFromSecret(secret);
}

import { readFileSync } from "node:fs";
function readSecretFile(file: string): string {
  return readFileSync(path.resolve(file), "utf8").trim();
}

export async function createAuthContext(options: { signingSecret?: string } = {}): Promise<AuthContext> {
  const dataRoot = serviceDataRoot();
  const store = new UserStore(UserStore.defaultPath(accountDataRoot()));
  await store.load();

  const audit = new AuditLog({
    directory: path.join(dataRoot, "logs"),
    onWarning: (message, error) => {
      // The audit log failing must never take the service down, but it must never be silent
      // either - a support call about a gap in the log starts here.
      console.warn(`[audit] ${message}`, error instanceof Error ? error.message : error);
    }
  });
  await audit.open();

  // The secret is injectable so tests can stand a server up without a configured environment;
  // production reads it from config and fails fast when it is absent.
  const key = options.signingSecret ? signingKeyFromSecret(options.signingSecret) : signingSecret();
  const auth = new AuthService(store, key);

  // First run: create the administrator and surface its password exactly once. The password
  // is returned to the caller for the startup banner; it is never written to the log, to a
  // file, or to any field - only its hash is stored.
  let bootstrapPassword: string | null = null;
  const bootstrap = await store.ensureBootstrapAdmin();
  if (bootstrap) {
    bootstrapPassword = bootstrap.password;
  }

  return { store, auth, audit, bootstrapPassword };
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
    /** The verified user behind this request, when a route required one. */
    grapixUser?: RequestUser;
  }
}

/** Routes anyone may hit without a token: health, and the login that issues one. */
const PUBLIC_ROUTES = new Set(["/health", "/api/auth/login", "/api/auth/refresh"]);

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Attach the verified user to the request, or refuse it.
 *
 * Called from the global hook for every route that is not public, so a route can trust
 * `request.grapixUser` rather than re-verifying - and so a permission check that forgot to
 * run cannot accidentally allow anything: there is no user to check without this.
 */
export function requireUser(context: AuthContext, request: FastifyRequest, reply: FastifyReply): boolean {
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

/** The permission a route needs, enforced per request, not only at login. */
export function requirePermission(
  context: AuthContext,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission
): boolean {
  if (!request.grapixUser) return requireUser(context, request, reply);
  if (!roleHasPermission(request.grapixUser.role as UserRole, permission)) {
    recordAudit(context, request, {
      action: "auth.permission-denied",
      result: "denied",
      detail: { permission, route: request.url }
    });
    void reply.code(403).send({ ok: false, error: `the ${permission} permission is required`, code: "FORBIDDEN" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Record an audit entry with the request's identity filled in.
 *
 * `record()` is fire-and-forget by design - see `auditLog.ts` - so a route appends and
 * continues; the take that triggered it is never waiting on the disk.
 */
export function recordAudit(context: AuthContext, request: FastifyRequest, entry: Omit<AuditEntry, "ipAddress" | "userId" | "username" | "role" | "sessionId" | "deviceName"> & Partial<Pick<AuditEntry, "userId" | "username" | "role" | "sessionId">>): void {
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
  });
}

export { PUBLIC_ROUTES };
