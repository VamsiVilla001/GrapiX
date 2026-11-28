import { describe, expect, it } from "vitest";

import { EDITOR_DESIGN_ID } from "../src/workspace-catalog";
import { createLayoutSwitcher, type LayoutSwitcher } from "../src/layout-switcher";
import { workspaceFromLayout } from "../src/workspace-io";
import { memoryPersistence } from "../src/workspace-persistence";
import { CARD_SORT_LAYOUT, isRefused, movePanel, type Layout } from "../src/workspace-layout";

const PANELS = Object.values(CARD_SORT_LAYOUT.regions).flatMap((r) => [...r.panels]);
const moved = (layout: Layout, panel: string, region: "left" | "right" | "centre" | "bottom"): Layout => {
  const next = movePanel(layout, panel, region);
  if (isRefused(next)) throw new Error(next.refused);
  return next;
};

/** A switcher over a store, whose page shows whatever `page.layout` is. */
function open(store = memoryPersistence(), previousLayout?: Layout) {
  const page = { layout: CARD_SORT_LAYOUT };
  const said: string[] = [];
  const switcher: LayoutSwitcher = createLayoutSwitcher({
    persistence: store,
    panels: () => PANELS,
    currentLayout: () => page.layout,
    previousLayout,
    say: (m) => void said.push(m),
    delayMs: -1,
    now: () => "2026-11-24T12:00:00Z",
  });
  return { store, page, said, switcher };
}

const where = (layout: Layout, panel: string): string | undefined => (Object.keys(layout.regions) as (keyof Layout["regions"])[]).find((r) => layout.regions[r].panels.includes(panel));

describe("the first run", () => {
  it("shows the shipped Design, unchanged, in use", async () => {
    const { switcher } = open();
    const started = await switcher.start();
    expect(started.layout).toEqual(CARD_SORT_LAYOUT);
    expect(switcher.items()).toEqual([{ id: EDITOR_DESIGN_ID, name: "Design", modified: false, shipped: true, active: true }]);
  });

  it("keeps the arrangement the author already had, as Design with a dot, so nothing moves", async () => {
    const theirs = moved(CARD_SORT_LAYOUT, "inspector", "left");
    const { switcher } = open(undefined, theirs);
    const started = await switcher.start();
    expect(where(started.layout!, "inspector")).toBe("left");
    expect(switcher.items()[0]).toMatchObject({ name: "Design", modified: true, active: true });
  });
});

describe("changes follow, and a restart keeps them", () => {
  it("writes the arrangement as the session copy and reads it back on the next start", async () => {
    const first = open();
    await first.switcher.start();
    first.switcher.changed(moved(CARD_SORT_LAYOUT, "inspector", "left"));
    await first.switcher.flush();
    expect(first.store.files.has(`editor/session/${EDITOR_DESIGN_ID}`)).toBe(true);
    const second = open(first.store);
    const started = await second.switcher.start();
    expect(where(started.layout!, "inspector")).toBe("left");
    expect(second.switcher.items()[0]!.modified).toBe(true);
  });

  it("says so when a change could not be written, and writes it with the next one", async () => {
    const { switcher, store, said } = open();
    await switcher.start();
    store.fail = (what) => what.includes("/session/");
    switcher.changed(moved(CARD_SORT_LAYOUT, "inspector", "left"));
    await switcher.flush();
    expect(said.join(" ")).toContain("not saved");
    store.fail = undefined;
    await switcher.flush();
    expect(store.files.has(`editor/session/${EDITOR_DESIGN_ID}`)).toBe(true);
  });
});

describe("saving and switching", () => {
  it("saves the arrangement as a layout of the author's own and puts it in use", async () => {
    const { switcher, page, store } = open();
    await switcher.start();
    page.layout = moved(CARD_SORT_LAYOUT, "inspector", "left");
    const made = await switcher.saveAs("Mine");
    expect(made).toMatchObject({ ok: true });
    const items = switcher.items();
    expect(items.map((i) => [i.name, i.shipped, i.active])).toEqual([["Design", true, false], ["Mine", false, true]]);
    expect(store.files.has(`editor/saved/${items[1]!.id}`)).toBe(true);
  });

  it("brings back each layout as it was left, unsaved changes included", async () => {
    const { switcher, page } = open();
    await switcher.start();
    page.layout = moved(CARD_SORT_LAYOUT, "inspector", "left");
    await switcher.saveAs("Mine");
    const mine = switcher.items()[1]!.id;
    page.layout = moved(page.layout, "bindings", "right");
    const back = await switcher.switchTo(EDITOR_DESIGN_ID);
    expect(back.ok).toBe(true);
    expect(where(back.layout!, "inspector")).toBe("left");
    page.layout = back.layout!;
    const again = await switcher.switchTo(mine);
    expect(where(again.layout!, "bindings")).toBe("right");
  });

  it("saving over the layout in use clears its dot", async () => {
    const { switcher, page } = open();
    await switcher.start();
    page.layout = moved(CARD_SORT_LAYOUT, "inspector", "left");
    await switcher.saveAs("Mine");
    switcher.changed(moved(page.layout, "bindings", "right"));
    expect(switcher.activeModified()).toBe(true);
    page.layout = moved(page.layout, "bindings", "right");
    await switcher.save();
    expect(switcher.activeModified()).toBe(false);
  });
});

describe("what the model refuses, the dialog says in words", () => {
  it("a shipped layout keeps its name and cannot be deleted; the one in use cannot be deleted; a name is unique", async () => {
    const { switcher, page } = open();
    await switcher.start();
    page.layout = moved(CARD_SORT_LAYOUT, "inspector", "left");
    await switcher.saveAs("Mine");
    const mine = switcher.items()[1]!.id;
    expect(await switcher.rename(EDITOR_DESIGN_ID, "Other")).toMatchObject({ ok: false, message: expect.stringContaining("keeps its name") });
    expect(await switcher.remove(EDITOR_DESIGN_ID)).toMatchObject({ ok: false, message: expect.stringContaining("cannot be deleted") });
    expect(await switcher.remove(mine)).toMatchObject({ ok: false, message: expect.stringContaining("workspace in use") });
    expect(await switcher.saveAs("mine")).toMatchObject({ ok: false, message: expect.stringContaining("already called") });
    expect(await switcher.rename(mine, "Wide")).toMatchObject({ ok: true });
    await switcher.switchTo(EDITOR_DESIGN_ID);
    expect(await switcher.remove(mine)).toMatchObject({ ok: true });
    expect(switcher.items().map((i) => i.name)).toEqual(["Design"]);
  });
});

describe("reset", () => {
  it("puts the shipped layout back as shipped", async () => {
    const { switcher } = open();
    await switcher.start();
    switcher.changed(moved(CARD_SORT_LAYOUT, "inspector", "left"));
    expect(switcher.activeModified()).toBe(true);
    const reset = await switcher.reset(EDITOR_DESIGN_ID);
    expect(reset.layout).toEqual(CARD_SORT_LAYOUT);
    expect(switcher.activeModified()).toBe(false);
  });

  it("puts the author's own layout back as they last saved it", async () => {
    const { switcher, page } = open();
    await switcher.start();
    page.layout = moved(CARD_SORT_LAYOUT, "inspector", "left");
    await switcher.saveAs("Mine");
    const mine = switcher.items()[1]!.id;
    switcher.changed(moved(page.layout, "bindings", "right"));
    const reset = await switcher.reset(mine);
    expect(where(reset.layout!, "inspector")).toBe("left");
    expect(where(reset.layout!, "bindings")).not.toBe("right");
  });
});

describe("a layout this page cannot show", () => {
  it("is listed, refused by name when chosen, and leaves the layout in use alone", async () => {
    const store = memoryPersistence();
    const foreign = workspaceFromLayout(CARD_SORT_LAYOUT, { workspaceId: "user.elsewhere", name: "Elsewhere", origin: "user", app: "editor" });
    store.files.set("editor/saved/user.elsewhere", foreign);
    store.files.set("editor/session/user.elsewhere", foreign);
    const { switcher } = open(store);
    await switcher.start();
    expect(switcher.items().map((i) => i.name)).toContain("Elsewhere");
    const chosen = await switcher.switchTo("user.elsewhere");
    expect(chosen).toMatchObject({ ok: false, message: expect.stringContaining("was not arranged on this page") });
    expect(switcher.activeId()).toBe(EDITOR_DESIGN_ID);
  });
});
