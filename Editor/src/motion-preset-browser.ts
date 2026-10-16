// The motion preset browser (build plan 11.15, ADR Part G.6).
//
// Done when: "Library grows from real designer work." The mechanism behind
// that sentence is that a preset is *selected and parameterised*, never
// authored, by the caller (G.6.7) — an agent or a designer picks one and fills
// its declared parameters, and there is nowhere to put a keyframe. A preset
// whose parameters could take arbitrary keyframes is a way to author motion
// wearing a browser's clothes, and the model is not supposed to do that.
//
// **A preset that cannot leave is a defect** (G.6.6). A graphic with no `out`
// phase is the failure that reaches air — it is taken and never clears — so a
// preset missing `out` is shown as unusable and refuses to apply, by name,
// rather than being quietly selectable.
//
// **Time is normalised; frames are resolved** (G.6.2). A preset stores a
// duration in milliseconds on a 0–1 timeline; frames are derived against the
// scene's rational rate at instantiation, never stored. The browser resolves
// them here so a designer can read "20 frames" rather than "400 ms" — the unit
// an operator actually thinks in at 50p.

import type { MotionPreset, RationalRate } from "@grapix/contracts";

import type { UiAction, UiNode } from "./agent-surface";

export interface PresetBrowserState {
  /// The kinds the current selection matches, used to filter what applies.
  readonly selectionKinds?: readonly string[];
  readonly selectedPresetId?: string;
  /// Why saving the current key selection as a preset is not possible, when it
  /// is not. Absent means it is. The browser only states it; the shell that
  /// owns the selection decides it, so the button and the refusal cannot
  /// disagree.
  readonly saveBlocker?: string;
}

/// Milliseconds to whole frames at a rational rate.
///
/// Rust owns this conversion (`ms_to_frames` in contracts), in integer-minded
/// arithmetic, and a preset must resolve identically everywhere it is
/// instantiated (invariant 27). This mirrors it for *display only* — an
/// operator reading the browser — and never for instantiation, which goes
/// through the engine. The rate's `num/den` is never pre-rounded.
export function framesForDisplay(ms: number, rate: RationalRate): number {
  return Math.max(0, Math.round((ms * rate.num) / (rate.den * 1000)));
}

/// The duration a phase carries, in milliseconds, when it is a literal.
///
/// A token reference resolves at instantiation against the token set, so it
/// has no literal answer here and the phase shows its reference instead.
function phaseMs(preset: MotionPreset, phase: keyof MotionPreset["phases"]): number | undefined {
  const candidate = preset.phases[phase];
  if (!candidate || Array.isArray(candidate)) return undefined;
  return typeof candidate.duration === "number" ? candidate.duration : undefined;
}

/// Why a preset cannot be used, or `undefined` when it can.
export function presetBlocker(preset: MotionPreset, state: PresetBrowserState): string | undefined {
  // G.6.6. Shown and refused rather than hidden: a preset that is merely
  // absent from the browser would look like the library is thin, when in fact
  // the library contains a preset that will put a graphic on air and never
  // take it off again.
  const out = preset.phases.out;
  if (typeof out.duration === "number" && out.duration === 0) {
    return `${preset.id} has no out phase — it would go to air and never clear`;
  }

  // A preset that cannot apply to the selection is unavailable, naming the
  // kinds it is for. Silently filtering it out would leave a designer
  // wondering where a preset they made has gone.
  if (state.selectionKinds !== undefined && state.selectionKinds.length > 0) {
    const applies = preset.appliesTo;
    const usable = state.selectionKinds.some((kind) => applies.includes(kind));
    if (!usable) {
      return `${preset.id} applies to ${applies.join(", ")}, not ${state.selectionKinds.join(", ")}`;
    }
  }

  return undefined;
}

function presetActions(preset: MotionPreset, state: PresetBrowserState): UiAction[] {
  const blocker = presetBlocker(preset, state);
  return [
    {
      name: "apply",
      label: `Apply ${preset.id}`,
      ...(blocker === undefined ? {} : { unavailable: blocker }),
    },
    {
      // G.6.7: the library grows from real designer work, captured from a
      // selection the designer just built — not from an agent authoring
      // keyframes. The save action is offered per-preset rather than globally
      // because the gesture is "make something like this from what I have".
      name: "saveAsPreset",
      label: "Save selection as preset",
      ...(state.saveBlocker === undefined ? {} : { unavailable: state.saveBlocker }),
    },
  ];
}

/// One preset as a card: what it applies to, its phases with frames resolved,
/// and the parameters a caller may fill.
export function presetCard(preset: MotionPreset, rate: RationalRate, state: PresetBrowserState): UiNode {
  const inMs = phaseMs(preset, "in");
  const outMs = phaseMs(preset, "out");

  const phases: UiNode[] = [];
  if (inMs !== undefined) {
    phases.push({
      id: `${preset.id}/phase/in`,
      role: "gridcell",
      label: "In",
      value: `${inMs} ms · ${framesForDisplay(inMs, rate)} frames`,
    });
  }
  phases.push({
    id: `${preset.id}/phase/out`,
    role: "gridcell",
    label: "Out",
    value:
      outMs === undefined
        ? "not resolvable here — token reference"
        : outMs === 0
          ? "none — the graphic cannot leave"
          : `${outMs} ms · ${framesForDisplay(outMs, rate)} frames`,
  });

  const params: UiNode[] = preset.params.map((param) => ({
    id: `${preset.id}/param/${param.name}`,
    role: "gridcell",
    label: param.name,
    // The declared range, because it is the constraint a caller is held to:
    // a duration parameter outside its range is not the preset.
    value:
      param.type === "enum"
        ? param.values.join(" / ")
        : `${param.min}–${param.max} ms`,
  }));

  return {
    id: `preset/${preset.id}`,
    role: "listitem",
    label: preset.id,
    description: `applies to ${preset.appliesTo.join(", ")}`,
    selected: state.selectedPresetId === preset.id,
    actions: presetActions(preset, state),
    children: [...phases, ...params],
  };
}

/// The preset library, against the scene's rate.
export function presetBrowserPanel(
  presets: readonly MotionPreset[],
  rate: RationalRate,
  state: PresetBrowserState = {},
): UiNode {
  const usable = presets.filter((preset) => presetBlocker(preset, state) === undefined).length;

  return {
    id: "motion-presets",
    role: "region",
    label: "Motion presets",
    description:
      presets.length === 0
        ? "the library is empty — it grows from designer work, saved from a selection"
        : `${presets.length} preset(s), ${usable} usable for this selection`,
    children: [
      {
        id: "motion-presets/list",
        role: "list",
        label: "Presets",
        children: presets.map((preset) => presetCard(preset, rate, state)),
      },
    ],
  };
}
