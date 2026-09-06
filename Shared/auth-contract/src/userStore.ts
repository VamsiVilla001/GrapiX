/**
 * The account store: a small JSON file, read into memory and written atomically.
 *
 * A database would be the reflex, but the population here is a facility's staff - tens of
 * accounts, not thousands - and the repo already keeps its durable state as JSON on disk. A
 * file that an administrator can read, back up and diff is worth more here than query
 * capability nobody needs.
 *
 * The file contains password *hashes* and never a password. It is written 0600 where the
 * platform honours it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import type { UserRole } from "./types.js";
import { ROLE_PERMISSIONS, USER_ROLES } from "./types.js";

export interface StoredUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  passwordHash: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/** A user as anything outside this module may see it: no hash, ever. */
export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  permissions: readonly string[];
}

export function toPublicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    permissions: ROLE_PERMISSIONS[user.role]
  };
}

interface UserFile {
  version: 1;
  users: StoredUser[];
}

export type LoginOutcome =
  | { ok: true; user: StoredUser }
  | { ok: false; reason: "unknown-user" | "bad-password" | "disabled" };

export class UserStore {
  private users: StoredUser[] = [];
  private loaded = false;

  constructor(private readonly path: string) {}

  static defaultPath(dataDirectory: string): string {
    return join(dataDirectory, "users.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as UserFile;
      this.users = Array.isArray(parsed?.users) ? parsed.users.filter(isStoredUser) : [];
    } catch {
      this.users = [];
    }
    this.loaded = true;
  }

  list(): PublicUser[] {
    return this.users.map(toPublicUser);
  }

  count(): number {
    return this.users.length;
  }

  findById(id: string): StoredUser | undefined {
    return this.users.find((user) => user.id === id);
  }

  /**
   * Look up by username *or* email, case-insensitively.
   *
   * Operators do not reliably remember which one they registered with, and a login form that
   * accepts only one of them generates support calls rather than security.
   */
  findByIdentifier(identifier: string): StoredUser | undefined {
    const needle = identifier.trim().toLowerCase();
    return this.users.find(
      (user) => user.username.toLowerCase() === needle || user.email.toLowerCase() === needle
    );
  }

  /**
   * Verify a credential.
   *
   * An unknown user still pays the cost of a hash comparison. Returning early would make the
   * response time itself a user-enumeration oracle, which is a real finding on any login form
   * that faces a venue network.
   */
  async authenticate(identifier: string, password: string): Promise<LoginOutcome> {
    const user = this.findByIdentifier(identifier);
    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      return { ok: false, reason: "unknown-user" };
    }
    const matches = await verifyPassword(password, user.passwordHash);
    if (!matches) return { ok: false, reason: "bad-password" };
    if (user.disabled) return { ok: false, reason: "disabled" };

    if (needsRehash(user.passwordHash)) {
      user.passwordHash = await hashPassword(password);
      user.updatedAt = new Date().toISOString();
      await this.save();
    }
    return { ok: true, user };
  }

  async create(input: {
    username: string;
    email: string;
    password: string;
    role: UserRole;
  }): Promise<PublicUser> {
    if (!this.loaded) await this.load();
    if (this.findByIdentifier(input.username) || this.findByIdentifier(input.email)) {
      throw new Error("a user with that username or email already exists");
    }
    if (!USER_ROLES.includes(input.role)) {
      throw new Error(`unknown role ${input.role}`);
    }
    const now = new Date().toISOString();
    const user: StoredUser = {
      id: `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      username: input.username.trim(),
      email: input.email.trim(),
      role: input.role,
      passwordHash: await hashPassword(input.password),
      disabled: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null
    };
    this.users.push(user);
    await this.save();
    return toPublicUser(user);
  }

  async setRole(id: string, role: UserRole): Promise<PublicUser | undefined> {
    const user = this.findById(id);
    if (!user) return undefined;
    user.role = role;
    user.updatedAt = new Date().toISOString();
    await this.save();
    return toPublicUser(user);
  }

  async setDisabled(id: string, disabled: boolean): Promise<PublicUser | undefined> {
    const user = this.findById(id);
    if (!user) return undefined;
    user.disabled = disabled;
    user.updatedAt = new Date().toISOString();
    await this.save();
    return toPublicUser(user);
  }

  async setPassword(id: string, password: string): Promise<boolean> {
    const user = this.findById(id);
    if (!user) return false;
    user.passwordHash = await hashPassword(password);
    user.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async noteLogin(id: string): Promise<void> {
    const user = this.findById(id);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    await this.save();
  }

  /**
   * Create the first administrator when the store is empty.
   *
   * Returns the generated password exactly once, for the operator to write down. It is never
   * logged and never stored - only its hash is. An engine that shipped with a known default
   * password would be worse than one with no auth at all, because it would look secure.
   */
  async ensureBootstrapAdmin(username = "admin"): Promise<{ user: PublicUser; password: string } | null> {
    if (!this.loaded) await this.load();
    if (this.users.length > 0) return null;
    const password = generatePassword();
    const user = await this.create({
      username,
      email: `${username}@localhost`,
      password,
      role: "admin"
    });
    return { user, password };
  }

  private async save(): Promise<void> {
    const file: UserFile = { version: 1, users: this.users };
    const body = `${JSON.stringify(file, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated account file, which
    // would lock every operator out of the system at the worst possible moment.
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/**
 * A hash to compare against when the user does not exist.
 *
 * Real scrypt output, so the comparison costs what a real one costs.
 */
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function generatePassword(): string {
  // Ambiguous glyphs removed: this gets read off a screen and typed on a different machine.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function isStoredUser(value: unknown): value is StoredUser {
  if (value === null || typeof value !== "object") return false;
  const user = value as Partial<StoredUser>;
  return (
    typeof user.id === "string" &&
    typeof user.username === "string" &&
    typeof user.email === "string" &&
    typeof user.passwordHash === "string" &&
    typeof user.role === "string" &&
    USER_ROLES.includes(user.role as UserRole)
  );
}
