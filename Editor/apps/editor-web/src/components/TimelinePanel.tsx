import {
  ANIMATABLE_PROPERTIES,
  sampleChannel,
  type AnimatableProperty,
  type PropertyChannel,
  type PropertyKeyframe,
  type SceneKeyframeEasing,
  type SceneObject
} from "@grapix/shared-types";
import { capturePointer } from "../lib/pointerCapture";
import {
  Activity,
  BarChart3,
  Diamond,
  Layers,
  Pause,
  Play,
  SkipBack,
  Trash2
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import {
  frameFromClientX,
  frameToMarkerPosition,
  frameToPercent
} from "./timelineMath";
import { computeRowWindow, rowWindowSpacers } from "./rowWindow";
import {
  clampFrameDelta,
  collectTimelineKeys,
  createTimelineRows,
  keysInMarquee,
  type MaskTimelineProperty,
  type TimelineKeyRef,
  type TimelineMarquee
} from "./timelineModel";

interface SelectedPropertyKey {
  objectId: string;
  property: AnimatableProperty;
  keyframeId?: string;
}

const ROW_HEIGHT = 28;
const RULER_HEIGHT = 28;
/** Pointer travel before a press becomes a drag, so a click does not micro-move a key. */
const DRAG_THRESHOLD_PX = 3;

export function TimelinePanel() {
  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const selectedObjectIds = useEditorStore((state) => state.selectedObjectIds);
  const selectObjects = useEditorStore((state) => state.selectObjects);
  const updateObjectKeyframe = useEditorStore((state) => state.updateObjectKeyframe);
  const updatePropertyKeyframe = useEditorStore((state) => state.updatePropertyKeyframe);
  const deletePropertyKeyframe = useEditorStore((state) => state.deletePropertyKeyframe);
  const updateMaskKeyframeFrame = useEditorStore((state) => state.updateMaskKeyframeFrame);
  const updateShapePathKeyframeFrame = useEditorStore((state) => state.updateShapePathKeyframeFrame);
  const deleteShapePathKeyframe = useEditorStore((state) => state.deleteShapePathKeyframe);
  const timelinePlaying = useUiStore((state) => state.timelinePlaying);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const toggleTimelinePlayback = useUiStore((state) => state.toggleTimelinePlayback);
  const goToStart = useUiStore((state) => state.goToStart);
  const stepTimeline = useUiStore((state) => state.stepTimeline);
  const setCurrentFrame = useUiStore((state) => state.setCurrentFrame);
  const selectedMaskId = useUiStore((state) => state.selectedMaskId);
  const setSelectedMaskId = useUiStore((state) => state.setSelectedMaskId);
  const timelineRowFilter = useUiStore((state) => state.timelineRowFilter);
  const setTimelineRowFilter = useUiStore((state) => state.setTimelineRowFilter);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const deleteObjectKeyframe = useEditorStore((state) => state.deleteObjectKeyframe);
  const [mode, setMode] = useState<"keys" | "speed">("keys");
  const [selectedPropertyKey, setSelectedPropertyKey] = useState<SelectedPropertyKey | null>(null);
  const [selectedKeyIds, setSelectedKeyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [marquee, setMarquee] = useState<TimelineMarquee | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const durationFrames = scene.timeline.durationFrames;
  const rows = useMemo(
    () => createTimelineRows(scene.objects, timelineRowFilter),
    [scene.objects, timelineRowFilter]
  );
  const rowIndexById = useMemo(
    () => new Map(rows.map((row, index) => [row.id, index])),
    [rows]
  );
  const timelineKeys = useMemo(
    () => collectTimelineKeys(scene.objects, scene.timeline.keyframes),
    [scene.objects, scene.timeline.keyframes]
  );
  /** Only keys on a visible row can be drawn, marquee'd or moved. */
  const visibleKeys = useMemo(
    () => timelineKeys.filter((key) => rowIndexById.has(key.rowId)),
    [rowIndexById, timelineKeys]
  );

  /*
   * Windowing. Only the rows on screen are mounted: a show-sized scene reaches thousands of channels
   * and keyframe markers, and drawing all of them cost that on every scrub frame while the author
   * could see forty. The scroller is the grid itself — in `advanced-key-grid` both columns scroll
   * together — so one scrollTop drives the label gutter, the track lines and the markers alike.
   */
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const scrollObserver = useRef<ResizeObserver | null>(null);
  /*
   * A callback ref rather than an effect, because the scroller is conditionally rendered: with no
   * scene open this panel shows an empty state and there is no grid to measure. An effect with `[]`
   * deps ran once against a null ref, never retried, and left the height at zero — which the window
   * reads as "unmeasured" and answers by drawing every row. Attaching on mount of the node itself is
   * the only version that cannot miss it.
   */
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollObserver.current?.disconnect();
    scrollObserver.current = null;
    if (!element) return;
    const measure = () => setViewport({ scrollTop: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    scrollObserver.current = observer;
  }, []);
  const rowWindow = useMemo(
    () =>
      computeRowWindow({
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.height,
        rowHeight: ROW_HEIGHT,
        rowCount: rows.length,
        headerHeight: RULER_HEIGHT,
        // Six rows of margin: a marker the pointer reaches during a drag has to be mounted already,
        // because one that mounts mid-drag never received the pointer capture.
        overscan: 6
      }),
    [rows.length, viewport.height, viewport.scrollTop]
  );
  /** The windowed rows, carrying their true index so absolute positions stay correct. */
  const windowedRows = useMemo(
    () => rows.slice(rowWindow.first, rowWindow.last + 1).map((row, offset) => ({ row, index: rowWindow.first + offset })),
    [rowWindow.first, rowWindow.last, rows]
  );
  const spacers = useMemo(
    () => rowWindowSpacers(rowWindow, rows.length, ROW_HEIGHT),
    [rowWindow, rows.length]
  );
  /** Markers are drawn only for rows that are mounted; the rest cannot be seen or grabbed. */
  const windowedKeys = useMemo(
    () => visibleKeys.filter((key) => {
      const index = rowIndexById.get(key.rowId);
      return index !== undefined && index >= rowWindow.first && index <= rowWindow.last;
    }),
    [rowIndexById, rowWindow.first, rowWindow.last, visibleKeys]
  );

  /**
   * The live drag. A ref rather than state because it is written on every pointer move and
   * nothing renders from it — and because the start frames must be the ones captured at
   * pointer-down: reading them back from the scene mid-drag makes each move compound the last
   * and the selection accelerates away from the cursor.
   */
  const keyDragRef = useRef<{
    pointerId: number;
    originFrame: number;
    originClientX: number;
    startFrames: Map<string, number>;
    refs: TimelineKeyRef[];
    appliedDelta: number;
    moved: boolean;
  } | null>(null);
  const marqueeRef = useRef<{ pointerId: number; additive: boolean; base: ReadonlySet<string> } | null>(null);
  const scrubRef = useRef<number | null>(null);

  useEffect(() => {
    if (!hasActiveScene || !timelinePlaying) return undefined;
    const intervalId = window.setInterval(
      () => stepTimeline(durationFrames),
      1000 / scene.timeline.fps
    );
    return () => window.clearInterval(intervalId);
  }, [durationFrames, hasActiveScene, scene.timeline.fps, stepTimeline, timelinePlaying]);

  useEffect(() => {
    if (!hasActiveScene) {
      if (currentFrame !== 0 || timelinePlaying) goToStart();
      return;
    }

    setCurrentFrame(currentFrame, durationFrames);
  }, [
    currentFrame,
    durationFrames,
    goToStart,
    hasActiveScene,
    setCurrentFrame,
    timelinePlaying
  ]);

  useEffect(() => {
    if (!selectedObjectId) {
      setSelectedPropertyKey(null);
      return;
    }
    const object = scene.objects.find((item) => item.id === selectedObjectId);
    if (!object) return;
    const currentChannel = selectedPropertyKey?.objectId === object.id
      ? object.animation?.[selectedPropertyKey.property]
      : undefined;
    if (currentChannel) return;
    const firstProperty = ANIMATABLE_PROPERTIES.find((property) => object.animation?.[property]);
    setSelectedPropertyKey(firstProperty ? { objectId: object.id, property: firstProperty } : null);
  }, [scene.objects, selectedObjectId, selectedPropertyKey?.objectId, selectedPropertyKey?.property]);

  const selectedObject = selectedPropertyKey
    ? scene.objects.find((object) => object.id === selectedPropertyKey.objectId)
    : undefined;
  const selectedChannel = selectedObject && selectedPropertyKey
    ? selectedObject.animation?.[selectedPropertyKey.property]
    : undefined;
  const selectedKey = selectedChannel && selectedPropertyKey?.keyframeId
    ? selectedChannel.keys.find((key) => key.id === selectedPropertyKey.keyframeId)
    : undefined;

  const frameForClientX = useCallback((clientX: number): number => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return frameFromClientX(clientX, rect.left, rect.width, durationFrames);
  }, [durationFrames]);

  /** Which track row a pointer is over. The ruler's own header occupies the first band. */
  const rowForClientY = useCallback((clientY: number): number => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const offset = clientY - rect.top - RULER_HEIGHT;
    return Math.max(0, Math.min(rows.length - 1, Math.floor(offset / ROW_HEIGHT)));
  }, [rows.length]);

  /** Write one key's frame, whichever kind of key it is. */
  const applyKeyFrame = useCallback((key: TimelineKeyRef, frame: number) => {
    switch (key.kind) {
      case "property":
        updatePropertyKeyframe(key.objectId, key.property, key.keyId, { frame });
        return;
      case "legacy":
        updateObjectKeyframe(key.keyId, { frame });
        return;
      case "mask":
        updateMaskKeyframeFrame(key.objectId, key.maskId, key.maskProperty, key.keyId, frame);
        return;
      case "shape-path":
        updateShapePathKeyframeFrame(key.objectId, key.keyId, frame);
    }
  }, [
    updateMaskKeyframeFrame,
    updateObjectKeyframe,
    updatePropertyKeyframe,
    updateShapePathKeyframeFrame
  ]);

  function selectKeyRow(key: TimelineKeyRef) {
    selectObject(key.objectId);
    if (key.kind === "property") {
      setSelectedPropertyKey({ objectId: key.objectId, property: key.property, keyframeId: key.keyId });
    }
    if (key.kind === "mask") setSelectedMaskId(key.maskId);
  }

  /**
   * Press on a key.
   *
   * Shift or Ctrl toggles membership and starts no drag — an author refining a selection is not
   * asking to move it. Pressing an already-selected key keeps the whole group, so a five-key
   * selection drags as five keys rather than collapsing to the one under the cursor.
   */
  function beginKeyDrag(event: ReactPointerEvent<HTMLButtonElement>, key: TimelineKeyRef) {
    event.preventDefault();
    event.stopPropagation();
    setNotice(null);

    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      const next = new Set(selectedKeyIds);
      if (next.has(key.id)) next.delete(key.id);
      else next.add(key.id);
      setSelectedKeyIds(next);
      selectKeyRow(key);
      return;
    }

    const selection = selectedKeyIds.has(key.id) ? new Set(selectedKeyIds) : new Set([key.id]);
    setSelectedKeyIds(selection);
    selectKeyRow(key);
    setCurrentFrame(key.frame, durationFrames);

    const refs = visibleKeys.filter((candidate) => selection.has(candidate.id));
    capturePointer(event.currentTarget, event.pointerId);
    beginHistory(refs.length > 1 ? `Move ${refs.length} keyframes` : "Move keyframe");
    keyDragRef.current = {
      pointerId: event.pointerId,
      originFrame: frameForClientX(event.clientX),
      originClientX: event.clientX,
      startFrames: new Map(refs.map((candidate) => [candidate.id, candidate.frame])),
      refs,
      appliedDelta: 0,
      moved: false
    };
  }

  function dragKeys(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = keyDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.abs(event.clientX - drag.originClientX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    const delta = clampFrameDelta(
      [...drag.startFrames.values()],
      frameForClientX(event.clientX) - drag.originFrame,
      durationFrames
    );
    if (delta === drag.appliedDelta) return;
    drag.appliedDelta = delta;

    for (const key of drag.refs) {
      const start = drag.startFrames.get(key.id);
      if (start !== undefined) applyKeyFrame(key, start + delta);
    }
  }

  /**
   * End of any key drag. `commitHistory` is safe on a press that never moved: it compares the
   * scene against the transaction's snapshot and leaves the undo stack alone when nothing
   * changed, so a click does not deposit an empty undo step.
   */
  function endKeyDrag() {
    if (!keyDragRef.current) return;
    keyDragRef.current = null;
    commitHistory();
  }

  function beginMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Only an empty stretch of track starts a box; markers stop propagation before this runs.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    setNotice(null);

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    marqueeRef.current = {
      pointerId: event.pointerId,
      additive,
      base: additive ? new Set(selectedKeyIds) : new Set()
    };
    if (!additive) setSelectedKeyIds(new Set());

    const frame = frameForClientX(event.clientX);
    const row = rowForClientY(event.clientY);
    setMarquee({ frameFrom: frame, frameTo: frame, rowFrom: row, rowTo: row });
  }

  function dragMarquee(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = marqueeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    setMarquee((current) => {
      if (!current) return current;
      const next = {
        ...current,
        frameTo: frameForClientX(event.clientX),
        rowTo: rowForClientY(event.clientY)
      };
      const caught = keysInMarquee(visibleKeys, next, rowIndexById);
      setSelectedKeyIds(new Set([...drag.base, ...caught]));
      return next;
    });
  }

  function endMarquee() {
    marqueeRef.current = null;
    setMarquee(null);
  }

  /**
   * Delete the selection.
   *
   * Mask keys are excluded because no store action deletes one — reporting that is the point.
   * Silently dropping them from the count would tell the author their selection was removed
   * when four of its keys are still on the track.
   */
  function deleteSelectedKeys() {
    const selected = visibleKeys.filter((key) => selectedKeyIds.has(key.id));
    if (!selected.length) return;

    const maskKeys = selected.filter((key) => key.kind === "mask").length;
    beginHistory(`Delete ${selected.length - maskKeys} keyframes`);
    for (const key of selected) {
      if (key.kind === "property") deletePropertyKeyframe(key.objectId, key.property, key.keyId);
      else if (key.kind === "legacy") deleteObjectKeyframe(key.keyId);
      else if (key.kind === "shape-path") deleteShapePathKeyframe(key.objectId, key.keyId);
    }
    commitHistory();

    setSelectedKeyIds(new Set());
    setNotice(
      maskKeys
        ? `${maskKeys} mask key${maskKeys === 1 ? "" : "s"} kept — mask keyframes cannot be deleted from the timeline.`
        : null
    );
  }

  /**
   * Scrubbing.
   *
   * Pointer capture is what makes it smooth in both directions: without it the pointer leaving
   * the 28px ruler band ends the gesture, which is why dragging the playhead backwards used to
   * stop the moment the cursor strayed. The frame follows the pointer for as long as the button
   * is held, wherever it goes.
   */
  function beginScrub(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    scrubRef.current = event.pointerId;
    setCurrentFrame(frameForClientX(event.clientX), durationFrames);
  }

  /**
   * Tracked by the ref rather than by `hasPointerCapture`, so a capture the browser refused is
   * not the difference between a scrubber that follows the pointer and one that moves once and
   * then sticks.
   */
  function dragScrub(event: ReactPointerEvent<HTMLElement>) {
    if (scrubRef.current !== event.pointerId) return;
    setCurrentFrame(frameForClientX(event.clientX), durationFrames);
  }

  function endScrub() {
    scrubRef.current = null;
  }

  function scrubFromKeyboard(event: { key: string; shiftKey: boolean; preventDefault: () => void }) {
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setCurrentFrame(currentFrame - step, durationFrames);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setCurrentFrame(currentFrame + step, durationFrames);
    } else if (event.key === "Home") {
      event.preventDefault();
      setCurrentFrame(0, durationFrames);
    } else if (event.key === "End") {
      event.preventDefault();
      setCurrentFrame(durationFrames, durationFrames);
    }
  }

  // Delete works on the panel rather than on each marker: a marquee selection has no focused
  // element, so a key handler bound to one diamond can never see the keystroke.
  useEffect(() => {
    if (!selectedKeyIds.size) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!rulerRef.current?.closest(".timeline-panel")?.contains(target)) return;
      event.preventDefault();
      deleteSelectedKeys();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // A key that disappears — undo, a deleted object, a filter change — must not stay selected,
  // or the next group drag reports a count the timeline is not showing.
  useEffect(() => {
    setSelectedKeyIds((current) => {
      if (!current.size) return current;
      const live = new Set(visibleKeys.map((key) => key.id));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleKeys]);

  return (
    <section className="timeline-panel advanced-timeline">
      <div className="dock-panel-title timeline-titlebar">
        <div className="timeline-mode-switch" aria-label="Timeline editor mode">
          <button className={mode === "keys" ? "active" : ""} onClick={() => setMode("keys")} title="Keyframe timeline">
            <Diamond size={13} /><span>Keys</span>
          </button>
          <button className={mode === "speed" ? "active" : ""} onClick={() => setMode("speed")} title="Speed graph editor">
            <Activity size={13} /><span>Speed Graph</span>
          </button>
        </div>
        <div className="mini-action-row">
          <label className="timeline-frame-field" title="Current frame">
            <span>Frame</span>
            <input
              max={durationFrames}
              min={0}
              onChange={(event) => setCurrentFrame(Number(event.target.value), durationFrames)}
              type="number"
              value={currentFrame}
            />
          </label>
          <button className="panel-icon-button" disabled={!hasActiveScene} title="Go to start" onClick={goToStart}>
            <SkipBack size={14} />
          </button>
          <button
            className="panel-icon-button"
            disabled={!hasActiveScene}
            title={timelinePlaying ? "Pause" : "Play"}
            onClick={toggleTimelinePlayback}
          >
            {timelinePlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </div>
      </div>

      {hasActiveScene && mode === "keys" ? (
        <div className="timeline-ribbon">
          <div className="timeline-row-filter" role="group" aria-label="Timeline object filter">
            <button
              aria-pressed={timelineRowFilter === "all"}
              className={timelineRowFilter === "all" ? "active" : ""}
              onClick={() => setTimelineRowFilter("all")}
              title="List every object in the scene"
              type="button"
            >
              <Layers size={12} /><span>All objects</span>
            </button>
            <button
              aria-pressed={timelineRowFilter === "keyframed"}
              className={timelineRowFilter === "keyframed" ? "active" : ""}
              onClick={() => setTimelineRowFilter("keyframed")}
              title="List only objects that carry animation"
              type="button"
            >
              <Diamond size={12} /><span>Keyframed only</span>
            </button>
          </div>

          <span className="timeline-ribbon-count">
            {rows.length ? `${rows.length} row${rows.length === 1 ? "" : "s"}` : "No rows"}
            {timelineRowFilter === "keyframed" ? " · animated" : ""}
          </span>

          <div className="timeline-ribbon-selection">
            {selectedKeyIds.size ? (
              <>
                <strong>{selectedKeyIds.size} selected</strong>
                <button
                  className="panel-icon-button danger"
                  onClick={deleteSelectedKeys}
                  title="Delete selected keyframes (Del)"
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
                <button
                  className="timeline-ribbon-clear"
                  onClick={() => setSelectedKeyIds(new Set())}
                  type="button"
                >
                  Clear
                </button>
              </>
            ) : (
              <span className="timeline-ribbon-hint">Drag a box over the tracks to select keyframes</span>
            )}
          </div>
        </div>
      ) : null}

      {notice ? <p className="timeline-notice">{notice}</p> : null}

      {!hasActiveScene ? (
        <div className="empty-panel timeline-empty-state">Open a scene to view its objects and keyframes.</div>
      ) : mode === "speed" ? (
        <SpeedGraphEditor
          channel={selectedChannel}
          durationFrames={durationFrames}
          fps={scene.timeline.fps}
          object={selectedObject}
          property={selectedPropertyKey?.property}
          selectedKey={selectedKey}
          onDeleteKey={(keyframeId) => {
            if (!selectedPropertyKey) return;
            deletePropertyKeyframe(
              selectedPropertyKey.objectId,
              selectedPropertyKey.property,
              keyframeId
            );
            setSelectedPropertyKey({ ...selectedPropertyKey, keyframeId: undefined });
          }}
          onSelectKey={(keyframeId) => {
            if (!selectedPropertyKey) return;
            setSelectedPropertyKey({ ...selectedPropertyKey, keyframeId });
            const key = selectedChannel?.keys.find((item) => item.id === keyframeId);
            if (key) setCurrentFrame(key.frame, durationFrames);
          }}
          onUpdateKey={(keyframeId, patch) => {
            if (!selectedPropertyKey) return;
            updatePropertyKeyframe(
              selectedPropertyKey.objectId,
              selectedPropertyKey.property,
              keyframeId,
              patch
            );
          }}
        />
      ) : (
        <div
          className="timeline-grid advanced-key-grid"
          onScroll={(event) => {
            const element = event.currentTarget;
            setViewport({ scrollTop: element.scrollTop, height: element.clientHeight });
          }}
          ref={attachScroller}
        >
          <div className="timeline-object-list">
            <div className="timeline-list-heading">Object / Property</div>
            {/* Standing in for the rows above the window, so the scrollbar still measures the
                whole list rather than only the part that is mounted. */}
            {spacers.before > 0 ? <div aria-hidden="true" style={{ height: `${spacers.before}px` }} /> : null}
            {windowedRows.map(({ row }) => (
              <button
                className={`timeline-track-label ${
                  !row.property && !row.maskId && row.object.id === selectedObjectId ? "selected" : ""
                } ${
                  row.property && selectedPropertyKey?.objectId === row.object.id && selectedPropertyKey.property === row.property
                    ? "channel-selected"
                    : ""
                } ${row.maskId === selectedMaskId ? "mask-selected" : ""}`}
                key={row.id}
                onClick={() => {
                  // Navigating the Timeline must not destroy a multi-selection made elsewhere.
                  // Clicking a row that is already a member only moves the active object; clicking
                  // a non-member replaces the selection, as it always did.
                  if (selectedObjectIds.includes(row.object.id)) {
                    selectObjects(selectedObjectIds, { active: row.object.id });
                  } else {
                    selectObject(row.object.id);
                  }
                  if (row.property) setSelectedPropertyKey({ objectId: row.object.id, property: row.property });
                  if (row.maskId) setSelectedMaskId(row.maskId);
                }}
                style={{ paddingLeft: `${10 + row.depth * 16}px` }}
              >
                {row.property ? (
                  <>
                    <BarChart3 size={11} />
                    <span>{propertyLabel(row.property)}</span>
                  </>
                ) : row.isShapePath ? (
                  <>
                    <Diamond size={10} />
                    <span>Path</span>
                  </>
                ) : row.maskProperty ? (
                  <>
                    <Diamond size={10} />
                    <span>{maskPropertyLabel(row.maskProperty)}</span>
                  </>
                ) : row.maskId ? (
                  <>
                    <span className="timeline-object-dot type-mask" />
                    <strong>{row.maskName}</strong>
                  </>
                ) : (
                  <>
                    <span className={`timeline-object-dot type-${row.object.type}`} />
                    <strong>{row.object.name}</strong>
                  </>
                )}
              </button>
            ))}
            {spacers.after > 0 ? <div aria-hidden="true" style={{ height: `${spacers.after}px` }} /> : null}
          </div>
          <div
            className={`timeline-ruler ${marquee ? "marquee-active" : ""}`}
            onLostPointerCapture={endMarquee}
            onPointerCancel={endMarquee}
            onPointerDown={beginMarquee}
            onPointerMove={dragMarquee}
            onPointerUp={endMarquee}
            ref={rulerRef}
            style={{ minHeight: `${RULER_HEIGHT + rows.length * ROW_HEIGHT}px` }}
          >
            <div
              aria-label="Playhead"
              aria-valuemax={durationFrames}
              aria-valuemin={0}
              aria-valuenow={currentFrame}
              className="timeline-tick-row"
              onKeyDown={scrubFromKeyboard}
              onLostPointerCapture={endScrub}
              onPointerCancel={endScrub}
              onPointerDown={beginScrub}
              onPointerMove={dragScrub}
              onPointerUp={endScrub}
              onWheel={(event) => {
                // Wheel steps the playhead: a trackpad gives finer forward/back control than
                // dragging when the whole scene is a few hundred pixels wide.
                setCurrentFrame(currentFrame + Math.sign(event.deltaY) * (event.shiftKey ? 10 : 1), durationFrames);
              }}
              role="slider"
              tabIndex={0}
            >
              {Array.from({ length: 11 }, (_, index) => {
                const frame = Math.round((index / 10) * durationFrames);
                return (
                  <span
                    className={index === 0 ? "start" : index === 10 ? "end" : undefined}
                    key={index}
                    style={{ left: `${index * 10}%` }}
                  >
                    {frame}f
                  </span>
                );
              })}
            </div>
            {windowedRows.map(({ row, index }) => (
              <div
                className={`timeline-track-line ${row.property || row.maskProperty ? "property" : "object"}`}
                key={row.id}
                style={{ top: `${RULER_HEIGHT + index * ROW_HEIGHT}px` }}
              />
            ))}
            {/*
              One pass over every kind of key. The four separate passes this replaces each had
              their own drag handler, and three of them moved a key to the pointer's absolute
              frame — so grabbing a diamond anywhere but its centre teleported it.
            */}
            {windowedKeys.map((key) => {
              const rowIndex = rowIndexById.get(key.rowId);
              if (rowIndex === undefined) return null;
              return (
                <button
                  className={`keyframe-marker ${markerClass(key)} ${selectedKeyIds.has(key.id) ? "selected" : ""}`}
                  key={key.id}
                  onDoubleClick={() => {
                    if (key.kind === "property") setMode("speed");
                  }}
                  onPointerCancel={endKeyDrag}
                  onPointerDown={(event) => beginKeyDrag(event, key)}
                  onPointerMove={dragKeys}
                  onPointerUp={endKeyDrag}
                  style={{
                    left: frameToMarkerPosition(key.frame, durationFrames),
                    top: `${RULER_HEIGHT + rowIndex * ROW_HEIGHT + 9}px`
                  }}
                  title={`${markerLabel(key)} · ${key.frame}f · drag to move, shift-click to add`}
                  type="button"
                />
              );
            })}
            {marquee ? (
              <div
                className="timeline-marquee"
                style={{
                  left: `${frameToPercent(Math.min(marquee.frameFrom, marquee.frameTo), durationFrames)}%`,
                  width: `${
                    frameToPercent(Math.max(marquee.frameFrom, marquee.frameTo), durationFrames)
                    - frameToPercent(Math.min(marquee.frameFrom, marquee.frameTo), durationFrames)
                  }%`,
                  top: `${RULER_HEIGHT + Math.min(marquee.rowFrom, marquee.rowTo) * ROW_HEIGHT}px`,
                  height: `${(Math.abs(marquee.rowTo - marquee.rowFrom) + 1) * ROW_HEIGHT}px`
                }}
              />
            ) : null}
            <div
              className={`playhead ${
                currentFrame <= 0 ? "at-start" : currentFrame >= durationFrames ? "at-end" : ""
              }`}
              style={{ left: `${frameToPercent(currentFrame, durationFrames)}%` }}
            >
              {/* The head is the grab target; the line below it stays transparent to pointers. */}
              <span
                onLostPointerCapture={endScrub}
                onPointerCancel={endScrub}
                onPointerDown={beginScrub}
                onPointerMove={dragScrub}
                onPointerUp={endScrub}
                title="Drag to scrub"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SpeedGraphEditor(props: {
  channel?: PropertyChannel;
  durationFrames: number;
  fps: number;
  object?: SceneObject;
  property?: AnimatableProperty;
  selectedKey?: PropertyKeyframe;
  onSelectKey: (keyframeId: string) => void;
  onUpdateKey: (keyframeId: string, patch: Partial<PropertyKeyframe>) => void;
  onDeleteKey: (keyframeId: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const width = 1000;
  const height = 250;
  const graphTop = 24;
  const graphBottom = 218;
  const channel = props.channel;
  const samples = useMemo(
    () => channel ? sampleSpeedGraph(channel, props.durationFrames, props.fps, 180) : [],
    [channel, props.durationFrames, props.fps]
  );
  const speedRange = useMemo(() => {
    const speeds = samples.map((sample) => sample.speed);
    const min = Math.min(0, ...speeds);
    const max = Math.max(0, ...speeds);
    const span = Math.max(1, max - min);
    return { min: min - span * 0.12, max: max + span * 0.12 };
  }, [samples]);
  const xForFrame = (frame: number) => (frame / Math.max(1, props.durationFrames)) * width;
  const yForSpeed = (speed: number) =>
    graphBottom - ((speed - speedRange.min) / (speedRange.max - speedRange.min)) * (graphBottom - graphTop);
  const speedForY = (y: number) =>
    speedRange.min + ((graphBottom - y) / (graphBottom - graphTop)) * (speedRange.max - speedRange.min);
  const frameForX = (x: number) => (x / width) * props.durationFrames;
  const polyline = samples.map((sample) => `${xForFrame(sample.frame)},${yForSpeed(sample.speed)}`).join(" ");

  function graphPoint(event: ReactPointerEvent<SVGCircleElement>): { x: number; y: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transform = svg.getScreenCTM()?.inverse();
    return transform ? point.matrixTransform(transform) : null;
  }

  function dragTangent(
    event: ReactPointerEvent<SVGCircleElement>,
    key: PropertyKeyframe,
    adjacent: PropertyKeyframe,
    kind: "in" | "out"
  ) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = graphPoint(event);
    if (!point) return;
    const span = Math.max(1, Math.abs(adjacent.frame - key.frame));
    const delta = kind === "out"
      ? adjacent.value - key.value
      : key.value - adjacent.value;
    const pointerFrame = frameForX(Math.max(0, Math.min(width, point.x)));
    const influence = kind === "out"
      ? Math.max(1, Math.min(span * 0.9, pointerFrame - key.frame))
      : Math.max(1, Math.min(span * 0.9, key.frame - pointerFrame));
    const speed = speedForY(Math.max(graphTop, Math.min(graphBottom, point.y)));
    const tangentY = Math.abs(delta) < 1e-6
      ? 0
      : speed * influence / (props.fps * delta);
    props.onUpdateKey(key.id, kind === "out"
      ? { outTangent: { x: influence, y: tangentY } }
      : { inTangent: { x: -influence, y: -tangentY } });
  }

  if (!props.object || !props.property || !channel) {
    return (
      <div className="speed-graph-empty">
        <Activity size={24} />
        <strong>Select an animated property</strong>
        <span>Enable a property clock in Scene Inspector, then select its timeline row.</span>
      </div>
    );
  }

  const keys = channel.keys;

  return (
    <div className="speed-graph-editor">
      <div className="speed-graph-toolbar">
        <div>
          <strong>{props.object.name}</strong>
          <span>{propertyLabel(props.property)} · units/second</span>
        </div>
        {props.selectedKey ? (
          <div className="speed-key-controls">
            <label>
              Frame
              <input
                min={0}
                max={props.durationFrames}
                type="number"
                value={props.selectedKey.frame}
                onChange={(event) => props.onUpdateKey(props.selectedKey!.id, { frame: Number(event.target.value) })}
              />
            </label>
            <label>
              Value
              <input
                step={0.01}
                type="number"
                value={props.selectedKey.value}
                onChange={(event) => props.onUpdateKey(props.selectedKey!.id, { value: Number(event.target.value) })}
              />
            </label>
            <label>
              Ease
              <select
                value={props.selectedKey.easing}
                onChange={(event) => props.onUpdateKey(props.selectedKey!.id, {
                  easing: event.target.value as SceneKeyframeEasing,
                  inTangent: undefined,
                  outTangent: undefined
                })}
              >
                <option value="linear">Linear</option>
                <option value="ease-in">Ease In</option>
                <option value="ease-out">Ease Out</option>
                <option value="ease-in-out">Ease In/Out</option>
              </select>
            </label>
            <button className="panel-icon-button danger" title="Delete selected key" onClick={() => props.onDeleteKey(props.selectedKey!.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ) : (
          <span className="speed-graph-hint">Select a diamond to edit its speed and influence.</span>
        )}
      </div>
      {keys.length < 2 ? (
        <div className="speed-graph-empty compact">
          <strong>Add a second keyframe</strong>
          <span>Move the playhead and change the clock-enabled property value.</span>
        </div>
      ) : (
        <svg
          aria-label={`${propertyLabel(props.property)} speed graph`}
          className="speed-graph-svg"
          preserveAspectRatio="xMidYMid meet"
          ref={svgRef}
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <defs>
            <linearGradient id="speed-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#17b9a8" stopOpacity="0.35" />
              <stop offset="1" stopColor="#17b9a8" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {Array.from({ length: 6 }, (_, index) => {
            const y = graphTop + (index / 5) * (graphBottom - graphTop);
            const speed = speedForY(y);
            return (
              <g key={index}>
                <line className="speed-grid-line" x1={0} x2={width} y1={y} y2={y} />
                <text className="speed-grid-label" x={6} y={y - 4}>{Math.round(speed)}</text>
              </g>
            );
          })}
          <line
            className="speed-zero-line"
            x1={0}
            x2={width}
            y1={yForSpeed(0)}
            y2={yForSpeed(0)}
          />
          <polygon
            fill="url(#speed-fill)"
            points={`0,${yForSpeed(0)} ${polyline} ${width},${yForSpeed(0)}`}
          />
          <polyline className="speed-curve" fill="none" points={polyline} />
          {keys.map((key, index) => {
            const incoming = index > 0 ? keys[index - 1] : undefined;
            const outgoing = index < keys.length - 1 ? keys[index + 1] : undefined;
            const keyX = xForFrame(key.frame);
            const keySpeed = speedAtFrame(channel, key.frame, props.fps);
            const keyY = yForSpeed(keySpeed);
            const inHandle = incoming
              ? tangentHandle(channel, incoming, key, "in", props.fps)
              : undefined;
            const outHandle = outgoing
              ? tangentHandle(channel, key, outgoing, "out", props.fps)
              : undefined;

            return (
              <g key={key.id}>
                <line className="speed-key-line" x1={keyX} x2={keyX} y1={graphTop} y2={graphBottom} />
                {inHandle && incoming ? (
                  <>
                    <line
                      className="speed-handle-line"
                      x1={keyX}
                      x2={xForFrame(key.frame - inHandle.influence)}
                      y1={keyY}
                      y2={yForSpeed(inHandle.speed)}
                    />
                    <circle
                      className="speed-handle"
                      cx={xForFrame(key.frame - inHandle.influence)}
                      cy={yForSpeed(inHandle.speed)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        props.onSelectKey(key.id);
                      }}
                      onPointerMove={(event) => dragTangent(event, key, incoming, "in")}
                      r={5}
                    />
                  </>
                ) : null}
                {outHandle && outgoing ? (
                  <>
                    <line
                      className="speed-handle-line"
                      x1={keyX}
                      x2={xForFrame(key.frame + outHandle.influence)}
                      y1={keyY}
                      y2={yForSpeed(outHandle.speed)}
                    />
                    <circle
                      className="speed-handle"
                      cx={xForFrame(key.frame + outHandle.influence)}
                      cy={yForSpeed(outHandle.speed)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        props.onSelectKey(key.id);
                      }}
                      onPointerMove={(event) => dragTangent(event, key, outgoing, "out")}
                      r={5}
                    />
                  </>
                ) : null}
                <rect
                  className={`speed-key ${props.selectedKey?.id === key.id ? "selected" : ""}`}
                  height={10}
                  onClick={() => props.onSelectKey(key.id)}
                  transform={`rotate(45 ${keyX} ${keyY})`}
                  width={10}
                  x={keyX - 5}
                  y={keyY - 5}
                />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function markerClass(key: TimelineKeyRef): string {
  switch (key.kind) {
    case "property": return "property-key";
    case "legacy": return "legacy";
    case "mask": return "mask-key";
    case "shape-path": return "mask-key shape-path-key";
  }
}

function markerLabel(key: TimelineKeyRef): string {
  switch (key.kind) {
    case "property": return propertyLabel(key.property);
    case "legacy": return "Legacy all-property key";
    case "mask": return maskPropertyLabel(key.maskProperty);
    case "shape-path": return "Shape Path";
  }
}

function maskPropertyLabel(property: MaskTimelineProperty): string {
  if (property === "path") return "Mask Path";
  if (property === "opacity") return "Mask Opacity";
  if (property === "feather") return "Mask Feather";
  return "Mask Expansion";
}

function sampleSpeedGraph(
  channel: PropertyChannel,
  durationFrames: number,
  fps: number,
  count: number
): Array<{ frame: number; speed: number }> {
  return Array.from({ length: count }, (_, index) => {
    const frame = (index / Math.max(1, count - 1)) * durationFrames;
    return { frame, speed: speedAtFrame(channel, frame, fps) };
  });
}

function speedAtFrame(channel: PropertyChannel, frame: number, fps: number): number {
  const epsilon = 0.05;
  const before = sampleChannel(channel, frame - epsilon);
  const after = sampleChannel(channel, frame + epsilon);
  if (before === undefined || after === undefined) return 0;
  return ((after - before) / (epsilon * 2)) * fps;
}

function tangentHandle(
  channel: PropertyChannel,
  lo: PropertyKeyframe,
  hi: PropertyKeyframe,
  kind: "in" | "out",
  fps: number
): { influence: number; speed: number } {
  const span = Math.max(1, hi.frame - lo.frame);
  if (kind === "out" && lo.outTangent) {
    const influence = Math.max(1, Math.min(span * 0.9, lo.outTangent.x));
    const speed = Math.abs(hi.value - lo.value) < 1e-6
      ? 0
      : fps * (hi.value - lo.value) * lo.outTangent.y / influence;
    return { influence, speed };
  }
  if (kind === "in" && hi.inTangent) {
    const influence = Math.max(1, Math.min(span * 0.9, Math.abs(hi.inTangent.x)));
    const speed = Math.abs(hi.value - lo.value) < 1e-6
      ? 0
      : fps * (hi.value - lo.value) * -hi.inTangent.y / influence;
    return { influence, speed };
  }
  const frame = kind === "out" ? lo.frame + 0.05 : hi.frame - 0.05;
  return { influence: span / 3, speed: speedAtFrame(channel, frame, fps) };
}

function propertyLabel(property: AnimatableProperty): string {
  switch (property) {
    case "opacity": return "Alpha";
    case "x": return "X Position";
    case "y": return "Y Position";
    case "zDepth": return "Z Position";
    case "rotationX": return "X Rotation";
    case "rotationY": return "Y Rotation";
    case "rotation":
    case "rotationZ": return "Z Rotation";
    case "scaleX": return "X Scale";
    case "scaleY": return "Y Scale";
    case "scaleZ": return "Z Scale";
  }
}
