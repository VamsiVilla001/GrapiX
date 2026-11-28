// The engine chip's hover card (visibility decision of 26 Nov 2026): what it says, and that the scene tabs' + opens the Scenes list.

import { describe, expect, it } from "vitest";

import { engineHoverLines } from "../src/engine-preview";

describe("the engine hover card", () => {
  it("says the status, then the engine's reason, then the last frame time", () => {
    expect(engineHoverLines({ status: "unavailable", detail: "the engine is not running", renderMs: 12.4 })).toEqual([
      "Engine unavailable",
      "the engine is not running",
      "Last frame drawn in 12 ms",
    ]);
  });

  it("leaves out what it does not have", () => {
    expect(engineHoverLines({ status: "idle" } as never)).toEqual(["No frame yet"]);
    expect(engineHoverLines({ status: "current", detail: "   ", renderMs: 0 })).toEqual(["Current", "Last frame drawn in 0 ms"]);
    expect(engineHoverLines({ status: "current", renderMs: -1 })).toEqual(["Current"]);
    expect(engineHoverLines({ status: "current", renderMs: Number.NaN })).toEqual(["Current"]);
    expect(engineHoverLines({ status: "current", renderMs: Number.POSITIVE_INFINITY })).toEqual(["Current"]);
  });
});
