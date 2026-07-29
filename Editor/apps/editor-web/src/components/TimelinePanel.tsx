import {
  ANIMATABLE_PROPERTIES,
  sampleChannel,
  type AnimatableProperty,
  type PropertyChannel,
  type PropertyKeyframe,
  type SceneKeyframeEasing,
  type SceneObject
} from "@grapix/shared-types";
import {
  Activity,
  BarChart3,
  Diamond,
  Pause,
  Play,
  SkipBack,
  Trash2
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import {
  frameFromClientX,
  frameToMarkerPosition,
  frameToPercent
} from "./timelineMath";

interface TimelineRow {
  id: string;
  object: SceneObject;
  property?: AnimatableProperty;
  maskId?: string;
  maskName?: string;
  maskProperty?: MaskTimelineProperty;
  depth: number;
}

type MaskTimelineProperty = "path" | "opacity" | "feather" | "expansion";

interface SelectedPropertyKey {
  objectId: string;
  property: AnimatableProperty;
  keyframeId?: string;
}

const ROW_HEIGHT = 28;
const RULER_HEIGHT = 28;

export function TimelinePanel() {
  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const updateObjectKeyframe = useEditorStore((state) => state.updateObjectKeyframe);
  const updatePropertyKeyframe = useEditorStore((state) => state.updatePropertyKeyframe);
  const deletePropertyKeyframe = useEditorStore((state) => state.deletePropertyKeyframe);
  const updateMaskKeyframeFrame = useEditorStore((state) => state.updateMaskKeyframeFrame);
  const timelinePlaying = useUiStore((state) => state.timelinePlaying);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const toggleTimelinePlayback = useUiStore((state) => state.toggleTimelinePlayback);
  const goToStart = useUiStore((state) => state.goToStart);
  const stepTimeline = useUiStore((state) => state.stepTimeline);
  const setCurrentFrame = useUiStore((state) => state.setCurrentFrame);
  const selectedMaskId = useUiStore((state) => state.selectedMaskId);
  const setSelectedMaskId = useUiStore((state) => state.setSelectedMaskId);
  const [mode, setMode] = useState<"keys" | "speed">("keys");
  const [selectedPropertyKey, setSelectedPropertyKey] = useState<SelectedPropertyKey | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const durationFrames = scene.timeline.durationFrames;
  const rows = useMemo(() => createTimelineRows(scene.objects), [scene.objects]);
  const rowIndexById = useMemo(
    () => new Map(rows.map((row, index) => [row.id, index])),
    [rows]
  );

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

  function frameForClientX(clientX: number): number {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return currentFrame;
    return frameFromClientX(clientX, rect.left, rect.width, durationFrames);
  }

  function beginPropertyKeyDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    objectId: string,
    property: AnimatableProperty,
    key: PropertyKeyframe
  ) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectObject(objectId);
    setSelectedPropertyKey({ objectId, property, keyframeId: key.id });
    setCurrentFrame(key.frame, durationFrames);
  }

  function dragPropertyKey(
    event: ReactPointerEvent<HTMLButtonElement>,
    objectId: string,
    property: AnimatableProperty,
    keyframeId: string
  ) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const frame = frameForClientX(event.clientX);
    updatePropertyKeyframe(objectId, property, keyframeId, { frame });
    setCurrentFrame(frame, durationFrames);
  }

  function beginLegacyKeyDrag(event: ReactPointerEvent<HTMLButtonElement>, objectId: string, frame: number) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectObject(objectId);
    setCurrentFrame(frame, durationFrames);
  }

  return (
    <section className="timeline-panel advanced-timeline">
      <div className="dock-panel-title timeline-titlebar">
        <span>Timeline <em>{currentFrame}f</em></span>
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
        <div className="timeline-grid advanced-key-grid">
          <div className="timeline-object-list">
            <div className="timeline-list-heading">Object / Property</div>
            {rows.map((row) => (
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
                  selectObject(row.object.id);
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
          </div>
          <div
            className="timeline-ruler"
            onClick={(event) => setCurrentFrame(frameFromPointer(event, durationFrames))}
            ref={rulerRef}
            style={{ minHeight: `${RULER_HEIGHT + rows.length * ROW_HEIGHT}px` }}
          >
            <div className="timeline-tick-row">
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
            {rows.map((row, index) => (
              <div
                className={`timeline-track-line ${row.property || row.maskProperty ? "property" : "object"}`}
                key={row.id}
                style={{ top: `${RULER_HEIGHT + index * ROW_HEIGHT}px` }}
              />
            ))}
            {scene.timeline.keyframes.map((keyframe) => {
              const rowIndex = rowIndexById.get(`object:${keyframe.objectId}`);
              if (rowIndex === undefined) return null;
              return (
                <button
                  className="keyframe-marker legacy"
                  key={keyframe.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCurrentFrame(keyframe.frame, durationFrames);
                    selectObject(keyframe.objectId);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const delta = (event.shiftKey ? 10 : 1) * (event.key === "ArrowRight" ? 1 : -1);
                    const frame = Math.max(0, Math.min(durationFrames, keyframe.frame + delta));
                    updateObjectKeyframe(keyframe.id, { frame });
                    setCurrentFrame(frame, durationFrames);
                  }}
                  onPointerDown={(event) => beginLegacyKeyDrag(event, keyframe.objectId, keyframe.frame)}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                    const frame = frameForClientX(event.clientX);
                    updateObjectKeyframe(keyframe.id, { frame });
                    setCurrentFrame(frame, durationFrames);
                  }}
                  style={{
                    left: frameToMarkerPosition(keyframe.frame, durationFrames),
                    top: `${RULER_HEIGHT + rowIndex * ROW_HEIGHT + 9}px`
                  }}
                  title={`Legacy all-property key · ${keyframe.frame}f · drag to move`}
                />
              );
            })}
            {scene.objects.flatMap((object) =>
              ANIMATABLE_PROPERTIES.flatMap((property) => {
                const channel = object.animation?.[property];
                const rowIndex = rowIndexById.get(`property:${object.id}:${property}`);
                if (!channel || rowIndex === undefined) return [];
                return channel.keys.map((key) => (
                  <button
                    className={`keyframe-marker property-key ${
                      selectedPropertyKey?.objectId === object.id &&
                      selectedPropertyKey.property === property &&
                      selectedPropertyKey.keyframeId === key.id
                        ? "selected"
                        : ""
                    }`}
                    key={`${object.id}:${property}:${key.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      selectObject(object.id);
                      setSelectedPropertyKey({ objectId: object.id, property, keyframeId: key.id });
                      setCurrentFrame(key.frame, durationFrames);
                    }}
                    onDoubleClick={() => setMode("speed")}
                    onKeyDown={(event) => {
                      if (event.key === "Delete" || event.key === "Backspace") {
                        event.preventDefault();
                        deletePropertyKeyframe(object.id, property, key.id);
                        return;
                      }
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      const delta = (event.shiftKey ? 10 : 1) * (event.key === "ArrowRight" ? 1 : -1);
                      const frame = Math.max(0, Math.min(durationFrames, key.frame + delta));
                      updatePropertyKeyframe(object.id, property, key.id, { frame });
                      setCurrentFrame(frame, durationFrames);
                    }}
                    onPointerDown={(event) => beginPropertyKeyDrag(event, object.id, property, key)}
                    onPointerMove={(event) => dragPropertyKey(event, object.id, property, key.id)}
                    style={{
                      left: frameToMarkerPosition(key.frame, durationFrames),
                      top: `${RULER_HEIGHT + rowIndex * ROW_HEIGHT + 9}px`
                    }}
                    title={`${propertyLabel(property)} · ${key.frame}f · ${key.value} · drag to move`}
                  />
                ));
              })
            )}
            {scene.objects.flatMap((object) =>
              (object.masks ?? []).flatMap((mask) =>
                (["path", "opacity", "feather", "expansion"] as MaskTimelineProperty[]).flatMap((property) => {
                  const rowIndex = rowIndexById.get(`mask-property:${object.id}:${mask.id}:${property}`);
                  const keys = mask.animation?.[property] ?? [];
                  if (rowIndex === undefined) return [];
                  return keys.map((key) => (
                    <button
                      className="keyframe-marker mask-key"
                      key={`${object.id}:${mask.id}:${property}:${key.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectObject(object.id);
                        setSelectedMaskId(mask.id);
                        setCurrentFrame(key.frame, durationFrames);
                      }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={(event) => {
                        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                        const frame = frameForClientX(event.clientX);
                        updateMaskKeyframeFrame(object.id, mask.id, property, key.id, frame);
                        setCurrentFrame(frame, durationFrames);
                      }}
                      style={{
                        left: frameToMarkerPosition(key.frame, durationFrames),
                        top: `${RULER_HEIGHT + rowIndex * ROW_HEIGHT + 9}px`
                      }}
                      title={`${mask.name} ${maskPropertyLabel(property)} · ${key.frame}f · drag to move`}
                    />
                  ));
                })
              )
            )}
            <div
              className={`playhead ${
                currentFrame <= 0 ? "at-start" : currentFrame >= durationFrames ? "at-end" : ""
              }`}
              style={{ left: `${frameToPercent(currentFrame, durationFrames)}%` }}
            >
              <span />
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

function createTimelineRows(objects: SceneObject[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const object of objects) {
    rows.push({ id: `object:${object.id}`, object, depth: 0 });
    for (const property of ANIMATABLE_PROPERTIES) {
      if (object.animation?.[property]) {
        rows.push({
          id: `property:${object.id}:${property}`,
          object,
          property,
          depth: 1
        });
      }
    }
    for (const mask of object.masks ?? []) {
      rows.push({
        id: `mask:${object.id}:${mask.id}`,
        object,
        maskId: mask.id,
        maskName: mask.name,
        depth: 1
      });
      for (const maskProperty of ["path", "opacity", "feather", "expansion"] as MaskTimelineProperty[]) {
        if (mask.animation?.[maskProperty]?.length) {
          rows.push({
            id: `mask-property:${object.id}:${mask.id}:${maskProperty}`,
            object,
            maskId: mask.id,
            maskName: mask.name,
            maskProperty,
            depth: 2
          });
        }
      }
    }
  }
  return rows;
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

function frameFromPointer(event: MouseEvent<HTMLDivElement>, durationFrames: number): number {
  const rect = event.currentTarget.getBoundingClientRect();
  return frameFromClientX(event.clientX, rect.left, rect.width, durationFrames);
}
