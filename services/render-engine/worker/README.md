# gx-render-worker

Native Rust/wgpu render worker. Owns the GPU device, the scene runtime, tiling
and Program frame production.

Two rules here are load-bearing and were paid for once already: nothing that
can be built once may be built per Program frame (invariant 35), and a large
stage is never one GPU texture — only tiles become render targets
(invariant 37).
