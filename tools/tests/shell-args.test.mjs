// The launcher passes a package folder that has spaces in it to the engine: it must
// arrive as one argument, through the Windows shell and not.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { quoteForCmd, shellArguments } from "../shell-args.mjs";

test("an argument is quoted only when the shell would split it", () => {
  assert.equal(quoteForCmd("--port"), "--port");
  assert.equal(quoteForCmd("4400"), "4400");
  assert.equal(quoteForCmd("D:\\Project KK\\Personal projects\\x"), '"D:\\Project KK\\Personal projects\\x"');
  assert.equal(quoteForCmd(""), '""');
  assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  // A trailing backslash must not escape the closing quote.
  assert.equal(quoteForCmd("D:\\a b\\"), '"D:\\a b\\\\"');
});

test("arguments are quoted for the Windows shell and left alone elsewhere", () => {
  const args = ["--package-dir", "D:\\Project KK\\dev packages"];
  assert.deepEqual(shellArguments(args, { shell: true, platform: "win32" }), ["--package-dir", '"D:\\Project KK\\dev packages"']);
  assert.deepEqual(shellArguments(args, { shell: false, platform: "win32" }), args, "an .exe is started without a shell");
  assert.deepEqual(shellArguments(args, { shell: true, platform: "linux" }), args);
});

test("a path with spaces arrives as one argument through a real child process", async () => {
  const folder = mkdtempSync(join(tmpdir(), "gx launcher test "));
  try {
    const script = join(folder, "print args.mjs");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const wanted = ["--port", "4400", "--package-dir", "D:\\Project KK\\Personal projects\\dev packages", 'a "quoted" word'];
    const run = (shell) =>
      new Promise((resolve, reject) => {
        const args = shellArguments([script, ...wanted], { shell });
        const child = spawn("node", args, { shell, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("error", reject);
        child.on("close", () => resolve(out.trim()));
      });
    // Through the Windows shell (how the launcher starts `npx`): the quoting is what keeps it whole.
    assert.deepEqual(JSON.parse(await run(true)), wanted);
    // Without a shell (how it starts the engine .exe): nothing to quote.
    assert.deepEqual(JSON.parse(await run(false)), wanted);
    // And the failure this fixes, shown so the test cannot pass for the wrong reason: the same
    // line, unquoted, through the shell, splits at the spaces.
    if (process.platform === "win32") {
      const unquoted = spawnSync("node", [script, ...wanted], { shell: true, encoding: "utf8" });
      assert.notDeepEqual(JSON.parse(unquoted.stdout.trim() || "[]"), wanted, "an unquoted path went through whole: the test proves nothing");
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the launcher runs each shell as its own program, never through `tauri dev`", () => {
  // `tauri dev --config Playout/shell/tauri.conf.json`, run from the repository root beside
  // the Editor's config, ran the Editor's program, and two of them fought over one
  // gx-editor.exe ("Access is denied"), which tore the arrangement down, engine included.
  const launcher = readFileSync(join(import.meta.dirname, "..", "launch-shells.mjs"), "utf8");
  assert.match(launcher, /exe\("gx-editor"\)/);
  assert.match(launcher, /exe\("gx-playout"\)/);
  assert.ok(!/"tauri"/.test(launcher), "the launcher starts a shell through tauri again");
  const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")).scripts;
  assert.ok(!/tauri dev.*Playout/.test(scripts.playout), `npm run playout is ${scripts.playout}`);
  assert.match(scripts.playout, /gx-playout-shell/);
});
