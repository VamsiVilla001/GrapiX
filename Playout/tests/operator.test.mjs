// 2.15: the page's check of an operator's name agrees with the shared fixture that the Rust
// parser is tested against, and says each fault in words.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describeNameFault, parseOperatorName } from "../web/operator.js";

const fixture = JSON.parse(readFileSync(new URL("../../Shared/contracts/fixtures/operator-names.json", import.meta.url), "utf8"));

test("every case in the shared fixture parses as the fixture says", () => {
  assert.ok(fixture.cases.length >= 15);
  for (const entry of fixture.cases) {
    const result = parseOperatorName(entry.input);
    if (entry.name !== undefined) assert.deepEqual(result, { ok: true, name: entry.name }, JSON.stringify(entry.input));
    else assert.deepEqual(result, { ok: false, reason: entry.reason }, JSON.stringify(entry.input));
  }
});

test("each fault has a sentence an operator can act on, and an unknown one is still worded", () => {
  for (const reason of ["empty", "tooLong", "badCharacter", "badStart", "doubleSpace"]) {
    assert.match(describeNameFault(reason), /\w/);
  }
  assert.equal(describeNameFault("empty"), "Enter your name to sign in.");
  assert.equal(describeNameFault("nope"), "That name is not accepted.");
});

test("the name is trimmed but otherwise kept exactly", () => {
  assert.deepEqual(parseOperatorName("  Ada Lovelace "), { ok: true, name: "Ada Lovelace" });
  assert.deepEqual(parseOperatorName("ADA"), { ok: true, name: "ADA" });
});
