/**
 * Engine registry: profiles, discovery, and multi-engine selection.
 *
 * Requirement 8 asks for manual IP and port entry, saved engine profiles,
 * automatic local discovery, and a per-engine record of identity, GPU, capability,
 * load, and authentication state. This is that, plus the routing logic a
 * multi-engine setup needs.
 *
 * Deliberately transport-agnostic and side-effect-free: the registry holds
 * *records*, and the caller owns the sockets. That keeps it testable and lets the
 * Editor and Playout share it without either dictating a connection lifecycle.
 */

import type { EngineCapabilities, StageRequirements } from "./capabilities.js";
import { checkStageCapability, type CapabilityCheck } from "./capabilities.js";
import type { EngineState } from "./engine-state.js";
import { isEngineOperational } from "./engine-state.js";
import { engineUrl } from "./transport.js";

/** How an engine came to be known. */
export const ENGINE_DISCOVERY_SOURCES = [
  /** Typed in by an operator. */
  "manual",
  /** Loaded from saved configuration. */
  "profile",
  /** Found by scanning known local ports. */
  "local-scan",
  /** Announced itself on the network. */
  "announced"
] as const;
export type EngineDiscoverySource = (typeof ENGINE_DISCOVERY_SOURCES)[number];

/** A saved, reconnectable engine definition. */
export interface EngineProfile {
  profileId: string;
  /** Operator-facing label. May differ from the engine's own reported name. */
  label: string;
  host: string;
  port: number;
  /** Explicit rather than derived, so an operator can force plaintext on a LAN. */
  secure?: boolean;
  authToken?: string;
  projectId?: string;
  /** Prefer this engine when several are compatible. */
  preferred: boolean;
  /** Skip during automatic selection without deleting the profile. */
  enabled: boolean;
  /** Role in a primary/backup pair. */
  role: EngineRole;
}

export const ENGINE_ROLES = ["primary", "backup", "auxiliary", "unassigned"] as const;
export type EngineRole = (typeof ENGINE_ROLES)[number];

/** Everything currently known about one engine. */
export interface EngineRecord {
  profileId: string;
  label: string
  url: string;
  host: string;
  port: number;
  source: EngineDiscoverySource;
  role: EngineRole;
  enabled: boolean;
  preferred: boolean;
  state: EngineState;
  /** Reported by the engine at Hello. Null until it identifies itself. */
  engineId: string | null;
  /** Name the engine reports for itself, which may differ from `label`. */
  reportedName: string | null;
  softwareVersion: string | null;
  protocolVersion: number | null;
  capabilities: EngineCapabilities | null;
  authenticated: boolean;
  /** Round-trip time from the most recent heartbeat. */
  lastLatencyMs: number;
  /** 0..1 estimate from the engine's frame budget utilisation. */
  load: number;
  lastSeenMs: number;
  lastError: string | null;
  /** Consecutive failed connection attempts, for backoff and for the UI. */
  failureCount: number;
}

export interface EngineObservation {
  state?: EngineState;
  engineId?: string | null;
  reportedName?: string | null;
  softwareVersion?: string | null;
  protocolVersion?: number | null;
  capabilities?: EngineCapabilities | null;
  authenticated?: boolean;
  lastLatencyMs?: number;
  load?: number;
  lastError?: string | null;
  atMs?: number;
}

export function normalizeEngineProfile(
  value: Partial<EngineProfile> & { profileId: string; host: string; port: number }
): EngineProfile {
  const role: EngineRole = ENGINE_ROLES.includes(value.role as EngineRole)
    ? (value.role as EngineRole)
    : "unassigned";

  const profile: EngineProfile = {
    profileId: value.profileId,
    label: value.label?.trim() || `${value.host}:${value.port}`,
    host: value.host.trim(),
    port: Math.round(value.port),
    preferred: value.preferred === true,
    enabled: value.enabled !== false,
    role
  };

  if (value.secure !== undefined) profile.secure = value.secure;
  if (value.authToken) profile.authToken = value.authToken;
  if (value.projectId) profile.projectId = value.projectId;

  return profile;
}

/** Ports a local scan tries. The engine default plus a small node range. */
export const DEFAULT_LOCAL_ENGINE_PORTS: readonly number[] = Object.freeze([
  4400, 4401, 4402, 4403
]);

/**
 * Candidate profiles for a local-engine scan.
 *
 * Loopback only. Scanning a subnet from a graphics application would be
 * indistinguishable from a port scan, and on a production network that is not a
 * reasonable thing to do unprompted.
 */
export function localEngineCandidates(
  ports: readonly number[] = DEFAULT_LOCAL_ENGINE_PORTS
): EngineProfile[] {
  return ports.map((port) =>
    normalizeEngineProfile({
      profileId: `local-${port}`,
      label: `Local engine :${port}`,
      host: "127.0.0.1",
      port,
      secure: false,
      enabled: true,
      preferred: port === DEFAULT_LOCAL_ENGINE_PORTS[0],
      role: "unassigned"
    })
  );
}

export interface EngineRegistrySummary {
  total: number;
  operational: number;
  onAir: number;
  offline: number;
  errored: number;
  authenticated: number;
  /** Engines reporting a state that permits a Take. */
  takeReady: number;
}

/**
 * Registry of known engines.
 *
 * Every engine has a unique `engineId` once it identifies itself, which is what
 * makes primary/backup, mirroring, and failover expressible. The registry keys on
 * `profileId` rather than `engineId` because a profile exists before its engine has
 * ever answered.
 */
export class EngineRegistry {
  private readonly records = new Map<string, EngineRecord>();

  /** Add or replace a profile, preserving any observed runtime state. */
  register(
    profile: EngineProfile,
    source: EngineDiscoverySource = "manual",
    atMs = 0
  ): EngineRecord {
    const url = engineUrl(profile.host, profile.port, { secure: profile.secure });
    const existing = this.records.get(profile.profileId);

    const record: EngineRecord = {
      profileId: profile.profileId,
      label: profile.label,
      url,
      host: profile.host,
      port: profile.port,
      source,
      role: profile.role,
      enabled: profile.enabled,
      preferred: profile.preferred,
      // Re-registering must not lose what we already know about a live engine.
      state: existing?.state ?? "offline",
      engineId: existing?.engineId ?? null,
      reportedName: existing?.reportedName ?? null,
      softwareVersion: existing?.softwareVersion ?? null,
      protocolVersion: existing?.protocolVersion ?? null,
      capabilities: existing?.capabilities ?? null,
      authenticated: existing?.authenticated ?? false,
      lastLatencyMs: existing?.lastLatencyMs ?? 0,
      load: existing?.load ?? 0,
      lastSeenMs: existing?.lastSeenMs ?? atMs,
      lastError: existing?.lastError ?? null,
      failureCount: existing?.failureCount ?? 0
    };

    this.records.set(profile.profileId, record);
    return record;
  }

  remove(profileId: string): boolean {
    return this.records.delete(profileId);
  }

  get(profileId: string): EngineRecord | undefined {
    return this.records.get(profileId);
  }

  /** Look up by the engine's own id, once it has reported one. */
  byEngineId(engineId: string): EngineRecord | undefined {
    for (const record of this.records.values()) {
      if (record.engineId === engineId) return record;
    }
    return undefined;
  }

  all(): EngineRecord[] {
    return [...this.records.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Merge an observation into a record. Unknown profiles are ignored. */
  observe(profileId: string, observation: EngineObservation): EngineRecord | undefined {
    const record = this.records.get(profileId);
    if (!record) return undefined;

    if (observation.state !== undefined) {
      record.state = observation.state;
      // A connection that reached an operational state is not a failing one.
      if (isEngineOperational(observation.state)) {
        record.failureCount = 0;
        record.lastError = null;
      }
      if (observation.state === "error") {
        record.failureCount += 1;
      }
    }

    if (observation.engineId !== undefined) record.engineId = observation.engineId;
    if (observation.reportedName !== undefined) record.reportedName = observation.reportedName;
    if (observation.softwareVersion !== undefined) {
      record.softwareVersion = observation.softwareVersion;
    }
    if (observation.protocolVersion !== undefined) {
      record.protocolVersion = observation.protocolVersion;
    }
    if (observation.capabilities !== undefined) {
      record.capabilities = observation.capabilities;
      if (observation.capabilities) {
        // Capabilities carry authoritative identity; trust them over Hello.
        record.engineId = observation.capabilities.engineId;
        record.reportedName = observation.capabilities.engineName;
        record.softwareVersion = observation.capabilities.softwareVersion;
        record.protocolVersion = observation.capabilities.protocolVersion;
      }
    }
    if (observation.authenticated !== undefined) record.authenticated = observation.authenticated;
    if (observation.lastLatencyMs !== undefined) record.lastLatencyMs = observation.lastLatencyMs;
    if (observation.load !== undefined) {
      record.load = Math.min(1, Math.max(0, observation.load));
    }
    if (observation.lastError !== undefined) record.lastError = observation.lastError;
    if (observation.atMs !== undefined) record.lastSeenMs = observation.atMs;

    return record;
  }

  /** Mark a connection attempt as failed, for backoff and operator feedback. */
  recordFailure(profileId: string, error: string, atMs = 0): EngineRecord | undefined {
    const record = this.records.get(profileId);
    if (!record) return undefined;

    record.failureCount += 1;
    record.lastError = error;
    record.state = "error";
    record.authenticated = false;
    record.lastSeenMs = atMs;
    return record;
  }

  /** Engines that could render right now. */
  operational(): EngineRecord[] {
    return this.all().filter((record) => record.enabled && isEngineOperational(record.state));
  }

  summary(): EngineRegistrySummary {
    let operational = 0;
    let onAir = 0;
    let offline = 0;
    let errored = 0;
    let authenticated = 0;
    let takeReady = 0;

    for (const record of this.records.values()) {
      if (isEngineOperational(record.state)) operational += 1;
      if (record.state === "on-air") onAir += 1;
      if (record.state === "offline") offline += 1;
      if (record.state === "error") errored += 1;
      if (record.authenticated) authenticated += 1;
      if (record.enabled && isEngineOperational(record.state)) takeReady += 1;
    }

    return {
      total: this.records.size,
      operational,
      onAir,
      offline,
      errored,
      authenticated,
      takeReady
    };
  }

  /**
   * Choose an engine for a stage.
   *
   * Ranks by: operator preference, then role (primary before backup), then fewest
   * capability warnings, then lowest load. Returns `undefined` when nothing is
   * compatible — which the caller must surface rather than quietly picking the
   * least-bad engine.
   */
  selectForStage(
    requirements: StageRequirements
  ): { record: EngineRecord; check: CapabilityCheck } | undefined {
    const rolePriority: Record<EngineRole, number> = {
      primary: 0,
      auxiliary: 1,
      unassigned: 2,
      backup: 3
    };

    const candidates = this.operational()
      .filter((record) => record.capabilities !== null)
      .map((record) => ({
        record,
        check: checkStageCapability(requirements, record.capabilities as EngineCapabilities)
      }))
      .filter((entry) => entry.check.compatible)
      .sort((a, b) => {
        if (a.record.preferred !== b.record.preferred) {
          return a.record.preferred ? -1 : 1;
        }
        const role = rolePriority[a.record.role] - rolePriority[b.record.role];
        if (role !== 0) return role;

        const warnings = a.check.issues.length - b.check.issues.length;
        if (warnings !== 0) return warnings;

        return a.record.load - b.record.load;
      });

    return candidates[0];
  }

  /**
   * Why no engine can take a stage.
   *
   * Called when `selectForStage` returns nothing, so the operator sees the actual
   * blocker per engine instead of a bare "no engine available".
   */
  explainIncompatibility(requirements: StageRequirements): string[] {
    const reasons: string[] = [];

    for (const record of this.all()) {
      if (!record.enabled) {
        reasons.push(`${record.label}: disabled`);
        continue;
      }
      if (!isEngineOperational(record.state)) {
        reasons.push(
          `${record.label}: ${record.state}${record.lastError ? ` — ${record.lastError}` : ""}`
        );
        continue;
      }
      if (!record.capabilities) {
        reasons.push(`${record.label}: capabilities not yet negotiated`);
        continue;
      }

      const check = checkStageCapability(requirements, record.capabilities);
      if (check.compatible) continue;

      const errors = check.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message);
      reasons.push(`${record.label}: ${errors.join("; ")}`);
    }

    if (reasons.length === 0) {
      reasons.push("no engines are registered");
    }
    return reasons;
  }

  /**
   * Engines that should mirror a scene.
   *
   * A backup must hold the same scenes as the primary or it cannot be failed over
   * to. Not shipped as automatic replication, but this is the set that would need
   * it, and it is what a diagnostics panel shows.
   */
  mirrorTargets(primaryProfileId: string): EngineRecord[] {
    const primary = this.records.get(primaryProfileId);
    if (!primary) return [];

    return this.all().filter(
      (record) =>
        record.profileId !== primaryProfileId
        && record.enabled
        && record.role === "backup"
        && isEngineOperational(record.state)
    );
  }

  /**
   * Failover candidate for a failed engine.
   *
   * Requires matching capabilities, because a backup that cannot render the stage
   * is not a backup.
   */
  failoverFor(
    failedProfileId: string,
    requirements: StageRequirements
  ): EngineRecord | undefined {
    const failed = this.records.get(failedProfileId);
    if (!failed) return undefined;

    const candidates = this.operational()
      .filter((record) => record.profileId !== failedProfileId && record.capabilities !== null)
      .filter(
        (record) =>
          checkStageCapability(requirements, record.capabilities as EngineCapabilities)
            .compatible
      )
      .sort((a, b) => {
        // A designated backup first, then whatever is least loaded.
        const aBackup = a.role === "backup" ? 0 : 1;
        const bBackup = b.role === "backup" ? 0 : 1;
        if (aBackup !== bBackup) return aBackup - bBackup;
        return a.load - b.load;
      });

    return candidates[0];
  }
}
