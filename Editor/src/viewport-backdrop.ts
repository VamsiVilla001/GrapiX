// What shows behind the composition: After Effects' transparency grid, or a solid colour.
//
// The grid is how a transparent pixel reads as transparent rather than as black; the solid
// colour (black by default) is for judging the picture against a background an author picks.
// Pure: a stored string in, a checked value out, so a bad or missing value never breaks the view.

export interface Backdrop {
  readonly grid: boolean;
  /** `#rrggbb`. */
  readonly color: string;
}

export const DEFAULT_BACKDROP: Backdrop = { grid: false, color: "#000000" };

const HEX = /^#[0-9a-fA-F]{6}$/;

export function parseBackdrop(raw: string | null | undefined): Backdrop {
  if (!raw) return DEFAULT_BACKDROP;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_BACKDROP;
    const { grid, color } = value as { grid?: unknown; color?: unknown };
    return {
      grid: grid === true,
      color: typeof color === "string" && HEX.test(color) ? color.toLowerCase() : DEFAULT_BACKDROP.color,
    };
  } catch {
    return DEFAULT_BACKDROP;
  }
}

export function serialiseBackdrop(backdrop: Backdrop): string {
  return JSON.stringify({ grid: backdrop.grid, color: backdrop.color });
}

/** The words for the toggle's tooltip: what it is now and what a press does. */
export function backdropLabel(backdrop: Backdrop): string {
  return backdrop.grid
    ? "Transparency grid on: transparent pixels show as a checkerboard. Press for the solid background colour."
    : `Solid background ${backdrop.color}: transparent pixels show as this colour. Press for the transparency grid.`;
}
