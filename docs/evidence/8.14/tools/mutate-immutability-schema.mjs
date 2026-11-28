// Mutation check of 8.14 slice 2 (a published revision never changes; an unknown scene schema version fails closed), claude-grapix-f1,
// 25 Nov 2026. Runs under LOCK gate on a private CARGO_TARGET_DIR. Every mutant must make `cargo test -p gx-conformance --lib mcp_scope`
// fail by compile-clean test failure. Usage: node mutate-immutability-schema.mjs <backup-and-log-dir> [A13,X1,...]
//
// Four of the five files are not only mine: services/playout/src/lib.rs and Shared/contracts/src/scene.rs hold other agents' uncommitted
// work. So: each file is read at the start and must still be what was read before every mutant (a changed file aborts the run, nothing is
// written over someone else's edit), the original text is put back after every mutant, and at the end each file is compared with its
// start byte for byte. The mutants are one-expression edits and are never left on disk.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const files = {
  suite: path.join(repo, "conformance/src/mcp_scope.rs"),
  playout: path.join(repo, "services/playout/src/lib.rs"),
  contract: path.join(repo, "Shared/contracts/src/mcp.rs"),
  scene: path.join(repo, "Shared/contracts/src/scene.rs"),
  package: path.join(repo, "Shared/asset-plane/src/package.rs"),
};
const work = path.resolve(process.argv[2] ?? "mut-8-14-s2");
const only = process.argv[3]?.split(",");
fs.mkdirSync(path.join(work, "logs"), { recursive: true });
const original = {};
for (const [key, file] of Object.entries(files)) {
  original[key] = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(work, `${key}.orig`), original[key]);
}

const mutants = [
  // A: the suite's own sensitivity
  ["suite", "A13 no author write tool is looked at", "if tool.effect != ToolEffect::Write || tool.required_scope != Some(Scope::Author) {", "if true {"],
  ["suite", "A14 the names of a published revision are not listed", 'const PUBLISHED_REVISION_FIELDS: &[&str] = &["takeId", "contentHash"];', "const PUBLISHED_REVISION_FIELDS: &[&str] = &[];"],
  ["suite", "A15 no scene-reading tool is found", 'tool.input == "SceneRef"', 'tool.input == "NoSuchType"'],
  // X: a published revision changes (Playout's library)
  ["playout", "X1 a publish reuses the revision number, so it overwrites the last one", "            .unwrap_or(Revision(0))\n            .next();", "            .unwrap_or(Revision(1));"],
  ["playout", "X2 a review wipes the document", "        scene.review = review;\n        Ok(scene)", "        scene.review = review;\n        scene.document = serde_json::Value::Null;\n        Ok(scene)"],
  ["playout", "X3 a review drops the content hash", "        scene.review = review;\n        Ok(scene)", "        scene.review = review;\n        scene.content_hash = None;\n        Ok(scene)"],
  ["playout", "X4 a review moves nothing", "        scene.review = review;\n        Ok(scene)", "        let _ = review;\n        Ok(scene)"],
  ["playout", "X5 a review drops the design system stamp", "        scene.review = review;\n        Ok(scene)", "        scene.review = review;\n        scene.design_system_version = None;\n        Ok(scene)"],
  ["playout", "X6 a publish hashes nothing of its document", "            content_hash: Some(scene_content_hash(&document)),\n            document,", "            content_hash: Some(scene_content_hash(&serde_json::Value::Null)),\n            document,"],
  // X7: an author write can say which revision to touch
  ["contract", "X7 packages.publish takes a Take ID and a content hash", 'tool("packages.publish", "packages", ToolEffect::Write, Scope::Author, "PackageRef",', 'tool("packages.publish", "packages", ToolEffect::Write, Scope::Author, "ProgramArgs",'],
  // Y: the scene reader's guard
  ["scene", "Y1 any scene version is read", "    if !(1..u64::from(SCENE_SCHEMA_VERSION)).contains(&version) {", "    if false {"],
  ["scene", "Y2 version 0 is read", "    if !(1..u64::from(SCENE_SCHEMA_VERSION)).contains(&version) {", "    if !(0..u64::from(SCENE_SCHEMA_VERSION)).contains(&version) {"],
  ["scene", "Y3 the next version is read", "    if !(1..u64::from(SCENE_SCHEMA_VERSION)).contains(&version) {", "    if !(1..=u64::from(SCENE_SCHEMA_VERSION) + 1).contains(&version) {"],
  ["scene", "Y4 the refusal does not say what was found", "            actual: u32::try_from(version).unwrap_or(u32::MAX),\n            supported: SCENE_SCHEMA_VERSION,", "            actual: 0,\n            supported: SCENE_SCHEMA_VERSION,"],
  ["scene", "Y5 the refusal does not say what is supported", "            actual: u32::try_from(version).unwrap_or(u32::MAX),\n            supported: SCENE_SCHEMA_VERSION,", "            actual: u32::try_from(version).unwrap_or(u32::MAX),\n            supported: 0,"],
  // Z: the package reader's guard
  ["package", "Z1 a package scene is read without the version guard", "    let scene = parse_scene_document(scene_bytes)?;\n    verify_scene_pin", "    let scene: SceneDocument = serde_json::from_slice(scene_bytes).map_err(|e| Refusal::SceneParseFailed { detail: e.to_string() })?;\n    verify_scene_pin"],
];

const failedChecks = (log) =>
  [...log.matchAll(/"([^"\n]{20,260}?): Fail\(/g)].map((m) => m[1].slice(0, 80)).concat([...log.matchAll(/^test (mcp_scope::tests::\w+) \.\.\. FAILED/gm)].map((m) => m[1]));
let caught = 0;
let ran = 0;
const survivors = [];
const lines = [];
let aborted = null;
try {
  for (const [key, name, find, replace] of mutants) {
    if (only && !only.includes(name.split(" ")[0])) continue;
    const text = original[key];
    if (!text.includes(find)) {
      lines.push(`NOT FOUND: ${name}`);
      survivors.push(`${name} (pattern not found)`);
      console.log(lines.at(-1));
      continue;
    }
    // Nobody else has changed this file since the run began: otherwise stop, and write nothing over it.
    if (fs.readFileSync(files[key], "utf8") !== text) {
      aborted = `${files[key]} changed under the run before ${name}`;
      break;
    }
    ran += 1;
    fs.writeFileSync(files[key], text.replace(find, replace));
    const r = spawnSync("cargo", ["test", "--locked", "-p", "gx-conformance", "--lib", "mcp_scope"], {
      cwd: repo,
      encoding: "utf8",
      shell: true,
      timeout: 1200000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CARGO_TARGET_DIR: "D:/Project KK/cargo-target-f1" },
    });
    fs.writeFileSync(files[key], text);
    const log = `${r.stdout}\n${r.stderr}`;
    const compiled = !/could not compile|error\[E\d+\]/.test(log);
    fs.writeFileSync(path.join(work, "logs", `${name.split(" ")[0]}.log`), log);
    const ok = r.status !== 0 && compiled;
    if (ok) caught += 1;
    else survivors.push(`${name}${compiled ? "" : " (did not compile)"}`);
    lines.push(`${ok ? "caught  " : "SURVIVED"} ${name}  [${failedChecks(log).join(" | ")}]`);
    console.log(lines.at(-1));
  }
} finally {
  for (const [key, file] of Object.entries(files)) {
    if (fs.readFileSync(file, "utf8") !== original[key] && !aborted) fs.writeFileSync(file, original[key]);
  }
}
const restored = Object.entries(files).every(([key, file]) => fs.readFileSync(file, "utf8") === fs.readFileSync(path.join(work, `${key}.orig`), "utf8"));
const summary = JSON.stringify({ mutants: mutants.length, ran, caught, survivors, aborted, restoredByteForByte: restored });
fs.writeFileSync(path.join(work, "mutation-log.txt"), `${lines.join("\n")}\n${summary}\n`);
console.log(summary);
