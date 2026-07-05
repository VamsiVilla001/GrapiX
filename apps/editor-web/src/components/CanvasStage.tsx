import type { SceneObject } from "@grapix/shared-types";
import { useMemo, useState, type PointerEvent } from "react";
import { GpuSceneStage } from "./GpuSceneStage";
import type { GpuRendererCapabilities } from "../rendering/GpuSceneRenderer";
import { resolveRenderableObjects } from "../rendering/sceneMaterial";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

interface DragState {
  objectId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

export function CanvasStage() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const updateObject = useEditorStore((state) => state.updateObject);
  const zoom = useUiStore((state) => state.zoom);
  const snapping = useUiStore((state) => state.snapping);
  const toggleSnapping = useUiStore((state) => state.toggleSnapping);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [capabilities, setCapabilities] = useState<GpuRendererCapabilities | null>(null);
  const displayObjects = useMemo(
    () => resolveRenderableObjects(scene),
    [scene]
  );

  function beginDrag(event: PointerEvent<SVGGElement>, object: SceneObject) {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectObject(object.id);

    if (object.locked) {
      setDrag(null);
      return;
    }

    setDrag({
      objectId: object.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: object.x,
      startY: object.y
    });
  }

  function moveDrag(event: PointerEvent<SVGSVGElement>) {
    if (!drag) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const dx = ((event.clientX - drag.startClientX) / rect.width) * scene.canvas.width;
    const dy = ((event.clientY - drag.startClientY) / rect.height) * scene.canvas.height;

    updateObject(drag.objectId, {
      x: snapValue(drag.startX + dx, snapping),
      y: snapValue(drag.startY + dy, snapping)
    });
  }

  return (
    <main className="stage-shell">
      <div className="stage-toolbar">
        <span>{scene.canvas.width} x {scene.canvas.height}</span>
        <span className="renderer-status" title={capabilities?.rendererName ?? "Renderer initializing"}>
          GPU {capabilities?.backend.toUpperCase() ?? "INIT"}
          {capabilities?.maxTextureSize ? ` / ${capabilities.maxTextureSize}px tex` : ""}
        </span>
        <button className={`snapping-toggle ${snapping ? "active" : ""}`} onClick={toggleSnapping}>
          Snapping
        </button>
        <span>{scene.objects.length} objects</span>
      </div>
      <div className="stage-frame">
        <div
          className="stage gpu-stage"
          style={{ transform: `scale(${zoom / 100})` }}
          role="application"
          aria-label={`${scene.name} GPU viewport`}
        >
          <GpuSceneStage scene={scene} objects={displayObjects} onCapabilities={setCapabilities} />
          <svg
            className="stage-interaction-overlay"
            viewBox={`0 0 ${scene.canvas.width} ${scene.canvas.height}`}
            role="img"
            aria-label={scene.name}
            onPointerDown={() => selectObject(null)}
            onPointerMove={moveDrag}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
          >
            <rect width={scene.canvas.width} height={scene.canvas.height} fill="transparent" />
            {displayObjects.map((object) => (
              <g
                key={object.id}
                transform={`translate(${object.x} ${object.y}) rotate(${object.rotation})`}
                visibility={object.visible ? "visible" : "hidden"}
                onPointerDown={(event) => beginDrag(event, object)}
                className={`scene-object ${object.locked ? "locked" : ""}`}
              >
                <rect width={object.width} height={object.height} fill="transparent" />
                {selectedObjectId === object.id ? (
                  <rect
                    x={-8}
                    y={-8}
                    width={object.width + 16}
                    height={object.height + 16}
                    fill="none"
                    stroke="#f5b942"
                    strokeWidth="4"
                    strokeDasharray="16 10"
                    pointerEvents="none"
                  />
                ) : null}
              </g>
            ))}
          </svg>
        </div>
      </div>
    </main>
  );
}

function snapValue(value: number, snapping: boolean): number {
  if (!snapping) {
    return Math.round(value);
  }

  return Math.round(value / 10) * 10;
}
