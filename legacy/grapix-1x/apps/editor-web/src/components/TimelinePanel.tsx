import { Pause, Play, Plus, SkipBack } from "lucide-react";
import { useEffect, type MouseEvent } from "react";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

export function TimelinePanel() {
  const scene = useEditorStore((state) => state.scene);
  const objects = scene.objects;
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const addObjectKeyframe = useEditorStore((state) => state.addObjectKeyframe);
  const timelinePlaying = useUiStore((state) => state.timelinePlaying);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const toggleTimelinePlayback = useUiStore((state) => state.toggleTimelinePlayback);
  const goToStart = useUiStore((state) => state.goToStart);
  const stepTimeline = useUiStore((state) => state.stepTimeline);
  const setCurrentFrame = useUiStore((state) => state.setCurrentFrame);
  const durationFrames = scene.timeline.durationFrames;

  useEffect(() => {
    if (!timelinePlaying) {
      return undefined;
    }

    const intervalId = window.setInterval(() => stepTimeline(durationFrames), 1000 / scene.timeline.fps);

    return () => window.clearInterval(intervalId);
  }, [durationFrames, scene.timeline.fps, stepTimeline, timelinePlaying]);

  function addKeyframe() {
    if (selectedObjectId) {
      addObjectKeyframe(selectedObjectId, currentFrame);
    }
  }

  return (
    <section className="timeline-panel">
      <div className="dock-panel-title">
        <span>Timeline <em>{currentFrame}f</em></span>
        <div className="mini-action-row">
          <button className="panel-icon-button" title="Go to start" onClick={goToStart}><SkipBack size={14} /></button>
          <button className="panel-icon-button" title={timelinePlaying ? "Pause" : "Play"} onClick={toggleTimelinePlayback}>
            {timelinePlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button className="panel-icon-button" title="Add keyframe" onClick={addKeyframe} disabled={!selectedObjectId}>
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className="timeline-grid">
        <div className="timeline-object-list">
          {objects.map((object) => (
            <button
              className={`timeline-track-label ${object.id === selectedObjectId ? "selected" : ""}`}
              key={object.id}
              onClick={() => selectObject(object.id)}
            >
              {object.name}
            </button>
          ))}
        </div>
        <div className="timeline-ruler" onClick={(event) => setCurrentFrame(frameFromPointer(event, durationFrames))}>
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index}>{index * 10}f</span>
          ))}
          {scene.timeline.keyframes.map((keyframe) => {
            const objectIndex = objects.findIndex((object) => object.id === keyframe.objectId);

            if (objectIndex === -1) {
              return null;
            }

            return (
              <button
                className="keyframe-marker"
                key={keyframe.id}
                onClick={(event) => {
                  event.stopPropagation();
                  setCurrentFrame(keyframe.frame);
                  selectObject(keyframe.objectId);
                }}
                style={{
                  left: `${frameToPercent(keyframe.frame, durationFrames)}%`,
                  top: `${34 + objectIndex * 30}px`
                }}
                title={`${keyframe.frame}f`}
              />
            );
          })}
          <div className="playhead" style={{ left: `${frameToPercent(currentFrame, durationFrames)}%` }} />
        </div>
      </div>
    </section>
  );
}

function frameToPercent(frame: number, durationFrames: number): number {
  if (durationFrames <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (frame / durationFrames) * 100));
}

function frameFromPointer(event: MouseEvent<HTMLDivElement>, durationFrames: number): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const percent = (event.clientX - rect.left) / rect.width;

  return Math.round(Math.min(1, Math.max(0, percent)) * durationFrames);
}
