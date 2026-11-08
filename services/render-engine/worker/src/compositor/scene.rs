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
    // 3.22: each layer's effect stack, re-packed in place every frame from
    // the evaluated scene (no per-frame allocation).
    effects: Vec<Option<crate::effect_chain::EffectPlan>>,
    effect_contexts: Vec<crate::effect_chain::EffectContext>,
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
        let mut contexts = Vec::new();
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
            let resolved = &scene.effective()[index];
            // 3.22: padded by the effect stack's largest reach over every
            // frame, and Box Blur sized to its largest iteration count.
            let (pad, iterations) = crate::effect_chain::layer_extent(doc, index)?;
            let source = crate::layer_source::prepare_layer_source(doc, scene.effective(), scene.texts(), index, pad, limit)?;
            let (width, height) = (source.surface.width(), source.surface.height());
            let surface = source.surface;
            let origin = source.origin;
            let blend_mode = object.base().blend_mode();
            let instances = object.base().effects();
            let effect_ctx = crate::effect_chain::EffectContext {
                origin,
                size: [object.base().width, object.base().height],
                space: doc.working_color_space,
            };
            let effects = (!instances.is_empty()).then(|| {
                let mut plan = crate::effect_chain::EffectPlan::layout(instances, &iterations);
                plan.pack(instances, &effect_ctx);
                plan
            });
            let mut state = layer_state(object.base().anchor, resolved, origin);
            state.seed = frame_seed(&id, blend_mode, 0);
            contexts.push(effect_ctx);
            inputs.push(LayerInput {
                object_id: id.clone(),
                document_path: path.clone(),
                width,
                height,
                pixels: surface.pixels().to_vec(),
                working_space: doc.working_color_space,
                blend_mode,
                effects,
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
        let effects = inputs.iter().map(|input| input.effects.clone()).collect();
        let effect_contexts = contexts;
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
            effects,
            effect_contexts,
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
        for ((plan, layer), ctx) in self.effects.iter_mut().zip(&self.layers).zip(&self.effect_contexts) {
            if let Some(plan) = plan {
                plan.pack(self.evaluated.objects[layer.object_index].base().effects(), ctx);
            }
        }
        self.compositor
            .composite_with_effects(&self.states, Some(&self.effects))
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

pub(crate) fn layer_state(anchor: Option<Vec2>, resolved: &ResolvedObject, origin: [f64; 2]) -> LayerState {
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
