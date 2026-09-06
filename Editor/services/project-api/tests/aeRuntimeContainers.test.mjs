import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authenticatedInject } from "./authHelpers.mjs";

const TEST_SIGNING_SECRET = "test-signing-secret-that-is-long-enough-for-auth";

function request(projectDigest, overrides = {}) {
  return {
    id: "lower-third",
    name: "Lower Third",
    projectUri: "show/lower-third.aep",
    projectDigest,
    profile: {
      aeVersion: "26.3",
      renderer: "Advanced 3D",
      workingColorSpace: "sRGB IEC61966-2.1",
      frameRate: "30000/1001"
    },
    compositions: [{ itemId: 1, name: "LOWER_THIRD", width: 1920, height: 1080, clock: { frameDuration: "1001", timeScale: "30000" } }],
    cachePolicy: { mode: "bounded", maxPreparedFrames: 3 },
    ...overrides
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-ae-container-"));
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "projects");
  const projectDir = path.join(projectRoot, "show");
  await mkdir(projectDir, { recursive: true });
  const bytes = Buffer.from("RIFX pinned fixture bytes");
  await writeFile(path.join(projectDir, "lower-third.aep"), bytes);
  process.env.GRAPIX_DATA_ROOT = dataRoot;
  process.env.GRAPIX_AE_PROJECT_ROOTS = projectRoot;
  const { createApiServer } = await import(`../dist/index.js?root=${encodeURIComponent(root)}`);
  const server = await createApiServer({ logger: false, signingSecret: TEST_SIGNING_SECRET });
  return {
    root,
    projectDir,
    server,
    inject: await authenticatedInject(server),
    password: server.bootstrapAdminPassword,
    digest: createHash("sha256").update(bytes).digest("hex")
  };
}

async function cleanup(state) {
  await state.server.close();
  delete process.env.GRAPIX_DATA_ROOT;
  delete process.env.GRAPIX_AE_PROJECT_ROOTS;
  await rm(state.root, { recursive: true, force: true });
}

test("container sidecar survives restart with stable relative identity", async () => {
  const state = await fixture();
  try {
    const created = await state.inject({
      method: "POST",
      url: "/api/ae-runtime/containers",
      payload: request(state.digest)
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().container.projectUri, "show/lower-third.aep");
    assert.equal(created.json().container.compositions[0].itemId, 1);

    const sidecar = JSON.parse(await readFile(
      path.join(state.projectDir, ".grapix", "ae-runtime", "lower-third", "container.json"),
      "utf8"
    ));
    assert.equal(sidecar.projectDigest, state.digest);

    await state.server.close();
    const { createApiServer } = await import(`../dist/index.js?restart=${Date.now()}`);
    state.server = await createApiServer({ logger: false, signingSecret: TEST_SIGNING_SECRET });
    const login = await state.server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { identifier: "admin", password: state.password }
    });
    assert.equal(login.statusCode, 200, login.body);
    const token = login.json().accessToken;
    state.inject = (options) => state.server.inject({
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) }
    });
    const reopened = await state.inject({ method: "GET", url: "/api/ae-runtime/containers/lower-third" });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().container.id, "lower-third");
    assert.equal(reopened.json().container.compositions[0].itemId, 1);
  } finally {
    await cleanup(state);
  }
});

test("traversal and digest mismatch are refused before a sidecar exists", async () => {
  const state = await fixture();
  try {
    const traversal = await state.inject({
      method: "POST",
      url: "/api/ae-runtime/containers",
      payload: request(state.digest, { id: "traversal", projectUri: "../outside.aep" })
    });
    assert.equal(traversal.statusCode, 400, traversal.body);
    assert.equal(traversal.json().code, "INVALID_PROJECT_URI");

    const mismatch = await state.inject({
      method: "POST",
      url: "/api/ae-runtime/containers",
      payload: request("0".repeat(64), { id: "mismatch" })
    });
    assert.equal(mismatch.statusCode, 409, mismatch.body);
    assert.equal(mismatch.json().code, "PROJECT_DIGEST_MISMATCH");

    await assert.rejects(readFile(path.join(state.projectDir, ".grapix", "ae-runtime", "mismatch", "container.json")));
  } finally {
    await cleanup(state);
  }
});

test("changed authoritative project bytes block reads", async () => {
  const state = await fixture();
  try {
    const created = await state.inject({
      method: "POST",
      url: "/api/ae-runtime/containers",
      payload: request(state.digest)
    });
    assert.equal(created.statusCode, 201, created.body);
    await writeFile(path.join(state.projectDir, "lower-third.aep"), "designer changed project");
    const response = await state.inject({ method: "GET", url: "/api/ae-runtime/containers/lower-third" });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "PROJECT_DIGEST_MISMATCH");
  } finally {
    await cleanup(state);
  }
});

test("an allowlisted root with no containers lists empty rather than refusing", async () => {
  // The state a packaged Editor now starts in: it provisions one project root of its own, so the AE
  // Controls panel must show "no containers" instead of an environment-variable error. Before the root
  // was provisioned this request answered AE_PROJECT_ROOT_NOT_CONFIGURED and the panel was unusable.
  const state = await fixture();
  try {
    const listed = await state.inject({ method: "GET", url: "/api/ae-runtime/containers" });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().containers, []);
  } finally {
    await cleanup(state);
  }
});

test("no allowlisted root refuses with the remedy, not just a variable name", async () => {
  const state = await fixture();
  try {
    // Read at call time, so clearing it here is enough to reach the refusal path.
    delete process.env.GRAPIX_AE_PROJECT_ROOTS;
    const listed = await state.inject({ method: "GET", url: "/api/ae-runtime/containers" });
    assert.equal(listed.json().code, "AE_PROJECT_ROOT_NOT_CONFIGURED");
    // This string is what the AE connector renders verbatim, so it has to be operator-readable.
    const message = listed.json().error;
    // The primary remedy is now an action the author can take in the panel: choose a project. The
    // environment variable survives as the facility-wide option, so it is still named — but a
    // restart is no longer part of the answer, because a chosen project takes effect immediately.
    assert.match(message, /choose/i);
    assert.match(message, /\.aep/);
    assert.match(message, /GRAPIX_AE_PROJECT_ROOTS/);
    assert.doesNotMatch(message, /restart/i);
  } finally {
    await cleanup(state);
  }
});
