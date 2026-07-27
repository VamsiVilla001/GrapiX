import {
  Brush,
  ChevronRight,
  CircleDashed,
  Crosshair,
  Edit3,
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
import { useEditorStore } from "../store/editorStore";
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
        {SINGLE_TOOLS.slice(0, 6).map((tool) => (
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
        {SINGLE_TOOLS.slice(6).map((tool) => (
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
  const marquee = useUiStore((state) => state.marqueeOptions);
  const eyedropper = useUiStore((state) => state.eyedropperOptions);
  const foreground = useUiStore((state) => state.foregroundColor);
  const updateBrush = useUiStore((state) => state.updateBrushOptions);
  const updateMarquee = useUiStore((state) => state.updateMarqueeOptions);
  const updateEyedropper = useUiStore((state) => state.updateEyedropperOptions);
  const setMarqueeSelection = useUiStore((state) => state.setMarqueeSelection);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selected = useEditorStore((state) => state.scene.objects.find((object) => object.id === state.selectedObjectId));
  const sceneObjects = useEditorStore((state) => state.scene.objects);
  const updateObject = useEditorStore((state) => state.updateObject);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const addShapePoint = useEditorStore((state) => state.addShapePoint);
  const removeShapePoints = useEditorStore((state) => state.removeShapePoints);
  const setShapePointsSmooth = useEditorStore((state) => state.setShapePointsSmooth);
  const convertObjectToShape = useEditorStore((state) => state.convertObjectToShape);
  const closeShapePath = useEditorStore((state) => state.closeShapePath);
  const duplicateObject = useEditorStore((state) => state.duplicateObject);
  const deleteObject = useEditorStore((state) => state.deleteObject);
  const moveObjectInStack = useEditorStore((state) => state.moveObjectInStack);
  const selectedPaths = useUiStore((state) => state.selectedPathObjectIds);
  const selectedAnchors = useUiStore((state) => state.selectedAnchorIndices);
  const setSelectedAnchors = useUiStore((state) => state.setSelectedAnchors);

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
          <span>{selectedPaths.length || (selected ? 1 : 0)} paths</span>
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
          <button disabled={selected?.type !== "shape" || selectedAnchors.length === 0} onClick={() => {
            if (selected?.type === "shape") setShapePointsSmooth(selected.id, selectedAnchors, false);
          }} type="button">Corner</button>
          <button disabled={selected?.type !== "shape" || selectedAnchors.length === 0} onClick={() => {
            if (selected?.type === "shape") setShapePointsSmooth(selected.id, selectedAnchors, true, true);
          }} type="button">Smooth</button>
          <button disabled={selected?.type !== "shape" || selectedAnchors.length === 0} onClick={() => {
            if (selected?.type === "shape") setShapePointsSmooth(selected.id, selectedAnchors, true, true);
          }} type="button">Link handles</button>
          <button disabled={selected?.type !== "shape" || selectedAnchors.length === 0} onClick={() => {
            if (selected?.type === "shape") setShapePointsSmooth(selected.id, selectedAnchors, true, false);
          }} type="button">Break handles</button>
          <button disabled={selected?.type !== "shape" || selected.path.closed} onClick={() => {
            if (selected?.type === "shape") closeShapePath(selected.id);
          }} type="button">Close path</button>
          <button disabled={selected?.type !== "shape" || !selected.path.closed} onClick={() => {
            if (selected?.type === "shape") updateObject(selected.id, { path: { ...selected.path, closed: false } });
          }} type="button">Open path</button>
        </>
      ) : null}
      {activeTool === "horizontal-type" || activeTool === "vertical-type" ? (
        <>
          <label>Font <input value={selected?.type === "text" ? selected.fontFamily : "Inter"} onChange={(event) => {
            if (selectedObjectId && selected?.type === "text") updateObject(selectedObjectId, { fontFamily: event.target.value });
          }} /></label>
          <label>Size <input min={1} type="number" value={selected?.type === "text" ? selected.fontSize : 48} onChange={(event) => {
            if (selectedObjectId && selected?.type === "text") updateObject(selectedObjectId, { fontSize: event.target.valueAsNumber });
          }} /></label>
          <label>Weight <select value={selected?.type === "text" ? selected.fontWeight : "700"} onChange={(event) => {
            if (selectedObjectId && selected?.type === "text") updateObject(selectedObjectId, { fontWeight: event.target.value as "400" | "500" | "600" | "700" | "800" });
          }}><option>400</option><option>500</option><option>600</option><option>700</option><option>800</option></select></label>
          <span>Fill {foreground.type === "solid" ? foreground.color : foreground.type}</span>
        </>
      ) : null}
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
          <label>Operation <select value={marquee.operation} onChange={(event) => updateMarquee({ operation: event.target.value as typeof marquee.operation })}>
            <option value="new">New</option><option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option>
          </select></label>
          <NumericOption label="Feather" min={0} max={500} value={marquee.feather} onChange={(feather) => updateMarquee({ feather })} />
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
          <label><input checked={marquee.antiAlias} onChange={(event) => updateMarquee({ antiAlias: event.target.checked })} type="checkbox" /> Anti-alias</label>
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

function NumericOption(props: { label: string; min: number; max: number; value: number; onChange: (value: number) => void }) {
  return <label>{props.label} <input min={props.min} max={props.max} type="number" value={Math.round(props.value * 100) / 100} onChange={(event) => props.onChange(event.target.valueAsNumber)} /></label>;
}

function toolName(tool: EditorTool): string {
  const grouped = Object.values(TOOL_GROUPS).flat().find((item) => item.id === tool);
  return grouped?.name ?? SINGLE_TOOLS.find((item) => item.id === tool)?.name ?? "Tool";
}
