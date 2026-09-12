// GrapiX Playout — operator surface behaviour.
//
// Plain ES module, no bundler, no dependencies. Loaded by the Tauri 2 shell
// (`Playout/shell/tauri.conf.json`, `frontendDist: "../web"`).
//
// Three rules shape this file more than anything else:
//
//  * Severity is not decided here. `Playout/src/clock-display.ts` is the
//    tested rule — Nominal → quiet, Warning → persistent, Critical → blocking
//    — and `prominenceFor` below is that rule and nothing more. Recomputing
//    severity from `status.clock`/`status.reference` would be a second opinion
//    about how alarming a state is, which is exactly what invariant 11 and
//    ADR-002 exist to prevent.
//
//  * No control sends a time and no readout shows one (invariants 8, 9).
//    Scheduling is "next opportunity" or a frame number; every result is the
//    frame the *engine* committed to, labelled as the engine's decision. Even
//    the activity log is sequenced rather than timestamped, because a
//    wall-clock column is a wall-clock time.
//
//  * Refusals keep their names (invariant 17). A refusal is rendered as its
//    named failing condition plus the engine's detail, verbatim. Nothing here
//    collapses into "failed".

// ---------------------------------------------------------------------------
// The shell bridge.
//
// Tauri 2 exposes `window.__TAURI__.core.invoke` globally. Opened in a plain
// browser there is no bridge, and the page must say so rather than throw.
// ---------------------------------------------------------------------------

const bridge = globalThis.__TAURI__ && globalThis.__TAURI__.core;
const inShell = typeof bridge?.invoke === "function";

/** Every engine call goes through here so the no-bridge case is one branch. */
function invoke(command, args) {
  if (!inShell) {
    return Promise.reject({
      error: "shellUnavailable",
      detail: "window.__TAURI__.core.invoke is not present in this page.",
    });
  }
  return bridge.invoke(command, args);
}

const EM_DASH = "\u2014";

// ---------------------------------------------------------------------------
// Contract helpers.
// ---------------------------------------------------------------------------

/** Render an exact rational as an operator-facing rate.
 *
 *  Mirrors `formatRate` in `Playout/src/clock-display.ts`. The value carried
 *  in the contract stays num/den (invariant 12); this is the only place a rate
 *  becomes lossy, and it is lossy only on screen. */
function formatRate(rate) {
  if (!rate || !Number.isFinite(rate.num) || !Number.isFinite(rate.den) || rate.den === 0) {
    return EM_DASH;
  }
  if (rate.den === 1) return `${rate.num}`;
  const decimal = rate.num / rate.den;
  // Two places covers every broadcast rate in use; more would be noise.
  return decimal.toFixed(2).replace(/\.00$/, "");
}

/** The exact rational, always shown next to the conversational rate. */
function rationalOf(rate) {
  if (!rate || !Number.isFinite(rate.num) || !Number.isFinite(rate.den)) return EM_DASH;
  return `${rate.num}/${rate.den}`;
}

/** Severity as the engine spells it, tolerant of casing only.
 *
 *  This normalises an encoding, it does not decide anything: the value still
 *  comes from `clock.severity`. */
function canonicalSeverity(severity) {
  if (typeof severity !== "string" || severity.length === 0) return null;
  const lower = severity.toLowerCase();
  if (lower === "nominal") return "Nominal";
  if (lower === "warning") return "Warning";
  if (lower === "critical") return "Critical";
  return null;
}

/** Map severity to how hard the UI must push.
 *
 *  Total over Severity, as in clock-display.ts. A severity this build does not
 *  know escalates to blocking: the one thing that must never happen is a
 *  non-nominal state rendered quietly. */
function prominenceFor(severity) {
  switch (canonicalSeverity(severity)) {
    case "Nominal":
      return "quiet";
    case "Warning":
      // Free-run is a Warning, and it stays on screen for the whole show. It
      // is never a toast that disappears.
      return "persistent";
    case "Critical":
      return "blocking";
    default:
      return "blocking";
  }
}

/** Whether the live-output control may be enabled.
 *
 *  Mirrors `liveControlEnabled` in clock-display.ts, which in turn mirrors the
 *  engine's own gate. Playout does not decide liveness (invariant 20); it only
 *  declines to offer a button whose press it knows will be refused. */
function liveControlEnabled(status) {
  if (!status || status.liveAllowed !== true) return false;
  const degradations = Array.isArray(status.degradations) ? status.degradations : [];
  return !degradations.some(
    (d) => d && (d.degradation === "referenceLost" || d.degradation === "deviceBelowT0"),
  );
}

/** Newtype-tolerant unwrap: `TakeId(String)` may arrive as `"id"` or `{0:"id"}`. */
function inner(value) {
  if (value !== null && typeof value === "object" && "0" in value) return value["0"];
  return value;
}

/** Frame and revision numbers are exact integers. Never formatted, never
 *  grouped, never rounded — an operator reads them against a hardware
 *  counter. */
function formatCount(value) {
  const v = inner(value);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return EM_DASH;
}

/** A named refusal, with every field it carries (invariant 17). */
function formatRefusal(refusal) {
  if (refusal == null) return "unnamed refusal";
  if (typeof refusal === "string") return refusal;
  const name = refusal.refusal ?? "unnamed refusal";
  const fields = Object.entries(refusal)
    .filter(([key]) => key !== "refusal")
    .map(([key, value]) => `${key}=${scalar(value)}`);
  return fields.length ? `${name} (${fields.join(", ")})` : String(name);
}

function scalar(value) {
  const v = inner(value);
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Turn a rejected command into a name and a detail, both verbatim.
 *
 *  `unreachable` and `refused` stay distinct all the way to the screen: one is
 *  "the engine never heard you", the other is "the engine said no, and here is
 *  the condition that failed". */
function describeError(err) {
  if (err && typeof err === "object" && typeof err.error === "string") {
    if (err.error === "refused") {
      return {
        name: `refused: ${formatRefusal(err.refusal)}`,
        detail: typeof err.detail === "string" ? err.detail : "",
        kind: "refused",
        code: "refused",
      };
    }
    const parts = Object.entries(err)
      .filter(([key]) => key !== "error" && key !== "detail")
      .map(([key, value]) => `${key}=${scalar(value)}`);
    const detail = typeof err.detail === "string" ? err.detail : "";
    return {
      name: err.error,
      detail: parts.length ? `${detail}${detail ? " " : ""}[${parts.join(", ")}]` : detail,
      kind: "error",
      code: err.error,
    };
  }
  // Not one of ours. Say so rather than inventing a contract name.
  return {
    name: "unhandledBridgeFailure",
    detail: err instanceof Error ? err.message : String(err),
    kind: "error",
    code: "unhandledBridgeFailure",
  };
}

/** Errors that mean the connection is gone, so polling stops rather than
 *  reissuing a call that cannot succeed.
 *
 *  `unhandledBridgeFailure` is deliberately absent: something this surface
 *  does not recognise is not evidence that the engine went away, and tearing
 *  the session down on it would turn a rendering fault into a false
 *  disconnection. */
const CONNECTION_LOST = new Set([
  "notConnected",
  "unreachable",
  "invalidEndpoint",
  "invalidToken",
  "shellUnavailable",
]);

// ---------------------------------------------------------------------------
// DOM.
// ---------------------------------------------------------------------------

const id = (name) => document.getElementById(name);

const ui = {
  shellNotice: id("shellNotice"),

  endpointInput: id("endpointInput"),
  tokenInput: id("tokenInput"),
  connectButton: id("connectButton"),
  refreshButton: id("refreshButton"),
  connectionState: id("connectionState"),
  connectionDetail: id("connectionDetail"),

  severityBand: id("severityBand"),
  severityWord: id("severityWord"),
  severityLabel: id("severityLabel"),
  severityNote: id("severityNote"),

  clockPanel: id("clockPanel"),
  clockSeverityChip: id("clockSeverityChip"),
  clockLabel: id("clockLabel"),
  clockProminence: id("clockProminence"),
  clockRate: id("clockRate"),
  clockRational: id("clockRational"),
  clockSource: id("clockSource"),
  referenceState: id("referenceState"),
  clockFreeRun: id("clockFreeRun"),
  deviceTier: id("deviceTier"),
  deviceTierNote: id("deviceTierNote"),
  epochValue: id("epochValue"),
  currentFrame: id("currentFrame"),
  degradationList: id("degradationList"),

  programChip: id("programChip"),
  programEmpty: id("programEmpty"),
  programDetail: id("programDetail"),
  programTakeId: id("programTakeId"),
  programRevision: id("programRevision"),
  programCommittedFrame: id("programCommittedFrame"),

  transportPanel: id("transportPanel"),
  takeIdInput: id("takeIdInput"),
  revisionInput: id("revisionInput"),
  frameInput: id("frameInput"),
  frameMode: id("frameMode"),
  cueButton: id("cueButton"),
  takeButton: id("takeButton"),
  clearButton: id("clearButton"),
  commitReadout: id("commitReadout"),
  commitHead: id("commitHead"),
  commitFrame: id("commitFrame"),
  commitRate: id("commitRate"),
  commitClock: id("commitClock"),
  commitNote: id("commitNote"),
  transportBlock: id("transportBlock"),
  transportBlockWord: id("transportBlockWord"),
  transportBlockLabel: id("transportBlockLabel"),
  transportBlockWhy: id("transportBlockWhy"),
  acknowledgeButton: id("acknowledgeButton"),

  adapterInput: id("adapterInput"),
  liveCheckbox: id("liveCheckbox"),
  liveGate: id("liveGate"),
  freeRunCheckbox: id("freeRunCheckbox"),
  configureButton: id("configureButton"),
  outputChip: id("outputChip"),
  outputResult: id("outputResult"),
  outputAdapter: id("outputAdapter"),
  outputLive: id("outputLive"),
  outputRefusal: id("outputRefusal"),

  logList: id("logList"),
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setChip(node, text, variant) {
  node.className = `chip chip--${variant}`;
  node.textContent = text;
}

// ---------------------------------------------------------------------------
// Session state.
// ---------------------------------------------------------------------------

const session = {
  connected: false,
  /** Last `prominence` derived from the engine's severity. */
  prominence: "blocking",
  /** `clock.label`, verbatim, as last reported. */
  clockLabel: "",
  /** A critical clock has been acknowledged for exactly one command. */
  armed: false,
  /** The label that was acknowledged; a different one re-blocks. */
  armedLabel: null,
  /** Last poll failure, so a repeating fault is logged once. */
  lastPollSignature: null,
  pollTimer: null,
  polling: false,
  busy: false,
};

// ---------------------------------------------------------------------------
// Activity log.
//
// Append-only, newest first. Sequenced rather than timestamped: a wall-clock
// column on an operator surface is a wall-clock time, and Playout does not
// deal in those (invariants 8, 9). The sequence number is what an operator
// quotes when reporting what happened and in what order.
// ---------------------------------------------------------------------------

const LOG_CAP = 400;
let logSeq = 0;

/** One row. `body` is a node so a frame number can carry its own emphasis
 *  without building HTML from engine-supplied strings. */
function appendRow(kind, outcome, body, detail) {
  logSeq += 1;

  const row = el("li", `log__row log__row--${outcome}`);
  row.appendChild(el("span", "log__seq", `#${String(logSeq).padStart(4, "0")}`));
  row.appendChild(el("span", "log__kind", kind));

  const text = el("span", "log__text");
  text.appendChild(body);
  if (detail) text.appendChild(el("span", "log__detail", detail));
  row.appendChild(text);

  const empty = ui.logList.querySelector(".log__empty");
  if (empty) empty.remove();

  ui.logList.prepend(row);
  while (ui.logList.childElementCount > LOG_CAP) {
    ui.logList.lastElementChild.remove();
  }
}

function log(kind, outcome, text, detail) {
  appendRow(kind, outcome, document.createTextNode(text), detail);
}

/** A committed frame, in the log, always labelled as the engine's choice and
 *  never as an echo of what was asked for (invariant 9). */
function logCommitted(kind, committed) {
  const body = el("span");
  body.appendChild(document.createTextNode("engine committed frame "));
  body.appendChild(el("span", "log__frame", formatCount(committed?.frame)));

  appendRow(
    kind,
    "ok",
    body,
    `${formatRate(committed?.timebase)} (${rationalOf(committed?.timebase)}) \u00b7 ${
      committed?.clock ?? "clock unreported"
    }`,
  );
}

function logFailure(kind, err) {
  const { name, detail, kind: outcome } = describeError(err);
  log(kind, outcome === "refused" ? "refused" : "error", name, detail);
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

const SEVERITY_CHIP = {
  quiet: ["NOMINAL", "nominal"],
  persistent: ["WARNING", "warning"],
  blocking: ["CRITICAL", "critical"],
};

const PROMINENCE_TEXT = {
  quiet: "Prominence: quiet \u2014 locked and healthy",
  persistent: "Prominence: persistent \u2014 stays on screen, cannot be dismissed",
  blocking: "Prominence: blocking \u2014 transport held until acknowledged",
};

/** The clock indicator. Prominence comes from the engine's severity; the text
 *  is `clock.label`, verbatim. */
function renderClock(clock) {
  const prominence = prominenceFor(clock?.severity);
  const label = typeof clock?.label === "string" && clock.label ? clock.label : "Clock state unreported";

  session.prominence = prominence;
  session.clockLabel = label;

  const [chipText, chipVariant] = SEVERITY_CHIP[prominence];
  setChip(ui.clockSeverityChip, chipText, chipVariant);
  ui.clockPanel.dataset.severity = chipVariant;
  ui.clockLabel.textContent = label;
  ui.clockProminence.textContent = PROMINENCE_TEXT[prominence];

  ui.clockRate.textContent = formatRate(clock?.timebase);
  ui.clockRational.textContent = rationalOf(clock?.timebase);
  ui.clockFreeRun.textContent = clock?.freeRunning === true ? "YES \u2014 no external reference" : "No";

  // `nominal` is the only severity allowed to be quiet, so it is the only one
  // without a band.
  if (prominence === "quiet") {
    ui.severityBand.hidden = true;
    ui.severityBand.className = "band";
  } else {
    const critical = prominence === "blocking";
    ui.severityBand.hidden = false;
    ui.severityBand.className = `band band--${critical ? "critical" : "warning"}`;
    ui.severityWord.textContent = critical ? "CRITICAL" : "WARNING";
    ui.severityLabel.textContent = label;
    ui.severityNote.textContent = critical
      ? "Transport is held. Acknowledge in the transport panel to arm one command."
      : "Reported by the engine. This notice has no dismiss control.";
  }
}

const TIER_NOTE = {
  T0: "May go live.",
  T1: "Cannot go live \u2014 only T0 may go to air.",
  T2: "Cannot go live \u2014 only T0 may go to air.",
  T3: "Cannot go live \u2014 only T0 may go to air.",
};

function renderStatus(status) {
  ui.clockSource.textContent = status?.clock ?? EM_DASH;
  ui.referenceState.textContent = status?.reference ?? EM_DASH;
  ui.epochValue.textContent = formatCount(status?.epoch);
  ui.currentFrame.textContent = formatCount(status?.currentFrame);

  const tier = typeof status?.deviceTier === "string" ? status.deviceTier : null;
  if (tier) {
    setChip(ui.deviceTier, tier, tier === "T0" ? "nominal" : "critical");
    ui.deviceTierNote.textContent = TIER_NOTE[tier] ?? "Unknown tier \u2014 treat as not live-capable.";
  } else {
    setChip(ui.deviceTier, EM_DASH, "idle");
    ui.deviceTierNote.textContent = "Tier unknown.";
  }

  renderDegradations(status?.degradations);
  renderProgram(status?.program);
  renderLiveGate(status);
}

const DEGRADATION_TAG = {
  referenceLost: ["CRITICAL", "crit"],
  deviceBelowT0: ["CRITICAL", "crit"],
  freeRunning: ["WARNING", "warn"],
};

function renderDegradations(degradations) {
  const list = ui.degradationList;
  list.replaceChildren();

  if (!Array.isArray(degradations) || degradations.length === 0) {
    list.appendChild(el("li", "list__empty", "None. The engine reports no degraded condition."));
    return;
  }

  for (const d of degradations) {
    const name = d?.degradation;
    const [tagText, tagVariant] = DEGRADATION_TAG[name] ?? ["WARNING", "warn"];
    const item = el("li", `list__item list__item--${tagVariant}`);
    item.appendChild(el("span", "list__tag", tagText));
    item.appendChild(el("span", null, degradationText(d)));
    list.appendChild(item);
  }
}

function degradationText(d) {
  switch (d?.degradation) {
    case "referenceLost":
      return `Reference lost \u2014 holding the last good cadence, ${formatRate(d.was)} (${rationalOf(
        d.was,
      )}).`;
    case "freeRunning":
      return "Free running \u2014 Program cadence has no external reference.";
    case "deviceBelowT0":
      return `Render device below T0 (reported ${scalar(d.actual)}) \u2014 live adapters refuse.`;
    default:
      // An unknown degradation is still a degradation. Show it rather than
      // dropping it (invariant 17 in spirit: name the condition).
      return `Unrecognised degradation reported by the engine: ${scalar(d)}`;
  }
}

function renderProgram(program) {
  if (!program) {
    setChip(ui.programChip, "CLEAR", "idle");
    ui.programEmpty.hidden = false;
    ui.programEmpty.textContent = "Program clear \u2014 nothing on air.";
    ui.programDetail.hidden = true;
    return;
  }

  setChip(ui.programChip, "ON AIR", "live");
  ui.programEmpty.hidden = true;
  ui.programDetail.hidden = false;
  ui.programTakeId.textContent = String(inner(program.takeId) ?? EM_DASH);
  ui.programRevision.textContent = formatCount(program.revision);
  ui.programCommittedFrame.textContent = formatCount(program.committedFrame);
}

/** Invariant 20: the engine decides liveness. The control is offered or not
 *  offered on the engine's own answer, and the reason is always stated. */
function renderLiveGate(status) {
  const enabled = liveControlEnabled(status);
  ui.liveCheckbox.disabled = !enabled;

  if (enabled) {
    ui.liveGate.className = "check__gate";
    ui.liveGate.textContent = "The engine reports this output may be configured live.";
    return;
  }

  ui.liveGate.className = "check__gate check__gate--blocked";

  const degradations = Array.isArray(status?.degradations) ? status.degradations : [];
  const blockers = degradations
    .filter((d) => d?.degradation === "referenceLost" || d?.degradation === "deviceBelowT0")
    .map((d) => d.degradation);

  let reason;
  if (!status) {
    reason = "No engine status. Liveness is the engine's answer and it has not answered.";
  } else if (status.liveAllowed !== true) {
    reason = "The engine reports liveAllowed=false. Live configuration would be refused.";
  } else {
    reason = `The engine reports ${blockers.join(" and ")}. Live configuration would be refused.`;
  }

  // Not silent: if a live request was staged and the engine has since said no,
  // the request is cleared and the operator is told it was cleared.
  if (ui.liveCheckbox.checked) {
    ui.liveCheckbox.checked = false;
    reason += " The staged live request was cleared.";
    log("OUTPUT", "info", "live request cleared", reason);
  }

  ui.liveGate.textContent = reason;
}

// ---------------------------------------------------------------------------
// Transport gating.
// ---------------------------------------------------------------------------

function refreshTransportGate() {
  const blocking = session.prominence === "blocking";
  const armedHere = session.armed && session.armedLabel === session.clockLabel;
  const clockBlocked = session.connected && blocking && !armedHere;

  // Two different reasons the transport is unavailable, and the overlay says
  // which. A critical clock can be acknowledged; a missing connection cannot,
  // so that acknowledgement is not offered.
  if (!session.connected) {
    ui.transportBlock.hidden = false;
    ui.transportBlockWord.textContent = "NO ENGINE CONNECTION";
    ui.transportBlockLabel.textContent = "Playout is not connected to an engine.";
    ui.transportBlockWhy.textContent =
      "Program commands cannot be sent from here. Program itself continues on the render node.";
    ui.acknowledgeButton.hidden = true;
  } else if (clockBlocked) {
    ui.transportBlock.hidden = false;
    ui.transportBlockWord.textContent = "TRANSPORT BLOCKED";
    ui.transportBlockLabel.textContent = session.clockLabel;
    ui.transportBlockWhy.textContent =
      "The engine reports a critical clock state. Program commands are held until you acknowledge it.";
    ui.acknowledgeButton.hidden = false;
  } else {
    ui.transportBlock.hidden = true;
  }

  ui.transportPanel.classList.toggle("is-armed", session.connected && blocking && armedHere);

  // Disabled for real, not only covered: a keyboard reaching a button under an
  // overlay would be the whole mechanism defeated.
  const usable = session.connected && !clockBlocked && !session.busy;
  ui.cueButton.disabled = !usable;
  ui.takeButton.disabled = !usable;
  ui.clearButton.disabled = !usable;
  ui.configureButton.disabled = !session.connected || session.busy;
  ui.refreshButton.disabled = !session.connected || session.busy;
}

function acknowledgeCritical() {
  session.armed = true;
  session.armedLabel = session.clockLabel;
  log("TRANSPORT", "info", "critical clock acknowledged \u2014 one command armed", session.clockLabel);
  refreshTransportGate();
}

/** Re-block after every command. An acknowledgement covers one command, so a
 *  critical clock cannot be acknowledged once at the top of a show and then
 *  forgotten. */
function disarm() {
  if (session.armed) {
    session.armed = false;
    session.armedLabel = null;
    if (session.prominence === "blocking") {
      log("TRANSPORT", "info", "transport re-blocked", "Acknowledgement covers one command only.");
    }
  }
}

// ---------------------------------------------------------------------------
// Connection state.
// ---------------------------------------------------------------------------

function setConnected(detail) {
  session.connected = true;
  setChip(ui.connectionState, "CONNECTED", "nominal");
  ui.connectionDetail.textContent = detail;
  ui.connectButton.textContent = "Reconnect";
  refreshTransportGate();
}

/** Return to the disconnected state.
 *
 *  Everything derived from engine status is cleared rather than left on
 *  screen: a stale "Genlocked" is a quiet presentation of a state nobody is
 *  reporting, which is the failure invariant 11 names. */
function setDisconnected(detail, wasConnected) {
  stopPolling();
  session.connected = false;
  session.armed = false;
  session.armedLabel = null;
  session.prominence = "blocking";
  session.clockLabel = "";

  setChip(ui.connectionState, "DISCONNECTED", "idle");
  ui.connectionDetail.textContent = detail;
  ui.connectButton.textContent = "Connect";

  setChip(ui.clockSeverityChip, "NO DATA", "idle");
  ui.clockPanel.dataset.severity = "unknown";
  ui.clockLabel.textContent = "No engine status.";
  ui.clockProminence.textContent = "Prominence: \u2014";
  ui.clockRate.textContent = EM_DASH;
  ui.clockRational.textContent = EM_DASH;
  ui.clockSource.textContent = EM_DASH;
  ui.referenceState.textContent = EM_DASH;
  ui.clockFreeRun.textContent = EM_DASH;
  ui.epochValue.textContent = EM_DASH;
  ui.currentFrame.textContent = EM_DASH;
  setChip(ui.deviceTier, EM_DASH, "idle");
  ui.deviceTierNote.textContent = "Tier unknown.";

  ui.degradationList.replaceChildren(
    el("li", "list__empty", "No engine status \u2014 degraded conditions unknown."),
  );

  setChip(ui.programChip, "UNKNOWN", "idle");
  ui.programEmpty.hidden = false;
  ui.programEmpty.textContent = "No engine status \u2014 Program state unknown.";
  ui.programDetail.hidden = true;

  ui.liveCheckbox.disabled = true;
  ui.liveGate.className = "check__gate check__gate--blocked";
  ui.liveGate.textContent = "Not connected. Liveness is the engine's answer.";

  if (wasConnected) {
    ui.severityBand.hidden = false;
    ui.severityBand.className = "band band--critical";
    ui.severityWord.textContent = "NO ENGINE";
    ui.severityLabel.textContent = "Engine connection lost";
    ui.severityNote.textContent = "Program state is unknown from here. Program itself continues.";
  } else {
    ui.severityBand.hidden = true;
    ui.severityBand.className = "band";
  }

  ui.transportPanel.classList.remove("is-armed");
  refreshTransportGate();
}

function applyView(view) {
  renderClock(view?.clock);
  renderStatus(view?.status);

  // A severity change invalidates an acknowledgement: the operator
  // acknowledged a specific reported state, not critical states in general.
  if (session.armed && (session.prominence !== "blocking" || session.armedLabel !== session.clockLabel)) {
    session.armed = false;
    session.armedLabel = null;
  }
  refreshTransportGate();
}

// ---------------------------------------------------------------------------
// Polling.
//
// ~500ms once connected, stopped on disconnect. Re-entrancy is guarded so a
// slow round trip cannot queue a second one behind it.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500;

function startPolling() {
  if (session.pollTimer !== null) return;
  session.pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (session.pollTimer === null) return;
  clearInterval(session.pollTimer);
  session.pollTimer = null;
}

async function pollOnce() {
  if (session.polling || session.busy) return;
  session.polling = true;
  try {
    const view = await invoke("cmd_status");
    applyView(view);
    session.lastPollSignature = null;
  } catch (err) {
    const described = describeError(err);

    if (CONNECTION_LOST.has(described.code)) {
      log("STATUS", described.kind === "refused" ? "refused" : "error", described.name, described.detail);
      setDisconnected(`${described.name}${described.detail ? ` \u2014 ${described.detail}` : ""}`, true);
      return;
    }

    // Not fatal to the connection. Log the first occurrence of each distinct
    // fault and keep polling rather than filling the log with one line.
    const signature = `${described.name}|${described.detail}`;
    if (signature !== session.lastPollSignature) {
      session.lastPollSignature = signature;
      log("STATUS", described.kind === "refused" ? "refused" : "error", described.name, described.detail);
    }
  } finally {
    session.polling = false;
  }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/** Serialise operator-initiated commands so two cannot overlap. */
async function run(fn) {
  if (session.busy) return;
  session.busy = true;
  refreshTransportGate();
  try {
    await fn();
  } finally {
    session.busy = false;
    refreshTransportGate();
  }
}

async function doConnect() {
  const endpoint = ui.endpointInput.value.trim();
  if (endpoint === "") {
    ui.endpointInput.setAttribute("aria-invalid", "true");
    log("LOCAL", "error", "endpoint required", "Playout did not send anything.");
    return;
  }
  ui.endpointInput.removeAttribute("aria-invalid");

  const tokenRaw = ui.tokenInput.value;
  const token = tokenRaw === "" ? null : tokenRaw;

  stopPolling();
  setChip(ui.connectionState, "CONNECTING", "ok");
  ui.connectionDetail.textContent = `Opening control plane to ${endpoint}.`;

  try {
    const view = await invoke("cmd_connect", { endpoint, token });
    applyView(view);
    setConnected(
      `${endpoint} \u00b7 ${view?.status?.clock ?? "clock unreported"} \u00b7 ${
        view?.status?.deviceTier ?? "tier unreported"
      }`,
    );
    log(
      "CONNECT",
      "ok",
      `connected to ${endpoint}`,
      `${view?.clock?.label ?? "clock unreported"} \u00b7 current frame ${formatCount(
        view?.status?.currentFrame,
      )}`,
    );
    startPolling();
  } catch (err) {
    const described = describeError(err);
    logFailure("CONNECT", err);
    setDisconnected(
      `${described.name}${described.detail ? ` \u2014 ${described.detail}` : ""}`,
      session.connected,
    );
  }
}

async function doStatus() {
  try {
    const view = await invoke("cmd_status");
    applyView(view);
    session.lastPollSignature = null;
    log(
      "STATUS",
      "ok",
      view?.clock?.label ?? "clock unreported",
      `current frame ${formatCount(view?.status?.currentFrame)} \u00b7 ${formatRate(
        view?.status?.timebase,
      )} (${rationalOf(view?.status?.timebase)})`,
    );
  } catch (err) {
    const described = describeError(err);
    logFailure("STATUS", err);
    if (CONNECTION_LOST.has(described.code)) {
      setDisconnected(`${described.name}${described.detail ? ` \u2014 ${described.detail}` : ""}`, true);
    }
  }
}

/** The only scheduling this surface can express.
 *
 *  Blank is `NextOpportunity`. There is no "now" to send, and no wall-clock
 *  field exists to send one from (invariants 8, 9). */
function readFrame() {
  const raw = ui.frameInput.value.trim();
  if (raw === "") {
    ui.frameInput.removeAttribute("aria-invalid");
    return { ok: true, frame: null, description: "next opportunity" };
  }
  if (!/^\d+$/.test(raw)) {
    ui.frameInput.setAttribute("aria-invalid", "true");
    return { ok: false, reason: "Frame must be a whole frame number, or blank for next opportunity." };
  }
  ui.frameInput.removeAttribute("aria-invalid");
  const frame = Number(raw);
  if (!Number.isSafeInteger(frame)) {
    ui.frameInput.setAttribute("aria-invalid", "true");
    return { ok: false, reason: "Frame number is out of the range this surface can send exactly." };
  }
  return { ok: true, frame, description: `frame ${frame}` };
}

function readTakeTarget() {
  const takeId = ui.takeIdInput.value.trim();
  if (takeId === "") {
    ui.takeIdInput.setAttribute("aria-invalid", "true");
    return { ok: false, reason: "Take id is required." };
  }
  ui.takeIdInput.removeAttribute("aria-invalid");

  const raw = ui.revisionInput.value.trim();
  if (!/^\d+$/.test(raw)) {
    ui.revisionInput.setAttribute("aria-invalid", "true");
    return { ok: false, reason: "Revision is required and is a whole number. It is matched exactly." };
  }
  ui.revisionInput.removeAttribute("aria-invalid");
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) {
    ui.revisionInput.setAttribute("aria-invalid", "true");
    return { ok: false, reason: "Revision is out of the range this surface can send exactly." };
  }
  return { ok: true, takeId, revision };
}

const COMMIT_HEAD = {
  CUE: "Engine committed \u2014 cued, not on air",
  TAKE: "Engine committed \u2014 on air",
  CLEAR: "Engine committed \u2014 Program cleared",
};

/** Show what the *engine* decided. Never an echo of the request. */
function renderCommitted(kind, committed) {
  ui.commitReadout.hidden = false;
  ui.commitHead.textContent = COMMIT_HEAD[kind] ?? "Engine committed";
  ui.commitFrame.textContent = formatCount(committed?.frame);
  ui.commitRate.textContent = `${formatRate(committed?.timebase)} (${rationalOf(committed?.timebase)})`;
  ui.commitClock.textContent = committed?.clock ?? "clock unreported";
  ui.commitNote.textContent =
    committed?.clock === "FreeRun"
      ? "Committed on a free-running clock: the frame number is exact, its timing against any external reference is not."
      : "";
}

async function transport(kind, command, args) {
  const schedule = readFrame();
  if (!schedule.ok) {
    log("LOCAL", "error", `${kind} not sent`, schedule.reason);
    return;
  }

  const payload = { ...args, frame: schedule.frame };

  try {
    const committed = await invoke(command, payload);
    renderCommitted(kind, committed);
    logCommitted(kind, committed);
  } catch (err) {
    ui.commitReadout.hidden = true;
    logFailure(kind, err);
    const described = describeError(err);
    if (CONNECTION_LOST.has(described.code)) {
      setDisconnected(`${described.name}${described.detail ? ` \u2014 ${described.detail}` : ""}`, true);
      return;
    }
  } finally {
    disarm();
    refreshTransportGate();
  }
}

async function doCue() {
  const target = readTakeTarget();
  if (!target.ok) {
    log("LOCAL", "error", "CUE not sent", target.reason);
    return;
  }
  await transport("CUE", "cmd_cue", { takeId: target.takeId, revision: target.revision });
}

async function doTake() {
  const target = readTakeTarget();
  if (!target.ok) {
    log("LOCAL", "error", "TAKE not sent", target.reason);
    return;
  }
  await transport("TAKE", "cmd_take", { takeId: target.takeId, revision: target.revision });
}

async function doClear() {
  await transport("CLEAR", "cmd_clear", {});
}

async function doConfigureOutput() {
  const adapter = ui.adapterInput.value.trim();
  if (adapter === "") {
    ui.adapterInput.setAttribute("aria-invalid", "true");
    log("LOCAL", "error", "configure not sent", "Adapter name is required.");
    return;
  }
  ui.adapterInput.removeAttribute("aria-invalid");

  const live = ui.liveCheckbox.checked && !ui.liveCheckbox.disabled;
  const acceptFreeRun = ui.freeRunCheckbox.checked;

  ui.outputRefusal.hidden = true;
  ui.outputRefusal.replaceChildren();

  try {
    const state = await invoke("cmd_configure_output", { adapter, live, acceptFreeRun });
    ui.outputResult.hidden = false;
    ui.outputAdapter.textContent = state?.adapter ?? adapter;
    ui.outputLive.textContent = state?.live === true ? "LIVE TO AIR" : "not live";
    setChip(ui.outputChip, state?.live === true ? "LIVE" : "CONFIGURED", state?.live === true ? "live" : "ok");
    log(
      "OUTPUT",
      "ok",
      `${state?.adapter ?? adapter} configured`,
      `engine reports live=${state?.live === true}`,
    );
  } catch (err) {
    const described = describeError(err);
    setChip(ui.outputChip, "REFUSED", "critical");

    // The refusal is shown by name with its detail, verbatim (invariants 17,
    // 20): the engine decided, and the operator sees exactly what it said.
    ui.outputRefusal.hidden = false;
    ui.outputRefusal.replaceChildren(
      el("span", "refusal__name", described.name),
      el("span", "refusal__detail", described.detail || "The engine gave no further detail."),
    );

    logFailure("OUTPUT", err);
    if (CONNECTION_LOST.has(described.code)) {
      setDisconnected(`${described.name}${described.detail ? ` \u2014 ${described.detail}` : ""}`, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring.
// ---------------------------------------------------------------------------

function updateFrameMode() {
  const schedule = readFrame();
  const strong = el("strong", null, schedule.ok ? schedule.description : "invalid");
  ui.frameMode.replaceChildren(document.createTextNode("Scheduling: "), strong);
  if (!schedule.ok) {
    ui.frameMode.appendChild(document.createTextNode(` \u2014 ${schedule.reason}`));
  }
}

ui.connectButton.addEventListener("click", () => run(doConnect));
ui.refreshButton.addEventListener("click", () => run(doStatus));
ui.cueButton.addEventListener("click", () => run(doCue));
ui.takeButton.addEventListener("click", () => run(doTake));
ui.clearButton.addEventListener("click", () => run(doClear));
ui.configureButton.addEventListener("click", () => run(doConfigureOutput));
ui.acknowledgeButton.addEventListener("click", acknowledgeCritical);
ui.frameInput.addEventListener("input", updateFrameMode);

for (const input of [ui.endpointInput, ui.tokenInput]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") run(doConnect);
  });
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

async function boot() {
  updateFrameMode();
  setDisconnected("No engine connection.", false);

  if (!inShell) {
    ui.shellNotice.hidden = false;
    for (const control of document.querySelectorAll("input, button")) {
      control.disabled = true;
    }
    setChip(ui.connectionState, "NO SHELL", "critical");
    ui.connectionDetail.textContent = "Tauri command bridge unavailable.";
    log(
      "SESSION",
      "error",
      "shell bridge unavailable",
      "window.__TAURI__.core.invoke is not present. No command can be sent from this page.",
    );
    return;
  }

  log("SESSION", "info", "Playout surface ready", "Not connected. Commands are held until connect.");

  try {
    const endpoint = await invoke("cmd_default_endpoint");
    if (typeof endpoint === "string" && ui.endpointInput.value === "") {
      ui.endpointInput.value = endpoint;
      ui.connectionDetail.textContent = `Default endpoint ${endpoint}. Not connected.`;
    }
  } catch (err) {
    logFailure("SESSION", err);
  }

  // Attach to the engine on launch. This reads status and nothing else - it
  // cues nothing, takes nothing and configures no output. Those stay behind
  // the operator's own actions and, when the clock is critical, behind the
  // transport gate as well.
  //
  // Opening disconnected would be the worse default: an operator would face a
  // surface reporting "no engine status" while Program is on air behind it,
  // and could not tell that from an engine that is genuinely unreachable.
  // Invariant 11 is the same rule for the reference indicator - a blank one
  // is never acceptable - and the failure path below still shows exactly
  // which condition stopped the connection.
  await run(doConnect);
}

boot();
