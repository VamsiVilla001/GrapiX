import {
  DEFAULT_DESIGN_IMPORT_OPTIONS,
  type DesignImportOptions,
  type DesignImportResult,
  type FigmaMotionImportMode,
  type FigmaMotionImportReport,
  type FigmaMotionManifest,
  type NormalizedDesignNode,
  type SceneDocument
} from "@grapix/shared-types";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { importDesignFileToApi, importFigmaDesignToApi } from "../lib/apiClient";
import {
  MOTION_COMPATIBILITY_LABELS,
  canStartMotionImport,
  missingNodeSummary,
  motionManifestDeliverable,
  motionReportGroups,
  parseMotionManifest,
  resolveMotionMode
} from "./designImportMotion";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";

type SourceMode = "file" | "figma";

export function ImportDesignDialog({ onClose }: { onClose: () => void }) {
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const applyImportedScene = useEditorStore((state) => state.applyImportedScene);
  const createTemplateFromScene = useTemplateStore((state) => state.createTemplateFromScene);
  const [sourceMode, setSourceMode] = useState<SourceMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [figmaSource, setFigmaSource] = useState<{
    url: string;
    nodeIds: string;
    transport: "auto" | "rest" | "desktop-mcp";
    accessToken: string;
  }>({ url: "", nodeIds: "", transport: "auto", accessToken: "" });
  const [options, setOptions] = useState<DesignImportOptions>(DEFAULT_DESIGN_IMPORT_OPTIONS);
  const [destination, setDestination] = useState<"replace" | "merge">(hasActiveScene ? "merge" : "replace");
  const [phase, setPhase] = useState<"idle" | "reading" | "parsing" | "converting" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<DesignImportResult | null>(null);
  const [selectedSceneIds, setSelectedSceneIds] = useState<string[]>([]);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [reportView, setReportView] = useState<"summary" | "issues" | "motion">("summary");
  const [motionMode, setMotionMode] = useState<FigmaMotionImportMode>("design-only");
  /**
   * The parsed `grapix-figma-motion.json`, held as the manifest rather than the File.
   *
   * Parsed at selection time so a malformed export is reported while the author is still looking
   * at the field that caused it, instead of surfacing as a failed import a minute later.
   */
  const [motionManifest, setMotionManifest] = useState<{ manifest: FigmaMotionManifest; fileName: string } | null>(null);
  const [motionError, setMotionError] = useState("");

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape" && phase !== "parsing" && phase !== "converting") onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose, phase]);

  const motionManifestAvailable = motionManifestDeliverable(sourceMode);
  const effectiveMotionMode = resolveMotionMode(motionMode, sourceMode);

  const canAnalyze = (sourceMode === "file"
    ? Boolean(file)
    : Boolean(figmaSource.url.trim()))
    && canStartMotionImport(effectiveMotionMode, Boolean(motionManifest));

  async function selectMotionManifest(selected: File | null) {
    setMotionError("");
    if (!selected) {
      setMotionManifest(null);
      return;
    }
    try {
      setMotionManifest({ manifest: parseMotionManifest(await selected.text()), fileName: selected.name });
    } catch (nextError) {
      setMotionManifest(null);
      setMotionError(nextError instanceof Error ? nextError.message : "That file could not be read.");
    }
  }
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
        ? await importDesignFileToApi(file!, options, { motionMode: effectiveMotionMode })
        : await importFigmaDesignToApi({
            url: figmaSource.url,
            nodeIds: figmaSource.nodeIds.split(",").map((value) => value.trim()).filter(Boolean),
            transport: figmaSource.transport,
            accessToken: figmaSource.accessToken.trim() || undefined,
            motionMode: effectiveMotionMode,
            motionManifest: effectiveMotionMode === "full-motion-manifest" ? motionManifest?.manifest : undefined
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
          <button className={sourceMode === "figma" ? "active" : ""} onClick={() => setSourceMode("figma")} role="tab" type="button">Figma link</button>
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
            <label>Figma link<input placeholder="https://www.figma.com/design/…?node-id=1-2" value={figmaSource.url} onChange={(event) => setFigmaSource((current) => ({ ...current, url: event.target.value }))} /></label>
            <label>Additional node IDs, comma separated<input placeholder="Optional · 1:2, 3:4" value={figmaSource.nodeIds} onChange={(event) => setFigmaSource((current) => ({ ...current, nodeIds: event.target.value }))} /></label>
            <label>Transport
              <select
                value={figmaSource.transport}
                onChange={(event) => setFigmaSource((current) => ({ ...current, transport: event.target.value as typeof current.transport }))}
              >
                <option value="auto">Auto · REST when a token is available</option>
                <option value="rest">REST API · editable layers</option>
                <option value="desktop-mcp">Figma Desktop MCP · screenshot, no token</option>
              </select>
            </label>
            <label>Personal access token
              <input
                aria-label="Figma personal access token"
                autoComplete="off"
                spellCheck={false}
                placeholder={figmaSource.transport === "desktop-mcp" ? "Not used by the Desktop MCP transport" : "figd_…"}
                disabled={figmaSource.transport === "desktop-mcp"}
                type="password"
                value={figmaSource.accessToken}
                onChange={(event) => setFigmaSource((current) => ({ ...current, accessToken: event.target.value }))}
              />
            </label>
            {figmaSource.transport !== "desktop-mcp" && !figmaSource.accessToken.trim() ? (
              <p className="design-import-token-hint" role="note">
                Paste a token to import editable layers. Create one in Figma → Settings → Security → Personal access tokens,
                with the <code>file_content:read</code> scope. Leave this empty to fall back to <code>FIGMA_ACCESS_TOKEN</code>
                on the project service — or, with Transport set to Auto and no token anywhere, to the Desktop MCP screenshot.
              </p>
            ) : null}
            <p>
              <strong>REST</strong> fetches Figma&apos;s native document JSON, so text stays editable text and vectors stay paths.
              It needs a personal access token with the <code>file_content:read</code> scope (Figma → Settings → Security), or
              <code> FIGMA_ACCESS_TOKEN</code> on the machine running the project service. The token is sent to the local project
              service for this import only and is never stored in the project, the scene, or the report.
              <br />
              <strong>Figma Desktop MCP</strong> (127.0.0.1:3845) needs no token, but the server exposes only sparse XML and a
              rendered screenshot, so each node arrives as one image and is reported as rasterized.
            </p>
          </div>
        )}

        <MotionOptions
          error={motionError}
          manifest={motionManifest}
          manifestAvailable={motionManifestAvailable}
          mode={motionMode}
          onSelectManifest={(selected) => void selectMotionManifest(selected)}
          setMode={setMotionMode}
        />

        <ImportOptions options={options} setOptions={setOptions} destination={destination} setDestination={setDestination} hasActiveScene={hasActiveScene} />

        {phase !== "idle" && phase !== "ready" && phase !== "error" ? (
          <div className="design-import-progress" role="status">
            <progress />
            <span>{phase === "reading"
              ? "Reading source…"
              : phase === "parsing"
                ? effectiveMotionMode === "design-only" ? "Parsing layers and assets…" : "Parsing layers, assets and motion…"
                : effectiveMotionMode === "design-only" ? "Converting native GrapiX objects…" : "Converting objects and writing keyframes…"}</span>
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
                {result.motion ? (
                  <button className={reportView === "motion" ? "active" : ""} onClick={() => setReportView("motion")} type="button">
                    Motion ({result.motion.keyframesCreated})
                  </button>
                ) : null}
              </div>
              {reportView === "summary" ? <ReportSummary result={result} /> : reportView === "motion" && result.motion ? (
                <MotionReport report={result.motion} />
              ) : (
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

/**
 * How much motion to bring across.
 *
 * The three modes are not degrees of effort, they are three different sources, and the control
 * says so: prototype transitions come from the REST document, per-property tracks come only from
 * a file the export bridge writes. An author who picks the third mode without the file gets told
 * here rather than getting a design-only import and a warning buried in the report.
 */
function MotionOptions(props: {
  error: string;
  manifest: { manifest: FigmaMotionManifest; fileName: string } | null;
  manifestAvailable: boolean;
  mode: FigmaMotionImportMode;
  onSelectManifest: (file: File | null) => void;
  setMode: (mode: FigmaMotionImportMode) => void;
}) {
  const wantsManifest = props.mode === "full-motion-manifest";
  const timelines = props.manifest?.manifest.timelines.length ?? 0;

  return (
    <fieldset className="design-import-motion">
      <legend>Motion</legend>
      <label>Bring across
        <select
          aria-label="Motion import mode"
          onChange={(event) => props.setMode(event.target.value as FigmaMotionImportMode)}
          value={props.mode}
        >
          <option value="design-only">Design only · no motion</option>
          <option value="design-and-prototype-motion">Design + prototype motion · transitions and Smart Animate</option>
          <option value="full-motion-manifest">Full motion manifest · keyframed Motion timelines</option>
        </select>
      </label>

      {wantsManifest && props.manifestAvailable ? (
        <>
          <label className="design-file-drop">
            <span>{props.manifest ? `${props.manifest.fileName} · ${timelines} ${timelines === 1 ? "timeline" : "timelines"}` : "Choose grapix-figma-motion.json"}</span>
            <input
              accept=".json,application/json"
              aria-label="GrapiX motion manifest"
              onChange={(event) => props.onSelectManifest(event.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
          <p className="design-import-token-hint" role="note">
            Export this from the <strong>GrapiX Motion Bridge</strong> plugin in Figma
            (<code>tools/figma-motion-bridge</code>). Figma&apos;s REST API cannot see a Motion timeline, so
            keyframed motion can only reach GrapiX through that file. Import the same frames the export
            covered — motion referring to a frame you did not import is named in the report rather than applied.
          </p>
        </>
      ) : null}

      {wantsManifest && !props.manifestAvailable ? (
        <p className="design-import-token-hint" role="note">
          A motion manifest needs the <strong>Figma link</strong> tab: this request sends the design file as raw
          bytes, which leaves nowhere for a second file. Importing prototype motion instead — an exported Figma
          document carries its own transitions, so that part still works here.
        </p>
      ) : null}

      {props.mode === "design-and-prototype-motion" ? (
        <p className="design-import-token-hint" role="note">
          Prototype transitions state that two frames are related and how long the change takes. Smart Animate is
          where per-property motion comes from on this route: the difference between the two frames is the
          animation. Anything you keyframed on a Motion timeline needs the manifest.
        </p>
      ) : null}

      {props.error ? <div className="design-import-error" role="alert">{props.error}</div> : null}
    </fieldset>
  );
}

/** What happened to the design's motion, grouped by outcome with the worst first. */
function MotionReport({ report }: { report: FigmaMotionImportReport }) {
  const groups = motionReportGroups(report);

  return (
    <div className="design-import-motion-report">
      <dl>
        <div><dt>Timelines converted</dt><dd>{report.timelinesConverted} / {report.timelines}</dd></div>
        <div><dt>Matched layers</dt><dd>{report.matchedNodes}</dd></div>
        <div><dt>Channels created</dt><dd>{report.channelsCreated}</dd></div>
        <div><dt>Keyframes created</dt><dd>{report.keyframesCreated}</dd></div>
      </dl>

      {report.missingNodes.length ? (
        <article className="severity-warning">
          <strong>Motion for {report.missingNodes.length} {report.missingNodes.length === 1 ? "layer" : "layers"} had nowhere to go</strong>
          {/* Named, not counted: the remedy is to import the frame holding them, and that needs identifying. */}
          <span>No imported object carries {missingNodeSummary(report.missingNodes)}. The frame holding
            them was probably not selected for import.</span>
        </article>
      ) : null}

      {groups.length ? groups.map((group) => (
        <section key={group.compatibility}>
          <strong>{MOTION_COMPATIBILITY_LABELS[group.compatibility]} ({group.entries.length})</strong>
          {group.entries.map((entry, index) => (
            <article className={group.compatibility === "unsupported" ? "severity-warning" : "severity-info"} key={`${entry.nodeId}_${entry.property}_${index}`}>
              <strong>{entry.nodeName ?? entry.nodeId} · {entry.property}</strong>
              <span>{entry.detail}</span>
              {entry.timelineName ? <small>{entry.timelineName}</small> : null}
            </article>
          ))}
        </section>
      )) : <span>The manifest carried no motion for the imported layers.</span>}
    </div>
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
  return (
    <>
      <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {report.counts ? (
        <section className="design-import-counts">
          <strong>Layer and asset accounting</strong>
          <dl>
            <div><dt>Native layers</dt><dd>{report.counts.native}</dd></div>
            <div><dt>Generic containers</dt><dd>{report.counts.genericContainers}</dd></div>
            <div><dt>Flattened layers</dt><dd>{report.counts.flattened}</dd></div>
            <div><dt>Masks</dt><dd>{report.counts.masks}</dd></div>
            <div><dt>Clip containers</dt><dd>{report.counts.clippedContainers}</dd></div>
            <div><dt>Synthetic layers</dt><dd>{report.counts.syntheticLayers}</dd></div>
            <div><dt>Downloaded assets</dt><dd>{report.counts.assetsDownloaded}</dd></div>
            <div><dt>Failed assets</dt><dd>{report.counts.assetsFailed}</dd></div>
            <div><dt>Missing nodes</dt><dd>{report.counts.missingNodes.length}</dd></div>
          </dl>
        </section>
      ) : null}
    </>
  );
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
