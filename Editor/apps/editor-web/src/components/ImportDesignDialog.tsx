import {
  DEFAULT_DESIGN_IMPORT_OPTIONS,
  type DesignImportOptions,
  type DesignImportResult,
  type NormalizedDesignNode,
  type SceneDocument
} from "@grapix/shared-types";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { importDesignFileToApi, importFigmaDesignToApi } from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";

type SourceMode = "file" | "figma";

export function ImportDesignDialog({ onClose }: { onClose: () => void }) {
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const applyImportedScene = useEditorStore((state) => state.applyImportedScene);
  const createTemplateFromScene = useTemplateStore((state) => state.createTemplateFromScene);
  const [sourceMode, setSourceMode] = useState<SourceMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [figmaSource, setFigmaSource] = useState({ fileKey: "", accessToken: "", nodeIds: "" });
  const [options, setOptions] = useState<DesignImportOptions>(DEFAULT_DESIGN_IMPORT_OPTIONS);
  const [destination, setDestination] = useState<"replace" | "merge">(hasActiveScene ? "merge" : "replace");
  const [phase, setPhase] = useState<"idle" | "reading" | "parsing" | "converting" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<DesignImportResult | null>(null);
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [reportView, setReportView] = useState<"summary" | "issues">("summary");

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape" && phase !== "parsing" && phase !== "converting") onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose, phase]);

  const canAnalyze = sourceMode === "file"
    ? Boolean(file)
    : Boolean(figmaSource.fileKey.trim() && figmaSource.accessToken.trim());
  const selectedScenes = useMemo(
    () => result?.scenes
      .filter((scene) => selectedSceneIds.includes(scene.id))
      .map((scene) => filterImportedScene(scene, new Set(selectedNodeIds))) ?? [],
    [result, selectedSceneIds, selectedNodeIds]
  );

  async function analyze() {
    if (!canAnalyze) return;
    setError("");
    setResult(null);
    setPhase("reading");
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      setPhase("parsing");
      const imported = sourceMode === "file"
        ? await importDesignFileToApi(file!, options)
        : await importFigmaDesignToApi({
            fileKey: figmaSource.fileKey,
            accessToken: figmaSource.accessToken,
            nodeIds: figmaSource.nodeIds.split(",").map((value) => value.trim()).filter(Boolean)
          }, options);
      setPhase("converting");
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      setResult(imported);
      setSelectedSceneIds(imported.scenes.map((scene) => scene.id));
      setSelectedNodeIds(imported.document.pages.flatMap((page) => collectNodeIds(page.nodes)));
      setPhase("ready");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Design import failed");
      setPhase("error");
    }
  }

  function completeImport() {
    if (!selectedScenes.length) return;
    const [primary, ...additional] = selectedScenes;
    applyImportedScene(primary, destination);
    additional.forEach(createTemplateFromScene);
    onClose();
  }

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && phase !== "parsing" && phase !== "converting") onClose();
      }}
    >
      <section
        aria-labelledby="design-import-title"
        aria-modal="true"
        className="material-create-dialog design-import-dialog"
        role="dialog"
      >
        <header>
          <div>
            <strong id="design-import-title">Import Design File</strong>
            <span>PSD · Illustrator · Figma</span>
          </div>
          <button aria-label="Close design import" disabled={phase === "parsing" || phase === "converting"} onClick={onClose} type="button">×</button>
        </header>

        <div className="design-import-source-tabs" role="tablist" aria-label="Design source">
          <button className={sourceMode === "file" ? "active" : ""} onClick={() => setSourceMode("file")} role="tab" type="button">File upload</button>
          <button className={sourceMode === "figma" ? "active" : ""} onClick={() => setSourceMode("figma")} role="tab" type="button">Figma API</button>
        </div>

        {sourceMode === "file" ? (
          <label className="design-file-drop">
            <span>{file ? file.name : "Choose a PSD, AI/PDF, SVG, or exported Figma JSON file"}</span>
            <input
              accept=".psd,.ai,.pdf,.svg,.json,.figma.json,application/pdf,image/vnd.adobe.photoshop,image/svg+xml,application/json"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
        ) : (
          <div className="design-import-figma-fields">
            <label>Figma URL or file key<input value={figmaSource.fileKey} onChange={(event) => setFigmaSource((current) => ({ ...current, fileKey: event.target.value }))} /></label>
            <label>Personal access token<input autoComplete="off" type="password" value={figmaSource.accessToken} onChange={(event) => setFigmaSource((current) => ({ ...current, accessToken: event.target.value }))} /></label>
            <label>Selected node IDs, comma separated<input placeholder="Optional" value={figmaSource.nodeIds} onChange={(event) => setFigmaSource((current) => ({ ...current, nodeIds: event.target.value }))} /></label>
            <p>The token is sent only to the local GrapiX API and is not stored in the project or import report.</p>
          </div>
        )}

        <ImportOptions options={options} setOptions={setOptions} destination={destination} setDestination={setDestination} hasActiveScene={hasActiveScene} />

        {phase !== "idle" && phase !== "ready" && phase !== "error" ? (
          <div className="design-import-progress" role="status">
            <progress />
            <span>{phase === "reading" ? "Reading source…" : phase === "parsing" ? "Parsing layers and assets…" : "Converting native GrapiX objects…"}</span>
          </div>
        ) : null}
        {error ? <div className="design-import-error" role="alert">{error}</div> : null}

        {result ? (
          <div className="design-import-results">
            <section>
              <strong>Pages and artboards</strong>
              <div className="design-import-scenes">
                {result.scenes.map((scene, index) => (
                  <div className="design-import-scene" key={scene.id}>
                    <label>
                      <input
                        checked={selectedSceneIds.includes(scene.id)}
                        onChange={(event) => setSelectedSceneIds((current) => event.target.checked
                          ? [...current, scene.id]
                          : current.filter((id) => id !== scene.id))}
                        type="checkbox"
                      />
                      <span>{scene.name}</span>
                      <small>{scene.canvas.width} × {scene.canvas.height} · {scene.objects.length} objects</small>
                    </label>
                    {selectedSceneIds.includes(scene.id) ? (
                      <div className="design-import-layer-tree" aria-label={`${scene.name} layers`}>
                        {result.document.pages[index]?.nodes.map((node) => (
                          <DesignNodeTree
                            key={node.id}
                            node={node}
                            selected={new Set(selectedNodeIds)}
                            onToggle={(target, checked) => setSelectedNodeIds((current) => {
                              const next = new Set(current);
                              collectNodeIds([target]).forEach((id) => checked ? next.add(id) : next.delete(id));
                              return [...next];
                            })}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
            <section className="design-import-report">
              <div className="design-import-report-tabs">
                <button className={reportView === "summary" ? "active" : ""} onClick={() => setReportView("summary")} type="button">Report summary</button>
                <button className={reportView === "issues" ? "active" : ""} onClick={() => setReportView("issues")} type="button">Issues ({result.report.issues.length})</button>
              </div>
              {reportView === "summary" ? <ReportSummary result={result} /> : (
                <div className="design-import-issues">
                  {result.report.issues.length ? result.report.issues.map((issue) => (
                    <article className={`severity-${issue.severity}`} key={issue.id}>
                      <strong>{issue.kind.replaceAll("-", " ")}</strong>
                      <span>{issue.message}</span>
                      {issue.fallback ? <small>Fallback: {issue.fallback}</small> : null}
                    </article>
                  )) : <span>No compatibility issues were reported.</span>}
                </div>
              )}
            </section>
          </div>
        ) : null}

        <footer>
          <button onClick={onClose} type="button">Cancel</button>
          {!result ? (
            <button className="primary" disabled={!canAnalyze || phase === "parsing" || phase === "converting"} onClick={() => void analyze()} type="button">Analyze design</button>
          ) : (
            <>
              <button onClick={() => { setResult(null); setPhase("idle"); }} type="button">Choose another</button>
              <button className="primary" disabled={!selectedScenes.length} onClick={completeImport} type="button">
                Import {selectedScenes.length} {selectedScenes.length === 1 ? "scene" : "scenes"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body
  );
}

function ImportOptions(props: {
  options: DesignImportOptions;
  setOptions: React.Dispatch<React.SetStateAction<DesignImportOptions>>;
  destination: "replace" | "merge";
  setDestination: (value: "replace" | "merge") => void;
  hasActiveScene: boolean;
}) {
  const patch = (value: Partial<DesignImportOptions>) => props.setOptions((current) => ({ ...current, ...value }));
  return (
    <fieldset className="design-import-options">
      <legend>Import options</legend>
      <div className="design-import-checks">
        <label><input checked={props.options.preserveHierarchy} onChange={(event) => patch({ preserveHierarchy: event.target.checked })} type="checkbox" /> Preserve hierarchy</label>
        <label><input checked={props.options.keepTextEditable} onChange={(event) => patch({ keepTextEditable: event.target.checked })} type="checkbox" /> Keep text editable</label>
        <label><input checked={props.options.importHiddenLayers} onChange={(event) => patch({ importHiddenLayers: event.target.checked })} type="checkbox" /> Import hidden layers</label>
        <label><input checked={props.options.convertComponents} onChange={(event) => patch({ convertComponents: event.target.checked })} type="checkbox" /> Convert components</label>
      </div>
      <div className="design-import-option-grid">
        <label>Assets<select value={props.options.assetMode} onChange={(event) => patch({ assetMode: event.target.value as DesignImportOptions["assetMode"] })}><option value="embed">Embed extracted assets</option><option value="link">Keep source links</option></select></label>
        <label>Missing fonts<select value={props.options.missingFontPolicy} onChange={(event) => patch({ missingFontPolicy: event.target.value as DesignImportOptions["missingFontPolicy"] })}><option value="preserve-name">Preserve family for resolution</option><option value="replace">Replace during import</option></select></label>
        {props.options.missingFontPolicy === "replace" ? <label>Replacement font<input value={props.options.replacementFontFamily} onChange={(event) => patch({ replacementFontFamily: event.target.value })} /></label> : null}
        <label>Unsupported features<select value={props.options.unsupportedFeaturePolicy} onChange={(event) => patch({ unsupportedFeaturePolicy: event.target.value as DesignImportOptions["unsupportedFeaturePolicy"] })}><option value="closest-editable">Closest editable feature</option><option value="nested-composition">Nested composition</option><option value="rasterize-layer">Rasterise affected layer</option></select></label>
        <label>Import scale<input min={0.01} max={100} step={0.01} type="number" value={props.options.scale} onChange={(event) => patch({ scale: event.target.valueAsNumber })} /></label>
        <label>Target width<input min={1} placeholder="Source" type="number" value={props.options.targetWidth ?? ""} onChange={(event) => patch({ targetWidth: event.target.value ? event.target.valueAsNumber : undefined })} /></label>
        <label>Target height<input min={1} placeholder="Source" type="number" value={props.options.targetHeight ?? ""} onChange={(event) => patch({ targetHeight: event.target.value ? event.target.valueAsNumber : undefined })} /></label>
        <label>Destination<select value={props.destination} onChange={(event) => props.setDestination(event.target.value as "replace" | "merge")}><option value="replace">Open as imported scene</option><option disabled={!props.hasActiveScene} value="merge">Merge into current scene</option></select></label>
      </div>
    </fieldset>
  );
}

function ReportSummary({ result }: { result: DesignImportResult }) {
  const report = result.report;
  const rows = [
    ["Imported items", report.importedItems],
    ["Converted properties", report.convertedProperties],
    ["Missing fonts", report.missingFonts.length],
    ["Missing assets", report.missingLinkedAssets.length],
    ["Unsupported effects", report.unsupportedEffects.length],
    ["Rasterised objects", report.rasterizedObjects.length],
    ["Visual differences", report.visualDifferences.length],
    ["Errors", report.errors.length],
    ["Warnings", report.warnings.length]
  ];
  return <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function DesignNodeTree(props: {
  node: NormalizedDesignNode;
  selected: Set<string>;
  onToggle: (node: NormalizedDesignNode, checked: boolean) => void;
}) {
  return (
    <div className="design-import-layer-node">
      <label>
        <input
          checked={props.selected.has(nodeSelectionId(props.node))}
          onChange={(event) => props.onToggle(props.node, event.target.checked)}
          type="checkbox"
        />
        <span>{props.node.name}</span>
        <small>{props.node.type}</small>
      </label>
      {props.node.children.length ? (
        <div>
          {props.node.children.map((child) => (
            <DesignNodeTree key={child.id} node={child} selected={props.selected} onToggle={props.onToggle} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function collectNodeIds(nodes: NormalizedDesignNode[]): string[] {
  return nodes.flatMap((node) => [nodeSelectionId(node), ...collectNodeIds(node.children)]);
}

function nodeSelectionId(node: NormalizedDesignNode): string {
  return node.sourceId || node.id;
}

function filterImportedScene(scene: SceneDocument, selectedSourceIds: Set<string>): SceneDocument {
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const keep = new Map<string, boolean>();
  const shouldKeep = (objectId: string): boolean => {
    if (keep.has(objectId)) return keep.get(objectId)!;
    const object = byId.get(objectId);
    if (!object) return false;
    const own = object.importedDesign?.sourceNodeId
      ? selectedSourceIds.has(object.importedDesign.sourceNodeId)
      : false;
    const child = object.type === "group" || object.type === "layer"
      ? object.childIds.some(shouldKeep)
      : false;
    const result = own || child;
    keep.set(objectId, result);
    return result;
  };
  scene.objects.forEach((object) => shouldKeep(object.id));
  return {
    ...scene,
    objects: scene.objects
      .filter((object) => keep.get(object.id))
      .map((object) => object.type === "group" || object.type === "layer"
        ? { ...object, childIds: object.childIds.filter((id) => keep.get(id)) }
        : object)
  };
}
