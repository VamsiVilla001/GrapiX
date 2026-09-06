import {
  getBindableFaces,
  getMaterialBindingId,
  isMaterialCompatibleWithFace,
  propertyStep,
  sampleChannel,
  type AnimatableProperty,
  type PropertyChannel,
  type ObjectMask,
  type SceneObject
} from "@grapix/shared-types";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  Clock3,
  Columns3,
  Diamond,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Lock,
  Pencil,
  Search,
  Trash2,
  Unlock
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  // React 19 removed the global `JSX` namespace; it is now exported from React itself.
  type JSX
} from "react";
import { sortObjectsForRender } from "../rendering/sceneMaterial";
import { computeRowWindowFromOffsets, rowOffsets } from "./rowWindow";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";
import { useUiStore } from "../store/uiStore";
import { capturePointer, releasePointer } from "../lib/pointerCapture";
import { useNumericGesture } from "../lib/numericGesture";
import {
  gestureForPointer,
  reduceObjectSelection,
  type ObjectSelectionGesture
} from "../store/objectSelection";
import {
  resolveDrop,
  type DropResolution
} from "../modules/object-manager/services/objectManagerDrop";
import { buildTreeRows, createLayerStacks, FIXED_COLUMNS, formatLayerName, type LayerStack, type TreeRow } from "../modules/object-manager/services/objectManagerTree";
import { reduceObjectManagerKey } from "../modules/object-manager/services/objectManagerKeymap";
import { resolveFocusTarget } from "../modules/object-manager/services/objectManagerFocus";
import { isTextEntryTarget } from "../lib/historyShortcut";
import { expandSearchMatches } from "../modules/object-manager/services/objectSearch";
import { useObjectManagerStore } from "../modules/object-manager/stores/objectManagerStore";
import {
  layerRenameError,
  objectRenameError
} from "../modules/object-manager/services/objectManagerNaming";
import { normalizeLayerId } from "../store/layerIds";
import { collectContainerSubtreeIds } from "../store/objectHierarchy";
import { bandAggregate, type BandAggregate } from "../modules/object-manager/services/objectManagerBands";
import {
  OBJECT_COLUMNS,
  columnProperty,
  isColumnAnimatable,
  isColumnSupported,
  readColumnValue,
  resolveColumns,
  toggleColumn,
  type ObjectColumnId
} from "./objectManagerColumns";
/** Width of one property column, and of the name column, in the grid template. */
const COLUMN_WIDTH_PX = 72;
const NAME_COLUMN_PX = 180;

/**
 * The height of each row kind, in pixels.
 *
 * These are the numbers `styles.css` pins the rows to, restated here because the windowing offsets
 * are a sum of them. The two must agree: a row taller than its entry here puts every offset below it
 * out, so the CSS carries a comment saying why the height is fixed rather than a minimum.
 */
const ROW_HEIGHT_BY_KIND: Record<TreeRow["kind"], number> = {
  band: 27,
  object: 29,
  mask: 27
};

/**
 * The drag type an object row carries.
 *
 * Distinct from `application/x-grapix-material` so the two gestures cannot be confused: a material
 * dragged onto a group still assigns a material, and an object dragged onto one reparents. Both
 * handlers test the type before doing anything, which is what keeps them from fighting.
 */
const OBJECT_DRAG_MIME = "application/x-grapix-objects";

/** The ids in an object drag, or null when this is not one. */
function readDraggedIds(event: DragEvent<HTMLElement>): string[] | null {
  const raw = event.dataTransfer.getData(OBJECT_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

/**
 * The scene's objects: hierarchy, layers, order, visibility and masks.
 *
 * The property columns beside the tree are **chosen**, not fixed. This panel used to render a
 * ten-column transform spreadsheet for every object — a table nobody picked, wide enough to
 * push the viewport aside, and duplicating the Object Inspector's Transform tab in full. The
 * columns are now an author's working set: none of them, three of them, or all ten, remembered
 * across re-docking, and re-sorted into catalogue order so the table reads the same every time.
 *
 * Detailed Properties/Materials/Text/Data Binding live in the Object Inspector dock, not here:
 * listing objects and editing one object are two jobs.
 */
export function ObjectManager() {
  const scene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const selectObject = useEditorStore((state) => state.selectObject);
  const selectedObjectIds = useEditorStore((state) => state.selectedObjectIds);
  const selectionAnchorId = useEditorStore((state) => state.objectSelectionAnchorId);
  const selectObjects = useEditorStore((state) => state.selectObjects);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const applyObjectDrop = useEditorStore((state) => state.applyObjectDrop);
  const cancelHistory = useEditorStore((state) => state.cancelHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  const duplicateObject = useEditorStore((state) => state.duplicateObject);
  const deleteObject = useEditorStore((state) => state.deleteObject);
  const updateObject = useEditorStore((state) => state.updateObject);
  const assignMaterialToFaces = useEditorStore((state) => state.assignMaterialToFaces);
  const moveObjectInStack = useEditorStore((state) => state.moveObjectInStack);
  const duplicateSelectedObject = useEditorStore((state) => state.duplicateSelectedObject);
  const deleteSelectedObject = useEditorStore((state) => state.deleteSelectedObject);
  const createLayerForObject = useEditorStore((state) => state.createLayerForObject);
  const renameLayer = useEditorStore((state) => state.renameLayer);
  const renameObject = useEditorStore((state) => state.renameObject);
  const deleteLayer = useEditorStore((state) => state.deleteLayer);
  const setLayerVisibility = useEditorStore((state) => state.setLayerVisibility);
  const setLayerLocked = useEditorStore((state) => state.setLayerLocked);
  const setPropertyAnimationEnabled = useEditorStore((state) => state.setPropertyAnimationEnabled);
  const setAnimatedPropertyValue = useEditorStore((state) => state.setAnimatedPropertyValue);
  const addPropertyKeyframe = useEditorStore((state) => state.addPropertyKeyframe);
  const deletePropertyKeyframe = useEditorStore((state) => state.deletePropertyKeyframe);
  const updateMask = useEditorStore((state) => state.updateMask);
  const duplicateMask = useEditorStore((state) => state.duplicateMask);
  const deleteMask = useEditorStore((state) => state.deleteMask);
  // Deliberately **not** `useUiStore((state) => state.currentFrame)`. Subscribing here re-rendered
  // every row and every cell on every playhead tick, for a scene where one property might be
  // animated. The cells that display a channel subscribe for themselves; everything else reads the
  // frame only when the author acts.
  const frameNow = () => useUiStore.getState().currentFrame;
  const selectedMaskId = useUiStore((state) => state.selectedMaskId);
  const setSelectedMaskId = useUiStore((state) => state.setSelectedMaskId);
  const openedTemplate = useTemplateStore((state) =>
    state.templates.find((template) => template.templateId === state.openedTemplateId) ?? null
  );
  const storedColumns = useObjectManagerStore((state) => state.columns);
  const columnMode = useObjectManagerStore((state) => state.columnMode);
  const nameWidth = useObjectManagerStore((state) => state.nameWidth);
  const setNameWidth = useObjectManagerStore((state) => state.setNameWidth);
  const setColumnMode = useObjectManagerStore((state) => state.setColumnMode);
  const toggleStoredColumn = useObjectManagerStore((state) => state.toggleColumn);
  const setStoredColumns = useObjectManagerStore((state) => state.setColumns);
  // Collapse is session state now, not component state: re-docking the panel used to throw it away
  // while the columns beside it survived.
  const collapsedList = useObjectManagerStore((state) => state.collapsedIds);
  const toggleCollapsedId = useObjectManagerStore((state) => state.toggleCollapsed);
  const expandId = useObjectManagerStore((state) => state.expand);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  /**
   * The ids being dragged, in a ref rather than state.
   *
   * `dragover` needs them **synchronously**: it fires in its own event-loop turn but the resolver
   * runs inside the handler, and a state update from `dragstart` has not been applied yet the first
   * time it runs. Reading stale `[]` there resolved every first hover to `noop`, so the indicator
   * failed to appear until the pointer moved again — a gesture that feels broken for one frame.
   */
  const draggedIdsRef = useRef<string[]>([]);
  const nameResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ rowId: string; drop: DropResolution } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [materialDropTarget, setMaterialDropTarget] = useState<{ objectId: string; compatible: boolean } | null>(null);
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const collapsedIds = useMemo(() => new Set(collapsedList), [collapsedList]);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const layerStacks = useMemo(
    () => createLayerStacks(scene.objects, normalizedSearch),
    [normalizedSearch, scene.objects]
  );
  const [renamingObjectId, setRenamingObjectId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  /**
   * The active cell, and the rows it was resolved against.
   *
   * Session state, not persisted: a tab stop restored into a scene that has since changed is a tab
   * stop on a row that may not exist. `previousRowsRef` is what makes "nearest surviving row" mean
   * anything — after a delete the new list no longer contains the neighbours to search.
   */
  const activeCellRef = useRef<{ rowId: string; column: number } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const previousRowsRef = useRef<TreeRow[]>([]);
  /**
   * The scroller, and how much of the list it can show.
   *
   * Only the rows on screen are mounted, so the panel has to know where the viewport is. Measured
   * through a callback ref rather than an effect because the scroller is inside a conditional branch
   * — with no scene open this panel renders a placeholder and there is nothing to measure — and an
   * effect with `[]` deps would run once against a null ref and never retry.
   */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollObserverRef = useRef<ResizeObserver | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scrollObserverRef.current?.disconnect();
    scrollObserverRef.current = null;
    scrollerRef.current = element;
    if (!element) return;
    const measure = () => setViewport({ scrollTop: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    scrollObserverRef.current = observer;
  }, []);
  /**
   * A focus that is waiting for its row to be mounted.
   *
   * Arrow keys usually land inside the window, because the overscan is wider than one step. Home,
   * End and the page keys do not: they name a row that may be thousands of pixels away and therefore
   * not in the DOM at all. Those set this flag, scroll the row into view, and the post-commit pass
   * finishes the job once React has drawn it.
   */
  const pendingFocusRef = useRef(false);
  /** Where focus lands when no row can hold it: the panel's own heading, never another panel. */
  const captionRef = useRef<HTMLHeadingElement | null>(null);
  /**
   * Whether the author is working in this panel.
   *
   * Tracked by event rather than sampled, because the moment it matters is the moment the answer
   * becomes unreadable: deleting the focused row moves the caret to `body` before any effect runs.
   * A `focusout` with no `relatedTarget` is a node disappearing, not the author leaving.
   */
  const hadFocusRef = useRef(false);
  /**
   * The two id lists selection gestures need.
   *
   * `visibleRowIds` is what a Shift range spans: object rows in the order they are drawn, with a
   * collapsed group's descendants left out because the author cannot point at them. `selectableIds`
   * is every object the search matched, collapsed or not, which is what Ctrl+A takes — selecting
   * only what is visible and then deleting would orphan a collapsed child.
   */
  // Normalised on read: a persisted set from a build that had a column this one does not would
  // otherwise leave a permanent blank stripe down the grid.
  const columns = useMemo(
    () => resolveColumns(columnMode, storedColumns, scene.objects),
    [columnMode, scene.objects, storedColumns]
  );
  const treeRows = useMemo(
    () => buildTreeRows(layerStacks, collapsedIds, columns.length),
    [collapsedIds, columns.length, layerStacks]
  );
  const objectById = useMemo(
    () => new Map(scene.objects.map((object) => [object.id, object])),
    [scene.objects]
  );
  const layerById = useMemo(
    () => new Map(layerStacks.map((layer) => [layer.layerId, layer])),
    [layerStacks]
  );
  const visibleRowIds = useMemo(
    () => treeRows.filter((row) => row.kind === "object").map((row) => row.id),
    [treeRows]
  );
  /**
   * Two different numbers, and they are not interchangeable.
   *
   * `aria-rowindex` counts every row the panel draws, header included, because that is what a reader
   * announcing "row 9 of 40" is counting. The zebra counts *object* rows only — mask rows are
   * siblings in the DOM, so striping by position in the whole list inverts the pattern under every
   * object that owns a mask.
   */
  const ariaRowIndexById = useMemo(
    () => new Map(treeRows.map((row, index) => [row.id, index + 2])),
    [treeRows]
  );
  const stripeIndexById = useMemo(
    () => new Map(visibleRowIds.map((id, index) => [id, index])),
    [visibleRowIds]
  );
  const selectableIds = useMemo(
    () => layerStacks.flatMap((layer) => layer.objects.map((object) => object.id)),
    [layerStacks]
  );
  /**
   * Where every row sits, and which of them are worth drawing.
   *
   * A show-sized scene reaches thousands of rows and the panel can show forty. Mounting all of them
   * cost that on every selection change, and each row is a `treegrid` cell cluster with drag
   * handlers — the most expensive kind of row to build.
   *
   * The heights are per row *kind* rather than measured, and the CSS pins each kind to exactly these
   * numbers so the sum is the truth rather than an estimate. `rowIndexById` is what turns "focus this
   * row id" into "scroll to this pixel" for a row that is not currently in the DOM.
   */
  const rowIndexById = useMemo(
    () => new Map(treeRows.map((row, index) => [row.id, index])),
    [treeRows]
  );
  const rowOffsetTable = useMemo(
    () => rowOffsets(treeRows.map((row) => ROW_HEIGHT_BY_KIND[row.kind])),
    [treeRows]
  );
  const rowWindow = useMemo(
    () =>
      computeRowWindowFromOffsets({
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.height,
        offsets: rowOffsetTable,
        // Wider than one arrow step on purpose: a single Up/Down then lands on a row that is already
        // mounted, so the common case keeps the O(1) tab-stop patch and never waits for a commit.
        overscan: 8
      }),
    [rowOffsetTable, viewport.height, viewport.scrollTop]
  );
  const windowedRows = useMemo(
    () => treeRows.slice(rowWindow.first, rowWindow.last + 1),
    [rowWindow.first, rowWindow.last, treeRows]
  );
  const rowSpacers = useMemo(
    () => ({
      before: rowOffsetTable[Math.max(0, rowWindow.first)] ?? 0,
      after: (rowOffsetTable.at(-1) ?? 0) - (rowOffsetTable[Math.min(rowOffsetTable.length - 1, rowWindow.last + 1)] ?? 0)
    }),
    [rowOffsetTable, rowWindow.first, rowWindow.last]
  );
  /**
   * One pass over the scene for every band, not one per band per render.
   *
   * `bandAggregate` scans every object to answer "is this whole layer visible, is it locked, how many
   * objects are in it". The band row asked it once per band per render, so a 200-object scene with
   * three bands walked 600 objects to draw three headers.
   */
  const bandsByLayer = useMemo(() => {
    const map = new Map<string, BandAggregate>();
    for (const layer of layerStacks) map.set(layer.layerId, bandAggregate(scene.objects, layer.layerId));
    return map;
  }, [layerStacks, scene.objects]);
  /** The column catalogue by id: the header used to scan the list twice for every column it drew. */
  const columnById = useMemo(() => new Map(OBJECT_COLUMNS.map((entry) => [entry.id, entry])), []);
  /** Membership as a set: `includes` per row turned a 200-object selection into 40,000 comparisons. */
  const selectedIdSet = useMemo(() => new Set(selectedObjectIds), [selectedObjectIds]);
  const selectionCount = selectedObjectIds.length;

  /**
   * Keep the tab stop on something that exists — without ever taking the caret.
   *
   * Two halves, and the second is the one that matters. Resolving *where* the tab stop should go is
   * pure and runs on every row change. Actually moving focus happens only when the focus was already
   * inside this grid: a panel that pulls the caret because another panel deleted an object is a panel
   * that eats the author's typing from across the workspace.
   */
  useEffect(() => {
    const previousRows = previousRowsRef.current;
    previousRowsRef.current = treeRows;
    // Not `grid.contains(document.activeElement)`. By the time this runs the deleted row is gone and
    // the caret is already on `body`, so sampling the DOM here answers "no" for exactly the case that
    // needs a "yes" — the author was in the panel, and the thing they were standing on was removed.
    const hadFocus = hadFocusRef.current;
    const target = resolveFocusTarget({
      rows: treeRows,
      previousRowId: activeCellRef.current?.rowId ?? null,
      previousColumn: activeCellRef.current?.column ?? 0,
      previousRows,
      reason: hasActiveScene ? "rows-changed" : "scene-closed",
      hadFocus
    });
    if (!target.rowId) {
      activeCellRef.current = null;
      applyTabStop(false);
      // No row can hold the tab stop. The panel's own heading takes it, so a Tab after closing a
      // scene continues from here rather than from the top of the document.
      if (target.moveFocus) captionRef.current?.focus();
      return;
    }
    activeCellRef.current = { rowId: target.rowId, column: target.column };
    applyTabStop(target.moveFocus);
  }, [columns.length, hasActiveScene, treeRows]);

  /**
   * Put the tab stop back after every commit.
   *
   * The cells render `tabIndex={-1}` unconditionally, so any re-render — a scene edit, a selection, a
   * column change — wipes the promoted one. Re-asserting costs two node writes and removes the tab
   * stop from React's render path entirely, which is what makes a keystroke cost nothing.
   */
  useEffect(() => {
    applyTabStop(false);
  });

  /**
   * Run a command over the whole selection as one undo step.
   *
   * Ids are captured before the first call because the store reconciles the selection as objects
   * disappear — iterating the live array while deleting would stop after the first one.
   */
  function runOnSelection(label: string, command: (objectId: string) => void) {
    const ids = [...selectedObjectIds];
    if (ids.length === 0) return;
    beginHistory(ids.length > 1 ? `${label} ${ids.length} objects` : label);
    for (const id of ids) command(id);
    commitHistory();
  }

  /**
   * Hide everything the selection does not contain, as one undo step.
   *
   * A selected container's descendants stay visible with it: hiding the children of the group you
   * just isolated would defeat the point of isolating it.
   */
  function hideOthers() {
    if (selectedObjectIds.length === 0) return;
    const keep = new Set(selectedObjectIds.flatMap((id) => [...collectContainerSubtreeIds(scene.objects, id)]));
    const hiding = scene.objects.filter((object) => !keep.has(object.id) && object.visible);
    if (hiding.length === 0) return;
    beginHistory(`Hide ${hiding.length} other object${hiding.length === 1 ? "" : "s"}`, "scene-manager");
    for (const object of hiding) updateObject(object.id, { visible: false });
    commitHistory();
  }

  /** Show every hidden object, as one undo step. */
  function showAll() {
    const hidden = scene.objects.filter((object) => !object.visible);
    if (hidden.length === 0) return;
    beginHistory(`Show ${hidden.length} object${hidden.length === 1 ? "" : "s"}`, "scene-manager");
    for (const object of hidden) updateObject(object.id, { visible: true });
    commitHistory();
  }
  /** "Delete 3 objects" rather than "Delete selected object" — the count is the warning. */
  function commandTitle(verb: string, suffix: string): string {
    const subject = selectionCount > 1 ? `${selectionCount} objects` : "selected object";
    return `${verb} ${subject}${suffix ? ` ${suffix}` : ""}`.trim();
  }

  /**
   * Apply one selection gesture.
   *
   * The panel decides nothing about what a gesture means — that is the table in
   * `store/objectSelection.ts`. It only supplies the two id lists: what is visible, which a Shift
   * range spans, and what is selectable, which is what Ctrl+A takes.
   */
  function applyGesture(gesture: ObjectSelectionGesture) {
    const next = reduceObjectSelection(
      { selectedObjectIds, activeObjectId: selectedObjectId, anchorId: selectionAnchorId },
      gesture,
      { rows: visibleRowIds, all: selectableIds }
    );
    selectObjects(next.selectedObjectIds, { active: next.activeObjectId, anchor: next.anchorId });
  }

  /**
   * The panel's single tab stop, moved without re-rendering the panel.
   *
   * A grid with a tab stop per control is a grid you cannot leave: every icon button in every row used
   * to be tabbable, so reaching the panel *after* this one meant pressing Tab once per cell. One cell
   * holds `tabIndex={0}` and everything else `-1`, which is what makes the arrows load-bearing.
   *
   * The stop lives in a **ref and the DOM**, not in state, and this is the measured difference between
   * a usable keyboard and an unusable one. Driving it through React meant one arrow press re-rendered
   * every row and every cell to change one attribute: **85 ms per keystroke at 199 rows**, which is a
   * grid that visibly lags behind a held-down arrow key. Patching two nodes is O(1) and imperceptible.
   *
   * The cost of that choice is that React resets the attribute whenever it re-renders a row for its own
   * reasons, so `applyTabStop` is re-asserted after every commit — two node writes, not two hundred.
   */
  function applyTabStop(moveFocus: boolean) {
    const grid = gridRef.current;
    const active = activeCellRef.current;
    if (!grid) return;
    const previous = grid.querySelector<HTMLElement>('[data-cell][tabindex="0"]');
    const target = active ? resolveCell(grid, active.rowId, active.column) : null;
    if (previous && previous !== target) previous.tabIndex = -1;
    if (!target) {
      /*
        The row is in the list but not in the DOM, because only the window is mounted.
        
        Scroll it into view and remember that a focus is owed. The post-commit pass runs again once
        React has drawn the new window, and finishes the move then. Without this, Home / End / the
        page keys would move the *active cell* to a row the author cannot see and leave the caret
        behind on a row that is no longer the active one.
      */
      if (active && rowIndexById.has(active.rowId)) {
        if (moveFocus) pendingFocusRef.current = true;
        scrollRowIntoView(active.rowId);
      }
      return;
    }
    target.tabIndex = 0;
    if (moveFocus || pendingFocusRef.current) {
      pendingFocusRef.current = false;
      target.focus();
    }
  }

  /**
   * Bring a row inside the scroller, by arithmetic rather than by `scrollIntoView`.
   *
   * `scrollIntoView` needs the element, and the whole point here is that the element does not exist
   * yet. The offset table knows where the row would be, which is enough: scroll the minimum distance
   * that puts it fully inside the viewport, so a one-row step does not jump the list to centre it.
   */
  function scrollRowIntoView(rowId: string) {
    const scroller = scrollerRef.current;
    const index = rowIndexById.get(rowId);
    if (!scroller || index === undefined) return;
    const top = rowOffsetTable[index];
    const bottom = rowOffsetTable[index + 1] ?? top;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
  }

  /**
   * The cell a row/column names, or the row's last cell.
   *
   * Rows are not all the same width, and the column can outlive the cell it named — a mask row has no
   * property cells, and unticking a column leaves the index pointing past the end. Landing on the last
   * cell keeps the tab stop inside the grid instead of dropping it.
   */
  function resolveCell(grid: HTMLElement, rowId: string, column: number): HTMLElement | null {
    const row = grid.querySelector<HTMLElement>(`[data-row-id="${cssEscape(rowId)}"]`);
    if (!row) return null;
    const cells = row.querySelectorAll<HTMLElement>("[data-cell]");
    return row.querySelector<HTMLElement>(`[data-cell="${column}"]`) ?? cells[cells.length - 1] ?? null;
  }

  /** Move the caret to a cell, and take the tab stop with it. */
  function focusCell(rowId: string, column: number) {
    activeCellRef.current = { rowId, column };
    applyTabStop(true);
  }

  function moveTo(rowId: string, column: number) {
    focusCell(rowId, column);
  }

  /**
   * Every key this panel answers, routed through the pure keymap.
   *
   * The handler holds no opinions: it asks `reduceObjectManagerKey` what the keystroke means and does
   * that. `consumed` decides `preventDefault` separately from the intent, because a key can be ours
   * and still mean "do nothing" — End on the last cell must not scroll the panel away.
   */
  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    const editing = isTextEntryTarget(target) || renamingObjectId !== null || renamingLayerId !== null;
    const { intent, consumed } = reduceObjectManagerKey(
      {
        rows: treeRows,
        activeRowId: activeCellRef.current?.rowId ?? null,
        activeColumn: activeCellRef.current?.column ?? 0,
        editing
      },
      event
    );
    if (consumed) {
      event.preventDefault();
      event.stopPropagation();
    }

    switch (intent.kind) {
      case "move":
        moveTo(intent.rowId, intent.column);
        break;
      case "collapse":
      case "expand":
        toggleCollapsed(intent.rowId.startsWith("band:") ? intent.rowId.slice(5) : intent.rowId);
        break;
      case "select":
        applyGesture({ kind: "replace", id: intent.rowId });
        moveTo(intent.rowId, intent.column);
        break;
      case "extend":
        applyGesture({ kind: "range", id: intent.rowId });
        moveTo(intent.rowId, intent.column);
        break;
      case "toggleMember":
        applyGesture({ kind: "toggle", id: intent.rowId });
        moveTo(intent.rowId, intent.column);
        break;
      case "selectAll":
        applyGesture({ kind: "selectAll" });
        break;
      case "clearSelection":
        applyGesture({ kind: "clear" });
        break;
      case "toggleVisibility":
        toggleRowVisibility(intent.rowId);
        break;
      case "beginEdit":
        beginEditAt(intent.rowId, intent.column);
        break;
      case "delete":
        runOnSelection("Delete", deleteObject);
        break;
      default:
        break;
    }
  }

  /** Space is visibility, whatever kind of row is under it. */
  function toggleRowVisibility(rowId: string) {
    const row = treeRows.find((entry) => entry.id === rowId);
    if (!row) return;
    if (row.kind === "band") {
      setLayerVisibility(row.layerId, !(bandsByLayer.get(row.layerId)?.visible ?? false));
      return;
    }
    const object = objectById.get(row.objectId ?? "");
    if (!object) return;
    if (row.kind === "mask") {
      const mask = object.masks?.find((entry) => entry.id === row.maskId);
      if (mask) updateMask(object.id, mask.id, { visible: mask.visible === false });
      return;
    }
    updateObject(object.id, { visible: !object.visible });
  }

  /**
   * Enter and F2 mean "edit what is under me", which depends on the cell.
   *
   * On a name cell that is a rename draft; on a property cell it is the number. Anywhere else there is
   * nothing to edit and the key is spent rather than pretending.
   */
  function beginEditAt(rowId: string, column: number) {
    const row = treeRows.find((entry) => entry.id === rowId);
    if (!row) return;
    if (column === 0) {
      if (row.kind === "band") {
        setRenamingLayerId(row.layerId);
        setRenameValue(formatLayerName(row.layerId));
        setRenameError(null);
        return;
      }
      const object = objectById.get(row.objectId ?? "");
      if (object && row.kind === "object") beginObjectRename(object);
      return;
    }
    // A property cell's editor is its own input; handing it the caret is the whole gesture.
    const grid = gridRef.current;
    const cell = grid?.querySelector<HTMLElement>(`[data-row-id="${cssEscape(rowId)}"] [data-cell="${column}"]`);
    cell?.querySelector<HTMLInputElement>("input")?.focus();
  }

  /**
   * Turn a hover into a drop, **as the author sees it**.
   *
   * The result stays in screen terms — `before` means the line draws above the row — because that is
   * what the indicator renders. The translation to render order happens once, on the way into the
   * store (`inRenderOrder`), and doing it here instead drew the insertion line on the wrong edge:
   * hovering the top of a row promised a landing at its bottom.
   */
  function resolveRowDrop(event: DragEvent<HTMLElement>, rowId: string): DropResolution {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = box.height > 0 ? (event.clientY - box.top) / box.height : 0.5;
    return resolveDrop(scene.objects, draggedIdsRef.current, { kind: "object", id: rowId }, fraction);
  }

  /**
   * The same drop, in the order the store speaks.
   *
   * The grid draws each band reversed, topmost first, so what the author sees above a row is *later*
   * in render order. Exactly one place performs that flip.
   */
  function inRenderOrder(drop: DropResolution): DropResolution {
    if (drop.kind === "before") return { ...drop, kind: "after" };
    if (drop.kind === "after") return { ...drop, kind: "before" };
    return drop;
  }

  /** Apply a resolved drop, and make the result visible if it landed inside a closed group. */
  function commitDrop(event: DragEvent<HTMLElement>, drop: DropResolution) {
    const ids = readDraggedIds(event) ?? draggedIdsRef.current;
    setDropHint(null);
    setMaterialDropTarget(null);
    draggedIdsRef.current = [];
    if (ids.length === 0 || drop.kind === "noop" || drop.kind === "invalid") return;
    if (!applyObjectDrop(ids, inRenderOrder(drop))) return;
    // A move whose result you cannot see reads as a deletion.
    if (drop.kind === "into" && drop.targetId) {
      expandId(drop.targetId);
    }
  }

  /** Which indicator this row shows, if any. */
  function dropClassFor(rowId: string): string {
    if (dropHint?.rowId !== rowId) return "";
    switch (dropHint.drop.kind) {
      case "before": return "object-drop-before";
      case "after": return "object-drop-after";
      case "into":
      case "into-layer": return "object-drop-into";
      case "invalid": return "object-drop-invalid";
      default: return "";
    }
  }

  /**
   * Ticking a column in the picker adopts whatever is on screen and switches to `custom`.
   *
   * Editing from the *stored* set instead would make the first tick in "All properties" throw
   * away nine columns the author can see, which reads as the checkbox deleting the table.
   */
  function toggleColumnFromPicker(column: ObjectColumnId) {
    // Adopt what is on screen, not the stored set: the first tick in "All properties" would
    // otherwise appear to delete nine columns the author can see.
    setStoredColumns(toggleColumn(columns, column));
  }
  /**
   * The grid template, from the chosen columns.
   *
   * A CSS variable rather than a class per count: the rows, the header and the layer bands all
   * have to agree on the same template, and three stylesheets computing it independently is how
   * a header stops lining up with its body.
   */
  const gridTemplate = `${nameWidth}px 30px 30px 52px repeat(${columns.length}, ${COLUMN_WIDTH_PX}px)`;
  const gridMinWidth = nameWidth + 30 + 30 + 52 + columns.length * COLUMN_WIDTH_PX;
  const gridStyle = {
    "--object-grid-template": gridTemplate,
    "--object-grid-min-width": `${gridMinWidth}px`
  } as CSSProperties;

  useEffect(() => {
    if (!columnPickerOpen) return undefined;
    const close = (event: Event) => {
      if (!(event.target as HTMLElement | null)?.closest(".object-column-picker")) {
        setColumnPickerOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [columnPickerOpen]);

  /**
   * Commit a band rename, or refuse it inline.
   *
   * The collision is predictable *before* the write — `renameLayer` normalises the draft to a slug and
   * compares that — so the panel checks the same thing and refuses without a modal. The old path lied
   * twice and then blocked the app: the input was seeded with the raw slug while the band showed Title
   * Case, and the alert quoted the raw draft while the collision was decided on the normalised id, so
   * "Lower Third" collided with "lower third" and the message named neither culprit.
   */
  function commitLayerRename(layerId: string): boolean {
    const error = layerRenameError(scene.objects, layerId, renameValue);
    if (error) {
      setRenameError(error);
      return false;
    }
    if (renameValue.trim()) renameLayer(layerId, renameValue);
    setRenamingLayerId(null);
    setRenameValue("");
    setRenameError(null);
    return true;
  }

  function beginObjectRename(object: SceneObject) {
    setRenamingObjectId(object.id);
    setRenameValue(object.name);
    setRenameError(null);
  }

  function cancelObjectRename() {
    setRenamingObjectId(null);
    setRenameValue("");
    setRenameError(null);
  }

  /**
   * Commit an object rename, or hold the draft open with the reason.
   *
   * Blur commits, which is the convention the Inspector's name field already uses — deliberately not
   * the mask row's live input, which writes the scene on every keystroke. A draft that cannot be
   * committed keeps the field open rather than silently reverting: the author's typing is not thrown
   * away because it clashed.
   */
  function commitObjectRename(objectId: string): boolean {
    const error = objectRenameError(scene.objects, objectId, renameValue);
    if (error) {
      setRenameError(error);
      return false;
    }
    if (renameValue.trim()) renameObject(objectId, renameValue);
    cancelObjectRename();
    return true;
  }

  /**
   * The closures the rows call, behind one stable reference.
   *
   * Refreshed on every render and never re-identified, so `ObjectRow`'s props compare equal for the
   * rows that did not change. Building this as a plain object — or with `useMemo` over the state these
   * closures read — would hand every row a new prop on every keystroke and undo the memo.
   */
  const rowHandlers = useRef<ObjectRowHandlers>(null as unknown as ObjectRowHandlers);
  rowHandlers.current = {
    beginHistory,
    beginObjectRename,
    cancelHistory,
    cancelObjectRename,
    commitHistory,
    commitObjectRename,
    focusCell,
    onDragEnd: () => {
      draggedIdsRef.current = [];
      setDropHint(null);
    },
    onDragLeaveRow: (objectId) => {
      setMaterialDropTarget((value) => value?.objectId === objectId ? null : value);
      setDropHint((hint) => hint?.rowId === objectId ? null : hint);
    },
    onDragStartRow: (objectId, event) => {
      // The whole selection when the pressed row is part of it, otherwise just this row — the same
      // rule the Timeline uses for a key drag.
      const ids = selectedObjectIds.includes(objectId) ? selectedObjectIds : [objectId];
      event.dataTransfer.setData(OBJECT_DRAG_MIME, JSON.stringify(ids));
      event.dataTransfer.effectAllowed = "move";
      draggedIdsRef.current = ids;
    },
    onMaterialDragOver: (object, event) => {
      const materialId = event.dataTransfer.getData("application/x-grapix-material");
      const material = scene.materials.find((item) => item.materialId === materialId);
      const compatible = Boolean(
        material && getBindableFaces(object).some((face) =>
          isMaterialCompatibleWithFace(material, object, face.index)
        )
      );
      event.dataTransfer.dropEffect = compatible ? "copy" : "none";
      setMaterialDropTarget({ objectId: object.id, compatible });
    },
    onObjectDragOver: (objectId, event) => {
      const drop = resolveRowDrop(event, objectId);
      event.dataTransfer.dropEffect = drop.kind === "invalid" || drop.kind === "noop" ? "none" : "move";
      setDropHint({ rowId: objectId, drop });
    },
    onPointerSelect: (objectId, event) => {
      // Only the selection. Where the tab stop goes is settled by the focus the click produced, which
      // `onFocusCapture` adopts — deciding it a second time here is how the two drift apart.
      applyGesture(gestureForPointer(objectId, event));
    },
    onRenameDraft: (objectId, value) => {
      setRenameValue(value);
      setRenameError(objectRenameError(scene.objects, objectId, value));
    },
    onRowDrop: (object, event) => {
      const materialId = event.dataTransfer.getData("application/x-grapix-material");
      if (materialId) {
        const instanceId = event.dataTransfer.getData("application/x-grapix-material-instance");
        if (materialDropTarget?.objectId === object.id && materialDropTarget.compatible) {
          assignMaterialToFaces(
            object.id,
            getBindableFaces(object).map((face) => face.index),
            instanceId ? { materialId, instanceId } : materialId
          );
        }
        setMaterialDropTarget(null);
        return;
      }
      commitDrop(event, resolveRowDrop(event, object.id));
    },
    setAnimatedPropertyValue: (objectId, property, value) =>
      setAnimatedPropertyValue(objectId, property, value, frameNow()),
    setPropertyAnimationEnabled: (objectId, property, enabled) =>
      setPropertyAnimationEnabled(objectId, property, enabled, frameNow()),
    toggleCollapsed,
    toggleKeyAtFrame: (object, property) => {
      const frame = frameNow();
      const existing = object.animation?.[property]?.keys.find((key) => key.frame === frame);
      if (existing) deletePropertyKeyframe(object.id, property, existing.id);
      else addPropertyKeyframe(object.id, property, frame);
    },
    updateObject
  };
  /** Which material-drop indicator this row shows, if any. */
  function materialDropClassFor(objectId: string): string {
    if (materialDropTarget?.objectId !== objectId) return "";
    return materialDropTarget.compatible ? "material-drop-compatible" : "material-drop-blocked";
  }

  /** Collapse or expand a group or a band. Session state, so it survives a re-dock. */
  function toggleCollapsed(id: string) {
    toggleCollapsedId(id);
  }


  /**
   * A mask row. Its own function because it is its own row in the projection — the object renderer
   * used to build them inline, which is why nothing outside the walk could count them or land on one.
   */
  function renderMaskRow(row: TreeRow, object: SceneObject, mask: ObjectMask): JSX.Element {
    return (
          <div
            aria-level={row.level}
            aria-posinset={row.posInSet}
            aria-rowindex={ariaRowIndexById.get(row.id) ?? 1}
            aria-setsize={row.setSize}
            data-row-id={row.id}
            className={`scene-inspector-mask-row ${selectedMaskId === mask.id ? "selected" : ""}`}
            key={row.id}
            onClick={() => {
              selectObject(object.id);
              setSelectedMaskId(mask.id);
            }}
            role="row"
          >
            {/*
              Offset by half a level, not a whole one: a mask under a depth-0 object used to land on
              exactly the same 38px as a depth-2 object, so the two read as siblings.
            */}
            <div
              className="scene-object-tree-cell"
              data-cell="0"
              role="rowheader"
              style={{ paddingLeft: `${16 + row.depth * 15 + 7}px` }}
              tabIndex={-1}
            >
              <span className="scene-tree-disclosure-spacer" />
              <span className="object-type-badge type-mask">α Mask</span>
              <input
                aria-label="Mask name"
                className="scene-mask-name-input"
                onChange={(event) => updateMask(object.id, mask.id, { name: event.target.value })}
                tabIndex={-1}
                value={mask.name}
              />
            </div>
            <button
              className="scene-grid-icon-button"
              data-cell="1"
              onClick={(event) => {
                event.stopPropagation();
                updateMask(object.id, mask.id, { visible: mask.visible === false });
              }}
              title={mask.visible === false ? "Show mask" : "Hide mask"}
              role="gridcell"
              tabIndex={-1}
            >
              {mask.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <span
              aria-readonly
              className="scene-mask-lock-spacer"
              data-cell="2"
              role="gridcell"
              tabIndex={-1}
            />
            <div className="scene-mask-actions" data-cell="3" role="gridcell" tabIndex={-1}>
              <select
                aria-label="Mask mode"
                onChange={(event) => updateMask(object.id, mask.id, { mode: event.target.value as typeof mask.mode })}
                tabIndex={-1}
                value={mask.mode}
              >
                {["add", "subtract", "intersect", "lighten", "darken", "difference", "none"].map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </select>
              <button onClick={(event) => {
                event.stopPropagation();
                setSelectedMaskId(duplicateMask(object.id, mask.id));
              }} tabIndex={-1} title="Duplicate mask"><Copy size={11} /></button>
              <button onClick={(event) => {
                event.stopPropagation();
                deleteMask(object.id, mask.id);
                if (selectedMaskId === mask.id) setSelectedMaskId(null);
              }} tabIndex={-1} title="Delete mask"><Trash2 size={11} /></button>
            </div>
            {/*
              A mask has opacity, feather and expansion — not the object transform the columns
              describe. Borrowing those columns rendered "F 12" and "E 3" under headings that
              said X and Y, so the numbers read as positions. Its own values are named here, and
              the property columns stay empty because a mask has nothing to put in them.
            */}
            <div
              aria-colspan={Math.max(1, columns.length)}
              className="scene-mask-values"
              data-cell="4"
              role="gridcell"
              style={{ gridColumn: `span ${Math.max(1, columns.length)}` }}
              tabIndex={-1}
            >
              <label onClick={(event) => event.stopPropagation()}>
                <span>Alpha</span>
                <input
                  aria-label={`Mask ${mask.name} opacity`}
                  max={100}
                  min={0}
                  onChange={(event) => updateMask(object.id, mask.id, {
                    opacity: Math.min(1, Math.max(0, event.target.valueAsNumber / 100))
                  })}
                  tabIndex={-1}
                  type="number"
                  value={Math.round(mask.opacity * 100)}
                />
              </label>
              <span className="scene-mask-readout" title="Feather X and Y">
                Feather {Math.round(mask.feather.x)} / {Math.round(mask.feather.y)}
              </span>
              <span className="scene-mask-readout" title="Expansion">
                Expand {Math.round(mask.expansion)}
              </span>
            </div>
          </div>
    );
  }


  /**
   * A compositing band's header row.
   *
   * The wrapper this used to sit in is gone: it set a min-width every row already sets, and while it
   * existed the band's objects were nested inside it, so the grid's rows were not siblings and no
   * `aria-rowindex` over the panel could be true.
   */
  function renderBandRow(row: TreeRow, layer: LayerStack): JSX.Element {
    // Read from the whole band, not the search-filtered rows: the eye and the lock write every object
    // in the layer, so aggregating over what is on screen reported one thing and did another.
    const band = bandsByLayer.get(layer.layerId) ?? bandAggregate(scene.objects, layer.layerId);
    // The band accepts a drop anywhere along it: dropping on a layer means "take this out of whatever
    // group holds it and put it in this compositing layer", which has no before/after to choose.
    return (
      <div
        aria-expanded={row.expandable ? row.expanded : undefined}
        aria-level={row.level}
        aria-posinset={row.posInSet}
        aria-rowindex={ariaRowIndexById.get(row.id) ?? 1}
        aria-setsize={row.setSize}
        className={`scene-inspector-layer-row ${
          dropHint?.rowId === `layer:${layer.layerId}` ? dropClassFor(`layer:${layer.layerId}`) : ""
        }`}
        data-row-id={row.id}
        onDragLeave={() => setDropHint((hint) =>
          hint?.rowId === `layer:${layer.layerId}` ? null : hint
        )}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(OBJECT_DRAG_MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          const drop = resolveDrop(
            scene.objects,
            draggedIdsRef.current,
            { kind: "layer", id: layer.layerId },
            0.5
          );
          event.dataTransfer.dropEffect = drop.kind === "into-layer" ? "move" : "none";
          setDropHint({ rowId: `layer:${layer.layerId}`, drop });
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes(OBJECT_DRAG_MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          commitDrop(event, resolveDrop(
            scene.objects,
            draggedIdsRef.current,
            { kind: "layer", id: layer.layerId },
            0.5
          ));
        }}
        role="row"
      >
        <div
          className="scene-layer-tree-cell"
          data-cell="0"
          role="rowheader"
          tabIndex={-1}
        >
          {/* Was decoration: it looked like a disclosure control and had no handler. */}
          <button
            className="scene-tree-disclosure"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              toggleCollapsed(layer.layerId);
            }}
            title={!row.expanded ? `Expand ${formatLayerName(layer.layerId)}` : `Collapse ${formatLayerName(layer.layerId)}`}
          >
            {!row.expanded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          {renamingLayerId === layer.layerId ? (
            <span className="layer-rename-field">
              <input
                aria-invalid={Boolean(renameError)}
                aria-label={`Rename layer ${formatLayerName(layer.layerId)}`}
                autoFocus
                className={`layer-rename-input ${renameError ? "invalid" : ""}`}
                onBlur={() => commitLayerRename(layer.layerId)}
                onChange={(event) => {
                  setRenameValue(event.target.value);
                  setRenameError(layerRenameError(scene.objects, layer.layerId, event.target.value));
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key !== "Enter" && event.key !== "Escape") return;
                  if (event.key === "Enter") {
                    // A refused rename holds the field open with its reason; focus stays in the draft.
                    if (!commitLayerRename(layer.layerId)) return;
                  } else {
                    setRenamingLayerId(null);
                    setRenameValue("");
                    setRenameError(null);
                  }
                  // A keyboard edit ends where it began, on the cell that owned it.
                  focusCell(row.id, 0);
                }}
                value={renameValue}
              />
              {/* The slug is what actually collides, so it is shown rather than implied. */}
              <span className={`layer-rename-hint ${renameError ? "invalid" : ""}`}>
                {renameError ?? `id: ${normalizeLayerId(renameValue) || layer.layerId}`}
              </span>
            </span>
          ) : (
            <strong>{formatLayerName(layer.layerId)}</strong>
          )}
          <span title={`${band.count} object${band.count === 1 ? "" : "s"} in this layer`}>{band.count}</span>
          <ToolbarButton
            icon={<Pencil size={11} />}
            tabIndex={-1}
            onClick={() => {
              setRenamingLayerId(layer.layerId);
              setRenameValue(formatLayerName(layer.layerId));
              setRenameError(null);
            }}
            title={`Rename ${formatLayerName(layer.layerId)}`}
          />
          {layer.layerId !== "main" ? (
            <ToolbarButton
              danger
              icon={<Trash2 size={11} />}
              onClick={() => deleteLayer(layer.layerId)}
              tabIndex={-1}
              title="Delete layer and move its objects to Main"
            />
          ) : null}
        </div>
        <ToolbarButton
          cellIndex={1}
          icon={band.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          onClick={() => setLayerVisibility(layer.layerId, !band.visible)}
          tabIndex={-1}
          title={band.visible ? "Hide layer" : "Show layer"}
        />
        <ToolbarButton
          cellIndex={2}
          icon={band.locked ? <Lock size={13} /> : <Unlock size={13} />}
          onClick={() => setLayerLocked(layer.layerId, !band.locked)}
          tabIndex={-1}
          title={band.locked ? "Unlock layer" : "Lock layer"}
        />
        <span
          aria-readonly
          className="scene-layer-status-spacer"
          data-cell="3"
          role="gridcell"
          tabIndex={-1}
        />
      </div>
    );
  }
  return (
    <section className="scene-inspector-panel">
      {/*
        Objects only. The property tabs that used to live here moved to the Object Inspector
        panel: listing objects and editing one object's properties are two jobs, and carrying
        both meant the panel was two products sharing a dock.
      */}
      {!hasActiveScene ? (
        <div className="empty-panel scene-empty-state">
          <strong>No scene open</strong>
          <span>Create or open a scene template to inspect its objects and properties.</span>
        </div>
      ) : (
        <div className="scene-inspector-object-view">
          {/*
            Which properties the table shows. A mode rather than a preset: in "Keyframed" a
            column appears the moment something animates that property and leaves when its last
            key goes, which a one-shot fill-in cannot do.
          */}
          <div className="object-manager-ribbon">
            <div className="object-property-filter" role="group" aria-label="Property columns">
              {/*
                Pressing the active mode releases it, back to the author's own columns. Without
                that the only way home from a mode is the picker, and a toggle you can enter but
                not leave is not a toggle.
              */}
              <button
                aria-pressed={columnMode === "all"}
                className={columnMode === "all" ? "active" : ""}
                onClick={() => setColumnMode(columnMode === "all" ? "custom" : "all")}
                title={columnMode === "all" ? "Back to your chosen columns" : "Show a column for every property"}
                type="button"
              >
                <Columns3 size={12} /><span>All properties</span>
              </button>
              <button
                aria-pressed={columnMode === "keyframed"}
                className={columnMode === "keyframed" ? "active" : ""}
                onClick={() => setColumnMode(columnMode === "keyframed" ? "custom" : "keyframed")}
                title={columnMode === "keyframed"
                  ? "Back to your chosen columns"
                  : "Show only properties something in this scene keyframes"}
                type="button"
              >
                <Diamond size={12} /><span>Keyframed</span>
              </button>
            </div>

            {columnMode === "custom" ? (
              <span className="object-ribbon-note">
                Custom · {columns.length} column{columns.length === 1 ? "" : "s"}
              </span>
            ) : null}

            {columnMode === "keyframed" && columns.length === 0 ? (
              <span className="object-ribbon-note warn">Nothing in this scene is keyframed yet</span>
            ) : null}
          </div>

          <div className="scene-inspector-toolbar">
            <div className="scene-order-controls" aria-label="Selected object stacking controls">
              {/*
                Every command acts on the whole selection, in one history transaction. A trash can
                that silently deletes one of four selected objects is worse than having no
                multi-selection at all, and four separate undo steps for one click is the same bug
                seen from the other side.
              */}
              <ToolbarButton
                disabled={selectionCount === 0}
                icon={<ArrowUpToLine size={14} />}
                onClick={() => runOnSelection("Bring to front", (id) => moveObjectInStack(id, "front"))}
                title={commandTitle("Bring", "to front")}
              />
              <ToolbarButton
                disabled={selectionCount === 0}
                icon={<ArrowUp size={14} />}
                onClick={() => runOnSelection("Move up", (id) => moveObjectInStack(id, "up"))}
                title={commandTitle("Move", "up")}
              />
              <ToolbarButton
                disabled={selectionCount === 0}
                icon={<ArrowDown size={14} />}
                onClick={() => runOnSelection("Move down", (id) => moveObjectInStack(id, "down"))}
                title={commandTitle("Move", "down")}
              />
              <ToolbarButton
                disabled={selectionCount === 0}
                icon={<ArrowDownToLine size={14} />}
                onClick={() => runOnSelection("Send to back", (id) => moveObjectInStack(id, "back"))}
                title={commandTitle("Send", "to back")}
              />
              <span className="scene-toolbar-separator" />
              <ToolbarButton
                disabled={selectionCount === 0}
                icon={<Layers size={14} />}
                onClick={() => runOnSelection("Move to a new layer", createLayerForObject)}
                title={commandTitle("Move", "to a new layer")}
              />
              <ToolbarButton
                disabled={selectionCount === 0}
                icon={<Copy size={14} />}
                onClick={() => runOnSelection("Duplicate", duplicateObject)}
                title={commandTitle("Duplicate", "")}
              />
              <ToolbarButton
                danger
                disabled={selectionCount === 0}
                icon={<Trash2 size={14} />}
                onClick={() => runOnSelection("Delete", deleteObject)}
                title={commandTitle("Delete", "")}
              />
              <span className="scene-toolbar-separator" />
              {/*
                Not solo. Solo would be either a scene field the renderers must honour, or a viewport
                filter the canvas has to compose — and the third option, writing `visible: false`
                across the scene while calling it a view state, corrupts the document and loses the
                author's real visibility on undo. These are honest visibility writes, one undo step
                each, which is most of the value with no new state.
              */}
              <ToolbarButton
                disabled={selectionCount === 0}
                icon={<EyeOff size={14} />}
                onClick={hideOthers}
                title={selectionCount > 1
                  ? `Hide everything except these ${selectionCount} objects`
                  : "Hide everything except the selected object"}
              />
              <ToolbarButton
                icon={<Eye size={14} />}
                onClick={showAll}
                title="Show every object in the scene"
              />
            </div>
            <label className="scene-inspector-search">
              <Search size={13} />
              <input
                aria-label="Search scene objects"
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Find object"
                value={searchTerm}
              />
            </label>

            <div className="object-column-picker">
              <button
                aria-expanded={columnPickerOpen}
                aria-haspopup="true"
                className={`scene-grid-icon-button column-picker-button ${columnMode === "custom" && columns.length ? "active" : ""}`}
                onClick={() => setColumnPickerOpen((open) => !open)}
                title="Choose exactly which property columns to show"
                type="button"
              >
                <Columns3 size={14} />
                <span>{columns.length}</span>
              </button>
              {columnPickerOpen ? (
                <div className="column-picker-popover" role="menu">
                  <div className="column-picker-heading">
                    <strong>Property columns</strong>
                    <span>Shown beside every object</span>
                  </div>
                  {OBJECT_COLUMNS.map((column) => (
                    <label className="column-picker-option" key={column.id}>
                      <input
                        checked={columns.includes(column.id)}
                        onChange={() => toggleColumnFromPicker(column.id)}
                        type="checkbox"
                      />
                      <span className="column-picker-label">{column.label}</span>
                      <span className="column-picker-description">{column.description}</span>
                    </label>
                  ))}
                  {/*
                    No "All" or "Animated" here — the ribbon toggle owns both, and as a live mode
                    rather than a set that is correct only until the next stopwatch is enabled.
                  */}
                  <div className="column-picker-actions">
                    <button
                      onClick={() => {
                        setStoredColumns([]);
                      }}
                      type="button"
                    >
                      Clear all
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/*
            The scene's name, as a heading rather than a row.
            It used to be the grid's first `role="row"` with a single cell in it, which made every
            row index off by one and offered a reader a row with no object in it. It names the
            collection, so it sits above the collection.
          */}
          <h3 className="scene-grid-caption" id="object-manager-caption" ref={captionRef} tabIndex={-1}>
            {openedTemplate
              ? `Template ${openedTemplate.shortLabel}: ${scene.name}`
              : `Scene: ${scene.name}`}
          </h3>
          {/*
            Panel-scoped, never on the document. A global Delete or Ctrl+A crossing panel ownership is
            the defect the house rule against it exists for; this listener only sees keys while focus is
            inside the grid. What each key *means* is not decided here — the handler asks
            `objectManagerKeymap` and does what it says, so the whole keyboard can be tested without a
            browser and no key can quietly mean two things.
          */}
          <div
            className="scene-grid-scroll"
            onScroll={(event) => {
              const element = event.currentTarget;
              setViewport({ scrollTop: element.scrollTop, height: element.clientHeight });
            }}
            ref={attachScroller}
            onBlurCapture={(event) => {
              const next = event.relatedTarget as HTMLElement | null;
              // No next target means the element under the caret was removed. The author has not gone
              // anywhere, so the panel keeps its claim and the focus resolver may act.
              if (!next) return;
              if (!gridRef.current?.contains(next)) hadFocusRef.current = false;
            }}
            onFocusCapture={(event) => {
              hadFocusRef.current = true;
              // The DOM is the authority on where the caret is, so the keymap's idea of the active cell
              // is adopted from it rather than tracked in parallel. Click a lock button or a property
              // cell and the next arrow key moves from *there* — without this the two drifted apart and
              // an arrow moved from wherever the keyboard had last been.
              const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
              const rowId = cell?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
              const column = Number(cell?.dataset.cell);
              if (!rowId || !Number.isInteger(column)) return;
              activeCellRef.current = { rowId, column };
              applyTabStop(false);
            }}
            onKeyDown={onGridKeyDown}
            // Not a tab stop. The grid's one tab stop is the active cell, and a focusable scroller
            // beside it would be a second one that swallows the first Tab into the panel.
            tabIndex={-1}
          >
            <div
              aria-colcount={FIXED_COLUMNS + columns.length}
              aria-label="Scene objects"
              aria-multiselectable
              aria-rowcount={treeRows.length + 1}
              className={`scene-property-grid ${columns.length ? "" : "no-columns"}`}
              ref={gridRef}
              // A `treegrid`, not a `table`: the rows nest, they expand and collapse, and they are
              // navigated with arrows. `table` claimed none of that and promised a static grid.
              role="treegrid"
              style={gridStyle}
            >
              <div aria-rowindex={1} className="scene-grid-header" role="row">
                {/*
                  The name heading carries the resize handle. At depth 6 the indent, the badge and the
                  disclosure control left a fixed 180px column about four characters for the name,
                  which is the width defect worth fixing — the 72px value cells are not.
                */}
                <div className="scene-grid-name-heading" role="columnheader">
                  <span>Object</span>
                  <span
                    aria-hidden="true"
                    className="scene-grid-name-resize"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      capturePointer(event.currentTarget, event.pointerId);
                      nameResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: nameWidth };
                    }}
                    onPointerMove={(event) => {
                      const resize = nameResizeRef.current;
                      if (!resize || resize.pointerId !== event.pointerId) return;
                      setNameWidth(resize.startWidth + (event.clientX - resize.startX));
                    }}
                    onPointerUp={(event) => {
                      if (nameResizeRef.current?.pointerId !== event.pointerId) return;
                      nameResizeRef.current = null;
                      releasePointer(event.currentTarget, event.pointerId);
                    }}
                    title="Drag to resize the name column"
                  />
                </div>
                <div role="columnheader" title="Visibility"><Eye size={14} /></div>
                <div role="columnheader" title="Lock"><Lock size={14} /></div>
                <div className="scene-grid-status-heading" role="columnheader" title="Material · Animation · Data binding">Status</div>
                {columns.map((column) => (
                  <div key={column} role="columnheader" title={columnById.get(column)?.description}>
                    {columnById.get(column)?.label}
                  </div>
                ))}
              </div>
              {scene.objects.length === 0 ? (
                <div className="scene-grid-empty">This scene contains no objects.</div>
              ) : null}
              {/* Standing in for the rows above the window, so the scrollbar measures the whole
                  list and not just the part that is mounted. Plain blocks: every row is its own
                  grid, so a spacer disturbs no column template. */}
              {rowSpacers.before > 0 ? <div aria-hidden="true" style={{ height: `${rowSpacers.before}px` }} /> : null}
              {windowedRows.map((row) => {
                if (row.kind === "band") {
                  const layer = layerById.get(row.layerId);
                  return layer ? renderBandRow(row, layer) : null;
                }
                const object = objectById.get(row.objectId ?? "");
                if (!object) return null;
                if (row.kind === "mask") {
                  const mask = object.masks?.find((entry) => entry.id === row.maskId);
                  return mask ? renderMaskRow(row, object, mask) : null;
                }
                return (
                  <ObjectRow
                    ariaRowIndex={ariaRowIndexById.get(row.id) ?? 1}
                    columns={columns}
                    dropClass={dropClassFor(object.id)}
                    dropIndent={dropHint?.rowId === object.id ? dropHint.drop.depth : null}
                    handlers={rowHandlers}
                    isActive={object.id === selectedObjectId}
                    isMember={selectedIdSet.has(object.id)}
                    key={row.id}
                    materialDropClass={materialDropClassFor(object.id)}
                    object={object}
                    rename={renamingObjectId === object.id ? { error: renameError, value: renameValue } : null}
                    row={row}
                    stripe={(stripeIndexById.get(object.id) ?? 0) % 2 === 1}
                  />
                );
              })}
              {rowSpacers.after > 0 ? <div aria-hidden="true" style={{ height: `${rowSpacers.after}px` }} /> : null}
              {layerStacks.length === 0 && scene.objects.length > 0 ? (
                <div className="scene-grid-empty">No objects match the current search.</div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * One object row's props, chosen so that a selection change invalidates two rows and not two hundred.
 *
 * Every value here is a primitive or a stable reference, which is what lets `memo` do its job. The
 * measured difference at 199 rows is **80 ms per arrow key against 0.4 ms**: with the row inlined in
 * the panel, selecting the next object rebuilt every row and all 1,390 cells to move one accent bar.
 *
 * `handlers` is a ref rather than an object of callbacks. The row calls into closures that need the
 * live scene and selection, and rebuilding those each render would change identity every time and
 * defeat the memo — the whole point. A ref's identity never changes and `.current` is always fresh.
 */
interface ObjectRowProps {
  ariaRowIndex: number;
  columns: readonly ObjectColumnId[];
  /** "" when nothing is being dropped here, else the indicator class the store's resolution earned. */
  dropClass: string;
  /** Indent depth of the drop indicator, or null when this row is not the drop target. */
  dropIndent: number | null;
  handlers: MutableRefObject<ObjectRowHandlers>;
  isActive: boolean;
  isMember: boolean;
  materialDropClass: string;
  object: SceneObject;
  /** The live draft, present only on the row being renamed. */
  rename: { value: string; error: string | null } | null;
  row: TreeRow;
  stripe: boolean;
}

/** The closures a row calls. Held in a ref so the row's props stay comparable. */
interface ObjectRowHandlers {
  beginHistory: (label: string) => void;
  beginObjectRename: (object: SceneObject) => void;
  cancelHistory: () => void;
  cancelObjectRename: () => void;
  commitHistory: () => void;
  commitObjectRename: (objectId: string) => boolean;
  focusCell: (rowId: string, column: number) => void;
  onDragEnd: () => void;
  onDragLeaveRow: (objectId: string) => void;
  onDragStartRow: (objectId: string, event: DragEvent<HTMLElement>) => void;
  onMaterialDragOver: (object: SceneObject, event: DragEvent<HTMLElement>) => void;
  onObjectDragOver: (objectId: string, event: DragEvent<HTMLElement>) => void;
  onPointerSelect: (objectId: string, event: ReactMouseEvent<HTMLElement>) => void;
  onRenameDraft: (objectId: string, value: string) => void;
  onRowDrop: (object: SceneObject, event: DragEvent<HTMLElement>) => void;
  setAnimatedPropertyValue: (objectId: string, property: AnimatableProperty, value: number) => void;
  setPropertyAnimationEnabled: (objectId: string, property: AnimatableProperty, enabled: boolean) => void;
  toggleCollapsed: (id: string) => void;
  toggleKeyAtFrame: (object: SceneObject, property: AnimatableProperty) => void;
  updateObject: (objectId: string, patch: Partial<SceneObject>) => void;
}
const ObjectRow = memo(function ObjectRow(props: ObjectRowProps): JSX.Element {
const { columns, handlers, isActive, isMember, object, rename, row } = props;
  // Read without allocating: `Object.values` and `Object.keys` built three throwaway arrays per
  // row per render, which at 200 rows is 600 arrays to light three dots.
  const hasMaterial = hasAnyMaterial(object);
  const hasBinding = hasAnyBinding(object);
  const hasAnimation = hasAnyAnimation(object);
  return (
    <div
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-level={row.level}
      aria-posinset={row.posInSet}
      aria-rowindex={props.ariaRowIndex}
      aria-selected={isMember}
      aria-setsize={row.setSize}
      data-row-id={row.id}
      className={`scene-inspector-object-row ${isMember ? "selected" : ""} ${
        isActive ? "active" : ""
      } ${props.materialDropClass} ${object.locked ? "locked" : ""} ${
        props.stripe ? "stripe" : ""
      } ${props.dropClass}`}
      style={props.dropIndent === null
        ? undefined
        : ({ "--object-drop-indent": `${8 + props.dropIndent * 15}px` } as CSSProperties)}
      onClick={(event) => {
        // Focus the grid so the panel-scoped Ctrl+A and Escape reach it: a clicked row is how an
        // author says "I am working in here", and neither key should act from another panel.
        event.currentTarget.closest<HTMLElement>(".scene-grid-scroll")?.focus();
        handlers.current.onPointerSelect(object.id, event);
      }}
      draggable={!object.locked}
      onDragEnd={() => {
        handlers.current.onDragEnd();
      }}
      onDragLeave={() => {
        handlers.current.onDragLeaveRow(object.id);
      }}
      onDragStart={(event) => {
        // The whole selection when the pressed row is part of it, otherwise just this row — the
        // same rule the Timeline uses for a key drag.
        handlers.current.onDragStartRow(object.id, event);
      }}
      onDragOver={(event) => {
        // Mime discrimination, on both sides. A material drag keeps its own meaning on this row and
        // never reparents; an object drag is never mistaken for a material.
        if (event.dataTransfer.types.includes("application/x-grapix-material")) {
          event.preventDefault();
          event.stopPropagation();
          handlers.current.onMaterialDragOver(object, event);
          return;
        }
        if (!event.dataTransfer.types.includes(OBJECT_DRAG_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        handlers.current.onObjectDragOver(object.id, event);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        handlers.current.onRowDrop(object, event);
      }}
      role="row"
    >
      <div
        className="scene-object-tree-cell"
        data-cell="0"
        role="rowheader"
        style={{ paddingLeft: `${8 + row.depth * 15}px` }}
        tabIndex={-1}
      >
        {/*
          Masks count as children. The condition used to be `children.length > 0`, so a group whose
          only contents were masks had no disclosure control — while the same collapsed flag hid
          those masks, making them unreachable.
        */}
        {row.expandable ? (
          <button
            className="scene-tree-disclosure"
            onClick={(event) => {
              event.stopPropagation();
              handlers.current.toggleCollapsed(object.id);
            }}
            tabIndex={-1}
            title={row.expanded ? "Collapse" : "Expand"}
          >
            {row.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="scene-tree-disclosure-spacer" />
        )}
        <span className={`object-type-badge type-${object.type}`} title={badgeTitle(object)}>
          {labelForType(object)}
        </span>
        {rename ? (
          <input
            aria-invalid={Boolean(rename.error)}
            aria-label={`Rename ${object.name}`}
            autoFocus
            className={`scene-object-name-input ${rename.error ? "invalid" : ""}`}
            onBlur={() => handlers.current.commitObjectRename(object.id)}
            onChange={(event) => handlers.current.onRenameDraft(object.id, event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key !== "Enter" && event.key !== "Escape") return;
              if (event.key === "Enter") {
                // A refused rename holds the field open with its reason, so focus stays in the draft.
                if (!handlers.current.commitObjectRename(object.id)) return;
              } else {
                handlers.current.cancelObjectRename();
              }
              // A keyboard edit ends where it began. The input is about to unmount, and without this
              // the tab stop goes with it — the next Tab restarts at the top of the document.
              handlers.current.focusCell(row.id, 0);
            }}
            title={rename.error ?? "Enter to rename, Escape to cancel"}
            value={rename.value}
          />
        ) : (
          <span
            className="scene-object-name"
            onDoubleClick={(event) => {
              event.stopPropagation();
              handlers.current.beginObjectRename(object);
            }}
            title={object.name}
          >
            {object.name}
          </span>
        )}
      </div>
      <button
        className="scene-grid-icon-button"
        data-cell="1"
        onClick={(event) => {
          event.stopPropagation();
          handlers.current.updateObject(object.id, { visible: !object.visible });
        }}
        role="gridcell"
        tabIndex={-1}
        title={object.visible ? "Hide object" : "Show object"}
      >
        {object.visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      {/*
        Status, spelled out. The previous M/K/P triplet needed its own legend to read, and a
        single letter cannot say whether a binding resolves — these carry their meaning in the
        title and in an accessible label instead of in a key the operator has to memorise.
      */}
      <button
        className="scene-grid-icon-button"
        data-cell="2"
        onClick={(event) => {
          event.stopPropagation();
          handlers.current.updateObject(object.id, { locked: !object.locked });
        }}
        role="gridcell"
        tabIndex={-1}
        title={object.locked ? `Unlock ${object.name}` : `Lock ${object.name}`}
      >
        {object.locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <div
        aria-readonly
        className="scene-object-status"
        data-cell="3"
        role="gridcell"
        tabIndex={-1}
      >
        <i
          aria-label={hasMaterial ? "Has a material" : "No material"}
          className={`status-dot material ${hasMaterial ? "on" : ""}`}
          title={hasMaterial ? "Material assigned" : "No material assigned"}
        />
        <i
          aria-label={hasAnimation ? "Animated" : "Not animated"}
          className={`status-dot animation ${hasAnimation ? "on" : ""}`}
          title={hasAnimation ? "Has animation keys" : "No animation"}
        />
        <i
          aria-label={hasBinding ? "Data bound" : "Not data bound"}
          className={`status-dot binding ${hasBinding ? "on" : ""}`}
          title={hasBinding ? "Bound to live data" : "No data binding"}
        />
      </div>
      {columns.map((column, index) => (
        <TransformCell
          cellIndex={FIXED_COLUMNS + index}
          column={column}
          key={column}
          object={object}
          rowId={row.id}
          tabIndex={-1}
          onBeginEdit={handlers.current.beginHistory}
          onCancelEdit={handlers.current.cancelHistory}
          onCommitEdit={handlers.current.commitHistory}
          // The playhead is read when the author acts, not subscribed to. That is what lets the
          // panel skip re-rendering on every frame while a keyframe still lands where the
          // playhead actually is.
          onSetAnimationEnabled={(property, enabled) =>
            handlers.current.setPropertyAnimationEnabled(object.id, property, enabled)
          }
          onSetValue={(property, value) =>
            handlers.current.setAnimatedPropertyValue(object.id, property, value)
          }
          onToggleKeyAtFrame={(property) => handlers.current.toggleKeyAtFrame(object, property)}
        />
      ))}
    </div>
  );
});
interface TransformCellProps {
  /** Position in the row, so the grid's arrows can land on this cell and find it again. */
  cellIndex: number;
  column: ObjectColumnId;
  object: SceneObject;
  onBeginEdit: (label: string) => void;
  onCancelEdit: () => void;
  onCommitEdit: () => void;
  onSetAnimationEnabled: (property: AnimatableProperty, enabled: boolean) => void;
  onSetValue: (property: AnimatableProperty, value: number) => void;
  rowId: string;
  tabIndex: number;
  onToggleKeyAtFrame: (property: AnimatableProperty) => void;
}

/**
 * One property cell.
 *
 * Split in two on purpose. The panel used to subscribe to `currentFrame` and hand it to every
 * cell, so one playhead tick re-rendered the whole tree — every row, every cell, for a scene where
 * perhaps one property is animated. Nothing above this line reads the frame now: a cell with no
 * channel has nothing that changes per frame and never subscribes, and a cell that *is* animated
 * subscribes on its own behalf. A still scene therefore costs nothing to scrub through.
 *
 * The frame is still needed to *act* — enabling a stopwatch adds a key at the playhead — and that
 * is read at click time from the store rather than by subscribing to it.
 */
const TransformCell = memo(function TransformCell(props: TransformCellProps) {
  const property = columnProperty(props.object, props.column);
  const supported = isColumnSupported(props.object, props.column);
  // Not the same question as support. Z-Pos is editable on a rect and un-animatable on one, so the
  // cell keeps its number and loses its stopwatch. A legacy channel on such a property is ignored
  // here exactly as `evaluatePropertyChannelsAtFrame` ignores it, so the cell reads what renders.
  const animatable = isColumnAnimatable(props.object, props.column);
  const channel = supported && animatable ? props.object.animation?.[property] : undefined;

  if (!supported) {
    return (
      <div
        aria-readonly
        className="scene-transform-cell unsupported"
        data-cell={props.cellIndex}
        role="gridcell"
        tabIndex={props.tabIndex}
        title={`${props.column} is resolved by Program for a ${props.object.type}`}
      >
        —
      </div>
    );
  }
  if (channel) {
    return <AnimatedTransformCell {...props} animatable channel={channel} property={property} />;
  }
  return (
    <TransformCellBody
      {...props}
      animatable={animatable}
      animated={false}
      hasKeyAtFrame={false}
      property={property}
      value={readColumnValue(props.object, props.column)}
    />
  );
});

/** The animated half: the only part of this panel that follows the playhead. */
function AnimatedTransformCell(props: TransformCellProps & {
  animatable: boolean;
  channel: PropertyChannel;
  property: AnimatableProperty;
}) {
  const currentFrame = useUiStore((state) => state.currentFrame);
  const value = sampleChannel(props.channel, currentFrame, {
    objectId: props.object.id,
    property: props.property
  }) ?? readColumnValue(props.object, props.column);

  return (
    <TransformCellBody
      {...props}
      animated
      hasKeyAtFrame={props.channel.keys.some((key) => key.frame === currentFrame)}
      keyFrameLabel={currentFrame}
      value={value}
    />
  );
}

function TransformCellBody(props: TransformCellProps & {
  animatable: boolean;
  animated: boolean;
  hasKeyAtFrame: boolean;
  keyFrameLabel?: number;
  property: AnimatableProperty;
  value: number;
}) {
  const displayValue = props.column === "opacity" ? props.value * 100 : props.value;
  /*
   * The step comes from the shared constraint table, not from this cell. It was decided here with an
   * inline `startsWith("scale") ? 0.01 : 0.1` while the Inspector's animated field defaulted to 1, so
   * the same drag on the same property moved an object ten times further in one panel than the other.
   * Opacity is the one conversion: stored 0..1, shown here as a percentage, so its step scales with it.
   */
  const storedStep = propertyStep(props.object.type, props.column);
  const scrubStep = props.column === "opacity" ? storedStep * 100 : storedStep;
  const setDisplayValue = (nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    props.onSetValue(props.property, props.column === "opacity" ? nextValue / 100 : nextValue);
  };

  /*
   * The gesture itself now lives in `lib/numericGesture`, shared with the Inspector's fields. It was
   * written here first and the Inspector had none of it — no scrub, no Shift-fine, and a history entry
   * per keystroke — so an author met two conventions for one act depending on which panel they used.
   */
  const gesture = useNumericGesture({
    label: `Edit ${props.column}`,
    onBeginEdit: props.onBeginEdit,
    onCancelEdit: props.onCancelEdit,
    onChange: setDisplayValue,
    onCommitEdit: props.onCommitEdit,
    step: scrubStep,
    value: displayValue
  });
  const scrubbing = gesture.scrubbing;

  return (
    <div
      className={`scene-transform-cell ${props.animated ? "animated" : ""} ${
        props.hasKeyAtFrame ? "has-key" : ""
      } ${props.animatable ? "" : "no-stopwatch"}`}
      data-cell={props.cellIndex}
      role="gridcell"
      tabIndex={props.tabIndex}
    >
      {props.animatable ? (
        <button
          aria-label={`${props.animated ? "Disable" : "Enable"} ${props.column} animation for ${props.object.name}`}
          className={`property-stopwatch ${props.animated ? "active" : ""}`}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            props.onSetAnimationEnabled(props.property, !props.animated);
          }}
          title={props.animated
            ? "Stopwatch active. Click to stop animating this property (removes its keys)."
            : "Enable animation and add a key at the playhead."}
        >
          <Clock3 size={10} />
        </button>
      ) : null}
      {props.animated ? (
        <button
          aria-label={`${props.hasKeyAtFrame ? "Remove" : "Add"} ${props.column} keyframe at frame ${props.keyFrameLabel} for ${props.object.name}`}
          className={`property-key-toggle ${props.hasKeyAtFrame ? "on" : ""}`}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleKeyAtFrame(props.property);
          }}
          title={props.hasKeyAtFrame
            ? `Remove keyframe at frame ${props.keyFrameLabel}`
            : `Add keyframe at frame ${props.keyFrameLabel}`}
        >
          <Diamond size={9} />
        </button>
      ) : null}
      <input
        aria-label={`${props.column} for ${props.object.name}`}
        className={scrubbing ? "scrubbing" : undefined}
        onBlur={gesture.handlers.onBlur}
        onChange={(event) => setDisplayValue(Number(event.target.value))}
        onClick={(event) => {
          event.stopPropagation();
          if (scrubbing) event.preventDefault();
        }}
        onFocus={gesture.handlers.onFocus}
        onKeyDown={gesture.handlers.onKeyDown}
        onPointerCancel={gesture.handlers.onPointerCancel}
        onPointerDown={gesture.handlers.onPointerDown}
        onPointerMove={gesture.handlers.onPointerMove}
        onPointerUp={gesture.handlers.onPointerUp}
        step={scrubStep}
        tabIndex={-1}
        // A 72px cell clips without an ellipsis, so `-1234.567` can read as a different number. The
        // exact value joins the hint rather than replacing it.
        title={[
          `${props.column}: ${displayValue}`,
          "Drag horizontally to adjust; Shift-drag for fine control. Click to type an exact value.",
          props.animatable
            ? null
            : `Program resolves ${props.column} when the scene is prepared, so a ${props.object.type} cannot animate it.`
        ].filter(Boolean).join(" · ")}
        type="number"
        value={roundDisplayValue(displayValue)}
      />
    </div>
  );
}

/**
 * A small icon button.
 *
 * `cellIndex` and `tabIndex` are optional because the same button is used in the toolbar, where it is
 * an ordinary tab stop, and inside a row, where it is a grid cell and the grid owns the tab order.
 */
function ToolbarButton(props: {
  icon: JSX.Element;
  title: string;
  cellIndex?: number;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  tabIndex?: number;
}) {
  return (
    <button
      className={`scene-toolbar-button ${props.danger ? "danger" : ""}`}
      data-cell={props.cellIndex}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      role={props.cellIndex === undefined ? undefined : "gridcell"}
      tabIndex={props.tabIndex}
      title={props.title}
    >
      {props.icon}
    </button>
  );
}

/**
 * Quote a row id for a selector.
 *
 * Object ids and band slugs are data, and `querySelector` reads them as syntax — an id with a colon
 * in it (every mask row: `objectId:maskId`) throws before it matches anything.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, (character) => `\\${character}`);
}

/**
 * The three status dots, answered without building an array.
 *
 * These run for every row on every render. `Object.values(...).some(...)` reads well and allocates a
 * whole array to look at one property; a `for...in` that returns early reads the same and allocates
 * nothing, which is the difference between 600 short-lived arrays per keystroke and none.
 */
function hasAnyMaterial(object: SceneObject): boolean {
  for (const slot in object.materialSlots) {
    if (object.materialSlots[slot]) return true;
  }
  return false;
}

function hasAnyBinding(object: SceneObject): boolean {
  for (const key in object.bindings) {
    void key;
    return true;
  }
  return false;
}

function hasAnyAnimation(object: SceneObject): boolean {
  const animation = object.animation;
  if (!animation) return false;
  for (const property in animation) {
    if (animation[property as AnimatableProperty]?.keys.length) return true;
  }
  return false;
}

function roundDisplayValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The full kind behind a clipped badge.
 *
 * A mesh kind is unbounded text in a 34px badge, so "cylinder" and "cube" both render as a few
 * characters. The badge shows what fits; the title says what it is.
 */
function badgeTitle(object: SceneObject): string {
  if (object.type === "mesh") return `Mesh: ${object.meshKind}`;
  if (object.type === "layer") return object.layerKind === "camera" ? "Camera layer" : "Layer";
  if (object.type === "light") return `${object.lightKind} light`;
  return object.type;
}

/**
 * The short badge on a row.
 *
 * Two entries were wrong. A layer object showed its bare `layerKind` — literally `object` or
 * `camera`, and that `camera` collided with a camera object's `Persp`/`Ortho`, so two different kinds
 * of row read the same. And `meshKind` is unbounded text in a 34px badge, so it is clipped here and
 * spelled out in the title (`badgeTitle`).
 */
function labelForType(object: SceneObject): string {
  switch (object.type) {
    case "text": return "Ab";
    case "rect": return "Box";
    case "ellipse": return "Ell";
    case "image": return "Img";
    case "line": return "Line";
    case "shape": return "Path";
    case "paint": return "Paint";
    case "mesh": return clipBadge(object.meshKind);
    case "light": return clipBadge(object.lightKind);
    case "camera": return object.cameraKind === "perspective" ? "Persp" : "Ortho";
    case "layer": return object.layerKind === "camera" ? "CamLyr" : "Layer";
    case "marker": return "Evt";
    case "group": return "Grp";
  }
}

/** Four characters is what the badge fits; the full kind lives in the row's title. */
function clipBadge(kind: string): string {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return label.length > 6 ? `${label.slice(0, 5)}…` : label;
}
