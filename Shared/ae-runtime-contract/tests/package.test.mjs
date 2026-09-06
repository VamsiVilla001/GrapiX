import assert from "node:assert/strict";
import test from "node:test";
import {
  AE_PACKAGE_PATHS,
  AE_PACKAGE_SCHEMA_VERSION,
  AePackageError,
  aeVersionDirectory,
  buildAePublishValidation,
  parseAeVersionDirectory
} from "../dist/index.js";

/**
 * The published-package contract's live logic.
 *
 * Only three things here execute — version naming, version parsing, and how findings become a
 * verdict — and each of them decides something an operator acts on: which directory a publish
 * lands in, which directories count as versions at all, and whether a graphic may go on air.
 */

test("a version becomes a zero-padded directory that sorts correctly", () => {
  // Padding is not cosmetic: unpadded, a directory listing puts v10 before v2, and "the latest
  // version" read off a sorted listing would be wrong from the tenth publish onward.
  assert.equal(aeVersionDirectory(1), "v001");
  assert.equal(aeVersionDirectory(2), "v002");
  assert.equal(aeVersionDirectory(999), "v999");

  const sorted = [1, 2, 10, 100].map(aeVersionDirectory).sort();
  assert.deepEqual(sorted, ["v001", "v002", "v010", "v100"]);
});

test("a version past three digits keeps growing rather than truncating", () => {
  // Truncating would collide v1000 with an existing directory, and a publish that silently
  // overwrites is the one thing an immutable package must never do.
  assert.equal(aeVersionDirectory(1000), "v1000");
});

test("a version that is not a positive integer is refused", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => aeVersionDirectory(bad), AePackageError, `${bad} must be refused`);
  }
});

test("only a real version directory parses, so a stray folder is not mistaken for one", () => {
  assert.equal(parseAeVersionDirectory("v001"), 1);
  assert.equal(parseAeVersionDirectory("v042"), 42);
  assert.equal(parseAeVersionDirectory("v1000"), 1000);

  // Anything else is someone's notes, a backup, or a temp directory — not a version.
  for (const name of ["v1", "v01", "V001", "draft", "v001-old", "v001.bak", "", "v", "vabc", "v000"]) {
    assert.equal(parseAeVersionDirectory(name), null, `${name} must not parse as a version`);
  }
});

test("version naming and parsing round-trip", () => {
  for (const version of [1, 7, 99, 100, 500, 1234]) {
    assert.equal(parseAeVersionDirectory(aeVersionDirectory(version)), version);
  }
});

test("a validation is ready only when nothing refused; warnings never block", () => {
  const clean = buildAePublishValidation([], []);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.counts, { refusals: 0, warnings: 0 });

  // A third-party plugin is worth saying and must not stop a publish — the plan's READY banner
  // reads `ok` alone, so a warning that blocked would be indistinguishable from a refusal.
  const warned = buildAePublishValidation([], [
    { code: "THIRD_PARTY_PLUGIN", message: "Layer 'Glow' uses Example Plugin" }
  ]);
  assert.equal(warned.ok, true);
  assert.equal(warned.counts.warnings, 1);

  const refused = buildAePublishValidation(
    [{ code: "MISSING_FOOTAGE", message: "intro.mov was not found", subject: "intro.mov" }],
    [{ code: "NO_THUMBNAIL", message: "no thumbnail was rendered" }]
  );
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.counts, { refusals: 1, warnings: 1 });
  // The refusal keeps the subject, because "missing footage" without the filename is not a report.
  assert.equal(refused.refusals[0].subject, "intro.mov");
});

test("the package layout is fixed, relative and POSIX", () => {
  // An absolute or backslash path here would leak the publishing machine's filesystem into a
  // package meant to be portable.
  for (const value of Object.values(AE_PACKAGE_PATHS)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
    assert.ok(!value.startsWith("/"), `${value} must be relative`);
    assert.ok(!/^[A-Za-z]:/.test(value), `${value} must not be absolute`);
    assert.ok(!value.includes("\\"), `${value} must use POSIX separators`);
  }

  // Playout reads these four by name; renaming one is a package-format break, so they are pinned.
  assert.equal(AE_PACKAGE_PATHS.manifest, "grapix/manifest.json");
  assert.equal(AE_PACKAGE_PATHS.controls, "grapix/controls.json");
  assert.equal(AE_PACKAGE_PATHS.animations, "grapix/animations.json");
  assert.equal(AE_PACKAGE_PATHS.dependencies, "grapix/dependencies.json");
  assert.equal(AE_PACKAGE_SCHEMA_VERSION, 1);
});
