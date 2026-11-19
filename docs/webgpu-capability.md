# WebGPU capability probe — recorded results

Build plan step `11.2`. ADR-0002 A.1 asks for "a one-page WebGPU capability
probe on both platforms, run early. It decides whether the WASM fallback is
real." The fallback in question is ADR-0001's WASM render core on WebGPU, used
only if the engine-rendered viewport fails on latency.

**Windows only (user decisions, 8 and 19 November 2026).** GrapiX builds for
Windows, whose webview is WebView2/Chromium, so the Windows result below is
the whole probe: the macOS leg ADR-0002 asked for (Safari/WKWebView) is out of
scope and was never run. The step's done-when, "Result recorded; decides the
WASM fallback", is met by this record; marking `11.2` done is the user's call.

The probe lives in `Editor/src/gpu-probe.ts` and runs at Editor startup; its
one-line verdict goes to the activity log.

## Windows — measured 13 September 2026

| | |
|---|---|
| OS | Windows 10 Pro, build 10.0.19045 |
| Webview | WebView2 / Chromium **152.0.0.0** (`Edg/152.0.0.0`) |
| GPU | NVIDIA GeForce RTX 3070 Ti |
| Probe verdict | **WebGPU available** |

```
vendor:        nvidia
architecture:  ampere
device:        (empty string)
description:   (empty string)
preferredCanvasFormat: bgra8unorm
```

**Decisive limits**

| Limit | Value |
|---|---|
| `maxTextureDimension2D` | 16384 |
| `maxBufferSize` | 2147483648 (2 GiB) |
| `maxComputeWorkgroupStorageSize` | 32768 |

**Features (19)**

`bgra8unorm-storage`, `clip-distances`, `core-features-and-limits`,
`depth-clip-control`, `depth32float-stencil8`, `dual-source-blending`,
`float32-blendable`, `float32-filterable`, `indirect-first-instance`,
`primitive-index`, `rg11b10ufloat-renderable`, `shader-f16`, `subgroups`,
`texture-component-swizzle`, `texture-compression-bc`,
`texture-compression-bc-sliced-3d`, `texture-formats-tier1`,
`texture-formats-tier2`, `timestamp-query`

**Reading.** On this platform the WASM fallback is viable. `maxTextureDimension2D`
of 16384 covers the tiling threshold that 3.9 exists to handle, `shader-f16`
and the compute limits are present, and `texture-compression-bc` means packaged
textures need no re-encode for this GPU.

**One caveat worth recording.** `adapter.info` reported `vendor` and
`architecture` but left `device` and `description` empty. That is a reporting
gap in the webview, not a capability gap — Chromium masks precise device
strings unless the origin is privileged. The probe reports this as *available
with an unnamed device* rather than as a failure, because treating it as one
would turn a privacy measure into a platform verdict.
