/**
 * The authority vocabulary, shared by both products and the engine.
 *
 * This file is types and constant tables only - no `node:crypto`, no signing, nothing that
 * must not reach a browser. The web apps import from here to render what a user may do; the
 * services import the signer next door. Keeping the split at the file boundary is what lets a
 * UI know a permission name without being able to mint a token carrying it.
 *
 * The Rust engine reimplements the same tables in `services/render-engine/src/auth.rs`. They
 * are checked against each other by a conformance fixture, exactly as the easing tables are:
 * two implementations of one specification, never two specifications.
 */

/** Who someone is, in the only three shapes this system recognises. */
export type UserRole = "admin" | "editor" | "playout-operator";

export const USER_ROLES: readonly UserRole[] = ["admin", "editor", "playout-operator"] as const;

/**
 * What someone may do.
 *
 * Deliberately coarser than the engine's `RequestType` list: a permission is a job an operator
 * or author recognises, and one permission may cover several wire verbs. The mapping from verb
 * to permission is `PERMISSION_FOR_REQUEST` below, and it is exhaustive - a verb with no entry
 * is refused rather than allowed, so adding a request type to the protocol cannot silently
 * widen anyone's authority.
 */
export type Permission =
  // Authoring
  | "scene.read"
  | "scene.write"
  | "scene.publish"
  | "stage.write"
  | "asset.write"
  | "editor.view"
  // Operations
  | "playout.preview"
  | "playout.program"
  | "output.manage"
  // Administration
  | "engine.configure"
  | "engine.diagnose"
  | "user.manage"
  | "audit.read";

export const PERMISSIONS: readonly Permission[] = [
  "scene.read",
  "scene.write",
  "scene.publish",
  "stage.write",
  "asset.write",
  "editor.view",
  "playout.preview",
  "playout.program",
  "output.manage",
  "engine.configure",
  "engine.diagnose",
  "user.manage",
  "audit.read"
] as const;

/**
 * The permissions each role carries.
 *
 * An Editor may author and look at its own render, and may publish - but may not put anything
 * on Program. A Playout Operator may deliver and air a published scene, and may not author
 * one. Admin is the union plus the administrative permissions; it is a superset by
 * construction below rather than by a hand-copied list that could drift.
 */
const EDITOR_PERMISSIONS: readonly Permission[] = [
  "scene.read",
  "scene.write",
  "scene.publish",
  "stage.write",
  "asset.write",
  "editor.view",
  "engine.diagnose"
] as const;

const OPERATOR_PERMISSIONS: readonly Permission[] = [
  "scene.read",
  // Delivery, not authoring: an operator loads a published document and prepares it, but
  // never edits one in place. This mirrors the engine capability split exactly.
  "asset.write",
  "playout.preview",
  "playout.program",
  "output.manage",
  "engine.diagnose"
] as const;

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  admin: PERMISSIONS,
  editor: EDITOR_PERMISSIONS,
  "playout-operator": OPERATOR_PERMISSIONS
};

/**
 * Wire verb to the permission it requires.
 *
 * Exhaustive over the engine's `RequestType`. Connection housekeeping (`connection.*`) is
 * absent on purpose: those are answered before authority exists, and are gated by the
 * handshake rather than by a permission.
 */
export const PERMISSION_FOR_REQUEST: Readonly<Record<string, Permission>> = {
  "stage.load": "stage.write",
  "stage.unload": "stage.write",
  "scene.load": "scene.read",
  "scene.unload": "scene.read",
  "scene.fullSync": "scene.write",
  "scene.applyPatch": "scene.write",
  "scene.validate": "scene.read",
  "scene.prepare": "scene.read",
  "asset.register": "asset.write",
  "asset.upload": "asset.write",
  "asset.validate": "asset.write",
  "asset.preload": "asset.write",
  "asset.release": "asset.write",
  "playout.cue": "playout.preview",
  "playout.takeOnline": "playout.program",
  "playout.takeOffline": "playout.program",
  "playout.continue": "playout.program",
  "playout.update": "playout.program",
  "playout.stop": "playout.program",
  "playout.clear": "playout.program",
  "playout.replace": "playout.program",
  "playout.transition": "playout.program",
  "preview.request": "playout.preview",
  "preview.streamStart": "playout.preview",
  "preview.streamStop": "playout.preview",
  "preview.setViewport": "playout.preview",
  "editor.view.request": "editor.view",
  "engine.getStatus": "engine.diagnose",
  "engine.getDiagnostics": "engine.diagnose",
  "engine.getCapabilities": "engine.diagnose",
  "engine.setConfiguration": "engine.configure",
  "engine.restartRenderer": "engine.configure",
  "output.list": "engine.diagnose",
  "output.configure": "output.manage",
  "output.start": "output.manage",
  "output.stop": "output.manage",
  "output.remove": "output.manage"
};

/** Verbs answered before a principal exists, and therefore never permission-checked. */
export const UNAUTHENTICATED_REQUESTS: readonly string[] = [
  "connection.hello",
  "connection.authenticate",
  "connection.heartbeat",
  "connection.capabilities",
  "connection.disconnect"
] as const;

/** Does this role carry this permission? */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * The permission a wire verb needs, or `undefined` when the verb needs none.
 *
 * `undefined` means "connection housekeeping"; an *unknown* verb returns `null`, which callers
 * must refuse. The three-way answer is deliberate: silently treating an unrecognised verb as
 * unprivileged is how a new protocol message becomes an authority hole.
 */
export function permissionForRequest(requestType: string): Permission | undefined | null {
  if (UNAUTHENTICATED_REQUESTS.includes(requestType)) return undefined;
  return PERMISSION_FOR_REQUEST[requestType] ?? null;
}

/** Claims carried by an access token. Kept small: it travels on every connection. */
export interface AccessTokenClaims {
  /** Stable user id. */
  sub: string;
  /** Display name, for audit records and the UI. Never authority. */
  usr: string;
  role: UserRole;
  perms: Permission[];
  /** Session id: ties an access token, its refresh token and every audit row together. */
  sid: string;
  typ: "access";
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
}

/**
 * Claims carried by a refresh token.
 *
 * Deliberately carries no permissions: a refresh token is an identity claim, not an authority
 * one. Permissions are read from the user store when the access token is minted, so a role
 * change takes effect on the next refresh rather than whenever the token happens to expire.
 */
export interface RefreshTokenClaims {
  sub: string;
  sid: string;
  typ: "refresh";
  iat: number;
  exp: number;
  /**
   * The refresh-generation id. The session re-mints this on every refresh, and a token whose
   * `jti` no longer matches is rejected - which is what makes refresh-token rotation actually
   * revoke the token it replaced rather than just issue a new one beside it.
   */
  jti: string;
}

export type TokenClaims = AccessTokenClaims | RefreshTokenClaims;

/** Default lifetimes. Short access, long refresh: the standard trade, stated once. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 12 * 60 * 60;
