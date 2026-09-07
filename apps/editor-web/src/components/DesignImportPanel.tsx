import type { DesignIRSummary, ImportWarning } from "@grapix/design-ir";
import { AlertTriangle, FileUp, Info, Loader2, RefreshCw, Trash2, Type } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteDesignOnApi,
  importDesignFileOnApi,
  importFigmaOnApi,
  listDesignsFromApi
} from "../lib/apiClient";
import { useProfileStore } from "../store/profileStore";
import { CollapsiblePanel, CollapsibleSection } from "./Collapsible";

/**
 * Design ingest, replacing the old Object Library.
 *
 * GrapiX no longer creates artwork, so this panel is where scenes begin: import from
 * Figma (plugin or REST fallback), PSD or Illustrator, then review what the importer had
 * to approximate before anything gets rigged.
 */
export function DesignImportPanel() {
  const activeProfile = useProfileStore((state) => state.activeProfile);
  const setFigmaToken = useProfileStore((state) => state.setFigmaToken);

  const [designs, setDesigns] = useState<DesignIRSummary[]>([]);
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);
  const [figmaTarget, setFigmaTarget] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasFigmaToken = activeProfile?.credentialHints.figmaToken.present ?? false;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDesigns(await listDesignsFromApi());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not list designs.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runImport = async (
    label: string,
    action: () => Promise<{ design: DesignIRSummary; warnings: ImportWarning[] }>
  ): Promise<void> => {
    setBusy(label);
    setError(null);
    setNotice(null);
    setWarnings([]);

    try {
      const result = await action();
      setWarnings(result.warnings);
      setNotice(
        `Imported ${result.design.nodeCount} nodes from ${result.design.sourceFileName} — ${result.design.tokenCount} binding token(s).`
      );
      await refresh();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Import failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <CollapsiblePanel title="Design Import">
      <CollapsibleSection title="Figma">
        <p className="import-hint">
          Best fidelity comes from the GrapiX Figma plugin — it sends real vector paths and text
          runs. The URL import below is the fallback and needs a token on this profile.
        </p>

        <input
          className="import-input"
          onChange={(event) => setFigmaTarget(event.target.value)}
          placeholder="Paste a Figma file or frame URL"
          value={figmaTarget}
        />

        <button
          className="import-button"
          disabled={busy !== null || !figmaTarget.trim() || !activeProfile || !hasFigmaToken}
          onClick={() =>
            void runImport("figma", () =>
              importFigmaOnApi({
                profileId: activeProfile?.profileId ?? "",
                target: figmaTarget.trim()
              })
            )
          }
          type="button"
        >
          {busy === "figma" ? <Loader2 className="import-spin" size={14} /> : <Type size={14} />}
          Import from Figma URL
        </button>

        {hasFigmaToken ? (
          <p className="import-hint">
            Using token ····{activeProfile?.credentialHints.figmaToken.last4} from this profile.
          </p>
        ) : (
          <div className="import-token-form">
            <p className="import-hint">
              This profile has no Figma token, so URL import is disabled. Paste one to enable it.
            </p>
            <input
              className="import-input"
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="figd_…"
              type="password"
              value={tokenDraft}
            />
            <button
              className="import-button"
              disabled={!tokenDraft.trim()}
              onClick={() => {
                void setFigmaToken(tokenDraft.trim()).then(() => {
                  setTokenDraft("");
                  setNotice("Figma token saved to this profile.");
                });
              }}
              type="button"
            >
              Save token to profile
            </button>
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Photoshop and Illustrator">
        <p className="import-hint">
          PSD imports layer structure, text and solid fills. Illustrator reads the PDF stream, so
          save with &ldquo;Create PDF Compatible File&rdquo; enabled.
        </p>

        <input
          accept=".psd,.psb,.ai,.pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file) {
              void runImport("file", () => importDesignFileOnApi(file));
            }

            event.target.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />

        <button
          className="import-button"
          disabled={busy !== null}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          {busy === "file" ? <Loader2 className="import-spin" size={14} /> : <FileUp size={14} />}
          Choose a PSD or AI file
        </button>
      </CollapsibleSection>

      {error ? <div className="import-error">{error}</div> : null}
      {notice ? <div className="import-notice">{notice}</div> : null}

      {warnings.length ? (
        <CollapsibleSection title={`Import notes (${warnings.length})`}>
          <ul className="import-warnings">
            {warnings.map((warning, index) => (
              <li className={`import-warning import-warning-${warning.severity}`} key={index}>
                {warning.severity === "info" ? (
                  <Info size={13} />
                ) : (
                  <AlertTriangle size={13} />
                )}
                <span>
                  <strong>{warning.code}</strong> {warning.message}
                  {warning.sourcePath ? <em> ({warning.sourcePath})</em> : null}
                </span>
              </li>
            ))}
          </ul>
        </CollapsibleSection>
      ) : null}

      <CollapsibleSection title={`Imported designs (${designs.length})`}>
        <button className="import-button" onClick={() => void refresh()} type="button">
          <RefreshCw size={14} /> Refresh
        </button>

        {designs.length ? (
          <ul className="import-design-list">
            {designs.map((design) => (
              <li className="import-design" key={design.designId}>
                <div className="import-design-main">
                  <span className="import-design-name">{design.sourceFileName}</span>
                  <span className="import-design-meta">
                    {design.source.toUpperCase()} · {design.nodeCount} nodes ·{" "}
                    {design.textNodeCount} text · {design.tokenCount} tokens ·{" "}
                    {design.canvas.width}×{design.canvas.height}
                    {design.errorCount ? ` · ${design.errorCount} error(s)` : ""}
                    {design.warningCount ? ` · ${design.warningCount} warning(s)` : ""}
                  </span>
                </div>
                <button
                  className="import-icon-button"
                  onClick={() => {
                    if (window.confirm(`Delete imported design "${design.sourceFileName}"?`)) {
                      void deleteDesignOnApi(design.designId).then(refresh);
                    }
                  }}
                  title="Delete design"
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="import-hint">Nothing imported yet.</p>
        )}
      </CollapsibleSection>
    </CollapsiblePanel>
  );
}
