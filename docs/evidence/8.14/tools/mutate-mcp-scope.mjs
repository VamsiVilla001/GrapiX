// Mutation check of the MCP scope suite (8.14 slice 1), claude-grapix-f1, 25 Nov 2026. Runs under LOCK gate with its own CARGO_TARGET_DIR.
// Part A mutates my own new file (backup + restore). Part B mutates Shared/contracts/src/mcp.rs, which nobody else has changed
// (git diff is clean before and is checked clean after). Every mutant must make the test fail; the failing checks are recorded.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const suite = path.join(repo, "conformance/src/mcp_scope.rs");
const contract = path.join(repo, "Shared/contracts/src/mcp.rs");
const backups = path.resolve("mut-mcp-backup");
fs.mkdirSync(backups, { recursive: true });
const original = { suite: fs.readFileSync(suite, "utf8"), contract: fs.readFileSync(contract, "utf8") };
fs.writeFileSync(path.join(backups, "mcp_scope.rs.orig"), original.suite);
fs.writeFileSync(path.join(backups, "mcp.rs.orig"), original.contract);

const mutants = [
  // A: the suite's own sensitivity
  ["suite", "A1 Take is not an operator scope (a Take request is not seen as Program)", "Scope::Cue | Scope::Take | Scope::Clear | Scope::ConfigureOutput | Scope::Stop => true,", "Scope::Cue | Scope::Clear | Scope::ConfigureOutput | Scope::Stop => true,\n        Scope::Take => false,"],
  ["suite", "A2 the hostile tool no longer reaches Program (it sends a Status)", "let _ = self.0.playout.lock().peer_mut().handle(ClientRequest::Clear(ClearRequest {\n            at: TakeAt::NextOpportunity,\n            expected: None,\n        }));", "let _ = self.0.playout.lock().peer_mut().handle(ClientRequest::Status);"],
  ["suite", "A3 the agent-reach check never calls a tool", "let _ = assembly.call(tool, &held);\n", ""],
  ["suite", "A4 a cue and a take are given no valid arguments (the recorder never sees them)", '"playout.cue" | "playout.take" => pinned,', '"playout.cue" | "playout.take" => { let _ = pinned; serde_json::json!({}) }'],
  ["suite", "A5 outputs.configure is given invalid arguments", '"outputs.configure" => serde_json::json!({ "adapter": "conformance", "live": false, "acceptFreeRun": false }),', '"outputs.configure" => serde_json::json!({}),'],
  ["suite", "A6 the not-served ratchet is emptied", 'const NOT_SERVED_YET: &[&str] = &["objects.list", "assets.list", "fonts.list"];', "const NOT_SERVED_YET: &[&str] = &[];"],
  ["suite", "A7 the admin-listed ratchet is emptied", 'const LISTED_ADMIN_ONLY: &[&str] = &["designsystem.commit", "designsystem.import"];', "const LISTED_ADMIN_ONLY: &[&str] = &[];"],
  ["suite", "A8 only the Editor tools are assembled (the Program tools are not registered)", 'server.register("playout.take", Box::new(PlayoutTake(Arc::clone(&tools))));', ""],
  ["suite", "A9 the expected operator-scope list loses Stop", "const OPERATOR_SCOPES: &[Scope] = &[Scope::Cue, Scope::Take, Scope::Clear, Scope::ConfigureOutput, Scope::Stop];", "const OPERATOR_SCOPES: &[Scope] = &[Scope::Cue, Scope::Take, Scope::Clear, Scope::ConfigureOutput];"],
  ["suite", "A10 the expected tool list gives playout.clear the wrong scope", '("playout.clear", Scope::Clear),', '("playout.clear", Scope::Cue),'],
  ["suite", "A11 the program crates are not listed", 'const PROGRAM_CRATES: &[&str] = &["gx-control-plane", "gx-control-transport", "gx-playout", "gx-playout-mcp"];', "const PROGRAM_CRATES: &[&str] = &[];"],
  ["suite", "A12 a dev-dependency is read as a dependency", 'in_section = line == "[dependencies]";', 'in_section = line.ends_with("dependencies]");'],
  // B: the contract, where the claims live
  ["contract", "B1 the gate lets every caller through", "Some(required) if held.contains(&required) => Ok(tool),\n            Some(_) => Err(Refusal::Unauthenticated),", "Some(_) => Ok(tool),"],
  ["contract", "B2 playout.take needs only the author scope", 'tool("playout.take", "playout", ToolEffect::Write, Scope::Take,', 'tool("playout.take", "playout", ToolEffect::Write, Scope::Author,'],
  ["contract", "B3 outputs.configure needs only the author scope", 'tool("outputs.configure", "outputs", ToolEffect::Write, Scope::ConfigureOutput,', 'tool("outputs.configure", "outputs", ToolEffect::Write, Scope::Author,'],
  ["contract", "B4 playout.clear needs the cue scope (a cue-only token can clear)", 'tool("playout.clear", "playout", ToolEffect::Write, Scope::Clear,', 'tool("playout.clear", "playout", ToolEffect::Write, Scope::Cue,'],
];

const files = { suite, contract };
const failedChecks = (log) =>
  [...log.matchAll(/"([^"\n]{20,200}?): Fail\(/g)].map((m) => m[1].slice(0, 90)).concat([...log.matchAll(/^test (mcp_scope::tests::\w+) \.\.\. FAILED/gm)].map((m) => m[1]));
let caught = 0;
const survivors = [];
const lines = [];
try {
  for (const [key, name, find, replace] of mutants) {
    const text = original[key];
    if (!text.includes(find)) {
      lines.push(`NOT FOUND: ${name}`);
      survivors.push(`${name} (pattern not found)`);
      continue;
    }
    fs.writeFileSync(files[key], text.replace(find, replace));
    const r = spawnSync("cargo", ["test", "--locked", "-p", "gx-conformance", "--lib", "mcp_scope"], { cwd: repo, encoding: "utf8", shell: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CARGO_TARGET_DIR: "D:/Project KK/cargo-target-f1" } });
    fs.writeFileSync(files[key], text);
    const log = `${r.stdout}\n${r.stderr}`;
    // "error: test failed" is cargo reporting a caught mutant, not a build failure: only a compile error counts.
    const compiled = !/could not compile|error\[E\d+\]/.test(log);
    fs.mkdirSync(path.resolve("mut-mcp-logs"), { recursive: true });
    fs.writeFileSync(path.resolve("mut-mcp-logs", `${name.split(" ")[0]}.log`), log);
    const failed = r.status !== 0;
    const ok = failed && compiled;
    if (ok) caught += 1;
    else survivors.push(`${name}${compiled ? "" : " (did not compile)"}`);
    lines.push(`${ok ? "caught  " : "SURVIVED"} ${name}  [${failedChecks(log).join(" | ")}]`);
    console.log(lines.at(-1));
  }
} finally {
  for (const [key, file] of Object.entries(files)) fs.writeFileSync(file, original[key]);
}
const sameSuite = fs.readFileSync(suite, "utf8") === fs.readFileSync(path.join(backups, "mcp_scope.rs.orig"), "utf8");
const gitClean = spawnSync("git", ["diff", "--quiet", "--", "Shared/contracts/src/mcp.rs"], { cwd: repo }).status === 0;
console.log(JSON.stringify({ mutants: mutants.length, caught, survivors, suiteRestoredByteForByte: sameSuite, contractGitDiffClean: gitClean }));
