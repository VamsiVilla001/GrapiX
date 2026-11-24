// The Settings window's fields (11.81): what a control sends, what range it allows, and that the page has
// the window. The compiler already checks that every setting of the contract has a row
// (`satisfies Record<keyof UserSettings, ...>`); these tests hold what that cannot.
import { describe, expect, it } from "vitest";
import { MACHINE_FIELDS, toValue, USER_FIELDS, usageLine } from "../src/settings-form";
import page from "../web/index.html?raw";

describe("what a Settings control sends", () => {
  it("sends a whole number inside its range, and says why when it is not", () => {
    const port = MACHINE_FIELDS.controlPort;
    expect(toValue(port, "7788")).toEqual({ ok: true, value: 7788 });
    expect(toValue(port, " 1024 ")).toEqual({ ok: true, value: 1024 });
    expect(toValue(port, "1023")).toEqual({ ok: false, why: "Use 1024 or more." });
    expect(toValue(port, "65536")).toEqual({ ok: false, why: "Use 65535 or less." });
    expect(toValue(port, "80.5")).toEqual({ ok: false, why: "Type a whole number." });
    expect(toValue(port, "")).toEqual({ ok: false, why: "Type a whole number." });
    expect(toValue(port, "abc")).toEqual({ ok: false, why: "Type a whole number." });
  });

  it("allows 0 where 0 means off", () => {
    expect(toValue(MACHINE_FIELDS.diskCacheMaxMb, "0")).toEqual({ ok: true, value: 0 });
    expect(toValue(USER_FIELDS.defaultAnimationFrames, "0")).toEqual({ ok: false, why: "Use 1 or more." });
  });

  it("sends a checkbox as true or false, and text and choices trimmed", () => {
    expect(toValue(USER_FIELDS.confirmDeletes, true)).toEqual({ ok: true, value: true });
    expect(toValue(USER_FIELDS.confirmDeletes, false)).toEqual({ ok: true, value: false });
    expect(toValue(USER_FIELDS.language, "  en-GB ")).toEqual({ ok: true, value: "en-GB" });
    expect(toValue(USER_FIELDS.startup, "reopenLast")).toEqual({ ok: true, value: "reopenLast" });
    // An empty text is a real value (a cleared folder); the service decides if it is allowed.
    expect(toValue(USER_FIELDS.lastUsedFolder, "")).toEqual({ ok: true, value: "" });
  });
});

describe("the fields match the settings contract", () => {
  it("allows the same ranges the service enforces", () => {
    expect(MACHINE_FIELDS.textureCacheMb).toMatchObject({ min: 64, max: 65_536 });
    expect(MACHINE_FIELDS.diskCacheMaxMb).toMatchObject({ min: 0, max: 4_194_304 });
    expect(MACHINE_FIELDS.controlPort).toMatchObject({ min: 1024, max: 65_535 });
    expect(USER_FIELDS.defaultAnimationFrames).toMatchObject({ min: 1, max: 1_000_000 });
  });

  it("offers exactly the choices the contract has", () => {
    const values = (f: { options?: readonly (readonly [string, string])[] }): string[] => (f.options ?? []).map(([v]) => v);
    expect(values(USER_FIELDS.startup)).toEqual(["showStart", "reopenLast"]);
    expect(values(USER_FIELDS.defaultInterpolation)).toEqual(["linear", "easeInOut", "bezier"]);
    expect(values(MACHINE_FIELDS.processPriority)).toEqual(["normal", "aboveNormal", "high"]);
    expect(values(MACHINE_FIELDS.logLevel)).toEqual(["error", "warn", "info", "debug"]);
  });

  it("is honest about what reads each setting yet", () => {
    // Used now: what the Editor reads today.
    expect(usageLine(USER_FIELDS.startup)).toBe("Used now.");
    expect(USER_FIELDS.lastUsedFolder).not.toHaveProperty("notUsedYet");
    // Saved but waiting for the part that will read it.
    expect(usageLine(MACHINE_FIELDS.controlPort)).toContain("Not used yet");
    expect(usageLine(MACHINE_FIELDS.controlPort)).toContain("6.7");
    for (const field of [...Object.values(USER_FIELDS), ...Object.values(MACHINE_FIELDS)]) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.help.length).toBeGreaterThan(0);
    }
  });
});

describe("the page has the Settings window", () => {
  it("has the window and the controls the page code looks for", () => {
    for (const id of ["settings-dialog", "settings-form", "settings-body", "settings-error", "settings-reset-user", "settings-reset-machine", "settings-close"]) {
      expect(page).toContain(`id="${id}"`);
    }
  });
});
