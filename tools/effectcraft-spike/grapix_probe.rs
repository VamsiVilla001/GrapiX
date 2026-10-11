//! Isolated acceptance probe, copied into the pinned upstream GPU crate's examples.
//! This tests upstream API compatibility; it is not the SceneDocument adapter.
#![forbid(unsafe_code)]

use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use effectcraft_color::{ColorSpace, Label};
use effectcraft_keyframe::Value;
use effectcraft_project::build;
use effectcraft_project::{BitDepth, Comp, ItemId, ItemKind, LayerSource, Project, Solid};
use effectcraft_render::{Backend, LayerCache, NoFootage, RenderOpts, Renderer};
use effectcraft_time::{FrameRate, Tick};

fn scene(width: u32, height: u32, color: [f32; 3]) -> Result<(Project, ItemId), Box<dyn Error>> {
    let mut project = Project::default();
    project.settings.bit_depth = BitDepth::Bpc32;
    project.settings.working_space = Some(ColorSpace::Srgb);
    project.settings.linearize = true;
    let comp = Comp::new(
        width,
        height,
        FrameRate::FPS_50,
        Tick::from_seconds_f64(2.0),
    );
    let id = project.add_item(
        "GrapiX synthetic probe",
        Label::Sandstone,
        None,
        ItemKind::Comp(Arc::new(comp.clone())),
    );
    for (name, rgb, w, h, opacity) in [
        ("Background", color, width, height, 100.0),
        (
            "Translucent overlay",
            [0.12, 0.56, 0.9],
            width / 2,
            height / 2,
            60.0,
        ),
    ] {
        let source = project.add_item(
            name,
            Label::Red,
            None,
            ItemKind::Solid(Solid {
                color: rgb,
                width: w,
                height: h,
                pixel_aspect: 1.0,
            }),
        );
        let mut layer = build::layer(
            &mut project,
            &comp,
            name,
            LayerSource::Solid { item: source },
            (w, h),
            None,
        );
        layer
            .props
            .prop_mut("transform/opacity")
            .ok_or("no opacity property")?
            .value = Value::Scalar(opacity);
        project
            .comp_mut(id)
            .ok_or("no composition")?
            .layers
            .insert(0, layer);
    }
    Ok((project, id))
}

fn renderer<'a>(project: &'a Project, cache: &'a LayerCache) -> Renderer<'a> {
    let mut render = Renderer::new(
        project,
        &NoFootage,
        RenderOpts {
            backend: Backend::Gpu,
            motion_blur: false,
            ..Default::default()
        },
    );
    render.cache = Some(cache);
    render
}

fn run() -> Result<(), Box<dyn Error>> {
    let requested = std::env::args()
        .nth(1)
        .ok_or("usage: grapix_probe dx12|vulkan")?;
    let (backends, expected) = match requested.as_str() {
        "dx12" => (wgpu::Backends::DX12, wgpu::Backend::Dx12),
        "vulkan" => (wgpu::Backends::VULKAN, wgpu::Backend::Vulkan),
        _ => return Err("backend must be dx12 or vulkan".into()),
    };
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = backends;
    if let Some(dxc_path) = std::env::args().nth(2) {
        if requested != "dx12" {
            return Err("an explicit DXC path applies only to dx12".into());
        }
        descriptor.backend_options.dx12.shader_compiler =
            wgpu::Dx12Compiler::DynamicDxc { dxc_path };
    }
    println!(
        "COMPILER {:?}",
        descriptor.backend_options.dx12.shader_compiler
    );
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        ..Default::default()
    }))?;
    let info = adapter.get_info();
    if info.backend != expected
        || !matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        )
    {
        return Err(format!("required hardware backend unavailable: {info:?}").into());
    }
    println!("ADAPTER {info:?}");
    let limits = adapter.limits();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("GrapiX host-owned spike device"),
        required_limits: wgpu::Limits {
            max_texture_dimension_2d: limits.max_texture_dimension_2d.min(16384),
            max_buffer_size: limits.max_buffer_size,
            ..Default::default()
        },
        ..Default::default()
    }))?;
    println!(
        "DEVICE max_texture_dimension_2d={} max_storage_buffers_per_shader_stage={}",
        device.limits().max_texture_dimension_2d,
        device.limits().max_storage_buffers_per_shader_stage
    );
    let faults: Arc<Mutex<Vec<String>>> = Arc::default();
    let fault_sink = Arc::clone(&faults);
    device.on_uncaptured_error(Arc::new(move |error| {
        fault_sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(error.to_string());
    }));
    let initialized = Instant::now();
    let gpu = effectcraft_gpu::Gpu::new(&adapter, device.clone(), queue.clone())?;
    println!(
        "INITIALIZATION ms={:.3}",
        initialized.elapsed().as_secs_f64() * 1000.0
    );

    let (program, program_id) = scene(97, 61, [0.8, 0.1, 0.2])?;
    let (preview, preview_id) = scene(97, 61, [0.1, 0.8, 0.2])?;
    let program_cache = LayerCache::new(16 * 1024 * 1024);
    let preview_cache = LayerCache::new(16 * 1024 * 1024);
    let a = renderer(&program, &program_cache);
    let b = renderer(&preview, &preview_cache);
    let cpu = a.comp_frame_cpu(program_id, Tick(0));
    let actual = gpu
        .render(&a, program_id, Tick(0))
        .ok_or("GPU declined parity frame; not a pass")?;
    if (cpu.width, cpu.height) != (actual.width, actual.height)
        || cpu.data.len() != actual.data.len()
    {
        return Err("CPU/GPU output dimensions differ".into());
    }
    let max_delta = cpu
        .data
        .iter()
        .zip(&actual.data)
        .flat_map(|(a, b)| a.iter().zip(b).map(|(a, b)| (a - b).abs()))
        .try_fold(0.0_f32, |max, delta| {
            if delta.is_finite() {
                Ok(max.max(delta))
            } else {
                Err("non-finite parity pixel")
            }
        })?;
    if max_delta > 1e-3 {
        return Err(format!("CPU/GPU parity failed: {max_delta}").into());
    }

    let display_a = gpu
        .render_display(&a, program_id, Tick(0))
        .ok_or("GPU declined Program texture")?;
    let pixels_a = gpu
        .read_display(&display_a)
        .ok_or("Program readback failed")?;
    let display_b = gpu
        .render_display(&b, preview_id, Tick(0))
        .ok_or("GPU declined Preview texture")?;
    let pixels_b = gpu
        .read_display(&display_b)
        .ok_or("Preview readback failed")?;
    if pixels_a == pixels_b {
        return Err("independent projects rendered identical pixels".into());
    }
    let display_a_again = gpu
        .render_display(&a, program_id, Tick(0))
        .ok_or("GPU declined repeated Program")?;
    let pixels_a_again = gpu
        .read_display(&display_a_again)
        .ok_or("repeated Program readback failed")?;
    if pixels_a != pixels_a_again {
        return Err("Preview render contaminated Program pixels".into());
    }
    println!("PASS shared_host_device independent_projects=true cpu_gpu_max_delta={max_delta:.8}");

    for (width, height, cache_budget) in [
        (1920, 1080, 1 << 30),
        (3840, 2160, 1 << 30),
        (3840, 2160, 256 << 20),
    ] {
        let (project, id) = scene(width, height, [0.8, 0.1, 0.2])?;
        let cache = LayerCache::new(cache_budget);
        let render = renderer(&project, &cache);
        let mut samples = Vec::new();
        let mut cold_ms = 0.0;
        let transfers_before = gpu.context().transfer_stats();
        for sample in 0..35 {
            let started = Instant::now();
            let frame = gpu
                .render_display(&render, id, Tick(0))
                .ok_or("GPU declined benchmark texture")?;
            let pixels = gpu
                .read_display(&frame)
                .ok_or("benchmark readback failed")?;
            if pixels.len() != width as usize * height as usize * 4 {
                return Err("benchmark readback dimensions differ".into());
            }
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            if sample == 0 {
                cold_ms = ms;
            }
            if sample >= 5 {
                samples.push(ms);
            }
        }
        samples.sort_by(f64::total_cmp);
        let p50 = samples[14];
        let p99 = samples[29]; // nearest-rank p99 for 30 measured samples
        let transfers_after = gpu.context().transfer_stats();
        let cache_stats = cache.stats();
        println!(
            "BENCH synthetic_two_solids width={width} height={height} cache_budget={cache_budget} cold_ms={cold_ms:.3} warmup=5 samples=30 p50_ms={p50:.3} p99_ms={p99:.3} uploads={} readbacks={} readback_bytes={} cache_bytes={} cache_hits={} cache_misses={} acceptance_gate=false",
            transfers_after.uploads - transfers_before.uploads,
            transfers_after.readbacks - transfers_before.readbacks,
            transfers_after.readback_bytes - transfers_before.readback_bytes,
            cache_stats.bytes,
            cache_stats.hits,
            cache_stats.misses
        );
    }
    let faults = faults.lock().unwrap_or_else(|e| e.into_inner());
    if !faults.is_empty() {
        return Err(format!("host device errors: {faults:?}").into());
    }
    println!(
        "PASS probe_complete backend={requested}; SceneDocument, fonts, temporal effects, output adapters, tiling and soak NOT TESTED"
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("FAIL GrapiX EffectCraft probe: {error}");
        std::process::exit(1);
    }
}
