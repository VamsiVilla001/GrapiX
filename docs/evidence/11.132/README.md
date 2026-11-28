# 11.132 scalar animation verification

The render integration test writes all eight scalar channels to scene JSON, reads them back, and compares frames 0, 5 and 10 against static scenes with the evaluated values. It checks wrong-kind refusals by object and property name. A separate test exercises an effect on animated text and a backwards seek. The hardware runs compare pixel codes against static draws with a tolerance of one code.

Run from the repository root.

```powershell
cargo test --offline --locked -p gx-render-worker --test colour_reference
$env:GX_TEST_SCALAR_GPU = 'dx12'
cargo test --offline --locked -p gx-render-worker --test colour_reference -- --nocapture --test-threads=1
$env:GX_TEST_SCALAR_GPU = 'vulkan'
cargo test --offline --locked -p gx-render-worker --test colour_reference -- --nocapture --test-threads=1
Remove-Item Env:GX_TEST_SCALAR_GPU
node docs/evidence/11.132/tools/preview-parity.mjs
npm run codegen:check
```

On 25 November 2026, all three integration tests passed on DX12 and Vulkan. A two-line caption using packaged Inter took a mean of 2.35 ms and 2.76 ms to shape, respectively, over 20 iterations in the debug build. This measures CPU shaping and outline extraction before upload. Long continuously changing animations also incur a publish-time scan to size the GPU texture.

The Editor preview produced the same scalar values and refused a wrong-kind channel. The check caught both deliberate mutations in a temporary bundle, evaluating at frame zero and ignoring the property-kind restriction. The generated-contract check verified 564 files.
