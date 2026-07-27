# GrapiX hardware certification record

Status: **template — no hardware tier is certified by repository tests alone**.

Use one copy per tested machine/output combination.

## Identity

- Tier: HD Basic / HD Advanced / UHD / 3D / Multi-Channel
- Test date and operator:
- GrapiX commit/package hash:
- Windows version/build:
- CPU:
- RAM:
- GPU, VRAM, driver:
- Storage device/filesystem:
- wgpu backend and reported limits:
- Decoder backend and concurrent-session limit:
- NDI SDK/runtime:
- DeckLink/AJA model and driver:
- Monitor/output topology:

## Required evidence

- 80-scene project mix verified
- Normal cached 2D warm p99 below 500 ms
- Prepared-scene Take p99 below 100 ms
- Average render time below 70% of frame budget
- Render p99 below 90% of frame budget
- Zero unexplained Program/output stops
- Zero dropped frames in the certified normal workload
- Program survives editor reload and Preview failure
- Daemon restart restores Program or activates the declared safe fallback
- Missing/corrupt assets block Take with an actionable report
- Data disconnect uses declared fallback values
- Decoder preroll, seek, loop, pause, EOF, alpha, colour and A/V sync verified
- NDI/device output levels, frame rate, alpha and reconnect verified
- Device-loss/output-loss injection completed
- RAM/VRAM remain bounded
- 8-hour soak completed (24-hour for Advanced/UHD/Multi-Channel)

## Measurements

Record average/p99 render time, frame budget, dropped frames, warm/Take
latency, peak RAM/VRAM, decoder count, restart/fallback time and output
reconnect time. Attach the soak JSON and device logs.

## Decision

- Certified workload:
- Explicit exclusions/limitations:
- Pass/fail:
- Reviewer/sign-off:
