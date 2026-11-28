// Playout stacks (build plan 12.10 and 12.13, Figma P7): the pure rules behind the Stack field and the Stacks table.
//
// A stack is what the wire calls a Program `layer`: a whole number from -99,999 to +99,999, zero by default, higher in front. This
// module holds what can be decided without a window: reading a typed stack, how a stack is written, which stacks the engine
// reports and what is on each, what a row may be asked to do, and the hold-to-confirm rule for the armed controls. The page (main.js)
// owns the shell calls and `stacks-view.js` owns the DOM, so every rule here is tested in plain Node (`Playout/tests/stacks.test.mjs`).
//
// Two rules the whole file follows:
//  * The engine decides. A row is drawn from what the engine's status says is on a stack; nothing here guesses a state, drops an entry
//    it cannot read, or makes up a stack the engine did not report (invariants 17 and 18). What it cannot read is counted and said.
//  * Zero is sent as no stack at all, so a command for the main stack stays readable by an older receiver (12.10).

/** The stacks the wire allows. Out of this range the transport refuses by name; the page says so before it sends. */
export const STACK_MIN = -99_999;
export const STACK_MAX = 99_999;

/** How long an armed control is held before it sends (the owner's design: "Cue out hold 1 s"). */
export const HOLD_MS = 1000;

const WHOLE = /^[+-]?[0-9]{1,6}$/;

/** @typedef {"empty" | "notWhole" | "outOfRange"} StackFault */

/** Read a typed stack. Blank, a fraction, an exponent, a letter and a number out of range are each a named fault.
 *  @param {unknown} input
 *  @returns {{ ok: true, stack: number } | { ok: false, reason: StackFault }} */
export function parseStack(input) {
  const text = String(input ?? "").trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (!WHOLE.test(text)) return { ok: false, reason: "notWhole" };
  const stack = Number(text);
  if (stack < STACK_MIN || stack > STACK_MAX) return { ok: false, reason: "outOfRange" };
  // "-0" is zero: the field then reads back as "0", never as a stack called minus nought.
  return { ok: true, stack: stack === 0 ? 0 : stack };
}

const FAULTS = {
  empty: "Enter a stack, a whole number from -99,999 to +99,999. Blank is not stack 0.",
  notWhole: "A stack is a whole number, such as 0, +60 or -10.",
  outOfRange: "A stack runs from -99,999 to +99,999.",
};

/** The sentence an operator reads for a stack that was not accepted. */
export function describeStackFault(reason) {
  return FAULTS[reason] ?? "That stack is not accepted.";
}

/** How a stack is written: a sign on every number but zero, so +60 and -10 read as in front and behind. ASCII, so it parses back. */
export function formatStack(stack) {
  return stack > 0 ? `+${stack}` : String(stack === 0 ? 0 : stack);
}

/** One step of the plus and minus controls. The ends are held, not wrapped: the field shows the end the operator reached. */
export function stepStack(stack, delta) {
  return Math.min(STACK_MAX, Math.max(STACK_MIN, stack + delta));
}

/** The shell arguments that name a stack. Zero adds nothing (see the top of this file). */
export function stackArgs(stack) {
  return stack === 0 ? {} : { layer: stack };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What is on each stack.
// ---------------------------------------------------------------------------------------------------------------------------------

/** A newtype may arrive as `"id"` or `{ "0": "id" }`. */
function unwrap(value) {
  return value !== null && typeof value === "object" && "0" in value ? value["0"] : value;
}

/** @typedef {{ takeId: unknown, revision: unknown, state: string, frame: unknown }} StackScene */
/** @typedef {{ stack: number, label: string, current: StackScene | null, queued: StackScene | null, selected: boolean,
 *             reported: boolean, doubled: boolean }} StackRow */

/** The words of a state. A state this build does not know is shown as the engine spelled it, never as a known one. */
export const STATE_TEXT = Object.freeze({ onAir: "ON AIR", leaving: "LEAVING", queued: "QUEUED" });

/** @param {string} state */
export function stateText(state) {
  return STATE_TEXT[state] ?? String(state).toUpperCase();
}

/** The Program entries the engine reported, as one list: its `layers`, or, from an engine that sends none, the scene on stack zero
 *  (and nothing when none is on air: a status that says nothing is on air is still a status). `none` means no status has arrived.
 *  @returns {{ entries: Array<{ stack: unknown, scene: StackScene }>, source: "layers" | "program" | "none" }} */
function entriesOf(status) {
  if (status === null || status === undefined || typeof status !== "object") return { source: "none", entries: [] };
  if (Array.isArray(status.layers)) {
    return {
      source: "layers",
      entries: status.layers.map((item) => ({
        stack: item?.layer,
        scene: { takeId: item?.takeId, revision: item?.revision, state: String(item?.state ?? ""), frame: item?.frame },
      })),
    };
  }
  const program = status.program;
  return {
    source: "program",
    entries: program
      ? [{ stack: 0, scene: { takeId: program.takeId, revision: program.revision, state: "onAir", frame: program.committedFrame } }]
      : [],
  };
}

/** The Stacks table: the stacks the engine reports, front to back, and what is on each.
 *
 *  A stack holds at most one scene and one queued replacement behind it. An entry the table cannot place (not a whole number in
 *  range, or a second scene on a stack) is counted in `unreadable`, or marks the row `doubled`, so it is said, not dropped. The
 *  selected stack is added as an empty row when the engine does not report it, with `reported: false`, so the field and the table
 *  always agree on which stack the next command goes to.
 *  @param {unknown} status the engine status as the shell returns it
 *  @param {number} selected the stack in the Stack field
 *  @returns {{ rows: StackRow[], unreadable: number, source: "layers" | "program" | "none" }} */
export function stackRows(status, selected) {
  const { entries, source } = entriesOf(status);
  /** @type {Map<number, StackRow>} */
  const byStack = new Map();
  let unreadable = 0;
  const rowFor = (stack, reported) => {
    let row = byStack.get(stack);
    if (row === undefined) {
      row = { stack, label: formatStack(stack), current: null, queued: null, selected: stack === selected, reported, doubled: false };
      byStack.set(stack, row);
    }
    return row;
  };
  for (const { stack, scene } of entries) {
    if (!Number.isInteger(stack) || stack < STACK_MIN || stack > STACK_MAX) {
      unreadable += 1;
      continue;
    }
    const row = rowFor(stack, true);
    if (scene.state === "queued") {
      if (row.queued !== null) row.doubled = true;
      else row.queued = scene;
    } else if (row.current !== null) {
      row.doubled = true;
    } else {
      row.current = scene;
    }
  }
  if (!byStack.has(selected)) rowFor(selected, false);
  const rows = [...byStack.values()].sort((a, b) => b.stack - a.stack);
  return { rows, unreadable, source };
}

/** The page a row names when it asks for a targeted clear: the scene the operator is looking at on that stack, exactly as the engine
 *  reported it. Null when the row shows no scene to name.
 *  @param {StackRow} row */
export function pageOf(row) {
  if (row.current === null) return null;
  return { takeId: unwrap(row.current.takeId), revision: unwrap(row.current.revision) };
}

/** What a row's controls may do, from what the row shows. A scene that is leaving is already playing its Out, so only Clear applies;
 *  a stack with only a queued scene, or none, has nothing to continue, cue out or clear.
 *  @param {StackRow} row
 *  @returns {{ continue: boolean, cueOut: boolean, clear: boolean }} */
export function rowControls(row) {
  const current = row.current?.state;
  return { continue: current === "onAir", cueOut: current === "onAir", clear: current === "onAir" || current === "leaving" };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The armed controls: hold for one second.
// ---------------------------------------------------------------------------------------------------------------------------------

/** @typedef {"idle" | "holding" | "fired"} HoldState */

/** The hold-to-confirm rule, with its clock injected so it can be tested. `press` starts a hold; `release` or `cancel` before the time
 *  is up sends nothing; when the time is up `onFire` runs exactly once, and nothing fires again until the control has been released
 *  (so a key held down, which repeats, sends one command).
 *  @param {{ ms?: number, schedule?: (fn: () => void, ms: number) => unknown, unschedule?: (handle: unknown) => void,
 *            onFire: () => void, onChange?: (state: HoldState) => void }} options */
export function createHold(options) {
  const ms = options.ms ?? HOLD_MS;
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
  const unschedule = options.unschedule ?? ((handle) => clearTimeout(handle));
  /** @type {HoldState} */
  let state = "idle";
  /** @type {unknown} */
  let handle = null;
  const set = (next) => {
    if (state === next) return;
    state = next;
    options.onChange?.(state);
  };
  return {
    get state() {
      return state;
    },
    press() {
      if (state !== "idle") return false;
      set("holding");
      handle = schedule(() => {
        handle = null;
        set("fired");
        options.onFire();
      }, ms);
      return true;
    },
    release() {
      if (handle !== null) {
        unschedule(handle);
        handle = null;
      }
      set("idle");
    },
  };
}
