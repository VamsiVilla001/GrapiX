/**
 * How a band's display name becomes its stored id.
 *
 * One definition, because two callers predict each other: the store normalises a rename before
 * writing it, and the Object Manager must refuse a colliding draft *while the author is typing*. A
 * second copy would let the panel accept a name the store then rejects — the defect that used to
 * surface as a `window.alert` quoting the raw draft while the collision was decided on the slug, so
 * "Lower Third" collided with "lower third" and the message named neither.
 *
 * Lower case, runs of non-alphanumerics collapsed to a single hyphen, trimmed. Two names that differ
 * only in case or punctuation are therefore the same band.
 */
export function normalizeLayerId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
