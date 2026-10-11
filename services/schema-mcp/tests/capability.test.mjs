// Tests for the schema-mcp capability surface (Part D, principle 2).
//
// Runs against the compiled output. `npm run typecheck` must run first.
//
// These used to assert against lists this package maintained by hand. They now
// assert against the surface generated from the Rust contracts (build plan
// 8.1), which means they test that discovery *works* rather than that two
// copies of a list agree — the second being a test that could only ever pass.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  capabilities,
  enumValues,
  getCapabilitySurface,
  reachableWith,
  refusalCodes,
  status,
  tools,
} from "../dist/index.js";

test("the surface is read-only by construction", () => {
  assert.equal(capabilities.mutation, false);
  assert.equal(status, "Partial");
});

test("the schema version travels with headless-rendering protocol v5", () => {
  assert.equal(SCHEMA_VERSION, 5);
  assert.equal(getCapabilitySurface().protocolVersion, 5);
});

test("capability discovery enumerates the supported enums as data", () => {
  // Device tiers include T0, the only tier that may go to air (invariant 19).
  assert.deepEqual(enumValues("DeviceTier"), ["T0", "T1", "T2", "T3"]);

  // Clock sources include FreeRun, which must never be hidden (invariant 11).
  assert.ok(enumValues("ClockSource")?.includes("FreeRun"));

  // Reference states distinguish Unlocked from NotPresent: one is a fault, the
  // other a configuration.
  assert.deepEqual(enumValues("ReferenceState"), [
    "Locked",
    "Unlocked",
    "NotPresent",
  ]);

  // Locality is declared, not probed (ADR-001 action 2).
  assert.deepEqual(enumValues("Locality"), ["CoLocated", "Lan"]);
});

test("the surface reports wire values, not plausible spellings of them", () => {
  // The regression that motivated generating this: the hand-written list said
  // `cap-total` while the contract emits `capTotal`, so an agent that trusted
  // discovery sent a value the contract refuses.
  assert.ok(enumValues("Stagger")?.includes("capTotal"));
  assert.ok(!enumValues("Stagger")?.includes("cap-total"));

  // Blend modes rename to kebab-case, so both conventions appear in the same
  // surface and neither can be assumed.
  assert.ok(enumValues("BlendMode")?.includes("alpha-mask"));
});

test("refusals are named so a caller can act on them", () => {
  const codes = refusalCodes();
  for (const code of [
    "tierTooLow",
    "referenceUnlocked",
    "frameNotReachable",
    "unauthenticated",
  ]) {
    assert.ok(codes.includes(code), `expected refusal ${code} to be discoverable`);
  }
});

test("the design-system motion schema is discoverable", () => {
  // G.6.3: the operator phases a preset participates in. `in` and `out` are
  // required; `update` is the one that is forgotten and then hurts.
  const phases = enumValues("MotionPhase") ?? [];
  for (const phase of ["in", "hold", "continue", "out", "update"]) {
    assert.ok(phases.includes(phase), `expected motion phase ${phase}`);
  }
});

test("every tool declares the scope it requires", () => {
  // 8.13's client-side half: an agent can see what a tool will demand before
  // it asks, so it never sends a call it knows will be refused.
  for (const tool of tools()) {
    assert.ok(tool.name.startsWith(`${tool.group}.`));
    if (tool.requiredScope === null) {
      assert.equal(
        tool.name,
        "system.capability",
        "only capability discovery may be unscoped",
      );
    }
  }
});

test("an author token cannot reach Program or outputs", () => {
  // ADR-0002 D.3: "A design-scope token must never reach playout.take or
  // outputs.configure." The automation pipeline publishes drafts; a human
  // takes them to air.
  const names = reachableWith(["author"]).map((tool) => tool.name);

  assert.ok(names.includes("scenes.create"));
  assert.ok(names.includes("packages.publish"));
  assert.ok(!names.includes("playout.take"));
  assert.ok(!names.includes("outputs.configure"));
});
