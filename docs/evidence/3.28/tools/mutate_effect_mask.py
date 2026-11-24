"""3.28: mutate Preserve Underlying Transparency and effect mask references; each mutant must fail a named test.

Run from the repository root:  python -I docs/evidence/3.28/tools/mutate_effect_mask.py
Each file is restored after its mutant. CPU mutants run the CPU reference tests; the GPU mutants run the golden tests on
Vulkan (GX_GPU_316_BACKEND=vulkan), which also hold the CPU/GPU agreement.
"""
import os
import shutil
import subprocess
import sys

W = "services/render-engine/worker/src/"
CPU = ["cargo", "test", "-p", "gx-render-worker", "--lib", "--", "prepared::tests"]
GPU_MASK = ["cargo", "test", "-p", "gx-render-worker", "--lib", "--", "--ignored", "gpu_engine_draws_masked", "--test-threads=1"]
GPU_MATTE = ["cargo", "test", "-p", "gx-render-worker", "--lib", "--", "--ignored", "gpu_engine_draws_track_mattes", "--test-threads=1"]
CONTRACT = ["cargo", "test", "-p", "gx-contracts", "--lib"]

MUTANTS = [
    ("mix-swapped", W + "effect_chain.rs", "let mix = |input: f32, effect: f32| input * (1.0 - w) + effect * w;", "let mix = |input: f32, effect: f32| effect * (1.0 - w) + input * w;", CPU, {}),
    ("mix-default-zero", W + "effect_chain.rs", ".copied().unwrap_or(1.0).clamp(0.0, 1.0);", ".copied().unwrap_or(0.0).clamp(0.0, 1.0);", CPU, {}),
    ("mix-pass-identity", W + "effect_chain.rs", "(Role::Mix, _) => MIX,", "(Role::Mix, _) => IDENTITY,", CPU, {}),
    ("no-save-pre", W + "effect_chain.rs", "            if referenced {\n                push(i, Role::SavePre);\n            }", "            if false {\n                push(i, Role::SavePre);\n            }", CPU, {}),
    ("reference-none-counts-lost", W + "layer_source.rs", "mask.mode = gx_contracts::scene::MaskMode::Add;", "mask.mode = gx_contracts::scene::MaskMode::None;", CPU, {}),
    ("reference-filter-inverted", W + "layer_source.rs", ".filter(|m| m.id.as_ref().is_some_and(|id| ids.contains(id)))", ".filter(|m| !m.id.as_ref().is_some_and(|id| ids.contains(id)))", CPU, {}),
    ("weights-not-passed", W + "prepared.rs", "Some(crate::layer_source::EffectWeights::Cpu(values)) => Some(values.clone()),", "Some(crate::layer_source::EffectWeights::Cpu(_values)) => None,", CPU, {}),
    ("preserve-ignored", W + "prepared.rs", "*px = px.scaled(below.a);", "*px = px.scaled(1.0);", CPU, {}),
    ("preserve-not-drawn-alone", W + "prepared.rs", "if clip.is_some() || track.is_some() || preserve {", "if clip.is_some() || track.is_some() {", CPU, {}),
    ("reference-to-unknown-mask-allowed", "Shared/contracts/src/drawability.rs", "if !masks.iter().any(|m| m.id.as_deref() == Some(id.as_str())) {", "if false {", CONTRACT, {}),
    ("duplicate-mask-id-allowed", "Shared/contracts/src/drawability.rs", "if masks[..index].iter().any(|m| m.id.as_ref() == Some(id)) {", "if false {", CONTRACT, {}),
    ("gpu-mix-ignores-mask", W + "compositor/effects.wgsl", "out = finite4(o * (1.0 - m) + px * m);", "out = finite4(px);", GPU_MASK, {"GX_GPU_316_BACKEND": "vulkan"}),
    ("gpu-mix-reads-wrong-weight", W + "compositor/effects.wgsl", "let m = clamp(textureLoad(effect_weights, q, 0).w, 0.0, 1.0);", "let m = clamp(textureLoad(effect_weights, q, 0).x * 0.0, 0.0, 1.0);", GPU_MASK, {"GX_GPU_316_BACKEND": "vulkan"}),
    ("gpu-preserve-ignored", W + "compositor/composite.wgsl", "        s = s * d.a;\n    }\n    let mode = params.key.x;", "    }\n    let mode = params.key.x;", GPU_MATTE, {"GX_GPU_316_BACKEND": "vulkan"}),
    ("gpu-preserve-flag-not-sent", W + "compositor/mod.rs", "                if layer.preserve {\n                    geometry[3] = 1.0;\n                }", "                if false {\n                    geometry[3] = 1.0;\n                }", GPU_MATTE, {"GX_GPU_316_BACKEND": "vulkan"}),
]


def main() -> int:
    survived = []
    for name, path, old, new, command, env in MUTANTS:
        backup = path + ".mutbak"
        shutil.copyfile(path, backup)
        try:
            source = open(backup, encoding="utf-8").read()
            if old not in source:
                print(f"{name:36} PATTERN NOT FOUND")
                survived.append(name)
                continue
            open(path, "w", encoding="utf-8", newline="\n").write(source.replace(old, new, 1))
            run = subprocess.run(command, capture_output=True, text=True, env={**os.environ, **env})
            output = run.stdout + run.stderr
            if run.returncode == 0:
                print(f"{name:36} SURVIVED")
                survived.append(name)
            else:
                failed = [l.split(" ... ")[0].replace("test ", "") for l in output.splitlines() if l.startswith("test ") and l.rstrip().endswith("FAILED")]
                print(f"{name:36} killed by {failed or ['a build error']}")
        finally:
            shutil.copyfile(backup, path)
            os.remove(backup)
    print(f"killed {len(MUTANTS) - len(survived)} of {len(MUTANTS)}; survivors: {survived}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
