/**
 * The session service: issues, refreshes and revokes tokens against a user store.
 *
 * Both products run one of these, and both point it at the same store and the same signing
 * key as the engine - which is the whole design: a login in Editor and a login in Playout
 * produce tokens the engine trusts identically, because there is one account system, not
 * one per application.
 *
 * Sessions live in memory. A restart logs everyone out, which for a broadcast facility is a
 * feature masquerading as a limitation: the failure mode of a forgotten persistent session on
 * a shared operator machine is worse than the inconvenience of signing in again.
 */
import { newSessionId } from "./token.js";
import type { AccessTokenClaims, RefreshTokenClaims, UserRole } from "./types.js";
import {
  issueAccessToken,
  issueRefreshToken,
  verifyToken
} from "./token.js";
import type { PublicUser, StoredUser, UserStore } from "./userStore.js";
import { toPublicUser } from "./userStore.js";

export interface Session {
  id: string;
  user: PublicUser;
  createdAt: number;
  /** Rotated on every refresh, so a stolen old token dies with the session that replaced it. */
  refreshId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessClaims: AccessTokenClaims;
  refreshClaims: RefreshTokenClaims;
}

export type AuthFailure =
  | "unknown-user"
  | "bad-password"
  | "disabled"
  | "no-user-store"
  | "invalid-refresh"
  | "session-expired";

export class AuthService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly store: UserStore,
    private readonly signingKey: Buffer
  ) {}

  /** The user's display name and role, for a UI that has a valid access token. */
  async login(identifier: string, password: string): Promise<{ session: Session; tokens: IssuedTokens } | { failure: AuthFailure }> {
    const outcome = await this.store.authenticate(identifier, password);
    if (!outcome.ok) return { failure: outcome.reason };

    const user = outcome.user as StoredUser;
    const session: Session = {
      id: newSessionId(),
      user: toPublicUser(user),
      createdAt: Date.now(),
      refreshId: newSessionId()
    };
    this.sessions.set(session.id, session);
    void this.store.noteLogin(user.id);

    return { session, tokens: this.mint(session) };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * The refresh token proves the session; the account is re-read so a role change or a
   * disablement since login takes effect on this call rather than whenever the access token
   * happened to expire.
   */
  async refresh(refreshToken: string): Promise<{ session: Session; tokens: IssuedTokens } | { failure: AuthFailure }> {
    const verified = verifyToken<RefreshTokenClaims>(refreshToken, this.signingKey, "refresh");
    if (!verified.ok) return { failure: "invalid-refresh" };

    const session = this.sessions.get(verified.claims.sid);
    if (!session) return { failure: "session-expired" };

    // The rotation check: this token must be the one the session most recently issued. An old
    // refresh token - stolen, replayed, or just stale - has a `jti` that no longer matches,
    // and is refused here rather than honoured.
    if (verified.claims.jti !== session.refreshId) return { failure: "invalid-refresh" };

    const user = this.store.findById(session.user.id);
    if (!user || user.disabled) return { failure: "disabled" };

    // Rotate the session: the old refresh token is dead from this call.
    session.refreshId = newSessionId();
    session.user = toPublicUser(user);
    return { session, tokens: this.mint(session) };
  }

  logout(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Verify an access token and return the session behind it, for protecting API routes. */
  verifyAccess(token: string): { claims: AccessTokenClaims; session: Session } | { failure: AuthFailure } {
    const verified = verifyToken<AccessTokenClaims>(token, this.signingKey, "access");
    if (!verified.ok) return { failure: "invalid-refresh" };

    // Access tokens are intentionally portable between GrapiX services. Editor and Playout
    // have separate in-memory session tables, but share the account store and signing key; a
    // token minted by one must therefore be accepted by the other. Refresh tokens remain
    // issuer-local and still require the original in-memory session.
    //
    // Re-reading the account also makes a disablement, rename or role change effective on the
    // next request in either product. A signed token with stale identity claims is refused
    // instead of silently restoring the old authority.
    const user = this.store.findById(verified.claims.sub);
    if (!user || user.disabled) return { failure: "disabled" };
    if (user.username !== verified.claims.usr || user.role !== verified.claims.role) {
      return { failure: "session-expired" };
    }

    const localSession = this.sessions.get(verified.claims.sid);
    if (localSession) {
      localSession.user = toPublicUser(user);
      return { claims: verified.claims, session: localSession };
    }

    // A peer-issued access token has no refresh authority here. This transient view exists
    // only so route guards and audit code receive the same shape as a local session.
    return {
      claims: verified.claims,
      session: {
        id: verified.claims.sid,
        user: toPublicUser(user),
        createdAt: verified.claims.iat * 1000,
        refreshId: ""
      }
    };
  }

  private mint(session: Session): IssuedTokens {
    const { token: accessToken, claims: accessClaims } = issueAccessToken(
      {
        userId: session.user.id,
        username: session.user.username,
        role: session.user.role as UserRole,
        sessionId: session.id
      },
      this.signingKey
    );
    const { token: refreshToken, claims: refreshClaims } = issueRefreshToken(
      { userId: session.user.id, sessionId: session.id, refreshId: session.refreshId },
      this.signingKey
    );
    return { accessToken, refreshToken, accessClaims, refreshClaims };
  }
}
