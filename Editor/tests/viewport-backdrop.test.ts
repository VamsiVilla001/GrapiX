import { describe, expect, it } from "vitest";

import { backdropLabel, DEFAULT_BACKDROP, parseBackdrop, serialiseBackdrop } from "../src/viewport-backdrop";

describe("viewport backdrop", () => {
  it("defaults to solid black", () => {
    expect(parseBackdrop(null)).toEqual({ grid: false, color: "#000000" });
    expect(parseBackdrop(undefined)).toEqual(DEFAULT_BACKDROP);
    expect(parseBackdrop("")).toEqual(DEFAULT_BACKDROP);
  });

  it("round-trips a grid and a custom colour", () => {
    const value = { grid: true, color: "#1a2b3c" };
    expect(parseBackdrop(serialiseBackdrop(value))).toEqual(value);
  });

  it("lowercases a colour and keeps the grid flag", () => {
    expect(parseBackdrop('{"grid":true,"color":"#ABCDEF"}')).toEqual({ grid: true, color: "#abcdef" });
  });

  it("refuses a bad colour or flag without throwing", () => {
    expect(parseBackdrop('{"grid":"yes","color":"red"}')).toEqual(DEFAULT_BACKDROP);
    expect(parseBackdrop('{"color":"#12345"}').color).toBe("#000000");
    expect(parseBackdrop("not json")).toEqual(DEFAULT_BACKDROP);
    expect(parseBackdrop("42")).toEqual(DEFAULT_BACKDROP);
    expect(parseBackdrop("null")).toEqual(DEFAULT_BACKDROP);
  });

  it("names the state and the colour", () => {
    expect(backdropLabel({ grid: true, color: "#000000" })).toMatch(/checkerboard/);
    expect(backdropLabel({ grid: false, color: "#336699" })).toMatch(/#336699/);
  });
});
