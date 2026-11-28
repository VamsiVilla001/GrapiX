// On-demand popovers (visibility decision of 26 Nov 2026): a button toggles its popover and says so, one popover is open at a time,
// Escape and a press outside close them, and the not-drawn chip's words.

import { describe, expect, it } from "vitest";

import { closeAllPopovers, closePopoversOutside, closesOn, notDrawnWords, wirePopover } from "../src/popover";

class FakeButton {
  readonly attributes = new Map<string, string>();
  private listener: (() => void) | undefined;
  focused = false;
  constructor(readonly name: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  contains(node: unknown): boolean {
    return node === this;
  }
  focus(): void {
    this.focused = true;
  }
  addEventListener(_type: "click", listener: () => void): void {
    this.listener = listener;
  }
  click(): void {
    this.listener?.();
  }
}
class FakePopover {
  hidden = true;
  readonly inside = {};
  contains(node: unknown): boolean {
    return node === this || node === this.inside;
  }
}

describe("a popover", () => {
  it("opens and closes on its button, saying so on the button", () => {
    const button = new FakeButton("b");
    const popover = new FakePopover();
    let opened = 0;
    wirePopover(button, popover, () => (opened += 1));
    button.click();
    expect(popover.hidden).toBe(false);
    expect(button.attributes.get("aria-expanded")).toBe("true");
    expect(opened).toBe(1);
    button.click();
    expect(popover.hidden).toBe(true);
    expect(button.attributes.get("aria-expanded")).toBe("false");
  });

  it("is the only one open: opening another closes the first", () => {
    const [a, b] = [new FakeButton("a"), new FakeButton("b")];
    const [pa, pb] = [new FakePopover(), new FakePopover()];
    wirePopover(a, pa);
    wirePopover(b, pb);
    a.click();
    b.click();
    expect([pa.hidden, pb.hidden]).toEqual([true, false]);
    closeAllPopovers();
  });

  it("closes on Escape, and says whether one was open", () => {
    const button = new FakeButton("e");
    const popover = new FakePopover();
    wirePopover(button, popover);
    expect(closeAllPopovers()).toBe(false);
    button.click();
    expect(closeAllPopovers()).toBe(true);
    expect(popover.hidden).toBe(true);
    expect(button.attributes.get("aria-expanded")).toBe("false");
  });

  it("closes on a press outside it and its button, and stays open for a press inside", () => {
    const button = new FakeButton("o");
    const popover = new FakePopover();
    const close = wirePopover(button, popover);
    const pairs = [{ button, popover, close }];
    button.click();
    closePopoversOutside(popover.inside, pairs);
    expect(popover.hidden).toBe(false);
    closePopoversOutside(button, pairs);
    expect(popover.hidden).toBe(false);
    closePopoversOutside({}, pairs);
    expect(popover.hidden).toBe(true);
    expect(closesOn({}, button, popover)).toBe(true);
    expect(closesOn(button, button, popover)).toBe(false);
  });
});

describe("the not-drawn chip", () => {
  it("says how many things the preview does not draw", () => {
    expect(notDrawnWords(1)).toBe("1 not drawn");
    expect(notDrawnWords(3)).toBe("3 not drawn");
  });
});
