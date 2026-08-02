import assert from "node:assert/strict";
import test from "node:test";
import { scrubNumericValue } from "../src/modules/object-manager/services/numericScrub";

test("transform value scrubbing increases and decreases across zero", () => {
  assert.equal(scrubNumericValue(5, 20, 0.1), 7);
  assert.equal(scrubNumericValue(5, -80, 0.1), -3);
});

test("transform value scrubbing supports fine scale adjustments", () => {
  assert.equal(scrubNumericValue(1, -150, 0.01), -0.5);
  assert.equal(scrubNumericValue(1, 20, 0.01, 0.1), 1.02);
});

test("numeric scrubbing only clamps fields with explicit bounds", () => {
  assert.equal(scrubNumericValue(0, -10, 1), -10);
  assert.equal(scrubNumericValue(0, -10, 1, 1, 0, 100), 0);
  assert.equal(scrubNumericValue(95, 10, 1, 1, 0, 100), 100);
});
