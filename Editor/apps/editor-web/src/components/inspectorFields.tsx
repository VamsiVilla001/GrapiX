import type { ReactNode } from "react";

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
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

export function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        disabled={props.disabled}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function ToggleField(props: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
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
    </label>
  );
}

export function ColorField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const safeColor = props.value.startsWith("#") ? props.value : "#ffffff";

  return (
    <label className="field color-field">
      <span>{props.label}</span>
      <input type="color" value={safeColor} onChange={(event) => props.onChange(event.target.value)} />
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
    </label>
  );
}

/** A read-only value the inspector reports but nothing can edit here. */
export function ReadOnlyField(props: { label: string; value: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input readOnly value={props.value} />
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
