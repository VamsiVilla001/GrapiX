/**
 * Password storage.
 *
 * scrypt from `node:crypto` rather than a dependency: it is memory-hard, it is in the standard
 * library, and adding argon2 would mean a native build step on every machine that installs this
 * repo. The cost parameters are stored *in the hash string*, so raising them later does not
 * invalidate existing accounts - an old hash still verifies with its own parameters and can be
 * re-hashed on the next successful login.
 *
 * Format: `scrypt$N$r$p$<salt base64>$<derived key base64>`
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/** ~64 MiB of memory per hash. Enough to make bulk offline cracking expensive. */
const DEFAULT_COST = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** scrypt needs headroom above 128*N*r; the default 32 MiB cap is below what N=16384 wants. */
function maxmemFor(N: number, r: number): number {
  return Math.max(32 * 1024 * 1024, 256 * N * r);
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = DEFAULT_COST;
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Check a password against a stored hash.
 *
 * Returns false for a malformed stored hash rather than throwing: a corrupt row in the user
 * store must fail the login, not crash the login route for everybody.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a stored hash was made with weaker parameters than this build now uses. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < DEFAULT_COST.N;
}
