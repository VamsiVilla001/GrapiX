# 3.28 Preserve Underlying Transparency and Mask Reference; 3.29 Stencil and Silhouette (24 Nov 2026)

- **Preserve** (`preserveUnderlyingTransparency`, edit `setPreserveTransparency`): the composite pass scales the layer by the backdrop's
  alpha; the CPU reference draws it alone and scales it the same way. Golden: below .5, above .75, over nothing 0 (DX12 and Vulkan).
- **Mask Reference** (`Mask.id`, `EffectInstance.maskIds`, validated by name): an effect with references is planned as a save of its
  input (a fourth target), its own passes, and a mix `input * (1 - w) + effect * w` (exact at weight 0 and 1); `w` is the alpha of a
  white cover drawn through the referenced masks at prepare (a mask in mode none counts). A Glow, which keeps its own aux target, works.
  M-37 (the effect's reference does not change the layer's own clip) is a CPU test.
- **3.29:** the four modes exist (3.20); `gpu_engine_stencil_and_silhouette_cut_the_whole_stack_below_not_one_layer` covers three stacked
  backgrounds, a cut layer and a layer above it, within one code of the CPU reference on both backends. Scoping to a group is 3.31.
- **Checks:** 36 of 36 GPU hardware tests on DX12 and on Vulkan; Rust workspace; mutation `tools/mutate_effect_mask.py`, result in
  `mutants.txt` (15 of 15 after one gap was closed).
