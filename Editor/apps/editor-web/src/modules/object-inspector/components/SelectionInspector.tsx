import { NumberField, ParityNote } from "../../../components/inspectorFields";
import { useEditorStore } from "../../../store/editorStore";
import {
  BATCH_REFUSED,
  batchConstraint,
  batchGate,
  batchLabel,
  batchValue,
  batchableProperties,
  describeSelection,
  isBatchNumber,
  readBatchNumber
} from "../services/multiSelection";

/**
 * The Inspector when more than one object is selected.
 *
 * A separate component, deliberately: the single-object surface is unchanged, so nothing an author
 * already knows moves. What used to happen instead was worse than a missing feature — the panel showed
 * the **active** member's fields and wrote to it alone, so selecting twelve objects and typing an X
 * moved one of them with no indication that eleven had been ignored.
 *
 * Every decision here comes from `services/multiSelection`: which fields may be offered, whether a
 * value is shared or mixed, and whether a lock refuses the write. This component only draws the answer.
 */

/** Fields the panel knows how to draw, in the order an author reads them. */
const FIELD_ORDER: readonly string[] = [
  "x", "y", "zDepth", "width", "height",
  "rotation", "rotationX", "rotationY", "rotationZ",
  "scaleX", "scaleY", "scaleZ",
  "opacity", "strokeWidth",
  "fontSize", "lineHeight", "letterSpacing"
];

const LABELS: Readonly<Record<string, string>> = {
  x: "X",
  y: "Y",
  zDepth: "Position Z",
  width: "W",
  height: "H",
  rotation: "Rotate",
  rotationX: "Rotate X",
  rotationY: "Rotate Y",
  rotationZ: "Rotate Z",
  scaleX: "Scale X",
  scaleY: "Scale Y",
  scaleZ: "Scale Z",
  opacity: "Opacity",
  strokeWidth: "Stroke W",
  fontSize: "Font size",
  lineHeight: "Line height",
  letterSpacing: "Letter space"
};

export function SelectionInspector() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectIds = useEditorStore((state) => state.selectedObjectIds);
  const updateObjects = useEditorStore((state) => state.updateObjects);
  const beginHistory = useEditorStore((state) => state.beginHistory);
  const cancelHistory = useEditorStore((state) => state.cancelHistory);
  const commitHistory = useEditorStore((state) => state.commitHistory);
  // A scrub across a selection is still one undo step: the transaction spans the whole gesture, and
  // each pointer move writes through `updateObjects` inside it.
  const history = { onBeginEdit: beginHistory, onCancelEdit: cancelHistory, onCommitEdit: commitHistory };

  const objects = selectedObjectIds
    .map((id) => scene.objects.find((object) => object.id === id))
    .filter((object): object is NonNullable<typeof object> => Boolean(object));

  const summary = describeSelection(objects);
  const gate = batchGate(objects);
  const offered = batchableProperties(objects);
  const numericFields = FIELD_ORDER.filter((property) => offered.includes(property) && isBatchNumber(property));

  function setEverywhere(property: string, value: number) {
    if (!gate.allowed) return;
    updateObjects(gate.targetIds, { [property]: value }, batchLabel(LABELS[property] ?? property, gate.targetIds.length));
  }

  function setVisibility(visible: boolean) {
    if (!gate.allowed) return;
    updateObjects(
      gate.targetIds,
      { visible },
      `${visible ? "Show" : "Hide"} ${gate.targetIds.length} object${gate.targetIds.length === 1 ? "" : "s"}`
    );
  }

  /** Lock is the one command that must work *on* locked objects, or the gate can never be opened. */
  function setLocked(locked: boolean) {
    const ids = objects.map((object) => object.id);
    updateObjects(
      ids,
      { locked },
      `${locked ? "Lock" : "Unlock"} ${ids.length} object${ids.length === 1 ? "" : "s"}`
    );
  }

  return (
    <section aria-labelledby="inspector-selection-heading" className="inspector selection-inspector">
      <section aria-labelledby="inspector-selection-heading" className="field-section">
        <h3 id="inspector-selection-heading">Selection</h3>
        <p className="selection-count">
          <strong>{summary.count}</strong> objects selected
        </p>
        <p className="selection-breakdown">
          {summary.byType.map((entry) => `${entry.count} ${entry.type}`).join(" · ")}
        </p>
        <p className="selection-breakdown">
          {summary.visible} visible · {summary.hidden} hidden · {summary.locked} locked
        </p>
      </section>

      <section aria-labelledby="inspector-object-state-heading" className="field-section inspector-control-section">
        <h3 id="inspector-object-state-heading">Object state</h3>
        <div className="selection-commands">
          {/*
            Explicit commands rather than a tri-state toggle: with a mixed selection there is no
            "current" state to flip, and guessing one is how an author hides the half they meant to show.
          */}
          <button className="inspector-action-button" onClick={() => setVisibility(true)} type="button">
            Show all
          </button>
          <button className="inspector-action-button" onClick={() => setVisibility(false)} type="button">
            Hide all
          </button>
          <button className="inspector-action-button" onClick={() => setLocked(true)} type="button">
            Lock all
          </button>
          <button className="inspector-action-button" onClick={() => setLocked(false)} type="button">
            Unlock all
          </button>
        </div>
      </section>

      {!gate.allowed ? (
        <div className="field-section inspector-control-section">
          {/*
            A refusal, not a partial write. Writing the unlocked ten and skipping the locked two is a
            mutation the author cannot see the shape of, and their undo then takes back something else
            than what they think they did.
          */}
          <ParityNote>{gate.reason} Nothing has been changed.</ParityNote>
        </div>
      ) : null}

      {numericFields.length > 0 ? (
        <section aria-labelledby="inspector-shared-properties-heading" className="field-section two-column">
          <h3 id="inspector-shared-properties-heading">Shared properties</h3>
          {numericFields.map((property) => {
            const value = batchValue(objects, (object) => readBatchNumber(object, property));
            // The range, step and unit the whole selection agrees on. A single-object field reads the
            // same table, so "X" is labelled and stepped identically whether one object is selected
            // or twelve — it used to say "X (px)" for one and a bare "X" for a set.
            const constraint = batchConstraint(objects, property);
            const label = LABELS[property] ?? property;
            return (
              <NumberField {...history}
                disabled={!gate.allowed}
                key={property}
                label={constraint?.unit ? `${label} (${constraint.unit})` : label}
                max={constraint?.max}
                min={constraint?.min}
                mixedCount={value.kind === "mixed" ? value.count : undefined}
                onChange={(next) => setEverywhere(property, next)}
                step={constraint?.step ?? 1}
                value={value.kind === "same" ? value.value : 0}
              />
            );
          })}
        </section>
      ) : (
        <div className="field-section">
          <ParityNote>
            These objects share no property that means the same thing on all of them. Select objects of
            one kind to edit their shape, colour or type together.
          </ParityNote>
        </div>
      )}

      <section aria-labelledby="inspector-edited-one-at-time-heading" className="field-section">
        <h3 id="inspector-edited-one-at-time-heading">Edited one at a time</h3>
        <ul className="selection-refusals">
          {["name", "text", "path", "masks", "bindings", "animation"].map((property) => (
            <li key={property}>
              <strong>{property}</strong> — {BATCH_REFUSED[property]}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
