import type { AeDynamicControl, AePublishValidation, AeRuntimeContainer } from "@grapix/ae-runtime-contract";
import { CheckCircle2, ChevronLeft, FolderOpen, Import, Loader2, Plus, RefreshCw, Search, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createAeRuntimeContainerOnApi,
  getProjectOnApi,
  openProjectOnApi,
  importAeCompositionAsSceneOnApi,
  importAeCompositionIntoSceneOnApi,
  inspectAeProjectOnApi,
  listAeProjectsFromApi,
  listAeRuntimeContainersFromApi,
  publishAeContainerOnApi,
  readAeCompositionFromApi,
  registerAeProjectOnApi,
  removeAeImportOnApi,
  updateAeRuntimeContainerOnApi,
  validateAePublishOnApi,
  type AeCompositionSummary,
  type AeLayerSummary,
  type AeProjectInspection,
  type AeProjectSummary
} from "../lib/apiClient";
import { canPickFiles, pickAeProjectPath } from "../lib/desktopBridge";
import { ensureProjectLocation } from "../lib/ensureProject";
import { useEditorStore } from "../store/editorStore";
import {
  containerIdForComposition,
  controlFromProperty,
  frameRateToRational,
  rankCompositions,
  type CompositionFilter
} from "./aeConnectorModel";

/**
 * The After Effects connector.
 *
 * An author picks a project, picks one composition out of what a production project holds — the
 * reference project has 280 — exposes the properties an operator will drive, then validates and
 * publishes. Every step reads the `.aep` through the binary parser, so none of it needs a licensed
 * After Effects running: choosing what to publish is design-time work, and the live runtime is
 * gated behind a licensing decision this panel has no part in.
 *
 * The flow is a small state machine rather than one long form, because the steps genuinely gate one
 * another: there is no composition to choose before a project is inspected, and nothing to validate
 * before a container exists.
 */
type Stage = "projects" | "compositions" | "controls";

export function AeControlsPanel() {
  const [stage, setStage] = useState<Stage>("projects");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [projects, setProjects] = useState<AeProjectSummary[]>([]);
  const [addPath, setAddPath] = useState("");
  // Decided once: a browser has no way to give a path, so it gets the text field alone.
  const canBrowse = useMemo(() => canPickFiles(), []);
  const [inspection, setInspection] = useState<AeProjectInspection | null>(null);
  // Default on: a production project holds hundreds of precomp fragments an author is almost
  // never looking for. Top-level hides them; unticking it shows the whole project again.
  const [filter, setFilter] = useState<CompositionFilter>({ query: "", onlyPublishable: false, onlyWithText: false, onlyTopLevel: true });

  const [composition, setComposition] = useState<AeCompositionSummary | null>(null);
  const [layers, setLayers] = useState<AeLayerSummary[]>([]);
  const [container, setContainer] = useState<AeRuntimeContainer | null>(null);

  const [validation, setValidation] = useState<AePublishValidation | null>(null);
  const [published, setPublished] = useState<{ version: number; files: number; bytes: number } | null>(null);
  /** The scene a composition was materialized into, so the author can open it after import. */
  const [imported, setImported] = useState<{ sceneId: string; name: string; convertedLayers: number; warnings: number } | null>(null);

  /** One place to run an async step, so every failure reaches the author instead of the console. */
  async function run<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void run("Reading project roots", async () => setProjects(await listAeProjectsFromApi()));
  }, []);

  const activeScene = useEditorStore((state) => state.scene);
  const activeImports = useMemo(() => {
    if (!activeScene?.objects) return [];
    return activeScene.objects
      .filter((obj) => obj.type === "group" && obj.importedDesign?.raw?.importId)
      .map((obj) => ({
        importId: obj.importedDesign!.raw!.importId as string,
        name: obj.name,
        childCount: "childIds" in obj && Array.isArray(obj.childIds) ? obj.childIds.length : 0
      }));
  }, [activeScene]);

  const ranked = useMemo(
    () => (inspection ? rankCompositions(inspection.compositions, filter) : []),
    [inspection, filter]
  );

  /** Native dialog → register → list, so choosing a project is one action rather than three. */
  async function chooseProject() {
    const chosen = await pickAeProjectPath();
    // A cancelled dialog is not a failure and must not leave an error on screen.
    if (!chosen) return;
    await run("Adding project", async () => {
      await registerAeProjectOnApi(chosen);
      setProjects(await listAeProjectsFromApi());
      setAddPath("");
    });
  }

  async function openProject(project: AeProjectSummary) {
    const next = await run(`Parsing ${project.name}`, () => inspectAeProjectOnApi(project.projectUri));
    if (!next) return;
    setInspection(next);
    setComposition(null);
    setContainer(null);
    setValidation(null);
    setPublished(null);
    setStage("compositions");
  }

  async function openComposition(summary: AeCompositionSummary) {
    if (!inspection) return;
    const detail = await run(`Reading ${summary.name}`, () =>
      readAeCompositionFromApi(inspection.projectUri, summary.id)
    );
    if (!detail) return;
    setComposition(detail.composition);
    setLayers(detail.layers);
    setValidation(null);
    setPublished(null);

    // The container is created up front so a control can be declared the moment one is chosen;
    // without it every "Expose" would have to guess whether the container exists yet.
    const id = containerIdForComposition(inspection.projectName, summary.name);
    const existing = (await listAeRuntimeContainersFromApi().catch(() => [])).find((entry) => entry.id === id);
    if (existing) setContainer(existing);
    else {
      const created = await run("Declaring container", () =>
        createAeRuntimeContainerOnApi({
          id,
          name: `${inspection.projectName} — ${summary.name}`,
          projectUri: inspection.projectUri,
          projectDigest: inspection.projectDigest,
          profile: {
            aeVersion: "26.3",
            renderer: "Classic 3D",
            workingColorSpace: "sRGB",
            // The project reports a float; a broadcast clock is a rational or it is a guess.
            frameRate: frameRateToRational(summary.frameRate)
          },
          compositions: [{
            itemId: Number(summary.id),
            name: summary.name,
            width: summary.width,
            height: summary.height,
            clock: rationalToClock(frameRateToRational(summary.frameRate))
          }],
          cachePolicy: { mode: "bounded", maxPreparedFrames: 8 },
          controls: [],
          dataBindings: []
        })
      );
      if (!created) return;
      setContainer(created);
    }
    setStage("controls");
  }

  /**
   * Make sure a project exists before an import that will write footage into it.
   *
   * Same contract as saving: the operator names a `.gpxpkg`, the folder layout is created around it,
   * and only then does the work proceed. Returns false when they cancel, which cancels the import
   * rather than producing a scene whose images point nowhere.
   */
  async function ensureProject(): Promise<boolean> {
    const outcome = await ensureProjectLocation(inspection?.projectName);
    if (!outcome.ok && outcome.message) setError(outcome.message);
    return outcome.ok;
  }

  /**
   * Materialize a composition as a new, editable scene — the design-time import. Distinct from
   * publish: publish packages a container for Playout, this builds a scene in the Object Manager.
   */
  async function importAsNewScene(summary: AeCompositionSummary) {
    if (!inspection) return;
    if (!(await ensureProject())) return;
    const result = await run(`Importing ${summary.name} as new scene`, () =>
      importAeCompositionAsSceneOnApi(inspection.projectUri, summary.id, summary.name)
    );
    if (!result) return;
    if (result.scene) {
      useEditorStore.getState().loadScene(result.scene);
    }
    setImported({
      sceneId: result.sceneId,
      name: summary.name,
      convertedLayers: result.convertedLayers,
      warnings: result.warnings.length
    });
  }

  async function importIntoActiveScene(summary: AeCompositionSummary) {
    if (!inspection) return;
    if (!(await ensureProject())) return;
    const currentScene = useEditorStore.getState().scene;
    if (!currentScene?.id) {
      setError("No active scene is open to import into.");
      return;
    }
    const result = await run(`Importing ${summary.name} into open scene`, () =>
      importAeCompositionIntoSceneOnApi(inspection.projectUri, summary.id, currentScene.id)
    );
    if (!result) return;
    if (result.scene) {
      useEditorStore.getState().loadScene(result.scene);
    }
    setImported({
      sceneId: currentScene.id,
      name: summary.name,
      convertedLayers: result.convertedLayers,
      warnings: result.warnings.length
    });
  }

  async function removeImportFromActiveScene(importId: string) {
    const currentScene = useEditorStore.getState().scene;
    if (!currentScene?.id) return;
    const result = await run(`Removing imported composition`, () =>
      removeAeImportOnApi(currentScene.id, importId)
    );
    if (result?.scene) {
      useEditorStore.getState().loadScene(result.scene);
    }
  }

  async function expose(layer: AeLayerSummary, property: AeLayerSummary["exposable"][number]) {
    if (!container || !composition) return;
    const control = controlFromProperty(composition, layer, property, container.controls);
    if (!control) {
      setError(`"${layer.name} · ${property.label}" is already exposed.`);
      return;
    }
    const next = await run("Exposing control", () =>
      updateAeRuntimeContainerOnApi(container.id, { controls: [...container.controls, control] })
    );
    if (next) {
      setContainer(next);
      setValidation(null);
    }
  }

  async function removeControl(controlId: string) {
    if (!container) return;
    const next = await run("Removing control", () =>
      updateAeRuntimeContainerOnApi(container.id, {
        controls: container.controls.filter((control) => control.controlId !== controlId)
      })
    );
    if (next) {
      setContainer(next);
      setValidation(null);
    }
  }

  async function validate() {
    if (!container) return;
    const result = await run("Validating", () => validateAePublishOnApi(container.id));
    if (result) setValidation(result);
  }

  async function publish() {
    if (!container) return;
    const result = await run("Publishing", () => publishAeContainerOnApi(container.id));
    if (result) {
      setPublished({ version: result.version, files: result.fileCount, bytes: result.totalBytes });
      setValidation(result.validation);
    }
  }

  return (
    <div className="ae-connector">
      <header className="ae-connector-head">
        {stage !== "projects" ? (
          <button
            onClick={() => setStage(stage === "controls" ? "compositions" : "projects")}
            title="Back"
            type="button"
          >
            <ChevronLeft size={13} />
          </button>
        ) : null}
        <strong>
          {stage === "projects" ? "After Effects projects"
            : stage === "compositions" ? inspection?.projectName
            : composition?.name}
        </strong>
        {stage === "compositions" && inspection ? (
          <span className="ae-connector-sub">
            {inspection.compositions.length} comps · {inspection.assetCount} assets · parsed in {inspection.parsedInMs} ms
          </span>
        ) : null}
        <button
          disabled={Boolean(busy)}
          onClick={() => void run("Refreshing", async () => setProjects(await listAeProjectsFromApi()))}
          title="Refresh"
          type="button"
        >
          <RefreshCw size={13} />
        </button>
      </header>

      {busy ? (
        <div className="ae-connector-busy" role="status">
          <Loader2 className="ae-spin" size={13} /> {busy}…
        </div>
      ) : null}
      {error ? <div className="design-import-error" role="alert">{error}</div> : null}
      {imported ? (
        <div className="ae-import-success" role="status">
          <CheckCircle2 size={13} />
          <span>
            Imported <strong>{imported.name}</strong> as a scene — {imported.convertedLayers} layers became objects
            {imported.warnings ? `, ${imported.warnings} warning${imported.warnings === 1 ? "" : "s"}` : ""}.
            Open it from the scene list (<code>{imported.sceneId}</code>).
          </span>
          <button onClick={() => setImported(null)} title="Dismiss" type="button"><XCircle size={12} /></button>
        </div>
      ) : null}

      {stage === "projects" ? (
        <>
          {/*
            Choosing a project is what makes it readable — there is no folder to configure first.
            A path rather than a file picker because a browser file input reports a name and never a
            location, and the service needs the location; the desktop shell can fill this from a
            native dialog.
          */}
          <form
            className="ae-add-project"
            onSubmit={(event) => {
              event.preventDefault();
              const chosen = addPath.trim();
              if (!chosen) return;
              void run("Adding project", async () => {
                await registerAeProjectOnApi(chosen);
                setProjects(await listAeProjectsFromApi());
                setAddPath("");
              });
            }}
          >
            {canBrowse ? (
              <button
                disabled={Boolean(busy)}
                onClick={() => void chooseProject()}
                title="Choose an After Effects project"
                type="button"
              >
                <FolderOpen size={12} /> Browse…
              </button>
            ) : null}
            <input
              aria-label="Path to an After Effects project"
              onChange={(event) => setAddPath(event.target.value)}
              placeholder={canBrowse ? "…or paste a path to a .aep file" : "Paste the full path to a .aep file"}
              value={addPath}
            />
            <button disabled={Boolean(busy) || !addPath.trim()} type="submit">
              <Plus size={12} /> Add
            </button>
          </form>
          <ul className="ae-connector-list">
          {projects.map((project) => (
            <li key={project.projectUri}>
              <button onClick={() => void openProject(project)} type="button">
                <span className="ae-name">{project.name}</span>
                <span className="ae-meta">{(project.sizeBytes / 1048576).toFixed(1)} MB</span>
              </button>
            </li>
          ))}
            {!projects.length && !busy ? (
              <li className="ae-connector-empty">
                No projects yet. Paste the path to a <code>.aep</code> above — the folder that holds it
                becomes readable to GrapiX, and it is remembered for next time.
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {stage === "compositions" && inspection ? (
        <>
          {activeImports.length > 0 ? (
            <div className="ae-active-imports">
              <strong>In open scene ({activeImports.length})</strong>
              <ul>
                {activeImports.map((item) => (
                  <li key={item.importId}>
                    <span className="ae-name">{item.name} <span className="ae-meta">({item.childCount} layers)</span></span>
                    <button
                      className="ae-remove-import-btn"
                      disabled={Boolean(busy)}
                      onClick={() => void removeImportFromActiveScene(item.importId)}
                      title="Remove this composition group and release its unreferenced footage"
                      type="button"
                    >
                      <Trash2 size={12} /> Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="ae-connector-filter">
            <label>
              <Search size={12} />
              <input
                aria-label="Filter compositions"
                onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
                placeholder={`Filter ${inspection.compositions.length} compositions`}
                value={filter.query}
              />
            </label>
            <label>
              <input
                checked={filter.onlyTopLevel}
                onChange={(event) => setFilter((current) => ({ ...current, onlyTopLevel: event.target.checked }))}
                type="checkbox"
              />
              Top-level only
            </label>
            <label>
              <input
                checked={filter.onlyPublishable}
                onChange={(event) => setFilter((current) => ({ ...current, onlyPublishable: event.target.checked }))}
                type="checkbox"
              />
              Publishable
            </label>
            <label>
              <input
                checked={filter.onlyWithText}
                onChange={(event) => setFilter((current) => ({ ...current, onlyWithText: event.target.checked }))}
                type="checkbox"
              />
              Has text
            </label>
          </div>
          <ul className="ae-connector-list">
            {ranked.slice(0, 200).map((entry) => (
              <li key={entry.id}>
                <button onClick={() => void openComposition(entry)} type="button">
                  <span className="ae-name">
                    {entry.grapixMarked ? <span className="ae-badge" title="Named GX_ for GrapiX">GX</span> : null}
                    {entry.name}
                  </span>
                  <span className="ae-meta">
                    {entry.width}×{entry.height} · {entry.layerCount} layers
                    {entry.textLayerCount ? ` · ${entry.textLayerCount} text` : ""}
                    {entry.missingAssetCount ? ` · ${entry.missingAssetCount} missing` : ""}
                    {!entry.isTopLevel ? ` · precomp ×${entry.nestedUseCount}` : ""}
                  </span>
                </button>
                <div className="ae-import-actions">
                  <button
                    className="ae-import-scene"
                    disabled={Boolean(busy)}
                    onClick={() => void importAsNewScene(entry)}
                    title="Import as a new, editable template / scene"
                    type="button"
                  >
                    <Import size={12} /> As new scene
                  </button>
                  {useEditorStore.getState().hasActiveScene ? (
                    <button
                      className="ae-import-scene ae-import-into"
                      disabled={Boolean(busy)}
                      onClick={() => void importIntoActiveScene(entry)}
                      title="Import into the currently open scene"
                      type="button"
                    >
                      <Plus size={12} /> Into open scene
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
            {ranked.length > 200 ? (
              <li className="ae-connector-empty">
                {ranked.length - 200} more — narrow the filter to see them.
              </li>
            ) : null}
            {!ranked.length ? <li className="ae-connector-empty">No composition matches that filter.</li> : null}
          </ul>
        </>
      ) : null}

      {stage === "controls" && composition && container ? (
        <div className="ae-connector-author">
          {composition.cueMarkers.length ? (
            <section>
              <strong>Cue points ({composition.cueMarkers.length})</strong>
              <ul className="ae-cue-list">
                {composition.cueMarkers.map((marker, index) => (
                  <li key={`${marker.text}-${index}`}>
                    <span className="ae-badge">{marker.text.replace(/^GRAPIX:/, "")}</span>
                    <span className="ae-meta">{marker.time.toFixed(2)}s</span>
                  </li>
                ))}
              </ul>
              <p className="ae-connector-empty">
                These become the broadcast actions (IN / HOLD / OUT) Playout can play, derived from the markers at publish.
              </p>
            </section>
          ) : null}
          <section>
            <strong>Exposed to Playout ({container.controls.length})</strong>
            {container.controls.length ? (
              <ul className="ae-control-list">
                {container.controls.map((control) => (
                  <li key={control.controlId}>
                    <span className="ae-name">{control.displayName}</span>
                    <span className="ae-meta">{control.kind}</span>
                    <button onClick={() => void removeControl(control.controlId)} title="Remove" type="button">
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ae-connector-empty">
                Nothing exposed yet. Choose a property below — an operator can only drive what is declared here.
              </p>
            )}
          </section>

          <section>
            <strong>Layers ({layers.length})</strong>
            <ul className="ae-layer-list">
              {layers.map((layer) => (
                <li key={layer.index}>
                  <div className="ae-layer-head">
                    <span className="ae-name">{layer.name}</span>
                    <span className="ae-meta">{layer.type}</span>
                    {layer.effects.some((effect) => effect.thirdParty) ? (
                      <span className="ae-badge" title="Uses a third-party plugin">3rd-party</span>
                    ) : null}
                  </div>
                  {layer.text !== undefined ? <div className="ae-layer-text">“{layer.text}”</div> : null}
                  {layer.streams.length ? (
                    <div className="ae-stream-list">
                      {layer.streams.map((stream) => (
                        <div className="ae-stream" key={stream.property}>
                          <span className="ae-meta">
                            {stream.property}
                            {stream.expression ? " (expression)" : ""} · {stream.keyframes.length} keyframe{stream.keyframes.length === 1 ? "" : "s"}
                          </span>
                          <span className="ae-keyframes">
                            {stream.keyframes.slice(0, 24).map((key, keyIndex) => (
                              <span
                                className={`ae-keyframe ae-keyframe-${key.interpolation}`}
                                key={keyIndex}
                                title={`${key.time.toFixed(2)}s · ${key.interpolation}`}
                              />
                            ))}
                            {stream.keyframes.length > 24 ? (
                              <span className="ae-meta">+{stream.keyframes.length - 24}</span>
                            ) : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="ae-expose-row">
                    {layer.exposable.map((property) => (
                      <button
                        key={property.matchName}
                        onClick={() => void expose(layer, property)}
                        type="button"
                      >
                        <Plus size={10} /> {property.label}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <footer className="ae-connector-actions">
            <button disabled={Boolean(busy)} onClick={() => void validate()} type="button">Validate</button>
            <button
              className="primary"
              disabled={Boolean(busy) || (validation ? !validation.ok : false)}
              onClick={() => void publish()}
              type="button"
            >
              <Upload size={12} /> Publish to Playout
            </button>
          </footer>

          {published ? (
            <div className="ae-publish-ok" role="status">
              <CheckCircle2 size={13} /> Published v{String(published.version).padStart(3, "0")} —
              {" "}{published.files} files, {(published.bytes / 1048576).toFixed(1)} MB
            </div>
          ) : null}

          {validation ? (
            <div className={validation.ok ? "ae-publish-ok" : "ae-publish-bad"}>
              <div className="ae-verdict">
                {validation.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {validation.ok ? "READY FOR PLAYOUT" : "NOT READY"}
                <span className="ae-meta">
                  {validation.counts.refusals} refusals · {validation.counts.warnings} warnings
                </span>
              </div>
              {validation.refusals.map((refusal, index) => (
                <p key={`refusal-${index}`} className="ae-refusal">
                  {refusal.message}
                  {refusal.remedy ? <em> {refusal.remedy}</em> : null}
                </p>
              ))}
              {validation.warnings.slice(0, 6).map((warning, index) => (
                <p key={`warning-${index}`} className="ae-warning">{warning.message}</p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** `30000/1001` → the composition clock the container contract carries. */
function rationalToClock(frameRate: string): { frameDuration: string; timeScale: string } {
  const [numerator, denominator = "1"] = frameRate.split("/");
  return { frameDuration: denominator, timeScale: numerator };
}
