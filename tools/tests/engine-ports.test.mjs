// 2.21: the tools take the engine's ports from the one file that names them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ENDPOINTS_FILE, enginePorts, portNamed } from "../engine-ports.mjs";

const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the ports read from the endpoints module agree with its default endpoints", () => {
  const source = readFileSync(ENDPOINTS_FILE, "utf8");
  const { control, asset } = enginePorts();
  assert.ok(Number.isInteger(control) && control > 0 && control < 65536, `${control}`);
  assert.equal(asset, control + 1, "the asset plane is the next port");
  // The same file writes the default endpoints out; a port read here that
  // disagreed with them would be a port read from the wrong line.
  assert.match(source, new RegExp(`DEFAULT_CONTROL_ENDPOINT: &str = "127\\.0\\.0\\.1:${control}";`));
  assert.match(source, new RegExp(`DEFAULT_ASSET_ENDPOINT: &str = "127\\.0\\.0\\.1:${asset}";`));
});

test("a constant the module does not name is an error by name, not a default", () => {
  assert.throws(() => portNamed("ENGINE_NO_SUCH_PORT"), /no longer names ENGINE_NO_SUCH_PORT/);
  const renamed = "pub const CONTROL_PORT: u16 = 4400;\npub const ENGINE_ASSET_PORT: u16 = 4401;\n";
  assert.throws(() => enginePorts(renamed), /no longer names ENGINE_CONTROL_PORT/);
  // A commented-out or indented look-alike is not the constant.
  assert.throws(() => portNamed("ENGINE_CONTROL_PORT", "// pub const ENGINE_CONTROL_PORT: u16 = 1;\n"), /no longer names/);
  assert.equal(portNamed("ENGINE_CONTROL_PORT", "pub const ENGINE_CONTROL_PORT: u16 = 4400;\n"), 4400);
});

test("the launcher asks for the ports and writes no port number of its own", () => {
  const launcher = readFileSync(resolve(TOOLS, "launch-shells.mjs"), "utf8");
  assert.match(launcher, /import \{ enginePorts \} from "\.\/engine-ports\.mjs";/);
  assert.match(launcher, /enginePorts\(\)/);
  const { control, asset } = enginePorts();
  for (const port of [control, asset]) {
    assert.ok(!new RegExp(`\\b${port}\\b`).test(launcher), `the launcher writes ${port} out`);
  }
});
