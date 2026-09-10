// Tests for the schema-mcp capability surface (Part D, principle 2).
//
// Runs against the compiled output. `npm run typecheck` must run first.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  capabilities,
  getCapabilitySurface,
  status,
} from "../dist/index.js";

test("the surface is read-only by construction", () => {
  assert.equal(capabilities.mutation, false);
  assert.equal(status, "Partial");
});

test("the schema version travels with protocol v3", () => {
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(getCapabilitySurface().schemaVersion, 3);
});

test("capability discovery enumerates the supported enums as data", () => {
  const surface = getCapabilitySurface();

  // Device tiers include T0, the only tier that may go to air (invariant 19).
  assert.deepEqual(
    surface.deviceTiers.map((t) => t.value),
    ["T0", "T1", "T2", "T3"],
  );

  // Clock sources include FreeRun, which must never be hidden (invariant 11).
  assert.ok(surface.clockSources.some((c) => c.value === "FreeRun"));

  // Reference states distinguish Unlocked from NotPresent: one is a fault, the
  // other a configuration.
  assert.deepEqual(
    surface.referenceStates.map((r) => r.value),
    ["Locked", "Unlocked", "NotPresent"],
  );

  // Locality is declared, not probed (ADR-001 action 2).
  assert.deepEqual(
    surface.localities.map((l) => l.value),
    ["CoLocated", "Lan"],
  );
});

test("refusals are named so a caller can act on them", () => {
  const surface = getCapabilitySurface();
  // The refusals that gate live output and intent must be discoverable.
  for (const code of [
    "tierTooLow",
    "referenceUnlocked",
    "frameNotReachable",
    "unauthenticated",
  ]) {
    assert.ok(
      surface.refusals.includes(code),
      `expected refusal ${code} to be discoverable`,
    );
  }
});

test("the design-system motion schema is discoverable", () => {
  const surface = getCapabilitySurface();
  // G.6.3: the operator phases a preset participates in. `in` and `out` are
  // required; `update` is the one that is forgotten and then hurts.
  assert.deepEqual(surface.designSystem.motionPhases, [
    "in",
    "hold",
    "continue",
    "out",
    "update",
  ]);
  // G.6.5: count-adaptive stagger modes, cap-total the default for rosters.
  assert.deepEqual(surface.designSystem.staggerModes, [
    "fixed",
    "cap-total",
    "overlap",
  ]);
});
