/**
 * Take pointer capture, best-effort.
 *
 * `setPointerCapture` throws `NotFoundError` when the pointer is no longer active — a release that
 * lands between the browser queueing the event and React running the handler, and every synthetic
 * pointer a test dispatches. Letting that escape aborts the rest of the handler, so the drag state
 * is never recorded and the gesture does nothing at all. Capture only extends tracking beyond the
 * element's bounds; without it a drag still works while the pointer is over the element, which is a
 * far better failure.
 *
 * Shared rather than copied: the Timeline's key drags and the Object Manager's numeric scrub both
 * need it, and a second copy is how one of them ends up without the `try`.
 */
export function capturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Tracked by the caller's own drag refs either way.
  }
}

/** Release capture if this element still holds it. Safe to call on a pointer that already went. */
export function releasePointer(element: Element, pointerId: number): void {
  if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
}
