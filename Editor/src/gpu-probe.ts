// WebGPU capability probe (build plan 11.2; ADR-0002 A.1 and its checklist).
//
// ADR-0002's action is "a one-page WebGPU capability probe on both platforms,
// run early. It decides whether the WASM fallback is real." The fallback in
// ADR-0001 is a WASM render core on WebGPU, used if the engine-rendered
// viewport fails on latency. Whether that is a real option is a property of
// the two target webviews, not something anyone can reason to — so it is
// measured and the measurement recorded.
//
// **Absence is a finding, not an error.** Three different things can go wrong
// and they mean three different things:
//
//   - `navigator.gpu` missing — the webview has no WebGPU at all. The fallback
//     is not available on this platform, full stop.
//   - `requestAdapter()` resolving null — WebGPU exists but this machine's GPU
//     or driver was refused. The fallback may be real on other hardware.
//   - `requestAdapterInfo` unimplemented — WebGPU works; we simply cannot name
//     the device. That is a reporting gap, not a capability gap.
//
// Collapsing those into "unavailable" would turn a driver problem into a
// platform verdict and vice versa, which is the silent substitution invariant
// 18 forbids.

/// The structural subset of `navigator.gpu` this needs. Injected rather than
/// read from the global so the probe is a pure function and every outcome —
/// including the ones that need a webview that does not exist here — is
/// testable headlessly.
export interface GpuLike {
  requestAdapter(): Promise<AdapterLike | null>;
  getPreferredCanvasFormat?: () => string;
}

export interface AdapterLike {
  readonly features?: Iterable<string>;
  readonly limits?: Record<string, unknown>;
  requestAdapterInfo?: () => Promise<AdapterInfoLike>;
  readonly info?: AdapterInfoLike;
}

export interface AdapterInfoLike {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

/// The limits that decide whether a WASM render core is viable. Named
/// explicitly rather than dumping every limit: these are the ones a decision
/// would actually turn on, and an undifferentiated dump invites nobody to
/// read it.
export const DECISIVE_LIMITS = [
  "maxTextureDimension2D",
  "maxBufferSize",
  "maxComputeWorkgroupStorageSize",
] as const;

export type GpuReport =
  | {
      readonly kind: "no-webgpu";
      /// Said in words, because this is the line that goes in the record.
      readonly detail: string;
    }
  | {
      readonly kind: "no-adapter";
      readonly detail: string;
    }
  | {
      readonly kind: "available";
      /// Absent when the webview does not implement `requestAdapterInfo`.
      /// Distinct from an adapter that reports empty strings.
      readonly info?: AdapterInfoLike;
      /// Why the device could not be named, when it could not.
      readonly infoUnavailable?: string;
      readonly features: readonly string[];
      readonly limits: Readonly<Record<string, number | undefined>>;
      readonly preferredCanvasFormat?: string;
    };

/// Probe a WebGPU implementation.
///
/// Never throws: a probe that failed is a result the record needs, and an
/// exception here would take the Editor's startup with it.
export async function probeWebGpu(gpu: GpuLike | undefined): Promise<GpuReport> {
  if (!gpu) {
    return {
      kind: "no-webgpu",
      detail: "navigator.gpu is not present; this webview exposes no WebGPU",
    };
  }

  let adapter: AdapterLike | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (error) {
    return {
      kind: "no-adapter",
      detail: `requestAdapter threw: ${describeError(error)}`,
    };
  }
  if (!adapter) {
    return {
      kind: "no-adapter",
      detail: "requestAdapter resolved null; WebGPU exists but no adapter was granted",
    };
  }

  let info: AdapterInfoLike | undefined;
  let infoUnavailable: string | undefined;
  if (adapter.info) {
    info = adapter.info;
  } else if (typeof adapter.requestAdapterInfo === "function") {
    try {
      info = await adapter.requestAdapterInfo();
    } catch (error) {
      infoUnavailable = `requestAdapterInfo threw: ${describeError(error)}`;
    }
  } else {
    infoUnavailable = "this webview implements neither adapter.info nor requestAdapterInfo";
  }

  const limits: Record<string, number | undefined> = {};
  for (const name of DECISIVE_LIMITS) {
    const value = adapter.limits?.[name];
    limits[name] = typeof value === "number" ? value : undefined;
  }

  return {
    kind: "available",
    ...(info === undefined ? {} : { info }),
    ...(infoUnavailable === undefined ? {} : { infoUnavailable }),
    features: [...(adapter.features ?? [])].sort(),
    limits,
    ...(gpu.getPreferredCanvasFormat === undefined
      ? {}
      : { preferredCanvasFormat: gpu.getPreferredCanvasFormat() }),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/// One line for the activity log and the record.
///
/// States the consequence for the WASM fallback, because that is the decision
/// the probe exists to inform — a reader should not have to re-derive it.
export function summariseGpuReport(report: GpuReport): string {
  switch (report.kind) {
    case "no-webgpu":
      return `WebGPU absent — the WASM fallback is not available on this platform (${report.detail})`;
    case "no-adapter":
      return `WebGPU present but no adapter — the fallback is unproven on this machine (${report.detail})`;
    case "available": {
      const named =
        report.info?.description ||
        [report.info?.vendor, report.info?.architecture, report.info?.device]
          .filter(Boolean)
          .join(" ") ||
        "an unnamed adapter";
      return `WebGPU available on ${named} — ${report.features.length} feature(s); the WASM fallback is viable here`;
    }
  }
}
