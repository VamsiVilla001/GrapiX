/**
 * Promoting a staged AE package into place, and the Windows transient it has to survive.
 *
 * A directory rename fails on Windows while any process holds a handle inside it, and antivirus and
 * the search indexer both open freshly written files to scan them. That surfaced as
 * `EPERM: rename .staging-v001 -> v001` failing one to three tests in `aePackageBuilder.test.mjs`
 * and `aePublishEndToEnd.test.mjs`, about one run in three — and it is not test-only: the same code
 * runs on a real publish, so an operator hits it too.
 *
 * Driven by injected faults rather than by racing a real scanner. The fault never appears on
 * demand, so a test that waited for it would be the flake it is meant to remove.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { promoteDirectory } from "../dist/ae/aePackageBuilder.js";

/** A rename that fails with `code` for its first `failures` calls, then succeeds. */
function flakyRename(code, failures) {
  const state = { calls: 0 };
  return {
    state,
    rename: async () => {
      state.calls += 1;
      if (state.calls <= failures) {
        const error = new Error(`${code}: operation not permitted, rename`);
        error.code = code;
        throw error;
      }
    }
  };
}

const noSleep = async () => {};

test("a promotion that succeeds first time renames once", async () => {
  const { state, rename } = flakyRename("EPERM", 0);
  await promoteDirectory("/staging", "/final", { rename, sleep: noSleep });
  assert.equal(state.calls, 1, "no retry when none is needed");
});

test("a transient EPERM is retried until it succeeds", async () => {
  const { state, rename } = flakyRename("EPERM", 2);
  await promoteDirectory("/staging", "/final", { rename, sleep: noSleep });
  assert.equal(state.calls, 3, "two failures then the successful attempt");
});

test("every transient the scanner produces is retried", async () => {
  for (const code of ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]) {
    const { state, rename } = flakyRename(code, 1);
    await promoteDirectory("/staging", "/final", { rename, sleep: noSleep });
    assert.equal(state.calls, 2, `${code} must be retried`);
  }
});

/**
 * The other half of the policy, and the more important one: retrying an error that will never
 * succeed only delays the report. A cross-device move and an existing destination are both
 * permanent.
 */
test("a permanent error fails immediately without retrying", async () => {
  for (const code of ["EXDEV", "EEXIST", "ENOSPC", "ENOENT"]) {
    const { state, rename } = flakyRename(code, 10);
    await assert.rejects(
      promoteDirectory("/staging", "/final", { rename, sleep: noSleep }),
      (error) => error.code === code
    );
    assert.equal(state.calls, 1, `${code} must not be retried`);
  }
});

test("an error with no code is treated as permanent", async () => {
  let calls = 0;
  await assert.rejects(
    promoteDirectory("/staging", "/final", {
      rename: async () => { calls += 1; throw new Error("something else entirely"); },
      sleep: noSleep
    })
  );
  assert.equal(calls, 1);
});

test("a transient that never clears gives up and reports the original error", async () => {
  const { state, rename } = flakyRename("EPERM", Number.MAX_SAFE_INTEGER);
  await assert.rejects(
    promoteDirectory("/staging", "/final", { rename, sleep: noSleep, backoffMs: [1, 1, 1] }),
    (error) => error.code === "EPERM"
  );
  assert.equal(state.calls, 4, "three retries after the first attempt, then the error stands");
});

test("backoff grows between attempts rather than spinning", async () => {
  const slept = [];
  const { rename } = flakyRename("EPERM", 3);

  await promoteDirectory("/staging", "/final", {
    rename,
    sleep: async (ms) => { slept.push(ms); },
    backoffMs: [25, 50, 100, 200]
  });

  assert.deepEqual(slept, [25, 50, 100], "waits between attempts, increasing");
  assert.ok(
    slept.every((ms, index) => index === 0 || ms > slept[index - 1]),
    "a fixed delay would hammer a handle that needs a moment"
  );
});
