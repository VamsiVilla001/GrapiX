// Mutation check of task 121 slice 2 (ColumnChange in the CSV reader's module, and the service's file reader), claude-grapix-f1, 25 Nov 2026.
// Mutates my own NEW source (backup + restore, verified byte for byte). Every mutant must make the tests of its own file fail. Runs under LOCK
// gate on a private target dir. Usage: node mutate-csv-slice2.mjs <backup-and-log-dir> [C7,S15,...]  (the second argument runs only those)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const files = {
  contract: path.join(repo, "Shared/contracts/src/csv_table.rs"),
  service: path.join(repo, "services/editor/src/csv_source.rs"),
};
const runs = {
  contract: ["test", "--locked", "-p", "gx-contracts", "--lib", "csv_table"],
  service: ["test", "--locked", "-p", "gx-editor", "--lib", "csv_source"],
};
const work = path.resolve(process.argv[2] ?? "mut-s2");
const only = process.argv[3]?.split(",");
fs.mkdirSync(path.join(work, "logs"), { recursive: true });
const original = {};
for (const [key, file] of Object.entries(files)) {
  original[key] = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(work, `${key}.orig`), original[key]);
}

const mutants = [
  ["contract", "C1 an added column is one the old list had", "            .filter(|name| !in_old.contains(name.as_str()))", "            .filter(|name| in_old.contains(name.as_str()))"],
  ["contract", "C2 a removed column is one the new list has", "            .filter(|name| !in_new.contains(name.as_str()))", "            .filter(|name| in_new.contains(name.as_str()))"],
  ["contract", "C3 a different order is never named", "reordered: !kept_in_old.eq(kept_in_new),", "reordered: false,"],
  ["contract", "C4 any difference of the lists is a different order", "reordered: !kept_in_old.eq(kept_in_new),", "reordered: old != new,"],
  ["contract", "C5 the old columns are not narrowed to the kept ones", "let kept_in_old = old.iter().filter(|name| in_new.contains(name.as_str()));", "let kept_in_old = old.iter();"],
  ["contract", "C6 the new columns are not narrowed to the kept ones", "let kept_in_new = new.iter().filter(|name| in_old.contains(name.as_str()));", "let kept_in_new = new.iter();"],
  ["contract", "C7 a reorder alone is no change", "self.added.is_empty() && self.removed.is_empty() && !self.reordered", "self.added.is_empty() && self.removed.is_empty()"],
  ["contract", "C8 the names are not quoted in the words", "format!(\"\\\"{name}\\\"\")", "format!(\"{name}\")"],
  ["contract", "C9 added shows the removed names", "parts.push(format!(\"added {}\", quoted(&self.added)));", "parts.push(format!(\"added {}\", quoted(&self.removed)));"],
  ["contract", "C10 the parts are joined with a comma", "parts.join(\"; \")", "parts.join(\", \")"],
  ["contract", "C11 the order is called something else", "parts.push(\"the order changed\".to_owned());", "parts.push(\"reordered\".to_owned());"],
  ["contract", "C12 no change is not said", "if self.is_none() {\n            return write!(f, \"the columns are the same\");", "if false {\n            return write!(f, \"the columns are the same\");"],
  ["contract", "C13 removed shows the added names", "parts.push(format!(\"removed {}\", quoted(&self.removed)));", "parts.push(format!(\"removed {}\", quoted(&self.added)));"],
  ["service", "S1 a missing file is called unreadable", "Err(error) if error.kind() == std::io::ErrorKind::NotFound => {", "Err(error) if false => {"],
  ["service", "S2 a folder passes for a file", ".filter(|_| meta.is_file())", ""],
  ["service", "S3 a file exactly at the limit is refused", "if meta.len() > u64::from(limits.max_bytes) {", "if meta.len() >= u64::from(limits.max_bytes) {"],
  ["service", "S4 the size is not judged before reading", "if meta.len() > u64::from(limits.max_bytes) {", "if false {"],
  ["service", "S5 the refusal does not say the real size", "found: u32::try_from(meta.len()).unwrap_or(u32::MAX),", "found: 0,"],
  ["service", "S6 the read is not allowed one byte over the limit", ".take(u64::from(max_bytes) + 1)", ".take(u64::from(max_bytes))"],
  ["service", "S7 the read is not capped", ".take(u64::from(max_bytes) + 1)", ".take(u64::MAX)"],
  ["service", "S8 the size is not the file's", "bytes: bytes.len() as u64,", "bytes: 0,"],
  ["service", "S9 the hash is of nothing", "Sha256::digest(&bytes)", "Sha256::digest(b\"\")"],
  ["service", "S10 the delimiter is not the one stated", "        delimiter,\n        table,", "        delimiter: Delimiter::Comma,\n        table,"],
  ["service", "S11 a fault of the reader is not a source of the error", "Self::Csv { fault, .. } => Some(fault),", "Self::Csv { .. } => None,"],
  ["service", "S12 the file name is the whole path", "file_name: file_name.to_string_lossy().into_owned(),", "file_name: path.to_string_lossy().into_owned(),"],
  ["service", "S13 an unreadable file is called missing", "Err(error) => return Err(unreadable(error)),", "Err(_) => return Err(CsvSourceError::Missing { path: path.to_path_buf() }),"],
  ["service", "S14 the open error loses its reason", "reason: error.to_string(),", "reason: String::new(),"],
  ["service", "S15 the words of an unreadable file lose the file", "write!(f, \"{} cannot be read: {reason}\", path.display())", "write!(f, \"the file cannot be read: {reason}\")"],
];

let caught = 0;
const survivors = [];
const lines = [];
const failedTests = (log) => [...log.matchAll(/^test ((?:csv_table|csv_source)::tests::\w+) \.\.\. FAILED/gm)].map((m) => m[1].replace(/^csv_\w+::tests::/, "").slice(0, 60));
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
    fs.writeFileSync(files[key], text.replace(find, replace));
    const r = spawnSync("cargo", runs[key], {
      cwd: repo,
      encoding: "utf8",
      shell: true,
      timeout: 900000,
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
    lines.push(`${ok ? "caught  " : "SURVIVED"} ${name}  [${failedTests(log).join(" | ")}]`);
    console.log(lines.at(-1));
  }
} finally {
  for (const [key, file] of Object.entries(files)) fs.writeFileSync(file, original[key]);
}
const restored = Object.entries(files).every(([key, file]) => fs.readFileSync(file, "utf8") === fs.readFileSync(path.join(work, `${key}.orig`), "utf8"));
const summary = JSON.stringify({ mutants: mutants.length, caught, survivors, restoredByteForByte: restored });
fs.writeFileSync(path.join(work, "mutation-log.txt"), `${lines.join("\n")}\n${summary}\n`);
console.log(summary);
