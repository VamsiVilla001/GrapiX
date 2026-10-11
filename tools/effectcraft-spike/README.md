# EffectCraft compatibility probe

Build-plan `3.14`, [ADR-0003](../../docs/adr/0003-effectcraft-render-core.md).
This is an isolated upstream API probe, not the SceneDocument adapter.
It clones the exact candidate commit into an external temporary directory
and copies the original GrapiX probe into the GPU crate's examples. The
upstream lockfile applies; no tracked upstream source is patched, and no
dependency is added to GrapiX's product workspace.

```powershell
rustup toolchain install 1.95.0 --profile minimal
& ./tools/effectcraft-spike/run.ps1 -Backend dx12 -CoreTests
& ./tools/effectcraft-spike/run.ps1 -Backend vulkan -CoreTests
# If default DX12 initialization falls back to FXC and fails, select the
# installed x64 DXC explicitly (minimum supported by wgpu: 1.8.2502).
& ./tools/effectcraft-spike/run.ps1 -Backend dx12 -DxcPath 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\dxcompiler.dll' -CoreTests
```

Capture complete output with `*>` to a file outside the repository. Review
both exit status and skip/fallback messages. The probe itself fails if the
requested hardware adapter, GPU compositor or readback is unavailable.
It checks host-owned device construction, separate projects/caches sharing
one GPU context, CPU/GPU agreement for a small linear-light composition,
and interleaved Preview/Program pixel isolation. Timing includes rendering
and final RGBA8 readback, with five warmups and 30 measured samples. It
records cold time and cache counters, tests the upstream default 1 GiB CPU
layer-cache budget, and repeats 4K at 256 MiB to expose cache rejection.
These timings use the upstream display-texture API (including mipmaps),
not an implemented NDI output path. A selected DXC library's version and
SHA-256 are recorded. The runner restores its process environment afterward.

The two-solid 1080p/2160p benchmark is preliminary. It does not establish the
reference-show performance gate. It tests neither SceneDocument compilation,
fonts/live fields, temporal effects, output adapters, large-stage tiling,
device recovery nor eight-hour soak. `-CoreTests` runs the pinned `render`
and `gpu` test suites, not the full upstream UI/app workspace suite. Some
upstream tests can log a skip while libtest reports success; skips are not
GPU acceptance evidence. Exact results and remaining gates are recorded in
`memory.md` and ADR-0003, with tracker `3.14` kept active.
