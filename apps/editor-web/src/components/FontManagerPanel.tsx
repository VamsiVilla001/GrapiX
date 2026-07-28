import type { AssetLibraryItem, FontDefinition, FontLoadStatus } from "@grapix/shared-types";
import {
  CheckCircle2,
  CircleAlert,
  FileUp,
  Link2,
  Power,
  RefreshCw,
  Search,
  Trash2,
  Type
} from "lucide-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  importFontFileToApi,
  resolveRemoteFontsOnApi,
  type ApiImportedAsset
} from "../lib/apiClient";
import { projectFontRegistry } from "../fonts/ProjectFontRegistry";
import { useEditorStore } from "../store/editorStore";

type ImportSource = "files" | "google-fonts" | "css-url" | "adobe-fonts" | "direct-url";

export function FontManagerPanel() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const addFontDefinitions = useEditorStore((state) => state.addFontDefinitions);
  const updateFontDefinition = useEditorStore((state) => state.updateFontDefinition);
  const replaceFontDefinition = useEditorStore((state) => state.replaceFontDefinition);
  const removeFontDefinition = useEditorStore((state) => state.removeFontDefinition);
  const assignFontToSelectedText = useEditorStore((state) => state.assignFontToSelectedText);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [family, setFamily] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [source, setSource] = useState<ImportSource>("files");
  const [sourceValue, setSourceValue] = useState("");
  const [license, setLicense] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | FontLoadStatus>("ALL");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const fontRevision = useSyncExternalStore(
    projectFontRegistry.subscribe,
    projectFontRegistry.snapshot,
    projectFontRegistry.snapshot
  );
  const selected = scene.objects.find((object) => object.id === selectedObjectId);
  const fonts = useMemo(() => (scene.fonts ?? []).filter((font) => {
    const runtimeStatus = projectFontRegistry.get(font.fontId)?.status ?? font.status;
    return (statusFilter === "ALL" || runtimeStatus === statusFilter)
      && `${font.displayName} ${font.family} ${font.sourceLabel ?? ""}`
        .toLowerCase().includes(search.trim().toLowerCase());
  }), [fontRevision, scene.fonts, search, statusFilter]);

  async function importFiles(files: FileList | File[]) {
    if (!files.length) return;
    setBusy(true);
    setMessage(`Reading ${files.length} font file${files.length === 1 ? "" : "s"}…`);
    try {
      const results = await Promise.all([...files].map((file) => importFontFileToApi(file, {
        family: family.trim() || undefined,
        displayName: displayName.trim() || undefined,
        license: license.trim() || undefined
      })));
      const importedAssets = results.map((result) => importedFontAsset(result.asset));
      if (replaceTarget) {
        replaceFontDefinition(replaceTarget, results[0]!.font, [importedAssets[0]!]);
        setReplaceTarget(null);
        setMessage(`${results[0]!.font.displayName} replaced. Existing text assignments were preserved.`);
      } else {
        addFontDefinitions(results.map((result) => result.font), importedAssets);
        setMessage(`${results.length} face${results.length === 1 ? "" : "s"} imported and registered.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Font import failed");
    } finally {
      setBusy(false);
    }
  }

  async function resolveLink() {
    setBusy(true);
    setMessage("Resolving stylesheet and font faces…");
    try {
      const value = sourceValue.trim();
      const request = source === "google-fonts"
        ? {
            source: "css-url" as const,
            url: googleCssUrl(value),
            family: family.trim() || undefined
          }
        : source === "adobe-fonts"
          ? { source, projectId: adobeProjectId(value) }
          : {
              source: source as "css-url" | "direct-url",
              url: extractCssUrl(value),
              family: family.trim() || undefined
            };
      const result = await resolveRemoteFontsOnApi({
        ...request,
        displayName: displayName.trim() || undefined,
        license: license.trim() || undefined
      });
      addFontDefinitions(result.fonts, result.assets.map(importedFontAsset));
      setMessage(
        `${result.fonts.length} famil${result.fonts.length === 1 ? "y" : "ies"} resolved, downloaded, and packaged.`
        + (result.warnings.length ? ` ${result.warnings.join(" ")}` : "")
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Font link failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="font-manager-panel">
      <header className="font-manager-header">
        <div>
          <strong>Project Fonts</strong>
          <span>{scene.fonts?.length ?? 0} families · managed project-wide</span>
        </div>
        <label className="font-search">
          <Search size={13} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search fonts" />
        </label>
      </header>

      <div className="font-import-card">
        <div className="font-source-tabs">
          {(["files", "google-fonts", "css-url", "adobe-fonts", "direct-url"] as ImportSource[]).map((item) => (
            <button className={source === item ? "active" : ""} key={item} onClick={() => setSource(item)}>
              {sourceLabel(item)}
            </button>
          ))}
        </div>
        <div className="font-import-fields">
          <input value={family} onChange={(event) => setFamily(event.target.value)} placeholder="Family override (optional)" />
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Display name (optional)" />
          <input value={license} onChange={(event) => setLicense(event.target.value)} placeholder="License/source note (optional)" />
        </div>
        {source === "files" ? (
          <button disabled={busy} onClick={() => inputRef.current?.click()}>
            <FileUp size={13} /> Import OTF, TTF, WOFF, or WOFF2 faces
          </button>
        ) : (
          <div className="font-link-row">
            <input
              value={sourceValue}
              onChange={(event) => setSourceValue(event.target.value)}
              placeholder={sourcePlaceholder(source)}
            />
            <button disabled={busy || !sourceValue.trim()} onClick={() => void resolveLink()}>
              <Link2 size={13} /> Resolve
            </button>
          </div>
        )}
        <input
          accept=".otf,.ttf,.woff,.woff2"
          hidden
          multiple
          ref={inputRef}
          type="file"
          onChange={(event) => {
            if (event.target.files) void importFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          accept=".otf,.ttf,.woff,.woff2"
          hidden
          ref={replaceInputRef}
          type="file"
          onChange={(event) => {
            if (event.target.files) void importFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <div className="font-filter-row">
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
          <option value="ALL">All states</option>
          {(["LOADING", "READY", "MISSING", "INVALID", "UNSUPPORTED", "UNVERIFIED", "ERROR"] as FontLoadStatus[]).map((status) => (
            <option key={status} value={status}>{status.toLowerCase()}</option>
          ))}
        </select>
        <span>Font files are deduplicated by checksum and stored with the project.</span>
      </div>

      <div className="manager-list font-family-list">
        {fonts.map((font) => {
          const runtime = projectFontRegistry.get(font.fontId);
          const status = runtime?.status ?? font.status;
          return (
            <article className={`font-family-card status-${status.toLowerCase()}`} key={font.fontId}>
              <div className="font-card-top">
                <label className="font-enabled" title="Enable or disable this family">
                  <input
                    checked={font.enabled !== false}
                    onChange={(event) => updateFontDefinition(font.fontId, { enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <Power size={13} />
                </label>
                <div className="font-preview" style={{ fontFamily: `"${font.family}"` }}>
                  Ag مرحبا नमस्ते 0123
                </div>
                <StatusBadge status={status} />
              </div>
              <div className="font-card-details">
                <input
                  aria-label={`Display name for ${font.family}`}
                  className="font-display-name"
                  defaultValue={font.displayName}
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (value && value !== font.displayName) updateFontDefinition(font.fontId, { displayName: value });
                  }}
                />
                <span>{font.family}</span>
                <span>{font.sourceLabel ?? sourceSummary(font)}</span>
                <div className="font-face-pills">
                  {font.faces.map((face) => {
                    const faceStatus = runtime?.faces.find((item) => item.faceId === face.faceId);
                    return (
                      <span key={face.faceId} title={faceStatus?.errorMessage ?? face.errorMessage}>
                        {face.weight} {face.style}{face.stretch ? ` · ${face.stretch}` : ""}
                      </span>
                    );
                  })}
                </div>
                <label className="font-fallbacks">
                  Fallbacks
                  <input
                    defaultValue={font.fallbackFamilies.join(", ")}
                    onBlur={(event) => updateFontDefinition(font.fontId, {
                      fallbackFamilies: uniqueFamilies(event.target.value)
                    })}
                  />
                </label>
                {runtime?.errorMessage ? <p className="font-error"><CircleAlert size={12} /> {runtime.errorMessage}</p> : null}
              </div>
              <div className="font-card-actions">
                <button
                  disabled={selected?.type !== "text" || font.enabled === false || status !== "READY"}
                  onClick={() => assignFontToSelectedText(font.fontId)}
                  title="Assign to selected text object"
                >
                  <Type size={13} /> Assign
                </button>
                <button
                  onClick={() => {
                    setReplaceTarget(font.fontId);
                    replaceInputRef.current?.click();
                  }}
                  title="Replace missing or changed font file without breaking text assignments"
                >
                  <RefreshCw size={13} /> Replace
                </button>
                <button onClick={() => removeFontDefinition(font.fontId)} title="Remove this font definition only">
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          );
        })}
        {!fonts.length ? <div className="empty-panel">No fonts match this filter</div> : null}
      </div>
      {message ? <p className="manager-message" role="status">{busy ? "Working: " : ""}{message}</p> : null}
    </section>
  );
}

function StatusBadge({ status }: { status: FontLoadStatus }) {
  return (
    <span className={`font-status status-${status.toLowerCase()}`}>
      {status === "READY" ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
      {status.toLowerCase()}
    </span>
  );
}

function importedFontAsset(asset: ApiImportedAsset & { kind: "font" }): AssetLibraryItem {
  return {
    assetId: asset.assetId,
    storageAssetId: asset.assetId,
    name: asset.fileName,
    kind: "font",
    source: asset.contentUrl,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    checksum: asset.checksum,
    importedAt: asset.importedAt,
    status: "READY"
  };
}

function sourceLabel(source: ImportSource): string {
  return ({
    files: "Files",
    "google-fonts": "Google Fonts",
    "css-url": "CSS / @import",
    "adobe-fonts": "Adobe Fonts",
    "direct-url": "Direct URL"
  })[source];
}

function sourcePlaceholder(source: Exclude<ImportSource, "files">): string {
  if (source === "google-fonts") return "Family name or Google Fonts CSS URL";
  if (source === "adobe-fonts") return "Adobe project ID or https://use.typekit.net/…";
  if (source === "direct-url") return "https://example.com/font.woff2";
  return "Stylesheet URL, <link href=…>, or @import url(…)";
}

function extractCssUrl(value: string): string {
  const match = value.match(/(?:href\s*=\s*|url\(\s*)["']?([^"')\s>]+)["']?/i);
  return match?.[1] ?? value;
}

function googleCssUrl(value: string): string {
  const extracted = extractCssUrl(value);
  if (/^https:\/\/fonts\.googleapis\.com\//i.test(extracted)) return extracted;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(value).replace(/%20/g, "+")}&display=swap`;
}

function adobeProjectId(value: string): string {
  return value.match(/use\.typekit\.net\/([a-z0-9]+)/i)?.[1] ?? value;
}

function uniqueFamilies(value: string): string[] {
  const seen = new Set<string>();
  return value.split(",").map((item) => item.trim()).filter((item) =>
    item.length > 0 && !seen.has(item.toLowerCase()) && !!seen.add(item.toLowerCase())
  ).slice(0, 12);
}

function sourceSummary(font: FontDefinition): string {
  const kinds = [...new Set(font.faces.map((face) => face.source.kind))];
  return `${kinds.join(", ")} · ${font.embeddingPolicy}`;
}
