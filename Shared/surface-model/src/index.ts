/**
 * `@grapix/surface-model` — physical display surfaces on a GrapiX stage.
 *
 * `@grapix/stage-model` knows where a surface sits. This package knows what it
 * physically is: LED wall, curved LED, projection screen, ribbon, scoreboard,
 * multi-monitor array, stadium screen, virtual-production volume, or an
 * irregular layout — with pixel density, pixel aspect ratio, bezel gaps,
 * projector warp, edge blending, and a colour-profile reference.
 *
 * Honesty rule for this phase: warp, edge blending, and bezel compensation are
 * carried in the data model and reported by validation, but the renderer does
 * not yet apply the corrections. `implemented: false` is part of the type so no
 * caller can mistake declared calibration for applied calibration.
 */

export * from "./surface.js";
export * from "./mapper.js";
export * from "./layout.js";
