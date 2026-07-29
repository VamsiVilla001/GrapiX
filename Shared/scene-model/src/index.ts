/**
 * `@grapix/scene-model` — incremental scene updates and state separation.
 *
 * `SceneDocument` (in `@grapix/shared-types`) stays the single source of truth
 * for scene content. This package adds the two things a distributed renderer
 * needs on top of it:
 *
 *   patches    revision-gated incremental updates, so a text change is a few
 *              dozen bytes rather than a whole document
 *   revisions  ordered ingestion with duplicate, gap, and conflict detection,
 *              falling back to a full sync rather than ever guessing
 *
 * Plus `separation`, which enforces the rule that no PixiJS, React, DOM, or GPU
 * object may live inside a scene — checked before publishing, not discovered
 * when serialisation fails on the wire.
 */

export * from "./patch.js";
export * from "./revision.js";
export * from "./separation.js";
