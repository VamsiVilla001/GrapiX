//! 3.20 kernel gate: `blend.wgsl` against its CPU twin `crate::blend`, every
//! mode, on the same input words.
//!
//! The pixel pairs include the inputs behind EffectCraft's non-deterministic
//! DX12 32-bit NaN failures: subnormal and tiny alphas, over-range and huge
//! colours. Every GPU result must be finite with alpha in [0, 1]. Results
//! for colours up to 4x over range must also equal the CPU reference within
//! float tolerance; the discontinuous modes (Hard Mix, Darker and Lighter
//! Color) may flip a pixel that sits exactly on their threshold, at most 0.5%
//! of cases, as EffectCraft's own oracle allows. Colours near 1e20 only have
//! to stay finite: there a product overflows or not depending on evaluation
//! order, which a GPU compiler is free to change, and both answers are
//! bounded.
//! Hardware only: run with `--ignored`; `GX_GPU_316_BACKEND` picks dx12 or
//! vulkan.

use gx_contracts::material::BlendMode;
use wgpu::util::DeviceExt;

use crate::blend::{blend_pixel, mode_index, wgsl_mode_constants};
use crate::gpu::Gpu;

fn hardware() -> Gpu {
    let gpu = match std::env::var("GX_GPU_316_BACKEND").as_deref() {
        Ok("dx12") => crate::gpu::negotiate_for_test(wgpu::Backends::DX12),
        Ok("vulkan") => crate::gpu::negotiate_for_test(wgpu::Backends::VULKAN),
        Err(_) => crate::gpu::negotiate(),
        other => panic!("unsupported explicit proof backend: {other:?}"),
    };
    assert!(
        gpu.has_hardware(),
        "3.20 proof requires a hardware GPU, got {:?}",
        gpu.tier()
    );
    gpu
}

const KERNEL: &str = r#"
@group(0) @binding(0) var<storage, read> cases: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4<f32>>;

@compute @workgroup_size(64)
fn run(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= arrayLength(&results)) { return; }
    let extra = cases[3u * i + 2u];
    results[i] = blend_pixel(bitcast<u32>(extra.y), cases[3u * i], cases[3u * i + 1u], extra.x);
}
"#;

/// Deterministic pixel pairs: ordinary, over-range and adversarial.
fn cases() -> Vec<([f32; 4], [f32; 4], f32, bool)> {
    let mut state = 0x2545_f491_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 40) as f32 / 16_777_216.0
    };
    let special_alpha = [
        0.0,
        f32::from_bits(1),
        1e-39,
        f32::MIN_POSITIVE,
        1e-30,
        1e-7,
        1.0,
    ];
    let mut out = Vec::new();
    for i in 0..4096 {
        let pick = |next: &mut dyn FnMut() -> f32, i: usize| -> f32 {
            match i % 4 {
                0 => {
                    special_alpha
                        [(next() * special_alpha.len() as f32) as usize % special_alpha.len()]
                }
                _ => next(),
            }
        };
        let sa = pick(&mut next, i);
        let da = pick(&mut next, i / 3);
        let scale = match i % 7 {
            0 => 4.0,
            1 => 1e20,
            _ => 1.0,
        };
        let straight =
            |next: &mut dyn FnMut() -> f32| [next() * scale, next() * scale, next() * scale];
        let s = straight(&mut next);
        let d = straight(&mut next);
        let noise = next();
        let compared = scale <= 4.0;
        out.push((
            [d[0] * da, d[1] * da, d[2] * da, da],
            [s[0] * sa, s[1] * sa, s[2] * sa, sa],
            noise,
            compared,
        ));
    }
    out
}

fn close(gpu: f32, cpu: f32) -> bool {
    if gpu == cpu {
        return true;
    }
    // Saturated values: both beyond 1e37 with the same sign.
    if gpu.abs() >= 1e37 && cpu.abs() >= 1e37 && gpu.signum() == cpu.signum() {
        return true;
    }
    let scale = cpu.abs().max(1.0);
    (gpu - cpu).abs() <= 1e-4 * scale
}

fn discontinuous(mode: BlendMode) -> bool {
    matches!(
        mode,
        BlendMode::HardMix | BlendMode::DarkerColor | BlendMode::LighterColor
    )
}

#[test]
#[ignore = "requires hardware GPU; 3.20 blend kernel gate"]
fn gpu_blend_kernel_equals_the_cpu_reference_for_every_mode() {
    let gpu = hardware();
    let (device, queue) = gpu.device_queue().expect("hardware device");
    let mut source = wgsl_mode_constants();
    source.push_str(include_str!("blend.wgsl"));
    source.push_str(KERNEL);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gx-blend-kernel-test"),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("gx-blend-kernel-test"),
        layout: None,
        module: &module,
        entry_point: Some("run"),
        compilation_options: Default::default(),
        cache: None,
    });
    let pairs = cases();
    let mut report = Vec::new();
    let mut failures = Vec::new();
    for mode in BlendMode::ALL {
        let mut words = Vec::with_capacity(pairs.len() * 12);
        for (dst, src, noise, _) in &pairs {
            words.extend_from_slice(dst);
            words.extend_from_slice(src);
            words.extend_from_slice(&[*noise, f32::from_bits(mode_index(mode)), 0.0, 0.0]);
        }
        let bytes: Vec<u8> = words
            .iter()
            .flat_map(|w| w.to_bits().to_le_bytes())
            .collect();
        let input = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("cases"),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let size = (pairs.len() * 16) as u64;
        let output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("results"),
            size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: input.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: output.as_entire_binding(),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups((pairs.len() as u32).div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, size);
        queue.submit([encoder.finish()]);
        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
        device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(10)),
            })
            .unwrap();
        rx.recv().unwrap().unwrap();
        let view = slice.get_mapped_range().unwrap();
        let results: Vec<f32> = view
            .chunks_exact(4)
            .map(|b| f32::from_bits(u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
            .collect();
        drop(view);
        readback.unmap();
        let mut mismatched = 0usize;
        let mut first = None;
        let compared = pairs.iter().filter(|p| p.3).count();
        for (i, (dst, src, noise, compare)) in pairs.iter().enumerate() {
            let gpu = &results[i * 4..i * 4 + 4];
            assert!(
                gpu.iter().all(|v| v.is_finite()) && (0.0..=1.0).contains(&gpu[3]),
                "{mode:?}: non-finite or out-of-range GPU result {gpu:?} for dst {dst:?} src {src:?}"
            );
            let cpu = blend_pixel(mode, *dst, *src, *noise);
            if *compare && !(0..4).all(|c| close(gpu[c], cpu[c])) {
                mismatched += 1;
                first.get_or_insert((i, *dst, *src, cpu, [gpu[0], gpu[1], gpu[2], gpu[3]]));
            }
        }
        let allowed = if discontinuous(mode) {
            compared / 200
        } else {
            0
        };
        if mismatched > allowed {
            failures.push(format!(
                "{mode:?}: {mismatched} of {compared} differ; first {first:?}"
            ));
        }
        report.push(format!("{mode:?}: {mismatched}/{compared}"));
    }
    eprintln!(
        "3.20 kernel gate on {:?}: {}",
        gpu.diagnostic_description(),
        report.join(", ")
    );
    assert!(
        failures.is_empty(),
        "GPU blend results that differ from the CPU reference: {failures:#?}"
    );
}
