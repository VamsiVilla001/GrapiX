//! 3.22 kernel gate: `effects.wgsl` against its CPU twin `crate::effects`,
//! every pointwise effect over a spread of parameter settings, on the same
//! packed parameter block and the same input pixels.
//!
//! Inputs include opaque, partial, tiny and subnormal coverage and colours
//! over range. Every GPU result must be finite with alpha in [0, 1], and equal
//! the CPU reference within 2e-4 (relative above 1): far below one 8-bit code
//! value (3.9e-3). Hardware only: run with `--ignored`; `GX_GPU_316_BACKEND`
//! picks dx12 or vulkan.

use gx_contracts::color::{Rgba, SourceColorSpace, WorkingColorSpace};
use gx_contracts::effect::*;
use wgpu::util::DeviceExt;

use crate::colour_pipeline::WorkingRgba;
use crate::effects::{apply_pixel, PackedEffect};
use crate::gpu::Gpu;

fn hardware() -> Gpu {
    let gpu = match std::env::var("GX_GPU_316_BACKEND").as_deref() {
        Ok("dx12") => crate::gpu::negotiate_for_test(wgpu::Backends::DX12),
        Ok("vulkan") => crate::gpu::negotiate_for_test(wgpu::Backends::VULKAN),
        Err(_) => crate::gpu::negotiate(),
        other => panic!("unsupported explicit proof backend: {other:?}"),
    };
    assert!(gpu.has_hardware(), "3.22 proof requires a hardware GPU, got {:?}", gpu.tier());
    gpu
}

const WIDTH: u32 = 64;
const HEIGHT: u32 = 64;

fn pixels() -> Vec<WorkingRgba> {
    let mut state = 0x9e37_79b9_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 40) as f32 / 16_777_216.0
    };
    let special = [0.0, f32::from_bits(1), 1e-30, 1e-6, 1.0];
    (0..WIDTH * HEIGHT)
        .map(|i| {
            let a = if i % 5 == 0 { special[(i as usize / 5) % special.len()] } else { next() };
            let scale = if i % 9 == 0 { 2.5 } else { 1.0 };
            let [r, g, b] = [next() * scale, next() * scale, next() * scale];
            WorkingRgba { r: r * a, g: g * a, b: b * a, a }
        })
        .collect()
}

fn colour(r: f64, g: f64, b: f64, a: f64) -> Rgba {
    Rgba::new(r, g, b, a, SourceColorSpace::Srgb)
}

/// Each pointwise effect at several settings, including switches on and off.
pub(crate) fn cases() -> Vec<(String, Effect)> {
    let mut out = Vec::new();
    let mut push = |name: &str, e: Effect| out.push((name.to_owned(), e));
    push("fill", Effect::Fill(Fill { color: colour(0.9, 0.3, 0.1, 1.0), opacity: 0.7 }));
    push("fill-alpha", Effect::Fill(Fill { color: colour(0.1, 0.8, 0.9, 0.5), opacity: 1.0 }));
    push("tint", Effect::Tint(Tint { map_black_to: colour(0.1, 0.0, 0.3, 1.0), map_white_to: colour(1.0, 0.9, 0.6, 0.8), amount: 0.8 }));
    let mut lv = Levels {
        rgb: LevelsChannel { input_black: 0.1, input_white: 0.8, gamma: 1.8, output_black: 0.05, output_white: 0.95 },
        red: LevelsChannel { gamma: 0.6, ..Default::default() },
        alpha: LevelsChannel { output_white: 0.8, ..Default::default() },
        ..Default::default()
    };
    push("levels", Effect::Levels(lv.clone()));
    lv.clip_to_output_black = false;
    lv.clip_to_output_white = false;
    push("levels-unclipped", Effect::Levels(lv));
    let cv = Curves {
        rgb: vec![CurvePoint { x: 0.0, y: 0.05 }, CurvePoint { x: 0.3, y: 0.4 }, CurvePoint { x: 0.7, y: 0.65 }, CurvePoint { x: 1.0, y: 0.98 }],
        green: vec![CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 0.5, y: 0.7 }, CurvePoint { x: 1.0, y: 1.0 }],
        alpha: vec![CurvePoint { x: 0.0, y: 0.0 }, CurvePoint { x: 1.0, y: 0.9 }],
        ..Default::default()
    };
    push("curves", Effect::Curves(cv));
    push("hue-saturation", Effect::HueSaturation(HueSaturation { hue: 75.0, saturation: 0.4, lightness: -0.2, ..Default::default() }));
    push("hue-saturation-down", Effect::HueSaturation(HueSaturation { hue: -200.0, saturation: -0.6, lightness: 0.3, ..Default::default() }));
    push("colorize", Effect::HueSaturation(HueSaturation { colorize: true, colorize_hue: 210.0, colorize_saturation: 0.6, colorize_lightness: 0.25, ..Default::default() }));
    push("brightness-contrast", Effect::BrightnessContrast(BrightnessContrast { brightness: 0.3, contrast: 0.4, use_legacy: false }));
    push("brightness-contrast-low", Effect::BrightnessContrast(BrightnessContrast { brightness: -0.8, contrast: -0.5, use_legacy: false }));
    push("brightness-contrast-legacy", Effect::BrightnessContrast(BrightnessContrast { brightness: 0.2, contrast: 0.5, use_legacy: true }));
    push("exposure", Effect::Exposure(Exposure { exposure: 1.3, offset: -0.02, gamma_correction: 1.4 }));
    push("exposure-down", Effect::Exposure(Exposure { exposure: -2.0, offset: 0.05, gamma_correction: 0.7 }));
    out
}

fn close(gpu: f32, cpu: f32) -> bool {
    gpu == cpu || (gpu - cpu).abs() <= 2e-4 * cpu.abs().max(1.0)
}

#[test]
#[ignore = "requires hardware GPU; 3.22 pointwise effect kernel gate"]
fn gpu_effect_kernels_equal_the_cpu_reference() {
    let gpu = hardware();
    let (device, queue) = gpu.device_queue().expect("hardware device");
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("gx-effect-kernel-test"),
        source: wgpu::ShaderSource::Wgsl(super::effects_shader().into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("effect_step"),
        layout: None,
        module: &module,
        entry_point: Some("effect_step"),
        compilation_options: Default::default(),
        cache: None,
    });
    let input = pixels();
    let size = wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 1 };
    let texture = |usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Float,
            usage,
            view_formats: &[],
        })
    };
    let src = texture(wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
    let words: Vec<u8> = input.iter().flat_map(|p| [p.r, p.g, p.b, p.a]).flat_map(|v| v.to_bits().to_le_bytes()).collect();
    queue.write_texture(
        src.as_image_copy(),
        &words,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(WIDTH * 16), rows_per_image: Some(HEIGHT) },
        size,
    );
    let src_view = src.create_view(&Default::default());
    let mut failures = Vec::new();
    let mut report = Vec::new();
    for space in [WorkingColorSpace::Srgb, WorkingColorSpace::LinearSrgb] {
        for (name, effect) in cases() {
            let mut packed = PackedEffect::identity();
            packed.pack(&EffectInstance::new("e", effect), space);
            let out = texture(wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC);
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &super::effect_uniform(&packed),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let mut curve_bytes = Vec::new();
            super::write_curve(&mut curve_bytes, &packed);
            let curve = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &curve_bytes,
                usage: wgpu::BufferUsages::STORAGE,
            });
            let out_view = out.create_view(&Default::default());
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src_view) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&out_view) },
                    wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: curve.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&src_view) },
                ],
            });
            let readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: u64::from(WIDTH * 16 * HEIGHT),
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(WIDTH / 16, HEIGHT / 16, 1);
            }
            encoder.copy_texture_to_buffer(
                out.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback,
                    layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(WIDTH * 16), rows_per_image: Some(HEIGHT) },
                },
                size,
            );
            queue.submit([encoder.finish()]);
            let slice = readback.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
            device
                .poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(10)) })
                .unwrap();
            rx.recv().unwrap().unwrap();
            let view = slice.get_mapped_range().unwrap();
            let gpu_px: Vec<f32> = view.chunks_exact(4).map(|b| f32::from_bits(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))).collect();
            drop(view);
            readback.unmap();
            let mut mismatched = 0;
            let mut first = None;
            for (i, px) in input.iter().enumerate() {
                let g = &gpu_px[i * 4..i * 4 + 4];
                assert!(g.iter().all(|v| v.is_finite()) && (0.0..=1.0).contains(&g[3]), "{name} {space:?}: {g:?} from {px:?}");
                let c = apply_pixel(&packed, *px);
                if !(close(g[0], c.r) && close(g[1], c.g) && close(g[2], c.b) && close(g[3], c.a)) {
                    mismatched += 1;
                    first.get_or_insert((i, *px, c, [g[0], g[1], g[2], g[3]]));
                }
            }
            if mismatched > 0 {
                failures.push(format!("{name} {}: {mismatched}/{} differ; first {first:?}", space.as_str(), input.len()));
            }
            report.push(format!("{name}/{}: {mismatched}", space.as_str()));
        }
    }
    eprintln!("3.22 kernel gate on {:?}: {}", gpu.diagnostic_description(), report.join(", "));
    assert!(failures.is_empty(), "{failures:#?}");
}
