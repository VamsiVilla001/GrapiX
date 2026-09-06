/**
 * The operator window's half of the login.
 *
 * Same shape as the Editor's, pointed at the Playout control service instead. Tokens live in
 * memory, not localStorage: a token that survives the tab is a token anything in the tab can
 * read, and an operator station has no reason to keep secrets on disk. A reload signs you
 * out, which on a shared machine is the safe default.
 */
import { apiRoot } from "./api";

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
    await post("/api/auth/logout", { sessionId: id }, token).catch(() => undefined);
  }
}

function armRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  if (!session) return;

  const lifetimeMs = session.expiresAtMs - Date.now();
  const delay = Math.max(lifetimeMs * 0.8, 5_000);
  refreshTimer = setTimeout(() => {
    void refresh().catch(() => {
      session = null;
      notify();
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
  const response = await fetch(`${apiRoot}${path}`, {
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
