// The one-line status bar (visibility decision of 26 Nov 2026): its words, and that the history and the engine time it replaces
// are still on the page.

import { describe, expect, it } from "vitest";

import { latestWords, renderTimeWords } from "../src/status-bar";

describe("the status bar", () => {
  it("shows the engine's last frame time in whole milliseconds, and nothing before a frame is drawn", () => {
    expect(renderTimeWords(12.4)).toBe("12 ms");
    expect(renderTimeWords(12.6)).toBe("13 ms");
    expect(renderTimeWords(0)).toBe("0 ms");
    expect(renderTimeWords(undefined)).toBe("");
    expect(renderTimeWords(Number.NaN)).toBe("");
    expect(renderTimeWords(-1)).toBe("");
  });

  it("shows the newest message, or that there is none yet", () => {
    expect(latestWords("Added text text-1")).toBe("Added text text-1");
    expect(latestWords("  Set Case to Uppercase \n")).toBe("Set Case to Uppercase");
    expect(latestWords(undefined)).toBe("No activity yet");
    expect(latestWords("   ")).toBe("No activity yet");
  });

  it("keeps the full history one click away: the message opens the same list, closed until asked for", async () => {
    const nodeFs = "node:fs";
    const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL, encoding: string): string };
    const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const main = fs.readFileSync(new URL("../web/main.ts", import.meta.url), "utf8");
    expect(html).toMatch(/id="log-popover"[^>]*hidden/);
    expect(html).toMatch(/id="log-popover"[\s\S]*?<ul id="log"/);
    expect(main).toContain('["status-message", "log-popover"]');
    expect(html).toContain('id="status-library"');
    expect(html).toContain('id="status-render"');
  });
});
