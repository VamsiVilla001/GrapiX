// WebGPU capability probe (11.2).
//
// The distinction these guard is the whole point of the step: "no WebGPU",
// "no adapter" and "cannot name the adapter" mean three different things for
// ADR-0001's WASM fallback, and collapsing them would turn a driver problem
// into a platform verdict.

import { describe, expect, it } from "vitest";

import { probeWebGpu, summariseGpuReport, type GpuLike } from "../src/gpu-probe";

describe("what the probe distinguishes", () => {
  it("reports an absent implementation as its own outcome", async () => {
    const report = await probeWebGpu(undefined);
    expect(report.kind).toBe("no-webgpu");
    expect(summariseGpuReport(report)).toContain("not available on this platform");
  });

  it("separates a refused adapter from an absent implementation", async () => {
    // WebGPU exists; this machine's driver was refused. The fallback may well
    // be real on other hardware, so this must not read as a platform verdict.
    const report = await probeWebGpu({ requestAdapter: async () => null });
    expect(report.kind).toBe("no-adapter");
    expect(summariseGpuReport(report)).toContain("unproven on this machine");
  });

  it("treats a throwing requestAdapter as no adapter, carrying the reason", async () => {
    const report = await probeWebGpu({
      requestAdapter: async () => {
        throw new Error("device lost");
      },
    });
    expect(report).toMatchObject({ kind: "no-adapter" });
    expect(report.kind === "no-adapter" && report.detail).toContain("device lost");
  });

  it("reports an available adapter that cannot name itself as available", async () => {
    // A reporting gap, not a capability gap: the fallback is still viable.
    const gpu: GpuLike = {
      requestAdapter: async () => ({
        features: ["depth-clip-control"],
        limits: { maxTextureDimension2D: 8192 },
      }),
    };
    const report = await probeWebGpu(gpu);
    expect(report.kind).toBe("available");
    expect(report.kind === "available" && report.infoUnavailable).toContain(
      "neither adapter.info nor requestAdapterInfo",
    );
    expect(summariseGpuReport(report)).toContain("fallback is viable");
  });
});

describe("what an available probe records", () => {
  const gpu: GpuLike = {
    getPreferredCanvasFormat: () => "bgra8unorm",
    requestAdapter: async () => ({
      features: ["texture-compression-bc", "depth-clip-control"],
      limits: {
        maxTextureDimension2D: 16384,
        maxBufferSize: 2147483648,
        maxComputeWorkgroupStorageSize: 32768,
        // A limit nobody decides on is deliberately not carried through.
        maxBindGroups: 4,
      },
      info: { vendor: "nvidia", architecture: "ampere", device: "RTX 3070 Ti" },
    }),
  };

  it("carries the decisive limits and drops the rest", async () => {
    const report = await probeWebGpu(gpu);
    expect(report.kind === "available" && report.limits).toEqual({
      maxTextureDimension2D: 16384,
      maxBufferSize: 2147483648,
      maxComputeWorkgroupStorageSize: 32768,
    });
  });

  it("sorts features so two recordings are comparable", async () => {
    // The record is read by diffing one platform against the other; iteration
    // order would make identical capabilities look different.
    const report = await probeWebGpu(gpu);
    expect(report.kind === "available" && report.features).toEqual([
      "depth-clip-control",
      "texture-compression-bc",
    ]);
  });

  it("names the adapter and the preferred canvas format", async () => {
    const report = await probeWebGpu(gpu);
    expect(report.kind === "available" && report.preferredCanvasFormat).toBe("bgra8unorm");
    expect(summariseGpuReport(report)).toContain("RTX 3070 Ti");
  });

  it("reports a missing decisive limit as absent rather than zero", async () => {
    // Zero is a real limit value; reporting it for "not stated" would make an
    // unimplemented limit look like a hard refusal to allocate anything.
    const report = await probeWebGpu({
      requestAdapter: async () => ({ features: [], limits: {} }),
    });
    expect(report.kind === "available" && report.limits.maxBufferSize).toBeUndefined();
  });
});
