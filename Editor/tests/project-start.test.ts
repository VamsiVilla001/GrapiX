// The Start screen's rules (11.43): where a project will be saved, the rows it offers, and when.
import { describe, expect, it } from "vitest";
import {
  canCreate,
  dirname,
  joinPath,
  previewGpx,
  projectSummary,
  relativeTime,
  renderingLabel,
  startRows,
  suggestCopyName,
  type ListedRecent,
} from "../src/project-start";

describe("where a project will be saved", () => {
  it("is <folder>/<name>/<name>.gpx with the separator the folder already uses", () => {
    expect(previewGpx("D:\\My Shows", "Finals")).toBe("D:\\My Shows\\Finals\\Finals.gpx");
    expect(previewGpx("/home/me/shows/", "Finals")).toBe("/home/me/shows/Finals/Finals.gpx");
    expect(previewGpx("D:\\My Shows\\", "Finals")).toBe("D:\\My Shows\\Finals\\Finals.gpx");
  });

  it("waits for both a folder and a name, and trims the name", () => {
    expect(previewGpx(undefined, "Finals")).toBeUndefined();
    expect(previewGpx("D:\\Shows", "   ")).toBeUndefined();
    expect(previewGpx("D:\\Shows", "  Finals  ")).toBe("D:\\Shows\\Finals\\Finals.gpx");
    expect(canCreate("D:\\Shows", "Finals")).toBe(true);
    expect(canCreate(undefined, "Finals")).toBe(false);
    expect(canCreate("D:\\Shows", " ")).toBe(false);
  });

  it("offers a Save As name that is never the original's, saved beside it", () => {
    expect(suggestCopyName("Finals")).toBe("Finals copy");
    expect(suggestCopyName("  Finals ")).toBe("Finals copy");
    // The copy goes to <folder>/<name>/<name>.gpx like any project.
    expect(previewGpx("D:\\My Shows", suggestCopyName("Finals"))).toBe(
      "D:\\My Shows\\Finals copy\\Finals copy.gpx",
    );
  });

  it("joins and splits paths of either kind", () => {
    expect(joinPath("C:\\a", "b", "c.gpx")).toBe("C:\\a\\b\\c.gpx");
    expect(dirname("C:\\a\\b\\c.gpx")).toBe("C:\\a\\b");
    expect(dirname("/a/b/c.gpx")).toBe("/a/b");
    expect(dirname("c.gpx")).toBe("");
  });
});

describe("how long ago", () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  const ago = (ms: number): string => relativeTime(now - ms, now);
  it("speaks in minutes, hours and yesterday, then gives the date", () => {
    expect(ago(5_000)).toBe("just now");
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(5 * 60_000)).toBe("5 minutes ago");
    expect(ago(3 * 3_600_000)).toBe("3 hours ago");
    expect(ago(30 * 3_600_000)).toBe("yesterday");
    expect(ago(10 * 86_400_000)).toBe("12 Nov 2026");
  });

  it("says nothing for a time it does not know", () => {
    expect(relativeTime(0, now)).toBe("");
    expect(relativeTime(Number.NaN, now)).toBe("");
  });
});

describe("the rows the Start screen offers", () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  const recent: ListedRecent[] = [
    { gpx: "D:\\Shows\\Finals\\Finals.gpx", name: "Finals", openedMs: now - 120_000, exists: true },
    { gpx: "D:\\Gone\\Old\\Old.gpx", name: "Old", openedMs: now - 5 * 86_400_000, exists: false },
  ];

  it("lists remembered projects as the shell gives them, a missing one marked and not openable", () => {
    const rows = startRows(recent, [], now);
    expect(rows.map((r) => r.title)).toEqual(["Finals", "Old"]);
    expect(rows[0]).toMatchObject({
      when: "2 minutes ago",
      missing: false,
      open: { kind: "gpx", gpx: "D:\\Shows\\Finals\\Finals.gpx" },
      forgettable: true,
    });
    expect(rows[1]).toMatchObject({ missing: true, open: undefined, forgettable: true });
  });

  it("adds projects from the old default folder that are not already remembered", () => {
    const rows = startRows(
      recent,
      [
        ["Finals", "d:/shows/finals"],
        ["Legacy", "C:\\Users\\me\\AppData\\projects\\Legacy"],
      ],
      now,
    );
    expect(rows.map((r) => r.title)).toEqual(["Finals", "Old", "Legacy"]);
    const legacy = rows[2]!;
    expect(legacy.open).toEqual({ kind: "folder", folder: "C:\\Users\\me\\AppData\\projects\\Legacy" });
    expect(legacy.forgettable).toBe(false);
    expect(legacy.when).toBe("");
  });

  it("is empty when nothing has been opened", () => {
    expect(startRows([], [], now)).toEqual([]);
  });
});

describe("the line under the Scene Manager's title", () => {
  it("names the open project and its file, or says none is open", () => {
    expect(projectSummary(undefined)).toBe("No project open");
    const finals = {
      name: "Finals",
      gpx: "D:\\S\\Finals\\Finals.gpx",
      root: "D:\\S",
      workingColorSpace: "srgb",
      colorDepth: "16",
      closedSessions: [],
    } as const;
    expect(projectSummary(finals)).toBe("Project Finals · 16 bpc · sRGB · D:\\S\\Finals\\Finals.gpx");
  });

  it("says how the project renders: its bits per channel and its space", () => {
    const at = (colorDepth: "8" | "16" | "32", workingColorSpace: "srgb" | "linear-srgb") =>
      renderingLabel({ colorDepth, workingColorSpace });
    expect(at("8", "srgb")).toBe("8 bpc · sRGB");
    expect(at("16", "srgb")).toBe("16 bpc · sRGB");
    // 32 is float in After Effects, and the only depth that keeps values above white.
    expect(at("32", "linear-srgb")).toBe("32 bpc float · Linear sRGB");
  });
});
