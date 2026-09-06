import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuditLog, sanitiseDetail } from "../dist/index.js";

function lines(file) {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a record never carries a password, a token, or a binary body", () => {
  const detail = sanitiseDetail({
    password: "hunter2",
    accessToken: "gx1.abc.def",
    note: "fine",
    image: Buffer.alloc(4096),
    items: [1, 2, 3],
    meta: { nested: true }
  });
  assert.equal(detail.password, "[redacted]");
  assert.equal(detail.accessToken, "[redacted]");
  assert.equal(detail.note, "fine");
  assert.equal(detail.image, "[binary 4096 bytes]");
  assert.equal(detail.items, "[array 3]");
  assert.equal(detail.meta, "[object]");
});

test("audit and events land in their own sinks with a monotonic sequence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "audit-sink-"));
  const log = new AuditLog({ directory, flushIntervalMs: 20 });
  await log.open();

  log.record({ action: "auth.login", result: "success", userId: "u1", username: "ada", role: "admin", sessionId: "s1" });
  log.record({ action: "playout.cue", result: "success", userId: "u1", username: "ada", role: "admin", sessionId: "s1", sceneId: "sc", revision: 3 });
  log.record({ action: "auth.login-failed", result: "failure", username: "ghost", error: { code: "AUTH", message: "bad" } });
  await log.flush();
  await log.close();

  const audit = lines(join(directory, "audit.jsonl"));
  const events = lines(join(directory, "events.jsonl"));
  assert.deepEqual(audit.map((record) => record.action), ["auth.login", "auth.login-failed"]);
  assert.deepEqual(events.map((record) => record.action), ["playout.cue"]);

  assert.deepEqual(audit.map((record) => record.sequence), [1, 2]);
  assert.equal(events[0].sequence, 1);
  // Each field the schema promises is present and correctly nulled when absent.
  for (const field of ["timestamp", "userId", "username", "role", "sessionId", "deviceName", "ipAddress", "connectionId", "sceneId", "revision"]) {
    assert.ok(field in audit[0], `audit row carries ${field}`);
  }
  assert.equal(events[0].sceneId, "sc");
  assert.equal(events[0].revision, 3);
});

test("sequence numbering survives a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "audit-restart-"));
  const first = new AuditLog({ directory, flushIntervalMs: 20 });
  await first.open();
  first.record({ action: "playout.cue", result: "success" });
  first.record({ action: "playout.cue", result: "success" });
  await first.flush();
  await first.close();

  const second = new AuditLog({ directory, flushIntervalMs: 20 });
  await second.open();
  second.record({ action: "playout.cue", result: "success" });
  await second.flush();
  await second.close();

  const sequences = lines(join(directory, "events.jsonl")).map((record) => record.sequence);
  assert.deepEqual(sequences, [1, 2, 3], "the log must not restart its numbering and claim a gap is a new log");
});

test("rotation by size renames the active file and compresses it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "audit-rotate-"));
  const log = new AuditLog({ directory, maxBytes: 300, flushIntervalMs: 20 });
  await log.open();
  for (let index = 0; index < 30; index += 1) {
    log.record({ action: "playout.cue", result: "success", sceneId: "sc", revision: index, detail: { frame: index } });
  }
  await log.flush();
  log.record({ action: "playout.cue", result: "success" });
  await log.flush();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await log.close();

  const files = readdirSync(directory).sort();
  const archive = files.find((file) => file.includes("events-") && file.endsWith(".gz"));
  assert.ok(archive, `expected a gzipped archive, got ${files.join(", ")}`);
  assert.ok(files.includes("events.jsonl"), "a fresh active file continues after rotation");
});

test("reserved records survive a queue that unreserved traffic has filled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "audit-reserve-"));
  const log = new AuditLog({ directory, flushIntervalMs: 5_000, maxQueued: 4 });
  await log.open();

  const reservation = log.reserve("playout.cue", 2);
  assert.ok(reservation, "a fresh queue can promise two records");
  assert.equal(reservation.remaining, 2);

  // Unreserved traffic now floods the same sink; the reserved room must not be what gives way.
  for (let index = 0; index < 6; index += 1) {
    log.record({ action: "scene.patch", result: "success", revision: index });
  }
  log.record({ action: "playout.cue", result: "success", revision: 900 }, reservation);
  log.record({ action: "playout.cue", result: "success", revision: 901 }, reservation);
  assert.equal(reservation.remaining, 0);
  reservation.release();

  await log.flush();
  await log.close();

  const events = lines(join(directory, "events.jsonl"));
  const cues = events.filter((record) => record.action === "playout.cue");
  assert.deepEqual(cues.map((record) => record.revision), [900, 901], "both reserved records reached the file");
  assert.ok(log.droppedCounts().events > 0, "the unreserved flood is what was dropped, and it is counted");
});

test("a reservation larger than the queue is refused rather than promised", async () => {
  const directory = mkdtempSync(join(tmpdir(), "audit-reserve-refuse-"));
  const warnings = [];
  const log = new AuditLog({ directory, flushIntervalMs: 5_000, maxQueued: 3, onWarning: (message) => warnings.push(message) });
  await log.open();

  assert.equal(log.reserve("playout.cue", 4), null);
  assert.match(warnings[0], /cannot reserve 4 records/);

  // Releasing gives the headroom back, so a refused caller does not shrink the queue for the next.
  const first = log.reserve("playout.cue", 3);
  assert.ok(first);
  assert.equal(log.reserve("playout.cue", 1), null, "the outstanding reservation is counted against the ceiling");
  first.release();
  assert.ok(log.reserve("playout.cue", 1), "released capacity is reusable");

  await log.close();
});
