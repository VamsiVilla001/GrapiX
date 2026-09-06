// React 19 removed the global `JSX` namespace; it is now exported from React itself.
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { EngineCapabilities } from "@grapix/render-protocol";

import { EditorEngineClient, type EngineConnectionSnapshot } from "../rendering/engineClient";
import {
  describeBackendSelection,
  detectBackendAvailability,
  selectEditorBackend
} from "../rendering/rendererPreference";
import { useEditorStore } from "../store/editorStore";
import { currentAccessToken } from "../lib/auth";

/**
 * Render Engine panel.
 *
 * The Editor's window onto the standalone engine. It can connect, read
 * capabilities and diagnostics, publish the current scene for preview, and pull a
 * preview frame.
 *
 * What it deliberately cannot do is put anything on air. There is no Take control
 * here, and `EditorEngineClient` does not expose one — Program is Playout's
 * decision, and the absence of the verb is the enforcement.
 */
export function RenderEnginePanel(): JSX.Element {
  const scene = useEditorStore((state) => state.scene);

  const clientRef = useRef<EditorEngineClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new EditorEngineClient({ clientId: "grapix-editor" });
  }
  const client = clientRef.current;

  const [engines, setEngines] = useState<EngineConnectionSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<string | null>(null);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("4400");
  const [token, setToken] = useState("");

  // Local backend policy, reported alongside the engine so an operator can see
  // which renderer they are actually looking at.
  const backend = useMemo(
    () => selectEditorBackend({ availability: detectBackendAvailability() }),
    []
  );

  useEffect(() => {
    const refresh = () => setEngines(client.engines());
    const unsubscribe = client.subscribe(refresh);

    // Offer the loopback candidates without connecting to any of them.
    client.discoverLocalEngines();
    refresh();

    const timer = window.setInterval(() => client.tick(), 2_000);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      client.disconnectAll("editor panel closed");
    };
  }, [client]);

  const selected = engines.find((engine) => engine.profileId === selectedId) ?? engines[0];
  const capabilities: EngineCapabilities | null = selected
    ? client.capabilities(selected.profileId)
    : null;

  const run = useCallback(
    async (label: string, action: () => Promise<string | void>) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const result = await action();
        setMessage(typeof result === "string" ? result : `${label} succeeded`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const handleAdd = () => {
    const parsed = Number(port);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("port must be a positive number");
      return;
    }
    const record = client.addEngine(host.trim(), parsed);
    setSelectedId(record.profileId);
    setMessage(`added ${record.label}`);
  };

  const handleConnect = (profileId: string) =>
    run("connect", async () => {
      // The signed-in user's access token, unless the operator pasted a different one. This
      // is what makes the engine's audit rows name a person: the same credential that opened
      // the API opens the socket, so a scene load and the take that follows it are attributed
      // to the same account rather than to "the Editor".
      const credential = token.trim() || currentAccessToken() || undefined;
      const negotiated = await client.connect(profileId, credential);
      setSelectedId(profileId);
      return (
        `connected to ${negotiated.engineName} — ${negotiated.gpu.adapter} ` +
        `[${negotiated.gpu.backend}], max logical canvas ` +
        `${negotiated.limits.maxLogicalCanvasWidth}x${negotiated.limits.maxLogicalCanvasHeight}`
      );
    });

  const handlePublish = () => {
    if (!selected) return;
    void run("publish", async () => {
      // Pre-publish check first: the operator learns a stage will not fit before
      // anything is sent, which is the point of capability negotiation.
      const preflight = client.preflight(selected.profileId, scene);

      if (preflight.documentIssues.length > 0) {
        throw new Error(`scene cannot be published: ${preflight.documentIssues.join("; ")}`);
      }
      if (!preflight.publishable) {
        throw new Error(preflight.errors.map((issue) => issue.message).join("; "));
      }

      await client.publishForPreview(selected.profileId, scene);

      const warnings = preflight.warnings.map((issue) => issue.message);
      return warnings.length > 0
        ? `published "${scene.name}" with warnings: ${warnings.join("; ")}`
        : `published "${scene.name}" and prepared it`;
    });
  };

  const handlePreview = (showTileDebug: boolean) => {
    if (!selected) return;
    void run("preview", async () => {
      const frame = await client.requestPreview(selected.profileId, {
        maxWidth: 960,
        maxHeight: 540,
        showTileDebug
      });
      setPreviewSrc(`data:image/jpeg;base64,${frame.data}`);
      setPreviewInfo(
        `${frame.width}x${frame.height} at scale ${frame.renderScale.toFixed(4)} · ` +
          `frame ${frame.frame} · ${frame.renderMs.toFixed(1)} ms`
      );
      return `preview rendered in ${frame.renderMs.toFixed(1)} ms`;
    });
  };

  const handleDiagnostics = () => {
    if (!selected) return;
    void run("diagnostics", async () => {
      const diagnostics = (await client.diagnostics(selected.profileId, true)) as {
        tiles?: { totalTiles?: number; trackedTiles?: number; dirtyTiles?: number };
        stage?: { logicalWidth?: number; logicalHeight?: number; fullResolutionBytes?: number };
      };

      const tiles = diagnostics.tiles ?? {};
      const stage = diagnostics.stage ?? {};
      const gigabytes = ((stage.fullResolutionBytes ?? 0) / 1024 ** 3).toFixed(2);

      return (
        `stage ${stage.logicalWidth}x${stage.logicalHeight} ` +
        `(${gigabytes} GB if it were one texture — it never is) · ` +
        `${tiles.trackedTiles ?? 0}/${tiles.totalTiles ?? 0} tiles tracked, ` +
        `${tiles.dirtyTiles ?? 0} dirty`
      );
    });
  };

  return (
    <div className="render-engine-panel">
      <section className="render-engine-section">
        <h3>Local renderer</h3>
        {backend ? (
          <p className={backend.degraded ? "engine-warning" : "engine-muted"}>
            {backend.degraded
              ? describeBackendSelection(backend)
              : `Editor preview: ${backend.kind.toUpperCase()} — ${backend.reason}. The standalone engine remains authoritative for Program.`}
          </p>
        ) : (
          <p className="engine-error">
            No graphics backend is available; the editor preview cannot render.
          </p>
        )}
      </section>

      <section className="render-engine-section">
        <h3>Engines</h3>
        <div className="engine-add-row">
          <input
            aria-label="Engine host"
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="127.0.0.1"
          />
          <input
            aria-label="Engine port"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            placeholder="4400"
          />
          <button type="button" onClick={handleAdd}>
            Add
          </button>
        </div>
        <div className="engine-add-row">
          <input
            aria-label="Engine token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="bearer token (blank for a loopback engine)"
            type="password"
          />
        </div>

        <ul className="engine-list">
          {engines.map((engine) => (
            <li
              key={engine.profileId}
              className={engine.profileId === selected?.profileId ? "engine-row selected" : "engine-row"}
              onClick={() => setSelectedId(engine.profileId)}
            >
              <span className={`engine-state engine-state-${engine.state}`}>{engine.state}</span>
              <span className="engine-label">{engine.reportedName ?? engine.label}</span>
              <span className="engine-url">{engine.url}</span>
              <button
                type="button"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleConnect(engine.profileId);
                }}
              >
                {engine.state === "offline" || engine.state === "error" ? "Connect" : "Reconnect"}
              </button>
            </li>
          ))}
          {engines.length === 0 && <li className="engine-muted">No engines registered.</li>}
        </ul>
      </section>

      {capabilities && (
        <section className="render-engine-section">
          <h3>{capabilities.engineName}</h3>
          <dl className="engine-facts">
            <dt>Engine id</dt>
            <dd>{capabilities.engineId}</dd>
            <dt>Version</dt>
            <dd>
              {capabilities.softwareVersion} · protocol v{capabilities.protocolVersion}
            </dd>
            <dt>GPU</dt>
            <dd>
              {capabilities.gpu.adapter} ({capabilities.gpu.backend},{" "}
              {capabilities.gpu.deviceType})
            </dd>
            <dt>Max texture</dt>
            <dd>{capabilities.limits.maxTextureDimension2d} px</dd>
            <dt>Max logical canvas</dt>
            <dd>
              {capabilities.limits.maxLogicalCanvasWidth} ×{" "}
              {capabilities.limits.maxLogicalCanvasHeight}
            </dd>
            <dt>Tile rendering</dt>
            <dd>{capabilities.features.tileRendering ? "yes" : "no"}</dd>
            <dt>Headless</dt>
            <dd>{capabilities.features.headlessRendering ? "yes" : "no"}</dd>
            <dt>Transitions</dt>
            <dd>{capabilities.supportedTransitions.join(", ") || "none"}</dd>
            <dt>Video decode</dt>
            <dd>
              {capabilities.features.nativeVideoDecode
                ? capabilities.supportedVideoFormats.join(", ")
                : "not supported"}
            </dd>
          </dl>

          {capabilities.outputAdapters.length > 0 && (
            <ul className="engine-adapters">
              {capabilities.outputAdapters.map((adapter) => (
                <li key={adapter.adapterId}>
                  <strong>{adapter.name}</strong>{" "}
                  {adapter.available ? (
                    adapter.hardwareCertified ? (
                      <span className="engine-muted">available, certified</span>
                    ) : (
                      <span className="engine-warning">
                        available, not certified against hardware
                      </span>
                    )
                  ) : (
                    <span className="engine-error">
                      unavailable — {adapter.unavailableReason ?? "unknown reason"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="render-engine-section">
        <h3>Scene</h3>
        <div className="engine-actions">
          <button type="button" disabled={busy || !selected?.authenticated} onClick={handlePublish}>
            Publish for preview
          </button>
          <button
            type="button"
            disabled={busy || !selected?.authenticated}
            onClick={() => handlePreview(false)}
          >
            Request preview
          </button>
          <button
            type="button"
            disabled={busy || !selected?.authenticated}
            onClick={() => handlePreview(true)}
          >
            Preview with tile grid
          </button>
          <button
            type="button"
            disabled={busy || !selected?.authenticated}
            onClick={handleDiagnostics}
          >
            Diagnostics
          </button>
        </div>
        {/* No Take control: Program is Playout's decision, and the Editor's
            client does not expose the verb. */}
        <p className="engine-muted">
          The Editor can publish and preview. Taking a scene to Program is done from
          Playout.
        </p>
      </section>

      {message && <p className="engine-message">{message}</p>}
      {error && <p className="engine-error">{error}</p>}

      {previewSrc && (
        <section className="render-engine-section">
          <h3>Engine preview</h3>
          <img className="engine-preview" src={previewSrc} alt="Render engine preview" />
          {previewInfo && <p className="engine-muted">{previewInfo}</p>}
        </section>
      )}
    </div>
  );
}
