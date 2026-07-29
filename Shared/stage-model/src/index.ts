/**
 * `@grapix/stage-model` — the GrapiX virtual canvas and stage contract.
 *
 * A stage is a logical coordinate space up to 50,000 x 50,000 logical units. It
 * is never a framebuffer: declaring a huge stage allocates nothing. Only tiles
 * become GPU render targets, and only when a viewport, output, preview, or
 * export actually needs them.
 *
 * Seven concepts stay distinct here, and the package exists mainly to stop them
 * collapsing back into one width x height pair:
 *
 *   Stage           the installation
 *   Canvas          its logical extent, origin, render scale, pixel aspect
 *   Surface         a physical display placed on it
 *   Region          a named logical rectangle
 *   Viewport        what is looked at
 *   Camera          how it is looked at
 *   Output          a device wanting pixels at its own resolution
 *   Output mapping  which part of the stage feeds which output
 *
 * This package has no runtime dependency beyond `@grapix/shared-types`, no DOM
 * access, and no GPU access, so the editor, the playout service, and the native
 * engine can all hold it to the same rules.
 */

export * from "./geometry.js";
export * from "./canvas.js";
export * from "./stage.js";
export * from "./outputs.js";
export * from "./document.js";
