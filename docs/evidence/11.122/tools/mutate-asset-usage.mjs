// Mutation check of task 119 slice 1 (project-wide asset usage), claude-grapix-f1, 25 Nov 2026. Mutates my own two NEW source files in place
// (backup + restore, verified byte for byte). Every mutant must make the tests fail. Runs under LOCK gate on a private target dir.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const files = {
  rule: path.join(repo, "Shared/contracts/src/asset_usage.rs"),
  service: path.join(repo, "services/editor/src/asset_usage.rs"),
};
const runs = {
  rule: ["test", "--locked", "-p", "gx-contracts", "--lib", "asset_usage"],
  service: ["test", "--locked", "-p", "gx-editor", "--lib", "asset_usage"],
};
const backups = path.resolve("mut-au-backup");
fs.mkdirSync(backups, { recursive: true });
const original = {};
for (const [key, file] of Object.entries(files)) {
  original[key] = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(backups, `${key}.orig`), original[key]);
}

const mutants = [
  ["rule", "R1 the key ignores the content hash (always id:<assetId>)", "Some(hash) => hash.0.clone(),", "Some(_) => format!(\"id:{}\", asset.asset_id),"],
  ["rule", "R2 an image object does not draw its asset", "SceneObject::Image(image) => image.asset_id == asset_id,", "SceneObject::Image(_) => false,"],
  ["rule", "R3 a mesh model does not count", "SceneObject::Mesh(mesh) => mesh.model_asset_id.as_deref() == Some(asset_id),", "SceneObject::Mesh(_) => false,"],
  ["rule", "R4 any declared material counts, bound or not", "slots.values().any(|binding| binding.material_id == material.material_id)\n            && ", "true\n            && "],
  ["rule", "R5 a material texture counts whatever asset it names", "material.textures.iter().any(|texture| texture.asset_id == asset_id)", "!material.textures.is_empty()"],
  ["rule", "R6 a scene is counted once per object, not once", "if drawn && !report.entries[at].scenes.iter().any(|scene| scene.scene_id == scene_id) {", "if drawn {"],
  ["rule", "R7 a scene that declares an asset counts although nothing draws it", "let drawn = !objects_drawing(&document, &asset.asset_id).is_empty();", "let drawn = true;"],
  ["rule", "R8 an unreadable scene is swallowed (no problem is named)", "Err(reason) => report.problems.push(UsageProblem { scene_id, reason }),", "Err(_) => {}"],
  ["rule", "R9 the same asset id is listed twice", "if !report.entries[at].asset_ids.contains(&asset.asset_id) {", "if true {"],
  ["rule", "R10 the library's assets are not entered (an unused library asset is missing)", "    for asset in project_assets {\n        entry_for(&mut report, asset);\n    }\n", ""],
  ["rule", "R11 scenes are reported in reverse of the order given", "    for (scene_id, read) in scenes {", "    for (scene_id, read) in scenes.into_iter().rev() {"],
  ["rule", "R12 the scene's id is the document's own id, not the store's", "scene_id: scene_id.clone(),\n                            name: document.name.clone(),", "scene_id: document.id.clone(),\n                            name: document.name.clone(),"],
  ["service", "S1 the scenes are read in reverse store order", ".list_scenes(project)?\n        .into_iter()", ".list_scenes(project)?\n        .into_iter()\n        .rev()"],
  ["service", "S2 the project library is not read (an empty library)", "let assets = projects.project_assets(project)?;", "let assets = Vec::new();"],
  ["service", "S3 an unreadable scene is dropped from the scenes (never reaches the rule)", ".map(|scene_id| {\n            let read = projects.read_scene(project, &scene_id).map_err(|error| error.to_string());\n            (scene_id, read)\n        })\n        .collect();", ".filter_map(|scene_id| projects.read_scene(project, &scene_id).ok().map(|document| (scene_id, Ok(document))))\n        .collect();"],
  ["service", "S4 the reason is lost", ".map_err(|error| error.to_string());", ".map_err(|_| String::new());"],
];

let caught = 0;
const survivors = [];
const lines = [];
const failedTests = (log) => [...log.matchAll(/^test (asset_usage::tests::\w+) \.\.\. FAILED/gm)].map((m) => m[1].replace("asset_usage::tests::", "").slice(0, 70));
try {
  for (const [key, name, find, replace] of mutants) {
    const text = original[key];
    if (!text.includes(find)) {
      lines.push(`NOT FOUND: ${name}`);
      survivors.push(`${name} (pattern not found)`);
      console.log(lines.at(-1));
      continue;
    }
    fs.writeFileSync(files[key], text.replace(find, replace));
    const r = spawnSync("cargo", runs[key], { cwd: repo, encoding: "utf8", shell: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CARGO_TARGET_DIR: "D:/Project KK/cargo-target-f1" } });
    fs.writeFileSync(files[key], text);
    const log = `${r.stdout}\n${r.stderr}`;
    const compiled = !/could not compile|error\[E\d+\]/.test(log);
    fs.mkdirSync(path.resolve("mut-au-logs"), { recursive: true });
    fs.writeFileSync(path.resolve("mut-au-logs", `${name.split(" ")[0]}.log`), log);
    const ok = r.status !== 0 && compiled;
    if (ok) caught += 1;
    else survivors.push(`${name}${compiled ? "" : " (did not compile)"}`);
    lines.push(`${ok ? "caught  " : "SURVIVED"} ${name}  [${failedTests(log).join(" | ")}]`);
    console.log(lines.at(-1));
  }
} finally {
  for (const [key, file] of Object.entries(files)) fs.writeFileSync(file, original[key]);
}
const restored = Object.entries(files).every(([key, file]) => fs.readFileSync(file, "utf8") === fs.readFileSync(path.join(backups, `${key}.orig`), "utf8"));
console.log(JSON.stringify({ mutants: mutants.length, caught, survivors, restoredByteForByte: restored }));
