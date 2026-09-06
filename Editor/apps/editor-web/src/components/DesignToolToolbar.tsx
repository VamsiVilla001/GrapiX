import type { FontDefinition, FontFaceDefinition, SceneObject } from "@grapix/shared-types";
import {
  Brush,
  ChevronRight,
  CircleDashed,
  Crosshair,
  Edit3,
  Feather,
  MousePointer2,
  Move,
  PenLine,
  Pipette,
  RotateCw,
  Scaling,
  SquareDashed,
  Type,
  WholeWord
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PEN_SHAPE_FILL, PEN_SHAPE_STROKE, useEditorStore } from "../store/editorStore";
import {
  useUiStore,
  type EditorTool,
  type ToolGroup
} from "../store/uiStore";

interface ToolDescriptor {
  id: EditorTool;
  name: string;
  icon: ReactNode;
}

const TOOL_GROUPS: Record<ToolGroup, ToolDescriptor[]> = {
  selection: [
    { id: "path-selection", name: "Path Selection Tool", icon: <MousePointer2 size={15} /> },
    { id: "direct-selection", name: "Direct Selection Tool", icon: <Edit3 size={15} /> }
  ],
  type: [
    { id: "horizontal-type", name: "Horizontal Type Tool", icon: <Type size={15} /> },
    { id: "vertical-type", name: "Vertical Type Tool", icon: <WholeWord size={15} className="vertical-type-icon" /> }
  ],
  marquee: [
    { id: "rectangular-marquee", name: "Rectangular Marquee Tool", icon: <SquareDashed size={15} /> },
    { id: "elliptical-marquee", name: "Elliptical Marquee Tool", icon: <CircleDashed size={15} /> }
  ]
};

const SINGLE_TOOLS: ToolDescriptor[] = [
  { id: "select", name: "Object Selection Tool", icon: <MousePointer2 size={15} /> },
  { id: "move", name: "Move Tool", icon: <Move size={15} /> },
  { id: "rotate", name: "Rotate Tool", icon: <RotateCw size={15} /> },
  { id: "scale", name: "Scale Tool", icon: <Scaling size={15} /> },
  { id: "pivot", name: "Pivot Tool", icon: <Crosshair size={15} /> },
  { id: "pen", name: "Pen Tool", icon: <PenLine size={15} /> },
  { id: "feather", name: "Mask Feather Tool", icon: <Feather size={15} /> },
  { id: "brush", name: "Brush Tool", icon: <Brush size={15} /> },
  { id: "eyedropper", name: "Eyedropper Tool", icon: <Pipette size={15} /> }
];

export function DesignToolToolbar() {
  const activeTool = useUiStore((state) => state.activeTool);
  const setActiveTool = useUiStore((state) => state.setActiveTool);
  const lastGroupTool = useUiStore((state) => state.lastGroupTool);
  const [openGroup, setOpenGroup] = useState<ToolGroup | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeOutside(event: globalThis.PointerEvent) {
      const target = event.target;
      const insidePortal = target instanceof Element && Boolean(target.closest(".tool-flyout"));
      if (!rootRef.current?.contains(target as Node) && !insidePortal) setOpenGroup(null);
    }
    function closeEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenGroup(null);
    }
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeEscape);
    };
  }, []);

  return (
    <div className="design-tools" ref={rootRef}>
      <div className="tool-toggle" role="toolbar" aria-label="Drawing and editing tools">
        {/* Through the Feather tool, which belongs beside the pen: both edit a path's edge. */}
        {SINGLE_TOOLS.slice(0, 7).map((tool) => (
          <SingleToolButton active={activeTool === tool.id} key={tool.id} tool={tool} onSelect={setActiveTool} />
        ))}
        <GroupedToolButton
          activeTool={activeTool}
          group="selection"
          lastTool={lastGroupTool.selection}
          open={openGroup === "selection"}
          onOpen={() => setOpenGroup((current) => current === "selection" ? null : "selection")}
          onSelect={(tool) => { setActiveTool(tool); setOpenGroup(null); }}
        />
        <GroupedToolButton
          activeTool={activeTool}
          group="type"
          lastTool={lastGroupTool.type}
          open={openGroup === "type"}
          onOpen={() => setOpenGroup((current) => current === "type" ? null : "type")}
          onSelect={(tool) => { setActiveTool(tool); setOpenGroup(null); }}
        />
        {SINGLE_TOOLS.slice(7).map((tool) => (
          <SingleToolButton active={activeTool === tool.id} key={tool.id} tool={tool} onSelect={setActiveTool} />
        ))}
        <GroupedToolButton
          activeTool={activeTool}
          group="marquee"
          lastTool={lastGroupTool.marquee}
          open={openGroup === "marquee"}
          onOpen={() => setOpenGroup((current) => current === "marquee" ? null : "marquee")}
          onSelect={(tool) => { setActiveTool(tool); setOpenGroup(null); }}
        />
      </div>
    </div>
  );
}

function SingleToolButton(props: {
  active: boolean;
  tool: ToolDescriptor;
  onSelect: (tool: EditorTool) => void;
}) {
  return (
    <button
      aria-label={props.tool.name}
      className={`tool-button ${props.active ? "active" : ""}`}
      onClick={() => props.onSelect(props.tool.id)}
      title={props.tool.name}
      type="button"
    >
      {props.tool.icon}
    </button>
  );
}

function GroupedToolButton(props: {
  group: ToolGroup;
  lastTool: EditorTool;
  activeTool: EditorTool;
  open: boolean;
  onOpen: () => void;
  onSelect: (tool: EditorTool) => void;
}) {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [flyoutPosition, setFlyoutPosition] = useState({ left: 0, top: 0 });
  const options = TOOL_GROUPS[props.group];
  const shown = options.find((tool) => tool.id === props.lastTool) ?? options[0];
  const active = options.some((tool) => tool.id === props.activeTool);

  function cancelHold() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

  useLayoutEffect(() => {
    if (!props.open) return;
    const bounds = buttonRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = 220;
    setFlyoutPosition({
      left: Math.max(4, Math.min(window.innerWidth - width - 4, bounds.left)),
      top: Math.min(window.innerHeight - 80, bounds.bottom + 5)
    });
  }, [props.open]);

  return (
    <div className="tool-group-button">
      <button
        aria-label={shown.name}
        aria-expanded={props.open}
        className={`tool-button ${active ? "active" : ""}`}
        ref={buttonRef}
        onClick={() => {
          if (!props.open) props.onSelect(shown.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          cancelHold();
          props.onOpen();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          cancelHold();
          holdTimer.current = setTimeout(props.onOpen, 360);
        }}
        onPointerLeave={cancelHold}
        onPointerUp={cancelHold}
        title={shown.name}
        type="button"
      >
        {shown.icon}
      </button>
      <button
        aria-label={`Open ${groupLabel(props.group)} tools`}
        aria-expanded={props.open}
        className="tool-flyout-indicator"
        onClick={props.onOpen}
        type="button"
      >
        <ChevronRight size={8} />
      </button>
      {props.open ? createPortal(
        <div
          className="tool-flyout"
          role="menu"
          aria-label={`${groupLabel(props.group)} tools`}
          style={{ left: flyoutPosition.left, top: flyoutPosition.top }}
        >
          {options.map((tool) => (
            <button
              aria-checked={props.activeTool === tool.id}
              className={props.activeTool === tool.id ? "active" : ""}
              key={tool.id}
              onClick={() => props.onSelect(tool.id)}
              role="menuitemradio"
              type="button"
            >
              {tool.icon}
              <span>{tool.name}</span>
            </button>
          ))}
        </div>,
        document.body
      ) : null}
    </div>
  );
}

function groupLabel(group: ToolGroup): string {
  if (group === "selection") return "Selection";
  if (group === "type") return "Type";
  return "Marquee";
}

export function ToolOptionsBar() {
  const activeTool = useUiStore((state) => state.activeTool);
  const brush = useUiStore((state) => state.brushOptions);
  const typeOptions = useUiStore((state) => state.typeOptions);
  const penOptions = useUiStore((state) => state.penOptions);
  const penTarget = useUiStore((state) => state.penTarget);
  const marquee = useUiStore((state) => state.marqueeOptions);
  const eyedropper = useUiStore((state) => state.eyedropperOptions);
  const foreground = useUiStore((state) => state.foregroundColor);
  const updatePenOptions = useUiStore((state) => state.updatePenOptions);
  const updateBrush = useUiStore((state) => state.updateBrushOptions);
  const updateMarquee = useUiStore((state) => state.updateMarqueeOptions);
  const updateEyedropper = useUiStore((state) => state.updateEyedropperOptions);
  const updateTypeOptions = useUiStore((state) => state.updateTypeOptions);
  const setMarqueeSelection = useUiStore((state) => state.setMarqueeSelection);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selected = useEditorStore((state) => state.scene.objects.find((object) => object.id === state.selectedObjectId));
  const sceneObjects = useEditorStore((state) => state.scene.objects);
  const projectFonts = useEditorStore((state) => state.scene.fonts ?? []);
  const updateObject = useEditorStore((state) => state.updateObject);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const addShapePoint = useEditorStore((state) => state.addShapePoint);
  const removeShapePoints = useEditorStore((state) => state.removeShapePoints);
  const setShapeAnchorKind = useEditorStore((state) => state.setShapeAnchorKind);
  const convertObjectToShape = useEditorStore((state) => state.convertObjectToShape);
  const closeShapePath = useEditorStore((state) => state.closeShapePath);
  const duplicateObject = useEditorStore((state) => state.duplicateObject);
  const deleteObject = useEditorStore((state) => state.deleteObject);
  const moveObjectInStack = useEditorStore((state) => state.moveObjectInStack);
  // The one selection. It used to read `uiStore.selectedPathObjectIds`, which the label still
  // called "paths" even though the marquee filled it with any object.
  const selectedPaths = useEditorStore((state) => state.selectedObjectIds);
  const selectObject = useEditorStore((state) => state.selectObject);
  const selectedAnchors = useUiStore((state) => state.selectedAnchorIndices);
  const setSelectedAnchors = useUiStore((state) => state.setSelectedAnchors);

  function applyTypePatch(patch: Partial<Extract<SceneObject, { type: "text" }>>) {
    if (selectedObjectId && selected?.type === "text") updateObject(selectedObjectId, patch);
  }

  /**
   * Set what the pen paints with.
   *
   * The option is remembered for the next path *and* applied to the one in hand, so toggling the
   * fill off mid-draw shows the outline immediately instead of only affecting the path after
   * this one. The selected shape is the path being drawn: the pen selects each shape as it
   * creates it.
   */
  function setPenPaint(patch: Partial<typeof penOptions>) {
    updatePenOptions(patch);
    if (selectedObjectId && selected?.type === "shape") updateObject(selectedObjectId, patch);
  }

  function chooseProjectFont(font: FontDefinition | undefined) {
    if (!font) {
      updateTypeOptions({ fontId: null });
      applyTypePatch({
        fontId: undefined,
        fontAssetId: undefined,
        fontFamily: "Inter, Arial, sans-serif",
        fallbackFamilies: ["Arial", "sans-serif"]
      });
      return;
    }
    const weight = selected?.type === "text" ? selected.fontWeight : typeOptions.fontWeight;
    const style = selected?.type === "text" ? selected.fontStyle ?? "normal" : typeOptions.fontStyle;
    const face = closestFontFace(font, weight, style);
    const patch = {
      fontId: font.fontId,
      fontFamily: font.family,
      fallbackFamilies: font.fallbackFamilies,
      fontWeight: String(face?.weight ?? 400),
      fontStyle: face?.style ?? "normal",
      fontAssetId: face?.source.kind === "file" ? face.source.assetId : undefined
    } satisfies Partial<Extract<SceneObject, { type: "text" }>>;
    updateTypeOptions({
      fontId: font.fontId,
      fontWeight: patch.fontWeight,
      fontStyle: patch.fontStyle
    });
    applyTypePatch(patch);
  }

  function alignPaths(axis: "x" | "y") {
    const objects = sceneObjects.filter((object) => selectedPaths.includes(object.id) && !object.locked);
    if (objects.length < 2) return;
    const target = axis === "x"
      ? Math.min(...objects.map((object) => object.x))
      : Math.min(...objects.map((object) => object.y));
    beginHistory("align paths");
    objects.forEach((object) => updateObject(object.id, axis === "x" ? { x: target } : { y: target }));
    commitHistory();
  }

  function distributePaths() {
    const objects = sceneObjects
      .filter((object) => selectedPaths.includes(object.id) && !object.locked)
      .sort((left, right) => left.x - right.x);
    if (objects.length < 3) return;
    const first = objects[0].x;
    const last = objects.at(-1)!.x;
    beginHistory("distribute paths");
    objects.slice(1, -1).forEach((object, index) => {
      updateObject(object.id, { x: first + (last - first) * (index + 1) / (objects.length - 1) });
    });
    commitHistory();
  }

  return (
    <div className="tool-options-bar" aria-label="Active tool options">
      <strong>{toolName(activeTool)}</strong>
      {activeTool === "path-selection" ? (
        <>
          {/* "selected", not "paths": the marquee fills this with any object, and it is now the
              same selection the Object Manager shows. */}
          <span>{selectedPaths.length || (selected ? 1 : 0)} selected</span>
          <button disabled={selectedPaths.length < 2} onClick={() => alignPaths("x")} type="button">Align left</button>
          <button disabled={selectedPaths.length < 2} onClick={() => alignPaths("y")} type="button">Align top</button>
          <button disabled={selectedPaths.length < 3} onClick={distributePaths} type="button">Distribute</button>
          <button disabled={selectedPaths.length === 0} onClick={() => {
            beginHistory("duplicate paths");
            selectedPaths.forEach(duplicateObject);
            commitHistory();
          }} type="button">Duplicate</button>
          <button disabled={selectedPaths.length === 0} onClick={() => {
            beginHistory("delete paths");
            selectedPaths.forEach(deleteObject);
            commitHistory();
            selectObject(null);
          }} type="button">Delete</button>
          <button disabled={!selectedObjectId} onClick={() => selectedObjectId && moveObjectInStack(selectedObjectId, "front")} type="button">Bring to front</button>
          <button disabled={!selectedObjectId} onClick={() => selectedObjectId && moveObjectInStack(selectedObjectId, "back")} type="button">Send to back</button>
        </>
      ) : null}
      {activeTool === "direct-selection" ? (
        <>
          {selected?.type === "rect" || selected?.type === "ellipse" ? (
            <button onClick={() => selectedObjectId && convertObjectToShape(selectedObjectId)} type="button">Convert to editable path</button>
          ) : null}
          <button disabled={selected?.type !== "shape"} onClick={() => {
            if (selected?.type !== "shape") return;
            addShapePoint(selected.id, selectedAnchors.at(-1) ?? selected.path.vertices.length - 1);
          }} type="button">Add point</button>
          <button disabled={selected?.type !== "shape" || selectedAnchors.length === 0} onClick={() => {
            if (selected?.type !== "shape") return;
            removeShapePoints(selected.id, selectedAnchors);
            setSelectedAnchors([]);
          }} type="button">Delete point</button>
          {/*
            Corner and Smooth are the whole conversion. "Link handles" used to issue the identical
            call to Smooth — a button that could not do anything Smooth had not already done — and
            "Break handles" rewrote the outgoing handle from the anchor's neighbours, which changed
            the curve rather than breaking a link. Handle linkage is now read from the anchor's own
            geometry as it is dragged, so there is nothing left for a button to toggle.
          */}
          <button
            disabled={selected?.type !== "shape" || selectedAnchors.length === 0}
            onClick={() => {
              if (selected?.type === "shape") setShapeAnchorKind(selected.id, selectedAnchors, "corner");
            }}
            title="Remove both handles so the path turns sharply through this anchor"
            type="button"
          >
            Corner
          </button>
          <button
            disabled={selected?.type !== "shape" || selectedAnchors.length === 0}
            onClick={() => {
              if (selected?.type === "shape") setShapeAnchorKind(selected.id, selectedAnchors, "smooth");
            }}
            title="Give the anchor opposed handles so the curve runs smoothly through it; dragging one handle then moves the other"
            type="button"
          >
            Smooth
          </button>
          <button disabled={selected?.type !== "shape" || selected.path.closed} onClick={() => {
            beginHistory("close path");
            if (selected?.type === "shape") closeShapePath(selected.id);
            commitHistory();
          }} type="button">Close path</button>
          <button disabled={selected?.type !== "shape" || !selected.path.closed} onClick={() => {
            beginHistory("open path");
            if (selected?.type === "shape") updateObject(selected.id, { path: { ...selected.path, closed: false } });
            commitHistory();
          }} type="button">Open path</button>
        </>
      ) : null}
      {activeTool === "horizontal-type" || activeTool === "vertical-type" ? (
        <>
          <label>Font <select value={selected?.type === "text" ? selected.fontId ?? "" : typeOptions.fontId ?? ""} onChange={(event) => {
            chooseProjectFont(projectFonts.find((item) => item.fontId === event.target.value));
          }}>
            <option value="">System / unmanaged</option>
            {projectFonts.map((font) => <option disabled={font.enabled === false} key={font.fontId} value={font.fontId}>{font.displayName}</option>)}
          </select></label>
          <label>Size <input min={1} type="number" value={selected?.type === "text" ? selected.fontSize : typeOptions.fontSize} onChange={(event) => {
            const fontSize = event.target.valueAsNumber;
            if (!Number.isFinite(fontSize)) return;
            updateTypeOptions({ fontSize });
            applyTypePatch({ fontSize });
          }} /></label>
          <label>Weight <select value={selected?.type === "text" ? selected.fontWeight : typeOptions.fontWeight} onChange={(event) => {
            const fontWeight = event.target.value;
            updateTypeOptions({ fontWeight });
            applyTypePatch({ fontWeight });
            const fontId = selected?.type === "text" ? selected.fontId : typeOptions.fontId;
            const font = projectFonts.find((item) => item.fontId === fontId);
            const face = font ? closestFontFace(font, fontWeight, selected?.type === "text" ? selected.fontStyle ?? "normal" : typeOptions.fontStyle) : undefined;
            applyTypePatch({ fontAssetId: face?.source.kind === "file" ? face.source.assetId : undefined });
          }}><option>100</option><option>200</option><option>300</option><option>400</option><option>500</option><option>600</option><option>700</option><option>800</option><option>900</option></select></label>
          <label>Style <select value={selected?.type === "text" ? selected.fontStyle ?? "normal" : typeOptions.fontStyle} onChange={(event) => {
            const fontStyle = event.target.value as typeof typeOptions.fontStyle;
            updateTypeOptions({ fontStyle });
            applyTypePatch({ fontStyle });
            const fontId = selected?.type === "text" ? selected.fontId : typeOptions.fontId;
            const font = projectFonts.find((item) => item.fontId === fontId);
            const face = font ? closestFontFace(font, selected?.type === "text" ? selected.fontWeight : typeOptions.fontWeight, fontStyle) : undefined;
            applyTypePatch({ fontAssetId: face?.source.kind === "file" ? face.source.assetId : undefined });
          }}><option value="normal">Normal</option><option value="italic">Italic</option><option value="oblique">Oblique</option></select></label>
          <span>Fill {foreground.type === "solid" ? foreground.color : foreground.type}</span>
        </>
      ) : null}
      {activeTool === "pen" ? (
        <>
          <label>
            <input
              checked={penOptions.fillEnabled}
              onChange={(event) => setPenPaint({ fillEnabled: event.target.checked })}
              type="checkbox"
            />
            Fill
          </label>
          <label>
            <input
              checked={penOptions.strokeEnabled}
              onChange={(event) => setPenPaint({ strokeEnabled: event.target.checked })}
              type="checkbox"
            />
            Stroke
          </label>
          <span className="tool-option-swatch">
            <i style={{ background: PEN_SHAPE_FILL, opacity: penOptions.fillEnabled ? 1 : 0.25 }} />
            <i style={{ background: PEN_SHAPE_STROKE, opacity: penOptions.strokeEnabled ? 1 : 0.25 }} />
          </span>
          <span>{penTarget === "mask" ? "Drawing a mask" : "Drawing a shape"}</span>
          {penTarget === "shape" && selected?.type === "shape" ? (
            <span className="tool-option-hint">
              On the selected path: click the line to add a point, an anchor to remove it,
              Alt-click an anchor to switch corner ↔ tangent.
            </span>
          ) : null}
          {penTarget === "shape" && !penOptions.fillEnabled && !penOptions.strokeEnabled ? (
            <span className="tool-option-warning">
              With both off the path is invisible; it is still selectable in Object Manager.
            </span>
          ) : null}
        </>
      ) : null}
      {activeTool === "feather" ? <FeatherToolOptions /> : null}
      {activeTool === "brush" ? (
        <>
          <label>Mode <select value={brush.mode} onChange={(event) => updateBrush({ mode: event.target.value as typeof brush.mode })}>
            <option value="paint">Paint</option><option value="mask-paint">Mask paint</option>
            <option value="mask-erase">Erase mask</option><option value="mask-reveal">Reveal mask</option>
          </select></label>
          <NumericOption label="Size" min={1} max={500} value={brush.size} onChange={(size) => updateBrush({ size })} />
          <NumericOption label="Hardness" min={0} max={100} value={brush.hardness * 100} onChange={(value) => updateBrush({ hardness: value / 100 })} />
          <NumericOption label="Opacity" min={0} max={100} value={brush.opacity * 100} onChange={(value) => updateBrush({ opacity: value / 100 })} />
          <NumericOption label="Flow" min={0} max={100} value={brush.flow * 100} onChange={(value) => updateBrush({ flow: value / 100 })} />
          <NumericOption label="Spacing" min={1} max={500} value={brush.spacing * 100} onChange={(value) => updateBrush({ spacing: value / 100 })} />
          <NumericOption label="Roundness" min={1} max={100} value={brush.roundness * 100} onChange={(value) => updateBrush({ roundness: value / 100 })} />
          <NumericOption label="Angle" min={-180} max={180} value={brush.angle} onChange={(angle) => updateBrush({ angle })} />
          <NumericOption label="Smoothing" min={0} max={100} value={brush.smoothing * 100} onChange={(value) => updateBrush({ smoothing: value / 100 })} />
          <label>Blend <select value={brush.blendMode} onChange={(event) => updateBrush({ blendMode: event.target.value as typeof brush.blendMode })}>
            <option value="normal">Normal</option><option value="multiply">Multiply</option>
            <option value="screen">Screen</option><option value="add">Add</option>
            <option value="erase">Erase</option>
          </select></label>
          <span>Colour {foreground.type === "solid" ? foreground.color : foreground.type}</span>
        </>
      ) : null}
      {activeTool === "eyedropper" ? (
        <>
          <label>Sample <select value={eyedropper.sampleSize} onChange={(event) => updateEyedropper({ sampleSize: Number(event.target.value) as typeof eyedropper.sampleSize })}>
            <option value={1}>Point</option><option value={3}>Small average</option>
            <option value={5}>Medium average</option><option value={11}>Large average</option>
          </select></label>
          <label>Source <select value={eyedropper.source} onChange={(event) => updateEyedropper({ source: event.target.value as typeof eyedropper.source })}>
            <option value="composited">Composited scene</option><option value="active-layer">Active layer</option>
          </select></label>
          <label><input checked={eyedropper.applyToSelection} onChange={(event) => updateEyedropper({ applyToSelection: event.target.checked })} type="checkbox" /> Apply sampled colour</label>
          <label><input checked={eyedropper.copyGradient} onChange={(event) => updateEyedropper({ copyGradient: event.target.checked })} type="checkbox" /> Copy gradient style</label>
        </>
      ) : null}
      {activeTool === "rectangular-marquee" || activeTool === "elliptical-marquee" ? (
        <>
          <label>Mode <select value={marquee.mode} onChange={(event) => updateMarquee({ mode: event.target.value as typeof marquee.mode })}>
            <option value="objects">Object selection</option><option value="region">Region selection</option><option value="mask">Mask creation</option>
          </select></label>
          {marquee.mode !== "region" ? (
            <label>Operation <select value={marquee.operation} onChange={(event) => updateMarquee({ operation: event.target.value as typeof marquee.operation })}>
              <option value="new">New</option><option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option>
            </select></label>
          ) : null}
          {marquee.mode === "mask" ? (
            <NumericOption label="Feather" min={0} max={500} value={marquee.feather} onChange={(feather) => updateMarquee({ feather })} />
          ) : null}
          <label>Constraint <select value={marquee.constraint} onChange={(event) => updateMarquee({ constraint: event.target.value as typeof marquee.constraint })}>
            <option value="free">Free</option><option value="fixed-ratio">Fixed ratio</option><option value="fixed-size">Fixed size</option>
          </select></label>
          {marquee.constraint === "fixed-ratio" ? (
            <NumericOption label="Ratio" min={0.01} max={100} value={marquee.ratio} onChange={(ratio) => updateMarquee({ ratio })} />
          ) : null}
          {marquee.constraint === "fixed-size" ? (
            <>
              <NumericOption label="Width" min={1} max={10000} value={marquee.fixedWidth} onChange={(fixedWidth) => updateMarquee({ fixedWidth })} />
              <NumericOption label="Height" min={1} max={10000} value={marquee.fixedHeight} onChange={(fixedHeight) => updateMarquee({ fixedHeight })} />
            </>
          ) : null}
          <label><input checked={marquee.fromCenter} onChange={(event) => updateMarquee({ fromCenter: event.target.checked })} type="checkbox" /> From centre</label>
          {marquee.mode === "objects" ? (
            <label>Include <select value={marquee.objectContainment} onChange={(event) => updateMarquee({ objectContainment: event.target.value as typeof marquee.objectContainment })}>
              <option value="touching">Touching</option><option value="enclosed">Fully enclosed</option>
            </select></label>
          ) : null}
          <button onClick={() => setMarqueeSelection(null)} type="button">Clear selection</button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Feather and expansion for the mask under the Feather tool.
 *
 * It edits the mask the operator has selected in the Inspector, falling back to the object's
 * first mask, because a tool that silently picked a different mask than the one highlighted would
 * be worse than one that does nothing.
 */
function FeatherToolOptions() {
  const options = useUiStore((state) => state.featherOptions);
  const updateOptions = useUiStore((state) => state.updateFeatherOptions);
  const selectedMaskId = useUiStore((state) => state.selectedMaskId);
  const setSelectedMaskId = useUiStore((state) => state.setSelectedMaskId);
  const selected = useEditorStore((state) => state.scene.objects.find((object) => object.id === state.selectedObjectId));
  const updateMask = useEditorStore((state) => state.updateMask);
  const addRectMask = useEditorStore((state) => state.addRectMask);

  const masks = selected?.masks ?? [];
  const mask = masks.find((item) => item.id === selectedMaskId) ?? masks[0] ?? null;

  if (!selected) return <span>Select an object to feather its mask.</span>;

  if (!mask) {
    return (
      <>
        <span>{selected.name} has no mask.</span>
        <button onClick={() => setSelectedMaskId(addRectMask(selected.id))} type="button">
          Add a rectangular mask
        </button>
      </>
    );
  }

  const setFeather = (axis: "x" | "y", value: number) => {
    const next = Math.max(0, value);
    updateMask(selected.id, mask.id, {
      feather: options.linked
        ? { x: next, y: next }
        : { ...mask.feather, [axis]: next }
    });
  };

  return (
    <>
      <label>Mask <select value={mask.id} onChange={(event) => setSelectedMaskId(event.target.value)}>
        {masks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <NumericOption label="Feather X" min={0} max={500} value={mask.feather.x} onChange={(value) => setFeather("x", value)} />
      <NumericOption label="Feather Y" min={0} max={500} value={mask.feather.y} onChange={(value) => setFeather("y", value)} />
      <label><input checked={options.linked} onChange={(event) => updateOptions({ linked: event.target.checked })} type="checkbox" /> Link X/Y</label>
      <NumericOption
        label="Expansion"
        min={-500}
        max={500}
        value={mask.expansion}
        onChange={(expansion) => updateMask(selected.id, mask.id, { expansion })}
      />
      <span className="tool-option-hint">
        Drag on the canvas to feather; hold Shift to expand. Negative expansion contracts the mask.
      </span>
      {masks.length > 1 ? (
        <span className="tool-option-warning">
          {masks.length} masks on this object share one blur — the viewport feathers by the largest
          value, so per-mask feather is not yet independent.
        </span>
      ) : null}
    </>
  );
}

function NumericOption(props: { label: string; min: number; max: number; value: number; onChange: (value: number) => void }) {
  return <label>{props.label} <input min={props.min} max={props.max} type="number" value={Math.round(props.value * 100) / 100} onChange={(event) => props.onChange(event.target.valueAsNumber)} /></label>;
}

function toolName(tool: EditorTool): string {
  const grouped = Object.values(TOOL_GROUPS).flat().find((item) => item.id === tool);
  return grouped?.name ?? SINGLE_TOOLS.find((item) => item.id === tool)?.name ?? "Tool";
}

function closestFontFace(
  font: FontDefinition,
  weight: string,
  style: FontFaceDefinition["style"]
): FontFaceDefinition | undefined {
  const targetWeight = Number(weight) || 400;
  return [...font.faces].sort((left, right) => {
    const leftScore = Math.abs(left.weight - targetWeight) + (left.style === style ? 0 : 1_000);
    const rightScore = Math.abs(right.weight - targetWeight) + (right.style === style ? 0 : 1_000);
    return leftScore - rightScore;
  })[0];
}
