import {
  createSceneId,
  evaluateSceneAtFrame,
  getBindableFaces,
  isMaterialCompatibleWithFace,
  type BezierPath,
  type BrushPoint,
  type CanvasGuide,
  type ColorValue,
  type PaintStroke,
  type SceneDocument,
  type SceneObject,
  type Vec2
} from "@grapix/shared-types";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { DesignToolToolbar, ToolOptionsBar } from "./DesignToolToolbar";
import { GpuSceneStage } from "./GpuSceneStage";
import type { PreviewRendererCapabilities } from "../rendering/ScenePreviewRenderer";
import { resolveRenderableObjects } from "../rendering/sceneMaterial";
import { projectMeshBounds } from "../rendering/ThreeSceneLayer";
import { useEditorStore } from "../store/editorStore";
import { useUiStore, type EditorTool } from "../store/uiStore";
import {
  marqueeFromDrag,
  marqueePath,
  objectIntersectsMarquee,
  sampleColorValue,
  smoothBrushPoints
} from "../tools/designToolMath";

type TransformAxis = "free" | "x" | "y" | "z" | "uniform";

interface TransformDragState {
  kind: "move" | "rotate" | "scale" | "pivot";
  axis: TransformAxis;
  objectId: string;
  startPointer: Vec2;
  startPivot: Vec2;
  startObject: SceneObject;
  startAngle: number;
}

interface GuideDragState {
  guideId: string;
  orientation: CanvasGuide["orientation"];
}

interface PointDragState {
  objectId: string;
  index: number;
  maskId?: string;
  kind: "vertex" | "in-tangent" | "out-tangent";
}

interface BrushDragState {
  objectId: string;
  strokeId: string;
  rawPoints: BrushPoint[];
  maskId?: string;
}

interface GradientDragState {
  objectId: string;
  handle: "start" | "end" | "center" | "focal" | "radius-x" | "radius-y";
}

export function CanvasStage() {
  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const updateObject = useEditorStore((state) => state.updateObject);
  const assignMaterialToFaces = useEditorStore((state) => state.assignMaterialToFaces);
  const assignAssetToFaces = useEditorStore((state) => state.assignAssetToFaces);
  const createPenShape = useEditorStore((state) => state.createPenShape);
  const appendShapeVertex = useEditorStore((state) => state.appendShapeVertex);
  const updateShapeVertex = useEditorStore((state) => state.updateShapeVertex);
  const closeShapePath = useEditorStore((state) => state.closeShapePath);
  const addMask = useEditorStore((state) => state.addMask);
  const appendMaskVertex = useEditorStore((state) => state.appendMaskVertex);
  const closeMaskPath = useEditorStore((state) => state.closeMaskPath);
  const addTextAt = useEditorStore((state) => state.addTextAt);
  const createPaintLayer = useEditorStore((state) => state.createPaintLayer);
  const addPaintStroke = useEditorStore((state) => state.addPaintStroke);
  const updatePaintStroke = useEditorStore((state) => state.updatePaintStroke);
  const addMaskFromPath = useEditorStore((state) => state.addMaskFromPath);
  const updateMask = useEditorStore((state) => state.updateMask);
  const updateMaskVertex = useEditorStore((state) => state.updateMaskVertex);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const cancelHistory = useEditorStore((state) => state.cancelHistory);
  const updateCanvasViewport = useEditorStore((state) => state.updateCanvasViewport);
  const zoom = useUiStore((state) => state.zoom);
  const snapping = useUiStore((state) => state.snapping);
  const toggleSnapping = useUiStore((state) => state.toggleSnapping);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const activeTool = useUiStore((state) => state.activeTool);
  const penTarget = useUiStore((state) => state.penTarget);
  const selectedPathObjectIds = useUiStore((state) => state.selectedPathObjectIds);
  const setSelectedPaths = useUiStore((state) => state.setSelectedPaths);
  const selectedAnchorIndices = useUiStore((state) => state.selectedAnchorIndices);
  const setSelectedAnchors = useUiStore((state) => state.setSelectedAnchors);
  const selectedMaskId = useUiStore((state) => state.selectedMaskId);
  const setSelectedMaskId = useUiStore((state) => state.setSelectedMaskId);
  const marqueeSelection = useUiStore((state) => state.marqueeSelection);
  const setMarqueeSelection = useUiStore((state) => state.setMarqueeSelection);
  const marqueeOptions = useUiStore((state) => state.marqueeOptions);
  const brushOptions = useUiStore((state) => state.brushOptions);
  const eyedropperOptions = useUiStore((state) => state.eyedropperOptions);
  const foregroundColor = useUiStore((state) => state.foregroundColor);
  const setForegroundColor = useUiStore((state) => state.setForegroundColor);
  const [drag, setDrag] = useState<TransformDragState | null>(null);
  const [capabilities, setCapabilities] = useState<PreviewRendererCapabilities | null>(null);
  const [materialDropTarget, setMaterialDropTarget] = useState<{ objectId: string; compatible: boolean } | null>(null);
  // Pen-tool state: the shape currently being drawn, and the active handle/vertex drag.
  const [penObjectId, setPenObjectId] = useState<string | null>(null);
  const [penDrag, setPenDrag] = useState<{ index: number; kind: "create-tangent" | "vertex" } | null>(null);
  const [penCursor, setPenCursor] = useState<Vec2 | null>(null);
  // The mask currently being drawn (pen target = mask), on the selected object.
  const [penMaskId, setPenMaskId] = useState<string | null>(null);
  const [guideDrag, setGuideDrag] = useState<GuideDragState | null>(null);
  const [typeDrag, setTypeDrag] = useState<{ start: Vec2; current: Vec2 } | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [marqueeStart, setMarqueeStart] = useState<Vec2 | null>(null);
  const [brushDrag, setBrushDrag] = useState<BrushDragState | null>(null);
  const [brushCursor, setBrushCursor] = useState<Vec2 | null>(null);
  const [pointDrag, setPointDrag] = useState<PointDragState | null>(null);
  const [gradientDrag, setGradientDrag] = useState<GradientDragState | null>(null);
  const [eyedropperPreview, setEyedropperPreview] = useState<{ point: Vec2; color: string } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportSettings = scene.canvas.editorViewport ?? {
    showRulers: true,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    guides: []
  };

  // The shape the pen overlay operates on: the one being drawn, else the selected shape.
  const penShape = useMemo(() => {
    if (penTarget === "mask") return null;
    const id = penObjectId ?? selectedObjectId;
    const object = scene.objects.find((item) => item.id === id);
    return object && object.type === "shape" ? object : null;
  }, [penTarget, penObjectId, selectedObjectId, scene.objects]);

  // The mask being drawn (pen target = mask): its host object + the mask.
  const penMask = useMemo(() => {
    if (penTarget !== "mask" || !penMaskId) return null;
    const host = scene.objects.find((item) => item.id === selectedObjectId);
    const mask = host?.masks?.find((item) => item.id === penMaskId);
    return host && mask ? { host, mask } : null;
  }, [penTarget, penMaskId, selectedObjectId, scene.objects]);

  // Finish the in-progress path on Escape, tool change, or pen-target change.
  useEffect(() => {
    if (drag || penDrag || brushDrag || pointDrag || gradientDrag || typeDrag || marqueeStart) commitHistory();
    setPenObjectId(null);
    setPenDrag(null);
    setPenMaskId(null);
    setPenCursor(null);
    setDrag(null);
    setBrushDrag(null);
    setBrushCursor(null);
    setPointDrag(null);
    setGradientDrag(null);
    setTypeDrag(null);
    setMarqueeStart(null);
    setMarqueeSelection(null);
    setEyedropperPreview(null);
  }, [activeTool, penTarget]);
  useEffect(() => {
    if (activeTool !== "pen") return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPenObjectId(null);
        setPenDrag(null);
        setPenMaskId(null);
        setPenCursor(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool]);
  // Sample the scene at the timeline playhead so keyframed properties animate,
  // then resolve materials/bindings on the evaluated scene.
  const evaluatedScene = useMemo(
    () => evaluateSceneAtFrame(scene, currentFrame),
    [scene, currentFrame]
  );
  const displayObjects = useMemo(
    () => resolveRenderableObjects(evaluatedScene),
    [evaluatedScene]
  );
  const selectedDisplayObject = useMemo(
    () => displayObjects.find((object) => object.id === selectedObjectId) ?? null,
    [displayObjects, selectedObjectId]
  );
  const directPathTarget = useMemo(() => {
    const host = scene.objects.find((object) => object.id === selectedObjectId);
    if (!host) return null;
    const mask = selectedMaskId ? host.masks?.find((item) => item.id === selectedMaskId) : undefined;
    if (mask && mask.type !== "paint") return { host, path: mask.path, maskId: mask.id };
    return host.type === "shape" ? { host, path: host.path } : null;
  }, [scene.objects, selectedMaskId, selectedObjectId]);
  const editingText = useMemo((): Extract<SceneObject, { type: "text" }> | null => {
    const object = scene.objects.find((item) => item.id === editingTextId);
    return object?.type === "text" ? object : null;
  }, [editingTextId, scene.objects]);
  const selectedGradient = useMemo(() => {
    const object = scene.objects.find((item) => item.id === selectedObjectId);
    const value = object?.fillStyle;
    return object && value && (value.type === "linear-gradient" || value.type === "radial-gradient")
      ? { object, value }
      : null;
  }, [scene.objects, selectedObjectId]);

  useEffect(() => {
    if (!guideDrag) return undefined;

    function pointerPosition(event: globalThis.PointerEvent) {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const horizontal = guideDrag!.orientation === "horizontal";
      const offset = horizontal ? event.clientY - rect.top : event.clientX - rect.left;
      const span = horizontal ? rect.height : rect.width;
      const sceneSpan = horizontal ? scene.canvas.height : scene.canvas.width;
      return {
        inside: offset >= 0 && offset <= span,
        value: Math.min(sceneSpan, Math.max(0, Math.round(offset / Math.max(1, span) * sceneSpan)))
      };
    }

    function updateGuide(position: number) {
      const settings = useEditorStore.getState().scene.canvas.editorViewport;
      const guides = (settings?.guides ?? []).map((guide) =>
        guide.guideId === guideDrag!.guideId ? { ...guide, position } : guide
      );
      updateCanvasViewport({ guides });
    }

    function onPointerMove(event: globalThis.PointerEvent) {
      const position = pointerPosition(event);
      if (position) updateGuide(position.value);
    }

    function onPointerUp(event: globalThis.PointerEvent) {
      const position = pointerPosition(event);
      const settings = useEditorStore.getState().scene.canvas.editorViewport;
      const currentGuides = settings?.guides ?? [];
      updateCanvasViewport({
        guides: !position?.inside
          ? currentGuides.filter((guide) => guide.guideId !== guideDrag!.guideId)
          : currentGuides.map((guide) =>
              guide.guideId === guideDrag!.guideId ? { ...guide, position: position.value } : guide
            )
      });
      commitHistory();
      setGuideDrag(null);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [
    commitHistory,
    guideDrag,
    scene.canvas.height,
    scene.canvas.width,
    updateCanvasViewport
  ]);

  if (!hasActiveScene) {
    return (
      <main className="stage-shell stage-shell-empty">
        <div className="stage-toolbar">
          <span>No scene open</span>
          <span className="renderer-status">GPU STANDBY</span>
        </div>
        <div className="stage-frame stage-empty-state">
          <div>
            <strong>Viewport is empty</strong>
            <span>Create or open a scene template to render its contents.</span>
          </div>
        </div>
      </main>
    );
  }

  function beginObjectInteraction(event: PointerEvent<SVGGElement>, object: SceneObject) {
    // In pen mode, let the click bubble to the stage so it adds a path vertex
    // instead of moving the object under the cursor.
    if (activeTool === "pen") {
      return;
    }
    if ((activeTool === "horizontal-type" || activeTool === "vertical-type") && object.type === "text") {
      event.stopPropagation();
      selectObject(object.id);
      setEditingTextId(object.id);
      return;
    }
    if (isCanvasCreationTool(activeTool)) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectObject(object.id);

    if (activeTool === "path-selection" || activeTool === "direct-selection") {
      const nextPaths = event.shiftKey
        ? selectedPathObjectIds.includes(object.id)
          ? selectedPathObjectIds.filter((id) => id !== object.id)
          : [...selectedPathObjectIds, object.id]
        : [object.id];
      setSelectedPaths(nextPaths);
      if (activeTool === "path-selection" && !object.locked) {
        beginTransformDrag(event, object, "move", "free");
      }
      return;
    }

    if (object.locked) {
      setDrag(null);
      return;
    }

    if (activeTool === "move" || activeTool === "rotate") {
      beginTransformDrag(event, object, activeTool, "free");
    }
  }

  function beginTransformDrag(
    event: PointerEvent<SVGElement>,
    displayObject: SceneObject,
    kind: TransformDragState["kind"],
    axis: TransformAxis
  ) {
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events may not have an active pointer to capture.
    }
    const point = clientToScene(event.clientX, event.clientY);
    const source = scene.objects.find((object) => object.id === displayObject.id) ?? displayObject;
    if (!point || source.locked) return;
    selectObject(source.id);
    beginHistory(`${kind} object`);
    const startPivot = displayObject.type === "mesh"
      ? projectMeshBounds(evaluatedScene, displayObject).center
      : { x: source.x, y: source.y };
    setDrag({
      kind,
      axis,
      objectId: source.id,
      startPointer: point,
      startPivot,
      startObject: source,
      startAngle: Math.atan2(point.y - startPivot.y, point.x - startPivot.x)
    });
  }

  function moveTransform(event: PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const point = clientToScene(event.clientX, event.clientY);
    if (!point) return;
    const object = drag.startObject;

    if (drag.kind === "move") {
      const delta = { x: point.x - drag.startPointer.x, y: point.y - drag.startPointer.y };
      if (drag.axis === "z" && supportsDepthPosition(object)) {
        updateObject(drag.objectId, {
          zDepth: snapValue(object.zDepth - delta.y, snapping)
        });
        return;
      }
      const constrained = constrainMoveDelta(delta, object.rotation, drag.axis, snapping);
      const nextX = object.x + constrained.x;
      const nextY = object.y + constrained.y;
      updateObject(drag.objectId, {
        x: drag.axis === "free" ? snapValue(nextX, snapping) : roundTransformValue(nextX),
        y: drag.axis === "free" ? snapValue(nextY, snapping) : roundTransformValue(nextY)
      });
      return;
    }

    if (drag.kind === "rotate") {
      if (supportsSpatialRotation(object)) {
        const degreesPerPixel = 0.45;
        if (drag.axis === "x") {
          updateObject(drag.objectId, {
            rotationX: snapAngle((object.rotationX ?? 0) - (point.y - drag.startPointer.y) * degreesPerPixel, snapping)
          });
          return;
        }
        if (drag.axis === "y") {
          updateObject(drag.objectId, {
            rotationY: snapAngle((object.rotationY ?? 0) + (point.x - drag.startPointer.x) * degreesPerPixel, snapping)
          });
          return;
        }
      }
      const angle = Math.atan2(point.y - drag.startPivot.y, point.x - drag.startPivot.x);
      const degrees = object.rotation + radiansToDegrees(normalizeRadians(angle - drag.startAngle));
      if (object.type === "mesh") {
        updateObject(drag.objectId, { rotationZ: snapAngle((object.rotationZ ?? object.rotation) + radiansToDegrees(normalizeRadians(angle - drag.startAngle)), snapping) });
      } else {
        updateObject(drag.objectId, { rotation: snapAngle(degrees, snapping) });
      }
      return;
    }

    if (drag.kind === "scale") {
      const startVector = worldVectorInObjectAxes(object, drag.startPointer);
      const nextVector = worldVectorInObjectAxes(object, point);
      const startScaleX = object.scaleX ?? 1;
      const startScaleY = object.scaleY ?? 1;
      if (drag.axis === "z" && supportsDepthScale(object)) {
        updateObject(drag.objectId, {
          scaleZ: snapScale((object.scaleZ ?? 1) + (drag.startPointer.y - point.y) / 100, snapping)
        });
      } else if (drag.axis === "x" && Math.abs(startVector.x) > 0.001) {
        updateObject(drag.objectId, {
          scaleX: snapScale(startScaleX * (nextVector.x / startVector.x), snapping)
        });
      } else if (drag.axis === "y" && Math.abs(startVector.y) > 0.001) {
        updateObject(drag.objectId, {
          scaleY: snapScale(startScaleY * (nextVector.y / startVector.y), snapping)
        });
      } else if (drag.axis === "uniform") {
        const denominator = startVector.x * startVector.x + startVector.y * startVector.y;
        if (denominator > 0.001) {
          const ratio = (nextVector.x * startVector.x + nextVector.y * startVector.y) / denominator;
          updateObject(drag.objectId, {
            scaleX: snapScale(startScaleX * ratio, snapping),
            scaleY: snapScale(startScaleY * ratio, snapping)
          });
        }
      }
      return;
    }

    const previousAnchor = object.anchor ?? { x: 0, y: 0 };
    const nextAnchorRaw = worldToLocal(object, point);
    const nextAnchor = snapping
      ? { x: snapValue(nextAnchorRaw.x, true), y: snapValue(nextAnchorRaw.y, true) }
      : { x: Math.round(nextAnchorRaw.x), y: Math.round(nextAnchorRaw.y) };
    const compensation = localVectorToWorld(object, {
      x: nextAnchor.x - previousAnchor.x,
      y: nextAnchor.y - previousAnchor.y
    });
    updateObject(drag.objectId, {
      anchor: nextAnchor,
      x: object.x + compensation.x,
      y: object.y + compensation.y
    });
  }

  function finishTransform() {
    if (!drag) return;
    commitHistory();
    setDrag(null);
  }

  function materialAtPointer(
    clientX: number,
    clientY: number,
    accepts: (object: SceneObject) => boolean
  ) {
    const host = document.querySelector(".stage.gpu-stage")?.getBoundingClientRect();
    if (!host) return null;
    const x = ((clientX - host.left) / host.width) * scene.canvas.width;
    const y = ((clientY - host.top) / host.height) * scene.canvas.height;
    return [...displayObjects].reverse().find((object) => {
      if (!object.visible || !accepts(object)) return false;
      if (object.type === "mesh") {
        const bounds = projectMeshBounds(evaluatedScene, object);
        return x >= bounds.x && x <= bounds.x + bounds.width
          && y >= bounds.y && y <= bounds.y + bounds.height;
      }
      const local = worldToLocal(object, { x, y });
      return local.x >= 0 && local.x <= object.width && local.y >= 0 && local.y <= object.height;
    }) ?? null;
  }

  // --- Pen tool -------------------------------------------------------------
  function overlayScale() {
    const rect = document.querySelector(".stage-interaction-overlay")?.getBoundingClientRect();
    return rect ? { rect, scenePerPx: scene.canvas.width / rect.width } : null;
  }

  function clientToScene(clientX: number, clientY: number): Vec2 | null {
    const s = overlayScale();
    if (!s) return null;
    return {
      x: (clientX - s.rect.left) * (scene.canvas.width / s.rect.width),
      y: (clientY - s.rect.top) * (scene.canvas.height / s.rect.height)
    };
  }

  function penDown(clientX: number, clientY: number) {
    const point = clientToScene(clientX, clientY);
    if (!point) return;
    const closeThreshold = 10 * (overlayScale()?.scenePerPx ?? 1);

    // Pen target = mask: draw a mask (local coords) on the selected object.
    if (penTarget === "mask") {
      const target = scene.objects.find((item) => item.id === selectedObjectId);
      if (!target) return;
      const local = worldToLocal(target, point);
      const activeMask = penMaskId ? (target.masks ?? []).find((mask) => mask.id === penMaskId) : null;
      if (activeMask) {
        const first = activeMask.path.vertices[0];
        const firstScene = localToWorld(target, first);
        if (activeMask.path.vertices.length >= 3 && Math.hypot(point.x - firstScene.x, point.y - firstScene.y) < closeThreshold) {
          beginHistory("mask close");
          closeMaskPath(target.id, activeMask.id);
          commitHistory();
          setPenMaskId(null);
          return;
        }
        beginHistory("mask vertex");
        appendMaskVertex(target.id, activeMask.id, local);
        commitHistory();
        return;
      }
      beginHistory("mask start");
      const id = addMask(target.id, local);
      commitHistory();
      setPenMaskId(id);
      return;
    }

    const active = penObjectId ? scene.objects.find((item) => item.id === penObjectId) : null;
    if (active && active.type === "shape") {
      const first = active.path.vertices[0];
      const firstScene = localToWorld(active, first);
      if (active.path.vertices.length >= 2 && Math.hypot(point.x - firstScene.x, point.y - firstScene.y) < closeThreshold) {
        beginHistory("pen close");
        closeShapePath(active.id);
        commitHistory();
        setPenObjectId(null);
        setPenDrag(null);
        return;
      }
      beginHistory("pen vertex");
      const index = appendShapeVertex(active.id, worldToLocal(active, point));
      setPenDrag({ index, kind: "create-tangent" });
      return;
    }
    beginHistory("pen start");
    const id = createPenShape(point);
    setPenObjectId(id);
    setPenDrag({ index: 0, kind: "create-tangent" });
  }

  function penMove(clientX: number, clientY: number) {
    const point = clientToScene(clientX, clientY);
    if (!point) return;
    setPenCursor(point);
    if (!penDrag || !penShape) return;
    const vertex = penShape.path.vertices[penDrag.index];
    if (!vertex) return;
    if (penDrag.kind === "vertex") {
      updateShapeVertex(penShape.id, penDrag.index, { vertex: worldToLocal(penShape, point) });
      return;
    }
    // Drag from the just-placed vertex sets a symmetric smooth handle.
    const localPoint = worldToLocal(penShape, point);
    const out = { x: localPoint.x - vertex.x, y: localPoint.y - vertex.y };
    updateShapeVertex(penShape.id, penDrag.index, { outTangent: out, inTangent: { x: -out.x, y: -out.y } });
  }

  function penUp() {
    if (penDrag) {
      commitHistory();
      setPenDrag(null);
    }
  }

  // --- Photoshop-style creation and editing tools --------------------------
  function startToolPointer(event: PointerEvent<SVGSVGElement>) {
    const point = clientToScene(event.clientX, event.clientY);
    if (!point) return false;

    if (activeTool === "horizontal-type" || activeTool === "vertical-type") {
      beginHistory("create text");
      setEditingTextId(null);
      setTypeDrag({ start: point, current: point });
      return true;
    }

    if (activeTool === "rectangular-marquee" || activeTool === "elliptical-marquee") {
      setMarqueeStart(point);
      setMarqueeSelection(marqueeFromDrag(
        activeTool === "elliptical-marquee" ? "ellipse" : "rectangle",
        point,
        point,
        marqueeOptions,
        { square: event.shiftKey, fromCenter: event.altKey }
      ));
      return true;
    }

    if (activeTool === "brush") {
      beginBrush(point, event.pressure || 1);
      return true;
    }

    if (activeTool === "eyedropper") {
      sampleEyedropper(point, event.clientX, event.clientY, true);
      return true;
    }

    return false;
  }

  function moveToolPointer(event: PointerEvent<SVGSVGElement>) {
    const point = clientToScene(event.clientX, event.clientY);
    if (!point) return false;

    if (typeDrag) {
      setTypeDrag({ ...typeDrag, current: point });
      return true;
    }
    if (marqueeStart) {
      setMarqueeSelection(marqueeFromDrag(
        activeTool === "elliptical-marquee" ? "ellipse" : "rectangle",
        marqueeStart,
        point,
        marqueeOptions,
        { square: event.shiftKey, fromCenter: event.altKey }
      ));
      return true;
    }
    if (brushDrag) {
      continueBrush(point, event.pressure || 1);
      return true;
    }
    if (pointDrag) {
      movePathPoint(point);
      return true;
    }
    if (gradientDrag) {
      moveGradientHandle(point);
      return true;
    }
    if (activeTool === "brush") {
      setBrushCursor(point);
      return true;
    }
    if (activeTool === "eyedropper") {
      sampleEyedropper(point, event.clientX, event.clientY, false);
      return true;
    }
    return false;
  }

  function finishToolPointer(cancelled = false) {
    if (typeDrag) {
      if (cancelled) {
        cancelHistory();
      } else {
        const width = Math.abs(typeDrag.current.x - typeDrag.start.x);
        const height = Math.abs(typeDrag.current.y - typeDrag.start.y);
        const origin = {
          x: Math.min(typeDrag.start.x, typeDrag.current.x),
          y: Math.min(typeDrag.start.y, typeDrag.current.y)
        };
        const id = addTextAt(
          origin,
          width >= 4 || height >= 4 ? { x: Math.max(1, width), y: Math.max(1, height) } : null,
          activeTool === "vertical-type" ? "vertical-rl" : "horizontal-tb"
        );
        commitHistory();
        setEditingTextId(id);
      }
      setTypeDrag(null);
      return true;
    }
    if (marqueeStart) {
      if (!cancelled && marqueeSelection && marqueeSelection.width > 0 && marqueeSelection.height > 0) {
        applyMarquee(marqueeSelection);
      } else if (cancelled) {
        setMarqueeSelection(null);
      }
      setMarqueeStart(null);
      return true;
    }
    if (brushDrag) {
      if (cancelled) cancelHistory();
      else commitHistory();
      setBrushDrag(null);
      return true;
    }
    if (pointDrag) {
      if (cancelled) cancelHistory();
      else commitHistory();
      setPointDrag(null);
      return true;
    }
    if (gradientDrag) {
      if (cancelled) cancelHistory();
      else commitHistory();
      setGradientDrag(null);
      return true;
    }
    return false;
  }

  function beginBrush(point: Vec2, pressure: number) {
    beginHistory(brushOptions.mode === "paint" ? "paint stroke" : "paint mask");
    const strokeId = createSceneId("stroke");
    const rawPoint: BrushPoint = { ...point, pressure, time: performance.now() };
    const stroke: PaintStroke = {
      id: strokeId,
      points: [rawPoint],
      size: brushOptions.size,
      hardness: brushOptions.hardness,
      opacity: brushOptions.opacity,
      flow: brushOptions.flow,
      spacing: brushOptions.spacing,
      smoothing: brushOptions.smoothing,
      roundness: brushOptions.roundness,
      angle: brushOptions.angle,
      color: foregroundColor,
      blendMode: brushOptions.blendMode,
      maskMode: brushOptions.mode === "mask-erase"
        ? "erase"
        : brushOptions.mode === "mask-reveal"
          ? "reveal"
          : "paint"
    };

    if (brushOptions.mode === "paint") {
      const selected = useEditorStore.getState().scene.objects.find((item) => item.id === selectedObjectId);
      const objectId = selected?.type === "paint" ? selected.id : createPaintLayer();
      const host = useEditorStore.getState().scene.objects.find((item) => item.id === objectId);
      const localPoint = host ? worldToLocal(host, point) : point;
      stroke.points = [{ ...localPoint, pressure, time: rawPoint.time }];
      addPaintStroke(objectId, stroke);
      setBrushDrag({ objectId, strokeId, rawPoints: [rawPoint] });
      setBrushCursor(point);
      return;
    }

    const host = useEditorStore.getState().scene.objects.find((item) => item.id === selectedObjectId);
    if (!host || host.locked) {
      cancelHistory();
      return;
    }
    const existing = host.masks?.find((mask) => mask.id === selectedMaskId && mask.type === "paint");
    const maskId = existing?.id ?? addMaskFromPath(host.id, {
      closed: true,
      vertices: [],
      inTangents: [],
      outTangents: []
    }, "paint");
    if (!maskId) {
      cancelHistory();
      return;
    }
    const localPoint = worldToLocal(host, point);
    stroke.points = [{ ...localPoint, pressure, time: rawPoint.time }];
    const latestHost = useEditorStore.getState().scene.objects.find((item) => item.id === host.id);
    const mask = latestHost?.masks?.find((item) => item.id === maskId);
    updateMask(host.id, maskId, { paintStrokes: [...(mask?.paintStrokes ?? []), stroke] });
    setSelectedMaskId(maskId);
    setBrushDrag({ objectId: host.id, strokeId, rawPoints: [rawPoint], maskId });
    setBrushCursor(point);
  }

  function continueBrush(point: Vec2, pressure: number) {
    if (!brushDrag) return;
    const nextRaw = [...brushDrag.rawPoints, { ...point, pressure, time: performance.now() }];
    const host = useEditorStore.getState().scene.objects.find((item) => item.id === brushDrag.objectId);
    if (!host) return;
    const localRaw = nextRaw.map((item) => ({ ...worldToLocal(host, item), pressure: item.pressure, time: item.time }));
    const points = smoothBrushPoints(localRaw, brushOptions.smoothing, Math.max(0.5, brushOptions.size * brushOptions.spacing));
    if (brushDrag.maskId) {
      const mask = host.masks?.find((item) => item.id === brushDrag.maskId);
      updateMask(host.id, brushDrag.maskId, {
        paintStrokes: (mask?.paintStrokes ?? []).map((stroke) =>
          stroke.id === brushDrag.strokeId ? { ...stroke, points } : stroke
        )
      });
    } else {
      updatePaintStroke(host.id, brushDrag.strokeId, { points });
    }
    setBrushDrag({ ...brushDrag, rawPoints: nextRaw });
    setBrushCursor(point);
  }

  function applyMarquee(selection: NonNullable<typeof marqueeSelection>) {
    if (marqueeOptions.mode === "mask") {
      const host = scene.objects.find((item) => item.id === selectedObjectId);
      if (!host || host.locked) return;
      beginHistory("create marquee mask");
      const localPath = scenePathToLocal(host, marqueePath(selection));
      const id = addMaskFromPath(
        host.id,
        localPath,
        selection.kind,
        { x: selection.feather, y: selection.feather }
      );
      commitHistory();
      setSelectedMaskId(id);
      return;
    }
    if (marqueeOptions.mode === "region") return;

    const matches = scene.objects
      .filter((object) => objectIntersectsMarquee(object, selection, marqueeOptions.objectContainment))
      .map((object) => object.id);
    let next = matches;
    if (selection.operation === "add") next = [...new Set([...selectedPathObjectIds, ...matches])];
    if (selection.operation === "subtract") next = selectedPathObjectIds.filter((id) => !matches.includes(id));
    if (selection.operation === "intersect") next = selectedPathObjectIds.filter((id) => matches.includes(id));
    setSelectedPaths(next);
    selectObject(next.at(-1) ?? null);
  }

  function sampleEyedropper(point: Vec2, clientX: number, clientY: number, apply: boolean) {
    const object = materialAtPointer(clientX, clientY, () => true);
    if (!object) {
      setEyedropperPreview({ point, color: scene.canvas.background });
      if (apply) setForegroundColor({ type: "solid", color: scene.canvas.background });
      return;
    }
    const local = worldToLocal(object, point);
    const source = object.fillStyle ?? object.fill;
    const normalizedPoint = {
      x: object.width ? local.x / object.width : 0,
      y: object.height ? local.y / object.height : 0
    };
    const color = sampleColorValue(source, normalizedPoint);
    setEyedropperPreview({ point, color });
    if (!apply) return;
    const copied = eyedropperOptions.copyGradient && object.fillStyle
      ? object.fillStyle
      : { type: "solid" as const, color };
    setForegroundColor(copied);
    if (eyedropperOptions.applyToSelection && selectedObjectId) {
      updateObject(selectedObjectId, { fill: color, fillStyle: copied });
    }
  }

  function movePathPoint(point: Vec2) {
    if (!pointDrag) return;
    const host = useEditorStore.getState().scene.objects.find((item) => item.id === pointDrag.objectId);
    if (!host) return;
    const local = worldToLocal(host, point);
    const path = pointDrag.maskId
      ? host.masks?.find((mask) => mask.id === pointDrag.maskId)?.path
      : host.type === "shape"
        ? host.path
        : undefined;
    const anchor = path?.vertices[pointDrag.index];
    if (!anchor) return;
    const patch = pointDrag.kind === "vertex"
      ? { vertex: local }
      : pointDrag.kind === "in-tangent"
        ? { inTangent: { x: local.x - anchor.x, y: local.y - anchor.y } }
        : { outTangent: { x: local.x - anchor.x, y: local.y - anchor.y } };
    if (pointDrag.maskId) updateMaskVertex(host.id, pointDrag.maskId, pointDrag.index, patch);
    else if (host.type === "shape") updateShapeVertex(host.id, pointDrag.index, patch);
  }

  function moveGradientHandle(point: Vec2) {
    if (!gradientDrag) return;
    const object = useEditorStore.getState().scene.objects.find((item) => item.id === gradientDrag.objectId);
    const value = object?.fillStyle;
    if (!object || !value || (value.type !== "linear-gradient" && value.type !== "radial-gradient")) return;
    const coordinate = gradientCoordinateFromWorld(object, value, point);
    if (value.type === "linear-gradient") {
      updateObject(object.id, {
        fillStyle: gradientDrag.handle === "start"
          ? { ...value, startX: coordinate.x, startY: coordinate.y }
          : { ...value, endX: coordinate.x, endY: coordinate.y }
      });
      return;
    }
    if (gradientDrag.handle === "center") {
      updateObject(object.id, { fillStyle: { ...value, centerX: coordinate.x, centerY: coordinate.y } });
    } else if (gradientDrag.handle === "focal") {
      updateObject(object.id, { fillStyle: { ...value, focalX: coordinate.x, focalY: coordinate.y } });
    } else if (gradientDrag.handle === "radius-x") {
      updateObject(object.id, { fillStyle: { ...value, radiusX: Math.max(0.001, Math.abs(coordinate.x - value.centerX)) } });
    } else if (gradientDrag.handle === "radius-y") {
      updateObject(object.id, { fillStyle: { ...value, radiusY: Math.max(0.001, Math.abs(coordinate.y - value.centerY)) } });
    }
  }

  function startGuideDrag(orientation: CanvasGuide["orientation"], guideId?: string) {
    if (guideDrag) return;
    const id = guideId ?? createSceneId("guide");
    beginHistory(guideId ? "move guide" : "add guide");
    if (!guideId) {
      updateCanvasViewport({
        guides: [
          ...viewportSettings.guides,
          { guideId: id, orientation, position: 0 }
        ]
      });
    }
    setGuideDrag({ guideId: id, orientation });
  }

  return (
    <main className="stage-shell">
      <div className="stage-toolbar">
        <span>{scene.canvas.width} x {scene.canvas.height}</span>
        <span className="renderer-status" title={capabilities?.rendererName ?? "Renderer initializing"}>
          GPU {capabilities?.backend.toUpperCase() ?? "INIT"}
          {capabilities?.maxTextureSize ? ` / ${capabilities.maxTextureSize}px tex` : ""}
        </span>
        <DesignToolToolbar />
        <ToolOptionsBar />
        <button className={`snapping-toggle ${snapping ? "active" : ""}`} onClick={toggleSnapping}>
          Snapping
        </button>
        <span>{scene.objects.length} objects</span>
      </div>
      <div className="stage-frame">
        <div
          className={`viewport-chrome ${viewportSettings.showRulers ? "with-rulers" : "without-rulers"}`}
          style={{
            transform: `scale(${zoom / 100})`,
            "--viewport-ui-scale": 100 / zoom
          } as CSSProperties}
        >
          {viewportSettings.showRulers ? (
            <>
              <button
                className="viewport-ruler-corner"
                title="Double-click to clear all guides"
                aria-label="Ruler origin; double-click to clear all guides"
                onDoubleClick={() => {
                  beginHistory("clear guides");
                  updateCanvasViewport({ guides: [] });
                  commitHistory();
                }}
              />
              <div
                className="viewport-ruler viewport-ruler-horizontal"
                aria-label="Horizontal canvas ruler; drag downward to add a guide"
                onPointerDown={(event) => {
                  if (event.button === 0) startGuideDrag("horizontal");
                }}
              >
                {rulerTicks(scene.canvas.width, zoom).map((tick) => (
                  <span
                    className={tick.major ? "major" : ""}
                    key={tick.value}
                    style={{ left: `${tick.percent}%` }}
                  >
                    {tick.major ? <em>{tick.value}</em> : null}
                  </span>
                ))}
              </div>
              <div
                className="viewport-ruler viewport-ruler-vertical"
                aria-label="Vertical canvas ruler; drag right to add a guide"
                onPointerDown={(event) => {
                  if (event.button === 0) startGuideDrag("vertical");
                }}
              >
                {rulerTicks(scene.canvas.height, zoom).map((tick) => (
                  <span
                    className={tick.major ? "major" : ""}
                    key={tick.value}
                    style={{ top: `${tick.percent}%` }}
                  >
                    {tick.major ? <em>{tick.value}</em> : null}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        <div
          ref={stageRef}
          className="stage gpu-stage"
          role="application"
          aria-label={`${scene.name} GPU viewport`}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setMaterialDropTarget(null); }}
          onDragOver={(event) => {
            const types = event.dataTransfer.types;
            const isAsset = types.includes("application/x-grapix-asset");
            if (!types.includes("application/x-grapix-material") && !isAsset) return;
            event.preventDefault();
            const draggedMaterial = isAsset
              ? undefined
              : scene.materials.find((item) =>
                  item.materialId === event.dataTransfer.getData("application/x-grapix-material")
                );
            // Search for the first compatible pixel-producing leaf, not merely
            // the topmost scene object. Non-rendering layer/group guides and
            // camera/light helpers must never intercept a drop intended for
            // their visible child.
            const object = materialAtPointer(event.clientX, event.clientY, (candidate) =>
              isAsset
                ? ["rect", "image", "mesh"].includes(candidate.type)
                : draggedMaterial
                  ? isMaterialCompatibleWithFace(draggedMaterial, candidate, 0)
                  : !["layer", "group", "camera", "light", "marker"].includes(candidate.type)
            );
            // Image assets always back an image material. Mesh surfaces accept
            // them as face textures; browsers hide the asset payload here.
            const compatible = isAsset
              ? Boolean(object && ["rect", "image", "mesh"].includes(object.type))
              : Boolean(object && draggedMaterial && isMaterialCompatibleWithFace(draggedMaterial, object, 0));
            event.dataTransfer.dropEffect = compatible ? "copy" : "none";
            setMaterialDropTarget(object ? { objectId: object.id, compatible } : null);
          }}
          onDrop={(event) => {
            const materialId = event.dataTransfer.getData("application/x-grapix-material");
            const instanceId = event.dataTransfer.getData("application/x-grapix-material-instance");
            const assetId = event.dataTransfer.getData("application/x-grapix-asset");
            const target = materialDropTarget;
            event.preventDefault();
            setMaterialDropTarget(null);
            const targetObject = target?.compatible
              ? scene.objects.find((object) => object.id === target.objectId)
              : undefined;
            const faceIndices = targetObject
              ? getBindableFaces(targetObject).map((face) => face.index)
              : [];
            if (materialId && targetObject) {
              assignMaterialToFaces(
                targetObject.id,
                faceIndices,
                instanceId ? { materialId, instanceId } : materialId
              );
            } else if (assetId && targetObject) {
              assignAssetToFaces(targetObject.id, faceIndices, assetId);
            }
          }}
        >
          <GpuSceneStage scene={scene} objects={displayObjects} onCapabilities={setCapabilities} />
          <svg
            className={`stage-interaction-overlay ${activeTool === "pen" ? "pen-mode" : ""}`}
            viewBox={`0 0 ${scene.canvas.width} ${scene.canvas.height}`}
            role="img"
            aria-label={scene.name}
            onPointerDown={(event) => {
              if (activeTool === "pen") {
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // No active pointer to capture (e.g. programmatic events) — ignore.
                }
                penDown(event.clientX, event.clientY);
                return;
              }
              if (startToolPointer(event)) {
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  // Programmatic pointers do not always expose capture.
                }
                return;
              }
              finishTransform();
              selectObject(null);
              setSelectedPaths([]);
              setSelectedAnchors([]);
            }}
            onPointerMove={(event) => {
              if (activeTool === "pen") {
                penMove(event.clientX, event.clientY);
                return;
              }
              if (moveToolPointer(event)) return;
              moveTransform(event);
            }}
            onPointerUp={() => {
              if (activeTool === "pen") {
                penUp();
                return;
              }
              if (finishToolPointer()) return;
              finishTransform();
            }}
            onPointerCancel={() => {
              if (activeTool === "pen") {
                penUp();
                return;
              }
              if (finishToolPointer(true)) return;
              finishTransform();
            }}
            onPointerLeave={() => {
              if (activeTool === "pen" && !penDrag) setPenCursor(null);
              if (activeTool === "brush" && !brushDrag) setBrushCursor(null);
              if (activeTool === "eyedropper") setEyedropperPreview(null);
            }}
          >
            <rect width={scene.canvas.width} height={scene.canvas.height} fill="transparent" />
            {displayObjects.map((object) => {
              const meshBounds = object.type === "mesh" ? projectMeshBounds(evaluatedScene, object) : null;
              return (
                <g
                  key={object.id}
                  transform={meshBounds ? undefined : objectSvgTransform(object)}
                visibility={object.visible ? "visible" : "hidden"}
                onPointerDown={(event) => beginObjectInteraction(event, object)}
                className={`scene-object tool-${activeTool} ${object.locked ? "locked" : ""}`}
              >
                <rect
                  x={meshBounds?.x ?? 0}
                  y={meshBounds?.y ?? 0}
                  width={meshBounds?.width ?? object.width}
                  height={meshBounds?.height ?? object.height}
                  fill="transparent"
                  stroke={isHierarchyContainer(object) ? object.stroke : undefined}
                  strokeWidth={isHierarchyContainer(object) ? Math.max(2, object.strokeWidth) : undefined}
                  strokeDasharray={isHierarchyContainer(object) ? "14 9" : undefined}
                  pointerEvents={isHierarchyContainer(object) ? "stroke" : "all"}
                />
                {materialDropTarget?.objectId === object.id ? (
                  <rect
                    x={(meshBounds?.x ?? 0) - 10}
                    y={(meshBounds?.y ?? 0) - 10}
                    width={(meshBounds?.width ?? object.width) + 20}
                    height={(meshBounds?.height ?? object.height) + 20}
                    fill={materialDropTarget.compatible ? "rgba(35, 199, 217, 0.14)" : "rgba(220, 76, 86, 0.18)"}
                    stroke={materialDropTarget.compatible ? "#23c7d9" : "#dc4c56"}
                    strokeWidth="6"
                    pointerEvents="none"
                  />
                ) : null}
                </g>
              );
            })}
            {selectedDisplayObject && activeTool !== "pen" ? (
              <TransformGizmo
                scene={evaluatedScene}
                object={selectedDisplayObject}
                tool={activeTool}
                onStart={(event, kind, axis) => beginTransformDrag(event, selectedDisplayObject, kind, axis)}
              />
            ) : null}
            {activeTool === "pen" && penMask ? (
              <g className="pen-overlay">
                <polyline
                  points={penMask.mask.path.vertices.map((vertex) => {
                    const point = localToWorld(penMask.host, vertex);
                    return `${point.x},${point.y}`;
                  }).join(" ")}
                  fill="none"
                  stroke="#f5b942"
                  strokeWidth={2}
                  strokeDasharray="8 6"
                  pointerEvents="none"
                />
                {penMask.mask.path.vertices.map((vertex, index) => {
                  const point = localToWorld(penMask.host, vertex);
                  return (
                    <rect
                      key={index}
                      x={point.x - 6}
                      y={point.y - 6}
                      width={12}
                      height={12}
                      fill={index === 0 ? "#f5b942" : "#ffffff"}
                      stroke="#1a2634"
                      strokeWidth={2}
                      pointerEvents="none"
                    />
                  );
                })}
                {penMaskId && penCursor && penMask.mask.path.vertices.length ? (
                  <line
                    className="pen-live-preview"
                    x1={localToWorld(penMask.host, penMask.mask.path.vertices.at(-1)!).x}
                    y1={localToWorld(penMask.host, penMask.mask.path.vertices.at(-1)!).y}
                    x2={penCursor.x}
                    y2={penCursor.y}
                    pointerEvents="none"
                  />
                ) : null}
              </g>
            ) : null}
            {activeTool === "pen" && penShape ? (
              <g className="pen-overlay">
                {penShape.path.vertices.map((vertex, index) => {
                  const vertexWorld = localToWorld(penShape, vertex);
                  const vx = vertexWorld.x;
                  const vy = vertexWorld.y;
                  const out = penShape.path.outTangents[index];
                  const inn = penShape.path.inTangents[index];
                  const outWorld = out ? localToWorld(penShape, { x: vertex.x + out.x, y: vertex.y + out.y }) : null;
                  const inWorld = inn ? localToWorld(penShape, { x: vertex.x + inn.x, y: vertex.y + inn.y }) : null;
                  const isFirst = index === 0;
                  return (
                    <g key={index}>
                      {outWorld && out && (out.x !== 0 || out.y !== 0) ? (
                        <>
                          <line x1={vx} y1={vy} x2={outWorld.x} y2={outWorld.y} stroke="#8fd0ff" strokeWidth={2} pointerEvents="none" />
                          <circle cx={outWorld.x} cy={outWorld.y} r={5} fill="#8fd0ff" pointerEvents="none" />
                        </>
                      ) : null}
                      {inWorld && inn && (inn.x !== 0 || inn.y !== 0) ? (
                        <>
                          <line x1={vx} y1={vy} x2={inWorld.x} y2={inWorld.y} stroke="#8fd0ff" strokeWidth={2} pointerEvents="none" />
                          <circle cx={inWorld.x} cy={inWorld.y} r={5} fill="#8fd0ff" pointerEvents="none" />
                        </>
                      ) : null}
                      <rect
                        x={vx - 6}
                        y={vy - 6}
                        width={12}
                        height={12}
                        fill={isFirst ? "#f5b942" : "#ffffff"}
                        stroke="#1a2634"
                        strokeWidth={2}
                        style={{ cursor: "move" }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          beginHistory("move vertex");
                          setPenObjectId(penShape.id);
                          setPenDrag({ index, kind: "vertex" });
                        }}
                      />
                    </g>
                  );
                })}
                {penObjectId && penCursor && penShape.path.vertices.length ? (
                  <PenSegmentPreview object={penShape} cursor={penCursor} />
                ) : null}
              </g>
            ) : null}
            {selectedGradient && (activeTool === "path-selection" || activeTool === "direct-selection") ? (
              <GradientHandles
                object={selectedGradient.object}
                value={selectedGradient.value}
                onStart={(event, handle) => {
                  event.stopPropagation();
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Synthetic pointer events do not expose capture.
                  }
                  beginHistory("move gradient handle");
                  setGradientDrag({ objectId: selectedGradient.object.id, handle });
                }}
              />
            ) : null}
            {typeDrag ? (
              <rect
                className="type-drag-box"
                x={Math.min(typeDrag.start.x, typeDrag.current.x)}
                y={Math.min(typeDrag.start.y, typeDrag.current.y)}
                width={Math.abs(typeDrag.current.x - typeDrag.start.x)}
                height={Math.abs(typeDrag.current.y - typeDrag.start.y)}
                pointerEvents="none"
              />
            ) : null}
            {marqueeSelection ? (
              <g className="marquee-overlay" pointerEvents="none">
                {marqueeSelection.kind === "ellipse" ? (
                  <ellipse
                    cx={marqueeSelection.x + marqueeSelection.width / 2}
                    cy={marqueeSelection.y + marqueeSelection.height / 2}
                    rx={marqueeSelection.width / 2}
                    ry={marqueeSelection.height / 2}
                  />
                ) : (
                  <rect
                    x={marqueeSelection.x}
                    y={marqueeSelection.y}
                    width={marqueeSelection.width}
                    height={marqueeSelection.height}
                  />
                )}
                <text x={marqueeSelection.x + 8} y={Math.max(18, marqueeSelection.y - 8)}>
                  {Math.round(marqueeSelection.x)}, {Math.round(marqueeSelection.y)} · {Math.round(marqueeSelection.width)} × {Math.round(marqueeSelection.height)}
                </text>
              </g>
            ) : null}
            {activeTool === "direct-selection" && directPathTarget ? (
              <g className="direct-path-overlay">
                <path
                  d={bezierPathSvg(directPathTarget.host, directPathTarget.path)}
                  className="direct-path-line"
                  pointerEvents="none"
                />
                {directPathTarget.path.vertices.map((vertex, index) => {
                  const vertexWorld = localToWorld(directPathTarget.host, vertex);
                  const selected = selectedAnchorIndices.includes(index);
                  const inTangent = directPathTarget.path.inTangents[index] ?? { x: 0, y: 0 };
                  const outTangent = directPathTarget.path.outTangents[index] ?? { x: 0, y: 0 };
                  const inWorld = localToWorld(directPathTarget.host, {
                    x: vertex.x + inTangent.x,
                    y: vertex.y + inTangent.y
                  });
                  const outWorld = localToWorld(directPathTarget.host, {
                    x: vertex.x + outTangent.x,
                    y: vertex.y + outTangent.y
                  });
                  const startPointDrag = (
                    event: PointerEvent<SVGElement>,
                    kind: PointDragState["kind"]
                  ) => {
                    event.stopPropagation();
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // Synthetic pointer events do not expose capture.
                    }
                    if (kind === "vertex") {
                      setSelectedAnchors(event.shiftKey
                        ? selected
                          ? selectedAnchorIndices.filter((item) => item !== index)
                          : [...selectedAnchorIndices, index]
                        : [index]);
                    }
                    beginHistory(kind === "vertex" ? "move path point" : "edit bezier handle");
                    setPointDrag({
                      objectId: directPathTarget.host.id,
                      index,
                      maskId: directPathTarget.maskId,
                      kind
                    });
                  };
                  return (
                    <g key={`${directPathTarget.maskId ?? directPathTarget.host.id}-${index}`}>
                      {selected && (inTangent.x !== 0 || inTangent.y !== 0) ? (
                        <>
                          <line className="direct-handle-line" x1={vertexWorld.x} y1={vertexWorld.y} x2={inWorld.x} y2={inWorld.y} />
                          <circle className="direct-handle" cx={inWorld.x} cy={inWorld.y} r={5} onPointerDown={(event) => startPointDrag(event, "in-tangent")} />
                        </>
                      ) : null}
                      {selected && (outTangent.x !== 0 || outTangent.y !== 0) ? (
                        <>
                          <line className="direct-handle-line" x1={vertexWorld.x} y1={vertexWorld.y} x2={outWorld.x} y2={outWorld.y} />
                          <circle className="direct-handle" cx={outWorld.x} cy={outWorld.y} r={5} onPointerDown={(event) => startPointDrag(event, "out-tangent")} />
                        </>
                      ) : null}
                      <rect
                        className={`direct-anchor ${selected ? "selected" : ""}`}
                        x={vertexWorld.x - 6}
                        y={vertexWorld.y - 6}
                        width={12}
                        height={12}
                        onPointerDown={(event) => startPointDrag(event, "vertex")}
                      />
                    </g>
                  );
                })}
              </g>
            ) : null}
            {brushCursor ? (
              <circle
                className="brush-cursor"
                cx={brushCursor.x}
                cy={brushCursor.y}
                r={Math.max(1, brushOptions.size / 2)}
                pointerEvents="none"
              />
            ) : null}
            {eyedropperPreview ? (
              <g className="eyedropper-preview" pointerEvents="none">
                <circle cx={eyedropperPreview.point.x} cy={eyedropperPreview.point.y} r={24} fill={eyedropperPreview.color} />
                <circle cx={eyedropperPreview.point.x} cy={eyedropperPreview.point.y} r={24} />
                <line x1={eyedropperPreview.point.x - 30} y1={eyedropperPreview.point.y} x2={eyedropperPreview.point.x + 30} y2={eyedropperPreview.point.y} />
                <line x1={eyedropperPreview.point.x} y1={eyedropperPreview.point.y - 30} x2={eyedropperPreview.point.x} y2={eyedropperPreview.point.y + 30} />
              </g>
            ) : null}
          </svg>
          {editingText ? (
            <textarea
              aria-label={`Edit ${editingText.name}`}
              autoFocus
              className="viewport-text-editor"
              onBlur={() => setEditingTextId(null)}
              onChange={(event) => updateObject(editingText.id, { text: event.target.value })}
              style={{
                left: `${editingText.x / scene.canvas.width * 100}%`,
                top: `${editingText.y / scene.canvas.height * 100}%`,
                width: `${editingText.width / scene.canvas.width * 100}%`,
                height: `${editingText.height / scene.canvas.height * 100}%`,
                color: editingText.fill,
                fontFamily: editingText.fontFamily,
                fontSize: `${editingText.fontSize * zoom / 100}px`,
                fontWeight: editingText.fontWeight,
                writingMode: editingText.writingMode === "horizontal-tb"
                  ? "horizontal-tb"
                  : "vertical-rl"
              }}
              value={editingText.text}
            />
          ) : null}
          <div
            className="viewport-safe-margins"
            aria-label="Project viewport safe margins"
            style={{
              top: `${viewportSettings.margins.top / scene.canvas.height * 100}%`,
              right: `${viewportSettings.margins.right / scene.canvas.width * 100}%`,
              bottom: `${viewportSettings.margins.bottom / scene.canvas.height * 100}%`,
              left: `${viewportSettings.margins.left / scene.canvas.width * 100}%`
            }}
          />
          {viewportSettings.guides.map((guide) => (
            <button
              aria-label={`${guide.orientation} guide at ${guide.position} pixels`}
              className={`viewport-guide viewport-guide-${guide.orientation} ${
                guideDrag?.guideId === guide.guideId ? "dragging" : ""
              }`}
              key={guide.guideId}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                startGuideDrag(guide.orientation, guide.guideId);
              }}
              style={guide.orientation === "horizontal"
                ? { top: `${guide.position / scene.canvas.height * 100}%` }
                : { left: `${guide.position / scene.canvas.width * 100}%` }}
              title={`${guide.orientation} guide: ${guide.position}px`}
            />
          ))}
        </div>
        </div>
      </div>
    </main>
  );
}

function GradientHandles(props: {
  object: SceneObject;
  value: Extract<ColorValue, { type: "linear-gradient" | "radial-gradient" }>;
  onStart: (
    event: PointerEvent<SVGCircleElement>,
    handle: GradientDragState["handle"]
  ) => void;
}) {
  if (props.value.type === "linear-gradient") {
    const start = gradientCoordinateToWorld(props.object, props.value, { x: props.value.startX, y: props.value.startY });
    const end = gradientCoordinateToWorld(props.object, props.value, { x: props.value.endX, y: props.value.endY });
    return (
      <g className="gradient-handles">
        <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
        <circle cx={start.x} cy={start.y} r={7} onPointerDown={(event) => props.onStart(event, "start")} />
        <circle cx={end.x} cy={end.y} r={7} onPointerDown={(event) => props.onStart(event, "end")} />
      </g>
    );
  }
  const centerCoordinate = { x: props.value.centerX, y: props.value.centerY };
  const center = gradientCoordinateToWorld(props.object, props.value, centerCoordinate);
  const focal = gradientCoordinateToWorld(props.object, props.value, {
    x: props.value.focalX ?? props.value.centerX,
    y: props.value.focalY ?? props.value.centerY
  });
  const radiusX = gradientCoordinateToWorld(props.object, props.value, {
    x: props.value.centerX + props.value.radiusX,
    y: props.value.centerY
  });
  const radiusY = gradientCoordinateToWorld(props.object, props.value, {
    x: props.value.centerX,
    y: props.value.centerY + props.value.radiusY
  });
  return (
    <g className="gradient-handles">
      <line x1={center.x} y1={center.y} x2={radiusX.x} y2={radiusX.y} />
      <line x1={center.x} y1={center.y} x2={radiusY.x} y2={radiusY.y} />
      <line className="focal-line" x1={center.x} y1={center.y} x2={focal.x} y2={focal.y} />
      <circle cx={center.x} cy={center.y} r={7} onPointerDown={(event) => props.onStart(event, "center")} />
      <circle cx={focal.x} cy={focal.y} r={5} onPointerDown={(event) => props.onStart(event, "focal")} />
      <circle cx={radiusX.x} cy={radiusX.y} r={7} onPointerDown={(event) => props.onStart(event, "radius-x")} />
      <circle cx={radiusY.x} cy={radiusY.y} r={7} onPointerDown={(event) => props.onStart(event, "radius-y")} />
    </g>
  );
}

function rulerTicks(span: number, zoom: number): Array<{ value: number; percent: number; major: boolean }> {
  const majorStep = span > 2500 ? (zoom < 100 ? 500 : 250) : (zoom < 100 ? 200 : 100);
  const minorStep = majorStep / 5;
  const ticks = [];
  for (let value = 0; value <= span; value += minorStep) {
    ticks.push({
      value,
      percent: value / span * 100,
      major: value % majorStep === 0
    });
  }
  return ticks;
}

function TransformGizmo({
  scene,
  object,
  tool,
  onStart
}: {
  scene: SceneDocument;
  object: SceneObject;
  tool: EditorTool;
  onStart: (
    event: PointerEvent<SVGElement>,
    kind: TransformDragState["kind"],
    axis: TransformAxis
  ) => void;
}) {
  const meshBounds = object.type === "mesh" ? projectMeshBounds(scene, object) : null;
  const boundsX = meshBounds?.x ?? 0;
  const boundsY = meshBounds?.y ?? 0;
  const boundsWidth = meshBounds?.width ?? object.width;
  const boundsHeight = meshBounds?.height ?? object.height;
  const pivot = meshBounds?.center ?? { x: object.x, y: object.y };
  const axisLength = 82;
  const displayRotation = object.type === "mesh" ? object.rotationZ ?? object.rotation : object.rotation;
  const xAxis = rotateVector({ x: axisLength, y: 0 }, displayRotation);
  const yAxis = rotateVector({ x: 0, y: axisLength }, displayRotation);
  const xEnd = { x: pivot.x + xAxis.x, y: pivot.y + xAxis.y };
  const yEnd = { x: pivot.x + yAxis.x, y: pivot.y + yAxis.y };
  const zEnd = { x: pivot.x - axisLength * 0.7, y: pivot.y + axisLength * 0.7 };
  const anchor = object.anchor ?? { x: 0, y: 0 };
  const farX = Math.abs(object.width - anchor.x) >= Math.abs(anchor.x) ? object.width : 0;
  const farY = Math.abs(object.height - anchor.y) >= Math.abs(anchor.y) ? object.height : 0;
  const scaleXEnd = meshBounds
    ? { x: meshBounds.x + meshBounds.width, y: pivot.y }
    : localToWorld(object, { x: farX, y: anchor.y });
  const scaleYEnd = meshBounds
    ? { x: pivot.x, y: meshBounds.y + meshBounds.height }
    : localToWorld(object, { x: anchor.x, y: farY });
  const scaleUniformEnd = meshBounds
    ? { x: meshBounds.x + meshBounds.width, y: meshBounds.y + meshBounds.height }
    : localToWorld(object, { x: farX, y: farY });
  const rotationRadius = Math.max(
    58,
    Math.min(190, Math.hypot(object.width * (object.scaleX ?? 1), object.height * (object.scaleY ?? 1)) * 0.32)
  );
  const rotationKnobOffset = rotateVector({ x: 0, y: -rotationRadius }, displayRotation);
  const rotationKnob = { x: pivot.x + rotationKnobOffset.x, y: pivot.y + rotationKnobOffset.y };
  const interactive = !object.locked;

  return (
    <g
      className={`transform-gizmo transform-gizmo-${tool} ${object.locked ? "locked" : ""}`}
      onPointerDown={!interactive ? (event) => event.stopPropagation() : undefined}
    >
      <g transform={meshBounds ? undefined : objectSvgTransform(object)} pointerEvents="none">
        <rect
          className="gizmo-bounds"
          x={boundsX}
          y={boundsY}
          width={boundsWidth}
          height={boundsHeight}
          vectorEffect="non-scaling-stroke"
        />
        {tool === "select" || tool === "path-selection" ? (
          <>
            <rect className="gizmo-corner" x={boundsX - 6} y={boundsY - 6} width={12} height={12} vectorEffect="non-scaling-stroke" onPointerDown={interactive ? (event) => onStart(event, "scale", "uniform") : undefined} pointerEvents="all" />
            <rect className="gizmo-corner" x={boundsX + boundsWidth - 6} y={boundsY - 6} width={12} height={12} vectorEffect="non-scaling-stroke" onPointerDown={interactive ? (event) => onStart(event, "scale", "uniform") : undefined} pointerEvents="all" />
            <rect className="gizmo-corner" x={boundsX + boundsWidth - 6} y={boundsY + boundsHeight - 6} width={12} height={12} vectorEffect="non-scaling-stroke" onPointerDown={interactive ? (event) => onStart(event, "scale", "uniform") : undefined} pointerEvents="all" />
            <rect className="gizmo-corner" x={boundsX - 6} y={boundsY + boundsHeight - 6} width={12} height={12} vectorEffect="non-scaling-stroke" onPointerDown={interactive ? (event) => onStart(event, "scale", "uniform") : undefined} pointerEvents="all" />
          </>
        ) : null}
      </g>

      {tool === "path-selection" ? (
        <g>
          <line className="gizmo-guide" x1={pivot.x} y1={pivot.y} x2={rotationKnob.x} y2={rotationKnob.y} />
          <circle
            className="gizmo-handle rotation-handle"
            cx={rotationKnob.x}
            cy={rotationKnob.y}
            r={11}
            onPointerDown={interactive ? (event) => onStart(event, "rotate", "free") : undefined}
          />
        </g>
      ) : null}

      {tool === "move" ? (
        <g className="move-gizmo">
          <line className="gizmo-axis axis-x" x1={pivot.x} y1={pivot.y} x2={xEnd.x} y2={xEnd.y} />
          <line className="gizmo-axis axis-y" x1={pivot.x} y1={pivot.y} x2={yEnd.x} y2={yEnd.y} />
          {supportsDepthPosition(object) ? (
            <line className="gizmo-axis axis-z" x1={pivot.x} y1={pivot.y} x2={zEnd.x} y2={zEnd.y} />
          ) : null}
          <circle
            className="gizmo-handle axis-x"
            cx={xEnd.x}
            cy={xEnd.y}
            r={10}
            onPointerDown={interactive ? (event) => onStart(event, "move", "x") : undefined}
          />
          {supportsDepthPosition(object) ? (
            <circle
              className="gizmo-handle axis-z"
              cx={zEnd.x}
              cy={zEnd.y}
              r={10}
              onPointerDown={interactive ? (event) => onStart(event, "move", "z") : undefined}
            />
          ) : null}
          <circle
            className="gizmo-handle axis-y"
            cx={yEnd.x}
            cy={yEnd.y}
            r={10}
            onPointerDown={interactive ? (event) => onStart(event, "move", "y") : undefined}
          />
          <rect
            className="gizmo-handle axis-free"
            x={pivot.x - 9}
            y={pivot.y - 9}
            width={18}
            height={18}
            onPointerDown={interactive ? (event) => onStart(event, "move", "free") : undefined}
          />
        </g>
      ) : null}

      {tool === "rotate" ? (
        <g className="rotate-gizmo">
          {supportsSpatialRotation(object) ? (
            <>
              <ellipse className="gizmo-rotation-ring axis-x" cx={pivot.x} cy={pivot.y} rx={rotationRadius * 0.3} ry={rotationRadius} onPointerDown={interactive ? (event) => onStart(event, "rotate", "x") : undefined} />
              <ellipse className="gizmo-rotation-ring axis-y" cx={pivot.x} cy={pivot.y} rx={rotationRadius} ry={rotationRadius * 0.3} onPointerDown={interactive ? (event) => onStart(event, "rotate", "y") : undefined} />
              <circle className="gizmo-rotation-ring axis-z" cx={pivot.x} cy={pivot.y} r={rotationRadius} onPointerDown={interactive ? (event) => onStart(event, "rotate", "z") : undefined} />
            </>
          ) : (
            <>
              <circle
                className="gizmo-rotation-ring"
                cx={pivot.x}
                cy={pivot.y}
                r={rotationRadius}
                onPointerDown={interactive ? (event) => onStart(event, "rotate", "free") : undefined}
              />
              <line className="gizmo-guide" x1={pivot.x} y1={pivot.y} x2={rotationKnob.x} y2={rotationKnob.y} />
              <circle
                className="gizmo-handle rotation-handle"
                cx={rotationKnob.x}
                cy={rotationKnob.y}
                r={11}
                onPointerDown={interactive ? (event) => onStart(event, "rotate", "free") : undefined}
              />
            </>
          )}
        </g>
      ) : null}

      {tool === "scale" ? (
        <g className="scale-gizmo">
          <line className="gizmo-axis axis-x" x1={pivot.x} y1={pivot.y} x2={scaleXEnd.x} y2={scaleXEnd.y} />
          <line className="gizmo-axis axis-y" x1={pivot.x} y1={pivot.y} x2={scaleYEnd.x} y2={scaleYEnd.y} />
          {supportsDepthScale(object) ? (
            <line className="gizmo-axis axis-z" x1={pivot.x} y1={pivot.y} x2={zEnd.x} y2={zEnd.y} />
          ) : null}
          <rect
            className="gizmo-handle scale-x"
            x={scaleXEnd.x - 10}
            y={scaleXEnd.y - 10}
            width={20}
            height={20}
            onPointerDown={interactive ? (event) => onStart(event, "scale", "x") : undefined}
          />
          <rect
            className="gizmo-handle scale-y"
            x={scaleYEnd.x - 10}
            y={scaleYEnd.y - 10}
            width={20}
            height={20}
            onPointerDown={interactive ? (event) => onStart(event, "scale", "y") : undefined}
          />
          {supportsDepthScale(object) ? (
            <rect
              className="gizmo-handle scale-z"
              x={zEnd.x - 10}
              y={zEnd.y - 10}
              width={20}
              height={20}
              onPointerDown={interactive ? (event) => onStart(event, "scale", "z") : undefined}
            />
          ) : null}
          <rect
            className="gizmo-handle scale-uniform"
            x={scaleUniformEnd.x - 11}
            y={scaleUniformEnd.y - 11}
            width={22}
            height={22}
            onPointerDown={interactive ? (event) => onStart(event, "scale", "uniform") : undefined}
          />
        </g>
      ) : null}

      {tool === "pivot" ? (
        <g
          className="pivot-gizmo"
          onPointerDown={interactive ? (event) => onStart(event, "pivot", "free") : undefined}
        >
          <circle className="gizmo-pivot-ring" cx={pivot.x} cy={pivot.y} r={16} />
          <line x1={pivot.x - 25} y1={pivot.y} x2={pivot.x + 25} y2={pivot.y} />
          <line x1={pivot.x} y1={pivot.y - 25} x2={pivot.x} y2={pivot.y + 25} />
          <circle className="gizmo-pivot-center" cx={pivot.x} cy={pivot.y} r={4} />
        </g>
      ) : (
        <g className="gizmo-anchor-marker" pointerEvents="none">
          <circle cx={pivot.x} cy={pivot.y} r={7} />
          <line x1={pivot.x - 12} y1={pivot.y} x2={pivot.x + 12} y2={pivot.y} />
          <line x1={pivot.x} y1={pivot.y - 12} x2={pivot.x} y2={pivot.y + 12} />
        </g>
      )}
    </g>
  );
}

function PenSegmentPreview({ object, cursor }: { object: Extract<SceneObject, { type: "shape" }>; cursor: Vec2 }) {
  const lastIndex = object.path.vertices.length - 1;
  const last = object.path.vertices[lastIndex];
  const out = object.path.outTangents[lastIndex] ?? { x: 0, y: 0 };
  const start = localToWorld(object, last);
  const control = localToWorld(object, { x: last.x + out.x, y: last.y + out.y });
  return (
    <path
      className="pen-live-preview"
      d={`M ${start.x} ${start.y} C ${control.x} ${control.y}, ${cursor.x} ${cursor.y}, ${cursor.x} ${cursor.y}`}
      pointerEvents="none"
    />
  );
}

function isHierarchyContainer(object: SceneObject): boolean {
  return object.type === "layer" || object.type === "group";
}

function supportsDepthPosition(object: SceneObject): boolean {
  return ["mesh", "light", "camera", "layer", "group"].includes(object.type);
}

function supportsSpatialRotation(object: SceneObject): boolean {
  return object.type === "mesh" || isHierarchyContainer(object);
}

function supportsDepthScale(object: SceneObject): boolean {
  return object.type === "mesh" || isHierarchyContainer(object);
}

function objectSvgTransform(object: SceneObject): string {
  const scaleX = object.scaleX ?? 1;
  const scaleY = object.scaleY ?? 1;
  const anchor = object.anchor ?? { x: 0, y: 0 };
  return `translate(${object.x} ${object.y}) rotate(${object.rotation}) scale(${scaleX} ${scaleY}) translate(${-anchor.x} ${-anchor.y})`;
}

function isCanvasCreationTool(tool: EditorTool): boolean {
  return tool === "horizontal-type"
    || tool === "vertical-type"
    || tool === "brush"
    || tool === "eyedropper"
    || tool === "rectangular-marquee"
    || tool === "elliptical-marquee";
}

function scenePathToLocal(object: SceneObject, path: BezierPath): BezierPath {
  const vectorToLocal = (vector: Vec2) => {
    const rotated = rotateVector(vector, -object.rotation);
    return {
      x: rotated.x / safeScale(object.scaleX ?? 1),
      y: rotated.y / safeScale(object.scaleY ?? 1)
    };
  };
  return {
    closed: path.closed,
    vertices: path.vertices.map((vertex) => worldToLocal(object, vertex)),
    inTangents: path.inTangents.map(vectorToLocal),
    outTangents: path.outTangents.map(vectorToLocal)
  };
}

function gradientCoordinateToWorld(
  object: SceneObject,
  value: Extract<ColorValue, { type: "linear-gradient" | "radial-gradient" }>,
  coordinate: Vec2
): Vec2 {
  return value.coordinateMode === "scene"
    ? coordinate
    : localToWorld(object, {
        x: coordinate.x * object.width,
        y: coordinate.y * object.height
      });
}

function gradientCoordinateFromWorld(
  object: SceneObject,
  value: Extract<ColorValue, { type: "linear-gradient" | "radial-gradient" }>,
  point: Vec2
): Vec2 {
  if (value.coordinateMode === "scene") return point;
  const local = worldToLocal(object, point);
  return {
    x: local.x / Math.max(1, object.width),
    y: local.y / Math.max(1, object.height)
  };
}

function bezierPathSvg(object: SceneObject, path: BezierPath): string {
  if (path.vertices.length === 0) return "";
  const points = path.vertices.map((vertex) => localToWorld(object, vertex));
  let result = `M ${points[0].x} ${points[0].y}`;
  const segments = path.closed ? points.length : points.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % points.length;
    const from = path.vertices[index];
    const to = path.vertices[next];
    const out = path.outTangents[index] ?? { x: 0, y: 0 };
    const inn = path.inTangents[next] ?? { x: 0, y: 0 };
    const controlOut = localToWorld(object, { x: from.x + out.x, y: from.y + out.y });
    const controlIn = localToWorld(object, { x: to.x + inn.x, y: to.y + inn.y });
    result += ` C ${controlOut.x} ${controlOut.y} ${controlIn.x} ${controlIn.y} ${points[next].x} ${points[next].y}`;
  }
  return path.closed ? `${result} Z` : result;
}

function localToWorld(object: SceneObject, point: Vec2): Vec2 {
  const anchor = object.anchor ?? { x: 0, y: 0 };
  const scaled = {
    x: (point.x - anchor.x) * (object.scaleX ?? 1),
    y: (point.y - anchor.y) * (object.scaleY ?? 1)
  };
  const rotated = rotateVector(scaled, object.rotation);
  return { x: object.x + rotated.x, y: object.y + rotated.y };
}

function worldToLocal(object: SceneObject, point: Vec2): Vec2 {
  const anchor = object.anchor ?? { x: 0, y: 0 };
  const unrotated = rotateVector({ x: point.x - object.x, y: point.y - object.y }, -object.rotation);
  const scaleX = safeScale(object.scaleX ?? 1);
  const scaleY = safeScale(object.scaleY ?? 1);
  return {
    x: anchor.x + unrotated.x / scaleX,
    y: anchor.y + unrotated.y / scaleY
  };
}

function localVectorToWorld(object: SceneObject, vector: Vec2): Vec2 {
  return rotateVector({
    x: vector.x * (object.scaleX ?? 1),
    y: vector.y * (object.scaleY ?? 1)
  }, object.rotation);
}

function worldVectorInObjectAxes(object: SceneObject, point: Vec2): Vec2 {
  return rotateVector({ x: point.x - object.x, y: point.y - object.y }, -object.rotation);
}

function rotateVector(vector: Vec2, degrees: number): Vec2 {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine
  };
}

function constrainMoveDelta(delta: Vec2, rotation: number, axis: TransformAxis, snapping: boolean): Vec2 {
  if (axis === "free" || axis === "uniform") return delta;
  const direction = rotateVector(axis === "x" ? { x: 1, y: 0 } : { x: 0, y: 1 }, rotation);
  let distance = delta.x * direction.x + delta.y * direction.y;
  if (snapping) distance = Math.round(distance / 10) * 10;
  return { x: direction.x * distance, y: direction.y * distance };
}

function normalizeRadians(value: number): number {
  let next = value;
  while (next > Math.PI) next -= Math.PI * 2;
  while (next < -Math.PI) next += Math.PI * 2;
  return next;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}

function snapAngle(value: number, snapping: boolean): number {
  return snapping ? Math.round(value / 15) * 15 : Math.round(value * 10) / 10;
}

function snapScale(value: number, snapping: boolean): number {
  const rounded = snapping ? Math.round(value * 20) / 20 : Math.round(value * 1000) / 1000;
  if (Math.abs(rounded) >= 0.01) return rounded;
  return rounded < 0 ? -0.01 : 0.01;
}

function roundTransformValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function safeScale(value: number): number {
  if (Math.abs(value) >= 0.0001) return value;
  return value < 0 ? -0.0001 : 0.0001;
}

function snapValue(value: number, snapping: boolean): number {
  if (!snapping) {
    return Math.round(value);
  }

  return Math.round(value / 10) * 10;
}
