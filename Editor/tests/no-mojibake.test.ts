/// <reference types="vite/client" />
// A file written with the wrong encoding turns "◇" into "â—‡" and "·" into "Â·": the Editor then draws garbled diamonds and arrows beside a property
// (seen in `keyframe-editor.ts`, 26 Nov 2026). This scans the Editor's own sources for the telltale sequences, so it cannot come back unseen.

import { describe, expect, it } from "vitest";

const sources = import.meta.glob(["../src/**/*.ts", "../web/*.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// UTF-8 bytes read as Windows-1252: a lead byte 0xC2/0xC3 or 0xE2 followed by its continuation, shown as Â, Ã, â and a symbol.
const MOJIBAKE = /\u00e2\u20ac|\u00e2\u2014|\u00c2[\u00a0-\u00bf]|\u00c3[\u0080-\u00bf]/;

describe("the Editor's sources are not double-encoded", () => {
  it("scans the sources it should (a glob that matched nothing would pass for the wrong reason)", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.keys(sources)).toContain("../src/keyframe-editor.ts");
    expect(Object.keys(sources)).toContain("../web/main.ts");
  });

  it("finds no UTF-8 read as Windows-1252 in any of them", () => {
    const damaged = Object.entries(sources).flatMap(([file, text]) => {
      const line = text.split("\n").findIndex((candidate) => MOJIBAKE.test(candidate));
      return line < 0 ? [] : [`${file}:${line + 1}`];
    });
    expect(damaged).toEqual([]);
  });

  it("would catch the damage it is looking for", () => {
    expect(MOJIBAKE.test("\u00e2\u2014\u2021 diamond")).toBe(true);
    expect(MOJIBAKE.test("frame \u00c2\u00b7 12")).toBe(true);
    expect(MOJIBAKE.test("\u25c7 \u00b7 \u2039 plain text, an \u00e9 and an \u00e0 are fine")).toBe(false);
  });
});
