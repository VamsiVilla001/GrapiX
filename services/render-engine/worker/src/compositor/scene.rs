//! SceneDocument mapping for 3.16. Object-local CPU-prepared source textures
//! bridge 3.17/3.18; only prepare can call the source rasterisers. Each frame
//! evaluates semantic transforms/opacity and composites the cached sources
//! on the GPU. No scene frame can fall back to CPU rasterisation.
use gx_contracts::animation::{evaluate_channel, set_base_property, KeyframeChannel};
use gx_contracts::material::BlendMode;
use gx_contracts::scene::{resolve_hierarchy, ResolvedObject, SceneDocument, SceneObject, Vec2};
use gx_contracts::Refusal;
use serde::Serialize;
use std::sync::Arc;

use super::output::{Delivered, OutputRing, Submitted};
use super::{CompositorError, LayerInput, LayerState, PreparedCompositor};
use crate::gpu::Gpu;
use crate::prepared::PreparedScene;
use crate::rasterise::{LyonPathRasteriser, PathRasteriser, PreparedPaths, RasterSurface};
use crate::rasterizer::Frame;
use crate::tiling::{Stage, StageOrigin};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTrace {
    pub object_id: String,
    pub document_path: String,
    pub object_kind: String,
    pub route: &'static str,
    pub width: u32,
    pub height: u32,
}

struct MappedLayer {
    object_index: usize,
    origin: [f64; 2],
    object_id: String,
    blend_mode: BlendMode,
}

/// The Dissolve seed of a layer at a frame; 0 for modes that use none.
fn frame_seed(object_id: &str, mode: BlendMode, scene_frame: u64) -> u32 {
    match mode {
        BlendMode::Dissolve | BlendMode::DancingDissolve => {
            crate::blend::dissolve_seed(object_id, mode, scene_frame)
        }
        _ => 0,
    }
}

pub struct GpuScene {
    compositor: PreparedCompositor,
    // 3.21: GPU output encode and the bounded asynchronous readback ring,
    // built with the compositor at prepare.
    ring: OutputRing,
    // Mutable semantic evaluation scratch owned by this pinned GPU revision.
    // Authoring and the immutable PreparedScene are never changed.
    evaluated: SceneDocument,
    channels: Vec<KeyframeChannel>,
    layers: Vec<MappedLayer>,
    states: Vec<LayerState>,
    sources: Vec<SourceTrace>,
    clear_frame: Arc<Frame>,
}

impl GpuScene {
    pub fn prepare(gpu: &Gpu, scene: &PreparedScene) -> Result<Self, Refusal> {
        let doc = scene.resolved_document();
        if let Some(refusal) = gx_contracts::drawability::gpu_compositor_animation_refusal(doc) {
            return Err(refusal);
        }
        let limit = gpu
            .max_texture_dimension_2d()
            .ok_or(Refusal::TierTooLow { actual: gpu.tier() })?;
        let mut inputs = Vec::new();
        let mut layers = Vec::new();
        let mut sources = Vec::new();
        for index in PreparedScene::draw_order(doc) {
            let object = &doc.objects[index];
            if matches!(
                object,
                SceneObject::Group(_)
                    | SceneObject::Layer(_)
                    | SceneObject::Camera(_)
                    | SceneObject::Marker(_)
            ) {
                continue;
            }
            let id = object.base().id.clone();
            let path = format!("objects[{index}]");
            // Semantic validation already refuses unsupported object kinds,
            // gradients, materials, masks and text features by name.
            let mut local = doc.clone();
            local.objects = vec![object.clone()];
            let resolved = &scene.effective()[index];
            let anchor = object.base().anchor.unwrap_or(Vec2 { x: 0.0, y: 0.0 });
            let phase = [resolved.x - anchor.x, resolved.y - anchor.y];
            // Preserve the reference's exact coverage rounding at initial
            // integer translations. Only the CPU source rasteriser sees this
            // sampling phase; GPU coordinates remain texture/tile-local.
            let phase = if resolved.scale_x == 1.0
                && resolved.scale_y == 1.0
                && resolved.rotation_z.rem_euclid(360.0) == 0.0
                && phase.iter().all(|v| v.fract() == 0.0 && v.abs() < 1e6)
            {
                phase
            } else {
                [0.0, 0.0]
            };
            let base = local.objects[0].base_mut();
            base.x = phase[0];
            base.y = phase[1];
            base.rotation = 0.0;
            base.scale_x = 1.0;
            base.scale_y = 1.0;
            base.anchor = None;
            base.opacity = 1.0;
            base.visible = true;
            let effective = resolve_hierarchy(&local.objects).effective;
            let paths = PreparedPaths::prepare(&local, &effective)?;
            let mut bounds: Option<[f64; 4]> = None;
            let mut point = |x: f64, y: f64| {
                let b = bounds.get_or_insert([x, y, x, y]);
                b[0] = b[0].min(x);
                b[1] = b[1].min(y);
                b[2] = b[2].max(x);
                b[3] = b[3].max(y);
            };
            for path in paths.paths() {
                for v in path.vertices() {
                    point(f64::from(v.x), f64::from(v.y));
                }
            }
            if let Some(text) = scene.texts().objects.iter().find(|t| t.object_id == id) {
                for &[x, y] in &text.vertices {
                    point(
                        f64::from((f64::from(x) + phase[0]) as f32),
                        f64::from((f64::from(y) + phase[1]) as f32),
                    );
                }
            }
            let b = bounds.unwrap_or([0.0, 0.0, 0.0, 0.0]);
            let origin = [b[0].floor() - 1.0, b[1].floor() - 1.0];
            let width = b[2].ceil() - origin[0] + 1.0;
            let height = b[3].ceil() - origin[1] + 1.0;
            if !width.is_finite()
                || !height.is_finite()
                || width > f64::from(limit)
                || height > f64::from(limit)
            {
                return Err(mapping_refusal(&id, &path,
                    &format!("CPU-prepared source {width}x{height} exceeds device limit {limit}; source tiling requires 3.17/3.18")));
            }
            let (width, height) = (width.max(1.0) as u32, height.max(1.0) as u32);
            crate::render_work::cpu_source();
            let mut surface = RasterSurface::window(width, height, origin);
            let object_paths: Vec<_> = paths.paths().iter().collect();
            LyonPathRasteriser.rasterise_into(&object_paths, &mut surface);
            if matches!(object, SceneObject::Text(_)) {
                crate::text::rasterise_text(scene.texts(), &id, &local, &effective, &mut surface)?;
            }
            let origin = [origin[0] - phase[0], origin[1] - phase[1]];
            let blend_mode = object.base().blend_mode;
            let mut state = layer_state(object.base().anchor, resolved, origin);
            state.seed = frame_seed(&id, blend_mode, 0);
            inputs.push(LayerInput {
                object_id: id.clone(),
                document_path: path.clone(),
                width,
                height,
                pixels: surface.pixels().to_vec(),
                working_space: doc.working_color_space,
                blend_mode,
                state,
            });
            sources.push(SourceTrace {
                object_id: id.clone(),
                document_path: path,
                object_kind: object.kind().into(),
                route: "cpu-prepared-source-at-prepare",
                width,
                height,
            });
            layers.push(MappedLayer {
                object_index: index,
                origin,
                object_id: id,
                blend_mode,
            });
        }
        let stage = Stage::new(
            doc.canvas.width,
            doc.canvas.height,
            StageOrigin { x: 0.0, y: 0.0 },
        )
        .map_err(|e| mapping_refusal(&doc.id, "canvas", &e.to_string()))?;
        let compositor = PreparedCompositor::prepare(gpu, stage, doc.working_color_space, &inputs)
            .map_err(compositor_refusal)?;
        let ring = compositor.output_ring().map_err(compositor_refusal)?;
        let states = inputs.iter().map(|input| input.state).collect();
        let clear_frame = Arc::new(Frame {
            width: doc.canvas.width,
            height: doc.canvas.height,
            pixels: vec![0; doc.canvas.width as usize * doc.canvas.height as usize * 4],
        });
        Ok(Self {
            compositor,
            ring,
            evaluated: doc.clone(),
            channels: doc.timeline.channels.clone(),
            layers,
            states,
            sources,
            clear_frame,
        })
    }

    pub fn sources(&self) -> &[SourceTrace] {
        &self.sources
    }
    pub fn clear_frame(&self) -> Arc<Frame> {
        self.clear_frame.clone()
    }

    /// Evaluate `scene_frame`, composite it and queue its output encode and
    /// readback under `tag` (3.21). Never waits for the GPU.
    pub fn submit(&mut self, scene_frame: u64, tag: u64) -> Result<Submitted, Refusal> {
        if !self.ring.has_idle_slot() {
            self.ring.note_ring_full();
            return Ok(Submitted::RingFull);
        }
        for channel in &self.channels {
            if let Some(value) = evaluate_channel(channel, scene_frame)? {
                set_base_property(
                    &mut self.evaluated,
                    &channel.object_id,
                    &channel.property,
                    value,
                )?;
            }
        }
        let effective = resolve_hierarchy(&self.evaluated.objects).effective;
        for (state, layer) in self.states.iter_mut().zip(&self.layers) {
            let object = &self.evaluated.objects[layer.object_index];
            *state = layer_state(
                object.base().anchor,
                &effective[layer.object_index],
                layer.origin,
            );
            state.seed = frame_seed(&layer.object_id, layer.blend_mode, scene_frame);
        }
        self.compositor
            .composite(&self.states)
            .map_err(compositor_refusal)?;
        Ok(self.ring.submit(tag))
    }

    /// The newest frame whose readback completed, without waiting.
    pub fn collect(&mut self) -> Result<Option<Delivered>, Refusal> {
        self.ring.collect().map_err(compositor_refusal)
    }

    /// Give a frame allocation back to the readback ring for reuse.
    pub fn recycle(&mut self, pixels: Vec<u8>) {
        self.ring.recycle(pixels);
    }

    /// Readback refusals and superseded frames, for the frame-timing report.
    pub fn ring_counters(&self) -> (u64, u64) {
        (self.ring.ring_full(), self.ring.superseded())
    }

    /// Render one frame and wait for it: for callers outside the live loop
    /// (tests, synchronous renders). Returns (Program, Preview).
    pub fn render(&mut self, scene_frame: u64) -> Result<(Frame, Frame), Refusal> {
        const SETTLED: u64 = u64::MAX;
        if self.submit(scene_frame, SETTLED)? == Submitted::RingFull {
            // Drain the frames already in flight, then submit again.
            while self.ring.collect().map_err(compositor_refusal)?.is_some() {}
            self.ring
                .wait_for_idle(std::time::Duration::from_secs(5))
                .map_err(compositor_refusal)?;
            if self.ring.submit(SETTLED) == Submitted::RingFull {
                return Err(compositor_refusal(CompositorError::Readback(
                    "no readback slot became idle".into(),
                )));
            }
        }
        let delivered = self
            .ring
            .wait_for(SETTLED, std::time::Duration::from_secs(5))
            .map_err(compositor_refusal)?;
        Ok((delivered.program, delivered.preview))
    }
}

#[cfg(test)]
impl GpuScene {
    /// The settled render plus the working-space pixels the GPU composited,
    /// so a test can check the GPU output encode against the CPU encode of
    /// the same pixels (3.21: exactly one quantisation, byte-identical).
    pub fn render_with_working(
        &mut self,
        scene_frame: u64,
    ) -> Result<(Frame, Frame, super::CompositeReference), Refusal> {
        let (program, preview) = self.render(scene_frame)?;
        let working = self.compositor.readback_working().map_err(compositor_refusal)?;
        Ok((program, preview, working))
    }
}

fn layer_state(anchor: Option<Vec2>, resolved: &ResolvedObject, origin: [f64; 2]) -> LayerState {
    // A zero-scale object has zero area. Hide it with an invertible identity
    // rather than rejecting a legitimate zero scale or inventing pixels.
    if resolved.scale_x == 0.0 || resolved.scale_y == 0.0 {
        return LayerState {
            opacity: 0.0,
            ..LayerState::default()
        };
    }
    let (sin, cos) = resolved.rotation_z.to_radians().sin_cos();
    let [a, b, c, d] = [
        cos * resolved.scale_x,
        sin * resolved.scale_x,
        -sin * resolved.scale_y,
        cos * resolved.scale_y,
    ];
    let anchor = anchor.unwrap_or(Vec2 { x: 0.0, y: 0.0 });
    let [x, y] = [origin[0] - anchor.x, origin[1] - anchor.y];
    LayerState {
        affine: [
            a,
            b,
            c,
            d,
            resolved.x + a * x + c * y,
            resolved.y + b * x + d * y,
        ],
        opacity: if resolved.visible {
            resolved.opacity as f32
        } else {
            0.0
        },
        seed: 0,
    }
}

pub(crate) fn mapping_refusal(id: &str, path: &str, detail: &str) -> Refusal {
    Refusal::ScenePropertyNotDrawable {
        object: id.into(),
        property: format!("{path}: {detail}"),
        owner: "3.16".into(),
    }
}

pub(crate) fn compositor_refusal(error: CompositorError) -> Refusal {
    match error {
        CompositorError::Mapping {
            object_id,
            document_path,
            detail,
        } => mapping_refusal(&object_id, &document_path, &detail),
        other => Refusal::TransportFailed {
            detail: format!("GPU compositor: {other}"),
        },
    }
}
