// Row 1.14: one number, one decision. The ADR files are numbered once; a plan row that cites ADR-0004 means debugging and broadcast
// logging (and its as-run record), never the Data Server, whose ADR is 0005 once it is written.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plan = readFileSync(join(root, "GrapiX-Build-Plan.md"), "utf8");
const rows = plan.split("\n").filter((line) => /^\| `[0-9.]+` \|/.test(line));
const files = readdirSync(join(root, "docs", "adr")).filter((name) => /^\d{4}-.*\.md$/.test(name));

test("each ADR number is used by one file", () => {
  const numbers = files.map((name) => name.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, `two ADR files share a number: ${files.join(", ")}`);
});

test("ADR-0004 is the logging ADR the file says it is", () => {
  const file = files.find((name) => name.startsWith("0004-"));
  assert.ok(file, "docs/adr/0004-*.md exists");
  assert.match(file, /logging/);
});

test("no plan row cites ADR-0004 for the Data Server", () => {
  const wrong = rows.filter((row) => /ADR-?0004/.test(row) && /data server/i.test(row.split("|").slice(1, 4).join("|")));
  assert.deepEqual(wrong.map((row) => row.slice(0, 60)), [], "the Data Server ADR is 0005");
});

test("the Data Server ADR is numbered 0005 in the plan and in the docs README", () => {
  const row = rows.find((line) => line.startsWith("| `19.1` |"));
  assert.ok(row, "row 19.1 exists");
  assert.match(row, /ADR-0005: Data Server boundaries/);
  const readme = readFileSync(join(root, "docs", "README.md"), "utf8");
  assert.match(readme, /Data Server ADR planned by step `19\.1`\s+is \*\*`0005`\*\*/);
});

test("12.11 cites ADR-0004 for the as-run record, which the ADR holds as its section 5", () => {
  const adr = readFileSync(join(root, "docs", "adr", files.find((name) => name.startsWith("0004-"))), "utf8");
  assert.match(adr, /as-run/i);
  const row = rows.find((line) => line.startsWith("| `12.11` |"));
  assert.ok(row && /ADR-0004/.test(row));
});
