import type { ReactNode } from "react";
import { labelWithUnit, propertyConstraint, type SceneObjectType } from "@grapix/shared-types";
import { useNumericGesture } from "../lib/numericGesture";

/**
 * The primitive property controls the inspector panels are built from.
 *
 * The Inspector and the Properties sidebar each declared their own `TextField`, `NumberField`,
 * `ColorField` and `SelectField`. They were not identical — one `SelectField` could relabel its
 * options and the other could not — so the same property rendered differently depending on which
 * panel you opened it in. One definition, imported by both.
 */

export function TextField(props: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  /**
   * A line under the control saying where its value came from.
   *
   * A slot rather than a computed thing: these primitives know a label and a number, not an object or
   * a scene's data, and giving them a store dependency to answer "is this bound" would make every
   * field in the app depend on the binding system. The caller resolves it and passes the sentence.
   */
  sourceNote?: ReactNode;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.sourceNote}
    </label>
  );
}

/**
 * A number, or — across a selection whose values differ — nothing at all.
 *
 * `mixedCount` is what makes a batch edit honest. Showing the active object's value instead would
 * invent data: the author reads `120`, leaves the field alone, and the next unrelated edit writes 120
 * onto eleven objects that were never 120. So a mixed field is **empty**, says how many distinct values
 * it stands for, and reports `aria-invalid` so a screen reader hears something other than a blank box.
 * Typing a value is the only way to write one.
 */
export function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Number of distinct values across a selection. Absent means the value is shared. */
  mixedCount?: number;
  /**
   * Opens and closes a history transaction. Supply both and the field gains the Object Manager's
   * grammar: horizontal scrub, Shift for fine control, Enter to commit, Escape to revert, and one undo
   * step per gesture however many values it passes through. Omit them and it stays a plain input, which
   * is right for a control whose caller writes through its own transaction.
   */
  onBeginEdit?: (label: string) => void;
  /** Abandons the transaction, restoring the scene the edit began from. Escape's route. */
  onCancelEdit?: () => void;
  onCommitEdit?: () => void;
  onChange: (value: number) => void;
  /**
   * A line under the control saying where its value came from.
   *
   * A slot rather than a computed thing: these primitives know a label and a number, not an object or
   * a scene's data, and giving them a store dependency to answer "is this bound" would make every
   * field in the app depend on the binding system. The caller resolves it and passes the sentence.
   */
  sourceNote?: ReactNode;
}) {
  const mixed = typeof props.mixedCount === "number";
  const scrubbable = Boolean(props.onBeginEdit && props.onCommitEdit);
  const gesture = useNumericGesture({
    label: `Edit ${props.label}`,
    max: props.max,
    min: props.min,
    onBeginEdit: props.onBeginEdit ?? (() => {}),
    onCancelEdit: props.onCancelEdit ?? (() => {}),
    onChange: props.onChange,
    onCommitEdit: props.onCommitEdit ?? (() => {}),
    step: props.step ?? 1,
    value: props.value
  });
  return (
    <label className={`field ${mixed ? "field-mixed" : ""} ${scrubbable && gesture.scrubbing ? "scrubbing" : ""}`}>
      <span>{props.label}</span>
      <input
        type="number"
        aria-label={mixed ? `${props.label} — mixed, ${props.mixedCount} values` : undefined}
        disabled={props.disabled}
        min={props.min}
        max={props.max}
        placeholder={mixed ? `Mixed — ${props.mixedCount} values` : undefined}
        step={props.step ?? 1}
        value={mixed ? "" : props.value}
        onBlur={scrubbable ? gesture.handlers.onBlur : undefined}
        onChange={(event) => {
          // An empty field on a mixed selection means "still mixed", not zero.
          if (event.target.value === "") return;
          props.onChange(Number(event.target.value));
        }}
        onFocus={scrubbable ? gesture.handlers.onFocus : undefined}
        onKeyDown={scrubbable ? gesture.handlers.onKeyDown : undefined}
        onPointerCancel={scrubbable ? gesture.handlers.onPointerCancel : undefined}
        onPointerDown={scrubbable ? gesture.handlers.onPointerDown : undefined}
        onPointerMove={scrubbable ? gesture.handlers.onPointerMove : undefined}
        onPointerUp={scrubbable ? gesture.handlers.onPointerUp : undefined}
      />
      {props.sourceNote}
    </label>
  );
}

/**
 * A `NumberField` whose range, step and unit come from the shared constraint table rather than from
 * the call site.
 *
 * The defect this closes: twenty-odd call sites each restated a bound the table already declared —
 * `min={0.01}` for a mesh's depth, `min={1}` for a line height, and a label hand-written as `"Cone °"`
 * because the unit was typed rather than looked up. They drifted: a scale stepped by `0.05` here and
 * `0.01` in the Object Manager's grid for the same property, and W and H showed no unit while X and Y
 * showed `(px)`. One property, one range, one step, one unit, whichever control renders it.
 */
export function ConstrainedNumberField(props: {
  label: string;
  objectType: SceneObjectType;
  property: string;
  value: number;
  disabled?: boolean;
  mixedCount?: number;
  onBeginEdit?: (label: string) => void;
  /** Abandons the transaction, restoring the scene the edit began from. Escape's route. */
  onCancelEdit?: () => void;
  onCommitEdit?: () => void;
  onChange: (value: number) => void;
  /** Forwarded to the number field beneath, so a bound width says so like a bound x does. */
  sourceNote?: ReactNode;
}) {
  const constraint = propertyConstraint(props.objectType, props.property);
  return (
    <NumberField
      disabled={props.disabled}
      label={labelWithUnit(props.label, props.objectType, props.property)}
      max={constraint?.max}
      min={constraint?.min}
      mixedCount={props.mixedCount}
      onBeginEdit={props.onBeginEdit}
      onCancelEdit={props.onCancelEdit}
      onChange={props.onChange}
      onCommitEdit={props.onCommitEdit}
      sourceNote={props.sourceNote}
      step={constraint?.step ?? 1}
      value={props.value}
    />
  );
}

export function ToggleField(props: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  /**
   * A line under the control saying where its value came from.
   *
   * A slot rather than a computed thing: these primitives know a label and a number, not an object or
   * a scene's data, and giving them a store dependency to answer "is this bound" would make every
   * field in the app depend on the binding system. The caller resolves it and passes the sentence.
   */
  sourceNote?: ReactNode;
}) {
  return (
    <label className="field toggle-field">
      <span>{props.label}</span>
      <input
        type="checkbox"
        checked={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      {props.sourceNote}
    </label>
  );
}

export function ColorField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * A line under the control saying where its value came from.
   *
   * A slot rather than a computed thing: these primitives know a label and a number, not an object or
   * a scene's data, and giving them a store dependency to answer "is this bound" would make every
   * field in the app depend on the binding system. The caller resolves it and passes the sentence.
   */
  sourceNote?: ReactNode;
}) {
  const safeColor = props.value.startsWith("#") ? props.value : "#ffffff";

  return (
    <label className="field color-field">
      <span>{props.label}</span>
      <input type="color" value={safeColor} onChange={(event) => props.onChange(event.target.value)} />
      {props.sourceNote}
    </label>
  );
}

export function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  disabled?: boolean;
  renderOption?: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.options.map((option) => (
          <option value={option} key={option}>
            {props.renderOption ? props.renderOption(option) : option}
          </option>
        ))}
      </select>
      {/* No slot here: no bindable property is authored through a select. */}
    </label>
  );
}

/** A read-only value the inspector reports but nothing can edit here. */
export function ReadOnlyField(props: { label: string; value: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input readOnly value={props.value} />
      {/* No slot here: a read-only field reports a value it does not source. */}
    </label>
  );
}

/**
 * Says which renderers honour the fields beside it.
 *
 * Authoring a property the renderer ignores is the defect that made six of eight texture fit
 * modes draw as `stretch`. Where a control is genuinely Editor-only, the panel says so rather
 * than letting the operator find out on air.
 */
export function ParityNote(props: { children: ReactNode }) {
  return <p className="inspector-parity-note">{props.children}</p>;
}
