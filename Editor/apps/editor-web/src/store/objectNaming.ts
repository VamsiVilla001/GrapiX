/**
 * Produce a readable, case-insensitively unique scene-object name. Newly created objects are
 * numbered from one (`Quad 1`, `Quad 2`) so repeated primitives are unambiguous immediately.
 */
export function nextUniqueObjectName(
  objects: readonly { name: string }[],
  requestedName: string
): string {
  const requested = requestedName.trim() || "Object";
  const base = requested
    .replace(/\s+copy(?:\s+\d+)?$/i, "")
    .replace(/\s+\d+$/i, "")
    .trim() || "Object";
  const occupied = new Set(objects.map((object) => object.name.trim().toLocaleLowerCase()));
  let index = 1;
  while (occupied.has(`${base} ${index}`.toLocaleLowerCase())) index += 1;
  return `${base} ${index}`;
}
