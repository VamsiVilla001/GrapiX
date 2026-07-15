// Emits the TypeScript contract fixtures to JSON for non-TypeScript
// consumers (the Rust render daemon's contract tests).
//
// Usage:
//   npm run fixtures:emit  -w @grapix/shared-types   (build + write JSON)
//   npm run fixtures:check -w @grapix/shared-types   (verify committed JSON is current)
//
// The .ts fixture is the source of truth (compile-time checked against
// SceneDocument); the emitted JSON is committed so Rust tests never need a
// Node toolchain to run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(packageRoot, "fixtures");
const outputPath = path.join(fixturesDir, "scene-document.v1.json");
const checkMode = process.argv.includes("--check");

const { sceneDocumentContractFixtureV1 } = await import(
  new URL("../dist/fixtures.js", import.meta.url).href
);

const json = `${JSON.stringify(sceneDocumentContractFixtureV1, null, 2)}\n`;

if (checkMode) {
  const committed = await readFile(outputPath, "utf8").catch(() => null);

  if (committed !== json) {
    console.error(
      `fixtures out of date: ${path.relative(packageRoot, outputPath)} does not match src/fixtures.ts.\n` +
        "Run: npm run fixtures:emit -w @grapix/shared-types"
    );
    process.exit(1);
  }

  console.log("fixtures up to date");
} else {
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(outputPath, json);
  console.log(`wrote ${path.relative(packageRoot, outputPath)}`);
}
