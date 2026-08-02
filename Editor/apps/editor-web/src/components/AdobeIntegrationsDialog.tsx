import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { AdobeApp, AdobeApplicationStatus } from "@grapix/adobe-common-schema";
import { describeApplication } from "../lib/adobeStatus";
import { useAdobeStore } from "../store/adobeStore";

const APPLICATIONS: { app: AdobeApp; label: string; bridge: string }[] = [
  { app: "photoshop", label: "Photoshop", bridge: "UXP plugin" },
  { app: "after-effects", label: "After Effects", bridge: "ExtendScript/CEP panel" }
];

/**
 * Settings › Integrations › Adobe.
 *
 * Reports what is actually reachable rather than what is configured: an application is
 * "connected" only while its bridge holds a socket on the gateway, and every mutating
 * tool stays refused until the operator approves this session here.
 */
export function AdobeIntegrationsDialog({ onClose }: { onClose: () => void }) {
  const connection = useAdobeStore((state) => state.connection);
  const detail = useAdobeStore((state) => state.detail);
  const status = useAdobeStore((state) => state.status);
  const logs = useAdobeStore((state) => state.logs);
  const approved = useAdobeStore((state) => state.approved);
  const busy = useAdobeStore((state) => state.busy);
  const error = useAdobeStore((state) => state.error);

  const connect = useAdobeStore((state) => state.connect);
  const disconnect = useAdobeStore((state) => state.disconnect);
  const refresh = useAdobeStore((state) => state.refresh);
  const refreshLogs = useAdobeStore((state) => state.refreshLogs);
  const setApproval = useAdobeStore((state) => state.setApproval);
  const restartBridge = useAdobeStore((state) => state.restartBridge);

  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);

  useEffect(() => {
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, busy]);

  const connected = connection === "connected";

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
    >
      <div
        className="material-create-dialog adobe-integrations-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="adobe-integrations-title"
      >
        <header>
          <strong id="adobe-integrations-title">Integrations · Adobe</strong>
          <button aria-label="Close" disabled={busy} onClick={onClose} type="button">×</button>
        </header>

        <p className="material-dialog-note">
          GrapiX talks to Photoshop and After Effects through a local gateway on
          port 4784. Each application needs its own bridge running inside it — a UXP plugin for
          Photoshop, an ExtendScript panel for After Effects. Nothing leaves this machine.
        </p>

        <section className="adobe-gateway-row">
          <span className={`adobe-state adobe-state-${connection}`}>
            Gateway {connection}
            {detail ? ` — ${detail}` : ""}
          </span>
          <span className="adobe-gateway-meta">
            {status ? `v${status.gatewayVersion} · ${status.protocol} · port ${status.port}` : "not reporting"}
          </span>
          <span className="adobe-gateway-actions">
            <button disabled={busy || connected} onClick={() => void connect()} type="button">
              {busy && !connected ? "Connecting…" : "Connect"}
            </button>
            <button disabled={!connected} onClick={disconnect} type="button">Disconnect</button>
            <button disabled={!connected} onClick={() => void refresh()} type="button">Refresh</button>
          </span>
        </section>

        <section className="adobe-approval-row">
          <label>
            <input
              checked={approved}
              disabled={!connected}
              onChange={(event) => void setApproval(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>Allow GrapiX to modify open Adobe documents</strong>
              <small>
                Read tools always work. Creating layers, writing text and importing a scene stay
                refused until this is on, and it clears whenever the gateway reconnects.
              </small>
            </span>
          </label>
        </section>

        <div className="adobe-application-list">
          {APPLICATIONS.map(({ app, label, bridge }) => (
            <ApplicationCard
              bridge={bridge}
              busy={busy}
              connected={connected}
              key={app}
              label={label}
              onRestart={() => void restartBridge(app)}
              status={status?.applications[app]}
            />
          ))}
        </div>

        {error ? <p className="publish-playout-error">{error}</p> : null}

        {showLogs ? (
          <section className="adobe-log-view" aria-label="Gateway log">
            {logs.length === 0 ? (
              <p className="material-dialog-note">No gateway activity recorded yet.</p>
            ) : (
              <ol>
                {logs.map((entry, index) => (
                  <li className={`adobe-log-${entry.level}`} key={`${entry.timestamp}-${index}`}>
                    <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                    <span className="adobe-log-source">{entry.source}</span>
                    <span>{entry.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}

        <footer>
          <button
            disabled={!connected}
            onClick={() => {
              setShowLogs((visible) => !visible);
              void refreshLogs();
            }}
            type="button"
          >
            {showLogs ? "Hide logs" : "View logs"}
          </button>
          <button className="primary" disabled={busy} onClick={onClose} type="button">Done</button>
        </footer>
      </div>
    </div>,
    document.body
  );
}

function ApplicationCard({
  bridge,
  busy,
  connected,
  label,
  onRestart,
  status
}: {
  bridge: string;
  busy: boolean;
  connected: boolean;
  label: string;
  onRestart: () => void;
  status?: AdobeApplicationStatus;
}) {
  const view = describeApplication(label, status);
  const bridgeUp = view.availability === "Connected";
  const stateClass = bridgeUp ? "connected" : view.cloudReady ? "connecting" : "disconnected";

  return (
    <article className={`adobe-application ${bridgeUp || view.cloudReady ? "is-connected" : "is-offline"}`}>
      <header>
        <strong>{label}</strong>
        <span className={`adobe-state adobe-state-${stateClass}`}>{view.availability}</span>
      </header>

      <dl>
        <div>
          <dt>Local plugin</dt>
          <dd>{status?.connected ? `${bridge} v${status.bridgeVersion ?? "?"}` : `${bridge} — not running`}</dd>
        </div>
        <div>
          <dt>Application version</dt>
          <dd>{status?.version ?? "—"}</dd>
        </div>
        <div>
          <dt>Adobe cloud API</dt>
          <dd>{view.cloudReady ? "Configured" : (status?.cloudDetail ?? "Not configured")}</dd>
        </div>
        <div>
          <dt>Active document</dt>
          <dd>{status?.activeDocument ?? "—"}</dd>
        </div>
        <div>
          <dt>Permissions</dt>
          <dd>{status?.permissionsStatus ?? "pending"}</dd>
        </div>
      </dl>

      {view.guidance ? <p className="material-dialog-note">{view.guidance}</p> : null}

      <footer>
        <button disabled={!connected || busy || !view.canRestart} onClick={onRestart} type="button">
          Restart bridge
        </button>
      </footer>
    </article>
  );
}
