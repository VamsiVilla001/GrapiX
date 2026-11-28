// Mutation check of task 121 slice 1 (the strict CSV table reader), claude-grapix-f1, 25 Nov 2026. Mutates my own NEW source file in place
// (backup + restore, verified byte for byte). Every mutant must make the tests fail. Runs under LOCK gate on a private target dir.
// Usage: node mutate-csv-table.mjs <backup-and-log-dir> [M3,M4,...]   (the second argument runs only those mutants)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const file = path.join(repo, "Shared/contracts/src/csv_table.rs");
const work = path.resolve(process.argv[2] ?? "mut-dt");
const only = process.argv[3]?.split(",");
fs.mkdirSync(path.join(work, "logs"), { recursive: true });
const original = fs.readFileSync(file, "utf8");
fs.writeFileSync(path.join(work, "csv_table.rs.orig"), original);

const mutants = [
  ["M1 the byte order mark is not removed", "bytes.strip_prefix(&UTF8_BYTE_ORDER_MARK).unwrap_or(bytes)", "bytes"],
  ["M2 the byte order mark is not counted in the offset of a bad byte", "size(skipped + error.valid_up_to())", "size(error.valid_up_to())"],
  ["M3 a UTF-16 little endian mark is not recognised", "if bytes.starts_with(&[0xFF, 0xFE]) {", "if false {"],
  ["M4 a UTF-16 big endian mark is not recognised", "if bytes.starts_with(&[0xFE, 0xFF]) {", "if false {"],
  ["M5 UTF-16 little endian without a mark is not recognised", "if odd * 3 >= sample.len() && odd > even {", "if false {"],
  ["M6 UTF-16 big endian without a mark is not recognised", "if even * 3 >= sample.len() && even > odd {", "if false {"],
  ["M7 little endian is reported as big endian", "return Some((LooksLike::Utf16LittleEndian, first_zero));", "return Some((LooksLike::Utf16BigEndian, first_zero));"],
  ["M8 the offset of UTF-16 without a mark is 0", "return Some((LooksLike::Utf16LittleEndian, first_zero));", "return Some((LooksLike::Utf16LittleEndian, 0));"],
  ["M9 a quoted empty cell is a blank line", "!self.fields.is_empty() || !self.field.is_empty() || self.field_started", "!self.fields.is_empty() || !self.field.is_empty()"],
  ["M10 a blank line in the middle is dropped", "self.pending_blank.get_or_insert(record.start_line);", "let _ = record.start_line;"],
  ["M11 the last blank line is named, not the first", "self.pending_blank.get_or_insert(record.start_line);", "self.pending_blank = Some(record.start_line);"],
  ["M12 a ragged row is accepted", "if fields.len() != self.columns.len() {", "if false {"],
  ["M13 only a short ragged row is refused", "if fields.len() != self.columns.len() {", "if fields.len() < self.columns.len() {"],
  ["M14 a row over the row limit is accepted at one above", "if self.rows.len() >= self.limits.max_rows as usize {", "if self.rows.len() > self.limits.max_rows as usize {"],
  ["M15 the row refusal names the limit, not one above", "found: self.limits.max_rows.saturating_add(1),", "found: self.limits.max_rows,"],
  ["M16 a column name of spaces is accepted", "if name.trim().is_empty() {", "if name.is_empty() {"],
  ["M17 an empty column name is accepted", "if name.trim().is_empty() {", "if false {"],
  ["M18 a repeated column name is accepted", "if let Some(first) = seen.insert(name.as_str(), index) {", "if let Some(first) = seen.insert(name.as_str(), index).filter(|_| false) {"],
  ["M19 the first column of a repeat is off by one", "first_column: size(first + 1),", "first_column: size(first),"],
  ["M20 the second column of a repeat is off by one", "column: size(index + 1),\n                });\n            }\n        }", "column: size(index),\n                });\n            }\n        }"],
  ["M21 the wrong-delimiter hint is never given", "if fields.len() == 1 {", "if false {"],
  ["M22 a plain one-column header is taken for the wrong delimiter", "if count > 0 && best != self.delimiter {", "if best != self.delimiter {"],
  ["M23 the other delimiters in the header are not counted", "self.header_others[other.index()] += 1;", "{}"],
  ["M24 text after a closing quote is accepted", "if record.after_quote {", "if false {"],
  ["M25 a quote inside a cell is accepted", "if record.field_started {\n                    return Err(CsvFault::StrayQuote {", "if false {\n                    return Err(CsvFault::StrayQuote {"],
  ["M26 a doubled quote is not one quote", "'\"' if chars.peek() == Some(&'\"') => {", "'\"' if false => {"],
  ["M27 a CR LF inside a quote does not move the line", "                        }\n                        self.line += 1;\n                    }\n                    '\\n' => {", "                        }\n                    }\n                    '\\n' => {"],
  ["M28 an LF inside a quote does not move the line", "                        self.push(&mut record, '\\n')?;\n                        self.line += 1;\n                    }\n                    other", "                        self.push(&mut record, '\\n')?;\n                    }\n                    other"],
  ["M29 CR LF outside a quote is two line ends", "if c == '\\r' && chars.peek() == Some(&'\\n') {", "if false {"],
  ["M30 a line end does not move the line", "self.end_record(finished)?;\n                self.line += 1;", "self.end_record(finished)?;"],
  ["M31 a record starts on line 1 whatever the line", "                self.line += 1;\n                record = Record::new(self.line);", "                self.line += 1;\n                record = Record::new(1);"],
  ["M32 the delimiter is always a comma", "if c == delimiter {", "if c == ',' {"],
  ["M33 an unterminated quote names the end of the file", "line: record.quote_line,", "line: self.line,"],
  ["M34 the line of a quote that opens is not kept", "record.quote_line = self.line;", ""],
  ["M35 a last record with no line end is lost", "if record.has_any() {\n            self.end_record(record)?;", "if false {\n            self.end_record(record)?;"],
  ["M36 an empty file is an empty table", "if !self.header_done {\n            return Err(CsvFault::Empty);", "if false {\n            return Err(CsvFault::Empty);"],
  ["M37 the column limit is one too many", "record.fields.len() > self.limits.max_columns as usize", "record.fields.len() >= self.limits.max_columns as usize"],
  ["M38 the column limit also refuses a ragged row", "if !self.header_done && record.fields.len()", "if record.fields.len()"],
  ["M39 the cell limit is one too few", "record.field.len() > self.limits.max_cell_bytes as usize", "record.field.len() >= self.limits.max_cell_bytes as usize"],
  ["M40 the cell limit counts characters, not bytes", "record.field.len() > self.limits.max_cell_bytes as usize", "record.field.chars().count() > self.limits.max_cell_bytes as usize"],
  ["M41 the file limit is one too few", "if bytes.len() > limits.max_bytes as usize {", "if bytes.len() >= limits.max_bytes as usize {"],
  ["M42 the default row limit is one less", "max_rows: 100_000,", "max_rows: 99_999,"],
  ["M43 the default file limit is one byte less", "max_bytes: 16 * 1024 * 1024,", "max_bytes: 16 * 1024 * 1024 - 1,"],
  ["M44 the semicolon is a comma", "Delimiter::Semicolon => ';',", "Delimiter::Semicolon => ',',"],
  ["M45 the tab is a space", "Delimiter::Tab => '\\t',", "Delimiter::Tab => ' ',"],
  ["M46 the stray quote names the wrong cell", "column: size(record.fields.len() + 1),", "column: size(record.fields.len()),"],
  ["M47 a quoted cell leaves the next one in a quote state", "record.field_started = false;\n        record.after_quote = false;", "record.after_quote = false;"],
  ["M48 a closing quote is not forgotten at the delimiter", "record.field_started = false;\n        record.after_quote = false;", "record.field_started = false;"],
  ["M49 a fault is tagged under another name", "tag = \"fault\",", "tag = \"kind\","],
  ["M50 the ragged-row words swap found and expected", "\"line {line} has {found} cells and the header has {expected}\"", "\"line {line} has {expected} cells and the header has {found}\""],
  ["M51 the blank-line words lose the remedy", "or write an empty cell as \\\"\\\"\"", "or fix it\""],
  ["M52 the refusal no longer says nothing was read", "; nothing was read", ""],
  ["M53 the file-size words are unrelated", "Limit::FileBytes => \"the file size in bytes\"", "Limit::FileBytes => \"the thing\""],
  ["M54 the cell text is trimmed", "fields.push(std::mem::take(&mut record.field));", "fields.push(std::mem::take(&mut record.field).trim().to_owned());"],
  ["M55 a header name is trimmed", "self.columns = fields;", "self.columns = fields.into_iter().map(|name| name.trim().to_owned()).collect();"],
];

let caught = 0;
const survivors = [];
const lines = [];
const failedTests = (log) => [...log.matchAll(/^test (csv_table::tests::\w+) \.\.\. FAILED/gm)].map((m) => m[1].replace("csv_table::tests::", "").slice(0, 60));
try {
  for (const [name, find, replace] of mutants) {
    if (only && !only.includes(name.split(" ")[0])) continue;
    if (!original.includes(find)) {
      lines.push(`NOT FOUND: ${name}`);
      survivors.push(`${name} (pattern not found)`);
      console.log(lines.at(-1));
      continue;
    }
    fs.writeFileSync(file, original.replace(find, replace));
    const r = spawnSync("cargo", ["test", "--locked", "-p", "gx-contracts", "--lib", "csv_table"], {
      cwd: repo,
      encoding: "utf8",
      shell: true,
      timeout: 900000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CARGO_TARGET_DIR: "D:/Project KK/cargo-target-f1" },
    });
    fs.writeFileSync(file, original);
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
  fs.writeFileSync(file, original);
}
const restored = fs.readFileSync(file, "utf8") === fs.readFileSync(path.join(work, "csv_table.rs.orig"), "utf8");
fs.writeFileSync(path.join(work, "mutation-log.txt"), `${lines.join("\n")}\n${JSON.stringify({ mutants: mutants.length, caught, survivors, restoredByteForByte: restored })}\n`);
console.log(JSON.stringify({ mutants: mutants.length, caught, survivors, restoredByteForByte: restored }));
