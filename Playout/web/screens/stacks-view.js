// The Stacks table (Figma P7, build plan 12.10 and 12.13): what is on each stack, front to back, and the controls of each stack.
//
// The rules are in `stacks.js` and are tested there. This file only draws them and passes the operator's intent to the page, which owns
// every shell call. Two things here are deliberate:
//
//  * Rows are updated in place, never rebuilt. The status is read every half second; a row that was replaced under the operator's
//    finger would end a hold that was nearly done. A row is added or removed only when its stack appears or goes, and a hold on a row
//    that goes is cancelled.
//  * An armed control (Cue out, Clear) sends nothing until it has been held for one second. The page a Clear names is the one the row
//    showed when the hold began, so if the stack changes during the hold the engine refuses by name and nothing is cleared.

import { term } from "../terms.js";
import { HOLD_MS, createHold, formatStack, pageOf, rowControls, stackRows, stateText } from "./stacks.js";

const EM_DASH = "—";
const HOLD_SECONDS = `${HOLD_MS / 1000} s`;

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const unwrap = (value) => (value !== null && typeof value === "object" && "0" in value ? value["0"] : value);
const count = (value) => {
  const v = unwrap(value);
  return typeof v === "bigint" || typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? String(v) : EM_DASH;
};

/** The chip variant (the page's own `chip--*` classes) for a state the engine reported. */
function chipFor(state) {
  if (state === "onAir") return "live";
  if (state === "leaving" || state === "queued") return "warning";
  return "critical"; // a state this build does not know is never drawn as a quiet one
}

/** @param {HTMLElement} root the element the table is drawn into
 *  @param {{ onSelect(stack: number): void,
 *            onContinue(stack: number): void,
 *            onCueOut(stack: number): void,
 *            onClear(stack: number, page: { takeId: unknown, revision: unknown }): void }} handlers */
export function createStacksView(root, handlers) {
  // The fill of an armed control runs as long as the hold does; one number, set here, so the two cannot disagree.
  root.style.setProperty("--hold-ms", `${HOLD_MS}ms`);
  const table = el("table", "stacks");
  table.setAttribute("aria-label", `${term("stack")}s, front to back`);
  const head = el("thead");
  const headRow = el("tr");
  for (const [text, cls] of [
    [term("stack").toUpperCase(), "stacks__col-stack"],
    ["ON THIS STACK", "stacks__col-scene"],
    ["STATE", "stacks__col-state"],
    ["CONTROL THIS STACK", "stacks__col-control"],
  ]) {
    const th = el("th", cls, text);
    th.scope = "col";
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  const body = el("tbody");
  table.append(head, body);
  const note = el("p", "stacks__note");
  note.hidden = true;
  root.replaceChildren(table, note);

  /** @type {Map<number, ReturnType<typeof makeRow>>} */
  const rows = new Map();
  let usable = false;

  /** A control that is held to send. `begin` runs when a hold really starts and returns what the hold will send; `fire` runs once when
   *  the time is up, with that. A release before the time sends nothing.
   *  @template T @param {string} label @param {string} className @param {string} title
   *  @param {() => T} begin @param {(context: T) => void} fire */
  function armedButton(label, className, title, begin, fire) {
    const button = el("button", `btn btn--armed ${className}`);
    button.type = "button";
    button.title = title;
    const text = el("span", "btn__text", label);
    const fill = el("span", "btn__fill");
    fill.setAttribute("aria-hidden", "true");
    button.append(fill, text);
    /** @type {T | undefined} */
    let context;
    const hold = createHold({
      onFire: () => fire(/** @type {T} */ (context)),
      onChange: (state) => {
        button.classList.toggle("is-holding", state === "holding");
        button.classList.toggle("is-fired", state === "fired");
      },
    });
    const press = () => {
      if (button.disabled || hold.state !== "idle") return;
      context = begin();
      hold.press();
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      button.setPointerCapture?.(event.pointerId);
      press();
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) button.addEventListener(type, () => hold.release());
    // A pointer taken off the button loses its capture, and `lostpointercapture` (above) ends the hold: a second held from outside the
    // control would send a command the operator is no longer pressing. Seen in the page (docs/evidence/12.13): the events on a drag-off
    // are pointerdown, gotpointercapture, lostpointercapture.
    button.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        press();
      }
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") hold.release();
    });
    // A click does nothing: only a full hold sends. (Without this a keyboard Enter would also click.)
    button.addEventListener("click", (event) => event.preventDefault());
    return { button, hold };
  }

  function makeRow(stack) {
    const tr = el("tr", "stacks__row");
    tr.dataset.stack = String(stack);
    const stackCell = el("td", "stacks__col-stack");
    const pick = el("button", "stacks__pick num", formatStack(stack));
    pick.type = "button";
    pick.setAttribute("aria-label", `${term("stack")} ${formatStack(stack)}`);
    pick.addEventListener("click", () => handlers.onSelect(stack));
    stackCell.appendChild(pick);

    const sceneCell = el("td", "stacks__col-scene");
    const sceneLine = el("div", "stacks__scene");
    const sceneMeta = el("div", "stacks__meta num");
    const thenLine = el("div", "stacks__then");
    sceneCell.append(sceneLine, sceneMeta, thenLine);

    const stateCell = el("td", "stacks__col-state");
    const stateChip = el("span", "chip");
    const queuedChip = el("span", "chip chip--warning stacks__queued-chip", stateText("queued"));
    const doubledChip = el("span", "chip chip--critical", "TWO REPORTED");
    doubledChip.title = "The engine reported more than one scene on this stack. Check the engine before sending a command here.";
    stateCell.append(stateChip, queuedChip, doubledChip);

    const controlCell = el("td", "stacks__col-control");
    const controls = el("div", "stacks__controls");
    const continueButton = el("button", "btn btn--phase", "Continue");
    continueButton.type = "button";
    continueButton.title = `Continue the scene on this ${term("stack").toLowerCase()} to its next phase`;
    continueButton.addEventListener("click", () => handlers.onContinue(stack));
    const cueOut = armedButton(
      `Cue out · hold ${HOLD_SECONDS}`,
      "btn--out",
      `Hold for ${HOLD_SECONDS} to play this scene's Out`,
      () => stack,
      (target) => handlers.onCueOut(target),
    );
    // The page a Clear names is fixed when the hold begins: if the stack changes during the hold the engine refuses by name.
    const clearPressed = armedButton(
      `Clear · hold ${HOLD_SECONDS}`,
      "btn--clear btn--clear-row",
      `Hold for ${HOLD_SECONDS} to take this scene off air`,
      () => ({ stack, page: row.page }),
      ({ stack: target, page }) => {
        if (page !== null) handlers.onClear(target, page);
      },
    );
    controls.append(continueButton, cueOut.button, clearPressed.button);
    controlCell.appendChild(controls);

    tr.append(stackCell, sceneCell, stateCell, controlCell);
    tr.addEventListener("click", (event) => {
      if (!(event.target instanceof Element) || event.target.closest("button") === null) handlers.onSelect(stack);
    });

    const row = {
      tr,
      page: null,
      pick,
      sceneLine,
      sceneMeta,
      thenLine,
      stateChip,
      queuedChip,
      doubledChip,
      continueButton,
      cueOut,
      clear: clearPressed,
      cancelHolds() {
        cueOut.hold.release();
        clearPressed.hold.release();
      },
    };
    return row;
  }

  function update(row, model) {
    const { tr } = row;
    row.page = pageOf(model);
    tr.classList.toggle("is-selected", model.selected);
    tr.classList.toggle("is-onair", model.current?.state === "onAir");
    row.pick.setAttribute("aria-pressed", String(model.selected));

    if (model.current === null && model.queued === null) {
      row.sceneLine.textContent = "empty";
      row.sceneLine.classList.add("stacks__empty");
      row.sceneMeta.textContent = model.selected ? "the Transport sends here" : "";
    } else if (model.current === null) {
      row.sceneLine.textContent = "nothing on air";
      row.sceneLine.classList.add("stacks__empty");
      row.sceneMeta.textContent = "";
    } else {
      row.sceneLine.classList.remove("stacks__empty");
      row.sceneLine.textContent = `${count(model.current.takeId)} · revision ${count(model.current.revision)}`;
      row.sceneMeta.textContent = `committed at frame ${count(model.current.frame)}`;
    }
    if (model.queued !== null) {
      row.thenLine.hidden = false;
      row.thenLine.textContent = `then ${count(model.queued.takeId)} · revision ${count(model.queued.revision)} from frame ${count(model.queued.frame)}`;
    } else {
      row.thenLine.hidden = true;
      row.thenLine.textContent = "";
    }

    if (model.current === null) {
      row.stateChip.hidden = true;
    } else {
      row.stateChip.hidden = false;
      row.stateChip.className = `chip chip--${chipFor(model.current.state)}`;
      row.stateChip.textContent = stateText(model.current.state);
    }
    row.queuedChip.hidden = model.queued === null;
    row.doubledChip.hidden = !model.doubled;

    const allowed = rowControls(model);
    const set = (button, on) => {
      button.disabled = !usable || !on;
    };
    set(row.continueButton, allowed.continue);
    set(row.cueOut.button, allowed.cueOut);
    set(row.clear.button, allowed.clear);
    // A hold in progress on a control that has just become unavailable ends with it.
    if (row.cueOut.button.disabled) row.cueOut.hold.release();
    if (row.clear.button.disabled) row.clear.hold.release();
  }

  // A hold ends with the pointer wherever it is lifted, and with the window losing focus: a safety net behind the button's own events.
  const endHolds = () => {
    for (const row of rows.values()) row.cancelHolds();
  };
  window.addEventListener("pointerup", endHolds);
  window.addEventListener("pointercancel", endHolds);
  window.addEventListener("blur", endHolds);

  return {
    /** Draw `status` for the stack selected in the field.
     *  @param {unknown} status @param {number} selected @param {boolean} canSend whether the page may send a command now */
    render(status, selected, canSend) {
      usable = canSend;
      const { rows: models, unreadable, source } = stackRows(status, selected);
      const wanted = new Set(models.map((m) => m.stack));
      for (const [stack, row] of rows) {
        if (!wanted.has(stack)) {
          row.cancelHolds();
          row.tr.remove();
          rows.delete(stack);
        }
      }
      models.forEach((model, index) => {
        let row = rows.get(model.stack);
        if (row === undefined) {
          row = makeRow(model.stack);
          rows.set(model.stack, row);
        }
        update(row, model);
        // Place a row only when it is not already where it belongs: a node that is moved loses the pointer that is on it.
        if (body.children[index] !== row.tr) body.insertBefore(row.tr, body.children[index] ?? null);
      });

      const sentences = [];
      if (source === "none") sentences.push("No engine status yet. A stack is drawn when the engine reports it.");
      if (source === "program") sentences.push(`This engine reports ${term("stack")} 0 only.`);
      if (unreadable > 0) sentences.push(`${unreadable} ${unreadable === 1 ? "entry" : "entries"} in the engine's status could not be placed on a stack.`);
      note.hidden = sentences.length === 0;
      note.textContent = sentences.join(" ");
    },
    /** End every hold in progress (the connection dropped, the page was blocked). */
    cancelHolds: endHolds,
  };
}
