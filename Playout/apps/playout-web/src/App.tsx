import type {
  PlayoutRuntimeStatus,
  PlayoutTakeEntry,
  PlayoutTakeList,
  PublishedSceneMetadata,
  SceneDocument
} from "@grapix/shared-types";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Clapperboard,
  Clock3,
  CloudDownload,
  Cpu,
  Database,
  FileInput,
  Hash,
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
  Trash2,
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
import {
  isProgramExplicitlyCleared,
  monitorStreamUrl,
  playoutApi,
  subscribeToPlayoutEvents,
  type EngineHealthView
} from "./api";
import { OutputsPanel } from "./OutputsPanel";

const emptyRuntime: PlayoutRuntimeStatus = {
  rendererConnection: "disconnected",
  previewRef: null,
  programRef: null,
  takeStates: {},
  lastError: null,
  updatedAt: new Date(0).toISOString()
};

/**
 * Reference a Scene Manager recall is tracked under.
 *
 * Mirrors `targetRef` in the control service. A direct recall has no take-list entry, so it
 * cannot borrow one — otherwise the Take List would highlight a row that is not on air.
 */
function sceneRef(takeId: number): string {
  return `scene:take-${takeId}`;
}

type OperatorAction = "cue" | "take" | "take-out" | "continue";

export function App() {
  const [library, setLibrary] = useState<PublishedSceneMetadata[]>([]);
  /** True while the control service's event stream is attached. */
  const [liveLink, setLiveLink] = useState(false);
  const [takeList, setTakeList] = useState<PlayoutTakeList | null>(null);
  const [runtime, setRuntime] = useState<PlayoutRuntimeStatus>(emptyRuntime);
  const [engine, setEngine] = useState<EngineHealthView | null>(null);
  const [clock, setClock] = useState(new Date());
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busyAction, setBusyAction] = useState<OperatorAction | null>(null);
  const [syncingEditor, setSyncingEditor] = useState(false);

  /** Scene Manager selection, by Take ID. */
  const [selectedTakeId, setSelectedTakeId] = useState<number | null>(null);
  /** Take List selection, by entry id. */
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  /** The recall field an operator types a Take ID into. */
  const [recall, setRecall] = useState("");

  const refreshLibrary = useCallback(async () => {
    setLibrary(await playoutApi.listScenes());
  }, []);

  const fetchFromEditor = useCallback(async () => {
    setSyncingEditor(true);
    setError(null);
    try {
      await playoutApi.syncFromEditor();
      await refreshLibrary();
    } catch (fetchError) {
      setError(errorMessage(fetchError));
    } finally {
      setSyncingEditor(false);
    }
  }, [refreshLibrary]);

  const handleRefresh = useCallback(async () => {
    try {
      await playoutApi.syncFromEditor();
      await refreshLibrary();
    } catch (error) {
      setError(errorMessage(error));
    }
  }, [refreshLibrary]);

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

  /**
   * Poll the render engine's health.
   *
   * Failure is normal — the engine may not be running — so it degrades to a null view rather
   * than surfacing an error banner. Memoised because the effect below depends on it; as a
   * plain function it got a new identity every render and re-opened the event stream.
   */
  const refreshEngine = useCallback(async () => {
    try {
      setEngine(await playoutApi.engine());
    } catch {
      setEngine(null);
    }
  }, []);

  const refreshTakeList = useCallback(async () => {
    const lists = await playoutApi.listTakeLists();
    const active = lists.find((list) => !list.archived) ?? (await playoutApi.createTakeList("Main"));
    setTakeList(active);
    return active;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [scenes, active] = await Promise.all([playoutApi.listScenes(), refreshTakeList()]);
        if (cancelled) return;
        setLibrary(scenes);
        setSelectedEntryId(active.cursorEntryId ?? active.entries[0]?.entryId ?? null);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();

    void refreshStatus();
    void refreshEngine();

    // The live link. A scene published from the Editor appears the moment it lands rather
    // than when someone remembers to press refresh. Polling stays as the floor: if the
    // stream drops, this degrades to the previous behaviour instead of freezing.
    const detachEvents = subscribeToPlayoutEvents(
      (kind) => {
        if (kind === "library.changed") {
          void refreshLibrary().catch((error: unknown) => setError(errorMessage(error)));
        }
        if (kind === "sequence.changed") {
          void refreshTakeList().catch((error: unknown) => setError(errorMessage(error)));
        }
        if (kind === "runtime.changed") void refreshStatus();
      },
      setLiveLink
    );

    const statusTimer = window.setInterval(refreshStatus, 3000);
    const engineTimer = window.setInterval(refreshEngine, 3000);
    const clockTimer = window.setInterval(() => setClock(new Date()), 250);
    const editorSyncTimer = window.setInterval(() => {
      void (async () => {
        try {
          await playoutApi.syncFromEditor();
          await refreshLibrary();
        } catch {
          // Background sync failure is silent
        }
      })();
    }, 10000);
    return () => {
      cancelled = true;
      detachEvents();
      window.clearInterval(statusTimer);
      window.clearInterval(engineTimer);
      window.clearInterval(clockTimer);
      window.clearInterval(editorSyncTimer);
    };
  }, [refreshEngine, refreshLibrary, refreshStatus, refreshTakeList]);

  /**
   * The Scene Manager list: one row per scene at its newest version.
   *
   * Older versions stay in the library and a pinned take-list entry still resolves to them,
   * but an operator recalling by Take ID means "the current one".
   */
  const sceneManager = useMemo(() => {
    const newest = new Map<string, PublishedSceneMetadata>();
    for (const scene of library) {
      const held = newest.get(scene.sceneId);
      if (!held || scene.version > held.version) newest.set(scene.sceneId, scene);
    }
    const query = search.trim().toLocaleLowerCase();
    return [...newest.values()]
      .filter(
        (scene) =>
          !query ||
          String(scene.takeId).includes(query) ||
          scene.name.toLocaleLowerCase().includes(query) ||
          (scene.category ?? "").toLocaleLowerCase().includes(query) ||
          scene.tags.some((tag) => tag.toLocaleLowerCase().includes(query))
      )
      .sort((left, right) => left.takeId - right.takeId);
  }, [library, search]);

  const selectedScene = sceneManager.find((scene) => scene.takeId === selectedTakeId) ?? null;
  const entries = takeList?.entries ?? [];
  const selectedEntry = entries.find((entry) => entry.entryId === selectedEntryId) ?? null;
  const connected = runtime.rendererConnection === "connected";

  const describeRef = useCallback(
    (ref: string | null): { name: string; detail: string } | null => {
      if (!ref) return null;
      const entry = entries.find((candidate) => candidate.entryId === ref);
      if (entry) {
        return { name: entry.name, detail: `${entry.sceneId} · v${entry.sceneVersion}` };
      }
      const takeId = Number(ref.replace("scene:take-", ""));
      const scene = library.find((candidate) => candidate.takeId === takeId);
      return scene
        ? { name: scene.name, detail: `take ${scene.takeId} · v${scene.version}` }
        : { name: ref, detail: "no longer in the library" };
    },
    [entries, library]
  );

  const previewSlate = describeRef(runtime.previewRef);
  const programSlate = describeRef(runtime.programRef);
  const programExplicitlyCleared = isProgramExplicitlyCleared(runtime);

  /**
   * The format an output should be configured at.
   *
   * Taken from the scene the operator is about to air — or the newest published scene when
   * nothing is selected — because a published scene carries the project's resolution and
   * rational rate. The fallback is HD/50p rather than nothing, so the Add Output dialog always
   * opens with a sane format instead of zeroes.
   */
  const programFormat = useMemo(() => {
    const onAir = runtime.programRef;
    const entry = onAir ? entries.find((candidate) => candidate.entryId === onAir) : undefined;
    const scene =
      (entry
        ? library.find((candidate) => candidate.sceneId === entry.sceneId)
        : onAir
          ? library.find(
              (candidate) => candidate.takeId === Number(onAir.replace("scene:take-", ""))
            )
          : undefined) ?? selectedScene ?? library[0];

    return {
      width: scene?.canvasWidth ?? 1920,
      height: scene?.canvasHeight ?? 1080,
      frameRate: {
        numerator: scene?.frameRateNumerator ?? 50,
        denominator: scene?.frameRateDenominator ?? 1
      },
      colorSpace: scene?.colorSpace ?? "rec709"
    };
  }, [entries, library, runtime.programRef, selectedScene]);

  const run = useCallback(
    async (action: OperatorAction, body: () => Promise<PlayoutRuntimeStatus | void>) => {
      setBusyAction(action);
      setError(null);
      try {
        const status = await body();
        if (status) setRuntime(status);
      } catch (actionError) {
        setError(errorMessage(actionError));
        await refreshStatus();
      } finally {
        setBusyAction(null);
      }
    },
    [refreshStatus]
  );

  /** Recall a Take ID straight to air — the Scene Manager's whole point. */
  const recallTakeId = useCallback(
    async (takeId: number, action: "cue" | "take") => {
      await run(action, () =>
        action === "cue"
          ? playoutApi.cueSceneByTakeId(takeId)
          : playoutApi.takeSceneByTakeId(takeId)
      );
    },
    [run]
  );

  async function saveList(next: PlayoutTakeList) {
    try {
      setTakeList(await playoutApi.saveTakeList(next));
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  async function appendScene(scene: PublishedSceneMetadata) {
    if (!takeList) return;
    const entry: PlayoutTakeEntry = {
      entryId: `entry_${crypto.randomUUID()}`,
      sceneId: scene.sceneId,
      sceneVersion: scene.version,
      versionPolicy: "latest",
      name: scene.name,
      layer: "Overlay",
      transitionIn: { type: scene.defaultTransition, durationFrames: 0, delayFrames: 0 },
      transitionOut: { type: "cut", durationFrames: 0, delayFrames: 0 },
      instanceData: {},
      notes: "",
      color: "#4077b8",
      completed: false
    };
    const next: PlayoutTakeList = {
      ...takeList,
      entries: [...takeList.entries, entry],
      cursorEntryId: takeList.cursorEntryId ?? entry.entryId
    };
    setSelectedEntryId(entry.entryId);
    await saveList(next);
  }

  async function moveEntry(entryId: string, delta: -1 | 1) {
    if (!takeList) return;
    const index = takeList.entries.findIndex((entry) => entry.entryId === entryId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= takeList.entries.length) return;
    const reordered = [...takeList.entries];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    await saveList({ ...takeList, entries: reordered });
  }

  async function removeEntry(entryId: string) {
    if (!takeList) return;
    const entries = takeList.entries.filter((entry) => entry.entryId !== entryId);
    await saveList({
      ...takeList,
      entries,
      // The cursor cannot point at something that is gone.
      cursorEntryId:
        takeList.cursorEntryId === entryId
          ? entries[0]?.entryId ?? null
          : takeList.cursorEntryId
    });
    if (selectedEntryId === entryId) setSelectedEntryId(null);
  }

  async function removeSelectedScene() {
    if (!selectedScene) return;
    if (!window.confirm(
      `Remove "${selectedScene.name}" and all of its published versions from Playout?`
    )) {
      return;
    }

    try {
      await playoutApi.removeScene(selectedScene.sceneId, true);
      setSelectedTakeId(null);
      await refreshLibrary();
    } catch (removeError) {
      setError(errorMessage(removeError));
    }
  }

  async function importScene(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const scene = JSON.parse(await file.text()) as SceneDocument;
      await playoutApi.publishScene(scene);
      await refreshLibrary();
    } catch (importError) {
      setError(errorMessage(importError));
    }
  }

  function submitRecall(event: React.FormEvent) {
    event.preventDefault();
    const takeId = Number(recall.trim());
    if (!Number.isSafeInteger(takeId)) {
      setError(`"${recall}" is not a take ID`);
      return;
    }
    if (!library.some((scene) => scene.takeId === takeId)) {
      setError(`No published scene has take ID ${takeId}`);
      return;
    }
    setSelectedTakeId(takeId);
    setRecall("");
    void recallTakeId(takeId, "take");
  }

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
            icon={engine?.connected ? <Cpu size={13} /> : <WifiOff size={13} />}
            label={engineLabel(engine)}
          />
          <StatusPill
            good={liveLink}
            icon={liveLink ? <Database size={13} /> : <WifiOff size={13} />}
            label={liveLink ? "Editor link live" : "Editor link polling"}
          />
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
        {/*
          The Scene Manager is the primary surface, as in XPression: every published scene with
          a Take ID, and a recall field that puts one on air without any list at all.
        */}
        <Panel
          className="library-panel"
          title="Scene Manager"
          icon={<Library size={15} />}
          actions={
            <>
              <button
                className="small-button"
                disabled={syncingEditor}
                onClick={() => void fetchFromEditor()}
                title="Check for new or updated scenes from Editor (http://127.0.0.1:4100)"
              >
                <CloudDownload size={13} className={syncingEditor ? "spin" : ""} />
                {syncingEditor ? "Fetching…" : "Fetch"}
              </button>
              <label className="small-button import-button">
                <FileInput size={13} />
                Import
                <input type="file" accept=".json,application/json" onChange={importScene} />
              </label>
              <button
                className="icon-button"
                onClick={() => void handleRefresh()}
                title="Refresh library and sync updated scenes from Editor"
              >
                <RefreshCw size={14} className={syncingEditor ? "spin" : ""} />
              </button>
            </>
          }
        >
          <form className="recall-box" onSubmit={submitRecall}>
            <Hash size={14} />
            <input
              value={recall}
              onChange={(event) => setRecall(event.target.value)}
              placeholder="Take ID to air"
              inputMode="numeric"
              aria-label="Recall a scene by take ID"
            />
            <button className="small-button" type="submit" disabled={!connected}>
              Take
            </button>
          </form>

          <div className="search-box">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search take ID, name, category or tag"
            />
          </div>

          <div className="library-list">
            {sceneManager.map((scene) => {
              const onAir = runtime.programRef === sceneRef(scene.takeId);
              return (
                <button
                  key={scene.sceneId}
                  className={`scene-card ${selectedTakeId === scene.takeId ? "selected" : ""} ${
                    onAir ? "on-air" : ""
                  }`}
                  onClick={() => setSelectedTakeId(scene.takeId)}
                  onDoubleClick={() => void recallTakeId(scene.takeId, "take")}
                  title="Double-click to take straight to air"
                >
                  <span className="take-id">{scene.takeId}</span>
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
                      {scene.category ? ` · ${scene.category}` : ""}
                    </small>
                  </span>
                  <span className={`readiness ${scene.assetReadiness}`}>
                    {scene.assetReadiness}
                  </span>
                </button>
              );
            })}
            {sceneManager.length === 0 && (
              <EmptyState
                icon={<Library size={28} />}
                title="No published scenes"
                detail="Publish from the Editor, or import a GrapiX SceneDocument JSON."
              />
            )}
          </div>

          <div className="library-actions">
            <button
              className="primary-button"
              disabled={!selectedScene || !connected || busyAction !== null}
              onClick={() => selectedScene && void recallTakeId(selectedScene.takeId, "take")}
            >
              <Play size={15} />
              Take to air
            </button>
            <button
              className="small-button"
              disabled={!selectedScene}
              onClick={() => selectedScene && void appendScene(selectedScene)}
            >
              <Plus size={14} />
              Add to take list
            </button>
            <button
              className="small-button danger"
              disabled={!selectedScene}
              onClick={() => void removeSelectedScene()}
              title="Remove every published version; on-air or take-list scenes are protected"
            >
              <Trash2 size={14} />
              Remove
            </button>
          </div>
        </Panel>

        {/* The ordered list, for a scripted show. Optional: the Scene Manager stands alone. */}
        <Panel
          className="rundown-panel"
          title={takeList?.name ?? "Take List"}
          icon={<ListVideo size={15} />}
          actions={<span className="revision-label">{entries.length} takes</span>}
        >
          <div className="rundown-columns take-list-columns">
            <span>#</span>
            <span>Take</span>
            <span>Layer</span>
            <span>Status</span>
            <span />
          </div>
          <div className="rundown-scroll">
            {entries.map((entry, index) => {
              const state = runtime.takeStates[entry.entryId] ?? "NOT_LOADED";
              return (
                <div
                  key={entry.entryId}
                  className={[
                    "take-row",
                    selectedEntryId === entry.entryId ? "selected" : "",
                    takeList?.cursorEntryId === entry.entryId ? "cursor" : "",
                    runtime.programRef === entry.entryId ? "online" : "",
                    runtime.previewRef === entry.entryId ? "preview" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => setSelectedEntryId(entry.entryId)}
                >
                  <span className="page-number">{index + 1}</span>
                  <span className="item-name">
                    <strong>{entry.name}</strong>
                    <small>
                      {entry.sceneId} · v{entry.sceneVersion} ·{" "}
                      {entry.versionPolicy === "pinned" ? "pinned" : "latest"}
                    </small>
                  </span>
                  <span className="layer-name">{entry.layer}</span>
                  <span className={`take-state ${state.toLowerCase()}`}>
                    {state.replace(/_/g, " ")}
                  </span>
                  <span className="row-actions">
                    <button
                      className="icon-button"
                      title="Move up"
                      disabled={index === 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        void moveEntry(entry.entryId, -1);
                      }}
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      className="icon-button"
                      title="Move down"
                      disabled={index === entries.length - 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        void moveEntry(entry.entryId, 1);
                      }}
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      className="icon-button"
                      title="Remove from take list"
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeEntry(entry.entryId);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
            {entries.length === 0 && (
              <EmptyState
                icon={<ListVideo size={30} />}
                title="Take list is empty"
                detail="The Scene Manager can put any scene on air by Take ID. Add takes here only for a scripted running order."
              />
            )}
          </div>
        </Panel>

        <section className="output-stack">
          <OutputMonitor kind="preview" title="PREVIEW" slate={previewSlate} connected={connected} />
          <OutputMonitor
            kind="program"
            title="PROGRAM"
            slate={programSlate}
            connected={connected}
            explicitlyCleared={programExplicitlyCleared}
          />
          {/*
            Output configuration lives beside Program because that is where the consequence is.
            The engine reports which outputs are live; the panel never infers it from an
            adapter name.
          */}
          <OutputsPanel
            engineConnected={engine?.connected === true}
            programFormat={programFormat}
          />
        </section>
      </section>

      <footer className="transport">
        <div className="selected-summary">
          <span className="eyebrow">Selected</span>
          <strong>
            {selectedEntry?.name ?? selectedScene?.name ?? "Nothing selected"}
          </strong>
          <small>
            {selectedEntry
              ? `Take list · ${selectedEntry.layer} · ${selectedEntry.transitionIn.type}`
              : selectedScene
                ? `Scene Manager · take ${selectedScene.takeId} · v${selectedScene.version}`
                : "Pick a scene or a take before operating Preview or Program"}
          </small>
        </div>
        <div className="transport-controls">
          <button
            className="control-button cue"
            disabled={(!selectedEntry && !selectedScene) || busyAction !== null}
            onClick={() =>
              selectedEntry && takeList
                ? void run("cue", () => playoutApi.cueEntry(takeList.takeListId, selectedEntry.entryId))
                : selectedScene && void recallTakeId(selectedScene.takeId, "cue")
            }
          >
            <MonitorPlay size={18} />
            <span>
              <small>CUE</small>
              Preview
            </span>
          </button>
          <button
            className="control-button take"
            disabled={(!selectedEntry && !selectedScene) || busyAction !== null || !connected}
            onClick={() =>
              selectedEntry && takeList
                ? void run("take", () =>
                    playoutApi.takeEntry(takeList.takeListId, selectedEntry.entryId)
                  )
                : selectedScene && void recallTakeId(selectedScene.takeId, "take")
            }
          >
            <Play size={19} fill="currentColor" />
            <span>
              <small>TAKE</small>
              Online
            </span>
          </button>
          <button
            className="control-button neutral"
            disabled={!takeList || entries.length === 0 || busyAction !== null}
            onClick={() =>
              takeList &&
              void run("continue", async () => {
                const { takeList: advanced, status } = await playoutApi.continueTakeList(
                  takeList.takeListId
                );
                setTakeList(advanced);
                setSelectedEntryId(advanced.cursorEntryId);
                return status;
              })
            }
          >
            <SkipForward size={18} />
            <span>
              <small>NEXT</small>
              Continue
            </span>
          </button>
          <button
            className="control-button danger"
            disabled={!runtime.programRef || busyAction !== null}
            onClick={() => void run("take-out", () => playoutApi.takeOut())}
          >
            <Square size={17} fill="currentColor" />
            <span>
              <small>OUT</small>
              Offline
            </span>
          </button>
        </div>
        <div className="output-summary">
          <Radio size={17} className={runtime.programRef ? "on-air" : ""} />
          <span>
            <small>PROGRAM</small>
            {programSlate?.name ?? "Clear"}
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

/**
 * A channel monitor.
 *
 * The slate is the *background layer*, not an alternative branch: the picture is painted
 * on top of it. Any gap — no engine, nothing cued, a stream that has not delivered its
 * first frame — shows through as the slate without a state machine deciding which to
 * render. Program is what an operator trusts; it must never show a blank box because a
 * flag disagreed with reality.
 *
 * Gated on the engine connection alone, deliberately *not* on whether Playout remembers
 * something being on the channel. That record lives in the control service's memory and
 * is empty after a restart, while the engine keeps rendering — so gating on it would
 * blank a monitor over a live Program. The engine is the authority on what is on a
 * channel, and the picture arriving is the proof.
 *
 * **FILL / KEY** is the broadcast way to check a graphic. Fill is the colour; key is the
 * greyscale matte the downstream keyer cuts — white opaque, black transparent, grey for the
 * feathered shadows and anti-aliased edges a clipped key destroys. SDI carries no alpha, so
 * these are separate signals in a real plant, and the engine renders each on request. This
 * is why the monitor needs no alpha-capable codec: a key is just a greyscale picture.
 *
 * One MJPEG connection, held open. The control service owns retries and starts the engine
 * stream on the first viewer, so a monitor opened before anything is cued begins painting
 * when a scene is taken — with no reconnect here and no reload by the operator. A panel
 * nobody is looking at costs no GPU work, because the last viewer leaving stops the stream.
 */
function OutputMonitor({
  kind,
  title,
  slate,
  connected,
  explicitlyCleared = false
}: {
  kind: "preview" | "program";
  title: string;
  slate: { name: string; detail: string } | null;
  connected: boolean;
  explicitlyCleared?: boolean;
}) {
  const [view, setView] = useState<"fill" | "key">("fill");
  const [painting, setPainting] = useState(false);

  useEffect(() => {
    if (!connected) setPainting(false);
  }, [connected]);

  // Switching view is a different render, so the picture is not valid until the new stream
  // delivers. Letting the old one show would label a fill as a key.
  useEffect(() => {
    setPainting(false);
  }, [view]);

  return (
    <section className={`output-monitor ${kind}`}>
      <header>
        <span className="output-label">
          <span className="output-light" />
          {title}
        </span>
        <span className="monitor-header-right">
          <span className="monitor-view-toggle">
            {(["fill", "key"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={view === candidate ? "active" : ""}
                onClick={() => setView(candidate)}
                title={
                  candidate === "fill"
                    ? "Fill: the colour an audience sees"
                    : "Key: the greyscale matte the downstream keyer cuts"
                }
              >
                {candidate.toUpperCase()}
              </button>
            ))}
          </span>
          <span>{explicitlyCleared ? "CLEAR" : painting ? "LIVE" : connected ? "NATIVE" : "OFFLINE"}</span>
        </span>
      </header>
      <div className="monitor-screen checkerboard">
        {slate ? (
          <div className="monitor-slate">
            <Clapperboard size={30} />
            <strong>{slate.name}</strong>
            <small>{slate.detail}</small>
          </div>
        ) : (
          <div className="monitor-slate muted">
            <Server size={28} />
            <strong>{painting ? "On air from the engine" : "No scene assigned"}</strong>
            <small>{connected ? "Channel is clear" : "Renderer disconnected"}</small>
          </div>
        )}
        {connected ? (
          <img
            // One element, reused. A `key` here would remount on every view change, and
            // Chromium does *not* close an MJPEG connection when its `<img>` is detached —
            // the stranded stream keeps rendering server-side and spends one of the engine's
            // four stream slots. Assigning a new `src` on the same element aborts the
            // previous load, which is what actually releases it.
            className={`monitor-frames${painting ? " painting" : ""}`}
            src={monitorStreamUrl(kind, view)}
            alt={`${title} ${view}`}
            onLoad={() => setPainting(true)}
            onError={() => setPainting(false)}
          />
        ) : null}
        {explicitlyCleared ? <div className="monitor-clear-cover" aria-hidden="true" /> : null}
      </div>
      <footer>
        <span>{slate?.detail ?? "—"}</span>
        <span>
          {explicitlyCleared
            ? "CLEAR"
            : painting
              ? `${title} · ${view.toUpperCase()}`
              : slate
                ? title
                : "CLEAR"}
        </span>
      </footer>
    </section>
  );
}

/**
 * One-line engine summary for the operator strip.
 *
 * Leads with the problem when there is one: an operator needs to see "engine offline" before
 * they see a GPU name.
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
