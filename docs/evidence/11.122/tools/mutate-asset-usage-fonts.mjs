// Mutation check of task 119 slice 1b (fonts counted as used by text), claude-grapix-f1, 25 Nov 2026. In place on my own NEW rule file,
// backup + restore verified byte for byte. Every mutant must make the rule's tests fail. Under LOCK gate, private target dir.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const file = path.join(repo, "Shared/contracts/src/asset_usage.rs");
const original = fs.readFileSync(file, "utf8");
const backup = path.resolve("mut-au-backup/fonts.orig");
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, original);

const FACES = ".is_some_and(|font| font.faces.iter().any(|face| matches!(&face.source, FontSource::File { asset_id: file, .. } if file == asset_id)))";
const mutants = [
  ["F1 a text object never draws a font file", "    let SceneObject::Text(text) = object else {\n        return false;\n    };\n    document", "    let SceneObject::Text(_) = object else {\n        return false;\n    };\n    let _ = document;\n    if true {\n        return false;\n    }\n    document"],
  ["F2 any font's file counts, not the font the text names", `        .font(&text.font_id)\n        ${FACES}`, `        .fonts\n        .iter()\n        .any(|font| font.faces.iter().any(|face| matches!(&face.source, FontSource::File { asset_id: file, .. } if file == asset_id)))`],
  ["F3 every face of the font must come from the file, not any one", ".is_some_and(|font| font.faces.iter().any(|face|", ".is_some_and(|font| font.faces.iter().all(|face|"],
  ["F4 a hidden text object does not draw its font", "    let SceneObject::Text(text) = object else {\n        return false;\n    };\n    document", "    let SceneObject::Text(text) = object else {\n        return false;\n    };\n    if !text.base.visible {\n        return false;\n    }\n    document"],
];

let caught = 0;
const survivors = [];
const failedTests = (log) => [...log.matchAll(/^test (asset_usage::tests::\w+) \.\.\. FAILED/gm)].map((m) => m[1].replace("asset_usage::tests::", "").slice(0, 80));
try {
  for (const [name, find, replace] of mutants) {
    if (!original.includes(find)) {
      survivors.push(`${name} (pattern not found)`);
      console.log(`NOT FOUND: ${name}`);
      continue;
    }
    fs.writeFileSync(file, original.replace(find, replace));
    const r = spawnSync("cargo", ["test", "--locked", "-p", "gx-contracts", "--lib", "asset_usage"], { cwd: repo, encoding: "utf8", shell: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CARGO_TARGET_DIR: "D:/Project KK/cargo-target-f1" } });
    fs.writeFileSync(file, original);
    const log = `${r.stdout}\n${r.stderr}`;
    const compiled = !/could not compile|error\[E\d+\]/.test(log);
    const ok = r.status !== 0 && compiled;
    if (ok) caught += 1;
    else survivors.push(`${name}${compiled ? "" : " (did not compile)"}`);
    console.log(`${ok ? "caught  " : "SURVIVED"} ${name}  [${failedTests(log).join(" | ")}]`);
  }
} finally {
  fs.writeFileSync(file, original);
}
const restored = fs.readFileSync(file, "utf8") === fs.readFileSync(backup, "utf8");
console.log(JSON.stringify({ mutants: mutants.length, caught, survivors, restoredByteForByte: restored }));
