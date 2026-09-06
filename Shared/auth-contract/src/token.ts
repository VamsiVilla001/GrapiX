/**
 * Token minting and verification.
 *
 * ## Why not JWT
 *
 * A JWT carries its own algorithm in a header the verifier is invited to read, and the two
 * classic ways to forge one - `"alg":"none"` and RS/HS confusion - both come from honouring
 * that field. This is a closed system: the same operator deploys the issuer and every verifier,
 * so there is nothing to negotiate. The format therefore has no algorithm field at all:
 *
 *     gx1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "gx1." + payload))>
 *
 * The `gx1` prefix *is* the algorithm, fixed at parse time. Alg confusion is not defended
 * against here; it is structurally absent, which is a stronger claim and a shorter one to
 * audit. A future `gx2` would be a distinct prefix and a distinct verifier.
 *
 * The Rust engine verifies the identical bytes in `services/render-engine/src/auth.rs`, and a
 * checked-in conformance fixture proves the two agree.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { AccessTokenClaims, Permission, RefreshTokenClaims, TokenClaims, UserRole } from "./types.js";
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, ROLE_PERMISSIONS } from "./types.js";

export const TOKEN_PREFIX = "gx1";

/** Why a token was refused. The caller decides what to tell the user; audit gets the reason. */
export type TokenFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-type"
  | "unsupported-version";

export type TokenVerification<T extends TokenClaims> =
  | { ok: true; claims: T }
  | { ok: false; reason: TokenFailure };

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(signingInput: string, key: Buffer): string {
  return createHmac("sha256", key).update(signingInput).digest("base64url");
}

/**
 * Compare two signatures without leaking where they diverge.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a signal, so the length
 * check is folded into the boolean result rather than left to throw.
 */
function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Mint a token from complete claims. Callers normally use the two helpers below. */
export function signToken(claims: TokenClaims, key: Buffer): string {
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${TOKEN_PREFIX}.${payload}`;
  return `${signingInput}.${sign(signingInput, key)}`;
}

export interface IssueAccessTokenOptions {
  userId: string;
  username: string;
  role: UserRole;
  sessionId: string;
  /** Overrides the role's default set. Used only to narrow, never to widen. */
  permissions?: Permission[];
  ttlSeconds?: number;
  issuedAt?: number;
}

export function issueAccessToken(options: IssueAccessTokenOptions, key: Buffer): { token: string; claims: AccessTokenClaims } {
  const iat = options.issuedAt ?? nowSeconds();
  const granted = options.permissions ?? ROLE_PERMISSIONS[options.role];
  // Narrowing only. A caller that asks for a permission the role does not carry gets the
  // role's set, not the union - a token must never grant more than the account behind it.
  const permissions = granted.filter((permission) => ROLE_PERMISSIONS[options.role].includes(permission));
  const claims: AccessTokenClaims = {
    sub: options.userId,
    usr: options.username,
    role: options.role,
    perms: [...permissions],
    sid: options.sessionId,
    typ: "access",
    iat,
    exp: iat + (options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS)
  };
  return { token: signToken(claims, key), claims };
}

export function issueRefreshToken(
  options: { userId: string; sessionId: string; refreshId: string; ttlSeconds?: number; issuedAt?: number },
  key: Buffer
): { token: string; claims: RefreshTokenClaims } {
  const iat = options.issuedAt ?? nowSeconds();
  const claims: RefreshTokenClaims = {
    sub: options.userId,
    sid: options.sessionId,
    typ: "refresh",
    iat,
    exp: iat + (options.ttlSeconds ?? REFRESH_TOKEN_TTL_SECONDS),
    jti: options.refreshId
  };
  return { token: signToken(claims, key), claims };
}

/**
 * Verify a token and return its claims.
 *
 * The signature is checked before the payload is parsed as anything but bytes, so a forged
 * token never reaches the JSON parser with attacker-chosen structure.
 */
export function verifyToken<T extends TokenClaims = TokenClaims>(
  token: string,
  key: Buffer,
  expectedType?: T["typ"],
  atSeconds?: number
): TokenVerification<T> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [version, payload, signature] = parts;
  if (version !== TOKEN_PREFIX) return { ok: false, reason: "unsupported-version" };
  if (!payload || !signature) return { ok: false, reason: "malformed" };

  const expected = sign(`${version}.${payload}`, key);
  if (!signaturesMatch(expected, signature)) return { ok: false, reason: "bad-signature" };

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof claims?.exp !== "number" || typeof claims?.sub !== "string" || typeof claims?.typ !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (expectedType && claims.typ !== expectedType) return { ok: false, reason: "wrong-type" };
  if (claims.exp <= (atSeconds ?? nowSeconds())) return { ok: false, reason: "expired" };

  return { ok: true, claims: claims as T };
}

/**
 * Read the signing key from configuration.
 *
 * Refuses a short key rather than padding it: a 16-character secret in a config file is the
 * kind of thing that survives to production precisely because nothing complained.
 */
export function signingKeyFromSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  if (trimmed.length < 32) {
    throw new Error("the auth signing secret must be at least 32 characters");
  }
  return Buffer.from(trimmed, "utf8");
}

/**
 * A fresh session id, used to correlate a login with every audit row it produces.
 *
 * A UUID, not a truncated random string: a refresh rotates the session id so a stolen old
 * refresh token dies with the session it was minted for, and that only holds if two ids are
 * never the same.
 */
export function newSessionId(): string {
  return `sess_${randomUUID().replace(/-/g, "")}`;
}

export function newUserId(): string {
  return `usr_${randomBytes(8).toString("hex")}`;
}
