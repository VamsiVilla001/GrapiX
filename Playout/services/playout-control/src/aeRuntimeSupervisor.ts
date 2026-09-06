import {
  AeRuntimeProtocolError,
  type AeRuntimeEvent,
  type AeRuntimeHealthResult,
  type AeRuntimeHelloAck,
  type AeRuntimeOperation,
  type AeRuntimeResult
} from "@grapix/adobe-common-schema";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AeRuntimeClient } from "./aeRuntimeClient.js";
import type { DiagnosticsLog } from "./diagnostics.js";

export type AeRuntimeLifecycleState = "stopped" | "starting" | "loading" | "ready" | "degraded" | "failed";

export interface AeRuntimeSupervisorStatus {
  state: AeRuntimeLifecycleState;
  pid: number | null;
  ownership: "owned" | "attached" | null;
  aeBuild: string | null;
  adapterSha256: string | null;
  pluginSetSha256: string | null;
  projectDigest: string | null;
  activeCompositionItemId: number | null;
  lastSuccessfulCommand: string | null;
  lastSuccessfulRevision: number | null;
  lastReadinessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  latencyMs: number[];
  crashCount: number;
  remedy: string | null;
  lastFrameId: null;
}

export interface AeRuntimeLaunchOptions {
  executablePath?: string;
  projectPath?: string;
  projectDigest?: string;
  sessionId?: string;
  token?: string;
  attach?: boolean;
}
export interface AeRuntimeProjectLaunch {
  projectPath: string;
  projectDigest: string;
}

export interface AeRuntimeSupervisorOptions {
  dataRoot: string;
  diagnostics?: DiagnosticsLog;
  autoHealth?: boolean;
  healthIntervalMs?: number;
  commandDeadlineMs?: number;
  maxRestartAttempts?: number;
  projectLoadTimeoutMs?: number;
  spawnProcess?: typeof spawn;
  clientFactory?: (options: ConstructorParameters<typeof AeRuntimeClient>[0]) => AeRuntimeClient;
}


export class AeRuntimeSupervisor {
  private readonly diagnostics: DiagnosticsLog | undefined;
  private readonly healthIntervalMs: number;
  private readonly commandDeadlineMs: number;
  private readonly maxRestartAttempts: number;
  private readonly projectLoadTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private readonly clientFactory: NonNullable<AeRuntimeSupervisorOptions["clientFactory"]>;
  private client: AeRuntimeClient | null = null;
  private child: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private launchOptions: AeRuntimeLaunchOptions | null = null;
  private stoppedExplicitly = true;
  private restartAttempts = 0;
  private statusValue: AeRuntimeSupervisorStatus = emptyStatus();
  private stopping = false;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(private readonly options: AeRuntimeSupervisorOptions) {
    this.diagnostics = options.diagnostics;
    this.healthIntervalMs = options.healthIntervalMs ?? 2_000;
    this.commandDeadlineMs = options.commandDeadlineMs ?? 1_500;
    this.projectLoadTimeoutMs = options.projectLoadTimeoutMs ?? 30_000;
    this.maxRestartAttempts = options.maxRestartAttempts ?? 5;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new AeRuntimeClient(clientOptions));
  }

  status(): AeRuntimeSupervisorStatus {
    return { ...this.statusValue, latencyMs: [...this.statusValue.latencyMs] };
  }

  async start(options: AeRuntimeLaunchOptions = {}): Promise<AeRuntimeSupervisorStatus> {
    return this.startInternal(options, true);
  }

  private async startInternal(options: AeRuntimeLaunchOptions, resetRestartBudget: boolean): Promise<AeRuntimeSupervisorStatus> {
    await validateProjectLaunch(options);
    const crashCount = this.statusValue.crashCount;
    const restartAttempts = this.restartAttempts;
    await this.stop(false, true);
    if (resetRestartBudget) this.restartAttempts = 0;
    else this.restartAttempts = restartAttempts;
    this.stoppedExplicitly = false;
    this.launchOptions = options;
    this.statusValue = {
      ...emptyStatus(),
      state: "starting",
      ownership: options.attach ? "attached" : "owned",
      projectDigest: options.projectDigest ?? null,
      crashCount
    };
    const sessionId = options.sessionId ?? randomUUID();
    const token = options.token ?? randomBytes(32).toString("hex");
    const claim = { sessionId, pid: null as number | null, ownership: options.attach ? "attached" : "owned", startedAt: new Date().toISOString() };

    if (!options.attach) {
      const executable = options.executablePath ?? process.env.GRAPIX_AE_EXE ?? "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/afterfx.exe";
      const args = options.projectPath ? [options.projectPath] : [];
      this.child = this.spawnProcess(executable, args, {
        windowsHide: false,
        detached: false,
        stdio: "ignore",
        env: {
          ...process.env,
          GRAPIX_AE_RUNTIME_SESSION_ID: sessionId,
          GRAPIX_AE_RUNTIME_TOKEN: token
        }
      });
      claim.pid = this.child.pid ?? null;
      this.statusValue.pid = claim.pid;
      this.child.once("exit", (code, signal) => this.onProcessExit(code, signal));
    }
    await mkdir(this.options.dataRoot, { recursive: true });
    await writeFile(path.join(this.options.dataRoot, "ae-runtime-claim.json"), `${JSON.stringify(claim, null, 2)}\n`);
    this.statusValue.state = "loading";
    this.client = this.clientFactory({ sessionId, token, connectTimeoutMs: 10_000 });
    this.unsubscribeEvents = this.client.onEvent((event) => this.onEvent(event));
    this.client.on("close", () => this.onPipeLoss());
    try {
      // The adapter only starts its pipe after AE loads plugins and fires the first idle hook.
      // That is a startup delay, not a failure, so budget the full project-load window for it.
      const hello = await this.connectWhenPipeReady(options.attach ? 10_000 : this.projectLoadTimeoutMs);
      if (claim.pid !== null && hello.hostPid !== claim.pid) {
        this.statusValue.ownership = "attached";
      }
      this.applyHello(hello);
      await this.awaitReadiness(options.projectPath);
      if (resetRestartBudget) this.restartAttempts = 0;
      if (this.options.autoHealth !== false) {
        this.healthTimer = setInterval(() => void this.health().catch(() => undefined), this.healthIntervalMs);
        this.healthTimer.unref();
      }
      return this.status();
    } catch (error) {
      this.fail("The After Effects runtime did not become commandable", error);
      this.scheduleRestart();
      throw error;
    }
  }

  async health(): Promise<AeRuntimeResult<AeRuntimeHealthResult>> {
    const started = performance.now();
    try {
      const result = await this.probeHealth();
      const actualProjectPath = result.result?.projectPath ?? null;
      const expectedProjectPath = this.launchOptions?.projectPath;
      if (expectedProjectPath && (!actualProjectPath || !this.assertProjectIdentity(actualProjectPath, expectedProjectPath))) {
        throw new Error(`After Effects opened ${actualProjectPath} instead of ${expectedProjectPath}`);
      }
      this.markHealthy(performance.now() - started);
      return result;
    } catch (error) {
      this.statusValue.state = "degraded";
      this.statusValue.lastFailureAt = new Date().toISOString();
      this.statusValue.lastError = messageOf(error);
      this.statusValue.remedy = "Check startup modal dialogs, the open project identity, and adapter load diagnostics; GrapiX will retry with bounded backoff.";
      this.scheduleRestart();
      throw error;
    }
  }

  async call<TResult = unknown, TPayload = unknown>(
    operation: AeRuntimeOperation,
    payload: TPayload,
    options: { deadlineMs?: number; idempotencyKey?: string; expectedProjectDigest?: string | null; revision?: number } = {}
  ): Promise<AeRuntimeResult<TResult>> {
    const started = performance.now();
    const expectedProjectDigest = options.expectedProjectDigest ?? this.statusValue.projectDigest;
    if (operation === "SET_PROPERTY" || operation === "APPLY_DATA_REVISION") {
      if (!expectedProjectDigest) {
        throw new AeRuntimeProtocolError("PROJECT_DIGEST_MISMATCH", "mutating runtime calls require a pinned project digest");
      }
      await this.verifyPinnedProjectDigest(expectedProjectDigest);
    }
    const result = await this.requireClient().call<TResult, TPayload>(operation, payload, {
      deadlineMs: options.deadlineMs ?? this.commandDeadlineMs,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      expectedProjectDigest
    });
    if (result.ok) {
      this.statusValue.lastSuccessfulCommand = operation;
      if (options.revision !== undefined) this.statusValue.lastSuccessfulRevision = options.revision;
      this.recordLatency(performance.now() - started);
    }
    return result;
  }

  /**
   * Change projects by replacing the owned After Effects process. The adapter is never asked to
   * open or close a project: that SDK route can wedge AE after reporting success.
   */
  async restartWithProject(project: AeRuntimeProjectLaunch): Promise<AeRuntimeSupervisorStatus> {
    if (this.statusValue.ownership !== "owned" || !this.launchOptions) {
      throw new Error("Project replacement requires a running supervisor-owned After Effects process");
    }
    await this.startInternal({
      ...(this.launchOptions.executablePath ? { executablePath: this.launchOptions.executablePath } : {}),
      projectPath: project.projectPath,
      projectDigest: project.projectDigest
    }, true);
    return this.status();
  }

  async stop(explicit = true, preserveRestartTimer = false): Promise<void> {
    if (explicit) this.stoppedExplicitly = true;
    this.stopping = true;
    try {
      if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
      if (this.restartTimer && !preserveRestartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
      const client = this.client;
      this.client = null;
      this.unsubscribeEvents?.();
      this.unsubscribeEvents = null;
      if (client) {
        try { await client.call("SHUTDOWN", {}, { deadlineMs: 500 }); } catch { /* channel already lost */ }
        await client.close().catch(() => undefined);
      }
      const child = this.child;
      this.child = null;
      if (child && this.statusValue.ownership === "owned" && child.exitCode === null) {
        child.kill("SIGTERM");
        const exited = Promise.withResolvers<void>();
        child.once("exit", exited.resolve);
        const force = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000);
        force.unref();
        await exited.promise;
        clearTimeout(force);
      }
      if (explicit) this.statusValue = { ...this.statusValue, state: "stopped", pid: null, lastFrameId: null };
    } finally {
      this.stopping = false;
    }
  }

  async readCrashState(): Promise<unknown | null> {
    try { return JSON.parse(await readFile(path.join(this.options.dataRoot, "ae-runtime-crash.json"), "utf8")); }
    catch { return null; }
  }

  private applyHello(hello: AeRuntimeHelloAck): void {
    this.statusValue.pid = hello.hostPid;
    this.statusValue.aeBuild = hello.fingerprint.aeVersion;
    this.statusValue.adapterSha256 = hello.fingerprint.adapterSha256;
    this.statusValue.pluginSetSha256 = hello.fingerprint.pluginSetSha256;
  }

  private onPipeLoss(): void {
    if (this.stoppedExplicitly || this.stopping) return;
    this.statusValue.state = "degraded";
    this.statusValue.lastFailureAt = new Date().toISOString();
    this.statusValue.lastError = "runtime pipe closed";
    this.scheduleRestart();
  }

  private onEvent(event: AeRuntimeEvent): void {
    if (event.event === "RUNTIME_READY") {
      if (!this.launchOptions?.projectPath) {
        this.statusValue.state = "ready";
        this.statusValue.lastReadinessAt = event.at;
        this.statusValue.lastError = null;
        this.statusValue.remedy = null;
      }
      return;
    }
    if (event.event === "RUNTIME_DEGRADED") {
      this.statusValue.state = "degraded";
      this.statusValue.lastFailureAt = event.at;
      this.statusValue.lastError = event.detail.reason;
      this.statusValue.remedy = "Check the After Effects runtime diagnostics and restore the command channel.";
      return;
    }
  }



  private async connectWhenPipeReady(timeoutMs: number): Promise<AeRuntimeHelloAck> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = new Error("After Effects runtime pipe did not become available");
    do {
      try {
        if (!this.client) throw new Error("After Effects runtime client was stopped before connection");
        return await this.client.connect();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ENOENT means the pipe doesn't exist yet; PROTOCOL_INCOMPATIBLE means the old adapter
        // is still running — either way the new one hasn't loaded, so keep waiting.
        if (code === "ENOENT" || code === "PROTOCOL_INCOMPATIBLE") {
          lastError = error;
        } else {
          throw error;
        }
      }
      if (Date.now() >= deadline) break;
      await delay(500);
    } while (true);
    throw lastError;
  }

  private async probeHealth(): Promise<AeRuntimeResult<AeRuntimeHealthResult>> {
    const result = await this.requireClient().call<AeRuntimeHealthResult>("HEALTH", {}, {
      deadlineMs: this.commandDeadlineMs
    });
    if (!result.ok) throw new Error(result.error?.message ?? "runtime health refused");
    return result;
  }

  private async awaitReadiness(expectedProjectPath?: string): Promise<AeRuntimeResult<AeRuntimeHealthResult>> {
    const started = performance.now();
    const deadline = Date.now() + (expectedProjectPath ? this.projectLoadTimeoutMs : this.commandDeadlineMs);
    let lastError: unknown = new Error("After Effects did not report readiness");
    do {
      try {
        const result = await this.probeHealth();
        const actualProjectPath = result.result?.projectPath ?? null;
        // During a project load, AE can answer before the target document is open. Only the target
        // path is proof of readiness; any other answer is treated as still-loading until the deadline.
        if (!expectedProjectPath || (actualProjectPath !== null && this.assertProjectIdentity(actualProjectPath, expectedProjectPath))) {
          this.markHealthy(performance.now() - started);
          return result;
        }
        lastError = new Error(`After Effects opened ${actualProjectPath ?? "no saved project"} instead of ${expectedProjectPath}`);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await delay(100);
    } while (true);
    throw lastError;
  }

  private assertProjectIdentity(actualProjectPath: string, expectedProjectPath?: string): boolean {
    if (!expectedProjectPath) return true;
    return normalizeProjectPath(actualProjectPath) === normalizeProjectPath(expectedProjectPath);
  }

  /**
   * The adapter can report its open path through the AE SDK but cannot hash an open `.aep` without
   * making file I/O on AE's callback thread. Verify the pinned bytes here immediately before every
   * mutation, after asking the adapter for a fresh project identity.
   */
  private async verifyPinnedProjectDigest(expectedProjectDigest: string): Promise<void> {
    const health = await this.probeHealth();
    const projectPath = health.result?.projectPath;
    if (!projectPath) {
      throw new AeRuntimeProtocolError("PROJECT_DIGEST_MISMATCH", "After Effects has no saved project to verify against the pinned digest");
    }
    const actualDigest = await sha256File(projectPath);
    if (actualDigest !== expectedProjectDigest.toLowerCase()) {
      this.diagnostics?.record({
        level: "warning",
        source: "ae-runtime",
        message: "Refused a mutation because the open project no longer matches its pinned digest",
        detail: {
          code: "ae-runtime.project-digest-mismatch",
          summary: "Refused a mutation because the open project no longer matches its pinned digest",
          context: { expectedProjectDigest, actualDigest, projectPath }
        }
      });
      throw new AeRuntimeProtocolError("PROJECT_DIGEST_MISMATCH", "the open project bytes do not match the pinned project digest");
    }
  }

  private markHealthy(latencyMs: number): void {
    this.statusValue.state = "ready";
    this.statusValue.lastSuccessfulCommand = "HEALTH";
    this.statusValue.lastReadinessAt = new Date().toISOString();
    this.statusValue.lastError = null;
    this.statusValue.remedy = null;
    this.recordLatency(latencyMs);
  }

  private onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stoppedExplicitly || this.stopping) return;
    this.statusValue.crashCount += 1;
    this.statusValue.state = "degraded";
    this.statusValue.lastFailureAt = new Date().toISOString();
    this.statusValue.lastError = `After Effects exited (${signal ?? code ?? "unknown"})`;
    this.statusValue.remedy = "The supervisor will restart the owned runtime; repeated failure marks it failed.";
    void writeFile(path.join(this.options.dataRoot, "ae-runtime-crash.json"), `${JSON.stringify({
      at: this.statusValue.lastFailureAt, code, signal, crashCount: this.statusValue.crashCount
    }, null, 2)}\n`).catch(() => undefined);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stoppedExplicitly || this.restartTimer || !this.launchOptions) return;
    if (this.statusValue.ownership === "attached") {
      this.statusValue.state = "failed";
      this.statusValue.remedy = "Reconnect the attached After Effects process; GrapiX will not kill or relaunch operator-owned work.";
      return;
    }
    if (this.restartAttempts >= this.maxRestartAttempts) {
      this.statusValue.state = "failed";
      this.statusValue.remedy = "Inspect the persisted crash record and provision the host before retrying.";
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** this.restartAttempts++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.launchOptions || this.stoppedExplicitly) return;
      void this.startInternal(this.launchOptions, false).catch(() => undefined);
    }, delay);
    this.restartTimer.unref();
  }

  private fail(summary: string, error: unknown): void {
    this.statusValue.state = "degraded";
    this.statusValue.lastFailureAt = new Date().toISOString();
    this.statusValue.lastError = messageOf(error);
    this.statusValue.remedy = "Clear non-destructive startup dialogs, verify the adapter install, and retry.";
    this.diagnostics?.record({ level: "warning", source: "ae-runtime", message: summary, detail: {
      code: "ae-runtime.unavailable", summary, cause: this.statusValue.lastError, remedy: this.statusValue.remedy
    } });
  }

  private requireClient(): AeRuntimeClient {
    if (!this.client?.connected) throw new Error("After Effects runtime is not connected");
    return this.client;
  }

  private recordLatency(value: number): void {
    this.statusValue.latencyMs = [...this.statusValue.latencyMs, Math.round(value * 100) / 100].slice(-32);
  }
}


async function validateProjectLaunch(options: AeRuntimeLaunchOptions): Promise<void> {
  if (!options.projectPath) return;
  const projectDigest = options.projectDigest;
  if (projectDigest === undefined) {
    throw new Error("A project launch requires projectDigest");
  }
  if (!/^[0-9a-f]{64}$/i.test(projectDigest)) {
    throw new Error("projectDigest must be a 64-character SHA-256 digest");
  }
  const actualDigest = await sha256File(options.projectPath);
  if (actualDigest !== projectDigest.toLowerCase()) {
    throw new Error(`Project digest mismatch for ${options.projectPath}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeProjectPath(value: string): string {
  const normalized = path.win32.normalize(value);
  return (normalized.startsWith("\\\\?\\") ? normalized.slice(4) : normalized).toLowerCase();
}


function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function emptyStatus(): AeRuntimeSupervisorStatus {
  return {
    state: "stopped", pid: null, ownership: null, aeBuild: null, adapterSha256: null,
    pluginSetSha256: null, projectDigest: null, activeCompositionItemId: null,
    lastSuccessfulCommand: null, lastSuccessfulRevision: null, lastReadinessAt: null,
    lastFailureAt: null, lastError: null, latencyMs: [], crashCount: 0, remedy: null,
    lastFrameId: null
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
