# 3.24 GPU/CPU load balancer: design and first slice (18 Nov 2026)

`jev-laya-design.json` holds the three questions, the facts given, and both answers.

| Question | Jev | Laya (second opinion) | Chosen |
|---|---|---|---|
| Signal | leading indicators with hysteresis, plus any late or missed frame trips at once (1.00) | late only | Jev |
| Order | graded and reversible (1.00) | queue everything | Jev |
| How Preview is shed | decimate (0.55) | move to CPU | Jev; the CPU renderer would take cores from the render loop |

Built in this slice: `services/render-engine/worker/src/governor.rs`, wired in `engine.rs` and `log.rs`;
telemetry in `Shared/control-plane/src/telemetry.rs`. Mutations: 12 run (`G1` to `G12`), each failed a named
test and was restored byte-identical; `G11` first survived because its test compared the constant with
itself, and was fixed.

Not built: levels 2 to 4, thread priority, and the sustained load test on DX12 and Vulkan.
