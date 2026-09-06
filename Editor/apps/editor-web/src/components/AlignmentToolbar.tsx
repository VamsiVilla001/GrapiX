import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignHorizontalDistributeEnd,
  AlignHorizontalDistributeStart,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  AlignVerticalDistributeEnd,
  AlignVerticalDistributeStart,
  AlignVerticalSpaceAround,
  MoreHorizontal
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import {
  canAlign,
  canDistribute,
  type AlignEdge,
  type AlignReference,
  type DistributeMode
} from "../tools/alignment";
import { useAlignmentSelection } from "../store/useAlignmentSelection";

/**
 * Alignment and distribution, in the top bar after the existing controls.
 *
 * Every button's enabled state is derived from the live selection rather than from a click
 * handler that quietly no-ops: aligning one object to its own bounding box and distributing fewer
 * than three objects are both meaningless, and a button that looks available and does nothing is
 * how an operator learns to distrust a toolbar.
 *
 * The reference selector is what makes the same twelve buttons cover "line these up with each
 * other", "centre this on the canvas" and "bring everything to this one" — the Photoshop key
 * object — without three sets of controls.
 */

interface AlignAction {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  enabled: boolean;
}

const REFERENCE_LABELS: Record<AlignReference, string> = {
  selection: "Selection",
  canvas: "Canvas",
  "key-object": "Key object",
  parent: "Parent group"
};

export function AlignmentToolbar() {
  const { objectIds, keyObjectId, targets } = useAlignmentSelection();
  const alignSelection = useEditorStore((state) => state.alignSelection);
  const distributeSelection = useEditorStore((state) => state.distributeSelection);
  const reference = useUiStore((state) => state.alignReference);
  const setReference = useUiStore((state) => state.setAlignReference);

  const alignable = canAlign(targets, reference);
  const distributable = canDistribute(targets);

  const align = (edge: AlignEdge) => () => alignSelection(objectIds, edge, reference, keyObjectId);
  const distribute = (mode: DistributeMode) => () => distributeSelection(objectIds, mode);

  const alignActions: AlignAction[] = [
    { id: "align-left", label: "Align left edges", icon: <AlignStartVertical size={15} />, run: align("left"), enabled: alignable },
    { id: "align-center-x", label: "Align horizontal centres", icon: <AlignCenterVertical size={15} />, run: align("center-x"), enabled: alignable },
    { id: "align-right", label: "Align right edges", icon: <AlignEndVertical size={15} />, run: align("right"), enabled: alignable },
    { id: "align-top", label: "Align top edges", icon: <AlignStartHorizontal size={15} />, run: align("top"), enabled: alignable },
    { id: "align-center-y", label: "Align vertical centres", icon: <AlignCenterHorizontal size={15} />, run: align("center-y"), enabled: alignable },
    { id: "align-bottom", label: "Align bottom edges", icon: <AlignEndHorizontal size={15} />, run: align("bottom"), enabled: alignable }
  ];

  const distributeActions: AlignAction[] = [
    { id: "dist-left", label: "Distribute left edges", icon: <AlignHorizontalDistributeStart size={15} />, run: distribute("left"), enabled: distributable },
    { id: "dist-center-x", label: "Distribute horizontal centres", icon: <AlignHorizontalDistributeCenter size={15} />, run: distribute("center-x"), enabled: distributable },
    { id: "dist-right", label: "Distribute right edges", icon: <AlignHorizontalDistributeEnd size={15} />, run: distribute("right"), enabled: distributable },
    { id: "dist-top", label: "Distribute top edges", icon: <AlignVerticalDistributeStart size={15} />, run: distribute("top"), enabled: distributable },
    { id: "dist-center-y", label: "Distribute vertical centres", icon: <AlignVerticalDistributeCenter size={15} />, run: distribute("center-y"), enabled: distributable },
    { id: "dist-bottom", label: "Distribute bottom edges", icon: <AlignVerticalDistributeEnd size={15} />, run: distribute("bottom"), enabled: distributable }
  ];

  // Equal spacing is the one designers actually want most of the time — distributing centres
  // leaves uneven gaps as soon as the objects differ in size — so it stays visible rather than
  // going into the overflow.
  const spacingActions: AlignAction[] = [
    { id: "space-x", label: "Equal horizontal spacing", icon: <AlignHorizontalSpaceAround size={15} />, run: distribute("spacing-x"), enabled: distributable },
    { id: "space-y", label: "Equal vertical spacing", icon: <AlignVerticalSpaceAround size={15} />, run: distribute("spacing-y"), enabled: distributable }
  ];

  return (
    <div className="alignment-toolbar" role="toolbar" aria-label="Alignment and distribution">
      <select
        aria-label="Align relative to"
        className="align-reference"
        onChange={(event) => setReference(event.target.value as AlignReference)}
        title="What the selection aligns against"
        value={reference}
      >
        {(Object.keys(REFERENCE_LABELS) as AlignReference[]).map((value) => (
          <option key={value} value={value}>{REFERENCE_LABELS[value]}</option>
        ))}
      </select>

      <ToolbarGroup actions={alignActions} />
      <span className="topbar-divider" />
      <ToolbarGroup actions={spacingActions} />
      {/*
        Per-edge distribution is the lower-priority half of the set: it is what you reach for when
        equal spacing is not what you meant, so it collapses into the overflow first.
      */}
      <OverflowMenu actions={distributeActions} />
    </div>
  );
}

function ToolbarGroup({ actions }: { actions: AlignAction[] }) {
  return (
    <div className="alignment-group">
      {actions.map((action) => (
        <button
          aria-label={action.label}
          className="topbar-icon"
          disabled={!action.enabled}
          key={action.id}
          onClick={action.run}
          title={action.label}
          type="button"
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}

function OverflowMenu({ actions }: { actions: AlignAction[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    function closeOutside(event: globalThis.PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  const anyEnabled = actions.some((action) => action.enabled);

  return (
    <div className="alignment-overflow" ref={root}>
      <button
        aria-expanded={open}
        aria-label="More distribution options"
        className="topbar-icon"
        disabled={!anyEnabled}
        onClick={() => setOpen((current) => !current)}
        title="More distribution options"
        type="button"
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div className="alignment-overflow-menu" role="menu">
          {actions.map((action) => (
            <button
              disabled={!action.enabled}
              key={action.id}
              onClick={() => {
                action.run();
                setOpen(false);
              }}
              role="menuitem"
              type="button"
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
