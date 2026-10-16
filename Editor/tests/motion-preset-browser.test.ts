// The motion preset browser (11.15, G.6).
//
// The done-when is that the library grows from real designer work, and the
// mechanism is that a preset is selected and parameterised, never authored —
// there is nowhere to put a keyframe. The failures under test:
//   - a preset with no out phase going to air and never clearing (G.6.6);
//   - frames resolved against the scene's rational rate, never stored, so a
//     preset authored at 50p behaves identically at 59.94 (G.6.2).

import { describe, expect, it } from "vitest";

import type { MotionPreset, RationalRate } from "@grapix/contracts";
import { agentView, findNode } from "../src/agent-surface";
import {
  framesForDisplay,
  presetBlocker,
  presetBrowserPanel,
  presetCard,
} from "../src/motion-preset-browser";

const P50: RationalRate = { num: 50, den: 1 } as RationalRate;
const P29_97: RationalRate = { num: 30000, den: 1001 } as RationalRate;

function preset(overrides: Partial<MotionPreset> = {}): MotionPreset {
  return {
    id: "lower-third/wipe-on",
    appliesTo: ["group"],
    phases: {
      in: { duration: 400, channels: [] },
      out: { duration: 240, channels: [] },
      hold: null,
      continue: [],
      update: null,
    },
    params: [],
    stagger: null,
    ...overrides,
  } as unknown as MotionPreset;
}

describe("frames resolve against the scene's rate (G.6.2)", () => {
  it("the same duration is a different frame count at a different rate", () => {
    // 400 ms is 20 frames at 50p and 12 at 29.97, and the rate is never
    // pre-rounded — storing frames would make the preset rate-specific.
    expect(framesForDisplay(400, P50)).toBe(20);
    expect(framesForDisplay(400, P29_97)).toBe(12);
  });

  it("the card shows the duration an operator reads", () => {
    const card = presetCard(preset(), P50, {});
    expect(findNode(card, "lower-third/wipe-on/phase/in")!.value).toBe("400 ms · 20 frames");
    expect(findNode(card, "lower-third/wipe-on/phase/out")!.value).toBe("240 ms · 12 frames");
  });
});

describe("a preset that cannot leave is a defect (G.6.6)", () => {
  it("refuses to apply and names the missing out phase", () => {
    const broken = preset({
      id: "stuck",
      phases: {
        in: { duration: 400, channels: [] },
        out: { duration: 0, channels: [] },
        hold: null,
        continue: [],
        update: null,
      },
    } as Partial<MotionPreset>);

    expect(presetBlocker(broken, {})).toContain("no out phase");
    expect(presetBlocker(broken, {})).toContain("never clear");

    const apply = presetCard(broken, P50, {}).actions!.find((a) => a.name === "apply")!;
    expect(apply.unavailable).toContain("no out phase");
  });

  it("a sound preset applies", () => {
    expect(presetBlocker(preset(), {})).toBeUndefined();
  });
});

describe("a preset applies to the selection or says why not", () => {
  it("a preset for a different kind is unavailable, naming both", () => {
    // Silently filtering it out would leave a designer wondering where a
    // preset they made has gone.
    const bugPreset = preset({ id: "bug/spin", appliesTo: ["mesh"] });
    const reason = presetBlocker(bugPreset, { selectionKinds: ["group"] });
    expect(reason).toContain("mesh");
    expect(reason).toContain("group");
  });

  it("a matching preset applies; no selection filters nothing", () => {
    expect(presetBlocker(preset(), { selectionKinds: ["group"] })).toBeUndefined();
    // No selection means everything is potentially applicable.
    expect(presetBlocker(preset(), { selectionKinds: [] })).toBeUndefined();
    expect(presetBlocker(preset(), {})).toBeUndefined();
  });
});

describe("the library grows from designer work", () => {
  it("every preset offers save-selection-as-preset", () => {
    const panel = presetBrowserPanel([preset()], P50, {});
    const card = findNode(panel, "preset/lower-third/wipe-on")!;
    expect(card.actions!.map((a) => a.name)).toEqual(["apply", "saveAsPreset"]);
  });

  it('save is unavailable by name when the shell says the selection cannot be saved', () => {
    const blocked = presetBrowserPanel([preset()], P50, { saveBlocker: 'select the keys to save in the timeline' });
    const action = findNode(blocked, 'preset/lower-third/wipe-on')!.actions!.find((a) => a.name === 'saveAsPreset')!;
    expect(action.unavailable).toBe('select the keys to save in the timeline');
    const open = presetBrowserPanel([preset()], P50, {});
    const free = findNode(open, 'preset/lower-third/wipe-on')!.actions!.find((a) => a.name === 'saveAsPreset')!;
    expect(free.unavailable).toBeUndefined();
  });

  it("an empty library says how it fills, not that it is broken", () => {
    // "The library is empty" is a different statement from "there are no
    // presets", and the first is the actionable one.
    const panel = presetBrowserPanel([], P50, {});
    expect(panel.description).toContain("grows from designer work");
  });

  it("the header counts what is usable for the selection", () => {
    const panel = presetBrowserPanel(
      [preset(), preset({ id: "mesh/only", appliesTo: ["mesh"] })],
      P50,
      { selectionKinds: ["group"] },
    );
    expect(panel.description).toBe("2 preset(s), 1 usable for this selection");
  });

  it("a parameter's declared range is the constraint a caller is held to", () => {
    const withParam = preset({
      params: [
        { type: "duration", name: "settle", min: 120, max: 600, default: 400 },
        { type: "enum", name: "direction", values: ["left", "right"], default: "left" },
      ],
    } as Partial<MotionPreset>);
    const card = presetCard(withParam, P50, {});

    expect(findNode(card, "lower-third/wipe-on/param/settle")!.value).toBe("120–600 ms");
    expect(findNode(card, "lower-third/wipe-on/param/direction")!.value).toBe("left / right");
  });
});

describe("an agent selects and parameterises, never authors", () => {
  it("the projection exposes apply and its blocker, and no keyframe path", () => {
    const panel = presetBrowserPanel([preset()], P50, {});
    const view = agentView(panel);
    const card = view.children[0]!.children[0]!;

    expect(card.actions.map((a) => a.name)).toEqual(["apply", "saveAsPreset"]);
    // There is no action that would let a caller author motion: the surface
    // an agent reads is the surface a designer uses, and neither can put a
    // keyframe into a preset.
    expect(card.actions.some((a) => a.name.includes("key"))).toBe(false);
    expect(card.actions.some((a) => a.name.includes("edit"))).toBe(false);
  });
});
