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

/// 11.112: a layer whose source is drawn again each frame, because its object
/// animates a path.
struct AnimatedSource {
    object_index: usize,
    plan: crate::layer_source::SourceRedraw,
    text: Option<gx_contracts::scene::TextObject>,
    reshaped: Option<crate::text::PreparedTexts>,
}

struct MappedLayer {
    object_index: usize,
    origin: [f64; 2],
    object_id: String,
    blend_mode: BlendMode,
    /// 3.19: a clip child, placed as its group's matte.
    matte: bool,
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
    // 11.112: sources drawn again each frame, and what they are drawn with.
    animated: Vec<AnimatedSource>,
    draw: Option<crate::gpu::DrawHandle>,
    texts: crate::text::PreparedTexts,
    animated_font_bytes: std::sync::Arc<crate::mesh::AssetBytes>,
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
        let mut animated = Vec::new();
        // 3.19: clip groups become per-frame mattes.
        let clips = crate::clip::ClipPlan::of(doc);
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
            let source = crate::layer_source::prepare_layer_source(
                doc,
                scene.effective(),
                scene.texts(),
                index,
                pad,
                limit,
                Some(gpu),
                scene.images(),
                Some(scene.animated_font_bytes()),
            )?;
            let (width, height) = (source.width, source.height);
            if let Some(plan) = source.redraw.clone() {
                let text = match object {
                    SceneObject::Text(text) => Some(text.clone()),
                    _ => None,
                };
                animated.push(AnimatedSource {
                    object_index: index,
                    plan,
                    text,
                    reshaped: None,
                });
            } else if crate::layer_source::animates_source(doc, &id) {
                return Err(mapping_refusal(
                    &id,
                    &path,
                    "animated geometry needs its source drawn on the GPU every frame",
                ));
            }
            let route = match (source.drawn.is_some(), object) {
                (true, SceneObject::Image(_)) => "gpu-image-fit-at-prepare",
                (true, _) => "gpu-vello-coverage-at-prepare",
                (false, _) => "cpu-prepared-source-at-prepare",
            };
            let origin = source.origin;
            let blend_mode = object.base().blend_mode();
            let instances = object.base().effects();
            let effect_ctx = crate::effect_chain::EffectContext {
                origin,
                size: [object.base().width, object.base().height],
                space: doc.working_color_space,
                depth: doc.color_depth,
            };
            let effects = (!instances.is_empty()).then(|| {
                let mut plan = crate::effect_chain::EffectPlan::layout(instances, &iterations);
                plan.pack(instances, &effect_ctx);
                plan
            });
            let matte = clips.is_matte(index);
            let mut state = if matte {
                matte_state(
                    object.base().anchor,
                    resolved,
                    origin,
                    object.base().opacity,
                )
            } else {
                layer_state(object.base().anchor, resolved, origin)
            };
            state.seed = frame_seed(&id, blend_mode, 0);
            contexts.push(effect_ctx);
            inputs.push(LayerInput {
                object_id: id.clone(),
                document_path: path.clone(),
                width,
                height,
                pixels: source
                    .surface
                    .as_ref()
                    .map_or_else(Vec::new, |surface| surface.pixels().to_vec()),
                working_space: doc.working_color_space,
                drawn: source.drawn,
                blend_mode,
                effects,
                state,
                matte,
                clip: None,
                track: None,
                preserve: object.base().preserves_underlying_transparency(),
                effect_weights: source
                    .effect_weights
                    .iter()
                    .map(|w| match w {
                        Some(crate::layer_source::EffectWeights::Gpu(texture)) => Some(texture.clone()),
                        _ => None,
                    })
                    .collect(),
            });
            sources.push(SourceTrace {
                object_id: id.clone(),
                document_path: path,
                object_kind: object.kind().into(),
                route,
                width,
                height,
            });
            layers.push(MappedLayer {
                object_index: index,
                origin,
                object_id: id.clone(),
                blend_mode,
                matte,
            });
            // 3.30 (Masking spec v2, 6.2): a track matte source is a matte
            // whether or not it is seen, and it is also drawn like any layer
            // when its own visibility says so. The matte layer above reads at
            // the source's own opacity; this copy of it, drawn in the frame
            // at its effective opacity (zero when hidden), shows it.
            if matte
                && clips.is_source.get(index) == Some(&true)
                && clips.is_clip.get(index) != Some(&true)
            {
                let mut seen = inputs.last().expect("the matte was just pushed").clone();
                seen.matte = false;
                seen.state = layer_state(object.base().anchor, resolved, origin);
                seen.state.seed = frame_seed(&id, blend_mode, 0);
                inputs.push(seen);
                let context = *contexts
                    .last()
                    .expect("the matte's context was just pushed");
                contexts.push(context);
                layers.push(MappedLayer {
                    object_index: index,
                    origin,
                    object_id: id,
                    blend_mode,
                    matte: false,
                });
            }
        }
        // 3.19: each clipped layer reads its clip child's matte.
        // A source's matte layer, not its drawn copy, is what clips and mattes read.
        let layer_of: std::collections::HashMap<usize, usize> = layers
            .iter()
            .enumerate()
            .filter(|(_, layer)| layer.matte)
            .map(|(i, layer)| (layer.object_index, i))
            .collect();
        for (input, layer) in inputs.iter_mut().zip(&layers) {
            input.clip = clips.clip_of[layer.object_index].and_then(|c| layer_of.get(&c).copied());
            // 3.30 (spec 6.4): a matte reads its source BEFORE the source's own track matte, so the matte layer of a source takes none
            // (its drawn copy and a plain layer do), and a source that is itself matted, or two layers matting each other, never recurse.
            input.track = if layer.matte {
                None
            } else {
                clips.track_of[layer.object_index].and_then(|(source, mode)| Some((*layer_of.get(&source)?, mode)))
            };
        }
        let stage = Stage::new(
            doc.canvas.width,
            doc.canvas.height,
            StageOrigin { x: 0.0, y: 0.0 },
        )
        .map_err(|e| mapping_refusal(&doc.id, "canvas", &e.to_string()))?;
        let mut compositor =
            PreparedCompositor::prepare(gpu, stage, doc.working_color_space, &inputs)
                .map_err(compositor_refusal)?;
        compositor.set_depth(doc.color_depth);
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
            animated,
            draw: gpu.draw_handle(),
            texts: scene.texts().clone(),
            animated_font_bytes: scene.animated_font_bytes().clone(),
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
        self.compose_at(scene_frame)?;
        Ok(self.ring.submit(tag))
    }

    /// Draw into the working-space GPU tiles without encoding the output.
    fn compose_at(&mut self, scene_frame: u64) -> Result<(), Refusal> {
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
        // 11.112: animated paths, by vertex id; a key held for a topology
        // mismatch is the reference's answer too. Each animated source is drawn
        // again, into the texture it was prepared with, before the frame is composed.
        if !self.animated.is_empty() {
            gx_contracts::animation::colour::apply(&mut self.evaluated, scene_frame)?;
            gx_contracts::path_anim::apply_path_channels(&mut self.evaluated, scene_frame)?;
            let draw = self.draw.as_ref().ok_or(Refusal::TierTooLow { actual: gx_contracts::DeviceTier::T2 })?;
            for animated in &mut self.animated {
                if let (Some(previous), SceneObject::Text(text)) =
                    (&mut animated.text, &self.evaluated.objects[animated.object_index])
                {
                    if crate::prepared::text_layout_changed(previous, text) {
                        let shaped = crate::text::prepare_text_object(
                            &self.evaluated, text, &self.animated_font_bytes,
                        )?;
                        animated.reshaped = Some(crate::text::PreparedTexts { objects: vec![shaped] });
                        previous.clone_from(text);
                    }
                }
                crate::layer_source::redraw_layer_source(
                    &mut self.evaluated,
                    animated.reshaped.as_ref().unwrap_or(&self.texts),
                    animated.object_index,
                    draw,
                    &animated.plan,
                )?;
            }
        }
        let effective = resolve_hierarchy(&self.evaluated.objects).effective;
        for (state, layer) in self.states.iter_mut().zip(&self.layers) {
            let object = &self.evaluated.objects[layer.object_index];
            *state = if layer.matte {
                matte_state(
                    object.base().anchor,
                    &effective[layer.object_index],
                    layer.origin,
                    object.base().opacity,
                )
            } else {
                layer_state(
                    object.base().anchor,
                    &effective[layer.object_index],
                    layer.origin,
                )
            };
            state.seed = frame_seed(&layer.object_id, layer.blend_mode, scene_frame);
        }
        for ((plan, layer), ctx) in self
            .effects
            .iter_mut()
            .zip(&self.layers)
            .zip(&self.effect_contexts)
        {
            if let Some(plan) = plan {
                plan.pack(
                    self.evaluated.objects[layer.object_index].base().effects(),
                    ctx,
                );
            }
        }
        self.compositor
            .composite_with_effects(&self.states, Some(&self.effects))
            .map_err(compositor_refusal)?;
        Ok(())
    }

    /// Draw this scene at `scene_frame` into its working-space tiles and stop there: no output encode, no readback. A layer stack takes
    /// the tiles from here (task 112); the scene's own output ring is not used for it.
    pub fn compose(&mut self, scene_frame: u64) -> Result<(), Refusal> {
        self.compose_at(scene_frame)
    }

    /// The tiles `compose` just drew, for a layer stack to take.
    pub fn composed_tiles(&self) -> Option<impl ExactSizeIterator<Item = (crate::tiling::Tile, &wgpu::Texture)>> {
        self.compositor.output_tiles()
    }

    /// The stage, working space and colour depth a stack of scenes like this one needs, and a stack built for them.
    pub fn new_stack(&self) -> Result<super::stack::LayerStack, Refusal> {
        self.compositor.new_stack().map_err(compositor_refusal)
    }

    /// The canvas size, working space and colour depth: what scenes on one stack must share.
    pub fn stack_key(&self) -> (u32, u32, gx_contracts::color::WorkingColorSpace, gx_contracts::color::ColorDepth) {
        let (stage, space, depth, _) = self.compositor.stack_shape();
        (stage.width, stage.height, space, depth)
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
        let working = self
            .compositor
            .readback_working()
            .map_err(compositor_refusal)?;
        Ok((program, preview, working))
    }
}

pub(crate) fn layer_state(
    anchor: Option<Vec2>,
    resolved: &ResolvedObject,
    origin: [f64; 2],
) -> LayerState {
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

/// A clip child's placement as its group's matte (3.19): its layer state at
/// its own opacity, not its effective one (the group's opacity already reaches
/// the clipped objects), whether visible or not. A zero-scale clip child has
/// no area and clips everything away.
pub(crate) fn matte_state(
    anchor: Option<Vec2>,
    resolved: &ResolvedObject,
    origin: [f64; 2],
    own_opacity: f64,
) -> LayerState {
    let mut state = layer_state(anchor, resolved, origin);
    if resolved.scale_x != 0.0 && resolved.scale_y != 0.0 {
        state.opacity = own_opacity as f32;
    }
    state
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
