#!/usr/bin/env node
/**
 * AE-A3 live restart-lifecycle runner.
 *
 * Proves the replacement lifecycle contract against the licensed host:
 *   1. the supervisor launches one After Effects with one project and proves identity from
 *      `HEALTH.projectPath` — After Effects' own answer, never the digest the caller declared;
 *   2. in-process project lifecycle is gone: `OPEN_PROJECT` and `CLOSE_PROJECT` refuse
 *      `OPERATION_UNSUPPORTED` through the production client;
 *   3. a project change replaces the process, and the replacement is commandable;
 *   4. shutdown reaches `stopped` with no lifecycle timeout.
 *
 * Every assertion is a throw. A refusal that does not arrive, or a project path that does not
 * match, fails the run rather than being recorded as a pass.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AeRuntimeSupervisor } from "../dist/aeRuntimeSupervisor.js";

const executablePath = process.env.GRAPIX_AE_EXE ?? "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/afterfx.exe";
const installedAdapter = process.env.GRAPIX_AE_INSTALLED_ADAPTER
  ?? "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/Plug-ins/GrapiX/GrapiXRuntimeAdapter.aex";
const initialProject = process.argv[2];
const replacementProject = process.argv[3];
const evidencePath = process.argv[4];
if (!initialProject || !replacementProject) {
  throw new Error("usage: node ae-restart-live.mjs <initial.aep> <replacement.aep> [evidence.json]");
}

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const initialDigest = await digest(initialProject);
const replacementDigest = await digest(replacementProject);
const adapterSha256 = await digest(installedAdapter);

// The adapter reads its own identity from the environment at load, and the supervisor passes its
// environment to the process it launches. Setting it here is what makes the recorded fingerprint a
// real hash instead of the adapter's "not declared" run of zeros.
process.env.GRAPIX_AE_RUNTIME_ADAPTER_SHA256 = adapterSha256;

const normalize = (value) => path.win32.normalize(value).toLowerCase();

const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-ae-restart-live-"));
const supervisor = new AeRuntimeSupervisor({
  dataRoot,
  autoHealth: false,
  maxRestartAttempts: 0,
  projectLoadTimeoutMs: Number(process.env.GRAPIX_AE_PROJECT_LOAD_TIMEOUT_MS ?? 300000)
});

async function proveOpenProject(expectedProject) {
  const health = await supervisor.health();
  if (!health.ok || health.result?.resident !== true) {
    throw new Error(`HEALTH did not prove residency: ${JSON.stringify(health)}`);
  }
  const reported = health.result.projectPath;
  if (!reported || normalize(reported) !== normalize(expectedProject)) {
    throw new Error(`After Effects reports ${reported ?? "no saved project"}, expected ${expectedProject}`);
  }
  return health.result;
}

try {
  const startedStatus = await supervisor.start({
    executablePath, projectPath: initialProject, projectDigest: initialDigest
  });
  if (startedStatus.state !== "ready" || startedStatus.ownership !== "owned") {
    throw new Error(`initial launch did not reach owned/ready: ${JSON.stringify(startedStatus)}`);
  }
  const startedHealth = await proveOpenProject(initialProject);

  // The removed surface, exercised through the production client against the live adapter.
  const refusals = {};
  for (const [operation, payload] of [
    ["OPEN_PROJECT", { projectUri: replacementProject.replaceAll("/", "\\") }],
    ["CLOSE_PROJECT", {}]
  ]) {
    const result = await supervisor.call(operation, payload, { expectedProjectDigest: initialDigest });
    if (result.ok || result.error?.code !== "OPERATION_UNSUPPORTED") {
      throw new Error(`${operation} was not refused as unsupported: ${JSON.stringify(result)}`);
    }
    refusals[operation] = { ok: result.ok, code: result.error.code, message: result.error.message };
  }
  // The host must still be commandable after refusing them: a refusal is not a wedge.
  const afterRefusalHealth = await proveOpenProject(initialProject);

  const restartedStatus = await supervisor.restartWithProject({
    projectPath: replacementProject, projectDigest: replacementDigest
  });
  if (restartedStatus.state !== "ready" || restartedStatus.ownership !== "owned") {
    throw new Error(`replacement launch did not reach owned/ready: ${JSON.stringify(restartedStatus)}`);
  }
  if (restartedStatus.pid === startedStatus.pid) {
    throw new Error(`project change reused pid ${restartedStatus.pid}; it must be a new process`);
  }
  const restartedHealth = await proveOpenProject(replacementProject);
  const compositions = await supervisor.call("LIST_COMPOSITIONS", {});
  if (!compositions.ok || !Array.isArray(compositions.result) || compositions.result.length === 0) {
    throw new Error(`replacement project did not answer discovery: ${JSON.stringify(compositions)}`);
  }

  await supervisor.stop();
  const stoppedStatus = supervisor.status();
  if (stoppedStatus.state !== "stopped" || stoppedStatus.pid !== null) {
    throw new Error(`shutdown did not reach stopped: ${JSON.stringify(stoppedStatus)}`);
  }
  if (stoppedStatus.lastError !== null) {
    throw new Error(`shutdown recorded an error: ${stoppedStatus.lastError}`);
  }

  const evidence = {
    phase: "AE-A3",
    recordedAt: new Date().toISOString(),
    host: {
      afterEffectsVersion: startedStatus.aeBuild,
      os: `${process.platform} ${process.arch}`,
      executablePath
    },
    adapter: {
      file: installedAdapter,
      sha256: adapterSha256,
      reportedAdapterSha256: startedStatus.adapterSha256,
      protocolMajor: 2,
      faultInjection: null
    },
    projects: {
      initial: { path: initialProject, sha256: initialDigest },
      replacement: { path: replacementProject, sha256: replacementDigest }
    },
    initialLaunch: {
      pid: startedStatus.pid,
      state: startedStatus.state,
      ownership: startedStatus.ownership,
      reportedProjectPath: startedHealth.projectPath,
      lastSuccessfulCommand: startedStatus.lastSuccessfulCommand
    },
    removedLifecycleSurface: {
      refusals,
      hostStillCommandable: { reportedProjectPath: afterRefusalHealth.projectPath }
    },
    projectReplacement: {
      pid: restartedStatus.pid,
      previousPid: startedStatus.pid,
      state: restartedStatus.state,
      ownership: restartedStatus.ownership,
      reportedProjectPath: restartedHealth.projectPath,
      projectDigest: restartedStatus.projectDigest,
      compositions: compositions.result.map((entry) => ({
        itemId: entry.itemId, displayName: entry.displayName, clock: entry.clock ?? null
      }))
    },
    shutdown: {
      state: stoppedStatus.state,
      pid: stoppedStatus.pid,
      crashCount: stoppedStatus.crashCount,
      lastError: stoppedStatus.lastError
    },
    verdict: {
      outcome: "pass",
      claim: "On licensed After Effects 26.3, project changes are supervisor-owned process replacements: each launch proves its project from AEGP_GetProjectPath, the removed in-process lifecycle operations refuse OPERATION_UNSUPPORTED without wedging the host, the replacement process answers discovery, and shutdown reaches stopped with no lifecycle timeout.",
      doesNotClaim: "AEGP_OpenProjectFromPath became safe, After Effects startup modals are cleared by the supervisor itself, a fingerprint-keyed capability matrix exists (AE-A4), or that any frame was rendered."
    }
  };
  const recorded = JSON.stringify(evidence, null, 2);
  if (evidencePath) await writeFile(evidencePath, `${recorded}\n`);
  console.log(recorded);
} finally {
  await supervisor.stop().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}
