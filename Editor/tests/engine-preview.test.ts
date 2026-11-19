// The engine preview's scheduler (11.65): latest only, a stale frame is never
// current, a failure is named, and no image URL is leaked.

import { describe, expect, it } from "vitest";

import { createEnginePreview, pngSize, statusWords, type Failure, type PreviewState } from "../src/engine-preview";

/** A render the test finishes by hand, so the order of events is the test's. */
function harness() {
  const renders: Array<{ payload: string; ok(bytes?: Uint8Array): void; fail(error: unknown): void }> = [];
  const urls = new Map<string, boolean>();
  const states: PreviewState[] = [];
  let counter = 0;
  let clock = 1000;
  let concurrent = 0;
  let mostConcurrent = 0;
  const preview = createEnginePreview<string>({
    render: (payload) =>
      new Promise((resolve, reject) => {
        concurrent += 1;
        mostConcurrent = Math.max(mostConcurrent, concurrent);
        renders.push({
          payload,
          ok: (bytes = new Uint8Array([1])) => {
            concurrent -= 1;
            clock += 40;
            resolve(bytes);
          },
          fail: (error) => {
            concurrent -= 1;
            reject(error);
          },
        });
      }),
    makeUrl: () => {
      const url = `blob:${(counter += 1)}`;
      urls.set(url, true);
      return url;
    },
    revokeUrl: (url) => {
      expect(urls.get(url)).toBe(true);
      urls.set(url, false);
    },
    onState: (state) => states.push(state),
    classify: (error): Failure =>
      (error as { kind?: string }).kind === "refused"
        ? { status: "refused", detail: "the engine declined: AssetMissing" }
        : { status: "unavailable", detail: "cannot reach the engine at 127.0.0.1:4401" },
    now: () => clock,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { preview, renders, urls, states, settle, mostConcurrent: () => mostConcurrent };
}

describe("a first request", () => {
  it("is drawing, then current with the frame, its key and how long it took", async () => {
    const h = harness();
    h.preview.request("a", "A");
    expect(h.preview.state()).toMatchObject({ status: "rendering", requestedKey: "a" });
    h.renders[0]!.ok();
    await h.settle();
    expect(h.preview.state()).toEqual({ status: "current", imageUrl: "blob:1", shownKey: "a", requestedKey: "a", renderMs: 40 });
  });

  it("a repeat of the latest key while it is drawing or current asks the engine nothing", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.preview.request("a", "A");
    expect(h.renders).toHaveLength(1);
    h.renders[0]!.ok();
    await h.settle();
    h.preview.request("a", "A");
    expect(h.renders).toHaveLength(1);
  });
});

describe("latest only", () => {
  it("a burst of edits draws the first and the last, never a backlog, and never two at once", async () => {
    const h = harness();
    for (const key of ["a", "b", "c", "d", "e"]) h.preview.request(key, key.toUpperCase());
    expect(h.renders.map((r) => r.payload)).toEqual(["A"]);
    h.renders[0]!.ok();
    await h.settle();
    expect(h.renders.map((r) => r.payload)).toEqual(["A", "E"]);
    h.renders[1]!.ok();
    await h.settle();
    expect(h.preview.state()).toMatchObject({ status: "current", shownKey: "e" });
    expect(h.mostConcurrent()).toBe(1);
  });
});

describe("a stale frame is never current", () => {
  it("keeps the old frame visible but marked out of date while a newer edit draws", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.renders[0]!.ok();
    await h.settle();
    h.preview.request("b", "B");
    expect(h.preview.state()).toMatchObject({ status: "stale", imageUrl: "blob:1", shownKey: "a", requestedKey: "b" });
    expect(statusWords(h.preview.state())).toEqual({ word: "Out of date", tone: "warn" });
    h.renders[1]!.ok();
    await h.settle();
    expect(h.preview.state()).toMatchObject({ status: "current", shownKey: "b" });
  });

  it("a frame that arrives after a newer request is shown as out of date, not current", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.preview.request("b", "B");
    h.renders[0]!.ok();
    await h.settle();
    // A's picture is on screen while B draws: it must not say current.
    expect(h.preview.state()).toMatchObject({ status: "stale", shownKey: "a", requestedKey: "b" });
    h.renders[1]!.ok();
    await h.settle();
    expect(h.preview.state()).toMatchObject({ status: "current", shownKey: "b" });
  });

  it("replacing a frame releases the old image URL", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.renders[0]!.ok();
    await h.settle();
    h.preview.request("b", "B");
    h.renders[1]!.ok();
    await h.settle();
    expect([...h.urls.entries()]).toEqual([["blob:1", false], ["blob:2", true]]);
  });
});

describe("failures are named", () => {
  it("an unreachable engine is unavailable, with the reason; the old frame is kept but not current", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.renders[0]!.ok();
    await h.settle();
    h.preview.request("b", "B");
    h.renders[1]!.fail({ kind: "unreachable" });
    await h.settle();
    expect(h.preview.state()).toMatchObject({
      status: "unavailable",
      detail: "cannot reach the engine at 127.0.0.1:4401",
      imageUrl: "blob:1",
      shownKey: "a",
    });
    expect(statusWords(h.preview.state())).toEqual({ word: "Engine unavailable", tone: "bad" });
  });

  it("a refusal is a different state from an unreachable engine, and says what was refused", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.renders[0]!.fail({ kind: "refused" });
    await h.settle();
    expect(h.preview.state()).toMatchObject({ status: "refused", detail: "the engine declined: AssetMissing" });
    expect(h.preview.state().imageUrl).toBeUndefined();
  });

  it("the next request after a failure asks again and can recover", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.renders[0]!.fail({ kind: "unreachable" });
    await h.settle();
    h.preview.request("b", "B");
    expect(h.renders).toHaveLength(2);
    h.renders[1]!.ok();
    await h.settle();
    expect(h.preview.state()).toMatchObject({ status: "current", shownKey: "b" });
  });

  it("a failure of an older render does not stop the newer request waiting behind it", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.preview.request("b", "B");
    h.renders[0]!.fail({ kind: "unreachable" });
    await h.settle();
    expect(h.renders.map((r) => r.payload)).toEqual(["A", "B"]);
  });
});

describe("clearing", () => {
  it("releases the image, goes idle, and drops a render that finishes afterwards", async () => {
    const h = harness();
    h.preview.request("a", "A");
    h.renders[0]!.ok();
    await h.settle();
    h.preview.request("b", "B");
    h.preview.clear();
    expect(h.preview.state()).toEqual({ status: "idle" });
    expect(h.urls.get("blob:1")).toBe(false);
    h.renders[1]!.ok();
    await h.settle();
    expect(h.preview.state()).toEqual({ status: "idle" });
    expect([...h.urls.values()].filter(Boolean)).toHaveLength(0);
  });
});

describe("words and PNG size", () => {
  it("a state says what it is in words", () => {
    expect(statusWords({ status: "idle" }).word).toBe("No frame yet");
    expect(statusWords({ status: "rendering" }).word).toBe("Drawing…");
    expect(statusWords({ status: "current" })).toEqual({ word: "Current", tone: "ok" });
    expect(statusWords({ status: "refused" }).word).toBe("Engine declined");
  });

  it("reads a PNG's size from its header and refuses what is not a PNG", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(png.buffer);
    view.setUint32(16, 1920);
    view.setUint32(20, 1080);
    expect(pngSize(png)).toEqual({ width: 1920, height: 1080 });
    expect(pngSize(new Uint8Array(40))).toBeUndefined();
    expect(pngSize(new Uint8Array(4))).toBeUndefined();
  });
});
