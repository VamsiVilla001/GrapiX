# 3.25 batch 1: Invert, Posterize, Threshold, Vibrance

Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `crates/effects/src/misc.rs` and `color_fx.rs`.

- Contract: `Invert` (+`InvertChannel`), `Posterize`, `Threshold`, `Vibrance` in `Shared/contracts/src/effect.rs`; one parameter table (`Effect::visit`) drives keyframe validation, the Editor panel and the surface.
- Engine: kernels 19 to 22 in `services/render-engine/worker/src/effects.rs` (CPU) and `compositor/effects.wgsl` (GPU), one packed block.
- Panel: 20 available, 286 not yet ported.

## Evidence
- `cargo test -p gx-contracts --lib`: 283 passed. `cargo test -p gx-render-worker --lib`: 199 passed.
- Hardware GPU parity (`--ignored effect`): 4 passed, including `gpu_effect_kernels_equal_the_cpu_reference` with 7 new cases and `every_effect_matches_its_cpu_reference_on_the_gpu`.
- Mutations (one at a time, restored byte-identical, each fails a named test): B1-B9 (CPU), G1-G4 (WGSL, GPU parity), C1-C3 (contract and catalogue). B7 (vibrance weight) first survived because the test pixel sat at s = 0.5; a pixel at s = 0.8 now catches it.
- Gate: fmt 0, clippy 0, `npm run check` 0.

## Not done
Vulkan backend parity (`GX_GPU_316_BACKEND=vulkan`); batches 2 onward.

# 3.25 batch 3: Color Balance (HLS), Black & White, Photo Filter, Leave Color

Done 19 November 2026. Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `color_fx.rs` (black_white, photo_filter, leave_color, PHOTO_FILTERS) and `color2.rs` (color_balance_hls).

- Contract (`Shared/contracts/src/effect.rs`): `ColorBalanceHls`, `BlackWhite` (six hue weights, -2 to 3, tint and tint colour), `PhotoFilter` with the 21-entry `PhotoFilterPreset` (20 camera and colour filters in EffectCraft's order, plus `custom`; `srgb8()` gives each colour) and `LeaveColor` with `LeaveMatch` (`rgb` or `hue`). One parameter table drives keyframing, the Editor panel and the surface.
- Engine: kernels 27 to 30 in `effects.rs` (CPU) and `compositor/effects.wgsl`, one packed block. The Photo Filter colour and the tint colour are converted to the working space like every other colour parameter; density 0 and amount 0 are exact identities (a ratio of two equal luminances is not exactly 1).
- The panel now lists **28 available, 278 not yet ported** (was 24 and 282).

## Evidence
- `cargo test -p gx-contracts --lib`: 288 passed (bounds, the wire words, the whole filter table pinned). `cargo test -p gx-render-worker --lib effects::`: 10 pass; known-pixel expectations were computed independently in Python from the EffectCraft formulas (including a 340 and a 300 degree hue turn, the default tint, a softness of 0.5, a nearly-grey pixel, and a dark red that separates the hue mode from the RGB mode).
- Hardware GPU parity (`-- --ignored effect`): 4 passed, with 8 new cases (HLS up and down, Black & White plain and tinted, Photo Filter preset and custom, Leave Color by RGB and by hue) within the 2e-4 gate.
- Mutants, one at a time: 24 plus 7 reruns. 22 each failed a named test (the HLS lightness and saturation formulas, the weight interpolation, its strength, the tint lightness and hue, tint not applied, the luminosity ratio, density, luminosity never kept, the RGB distance scale, the grey rule, the softness width, the preset colour, the hue-mode flag, five WGSL changes, the table and the weight domain). Six survived first and their tests were strengthened (hue wrap, the default tint's hue, the softness width, a nearly-grey pixel, the hue-mode flag). **Two are equivalent and recorded:** removing the HLS kernel's own hue wrap (`hsl_to_rgb` wraps hue itself, so the guard is redundant) and removing `tolerance >= 1` from Leave Color (the largest possible distance is exactly 1, so `distance <= tolerance` already holds).
- Gate: see the 19 November log.

## Not done
Vulkan backend parity (`GX_GPU_316_BACKEND=vulkan`); batch 4 onward (278 effects remain; Broadcast Colors and Video Limiter, both relevant to broadcast, are the next candidates).

# 3.25 batch 4: Video Limiter and Broadcast Colors

Done 19 November 2026. Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `color3.rs` (`video_limiter`, `knee`, `CLIP_LEVELS`) and `color2.rs` (`broadcast_colors`). Both are the broadcast-safety effects: they keep a picture inside a legal signal range.

- Contract (`Shared/contracts/src/effect.rs`): `VideoLimiter` (clip level 90/95/100/105/109%, method luma/chroma/smart-limit, compression before clipping none/3/5/10/20%, gamut warning and its colour) and `BroadcastColors` (NTSC or PAL, reduce luminance / reduce saturation / key out unsafe / key out safe, maximum signal 90 to 120 IRE). EffectCraft's defaults are kept, so Video Limiter at its defaults (100%, Smart Limit, 5%) is not a no-op above 0.95; Broadcast Colors at 110 IRE changes only very saturated colours.
- Engine: kernels 31 and 32 in `effects.rs` (CPU) and `compositor/effects.wgsl`. The keying modes change coverage, so the pixel goes fully transparent through the same `covers` rule as every other effect.
- The panel now lists **30 available, 276 not yet ported** (was 28 and 278).

## Evidence
- `cargo test -p gx-contracts --lib`: 289 passed (the new test pins the limiter's level and compression words and fractions, the defaults, and the 90 to 120 bound on the signal).
- `cargo test -p gx-render-worker --lib effects::`: 11 pass; `batch_four_matches_effectcraft_on_known_pixels` has 30 known-pixel checks (every limiter method and level, the knee, negative channels, the warning on and off at a 1e-4 change, NTSC and PAL, both reduce modes, both key modes). Expected values were computed independently in Python from EffectCraft's formulas.
- Hardware GPU parity (`-- --ignored effect`): 4 passed, with 6 new cases (two limiter, four broadcast) within the 2e-4 gate.
- Mutants, one at a time: 21 plus 2 reruns. 19 failed a named test first time; 2 survived (the lower clamp on the blue channel, the 1e-4 warning threshold) and new test pixels (a negative blue; changes of 5e-4 and 5e-5) now catch both. None equivalent.
- Gate: see the 19 November log.

## Not done
Vulkan backend parity (`GX_GPU_316_BACKEND=vulkan`); batch 5 onward (276 effects remain).

# 3.25 batch 5: CC Toner, CC Color Offset, CC Threshold, CC Threshold RGB

Done 20 November 2026. Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `color2.rs` (`cc_toner`, `cc_color_offset`) and `stylize2.rs` (`cc_threshold`, `cc_threshold_rgb`).

- Contract (`Shared/contracts/src/effect.rs`): `CcToner` (two, three or five tones; blend), `CcColorOffset` (a phase per channel in degrees; wrap, solarize or polarize past white), `CcThreshold` (luminance, RGB, saturation or alpha against a 0 to 255 level; invert; blend) and `CcThresholdRgb` (a level and an invert per channel; blend). EffectCraft's defaults are kept (the toner's default tritone is not an identity; CC Color Offset with no phase is exactly the picture).
- Engine: kernels 33 to 36 in `effects.rs` and `compositor/effects.wgsl`. The alpha mode of CC Threshold changes coverage, so a pixel under the level goes fully transparent through the same `covers` rule as every other effect.
- The panel now lists **34 available, 272 not yet ported** (was 30 and 276).

## Evidence
- `cargo test -p gx-contracts --lib`: 289 passed (bounds on the levels and blends). `effects::tests::batch_five_matches_effectcraft_on_known_pixels`: expected values computed independently in Python (tones at several luminances and blends, every overflow mode and a negative or multi-turn phase, each threshold channel, the exact level, 127 of 255 against 0.496, each channel's own level and invert).
- Hardware GPU parity (`-- --ignored effect`): 4 passed with 9 new cases (two toner, three overflow modes, four threshold modes, RGB threshold) within the 2e-4 gate.
- Mutants, one at a time: 21 (plus 8 reruns). 20 each failed a named test; 8 survived first and their tests were strengthened (a negative phase, the polarize cut, the 255 divisor, the blue invert, the RGB boundary, the green level, the pentone order). **One is equivalent and recorded:** letting the toner's last stop index reach `n` instead of `n - 1`, because at exactly `n` the blend fraction is 0.
- Found on the way: with the load balancer's Preview decimation now wired (3.24), a debug-build GPU test that reads Preview on every frame saw it decimated; the engine's own unit tests now start with the governor held at Normal (`arm_governor_for_test` arms it for the tests of the governor).
- Gate: see the 20 November log.

## Not done
Vulkan backend parity (`GX_GPU_316_BACKEND=vulkan`); batch 6 onward (272 effects remain).

# 3.25 batch 6: Change Color, Shift Channels

Done 20 November 2026. Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `color3.rs` (`change_color`, `colour_match`) and `channel.rs` / `util.rs` (`shift_channels`, `pick`).

- Contract (`Shared/contracts/src/effect.rs`): `ChangeColor` (hue in degrees, lightness and saturation as a share of the way to the extreme, the colour to change, tolerance and softness, matching by RGB, hue or chroma, invert, and the matte view) and `ShiftChannels` (each of alpha, red, green and blue taken from alpha, red, green, blue, luminance, hue, lightness, saturation, full on, half on or full off). The defaults of both are exactly the picture: the engine packs them as the identity kernel.
- Engine: kernels 37 and 38 in `effects.rs` and `compositor/effects.wgsl`. A difference from EffectCraft, in the engine's rule that a transparent pixel stays transparent in every effect: Shift Channels' "full on" alpha does not make an empty pixel opaque.
- The panel now lists **36 available, 270 not yet ported** (was 34 and 272).

## Evidence
- `effects::tests::batch_six_matches_effectcraft_on_known_pixels`: expected values computed independently in Python (the hue turned both ways, the matte, lightness and saturation in both directions, inverted, RGB with and without softness, chroma against RGB on a dim red, a grey, a nearly-grey pixel, a hue just across the wrap, another key colour; every Shift Channels source, a rotation, alpha taken from red, an alpha over 1 held at 1, alpha taken from nothing).
- Hardware GPU parity (`-- --ignored effect`): 4 passed with 7 new cases within the 2e-4 gate.
- Mutants, one at a time: 23 plus 7 reruns. 16 failed first time; 7 survived and their tests were strengthened (going down in lightness, the grey rule, the hue distance's wrap, the chroma scale, the chroma mode code, the key's own hue, the alpha clamp). **One is equivalent and recorded:** removing the hue wrap in the kernel, because `hsl_to_rgb` wraps the hue itself.
- Gate: see the 20 November log.

## Not done
Vulkan backend parity (`GX_GPU_316_BACKEND=vulkan`); batch 7 onward (270 effects remain; Change to Color, Set Channels and Channel Combiner need more than one input or more than one pass).

# 3.25 batch 7: Linear Color Key, Remove Color Matting (wave 1 of `docs/effects-programme.md`)

Done 20 November 2026. Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `keying.rs` (`linear_color_key`) and `channel.rs` (`remove_color_matting`).

- Contract: `LinearColorKey` (key colour; match by RGB, hue or chroma; tolerance and softness; key or keep the colour; final, source or matte view) and `RemoveColorMatting` (background colour; hold channels at the alpha). EffectCraft's defaults are kept.
- Engine: kernels 39 and 40 in `effects.rs` and `compositor/effects.wgsl`. The key's chromaticity and hue are worked out once at pack time. The matte view is an opaque grey of the alpha the picture had times the matte.
- The panel now lists **38 available, 268 not yet ported**.

## Evidence
- `effects::tests::batch_seven_matches_effectcraft_on_known_pixels`: expected values computed independently in Python (the key colour itself, a far colour, the soft edge, a hard step, all three matching modes against a blue key and a red key, a nearly-grey pixel, black against a grey key's chromaticity, keep colours, all three views, an alpha carried into the matte, and Remove Color Matting held at the alpha, unclipped and with a background that takes a channel to zero).
- Hardware GPU parity (`-- --ignored effect`, serial): 4 passed with 5 new cases.
- Mutants, one at a time: 18 plus 7 reruns. 12 failed first time; 6 survived because a blue key has no hue or chromaticity to tell the modes apart, and red-key and grey-key cases now catch every one. None equivalent.
- Gate: see the 20 November log.

# 3.25 batch 8: Extract, CC Color Neutralizer, Unmult, Spill Suppressor (wave 1 of `docs/effects-programme.md`)

Done 20 November 2026. Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `keying.rs` (`extract`, `spill_suppressor`), `keying2.rs` (`unmult`) and `color3.rs` (`color_neutralizer`).

- Contract: `Extract` (luminance, red, green, blue or alpha between a black and a white point, with a softness each side and invert), `CcColorNeutralizer` (a balance and an unbalance colour for the shadows, midtones and highlights, pinning, blend, darks, brights, contrast), `Unmult` (black or white background, levels, softness, remove matting, clip HDR) and `SpillSuppressor` (colour, faster or better, amount 0 to 2). EffectCraft's defaults are kept.
- Engine: kernels 41 to 44 in `effects.rs` and `compositor/effects.wgsl`. A neutralizer with nothing to move, and a Better spill with a grey key, pack as the identity. The Faster spill's strongest channel and the Better spill's key direction are worked out once at pack time.
- Left for the coordinate pass: CC Vignette (it needs each pixel's position and the layer size).
- The panel now lists **42 available, 264 not yet ported**.

## Evidence (batch 8)
- `effects::tests::batch_eight_matches_effectcraft_on_known_pixels` and `batch_eight_defaults_that_are_identities_are`: expected values computed independently in Python (windows, softness on both sides, every channel, invert, the edges, the luminance weights; every zone, pinning, blend, contrast, darks, brights, an HDR grey; classic Unmult on black and white, levels, softness, a hard step, clipping, matting, the alpha it had; Faster and Better spill, three keys, ties, amounts, alpha).
- Hardware GPU parity (`-- --ignored effect`, serial): 4 passed with 7 new cases.
- Mutants, one at a time: 55. 51 failed a named test. One survived because the alpha test used 0.5 for colour and alpha alike; a pixel that tells them apart now catches it. Three are equivalent and recorded: Unmult's clamp on the distance (the matte is clamped anyway), Unmult's zero-matte threshold (a zero matte is transparent either way), and Spill's channel mean (the key direction sums to zero, so the mean cancels).
- Gate: see the 20 November log.

## Not done
Vulkan backend parity; the rest of wave 1 (40 effects, with CC Vignette moved to the coordinate pass) and waves 2 to 9.

# 3.25 batch 9: Color Range (wave 1 of `docs/effects-programme.md`)

Done 22 November 2026. **Update, 22 Nov 2026: this batch was afterwards checked against the source text and matches it.** The pinned source was cloned with the user's yes (`agent/tmp/effectcraft-src`), and `color_range`, `to_lab`, `range_components`, `matte_of`, `apply_matte`, `unpremul` and the sRGB transfer were compared line by line with the kernel: identical. The paragraph below describes how the batch was first built, when only descriptions were available. **The reference was a reading of EffectCraft's source, not the source.** The pinned reference (`storytold/effectcraft` at `9a7d3e76991d5372448033b473dc12c2480a6a04`, MIT OR Apache-2.0, ADR-0003) is not on this machine; it was read through web-fetch agents that could return structured descriptions and short quotes (125 characters at most) but not the text. The constants below are therefore the ones those descriptions gave for `color_range`, `range_components`, `to_lab`, `matte_of` and `apply_matte` in `keying.rs`; where a helper lives in a file that was not read (`srgb_to_linear` in `effectcraft_color`, taken as the standard sRGB transfer already in this engine) that is an assumption. The tests check the kernel against an independent float64 calculation of that description. They do not check it against EffectCraft's own output, and a later pass against the source text should be expected to find differences if the description was wrong.

- Contract: `ColorRange` (a colour space, Lab, YUV or RGB; a lower and upper bound on each of its three axes, all on a 0 to 255 scale; and a fuzziness, 0 to 255) and `RangeSpace`. EffectCraft's defaults are kept (Lab, L 0 to 255, a 0 to 100, b 128 to 255, fuzziness 0). It has no view parameter, as the source has none (view 0 is always the final output).
- Engine: kernel 45 in `effects.rs` and `compositor/effects.wgsl`. A pixel inside the box has a matte of 0 and is keyed out; outside it the matte is the largest distance past a bound over the fuzziness, clamped (1 when the fuzziness is 0). The bound is inclusive. Lab clamps its input to 0 to 1 before linearising; YUV and RGB do not, so an HDR value is measured as it is. The colour is kept and the alpha is multiplied by the matte. The bounds are on display-encoded sRGB, so a **linear project encodes the colour first** (a flag packed from the working space).
- The panel now lists **43 available, 263 not yet ported**.

## Evidence (batch 9)
- `effects::tests::batch_nine_color_range_matches_effectcraft_on_known_pixels` (24 cases) and `batch_nine_defaults_and_transparent_pixels_behave`: expected values computed independently in Python (float64): Lab, YUV and RGB boxes, a hard edge and the fuzzy ramp, a pixel exactly on a bound (inside), the alpha it had, HDR white clamped in Lab and not clamped in RGB, a linear project against the same value in an sRGB project, and cases where each axis alone decides (L, a, b; Y; the dark linear segment of the Lab curve and the value just above it).
- Hardware GPU parity (`-- --ignored effect`, serial): 4 passed with 3 new cases.
- Mutants, one at a time: 21 on the CPU kernel and 6 on the shader. The first CPU run left 5 alive (the L scale, the b offset, the Lab threshold, the Z white and the YUV Y scale), because no case had each of those axes deciding the matte; 7 sharper cases killed all five. 21 of 21 CPU and 6 of 6 shader mutants then failed a named test. None are equivalent.
- Gate: fmt, clippy `-D warnings`, 289 contracts tests, 219 worker tests (34 hardware tests ignored by default), conformance.

## Not done
Vulkan backend parity; the rest of wave 1 (39 effects; see the plan row for why Levels (Individual Controls), Selective Color, Luma Key, Color Key, Color Difference Key and the analysis effects are not in this batch) and waves 2 to 9. The next effects should be ported from the source text: someone needs to put a clone of the pinned commit where it can be read.

# 3.25 batch 10: Arithmetic, Color Difference Key (wave 1 of `docs/effects-programme.md`)

Done 22 November 2026, **from the source text** (EffectCraft at the pinned commit `9a7d3e76991d5372448033b473dc12c2480a6a04`, MIT OR Apache-2.0, ADR-0003, cloned locally for reading): `arithmetic` (`channel.rs`), `color_difference_key`, `matte_levels` and `primary` (`keying.rs`). Nothing is copied into GrapiX; each kernel is a port.

- Contract: `Arithmetic` (an operator, a value for each of red, green and blue on 0 to 255, and the clip) with `ArithmeticOperator` (And, Or, Xor, Add, Subtract, Difference, Min, Max, Block Above, Block Below, Slice, Multiply, Screen), and `ColorDifferenceKey` (a view, the key colour, Faster or More Accurate, levels for partial matte A and B, and the matte's own black, white and gamma) with `ColorDiffView`, `MatchAccuracy` and `MatteLevels`. EffectCraft's defaults are kept (Add 0 with the clip on; a blue key, the final output, levels at identity).
- Engine: kernels 46 and 47 in `effects.rs` and `compositor/effects.wgsl`. Arithmetic's And, Or and Xor round the channel and the setting to 8 bits exactly as EffectCraft's `round() as u8` does (the shader has its own round-half-up, because WGSL's `round` goes to even). The key's strongest channel, its two differences and the accuracy are worked out once at pack time; a **linear project encodes the colour to display values first**, as Color Range does. The Source view packs as the identity.
- Left out: Color Difference Key's four-up view (EffectCraft's ninth) needs each pixel's position, so it comes with the coordinate pass, with CC Vignette. The contract offers eight views.
- The panel now lists **45 available, 261 not yet ported**.

## Evidence (batch 10)
- `batch_ten_arithmetic_matches_effectcraft_on_known_pixels` (35 cases) and `batch_ten_color_difference_key_matches_effectcraft_on_known_pixels` (36 cases), with expected values computed independently in Python (float64) from the source: all 13 operators with and without the clip, the 8-bit rounding of And, Or and Xor on the halves, unclipped HDR, a channel exactly equal to its setting; every stage of the matte, levels on both partials and on the matte, green, red and grey keys (a tie goes to green), More Accurate, a linear project, a key whose channels are nearly equal, and the alpha it had. `batch_ten_source_view_and_defaults_are_the_identity_or_a_keep`.
- Hardware GPU parity (`-- --ignored effect`, serial): 4 passed with 13 new cases (the ten continuous Arithmetic operators and four Color Difference Key stages, with and without More Accurate).
- **A limit the hardware test found.** The first run failed on Arithmetic Xor: 17 of 15,360 pixels on the program path and 599 on the preview path differed by one code value, none of them tie flips. And, Or and Xor quantise each channel to 8 bits, so the GPU's half-precision texture can flip a pixel across a rounding boundary that the CPU's f32 does not. This is inherent to the operator, not a defect in either kernel; the three are tested on the CPU against the independent values and left out of the strict GPU parity set (a comment in `effect_tests.rs` says why), and the other ten operators are in it.
- Mutants, one at a time: 47 (36 on the CPU kernels, 11 in the shader). The first run left 5 alive (Block Above, Block Below and Slice at a channel exactly equal to its setting; the key-difference floor; the display encode in a linear project, whose first case had its matte saturated); 5 sharper cases killed them. 47 of 47 then failed a named test. None are equivalent.
- Gate: fmt, clippy `-D warnings`, 289 contracts tests, 222 worker tests (34 hardware tests ignored by default), 556 web tests, conformance, TypeScript regenerated.

## Not done
Vulkan backend parity; the rest of wave 1 (37 effects) and waves 2 to 9. See the plan row for what blocks each of the next candidates.


# 3.25 batch 11: Selective Color (wave 1 of `docs/effects-programme.md`)

Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `crates/effects/src/color2.rs` (`selective_color`, `sc_weights`), checked against its text now on disk. It was held back at batch 8 because its 37 parameters did not fit the 32-float block; the block is 64 floats since 22 Nov 2026.

- Contract: `SelectiveColor` (a method, Relative or Absolute, and nine ranges: reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks) with `InkShift` (cyan, magenta, yellow, black, each -1 to 1, which is EffectCraft's -100% to 100%) and `SelectiveMethod`. 37 keyframable parameters, all zero by default. EffectCraft's "Colors" popup only chooses which range its panel shows, so it is not a parameter here.
- Engine: kernel 48 in `effects.rs` and `compositor/effects.wgsl`. The method and the nine ranges of four inks pack into slots 0 to 36. A range's weight comes from the pixel's channel order (a stable sort, so a tie keeps red, green, blue order on both sides): a primary by its lead over the middle channel, a secondary by the middle's lead over the smallest, whites and blacks by how far the darkest or lightest channel passes the middle of the range, neutrals by closeness to mid grey. Each range subtracts its inks (cyan from red, magenta from green, yellow from blue, black from all three), Relative by the share of the ink the pixel has (held at 0, so a channel above 1 has none to move), Absolute flat; each channel is held at 0 or above. A shift that is all zero packs as the identity.
- The panel now lists **46 available, 260 not yet ported**; wave 1 has 36 left.

## Evidence (batch 11)
- `selective_color_moves_inks_by_range_as_worked_by_hand`: 13 pixel cases and 3 direct weight checks, every expected value worked out from the formula on paper before the kernel was run (pure red against absolute cyan, a mid red under Relative cyan and Relative black, mid grey, white under both methods, pure yellow, an unrelated range, an over-bright channel, a partial Neutrals weight, no shift, a transparent pixel; weights at (0.9, 0.8, 0.7), at a green and blue tie, and at a dark blue-leaning pixel). One of my first expected values was wrong (red-smallest is Cyans, not Magentas); it was caught re-deriving by hand, before the run.
- Hardware GPU parity, **each backend named explicitly** (`GX_GPU_316_BACKEND=dx12` and `=vulkan`, `-- --ignored effect --test-threads=1 --nocapture`, RTX 3070 Ti; the harness prints the adapter it got, `(Dx12)` and `(Vulkan)`): 5 tests passed on each, and all 174 cases of the kernel gate (87 cases in each of sRGB and linear) show 0 mismatching components on each backend, the four Selective Color pairs and the Spill Suppressor pairs among them. With the variable unset the harness takes whatever adapter wgpu ranks first, which on this machine today is Vulkan.
- Mutants, one at a time: 10 (3 in the shader, 7 in the CPU kernel), each failed a named test. The first run of 6 left 2 alive, both gaps in my test: dropping the ink floor (needs a channel above 1) and changing the Neutrals weight (the grey case sits at exactly 0 on both terms). Three sharper cases killed them, and 4 more CPU mutants aimed at Whites, Blacks, the black term and the output floor were killed too. 10 of 10; none are equivalent. After the shader was rewritten for DX12 (below), 9 more mutants on the new shader text (each secondary and primary mapping, the second compare-swap, Relative flipped, the Blacks and Neutrals weights, and two Spill Suppressor channel indices) were each killed by a parity mismatch, none by a compile error.
- **A DX12 break found by running the backends explicitly, in two kernels, both mine.** On DX12 the whole effect shader failed to compile (`create_compute_pipeline` for `effect_step`, FXC): 4 of 5 hardware tests panicked at pipeline creation, so on a machine whose adapter wgpu ranks as DX12 **no effect would have rendered**. (1) **Spill Suppressor** (batch 8) stored through a non-constant vector index, `v[strong] = ...`, which FXC refuses (`X3500`); (2) **Selective Color** (this batch) sorted its channels with a data-dependent `while` loop that stores by index, which FXC is forced to unroll and cannot (`X3511`). Found by bisecting the shader's kernel branches against the DX12 compiler (my first bisect named the wrong branch, an early-return guard whose removal broke the shader for a different reason, and I discarded it; the corrected one confirmed Spill Suppressor alone by stripping it). Fixed in `effects.wgsl` only, the CPU kernels untouched: Spill Suppressor now uses a `select` on three constant comparisons (bit-identical), and the weights use a two-step compare-swap on scalars (a stable sort without a loop) with the weights built from `select`s. **Since every effect shares one shader module, one such kernel breaks all of them on DX12.** Because Spill Suppressor has been in the shader since batch 8, any hardware run since then that passed must have run on Vulkan; the earlier notes that listed "Vulkan backend parity" as open therefore named the wrong backend, and what was open was DX12. Both are now closed for the present 46 effects.
- Gate: fmt, clippy `-D warnings` (exit 0), 290 contracts tests, 224 worker tests (35 hardware tests ignored by default), 1308 workspace tests in all, 556 web tests, 145 mjs tests, typecheck, boundaries, protocol, codegen check (499 files), TypeScript regenerated (`InkShift`, `SelectiveColor`, `SelectiveMethod`).
- **Three tests of mine were stale and failed in the gate**, all in `services/editor/src/project.rs` from the colour-depth work: two built a 16-bit scene in a project whose depth reads as 32, and one still treated schema 4 as newer than supported. Fixed (the old-project test now also asserts that a project with no depth reads as 32 and keeps it through the upgrade), and the whole workspace then passed. My earlier note that the whole workspace had passed after the depth work was wrong.

## Not done
The rest of wave 1 (36 effects) and waves 2 to 9. The depth test (`a_project_colour_depth_matches_its_cpu_reference_on_the_gpu`) passes on both backends, one level apart on under 1% of components at 8 bit as before. A rule for the next kernels: **run the hardware set on both backends explicitly**, and in WGSL keep to what FXC accepts (no stores through a non-constant index into a vector or array, no data-dependent loop that stores by index).
