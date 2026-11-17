// The engine's ports, for the tools (build plan 2.21).
//
// They are written once, in `Shared/contracts/src/endpoints.rs`, and every
// Rust crate takes them from there. A Node tool cannot import a Rust constant,
// so it reads the same file here instead of keeping a number of its own. A
// constant that is renamed or removed is an error by name, never a default.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one file that names the engine's ports. */
export const ENDPOINTS_FILE = resolve(ROOT, "Shared", "contracts", "src", "endpoints.rs");

/** The value of a `pub const NAME: u16 = N;` in the endpoints module. */
export function portNamed(name, source = readFileSync(ENDPOINTS_FILE, "utf8")) {
  const found = new RegExp(`^pub const ${name}: u16 = (\\d+);`, "m").exec(source);
  if (!found) throw new Error(`Shared/contracts/src/endpoints.rs no longer names ${name}`);
  return Number(found[1]);
}

/** The engine's control and asset ports. */
export function enginePorts(source) {
  return {
    control: portNamed("ENGINE_CONTROL_PORT", source),
    asset: portNamed("ENGINE_ASSET_PORT", source),
  };
}
