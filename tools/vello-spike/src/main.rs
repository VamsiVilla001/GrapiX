//! Vello classic / Vello Hybrid spike for build-plan 3.17 and 16.9.
//!
//! Isolated probe: its own workspace and lockfile, never a product
//! dependency. It renders three broadcast-shaped workloads at 1920x1080 RGBA8
//! through five backends, reads every frame back to the CPU, times 5 warmups
//! and 30 samples, writes the frames as PNGs, and compares them against an
//! independent CPU reference with the engine's own cross-machine tolerance.
//!
//! Usage: `gx-vello-spike <dx12|vulkan> <out-dir> [dxcompiler.dll]`

use std::collections::HashSet;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::time::Instant;

use vello::kurbo::{self, Affine, BezPath, Cap, Join, Point, Rect, RoundedRect, Shape};
use vello::peniko::{self, Color, Fill, Gradient};

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const WARMUPS: usize = 5;
const SAMPLES: usize = 30;

type Rgba = [u8; 4];
type Result<T> = std::result::Result<T, Box<dyn Error>>;

// ---------------------------------------------------------------------------
// Backend-neutral display list
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum Paint {
    Solid(Rgba),
    Linear { p0: Point, p1: Point, stops: Vec<(f32, Rgba)> },
    Radial { centre: Point, radius: f64, stops: Vec<(f32, Rgba)> },
}

impl Paint {
    /// The flat colour a backend without gradients is given instead. Used only
    /// for the GrapiX worker, which refuses gradients today (3.17).
    fn solid_substitute(&self) -> Rgba {
        match self {
            Paint::Solid(c) => *c,
            Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => stops[0].1,
        }
    }
}

#[derive(Clone)]
struct StrokeStyle {
    width: f64,
    join: Join,
    cap: Cap,
    dash: Option<Vec<f64>>,
}

#[derive(Clone)]
enum Cmd {
    Fill { path: BezPath, paint: Paint },
    Stroke { path: BezPath, style: StrokeStyle, paint: Paint },
}

struct Workload {
    name: &'static str,
    cmds: Vec<Cmd>,
    /// Regions compared separately: (label, x, y, w, h).
    rois: Vec<(&'static str, [u32; 4])>,
}

fn rgba(hex: u32) -> Rgba {
    [(hex >> 24) as u8, (hex >> 16) as u8, (hex >> 8) as u8, hex as u8]
}

fn rounded(x: f64, y: f64, w: f64, h: f64, r: f64) -> BezPath {
    RoundedRect::new(x, y, x + w, y + h, r).to_path(0.1)
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> BezPath {
    Rect::new(x, y, x + w, y + h).to_path(0.1)
}

/// (a) Lower third: rounded-rect fill with a 2-stop linear gradient, a 2px
/// stroke, and two text-sized rectangles (at fractional positions, so their
/// edges are anti-aliased too).
fn lower_third() -> Workload {
    let plate = rounded(160.0, 800.0, 1200.0, 160.0, 18.0);
    let cmds = vec![
        Cmd::Fill {
            path: plate.clone(),
            paint: Paint::Linear {
                p0: Point::new(160.0, 0.0),
                p1: Point::new(1360.0, 0.0),
                stops: vec![(0.0, rgba(0x0B2E6BFF)), (1.0, rgba(0x1E88E5FF))],
            },
        },
        Cmd::Stroke {
            path: plate,
            style: StrokeStyle { width: 2.0, join: Join::Miter, cap: Cap::Butt, dash: None },
            paint: Paint::Solid(rgba(0xFFFFFFFF)),
        },
        Cmd::Fill { path: rect(200.5, 830.25, 640.0, 44.0), paint: Paint::Solid(rgba(0xFFFFFFFF)) },
        Cmd::Fill { path: rect(200.5, 892.75, 420.0, 30.0), paint: Paint::Solid(rgba(0xCFE3FFFF)) },
    ];
    Workload {
        name: "lower-third",
        cmds,
        rois: vec![
            // Top-left rounded corner: curved AA edge of fill and stroke.
            ("aa-edge", [150, 790, 48, 48]),
            // Plate interior right of the text: the gradient alone.
            ("gradient", [880, 830, 440, 100]),
        ],
    }
}

/// (b) Scorebug: a panel and 20 small filled rects, half of them stroked.
fn scorebug() -> Workload {
    let palette = [0xC62828FF, 0x1565C0FF, 0xF9A825FF, 0x2E7D32FF, 0x6A1B9AFF, 0xEEEEEEFF];
    let mut cmds = vec![
        Cmd::Fill { path: rounded(48.0, 40.0, 560.0, 72.0, 8.0), paint: Paint::Solid(rgba(0x101418F0)) },
        Cmd::Stroke {
            path: rounded(48.0, 40.0, 560.0, 72.0, 8.0),
            style: StrokeStyle { width: 1.5, join: Join::Round, cap: Cap::Butt, dash: None },
            paint: Paint::Solid(rgba(0xFFFFFF80)),
        },
    ];
    for i in 0..20u32 {
        let x = 60.0 + f64::from(i % 10) * 54.0 + 0.25;
        let y = 48.0 + f64::from(i / 10) * 30.0 + 0.5;
        let path = rounded(x, y, 46.0, 24.0, 3.0);
        cmds.push(Cmd::Fill { path: path.clone(), paint: Paint::Solid(rgba(palette[i as usize % palette.len()])) });
        if i % 2 == 0 {
            cmds.push(Cmd::Stroke {
                path,
                style: StrokeStyle { width: 1.0, join: Join::Miter, cap: Cap::Butt, dash: None },
                paint: Paint::Solid(rgba(0xFFFFFFFF)),
            });
        }
    }
    Workload { name: "scorebug", cmds, rois: vec![("aa-edge", [50, 40, 60, 40])] }
}

/// (c) Full-screen panel: a radial gradient and 50 stroked paths with mixed
/// joins and caps, every other one dashed.
fn full_panel() -> Workload {
    let mut cmds = vec![Cmd::Fill {
        path: rect(0.0, 0.0, f64::from(WIDTH), f64::from(HEIGHT)),
        paint: Paint::Radial {
            centre: Point::new(960.0, 540.0),
            radius: 1100.0,
            stops: vec![(0.0, rgba(0x283593FF)), (0.6, rgba(0x0D1B4AFF)), (1.0, rgba(0x000814FF))],
        },
    }];
    let joins = [Join::Miter, Join::Round, Join::Bevel];
    let caps = [Cap::Butt, Cap::Round, Cap::Square];
    let colours = [0x4FC3F7FF, 0xFFD54FFF, 0xEF5350FF, 0x81C784FF, 0xFFFFFFFF];
    for i in 0..50u32 {
        let x0 = 80.0 + f64::from(i % 10) * 180.0;
        let y0 = 100.0 + f64::from(i / 10) * 190.0;
        let mut path = BezPath::new();
        path.move_to((x0, y0));
        path.line_to((x0 + 40.0, y0 + 60.0));
        path.line_to((x0 + 80.0, y0 + 10.0));
        path.line_to((x0 + 120.0, y0 + 90.0));
        path.line_to((x0 + 150.0, y0 + 30.0));
        path.curve_to((x0 + 200.0, y0 + 60.0), (x0 + 100.0, y0 + 120.0), (x0 + 160.0, y0 + 150.0));
        cmds.push(Cmd::Stroke {
            path,
            style: StrokeStyle {
                width: 2.0 + f64::from(i % 5),
                join: joins[i as usize % 3],
                cap: caps[(i as usize / 3) % 3],
                dash: (i % 2 == 1).then(|| vec![16.0, 8.0]),
            },
            paint: Paint::Solid(rgba(colours[i as usize % colours.len()])),
        });
    }
    Workload {
        name: "full-panel",
        cmds,
        rois: vec![
            // Below the last row of paths: radial gradient only.
            ("gradient", [200, 1025, 1500, 50]),
            // One row of paths, with its dashes, caps and joins.
            ("strokes", [80, 100, 1820, 150]),
        ],
    }
}

// ---------------------------------------------------------------------------
// Paint conversion
// ---------------------------------------------------------------------------

fn colour(c: Rgba) -> Color {
    Color::from_rgba8(c[0], c[1], c[2], c[3])
}

fn gradient(p: &Paint) -> Option<Gradient> {
    let stops = |s: &[(f32, Rgba)]| s.iter().map(|(o, c)| (*o, colour(*c))).collect::<Vec<_>>();
    match p {
        Paint::Solid(_) => None,
        Paint::Linear { p0, p1, stops: s } => Some(Gradient::new_linear(*p0, *p1).with_stops(stops(s).as_slice())),
        Paint::Radial { centre, radius, stops: s } => {
            Some(Gradient::new_radial(*centre, *radius as f32).with_stops(stops(s).as_slice()))
        }
    }
}

fn brush(p: &Paint) -> peniko::Brush {
    match (p, gradient(p)) {
        (Paint::Solid(c), _) => colour(*c).into(),
        (_, Some(g)) => g.into(),
        (_, None) => unreachable!("every non-solid paint is a gradient"),
    }
}

/// Sparse-strip renderers (Hybrid, CPU) take a colour or a gradient.
macro_rules! set_paint {
    ($ctx:expr, $paint:expr) => {
        match $paint {
            Paint::Solid(c) => $ctx.set_paint(colour(*c)),
            other => $ctx.set_paint(gradient(other).expect("gradient")),
        }
    };
}

fn kurbo_stroke(s: &StrokeStyle) -> kurbo::Stroke {
    let stroke = kurbo::Stroke::new(s.width).with_join(s.join).with_caps(s.cap);
    match &s.dash {
        Some(d) => stroke.with_dashes(0.0, d.iter().copied()),
        None => stroke,
    }
}

// ---------------------------------------------------------------------------
// Frames and comparison
// ---------------------------------------------------------------------------

/// sRGB RGBA8, tightly packed, as the backend produced it. Converted to
/// straight alpha only after timing, so analysis costs are never measured.
struct Image {
    pixels: Vec<u8>,
    premultiplied: bool,
}

impl Image {
    fn straight(pixels: Vec<u8>) -> Self {
        Self { pixels, premultiplied: false }
    }
    fn premultiplied(pixels: Vec<u8>) -> Self {
        Self { pixels, premultiplied: true }
    }
    fn into_straight(self) -> Self {
        if self.premultiplied { Self::straight(unpremultiply(self.pixels)) } else { self }
    }
}

fn unpremultiply(mut px: Vec<u8>) -> Vec<u8> {
    for p in px.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        if a != 0 && a != 255 {
            for c in &mut p[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    px
}

fn premultiply(px: &[u8]) -> Vec<u8> {
    let mut out = px.to_vec();
    for p in out.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        for c in &mut p[..3] {
            *c = ((u32::from(*c) * a + 127) / 255) as u8;
        }
    }
    out
}

#[derive(Clone, Copy)]
struct Diff {
    differing: u64,
    total: u64,
    worst: u8,
    mean_abs: f64,
}

/// Compared in premultiplied space, so a fully transparent pixel's colour
/// (meaningless) never counts as a difference.
fn diff(a: &Image, b: &Image, roi: Option<[u32; 4]>) -> Diff {
    let pa = premultiply(&a.pixels);
    let pb = premultiply(&b.pixels);
    let [x0, y0, w, h] = roi.unwrap_or([0, 0, WIDTH, HEIGHT]);
    let (mut differing, mut worst, mut sum) = (0u64, 0u8, 0u64);
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let i = ((y * WIDTH + x) * 4) as usize;
            let mut differs = false;
            for c in 0..4 {
                let d = pa[i + c].abs_diff(pb[i + c]);
                differs |= d != 0;
                worst = worst.max(d);
                sum += u64::from(d);
            }
            differing += u64::from(differs);
        }
    }
    let total = u64::from(w) * u64::from(h);
    Diff { differing, total, worst, mean_abs: sum as f64 / (total * 4) as f64 }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let rank = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

struct Timing {
    p50: f64,
    p99: f64,
    mean: f64,
}

fn time<F: FnMut() -> Result<Image>>(mut frame: F) -> Result<(Timing, Image)> {
    for _ in 0..WARMUPS {
        frame()?;
    }
    let mut samples = Vec::with_capacity(SAMPLES);
    let mut last = None;
    for _ in 0..SAMPLES {
        let start = Instant::now();
        let image = frame()?;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        last = Some(image);
    }
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    samples.sort_by(|a, b| a.total_cmp(b));
    let image = last.unwrap().into_straight();
    Ok((Timing { p50: percentile(&samples, 50.0), p99: percentile(&samples, 99.0), mean }, image))
}

// ---------------------------------------------------------------------------
// GPU readback, shared by wgpu 30 (Vello classic) and wgpu 29 (Vello Hybrid)
// ---------------------------------------------------------------------------

macro_rules! gpu_support {
    ($module:ident, $wgpu:path) => {
        mod $module {
            use $wgpu as wgpu;

            /// wgpu 30 returns the mapped range as a Result, wgpu 29 does not.
            trait IntoView {
                fn view(self) -> super::Result<wgpu::BufferView>;
            }
            impl IntoView for wgpu::BufferView {
                fn view(self) -> super::Result<wgpu::BufferView> {
                    Ok(self)
                }
            }
            impl<E: std::fmt::Debug> IntoView for Result<wgpu::BufferView, E> {
                fn view(self) -> super::Result<wgpu::BufferView> {
                    self.map_err(|e| format!("mapped range: {e:?}").into())
                }
            }

            pub fn device(backend: &str, dxc: Option<&str>) -> super::Result<(wgpu::Device, wgpu::Queue, String)> {
                let (backends, expected) = match backend {
                    "dx12" => (wgpu::Backends::DX12, wgpu::Backend::Dx12),
                    "vulkan" => (wgpu::Backends::VULKAN, wgpu::Backend::Vulkan),
                    other => return Err(format!("unknown backend {other}").into()),
                };
                let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
                descriptor.backends = backends;
                if let Some(path) = dxc {
                    descriptor.backend_options.dx12.shader_compiler =
                        wgpu::Dx12Compiler::DynamicDxc { dxc_path: path.to_string() };
                }
                let compiler = format!("{:?}", descriptor.backend_options.dx12.shader_compiler);
                let instance = wgpu::Instance::new(descriptor);
                let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    force_fallback_adapter: false,
                    ..Default::default()
                }))
                .map_err(|e| format!("{backend}: no adapter: {e}"))?;
                let info = adapter.get_info();
                if info.backend != expected
                    || !matches!(info.device_type, wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu)
                {
                    return Err(format!("required hardware {backend} adapter unavailable: {info:?}").into());
                }
                let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                    label: Some("vello-spike"),
                    ..Default::default()
                }))?;
                Ok((device, queue, format!("{} ({:?}, driver {} {}; dx12 compiler {})", info.name, info.backend, info.driver, info.driver_info, compiler)))
            }

            pub fn target(device: &wgpu::Device, usage: wgpu::TextureUsages) -> (wgpu::Texture, wgpu::TextureView, wgpu::Buffer) {
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("vello-spike target"),
                    size: wgpu::Extent3d { width: super::WIDTH, height: super::HEIGHT, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: usage | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                });
                let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
                let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("vello-spike readback"),
                    size: u64::from(padded_row()) * u64::from(super::HEIGHT),
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                });
                (texture, view, buffer)
            }

            fn padded_row() -> u32 {
                (super::WIDTH * 4).next_multiple_of(256)
            }

            /// Copy the target into the buffer on `encoder`, submit, wait, and
            /// return tightly packed RGBA8.
            pub fn read_back(
                device: &wgpu::Device,
                queue: &wgpu::Queue,
                mut encoder: wgpu::CommandEncoder,
                texture: &wgpu::Texture,
                buffer: &wgpu::Buffer,
            ) -> super::Result<Vec<u8>> {
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                    wgpu::TexelCopyBufferInfo {
                        buffer,
                        layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded_row()), rows_per_image: None },
                    },
                    wgpu::Extent3d { width: super::WIDTH, height: super::HEIGHT, depth_or_array_layers: 1 },
                );
                queue.submit([encoder.finish()]);
                let slice = buffer.slice(..);
                let (sender, receiver) = std::sync::mpsc::channel();
                slice.map_async(wgpu::MapMode::Read, move |r| {
                    let _ = sender.send(r);
                });
                device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("poll: {e:?}"))?;
                receiver.recv()?.map_err(|e| format!("map: {e:?}"))?;
                let mut out = Vec::with_capacity((super::WIDTH * super::HEIGHT * 4) as usize);
                {
                    let mapped = slice.get_mapped_range().view()?;
                    for row in mapped.chunks_exact(padded_row() as usize) {
                        out.extend_from_slice(&row[..(super::WIDTH * 4) as usize]);
                    }
                }
                buffer.unmap();
                Ok(out)
            }
        }
    };
}

gpu_support!(gpu30, vello::wgpu);
gpu_support!(gpu29, wgpu29);

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

struct Classic {
    device: vello::wgpu::Device,
    queue: vello::wgpu::Queue,
    renderer: vello::Renderer,
    texture: vello::wgpu::Texture,
    view: vello::wgpu::TextureView,
    buffer: vello::wgpu::Buffer,
}

impl Classic {
    fn new(backend: &str, dxc: Option<&str>) -> Result<(Self, String, f64)> {
        let (device, queue, info) = gpu30::device(backend, dxc)?;
        let start = Instant::now();
        let renderer = vello::Renderer::new(
            &device,
            vello::RendererOptions {
                use_cpu: false,
                antialiasing_support: vello::AaSupport::area_only(),
                num_init_threads: None,
                pipeline_cache: None,
            },
        )
        .map_err(|e| format!("vello renderer: {e}"))?;
        let init_ms = start.elapsed().as_secs_f64() * 1000.0;
        let (texture, view, buffer) = gpu30::target(&device, vello::wgpu::TextureUsages::STORAGE_BINDING);
        Ok((Self { device, queue, renderer, texture, view, buffer }, info, init_ms))
    }

    /// `readback: false` waits for the GPU to finish instead of copying the
    /// frame back, separating render cost from the 8 MB transfer.
    fn frame(&mut self, w: &Workload, readback: bool) -> Result<Image> {
        let mut scene = vello::Scene::new();
        for cmd in &w.cmds {
            match cmd {
                Cmd::Fill { path, paint } => scene.fill(Fill::NonZero, Affine::IDENTITY, &brush(paint), None, path),
                Cmd::Stroke { path, style, paint } => {
                    scene.stroke(&kurbo_stroke(style), Affine::IDENTITY, &brush(paint), None, path)
                }
            }
        }
        self.renderer
            .render_to_texture(
                &self.device,
                &self.queue,
                &scene,
                &self.view,
                &vello::RenderParams {
                    base_color: Color::TRANSPARENT,
                    width: WIDTH,
                    height: HEIGHT,
                    antialiasing_method: vello::AaConfig::Area,
                },
            )
            .map_err(|e| format!("vello render: {e}"))?;
        if !readback {
            self.device.poll(vello::wgpu::PollType::wait_indefinitely()).map_err(|e| format!("poll: {e:?}"))?;
            return Ok(Image::straight(Vec::new()));
        }
        let encoder = self.device.create_command_encoder(&Default::default());
        // Classic Vello stores straight (separated) alpha.
        let pixels = gpu30::read_back(&self.device, &self.queue, encoder, &self.texture, &self.buffer)?;
        Ok(Image::straight(pixels))
    }
}

struct Hybrid {
    device: wgpu29::Device,
    queue: wgpu29::Queue,
    renderer: vello_hybrid::Renderer,
    resources: vello_hybrid::Resources,
    scene: vello_hybrid::Scene,
    texture: wgpu29::Texture,
    view: wgpu29::TextureView,
    buffer: wgpu29::Buffer,
}

impl Hybrid {
    fn new(backend: &str, dxc: Option<&str>) -> Result<(Self, String, f64)> {
        let (device, queue, info) = gpu29::device(backend, dxc)?;
        let start = Instant::now();
        let (renderer, resources) = vello_hybrid::Renderer::new(
            &device,
            &vello_hybrid::RenderTargetConfig {
                format: wgpu29::TextureFormat::Rgba8Unorm,
                width: WIDTH,
                height: HEIGHT,
            },
        );
        let init_ms = start.elapsed().as_secs_f64() * 1000.0;
        let (texture, view, buffer) = gpu29::target(&device, wgpu29::TextureUsages::RENDER_ATTACHMENT);
        let scene = vello_hybrid::Scene::new(WIDTH as u16, HEIGHT as u16);
        Ok((Self { device, queue, renderer, resources, scene, texture, view, buffer }, info, init_ms))
    }

    fn frame(&mut self, w: &Workload, readback: bool) -> Result<Image> {
        let scene = &mut self.scene;
        scene.reset();
        for cmd in &w.cmds {
            match cmd {
                Cmd::Fill { path, paint } => {
                    set_paint!(scene, paint);
                    scene.fill_path(path);
                }
                Cmd::Stroke { path, style, paint } => {
                    scene.set_stroke(kurbo_stroke(style));
                    set_paint!(scene, paint);
                    scene.stroke_path(path);
                }
            }
        }
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.renderer
            .render(
                scene,
                &mut self.resources,
                &self.device,
                &self.queue,
                &mut encoder,
                &vello_hybrid::RenderSize { width: WIDTH, height: HEIGHT },
                &self.view,
                &vello_hybrid::TextureBindings::new(),
            )
            .map_err(|e| format!("vello_hybrid render: {e:?}"))?;
        if !readback {
            self.queue.submit([encoder.finish()]);
            self.device.poll(wgpu29::PollType::wait_indefinitely()).map_err(|e| format!("poll: {e:?}"))?;
            return Ok(Image::straight(Vec::new()));
        }
        // Hybrid writes premultiplied alpha.
        let pixels = gpu29::read_back(&self.device, &self.queue, encoder, &self.texture, &self.buffer)?;
        Ok(Image::premultiplied(pixels))
    }
}

/// Vello CPU (sparse strips on the CPU, single-threaded): the same algorithm
/// family as Hybrid, so the natural CPU reference for it.
struct VelloCpu {
    ctx: vello_cpu::RenderContext,
    pixmap: vello_cpu::Pixmap,
    resources: vello_cpu::Resources,
}

fn vello_cpu_frame(state: &mut VelloCpu, w: &Workload) -> Result<Image> {
    let ctx = &mut state.ctx;
    ctx.reset();
    for cmd in &w.cmds {
        match cmd {
            Cmd::Fill { path, paint } => {
                set_paint!(ctx, paint);
                ctx.fill_path(path);
            }
            Cmd::Stroke { path, style, paint } => {
                ctx.set_stroke(kurbo_stroke(style));
                set_paint!(ctx, paint);
                ctx.stroke_path(path);
            }
        }
    }
    ctx.flush();
    state.pixmap.data_as_u8_slice_mut().fill(0);
    ctx.render(&mut state.pixmap, &mut state.resources);
    Ok(Image::premultiplied(state.pixmap.data_as_u8_slice().to_vec()))
}

/// tiny-skia: an independent, analytic-coverage CPU rasteriser (Skia's
/// algorithm), used as the CPU reference every GPU backend is compared with.
fn tiny_skia_frame(pixmap: &mut tiny_skia::Pixmap, w: &Workload) -> Result<Image> {
    use tiny_skia as ts;
    pixmap.fill(ts::Color::TRANSPARENT);
    let colour = |c: Rgba| ts::Color::from_rgba8(c[0], c[1], c[2], c[3]);
    let stops = |s: &[(f32, Rgba)]| s.iter().map(|(o, c)| ts::GradientStop::new(*o, colour(*c))).collect::<Vec<_>>();
    let pt = |p: Point| ts::Point::from_xy(p.x as f32, p.y as f32);
    for cmd in &w.cmds {
        let (path, paint_spec) = match cmd {
            Cmd::Fill { path, paint } | Cmd::Stroke { path, paint, .. } => (path, paint),
        };
        let mut builder = ts::PathBuilder::new();
        for el in path.elements() {
            match *el {
                kurbo::PathEl::MoveTo(p) => builder.move_to(p.x as f32, p.y as f32),
                kurbo::PathEl::LineTo(p) => builder.line_to(p.x as f32, p.y as f32),
                kurbo::PathEl::QuadTo(a, p) => builder.quad_to(a.x as f32, a.y as f32, p.x as f32, p.y as f32),
                kurbo::PathEl::CurveTo(a, b, p) => {
                    builder.cubic_to(a.x as f32, a.y as f32, b.x as f32, b.y as f32, p.x as f32, p.y as f32)
                }
                kurbo::PathEl::ClosePath => builder.close(),
            }
        }
        let path = builder.finish().ok_or("empty path")?;
        let mut paint = ts::Paint { anti_alias: true, ..Default::default() };
        paint.shader = match paint_spec {
            Paint::Solid(c) => ts::Shader::SolidColor(colour(*c)),
            Paint::Linear { p0, p1, stops: s } => {
                ts::LinearGradient::new(pt(*p0), pt(*p1), stops(s), ts::SpreadMode::Pad, ts::Transform::identity())
                    .ok_or("linear gradient")?
            }
            Paint::Radial { centre, radius, stops: s } => ts::RadialGradient::new(
                pt(*centre),
                0.0,
                pt(*centre),
                *radius as f32,
                stops(s),
                ts::SpreadMode::Pad,
                ts::Transform::identity(),
            )
            .ok_or("radial gradient")?,
        };
        match cmd {
            Cmd::Fill { .. } => pixmap.fill_path(&path, &paint, ts::FillRule::Winding, ts::Transform::identity(), None),
            Cmd::Stroke { style, .. } => {
                let stroke = ts::Stroke {
                    width: style.width as f32,
                    miter_limit: 4.0,
                    line_cap: match style.cap {
                        Cap::Butt => ts::LineCap::Butt,
                        Cap::Round => ts::LineCap::Round,
                        Cap::Square => ts::LineCap::Square,
                    },
                    line_join: match style.join {
                        Join::Miter => ts::LineJoin::Miter,
                        Join::Round => ts::LineJoin::Round,
                        Join::Bevel => ts::LineJoin::Bevel,
                    },
                    dash: style.dash.as_ref().and_then(|d| ts::StrokeDash::new(d.iter().map(|v| *v as f32).collect(), 0.0)),
                };
                pixmap.stroke_path(&path, &paint, &stroke, ts::Transform::identity(), None)
            }
        }
    }
    Ok(Image::premultiplied(pixmap.data().to_vec()))
}

// ---------------------------------------------------------------------------
// The existing GrapiX CPU rasteriser, driven unchanged through its public API
// ---------------------------------------------------------------------------

/// Express a workload as a SceneDocument the worker accepts. The worker
/// refuses gradients and has no dashes or join/cap choice, so those become a
/// flat first-stop paint and a plain stroke; the scene is otherwise the same
/// geometry. Paths are emitted as `shape` objects with straight-segment
/// vertices (curves flattened at 0.1px) so both sides draw the same outline.
fn worker_scene(w: &Workload) -> serde_json::Value {
    let solid = |c: Rgba| {
        serde_json::json!({"type": "solid", "color": {
            "r": f64::from(c[0]) / 255.0, "g": f64::from(c[1]) / 255.0,
            "b": f64::from(c[2]) / 255.0, "a": f64::from(c[3]) / 255.0, "space": "srgb"}})
    };
    let mut objects = Vec::new();
    for (i, cmd) in w.cmds.iter().enumerate() {
        let (path, paint, stroke) = match cmd {
            Cmd::Fill { path, paint } => (path, paint, None),
            Cmd::Stroke { path, style, paint } => (path, paint, Some(style)),
        };
        // One subpath per object here (every workload path is one subpath).
        let mut vertices = Vec::new();
        let mut closed = false;
        kurbo::flatten(path.elements().iter().copied(), 0.1, |el| match el {
            kurbo::PathEl::MoveTo(p) | kurbo::PathEl::LineTo(p) => vertices.push(serde_json::json!({"x": p.x, "y": p.y})),
            kurbo::PathEl::ClosePath => closed = true,
            _ => {}
        });
        let zeros: Vec<_> = vertices.iter().map(|_| serde_json::json!({"x": 0.0, "y": 0.0})).collect();
        let mut object = serde_json::json!({
            "type": "shape", "id": format!("o{i}"), "name": format!("o{i}"),
            "x": 0.0, "y": 0.0, "width": WIDTH, "height": HEIGHT,
            "path": {"closed": closed, "vertices": vertices, "inTangents": zeros, "outTangents": zeros},
        });
        match stroke {
            None => {
                object["fillEnabled"] = true.into();
                object["fill"] = solid(paint.solid_substitute());
            }
            Some(style) => {
                object["fillEnabled"] = false.into();
                object["strokeEnabled"] = true.into();
                object["stroke"] = solid(paint.solid_substitute());
                object["strokeWidth"] = style.width.into();
            }
        }
        objects.push(object);
    }
    serde_json::json!({
        "id": format!("vello-spike-{}", w.name), "name": w.name, "version": 3,
        "workingColorSpace": "srgb",
        "canvas": {"width": WIDTH, "height": HEIGHT, "frameRate": {"num": 50, "den": 1}},
        "timeline": {"durationFrames": 1}, "dataContext": {}, "assets": [], "fonts": [], "materials": [],
        "objects": objects,
    })
}

fn worker_prepare(w: &Workload) -> Result<gx_render_worker::PreparedScene> {
    let bytes = serde_json::to_vec(&worker_scene(w))?;
    let document = gx_contracts::scene::parse_scene_document(&bytes).map_err(|e| format!("{e:?}"))?;
    gx_render_worker::PreparedScene::prepare(
        document,
        &HashSet::new(),
        &gx_render_worker::AssetBytes::default(),
        &gx_contracts::material::MaterialSupport::fixed_function(),
    )
    .map_err(|e| format!("worker refused: {e:?}").into())
}

fn worker_frame(scene: &gx_render_worker::PreparedScene) -> Result<Image> {
    let frame = scene
        .frame_at(0, gx_contracts::color::OutputTransform::Srgb)
        .map_err(|e| format!("worker frame: {e:?}"))?;
    Ok(Image::straight(frame.pixels))
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// |a - b| per pixel (largest premultiplied channel), x16, on opaque black.
fn heatmap(a: &Image, b: &Image) -> Image {
    let (pa, pb) = (premultiply(&a.pixels), premultiply(&b.pixels));
    let mut out = Vec::with_capacity(pa.len());
    for (x, y) in pa.chunks_exact(4).zip(pb.chunks_exact(4)) {
        let d = x.iter().zip(y).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        let v = (u32::from(d) * 16).min(255) as u8;
        out.extend_from_slice(&[v, v, v, 255]);
    }
    Image::straight(out)
}

fn write_png(dir: &Path, name: &str, image: &Image) -> Result<()> {
    let frame = gx_render_worker::Frame { width: WIDTH, height: HEIGHT, pixels: image.pixels.clone() };
    std::fs::write(dir.join(name), gx_render_worker::headless::encode_png(&frame))?;
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("FAIL {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let backend = args.next().ok_or("usage: gx-vello-spike <dx12|vulkan> <out-dir> [dxcompiler.dll] | negotiate")?;
    if backend == "negotiate" {
        // The product's own device negotiation, unchanged (0.2's wgpu check).
        let gpu = gx_render_worker::gpu::negotiate();
        println!(
            "NEGOTIATE tier {:?}; hardware {}; max_texture_dimension_2d {:?}",
            gpu.tier(),
            gpu.has_hardware(),
            gpu.max_texture_dimension_2d()
        );
        return Ok(());
    }
    let out: PathBuf = args.next().ok_or("out-dir required")?.into();
    let dxc = args.next();
    std::fs::create_dir_all(&out)?;
    println!("BACKEND {backend}; {WIDTH}x{HEIGHT} RGBA8; {WARMUPS} warmups, {SAMPLES} samples; times include scene encoding and readback");

    let (mut classic, classic_info, classic_init) = Classic::new(&backend, dxc.as_deref())?;
    println!("CLASSIC adapter {classic_info}; renderer init {classic_init:.1} ms");
    let (mut hybrid, hybrid_info, hybrid_init) = Hybrid::new(&backend, dxc.as_deref())?;
    println!("HYBRID adapter {hybrid_info}; renderer init {hybrid_init:.1} ms");

    let tolerance = gx_render_worker::headless::CROSS_MACHINE_TOLERANCE;
    let mut cpu = VelloCpu {
        ctx: vello_cpu::RenderContext::new(WIDTH as u16, HEIGHT as u16),
        pixmap: vello_cpu::Pixmap::new(WIDTH as u16, HEIGHT as u16),
        resources: vello_cpu::Resources::new(),
    };
    let mut skia = tiny_skia::Pixmap::new(WIDTH, HEIGHT).ok_or("pixmap")?;
    println!();
    println!("| workload | backend | p50 ms | p99 ms | mean ms |");
    println!("|---|---|---:|---:|---:|");
    let mut comparisons = Vec::new();
    for w in [lower_third(), scorebug(), full_panel()] {
        let worker = worker_prepare(&w)?;
        let mut rows: Vec<(&str, Timing, Image)> = Vec::new();
        let (classic_gpu, _) = time(|| classic.frame(&w, false))?;
        let (hybrid_gpu, _) = time(|| hybrid.frame(&w, false))?;
        let (t, i) = time(|| classic.frame(&w, true))?;
        rows.push(("vello-classic", t, i));
        let (t, i) = time(|| hybrid.frame(&w, true))?;
        rows.push(("vello-hybrid", t, i));
        let (t, i) = time(|| vello_cpu_frame(&mut cpu, &w))?;
        rows.push(("vello-cpu", t, i));
        let (t, i) = time(|| tiny_skia_frame(&mut skia, &w))?;
        rows.push(("tiny-skia", t, i));
        let (t, i) = time(|| worker_frame(&worker))?;
        rows.push(("grapix-worker-cpu*", t, i));
        for (name, t) in [("vello-classic, no readback", &classic_gpu), ("vello-hybrid, no readback", &hybrid_gpu)] {
            println!("| {} | {} | {:.3} | {:.3} | {:.3} |", w.name, name, t.p50, t.p99, t.mean);
        }
        for (name, t, image) in &rows {
            println!("| {} | {} | {:.3} | {:.3} | {:.3} |", w.name, name, t.p50, t.p99, t.mean);
            write_png(&out, &format!("{}-{}-{}.png", backend, w.name, name.trim_end_matches('*')), image)?;
        }
        let find = |n: &str| &rows.iter().find(|r| r.0 == n).unwrap().2;
        for (a, b) in [
            ("vello-classic", "tiny-skia"),
            ("vello-hybrid", "tiny-skia"),
            ("vello-hybrid", "vello-cpu"),
            ("vello-classic", "vello-cpu"),
            ("vello-cpu", "tiny-skia"),
        ] {
            if matches!((a, b), ("vello-classic", "tiny-skia") | ("vello-hybrid", "vello-cpu")) {
                write_png(&out, &format!("{backend}-{}-diff-{a}-vs-{b}.png", w.name), &heatmap(find(a), find(b)))?;
            }
            let mut regions = vec![("full", None)];
            regions.extend(w.rois.iter().map(|(l, r)| (*l, Some(*r))));
            for (label, roi) in regions {
                let d = diff(find(a), find(b), roi);
                comparisons.push(format!(
                    "| {} | {} vs {} | {} | {} | {:.4}% | {} | {:.3} | {} |",
                    w.name, a, b, label, d.differing, 100.0 * d.differing as f64 / d.total as f64, d.worst, d.mean_abs,
                    if tolerance.admits(d.differing, d.total, d.worst) { "PASS" } else { "FAIL" }
                ));
            }
        }
    }
    println!();
    println!("* grapix-worker-cpu draws the same geometry with gradients replaced by their first stop and plain strokes (no dashes, joins, caps): it refuses gradients today and has none of those stroke options. It is point-sampled, not anti-aliased.");
    println!();
    println!("Comparison in premultiplied RGBA8; verdict uses CROSS_MACHINE_TOLERANCE (max 1 code value, <= 0.1% pixels).");
    println!("| workload | pair | region | differing px | share | worst channel | mean abs | gate |");
    println!("|---|---|---|---:|---:|---:|---:|---|");
    for line in comparisons {
        println!("{line}");
    }
    Ok(())
}
