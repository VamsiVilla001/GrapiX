// Build plan 12.10 and 12.13 (Figma P7): the rules behind Playout's Stack field and Stacks table, in plain Node.
// The DOM that draws them (web/screens/stacks-view.js) is exercised in the running window; what can be decided without one is here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { oldWordsIn } from "../../Shared/web-panels/terms.js";
import {
  HOLD_MS,
  STACK_MAX,
  STACK_MIN,
  createHold,
  describeStackFault,
  formatStack,
  pageOf,
  parseStack,
  rowControls,
  stackArgs,
  stackRows,
  stateText,
  stepStack,
} from "../web/screens/stacks.js";

// ---- reading and writing a stack -----------------------------------------------------------------------------------------------

test("a typed stack is a whole number from -99,999 to +99,999, with or without a sign", () => {
  for (const [text, stack] of [["0", 0], ["+60", 60], ["-10", -10], ["  7 ", 7], ["99999", 99_999], ["-99999", -99_999], ["+0", 0], ["007", 7]]) {
    assert.deepEqual(parseStack(text), { ok: true, stack }, JSON.stringify(text));
  }
  assert.equal(STACK_MIN, -99_999);
  assert.equal(STACK_MAX, 99_999);
});

test("minus nought is zero, so the field never reads back a stack called -0", () => {
  const parsed = parseStack("-0");
  assert.deepEqual(parsed, { ok: true, stack: 0 });
  assert.ok(Object.is(parsed.stack, 0), "not negative zero");
  assert.equal(formatStack(parseStack("-0").stack), "0");
});

test("each way a stack can be wrong is a named fault, and blank is not stack zero", () => {
  const cases = [
    ["", "empty"], ["   ", "empty"], [undefined, "empty"], [null, "empty"],
    ["1.5", "notWhole"], ["1e3", "notWhole"], ["abc", "notWhole"], ["+", "notWhole"], ["--1", "notWhole"], ["1,000", "notWhole"],
    ["٣", "notWhole"], ["+-1", "notWhole"], ["0x10", "notWhole"],
    ["100000", "outOfRange"], ["-100000", "outOfRange"], ["999999", "outOfRange"],
    ["1000000", "notWhole"], // seven digits is past anything the field means; it is refused as not a stack, not read
  ];
  for (const [text, reason] of cases) assert.deepEqual(parseStack(text), { ok: false, reason }, JSON.stringify(text));
});

test("every fault has a sentence an operator can act on, and an unknown one is still worded", () => {
  for (const reason of ["empty", "notWhole", "outOfRange"]) assert.match(describeStackFault(reason), /\w/);
  assert.match(describeStackFault("empty"), /Blank is not stack 0/);
  assert.match(describeStackFault("outOfRange"), /-99,999 to \+99,999/);
  assert.equal(describeStackFault("nope"), "That stack is not accepted.");
});

test("a stack is written with a sign except zero, and what is written parses back to the same stack", () => {
  assert.equal(formatStack(60), "+60");
  assert.equal(formatStack(-10), "-10");
  assert.equal(formatStack(0), "0");
  for (const stack of [STACK_MIN, -50, -1, 0, 1, 20, 60, STACK_MAX]) assert.deepEqual(parseStack(formatStack(stack)), { ok: true, stack });
});

test("plus and minus step by the amount given and stop at the ends instead of wrapping", () => {
  assert.equal(stepStack(0, 1), 1);
  assert.equal(stepStack(0, -1), -1);
  assert.equal(stepStack(STACK_MAX, 1), STACK_MAX);
  assert.equal(stepStack(STACK_MIN, -1), STACK_MIN);
  assert.equal(stepStack(99_998, 5), STACK_MAX);
});

test("stack zero is sent as no stack at all, so the main stack stays readable by an older receiver", () => {
  assert.deepEqual(stackArgs(0), {});
  assert.deepEqual(stackArgs(60), { layer: 60 });
  assert.deepEqual(stackArgs(-10), { layer: -10 });
});

// ---- what is on each stack -----------------------------------------------------------------------------------------------------

const scene = (layer, takeId, state, frame, revision = 1) => ({ layer, takeId, revision, state, frame });

test("the table lists the stacks the engine reports, front to back, with what is on each", () => {
  const status = { layers: [scene(-50, "bumper", "onAir", 10), scene(0, "l3", "onAir", 612), scene(60, "scorebug", "onAir", 700)] };
  const { rows, unreadable, source } = stackRows(status, 0);
  assert.equal(source, "layers");
  assert.equal(unreadable, 0);
  assert.deepEqual(rows.map((row) => row.label), ["+60", "0", "-50"]);
  assert.deepEqual(rows.map((row) => row.current.takeId), ["scorebug", "l3", "bumper"]);
  assert.deepEqual(rows.map((row) => row.selected), [false, true, false]);
  assert.ok(rows.every((row) => row.reported && row.queued === null && !row.doubled));
});

test("a scene that is leaving with a replacement queued behind it is one row: the scene, and then the replacement", () => {
  const status = { layers: [scene(60, "old", "leaving", 100), scene(60, "new", "queued", 130)] };
  const { rows } = stackRows(status, 60);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].current.takeId, "old");
  assert.equal(rows[0].current.state, "leaving");
  assert.equal(rows[0].queued.takeId, "new");
  assert.equal(rows[0].queued.frame, 130);
  assert.equal(rows[0].doubled, false);
});

test("the stack in the field is added as an empty row when the engine does not report it, and is marked as not reported", () => {
  const { rows } = stackRows({ layers: [scene(0, "l3", "onAir", 1)] }, 20);
  assert.deepEqual(rows.map((row) => [row.label, row.reported, row.current]), [["+20", false, null], ["0", true, rows[1].current]]);
  assert.equal(rows[0].selected, true);
  assert.equal(rows[1].selected, false);
});

test("an engine that reports no list is read as the scene on stack zero from `program`, and says so", () => {
  const status = { program: { takeId: "l3", revision: 4, committedFrame: 612, sceneFrame: 0, playing: true } };
  const { rows, source } = stackRows(status, 0);
  assert.equal(source, "program");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].current, { takeId: "l3", revision: 4, state: "onAir", frame: 612 });
});

test("an engine that reports an empty list and no program has nothing on air, and a missing status has no source", () => {
  assert.deepEqual(stackRows({ layers: [], program: null }, 0).rows.map((row) => [row.label, row.current, row.reported]), [["0", null, false]]);
  assert.equal(stackRows({ layers: [] }, 0).source, "layers");
  assert.equal(stackRows(null, 0).source, "none");
  assert.equal(stackRows(undefined, 5).rows[0].label, "+5");
  assert.equal(stackRows("not a status", 0).source, "none");
});

test("a status with no list and nothing on air is a status: it is read from `program`, not reported as no status", () => {
  // The mock engine at rest: it sends no `layers` and `program` is null. Seen in the real Playout window (docs/evidence/12.13).
  for (const status of [{ program: null }, { program: undefined }, {}]) {
    const { rows, source, unreadable } = stackRows(status, 0);
    assert.equal(source, "program", JSON.stringify(status));
    assert.equal(unreadable, 0);
    assert.deepEqual(rows.map((row) => [row.label, row.current, row.reported]), [["0", null, false]]);
  }
});

test("what cannot be placed is counted or marked, never dropped: a stack out of range, a fraction, two scenes on one stack", () => {
  const status = {
    layers: [
      scene(0, "a", "onAir", 1),
      scene(100_000, "far", "onAir", 1), // out of range
      scene(1.5, "half", "onAir", 1), // not a whole number
      scene("12", "text", "onAir", 1), // not a number
      scene(0, "b", "onAir", 2), // a second scene on stack 0
      scene(5, "q1", "queued", 3),
      scene(5, "q2", "queued", 4), // a second queued scene on stack 5
    ],
  };
  const { rows, unreadable } = stackRows(status, 0);
  assert.equal(unreadable, 3);
  const zero = rows.find((row) => row.stack === 0);
  assert.equal(zero.doubled, true);
  assert.equal(zero.current.takeId, "a", "the first scene is kept, the doubling is said");
  const five = rows.find((row) => row.stack === 5);
  assert.equal(five.doubled, true);
  assert.equal(five.current, null);
});

test("a state this build does not know is drawn as the engine spelled it, never as a known one", () => {
  assert.equal(stateText("onAir"), "ON AIR");
  assert.equal(stateText("leaving"), "LEAVING");
  assert.equal(stateText("queued"), "QUEUED");
  assert.equal(stateText("holding"), "HOLDING");
  const { rows } = stackRows({ layers: [scene(0, "x", "holding", 1)] }, 0);
  assert.equal(rows[0].current.state, "holding");
  assert.deepEqual(rowControls(rows[0]), { continue: false, cueOut: false, clear: false }, "an unknown state offers no control");
});

test("a row offers what its scene can take: on air has all three, leaving only Clear, queued or empty none", () => {
  const row = (current, queued = null) => ({ stack: 0, label: "0", current, queued, selected: false, reported: true, doubled: false });
  const on = { takeId: "a", revision: 1, state: "onAir", frame: 1 };
  assert.deepEqual(rowControls(row(on)), { continue: true, cueOut: true, clear: true });
  assert.deepEqual(rowControls(row({ ...on, state: "leaving" }, { ...on, state: "queued" })), { continue: false, cueOut: false, clear: true });
  assert.deepEqual(rowControls(row(null, { ...on, state: "queued" })), { continue: false, cueOut: false, clear: false });
  assert.deepEqual(rowControls(row(null)), { continue: false, cueOut: false, clear: false });
});

test("the page a Clear names is the scene the row shows, as the engine reported it; an empty row names none", () => {
  const { rows } = stackRows({ layers: [scene(60, "scorebug", "onAir", 1, 7), scene(60, "next", "queued", 9, 2)] }, 60);
  assert.deepEqual(pageOf(rows[0]), { takeId: "scorebug", revision: 7 });
  assert.equal(pageOf(stackRows(null, 3).rows[0]), null);
  // a newtype that arrives as { "0": "id" } is unwrapped
  const wrapped = stackRows({ layers: [{ layer: 0, takeId: { 0: "l3" }, revision: { 0: 4 }, state: "onAir", frame: 1 }] }, 0).rows[0];
  assert.deepEqual(pageOf(wrapped), { takeId: "l3", revision: 4 });
});

// ---- the armed controls --------------------------------------------------------------------------------------------------------

/** A clock the test moves by hand. */
function clock() {
  let next = 1;
  const timers = new Map();
  return {
    schedule: (fn, ms) => {
      const handle = next++;
      timers.set(handle, { fn, ms });
      return handle;
    },
    unschedule: (handle) => timers.delete(handle),
    pending: () => [...timers.values()],
    fireAll: () => {
      for (const [handle, timer] of [...timers]) {
        timers.delete(handle);
        timer.fn();
      }
    },
  };
}

test("a hold sends nothing until the time is up, and sends exactly once when it is", () => {
  const time = clock();
  const sent = [];
  const states = [];
  const hold = createHold({ schedule: time.schedule, unschedule: time.unschedule, onFire: () => sent.push("sent"), onChange: (s) => states.push(s) });
  assert.equal(HOLD_MS, 1000, "the owner's design: hold 1 s");
  assert.equal(hold.press(), true);
  assert.equal(hold.state, "holding");
  assert.equal(time.pending()[0].ms, HOLD_MS);
  assert.deepEqual(sent, []);
  time.fireAll();
  assert.deepEqual(sent, ["sent"]);
  assert.equal(hold.state, "fired");
  assert.deepEqual(states, ["holding", "fired"]);
});

test("a release before the time is up sends nothing and the control is ready again", () => {
  const time = clock();
  const sent = [];
  const hold = createHold({ schedule: time.schedule, unschedule: time.unschedule, onFire: () => sent.push("sent") });
  hold.press();
  hold.release();
  time.fireAll();
  assert.deepEqual(sent, []);
  assert.equal(hold.state, "idle");
  assert.equal(time.pending().length, 0, "the timer was cancelled, not left to fire");
  assert.equal(hold.press(), true);
});

test("a key held down repeats, and one hold still sends one command until the control has been released", () => {
  const time = clock();
  const sent = [];
  const hold = createHold({ schedule: time.schedule, unschedule: time.unschedule, onFire: () => sent.push(1) });
  assert.equal(hold.press(), true);
  assert.equal(hold.press(), false, "a repeat while holding does not start a second hold");
  time.fireAll();
  assert.equal(hold.press(), false, "a repeat after it fired does not start another");
  assert.deepEqual(sent, [1]);
  hold.release();
  assert.equal(hold.press(), true, "released, so it can be held again");
  time.fireAll();
  assert.deepEqual(sent, [1, 1]);
});

test("a hold uses the real clock when none is given, and a release cancels it", async () => {
  let fired = 0;
  const hold = createHold({ ms: 15, onFire: () => (fired += 1) });
  hold.press();
  hold.release();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fired, 0);
  hold.press();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1);
});

// ---- the words ------------------------------------------------------------------------------------------------------------------

test("the new files show none of the old product names: a stack is a Stack, never a layer, and a take is a cue", () => {
  for (const file of ["../web/screens/stacks.js", "../web/screens/stacks-view.js"]) {
    const found = oldWordsIn(readFileSync(new URL(file, import.meta.url), "utf8"), "playout");
    assert.deepEqual(found, [], file);
  }
});
