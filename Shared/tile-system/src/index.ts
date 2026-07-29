/**
 * `@grapix/tile-system` — tiled rendering for extremely large logical stages.
 *
 * Tiles are the only thing in GrapiX that becomes a GPU render target. That is
 * what lets a 50,000 x 50,000 logical stage exist on a GPU whose maximum texture
 * dimension is 16,384, and why declaring such a stage costs nothing until
 * something actually looks at part of it.
 *
 * The pipeline this package implements:
 *
 *   grid          partition the stage into GPU-sized rectangles
 *   object index  map objects to tiles incrementally, so moving one object
 *                 touches only the tiles it left and entered
 *   manager       select tiles by viewport / output / preview / export /
 *                 dirtiness, then evict least-recently-used ones under budget
 *   composite     assemble tiles into a target, provably without seams
 *
 * Pure TypeScript: no GPU, no DOM, no I/O. The Rust engine implements the same
 * model, and these tests are the shared specification.
 */

export * from "./grid.js";
export * from "./state.js";
export * from "./object-index.js";
export * from "./manager.js";
export * from "./composite.js";
