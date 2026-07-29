import type {
  PlayoutRundownDocument,
  PlayoutRundownItem,
  PlayoutRuntimeStatus,
  PublishedSceneMetadata,
  SceneDocument
} from "@grapix/shared-types";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clapperboard,
  Clock3,
  Cpu,
  Database,
  FileInput,
  Library,
  ListVideo,
  MonitorPlay,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SkipForward,
  Square,
  Wifi,
  WifiOff
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { playoutApi, type EngineHealthView } from "./api";
import { OutputsPanel } from "./OutputsPanel";

const emptyRuntime: PlayoutRuntimeStatus = {
  rendererConnection: "disconnected",
  previewItemId: null,
  programItemId: null,
  itemStates: {},
  lastError: null,
  updatedAt: new Date(0).toISOString()
};

export function App() {
  const [library, setLibrary] = useState<PublishedSceneMetadata[]>([]);
  const [rundown, setRundown] = useState<PlayoutRundownDocument | null>(null);
  const [runtime, setRuntime] = useState<PlayoutRuntimeStatus>(emptyRuntime);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedSceneKey, setSelectedSceneKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(new Date());

  /**
   * What is being dragged, and where it would land.
   *
   * Held in state rather than read from the drag event because Firefox does not expose
   * `dataTransfer` data during `dragover`, so the drop indicator could not be drawn
   * from the event alone.
   */
  const [drag, setDrag] = useState<
    | { kind: "scene"; sceneKey: string }
    | { kind: "item"; itemId: string }
    | null
  >(null);
  const [dropTarget, setDropTarget] = useState<
    { segmentId: string; beforeItemId: string | null } | null
  >(null);

  const refreshLibrary = useCallback(async () => {
    setLibrary(await playoutApi.listScenes());
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setRuntime(await playoutApi.status());
    } catch (statusError) {
      setRuntime((current) => ({
        ...current,
        rendererConnection: "disconnected",
        lastError: errorMessage(statusError)
      }));
    }
  }, []);

  const [engine, setEngine] = useState<EngineHealthView | null>(null);

  /**
   * Poll the render engine's health.
   *
   * Failure is normal — the engine may not be running — so it degrades to a null
   * view rather than surfacing an error banner.
   */
  async function refreshEngine() {
    try {
      setEngine(await playoutApi.engine());
    } catch {
      setEngine(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [scenes, rundowns] = await Promise.all([
          playoutApi.listScenes(),
          playoutApi.listRundowns()
        ]);
        if (cancelled) return;
        setLibrary(scenes);
        const active =
          rundowns.find((candidate) => !candidate.archived) ??
          (await playoutApi.createRundown("Main Rundown"));
        if (cancelled) return;
        setRundown(active);
        setSelectedItemId(active.activeItemId ?? active.items[0]?.itemId ?? null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();
    void refreshStatus();
    // Fetch once immediately as well, so the operator strip is populated on the
    // first paint rather than three seconds later.
    void refreshEngine();
    const statusTimer = window.setInterval(refreshStatus, 3000);
    const engineTimer = window.setInterval(refreshEngine, 3000);
    const clockTimer = window.setInterval(() => setClock(new Date()), 250);
    return () => {
      cancelled = true;
      window.clearInterval(statusTimer);
      window.clearInterval(engineTimer);
      window.clearInterval(clockTimer);
    };
  }, [refreshStatus]);

  const filteredLibrary = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return library.filter((scene, index, all) => {
      const isLatest =
        all.findIndex((candidate) => candidate.sceneId === scene.sceneId) === index;
      return (
        isLatest &&
        (!query ||
          scene.name.toLocaleLowerCase().includes(query) ||
          scene.tags.some((tag) => tag.toLocaleLowerCase().includes(query)))
      );
    });
  }, [library, search]);

  const selectedItem =
    rundown?.items.find((item) => item.itemId === selectedItemId) ?? null;
  const selectedScene =
    library.find(
      (scene) =>
        `${scene.sceneId}:${scene.version}` === selectedSceneKey
    ) ?? null;
  const previewItem =
    rundown?.items.find((item) => item.itemId === runtime.previewItemId) ?? null;
  const programItem =
    rundown?.items.find((item) => item.itemId === runtime.programItemId) ?? null;

  /**
   * The format an output should use, taken from the scene on Program when there is
   * one, then the selected scene, then the HD default.
   *
   * Published metadata carries the resolution the project settings produced, so this
   * follows a project change without Playout knowing about project settings at all.
   * A scene published before that field existed reports nothing, and the operator
   * sees the default and can change it rather than being told a wrong number.
   */
  const programFormat = useMemo(() => {
    const onAirSceneId = programItem?.sceneId ?? selectedItem?.sceneId;
    const published =
      library.find((scene) => scene.sceneId === onAirSceneId) ?? library[0];

    return {
      width: published?.canvasWidth ?? 1920,
      height: published?.canvasHeight ?? 1080,
      frameRate: {
        numerator: published?.frameRateNumerator ?? 50,
        denominator: published?.frameRateDenominator ?? 1
      },
      colorSpace: published?.colorSpace ?? "rec709"
    };
  }, [library, programItem, selectedItem]);

  async function persistRundown(next: PlayoutRundownDocument) {
    setRundown(next);
    try {
      const saved = await playoutApi.saveRundown(next);
      setRundown((current) =>
        current?.rundownId === saved.rundownId ? saved : current
      );
      setError(null);
    } catch (saveError) {
      setError(`Autosave failed: ${errorMessage(saveError)}`);
    }
  }

  /**
   * Put a published scene into the rundown.
   *
   * `segmentId` and `beforeItemId` come from a drop; without them the item is appended
   * to the first segment, which is what the button and double-click do.
   *
   * The version is pinned rather than following the latest publish: an operator who
   * built a rundown against v3 must not have v4 appear underneath them mid-show. Which
   * version is in use is shown on the row.
   */
  async function addSceneToRundown(
    scene: PublishedSceneMetadata,
    placement?: { segmentId?: string; beforeItemId?: string | null }
  ) {
    if (!rundown) return;
    const segmentId = placement?.segmentId ?? rundown.segments[0]?.segmentId;
    if (!segmentId) {
      setError("Create a rundown segment before adding scenes.");
      return;
    }
    const item: PlayoutRundownItem = {
      itemId: `item_${crypto.randomUUID()}`,
      sceneId: scene.sceneId,
      sceneVersion: scene.version,
      versionPolicy: "pinned",
      name: scene.name,
      pageNumber: String(100 + rundown.items.length),
      segmentId,
      layer: "Overlay",
      channel: "A",
      output: "Program",
      transitionIn: {
        type: scene.defaultTransition,
        durationFrames: scene.defaultTransition === "cut" ? 0 : 12,
        delayFrames: 0
      },
      transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
      instanceData: {},
      notes: "",
      color: "#3d75ae",
      cuePolicy: "manual",
      automationEnabled: false,
      completed: false
    };
    const items = [...rundown.items];
    const beforeIndex = placement?.beforeItemId
      ? items.findIndex((candidate) => candidate.itemId === placement.beforeItemId)
      : -1;
    if (beforeIndex >= 0) {
      items.splice(beforeIndex, 0, item);
    } else {
      items.push(item);
    }

    setSelectedItemId(item.itemId);
    await persistRundown({ ...rundown, activeItemId: item.itemId, items });
  }

  /**
   * Move an existing item, by drag.
   *
   * A rundown is one ordered list with items tagged by segment, so a cross-segment drag
   * changes both the position and the segment in a single write — otherwise the row
   * would briefly appear in the wrong block.
   */
  async function moveItemTo(
    itemId: string,
    target: { segmentId: string; beforeItemId: string | null }
  ) {
    if (!rundown) return;
    const index = rundown.items.findIndex((item) => item.itemId === itemId);
    if (index < 0 || target.beforeItemId === itemId) return;

    const items = [...rundown.items];
    const [moved] = items.splice(index, 1);
    if (!moved) return;

    const placed = { ...moved, segmentId: target.segmentId };
    const beforeIndex = target.beforeItemId
      ? items.findIndex((candidate) => candidate.itemId === target.beforeItemId)
      : -1;
    if (beforeIndex >= 0) {
      items.splice(beforeIndex, 0, placed);
    } else {
      // Dropped on the segment itself: put it at the end of that segment rather than
      // the end of the whole rundown.
      const lastInSegment = items.reduce(
        (last, candidate, candidateIndex) =>
          candidate.segmentId === target.segmentId ? candidateIndex : last,
        -1
      );
      items.splice(lastInSegment + 1, 0, placed);
    }

    await persistRundown({ ...rundown, items });
  }

  /** Resolve a dropped library payload back to its published scene. */
  function sceneFromDragKey(sceneKey: string): PublishedSceneMetadata | undefined {
    return library.find((scene) => `${scene.sceneId}:${scene.version}` === sceneKey);
  }

  /** Apply whatever is being dragged to a drop location. */
  async function handleDrop(target: { segmentId: string; beforeItemId: string | null }) {
    const payload = drag;
    setDrag(null);
    setDropTarget(null);
    if (!payload) return;

    if (payload.kind === "scene") {
      const scene = sceneFromDragKey(payload.sceneKey);
      if (!scene) {
        setError("That published scene is no longer in the library.");
        return;
      }
      await addSceneToRundown(scene, target);
      return;
    }

    await moveItemTo(payload.itemId, target);
  }

  async function moveItem(itemId: string, direction: -1 | 1) {
    if (!rundown) return;
    const index = rundown.items.findIndex((item) => item.itemId === itemId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= rundown.items.length) return;
    const items = [...rundown.items];
    [items[index], items[target]] = [items[target], items[index]];
    await persistRundown({ ...rundown, items });
  }

  async function execute(action: "cue" | "take") {
    if (!rundown || !selectedItem) return;
    setBusyAction(action);
    try {
      const status =
        action === "cue"
          ? await playoutApi.cue(rundown.rundownId, selectedItem.itemId)
          : await playoutApi.take(rundown.rundownId, selectedItem.itemId);
      setRuntime(status);
      setError(null);
    } catch (actionError) {
      setError(errorMessage(actionError));
      await refreshStatus();
    } finally {
      setBusyAction(null);
    }
  }

  async function importScene(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusyAction("import");
    try {
      const scene = JSON.parse(await file.text()) as SceneDocument;
      const published = await playoutApi.publishScene(scene);
      await refreshLibrary();
      setSelectedSceneKey(`${published.sceneId}:${published.version}`);
      setError(null);
    } catch (importError) {
      setError(`Scene import failed: ${errorMessage(importError)}`);
    } finally {
      setBusyAction(null);
    }
  }

  const connected = runtime.rendererConnection === "connected";

  return (
    <main className="playout-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">GX</span>
          <div>
            <strong>GrapiX Playout</strong>
            <span>Operator Control</span>
          </div>
        </div>
        <div className="system-strip">
          <StatusPill
            good={connected}
            icon={connected ? <Wifi size={13} /> : <WifiOff size={13} />}
            label={connected ? "Renderer connected" : "Renderer offline"}
          />
          <StatusPill
            good={engine?.takeReady === true}
            icon={
              engine?.connected ? <Cpu size={13} /> : <WifiOff size={13} />
            }
            label={engineLabel(engine)}
          />
          <StatusPill good icon={<Database size={13} />} label="Autosave active" />
          <div className="timecode">
            <Clock3 size={14} />
            {formatClock(clock)}
          </div>
          <button className="icon-button" title="Playout settings">
            <Settings2 size={16} />
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <CircleAlert size={15} />
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <section className="workspace">
        <Panel
          className="library-panel"
          title="Published Scenes"
          icon={<Library size={15} />}
          actions={
            <>
              <label className="small-button import-button">
                <FileInput size={13} />
                Import
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={importScene}
                />
              </label>
              <button className="icon-button" onClick={refreshLibrary} title="Refresh library">
                <RefreshCw size={14} />
              </button>
            </>
          }
        >
          <div className="search-box">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search scenes or tags"
            />
          </div>
          <div className="library-list">
            {filteredLibrary.map((scene) => {
              const key = `${scene.sceneId}:${scene.version}`;
              return (
                <button
                  key={key}
                  className={`scene-card ${selectedSceneKey === key ? "selected" : ""} ${
                    drag?.kind === "scene" && drag.sceneKey === key ? "dragging" : ""
                  }`}
                  draggable
                  onDragStart={(event) => {
                    setDrag({ kind: "scene", sceneKey: key });
                    event.dataTransfer.effectAllowed = "copy";
                    // A plain-text fallback so the drag is not rejected outright by
                    // browsers that require some data to be set.
                    event.dataTransfer.setData("text/plain", key);
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setDropTarget(null);
                  }}
                  onClick={() => setSelectedSceneKey(key)}
                  onDoubleClick={() => addSceneToRundown(scene)}
                >
                  <div
                    className="scene-thumbnail checkerboard"
                    style={
                      scene.thumbnailDataUrl
                        ? { backgroundImage: `url(${scene.thumbnailDataUrl})` }
                        : undefined
                    }
                  >
                    {!scene.thumbnailDataUrl && <Clapperboard size={25} />}
                  </div>
                  <span className="scene-copy">
                    <strong>{scene.name}</strong>
                    <small>
                      v{scene.version} · {scene.durationFrames}f ·{" "}
                      {scene.frameRateNumerator / scene.frameRateDenominator} fps
                    </small>
                  </span>
                  <span className={`readiness ${scene.assetReadiness}`}>
                    {scene.assetReadiness}
                  </span>
                </button>
              );
            })}
            {filteredLibrary.length === 0 && (
              <EmptyState
                icon={<Library size={28} />}
                title="No published scenes"
                detail="Import a GrapiX SceneDocument JSON to seed the offline Playout library."
              />
            )}
          </div>
          <button
            className="primary-button add-to-rundown"
            disabled={!selectedScene}
            onClick={() => selectedScene && addSceneToRundown(selectedScene)}
          >
            <Plus size={15} />
            Add to rundown
          </button>
        </Panel>

        <Panel
          className="rundown-panel"
          title={rundown?.name ?? "Rundown"}
          icon={<ListVideo size={15} />}
          actions={
            <span className="revision-label">
              rev {rundown?.revision ?? 0}
            </span>
          }
        >
          <div className="rundown-columns">
            <span>Pg</span>
            <span>Item</span>
            <span>Layer</span>
            <span>Status</span>
            <span />
          </div>
          <div className="rundown-scroll">
            {rundown?.segments.map((segment) => (
              <div
                className={[
                  "segment",
                  drag ? "drop-active" : "",
                  dropTarget?.segmentId === segment.segmentId && dropTarget.beforeItemId === null
                    ? "drop-here"
                    : ""
                ].join(" ")}
                key={segment.segmentId}
                onDragOver={(event) => {
                  if (!drag) return;
                  // Without preventDefault the browser refuses the drop entirely.
                  event.preventDefault();
                  event.dataTransfer.dropEffect = drag.kind === "scene" ? "copy" : "move";
                  setDropTarget({ segmentId: segment.segmentId, beforeItemId: null });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  void handleDrop({ segmentId: segment.segmentId, beforeItemId: null });
                }}
              >
                <div className="segment-header">
                  <span
                    className="segment-color"
                    style={{ background: segment.color }}
                  />
                  <ChevronDown size={13} />
                  <strong>{segment.name}</strong>
                  <small>
                    {
                      rundown.items.filter(
                        (item) => item.segmentId === segment.segmentId
                      ).length
                    }{" "}
                    items
                  </small>
                </div>
                {rundown.items
                  .filter((item) => item.segmentId === segment.segmentId)
                  .map((item, index, items) => {
                    const state = runtime.itemStates[item.itemId] ?? "NOT_LOADED";
                    const isProgram = runtime.programItemId === item.itemId;
                    const isPreview = runtime.previewItemId === item.itemId;
                    return (
                      <button
                        className={[
                          "rundown-row",
                          selectedItemId === item.itemId ? "selected" : "",
                          isProgram ? "program" : "",
                          isPreview ? "preview" : "",
                          drag?.kind === "item" && drag.itemId === item.itemId ? "dragging" : "",
                          dropTarget?.beforeItemId === item.itemId ? "drop-before" : ""
                        ].join(" ")}
                        key={item.itemId}
                        // The item on Program is deliberately still draggable: moving a
                        // row does not change what is on air, only its place in the
                        // running order.
                        draggable
                        onDragStart={(event) => {
                          setDrag({ kind: "item", itemId: item.itemId });
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", item.itemId);
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setDropTarget(null);
                        }}
                        onDragOver={(event) => {
                          if (!drag) return;
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect =
                            drag.kind === "scene" ? "copy" : "move";
                          setDropTarget({
                            segmentId: segment.segmentId,
                            beforeItemId: item.itemId
                          });
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void handleDrop({
                            segmentId: segment.segmentId,
                            beforeItemId: item.itemId
                          });
                        }}
                        onClick={() => setSelectedItemId(item.itemId)}
                      >
                        <span className="page-number">{item.pageNumber ?? "—"}</span>
                        <span className="item-name">
                          <strong>{item.name}</strong>
                          <small>
                            {item.sceneId} · v{item.sceneVersion}
                          </small>
                        </span>
                        <span className="layer-name">{item.layer}</span>
                        <span className={`state-tag state-${state.toLowerCase()}`}>
                          {state.replaceAll("_", " ")}
                        </span>
                        <span className="row-actions">
                          <span
                            role="button"
                            tabIndex={0}
                            className={index === 0 ? "disabled" : ""}
                            onClick={(event) => {
                              event.stopPropagation();
                              void moveItem(item.itemId, -1);
                            }}
                          >
                            <ChevronUp size={13} />
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            className={index === items.length - 1 ? "disabled" : ""}
                            onClick={(event) => {
                              event.stopPropagation();
                              void moveItem(item.itemId, 1);
                            }}
                          >
                            <ChevronDown size={13} />
                          </span>
                        </span>
                      </button>
                    );
                  })}
              </div>
            ))}
            {rundown?.items.length === 0 && (
              <EmptyState
                icon={<ListVideo size={30} />}
                title="Rundown is empty"
                detail="Select a published scene and add it to the active segment."
              />
            )}
          </div>
        </Panel>

        <section className="output-stack">
          <OutputMonitor
            kind="preview"
            title="PREVIEW"
            item={previewItem}
            connected={connected}
          />
          <OutputMonitor
            kind="program"
            title="PROGRAM"
            item={programItem}
            connected={connected}
          />
          {/*
            Output configuration lives beside Program because that is where the
            consequence is. The engine reports which outputs are live; the panel never
            infers it from an adapter name.
          */}
          <OutputsPanel
            engineConnected={engine?.connected === true}
            programFormat={programFormat}
          />
        </section>
      </section>

      <footer className="transport">
        <div className="selected-summary">
          <span className="eyebrow">Selected item</span>
          <strong>{selectedItem?.name ?? "No rundown item selected"}</strong>
          <small>
            {selectedItem
              ? `Page ${selectedItem.pageNumber ?? "—"} · ${selectedItem.layer} · ${selectedItem.transitionIn.type}`
              : "Choose an item before operating Preview or Program"}
          </small>
        </div>
        <div className="transport-controls">
          <button
            className="control-button cue"
            disabled={!selectedItem || busyAction !== null}
            onClick={() => execute("cue")}
          >
            <MonitorPlay size={18} />
            <span>
              <small>CUE</small>
              Preview
            </span>
          </button>
          <button
            className="control-button take"
            disabled={!selectedItem || busyAction !== null || !connected}
            onClick={() => execute("take")}
          >
            <Play size={19} fill="currentColor" />
            <span>
              <small>TAKE</small>
              Online
            </span>
          </button>
          <button className="control-button neutral" disabled>
            <SkipForward size={18} />
            <span>
              <small>NEXT</small>
              Continue
            </span>
          </button>
          <button className="control-button danger" disabled>
            <Square size={17} fill="currentColor" />
            <span>
              <small>OUT</small>
              Offline
            </span>
          </button>
        </div>
        <div className="output-summary">
          <Radio size={17} className={programItem ? "on-air" : ""} />
          <span>
            <small>PROGRAM</small>
            {programItem?.name ?? "Clear"}
          </span>
        </div>
      </footer>
    </main>
  );
}

function Panel({
  title,
  icon,
  actions,
  className,
  children
}: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
      <header className="panel-header">
        <span className="panel-title">
          {icon}
          {title}
        </span>
        <span className="panel-actions">{actions}</span>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function StatusPill({
  good,
  icon,
  label
}: {
  good: boolean;
  icon: ReactNode;
  label: string;
}) {
  return (
    <span className={`status-pill ${good ? "good" : "bad"}`}>
      {icon}
      {label}
    </span>
  );
}

function EmptyState({
  icon,
  title,
  detail
}: {
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function OutputMonitor({
  kind,
  title,
  item,
  connected
}: {
  kind: "preview" | "program";
  title: string;
  item: PlayoutRundownItem | null;
  connected: boolean;
}) {
  return (
    <section className={`output-monitor ${kind}`}>
      <header>
        <span className="output-label">
          <span className="output-light" />
          {title}
        </span>
        <span>{connected ? "NATIVE" : "OFFLINE"}</span>
      </header>
      <div className="monitor-screen checkerboard">
        {item ? (
          <div className="monitor-slate">
            <Clapperboard size={30} />
            <strong>{item.name}</strong>
            <small>
              {item.sceneId} · v{item.sceneVersion}
            </small>
          </div>
        ) : (
          <div className="monitor-slate muted">
            <Server size={28} />
            <strong>No scene assigned</strong>
            <small>{connected ? "Channel is clear" : "Renderer disconnected"}</small>
          </div>
        )}
      </div>
      <footer>
        <span>{item?.layer ?? "—"}</span>
        <span>{item?.pageNumber ? `PAGE ${item.pageNumber}` : "NO PAGE"}</span>
      </footer>
    </section>
  );
}

/**
 * One-line engine summary for the operator strip.
 *
 * Leads with the problem when there is one: an operator needs to see "engine
 * offline" before they see a GPU name.
 */
function engineLabel(engine: EngineHealthView | null): string {
  if (!engine) return "Engine unreachable";
  if (!engine.connected) {
    return engine.lastError ? `Engine ${engine.state}` : "Engine offline";
  }
  if (!engine.takeReady) return `Engine ${engine.state}`;

  const canvas = engine.maxLogicalCanvas
    ? ` · ${engine.maxLogicalCanvas.width}x${engine.maxLogicalCanvas.height} logical`
    : "";
  return `Engine ready${canvas}`;
}

function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}:${pad(Math.floor(date.getMilliseconds() / 40))}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
