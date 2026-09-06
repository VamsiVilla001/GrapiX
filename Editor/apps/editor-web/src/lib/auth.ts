/**
 * The editor window's half of the login.
 *
 * Holds the tokens the window minted at sign-in and refreshes them before they lapse, so an
 * author working through lunch does not lose the next save to an expired access token. The
 * access token is what every API request and the engine socket present; the refresh token is
 * how the window gets a new one without asking for the password again.
 *
 * Tokens live in memory, not localStorage. A token in localStorage survives the tab and is
 * readable by anything that runs in it, and the window has no other reason to keep secrets on
 * disk. The cost of that choice is that a reload signs you out - which for a facility machine
 * is a feature, not a bug.
 */
import { apiBaseUrl } from "./apiClient";

export interface SignedInUser {
  id: string;
  username: string;
  email: string;
  role: string;
  permissions: readonly string[];
}

interface Session {
  user: SignedInUser;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Milliseconds timestamp at which the access token lapses. */
  expiresAtMs: number;
}

let session: Session | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(user: SignedInUser | null) => void>();

export function currentUser(): SignedInUser | null {
  return session?.user ?? null;
}

export function currentAccessToken(): string | null {
  return session?.accessToken ?? null;
}

export function onAuthChange(listener: (user: SignedInUser | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  const user = session?.user ?? null;
  for (const listener of listeners) listener(user);
}

interface LoginReply {
  ok: boolean;
  user: SignedInUser;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export async function signIn(identifier: string, password: string): Promise<SignedInUser> {
  const reply = await post<LoginReply>("/api/auth/login", { identifier, password });
  applySession(reply);
  return reply.user;
}

export async function signOut(): Promise<void> {
  const id = session?.sessionId;
  const token = session?.accessToken;
  session = null;
  armRefresh();
  notify();
  if (id) {
    await post("/api/auth/logout", { sessionId: id }, token ?? undefined).catch(() => undefined);
  }
}

/**
 * Drop a session the project service has refused.
 *
 * Services deliberately keep sessions in memory, so restarting one invalidates a browser's
 * otherwise unexpired token. Central API clients call this on 401 and the App's existing auth
 * listener immediately returns the user to Sign in instead of leaving every action broken.
 */
export function invalidateSession(): void {
  if (!session) return;
  session = null;
  armRefresh();
  notify();
}

/**
 * Exchange the refresh token for a new pair before the access token lapses.
 *
 * Scheduled for 80% of the access token's life rather than at the deadline, so a slow network
 * does not turn a refresh into a sign-out.
 */
function armRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  if (!session) return;

  const nowMs = Date.now();
  const lifetimeMs = session.expiresAtMs - nowMs;
  const delay = Math.max(lifetimeMs * 0.8, 5_000);
  refreshTimer = setTimeout(() => {
    void refresh().catch(() => {
      // A failed refresh signs the window out rather than limping on a dead token: the next
      // request would be refused anyway, and the login screen is the honest state to land on.
      invalidateSession();
    });
  }, delay);
}

async function refresh(): Promise<void> {
  if (!session) return;
  const reply = await post<LoginReply>("/api/auth/refresh", { refreshToken: session.refreshToken });
  applySession(reply);
}

function applySession(reply: LoginReply): void {
  session = {
    user: reply.user,
    sessionId: reply.sessionId,
    accessToken: reply.accessToken,
    refreshToken: reply.refreshToken,
    expiresAtMs: reply.expiresAt * 1000
  };
  armRefresh();
  notify();
}

async function post<T>(path: string, body: unknown, accessToken?: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `sign-in failed with ${response.status}`);
  }
  return payload as T;
}
