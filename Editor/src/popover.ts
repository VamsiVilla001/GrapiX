// A control that opens a popover (the visibility decision of 26 Nov 2026: what is on demand is one click away and closes as easily).
// The button says whether its popover is open (`aria-expanded`); a click on it toggles; Escape, or a press anywhere outside both,
// closes it and gives the focus back to the button when it was inside. One popover open at a time.

export interface PopoverLike {
  hidden: boolean;
  contains(node: unknown): boolean;
}
export interface ButtonLike {
  setAttribute(name: string, value: string): void;
  contains(node: unknown): boolean;
  focus(): void;
  addEventListener(type: "click", listener: () => void): void;
}

const open = new Set<() => void>();

/** Whether a press at `target` should close the popover: anywhere but the popover or its button. */
export function closesOn(target: unknown, button: { contains(node: unknown): boolean }, popover: { contains(node: unknown): boolean }): boolean {
  return !button.contains(target) && !popover.contains(target);
}

/** Wire `button` to toggle `popover`; returns the function that closes it. */
export function wirePopover(button: ButtonLike, popover: PopoverLike, onOpen?: () => void): () => void {
  const close = (): void => {
    if (popover.hidden) return;
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
    open.delete(close);
  };
  button.addEventListener("click", () => {
    if (!popover.hidden) {
      close();
      return;
    }
    for (const other of [...open]) other();
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    open.add(close);
    onOpen?.();
  });
  return close;
}

/** Close every open popover, as Escape does. Returns whether one was open. */
export function closeAllPopovers(): boolean {
  const any = open.size > 0;
  for (const close of [...open]) close();
  return any;
}

/** Close the popovers a press outside them closes. */
export function closePopoversOutside(target: unknown, pairs: readonly { button: { contains(node: unknown): boolean }; popover: PopoverLike; close: () => void }[]): void {
  for (const pair of pairs) if (!pair.popover.hidden && closesOn(target, pair.button, pair.popover)) pair.close();
}

/** The chip's words: how many things the preview does not draw. */
export function notDrawnWords(count: number): string {
  return `${count} not drawn`;
}
