/**
 * Output configuration for the operator.
 *
 * Two kinds of output exist and the panel never lets them look alike:
 *
 * - **Live** — NDI or SDI. Frames reaching one of these are in front of an audience.
 *   Marked in red, and an uncertified live adapter says so before it is used.
 * - **Virtual** — a local window of the on-air graphic at full Program resolution.
 *   Nothing leaves the machine. It exists so a take can be confirmed with no risk.
 *
 * `live` always comes from the engine's own report. It is never derived from an
 * adapter name here, because a wrong guess in this particular field is the difference
 * between a rehearsal and an on-air mistake.
 *
 * Configuring an output does not start it. Taking a scene online does — the engine
 * starts every configured output on take and stops them on off-air.
 */

import { useCallback, useEffect, useState } from "react";
import { Radio, Plus, Play, Square, Trash2, EyeOff, RefreshCw, ExternalLink, Monitor, Copy, Check, Wifi, Zap } from "lucide-react";

import {
  playoutApi,
  type EngineOutputAdapterView,
  type EngineOutputView,
  type EngineOutputsView
} from "./api";
import { openVirtualOutputWindow } from "./VirtualOutputWindow";

interface OutputsPanelProps {
  /** False when the engine is unreachable; the panel then explains rather than fails. */
  engineConnected: boolean;
  /**
   * Program resolution and rate, from the project settings that govern every scene.
   * Prefilled rather than defaulted silently: an output at the wrong size reaches air
   * at the wrong size.
   */
  programFormat: {
    width: number;
    height: number;
    frameRate: { numerator: number; denominator: number };
    colorSpace: string;
  };
}

const FRAME_RATES = [
  { label: "23.976", numerator: 24_000, denominator: 1001 },
  { label: "24", numerator: 24, denominator: 1 },
  { label: "25", numerator: 25, denominator: 1 },
  { label: "29.97", numerator: 30_000, denominator: 1001 },
  { label: "30", numerator: 30, denominator: 1 },
  { label: "50", numerator: 50, denominator: 1 },
  { label: "59.94", numerator: 60_000, denominator: 1001 },
  { label: "60", numerator: 60, denominator: 1 }
];

export function OutputsPanel({ engineConnected, programFormat }: OutputsPanelProps) {
  const [view, setView] = useState<EngineOutputsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const [adapterId, setAdapterId] = useState("virtual");
  const [outputId, setOutputId] = useState("out_1");
  const [ndiSourceName, setNdiSourceName] = useState("GrapiX Program Out");
  const [ndiGroups, setNdiGroups] = useState("");
  const [copiedSourceId, setCopiedSourceId] = useState<string | null>(null);
  const [width, setWidth] = useState(programFormat.width);
  const [height, setHeight] = useState(programFormat.height);
  const [rateIndex, setRateIndex] = useState(() =>
    Math.max(
      0,
      FRAME_RATES.findIndex(
        (rate) =>
          rate.numerator === programFormat.frameRate.numerator &&
          rate.denominator === programFormat.frameRate.denominator
      )
    )
  );

  const handleAdapterChange = (newAdapterId: string) => {
    setAdapterId(newAdapterId);
    if (newAdapterId === "ndi") {
      if (outputId === "out_1" || outputId === "") {
        setOutputId("ndi_program");
      }
    } else if (newAdapterId === "virtual") {
      if (outputId === "ndi_program" || outputId === "") {
        setOutputId("out_1");
      }
    }
  };

  const refresh = useCallback(async () => {
    if (!engineConnected) {
      setView(null);
      return;
    }
    try {
      setView(await playoutApi.outputs());
      setError(null);
    } catch (refreshError) {
      setView(null);
      setError(errorMessage(refreshError));
    }
  }, [engineConnected]);

  useEffect(() => {
    void refresh();
    // Frame counters move constantly while an output runs, so a slow poll is enough
    // to show progress without hammering the control service.
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Follow the project resolution while the form is untouched.
  useEffect(() => {
    if (!adding) {
      setWidth(programFormat.width);
      setHeight(programFormat.height);
    }
  }, [adding, programFormat.width, programFormat.height]);

  async function run(label: string, action: () => Promise<{ warnings: string[] }>) {
    setBusy(label);
    try {
      const result = await action();
      setWarnings(result.warnings);
      setError(null);
      await refresh();
    } catch (actionError) {
      setError(errorMessage(actionError));
    } finally {
      setBusy(null);
    }
  }

  const selectedAdapter = view?.availableAdapters.find(
    (adapter) => adapter.adapterId === adapterId
  );

  return (
    <div className="outputs-panel">
      <header className="outputs-header">
        <h3>
          <Radio size={15} />
          Outputs
        </h3>
        <div className="outputs-header-actions">
          <button
            className="icon-button"
            title="Refresh outputs"
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
          </button>
          <button
            className="small-button"
            disabled={!engineConnected}
            onClick={() => setAdding((current) => !current)}
          >
            <Plus size={13} />
            Add
          </button>
        </div>
      </header>

      {!engineConnected && (
        <p className="outputs-note">
          The render engine is not connected, so its outputs cannot be listed or
          changed. Program state lives in the engine; connecting again shows what is
          already running.
        </p>
      )}

      {error && <p className="outputs-error">{error}</p>}

      {warnings.length > 0 && (
        <ul className="outputs-warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {adding && view && (
        <div className="outputs-form">
          <label>
            <span>Adapter</span>
            <select
              value={adapterId}
              onChange={(event) => handleAdapterChange(event.target.value)}
            >
              {view.availableAdapters.map((adapter) => (
                <option
                  key={adapter.adapterId}
                  value={adapter.adapterId}
                  disabled={!adapter.available}
                >
                  {adapter.name}
                  {adapter.adapterId === "ndi"
                    ? " — NDI LIVE"
                    : adapter.live
                    ? " — LIVE"
                    : " — not live"}
                  {adapter.available ? "" : " (unavailable)"}
                </option>
              ))}
            </select>
          </label>

          {selectedAdapter && !selectedAdapter.available && (
            <p className="outputs-error">
              {selectedAdapter.unavailableReason ??
                "This adapter cannot run on this engine."}
            </p>
          )}
          {selectedAdapter?.available &&
            selectedAdapter.live &&
            !selectedAdapter.hardwareCertified && (
              <p className="outputs-warning-inline">
                {selectedAdapter.name} is a live adapter that has not been certified
                against hardware. Do not rely on it for a show.
              </p>
            )}
          {selectedAdapter?.available && !selectedAdapter.live && (
            <p className="outputs-note">
              {selectedAdapter.adapterId === "virtual"
                ? "Windowed: Program is shown locally at full resolution and never transmitted."
                : "Non-live: frames never reach a broadcast output."}
            </p>
          )}

          <label>
            <span>Output id</span>
            <input
              value={outputId}
              onChange={(event) => setOutputId(event.target.value)}
              spellCheck={false}
            />
          </label>
          {adapterId === "ndi" && (
            <>
              <label>
                <span>NDI Source Name</span>
                <input
                  value={ndiSourceName}
                  onChange={(event) => setNdiSourceName(event.target.value)}
                  placeholder="e.g. GrapiX Program Out"
                  spellCheck={false}
                />
              </label>

              <label>
                <span>NDI Groups (optional)</span>
                <input
                  value={ndiGroups}
                  onChange={(event) => setNdiGroups(event.target.value)}
                  placeholder="e.g. Public, StudioA"
                  spellCheck={false}
                />
              </label>

              <div className="ndi-format-chip">
                <Wifi size={12} />
                <span>Format: <strong>Progressive BGRA8 Premultiplied Alpha</strong> (Rec.709/sRGB)</span>
              </div>
            </>
          )}

          <div className="outputs-form-row">
            <label>
              <span>Width</span>
              <input
                type="number"
                value={width}
                min={16}
                onChange={(event) => setWidth(Number(event.target.value))}
              />
            </label>
            <label>
              <span>Height</span>
              <input
                type="number"
                value={height}
                min={16}
                onChange={(event) => setHeight(Number(event.target.value))}
              />
            </label>
            <label>
              <span>Rate</span>
              <select
                value={rateIndex}
                onChange={(event) => setRateIndex(Number(event.target.value))}
              >
                {FRAME_RATES.map((rate, index) => (
                  <option key={rate.label} value={index}>
                    {rate.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="outputs-note">
            Colour space {programFormat.colorSpace}, square pixels, from the project
            settings that govern every scene.
          </p>

          <div className="outputs-form-actions">
            <button
              disabled={
                busy !== null ||
                outputId.trim().length === 0 ||
                (adapterId === "ndi" && ndiSourceName.trim().length === 0) ||
                selectedAdapter?.available === false
              }
              onClick={() =>
                void run("configure", async () => {
                  const rate = FRAME_RATES[rateIndex]!;
                  const configuredOutputId = outputId.trim();
                  const optionsPayload: Record<string, string> = {};
                  if (adapterId === "ndi") {
                    optionsPayload.sourceName = ndiSourceName.trim();
                    if (ndiGroups.trim()) {
                      optionsPayload.groups = ndiGroups.trim();
                    }
                  }
                  const result = await playoutApi.configureOutput({
                    outputId: configuredOutputId,
                    adapterId,
                    width,
                    height,
                    frameRate: {
                      numerator: rate.numerator,
                      denominator: rate.denominator
                    },
                    colorSpace: programFormat.colorSpace,
                    ...(Object.keys(optionsPayload).length > 0 ? { options: optionsPayload } : {})
                  });
              if (adapterId === "virtual" && "__TAURI_INTERNALS__" in window) {
                await openVirtualOutputWindow(configuredOutputId);
              }
              setAdding(false);
              return result;
            })
          }
        >
          Configure
        </button>
        <button className="small-button" onClick={() => setAdding(false)}>
          Cancel
        </button>
      </div>
    </div>
  )}

  <ul className="outputs-list">
    {view?.outputs.map((output) => (
      <OutputRow
        key={output.outputId}
        output={output}
        busy={busy !== null}
        onAction={(action) =>
          void run(action, () => playoutApi.outputAction(output.outputId, action))
        }
      />
    ))}
    {view?.outputs.length === 0 && (
      <li className="outputs-empty">
        No output is configured. A take will render nowhere until one exists —
        add an NDI live output or a windowed virtual output to start rendering.
      </li>
    )}
  </ul>
</div>
);
}

function OutputRow({
output,
busy,
onAction
}: {
output: EngineOutputView;
busy: boolean;
onAction: (action: "start" | "stop" | "remove") => void;
}) {
const [copied, setCopied] = useState(false);
const running = output.state === "running";
const windowed = output.adapterId === "virtual";
const isNdi = output.adapterId === "ndi";

const handleCopySource = (sourceName: string) => {
void navigator.clipboard.writeText(sourceName);
setCopied(true);
setTimeout(() => setCopied(false), 2000);
};

return (
<li className={`output-row ${isNdi ? "ndi live" : output.live ? "live" : windowed ? "windowed" : "headless"} ${output.state}`}>
  <div className="output-identity">
    <span className={isNdi ? "output-badge ndi" : output.live ? "output-badge live" : windowed ? "output-badge windowed" : "output-badge headless"}>
      {isNdi ? (
        <>
          <Wifi size={11} /> NDI LIVE
        </>
      ) : output.live ? (
        <>
          <Radio size={11} /> LIVE
        </>
      ) : windowed ? (
        <>
          <Monitor size={11} /> WINDOWED
        </>
      ) : (
        <>
          <EyeOff size={11} /> NON-LIVE
        </>
      )}
    </span>
    {running && <span className="output-live-pulse" title="Live stream transmitting" />}
    <strong>{output.outputId}</strong>
    <small>{output.name}</small>
  </div>

  <div className="output-detail">
    {output.sourceName && (
      <span className="output-source-tag">
        <span>Stream: <strong>{output.sourceName}</strong></span>
        <button
          className="output-copy-btn"
          onClick={() => handleCopySource(output.sourceName!)}
          title="Copy NDI Source Name"
          type="button"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? "Copied!" : "Copy"}
        </button>
      </span>
    )}
    <span>
      {output.width}×{output.height} ·{" "}
      {formatRate(output.frameRateNumerator, output.frameRateDenominator)} ·{" "}
      {output.colorSpace}
    </span>
    <span className={`output-state ${output.state}`}>{output.state}</span>
    {running && (
      <span className="output-counters">
        {output.framesSent} sent
        {output.framesDropped > 0 ? ` · ${output.framesDropped} dropped` : ""}
      </span>
    )}
    {output.live && !output.hardwareCertified && (
      <span className="output-uncertified">uncertified live output (NDI 6.x)</span>
    )}
  </div>

      {output.lastError && <p className="outputs-error">{output.lastError}</p>}

      <div className="output-actions">
        {windowed ? (
          <button
            className="small-button"
            onClick={() => {
              void openVirtualOutputWindow(output.outputId)
                .then((opened) => {
                  if (!opened) {
                    window.alert(
                      "The windowed virtual output was blocked. Allow popups for GrapiX and try again."
                    );
                  }
                })
                .catch((openError: unknown) => {
                  window.alert(errorMessage(openError));
                });
            }}
            title="Open the local Program output window"
          >
            <ExternalLink size={12} /> Open window
          </button>
        ) : null}
        {running ? (
          <button className="small-button" disabled={busy} onClick={() => onAction("stop")}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="small-button" disabled={busy} onClick={() => onAction("start")}>
            <Play size={12} /> Start
          </button>
        )}
        <button
          className="small-button danger"
          disabled={busy}
          onClick={() => onAction("remove")}
          title={
            output.live && running
              ? "A running live output must be stopped before it can be removed"
              : "Remove this output"
          }
        >
          <Trash2 size={12} />
        </button>
      </div>
    </li>
  );
}

/** Show 29.97 rather than 30000/1001, but never round 30 to 29.97. */
function formatRate(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  const value = numerator / denominator;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} fps`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
