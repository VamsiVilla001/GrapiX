import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Choosing a project is what makes it readable.
 *
 * The allowlist is what stops a crafted `projectUri` reading arbitrary files, and it used to be
 * fillable only by an environment variable set before the service started. These pin the replacement:
 * an author's explicit choice adds to the allowlist, it survives a restart, and it widens the reach
 * by exactly one folder of `.aep` files and nothing else.
 */
const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-ae-registry-"));
const projectDir = await mkdtemp(path.join(tmpdir(), "grapix-ae-chosen-"));
process.env.GRAPIX_DATA_ROOT = dataRoot;
delete process.env.GRAPIX_AE_PROJECT_ROOTS;

const storage = await import("../dist/storage.js");

test.after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

const projectPath = path.join(projectDir, "Chosen.aep");
await writeFile(projectPath, Buffer.from("RIFX....Egg! bytes"));

test("nothing is readable before a project is chosen", () => {
  assert.deepEqual(storage.configuredAeProjectRoots(), []);
  assert.throws(
    () => storage.resolveAeProjectUri("Chosen.aep"),
    (error) => error.code === "AE_PROJECT_ROOT_NOT_CONFIGURED"
  );
});

test("choosing a project registers the folder that holds it, and persists", async () => {
  const registered = await storage.registerAeProjectPath(projectPath);
  assert.equal(registered.projectUri, "Chosen.aep");
  assert.equal(path.resolve(registered.root), path.resolve(projectDir));

  // Now resolvable, and pointing at the real file.
  const resolved = storage.resolveAeProjectUri("Chosen.aep");
  assert.equal(path.resolve(resolved.projectPath), path.resolve(projectPath));

  // Remembered, so the author does not choose it again after a restart.
  const saved = JSON.parse(await readFile(path.join(dataRoot, "ae-project-roots.json"), "utf8"));
  assert.equal(saved.roots.length, 1);
  assert.equal(path.resolve(saved.roots[0]), path.resolve(projectDir));
});

test("choosing the same project twice does not duplicate the root", async () => {
  await storage.registerAeProjectPath(projectPath);
  // A duplicated root makes the browser list every project in it twice.
  assert.equal(storage.configuredAeProjectRoots().length, 1);
});

test("only an .aep that exists can be chosen", async () => {
  const notAProject = path.join(projectDir, "notes.txt");
  await writeFile(notAProject, "x");
  await assert.rejects(
    () => storage.registerAeProjectPath(notAProject),
    (error) => error.code === "INVALID_PROJECT_URI"
  );
  await assert.rejects(
    () => storage.registerAeProjectPath(path.join(projectDir, "ghost.aep")),
    (error) => error.code === "PROJECT_NOT_FOUND"
  );
  // A directory is not a project, even one named like it.
  await assert.rejects(
    () => storage.registerAeProjectPath(projectDir),
    (error) => error.code === "INVALID_PROJECT_URI"
  );
});

test("registering widens the reach by one folder of .aep files, and nothing more", () => {
  // Traversal out of the registered root stays refused...
  for (const attempt of ["../escape.aep", "../../secrets.aep", "sub/../../out.aep"]) {
    assert.throws(() => storage.resolveAeProjectUri(attempt), (error) => error.code === "INVALID_PROJECT_URI");
  }
  // ...an absolute path is not a project URI at all...
  assert.throws(() => storage.resolveAeProjectUri(projectPath), (error) => error.code === "INVALID_PROJECT_URI");
  // ...and nothing but an .aep resolves, so a wide root still cannot read a document or a key.
  assert.throws(() => storage.resolveAeProjectUri("notes.txt"), (error) => error.code === "INVALID_PROJECT_URI");
});

test("forgetting a root stops the project being readable", async () => {
  await storage.forgetAeProjectRoot(projectDir);
  assert.deepEqual(storage.configuredAeProjectRoots(), []);
  assert.throws(
    () => storage.resolveAeProjectUri("Chosen.aep"),
    (error) => error.code === "AE_PROJECT_ROOT_NOT_CONFIGURED"
  );
});
