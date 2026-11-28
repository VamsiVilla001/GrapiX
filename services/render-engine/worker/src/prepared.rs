//! Scene parse to prepared scene (build plan 3.4).
//!
//! A published document is authoring data: ids pointing at other ids, colours
//! in whatever space they were authored in, a hierarchy expressed as parent
//! claims. A rasteriser needs none of that — it needs resolved transforms,
//! bound assets and a font it can shape with. Doing that resolution per frame
//! is the fault invariant 35 records: 1.x rebuilt its prepared scene every
//! Program frame and paid 482 ms for it.
//!
//! So preparation happens **once per publish**, and it is where every
//! "this scene cannot be rendered" answer is produced. That placement is the
//! point: a scene that refuses at publish refuses while an operator is still
//! looking at an editor, not at the moment somebody takes it to air. Every
//! refusal here is named (invariant 17), and nothing is approximated to keep
//! a broken scene renderable (invariant 18).
//!
//! Vector paths, text and mesh state are all built here exactly once. Program
//! consumes the resulting immutable data; it never reparses authoring fields
//! or resolves ids per frame.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use gx_contracts::animation::{evaluate_channel, set_base_property, validate_scene_animation};
use gx_contracts::color::OutputTransform;
use gx_contracts::control::validate_control_fields;
use gx_contracts::material::{BlendMode, MaterialSupport};
use gx_contracts::phases::{validate_phases, PhaseKind, TimelinePhase};
use gx_contracts::scene::{
    resolve_hierarchy, HierarchyDiagnostic, ResolvedObject, SceneDocument, SceneObject,
};
use gx_contracts::text_style::validate_text_styles;
use gx_contracts::validate::validate_scene_document;
use gx_contracts::{ContentHash, Refusal};

use crate::mesh::{prepare_meshes, AssetBytes, PreparedMeshes};
use crate::rasterise::{PathRasteriser, PreparedPaths, RasterSurface, VelloCpuRasteriser};
use crate::rasterizer::Frame;
use crate::text::{prepare_text_object, prepare_texts, PreparedTexts};

/// A document resolved into what a renderer actually consumes.
///
/// Immutable by construction: it is built from a document that has already
/// been pinned to a revision, and publishing is additive (invariant 30), so
/// there is no method here that mutates one. A second publish makes a second
/// `PreparedScene`.
#[derive(Debug, Clone)]
pub struct PreparedScene {
    document: SceneDocument,
    /// The document with its bindings applied against its data context
    /// (3.13). What renders, and what animation evaluates on; `document`
    /// stays the authored one.
    resolved: SceneDocument,
    /// Effective transforms and state, resolved once (1.2's resolver).
    effective: Vec<ResolvedObject>,
    /// 3.22: each object with effects, drawn once in its own padded layer
    /// space (the GPU's source too), with its Box Blur iteration counts.
    effect_layers: Vec<Option<EffectLayer>>,
    /// 3.19: each object's clip group matte and whether it is a clip child.
    clips: crate::clip::ClipPlan,
    /// Hierarchy diagnostics. Preparation refuses any repaired edge, so a
    /// successfully prepared scene has none; retained for inspection callers.
    diagnostics: Vec<HierarchyDiagnostic>,
    /// Object index, so a lookup during rendering is not a linear scan of the
    /// draw list for every reference.
    by_id: HashMap<String, usize>,
    /// Tessellated vector draw commands, built once per publication.
    paths: PreparedPaths,
    /// CPU reference only. Built at reference preparation or lazily for an
    /// explicit headless render; GPU publication and Program never need it.
    static_frame: OnceLock<RasterSurface>,
    /// Shaped glyph runs, restricted to fonts carried by the scene.
    texts: PreparedTexts,
    animated_font_bytes: std::sync::Arc<AssetBytes>,
    /// 3.17: every image object's decoded image, by asset id.
    images: crate::image::PreparedImages,
    /// Prepared primitive/glTF geometry, materials, lights and camera.
    meshes: PreparedMeshes,
}

impl PreparedScene {
    /// Resolve a document against what this engine holds and can draw.
    ///
    /// `available` is the set of content hashes the asset plane has verified
    /// into the store. A scene declaring bytes the engine does not hold is a
    /// take blocker, not a scene with a missing picture (invariant 29): it
    /// refuses here, before anything can cue it.
    pub fn prepare(
        document: SceneDocument,
        available: &HashSet<ContentHash>,
        asset_bytes: &AssetBytes,
        support: &MaterialSupport,
    ) -> Result<Self, Refusal> {
        Self::prepare_inner(document, available, asset_bytes, support, true)
    }

    /// Engine semantic preparation. The CPU reference frame is lazy: GPU
    /// publication and Program never build a CPU full-stage surface. A
    /// subsequent explicit headless/reference request can still build it.
    pub(crate) fn prepare_for_gpu(
        document: SceneDocument,
        available: &HashSet<ContentHash>,
        asset_bytes: &AssetBytes,
        support: &MaterialSupport,
    ) -> Result<Self, Refusal> {
        Self::prepare_inner(document, available, asset_bytes, support, false)
    }

    fn prepare_inner(
        document: SceneDocument,
        available: &HashSet<ContentHash>,
        asset_bytes: &AssetBytes,
        support: &MaterialSupport,
        build_reference: bool,
    ) -> Result<Self, Refusal> {
        // Document-level validation is the shared implementation in
        // `gx_contracts::validate`, not a copy here. The Editor must be able
        // to give a designer the same answer before publish, and it cannot
        // call into this crate (invariant 3) — so the rules live in contracts
        // and both sides run them (invariant 27, and 7.4's done-when).
        //
        // The validator reports every fault because an author fixing a scene
        // needs the whole list. Preparation only needs to know it cannot
        // proceed, so it takes the first and stops.
        validate_scene_animation(&document)?;
        validate_phases(&document.timeline)?;
        validate_control_fields(&document)?;
        validate_text_styles(&document)?;
        if let Some(refusal) = validate_scene_document(&document, support, available, true)
            .into_iter()
            .next()
        {
            return Err(refusal.code);
        }
        // 3.13: bindings apply, all or nothing, as the Editor's preview applies
        // them; the bound document is what renders.
        let mut resolved = gx_contracts::bindings::resolve_scene_bindings(&document)?;
        // 11.113: an auto vertex's handles are derived once, here, by the one function
        // every consumer shares; nothing downstream sees the stored ones.
        gx_contracts::path_anim::resolve_auto_paths(&mut resolved);
        // 3.13: what this engine cannot draw refuses by name, never drops.
        crate::support::refuse_what_the_software_path_cannot_draw(&resolved)?;

        let resolution = resolve_hierarchy(&resolved.objects);
        let texts = prepare_texts(&resolved, asset_bytes)?;
        let paths = PreparedPaths::prepare(&resolved, &resolution.effective, Some(&texts))?;
        let meshes = prepare_meshes(&resolved, available, asset_bytes, support)?;
        // 3.17: images are decoded once, then drawn as layers.
        let images = crate::image::prepare_images(&resolved, asset_bytes)?;
        let clips = crate::clip::ClipPlan::of(&resolved);
        let mut effect_layers = Vec::with_capacity(resolved.objects.len());
        for (index, object) in resolved.objects.iter().enumerate() {
            // An object with effects or masks, every image and every clip
            // child is drawn in its own layer space and warped onto the
            // canvas as the GPU composites it.
            if object.base().effects().is_empty()
                && object.base().masks().is_empty()
                && !matches!(object, SceneObject::Image(_))
                && !clips.is_matte(index)
            {
                effect_layers.push(None);
                continue;
            }
            let (pad, iterations) = crate::effect_chain::layer_extent(&resolved, index)?;
            let source = crate::layer_source::prepare_layer_source(
                &resolved,
                &resolution.effective,
                &texts,
                index,
                pad,
                u32::MAX,
                None,
                &images,
                None,
            )?;
            effect_layers.push(Some(EffectLayer { source, iterations, pad }));
        }
        let static_frame = OnceLock::new();
        if build_reference {
            let _ = static_frame.set(compose(
                &resolved,
                &resolution.effective,
                &paths,
                0,
                &effect_layers,
                &clips,
            )?);
        }
        let by_id = resolution
            .effective
            .iter()
            .enumerate()
            .map(|(index, object)| (object.id.clone(), index))
            .collect();

        let animated_font_bytes = if resolved.timeline.channels.iter().any(|channel| {
            !channel.keys.is_empty()
                && matches!(
                    channel.property.as_str(),
                    "size" | "lineHeight" | "letterSpacing" | "baselineShift"
                )
        }) {
            resolved
                .assets
                .iter()
                .filter(|asset| asset.kind == gx_contracts::scene::AssetKind::Font)
                .filter_map(|asset| asset.checksum.as_ref())
                .filter_map(|hash| Some((hash.clone(), asset_bytes.get(hash)?.clone())))
                .collect()
        } else {
            AssetBytes::new()
        };

        Ok(Self {
            document,
            resolved,
            effective: resolution.effective,
            effect_layers,
            clips,
            diagnostics: resolution.diagnostics,
            by_id,
            paths,
            static_frame,
            texts,
            animated_font_bytes: std::sync::Arc::new(animated_font_bytes),
            images,
            meshes,
        })
    }

    /// The document this was prepared from.
    pub fn document(&self) -> &SceneDocument {
        &self.document
    }

    pub(crate) fn resolved_document(&self) -> &SceneDocument {
        &self.resolved
    }

    /// Every object's effective state, in the document's source order.
    pub fn effective(&self) -> &[ResolvedObject] {
        &self.effective
    }

    /// The objects that draw: everything that is not a container.
    pub fn renderable(&self) -> impl Iterator<Item = &ResolvedObject> {
        self.effective.iter().filter(|object| !object.is_container)
    }

    /// One object's effective state.
    pub fn effective_object(&self, id: &str) -> Option<&ResolvedObject> {
        self.by_id
            .get(id)
            .and_then(|index| self.effective.get(*index))
    }

    /// Hierarchy edges the resolver refused. Reported, never silently lost.
    pub fn diagnostics(&self) -> &[HierarchyDiagnostic] {
        &self.diagnostics
    }

    /// Tessellated vector content ready for any `PathRasteriser` backend.
    pub fn paths(&self) -> &PreparedPaths {
        &self.paths
    }

    /// Encode the static frame for one explicit output transform. It was
    /// composed once at publish, in draw order across object kinds.
    pub fn frame(&self, output: OutputTransform) -> Frame {
        self.static_frame
            .get_or_init(|| {
                compose(
                    &self.resolved,
                    &self.effective,
                    &self.paths,
                    0,
                    &self.effect_layers,
                    &self.clips,
                )
                .expect("semantically prepared static reference remains drawable")
            })
            .encode(output, self.document.working_color_space)
    }
    /// Whether Program must evaluate this scene for each output frame.
    pub fn has_animation(&self) -> bool {
        // A Dancing Dissolve layer changes its pattern every frame (3.20).
        self.document
            .timeline
            .channels
            .iter()
            .any(|channel| !channel.keys.is_empty())
            || gx_contracts::path_anim::has_path_animation(&self.document)
            || self.document.timeline.colour_channels.iter().flatten().any(|channel| !channel.keys.is_empty())
            || self
                .document
                .objects
                .iter()
                .any(|object| object.base().blend_mode() == BlendMode::DancingDissolve)
    }

    /// A named phase prepared with this revision.
    pub fn phase(&self, address: &str) -> Option<&TimelinePhase> {
        self.document
            .timeline
            .phases
            .iter()
            .find(|phase| phase.address() == address)
    }

    /// Phases of one operator kind, in authored timeline order.
    pub fn phases_of(&self, kind: PhaseKind) -> impl Iterator<Item = &TimelinePhase> {
        self.document
            .timeline
            .phases
            .iter()
            .filter(move |phase| phase.kind == kind)
    }

    /// Render one authored scene frame through the same Rust evaluator the
    /// Editor is pinned against.
    ///
    /// Static scenes retain the prepared-surface fast path. The software T2
    /// reference backend re-rasterises animated geometry for correctness; the
    /// hardware backend will map these evaluated properties to GPU uniforms.
    pub fn frame_at(&self, scene_frame: u64, output: OutputTransform) -> Result<Frame, Refusal> {
        if !self.has_animation() {
            return Ok(self.frame(output));
        }

        let mut evaluated = self.resolved.clone();
        for channel in &self.resolved.timeline.channels {
            if let Some(value) = evaluate_channel(channel, scene_frame)? {
                set_base_property(&mut evaluated, &channel.object_id, &channel.property, value)?;
            }
        }
        // 11.112: animated paths, by vertex id; a topology mismatch holds a key and is not an error.
        gx_contracts::animation::colour::apply(&mut evaluated, scene_frame)?;
        gx_contracts::path_anim::apply_path_channels(&mut evaluated, scene_frame)?;
        let resolution = resolve_hierarchy(&evaluated.objects);
        let texts = self.texts_at(&evaluated)?;
        let paths = PreparedPaths::prepare(&evaluated, &resolution.effective, Some(&texts))?;
        let layers = self.layers_at(&mut evaluated, &resolution.effective, &texts)?;
        let surface = compose(
            &evaluated,
            &resolution.effective,
            &paths,
            scene_frame,
            &layers,
            &self.clips,
        )?;
        Ok(surface.encode(output, self.document.working_color_space))
    }

    /// The draw order composition uses: the document's order, stably sorted
    /// by `z_index` ("draw order within a layer"), the order the Editor's
    /// viewport also uses.
    pub fn draw_order(document: &SceneDocument) -> Vec<usize> {
        let mut order: Vec<usize> = (0..document.objects.len()).collect();
        order.sort_by_key(|&index| document.objects[index].base().z_index);
        order
    }

    /// The composited working-space surface at a scene frame, before any
    /// output encode: the CPU reference's own float pixels (3.20 gates).
    #[cfg(test)]
    pub(crate) fn working_at(&self, scene_frame: u64) -> Result<RasterSurface, Refusal> {
        let mut evaluated = self.resolved.clone();
        for channel in &self.resolved.timeline.channels {
            if let Some(value) = evaluate_channel(channel, scene_frame)? {
                set_base_property(&mut evaluated, &channel.object_id, &channel.property, value)?;
            }
        }
        // 11.112: animated paths, by vertex id; a topology mismatch holds a key and is not an error.
        gx_contracts::animation::colour::apply(&mut evaluated, scene_frame)?;
        gx_contracts::path_anim::apply_path_channels(&mut evaluated, scene_frame)?;
        let resolution = resolve_hierarchy(&evaluated.objects);
        let texts = self.texts_at(&evaluated)?;
        let paths = PreparedPaths::prepare(&evaluated, &resolution.effective, Some(&texts))?;
        let layers = self.layers_at(&mut evaluated, &resolution.effective, &texts)?;
        compose(
            &evaluated,
            &resolution.effective,
            &paths,
            scene_frame,
            &layers,
            &self.clips,
        )
    }

    /// Reuse the published runs except for text whose evaluated layout changed.
    fn texts_at(&self, evaluated: &SceneDocument) -> Result<std::borrow::Cow<'_, PreparedTexts>, Refusal> {
        use std::borrow::Cow;

        let mut texts = Cow::Borrowed(&self.texts);
        let mut text_index = 0;
        for (authored, current) in self.resolved.objects.iter().zip(&evaluated.objects) {
            let (SceneObject::Text(authored), SceneObject::Text(current)) = (authored, current) else {
                continue;
            };
            if text_layout_changed(authored, current) {
                texts.to_mut().objects[text_index] =
                    prepare_text_object(evaluated, current, &self.animated_font_bytes)?;
            }
            text_index += 1;
        }
        Ok(texts)
    }

    /// Rebuild affected layer sources with bounds that fit the evaluated pixels.
    fn layers_at(
        &self,
        evaluated: &mut SceneDocument,
        effective: &[ResolvedObject],
        texts: &PreparedTexts,
    ) -> Result<std::borrow::Cow<'_, [Option<EffectLayer>]>, Refusal> {
        let mut layers = std::borrow::Cow::Borrowed(self.effect_layers.as_slice());
        for (index, previous) in self.effect_layers.iter().enumerate() {
            let Some(previous) = previous else { continue };
            let authored = &self.resolved.objects[index];
            let current = &evaluated.objects[index];
            let scalar_change = authored.base().stroke_width != current.base().stroke_width
                || authored.base().fill != current.base().fill
                || authored.base().stroke != current.base().stroke
                || authored.base().stroke_style != current.base().stroke_style
                || match (authored, current) {
                    (SceneObject::Text(a), SceneObject::Text(b)) => {
                        text_layout_changed(a, b) || a.text_animator != b.text_animator
                    },
                    (SceneObject::Rect(a), SceneObject::Rect(b)) => a.radius != b.radius,
                    (SceneObject::Shape(a), SceneObject::Shape(b)) => {
                        a.trim_start != b.trim_start || a.trim_end != b.trim_end || a.trim_offset != b.trim_offset
                    }
                    _ => false,
                };
            let source = if scalar_change {
                crate::layer_source::prepare_layer_source(
                    evaluated, effective, texts, index, previous.pad, u32::MAX, None, &self.images, None,
                )?
            } else if crate::layer_source::animates_a_path(&self.resolved, &authored.base().id) {
                crate::layer_source::redraw_layer_source_cpu(evaluated, texts, index, &previous.source)?
            } else {
                continue;
            };
            layers.to_mut()[index] = Some(EffectLayer {
                source,
                iterations: previous.iterations.clone(),
                pad: previous.pad,
            });
        }
        Ok(layers)
    }

    pub(crate) fn animated_font_bytes(&self) -> &std::sync::Arc<AssetBytes> {
        &self.animated_font_bytes
    }

    /// Glyph runs shaped from packaged fonts only.
    pub fn texts(&self) -> &PreparedTexts {
        &self.texts
    }

    /// Every image object's decoded image, by asset id (3.17).
    pub fn images(&self) -> &crate::image::PreparedImages {
        &self.images
    }

    /// Geometry, material assignments, lights and active camera.
    pub fn meshes(&self) -> &PreparedMeshes {
        &self.meshes
    }
}

/// Compose a frame in draw order across object kinds (3.13). Before this,
/// every vector was drawn first, then every text, whatever the scene said.
/// Meshes are refused at publish (`support.rs`), so there are none to draw.
///
/// 3.22: an object with effects takes the same route; its effect stack runs
/// on that layer (`crate::effects`, the CPU reference) before it is blended.
///
/// 3.20: an object in a blend mode other than `normal` is drawn alone onto a
/// transparent layer the size of the canvas, and that layer is blended onto
/// what is below it pixel by pixel through `crate::blend`, the CPU reference
/// the GPU compositor is held to. The whole canvas is visited, because the
/// stencil and silhouette modes change the backdrop outside the object too.
/// A hidden or fully transparent object changes nothing, in every mode.
pub(crate) fn text_layout_changed(a: &gx_contracts::scene::TextObject, b: &gx_contracts::scene::TextObject) -> bool {
    a.size != b.size
        || a.line_height != b.line_height
        || a.letter_spacing != b.letter_spacing
        || a.baseline_shift != b.baseline_shift
}

/// An object with effects in its own layer space (3.22).
#[derive(Debug, Clone)]
struct EffectLayer {
    source: crate::layer_source::LayerSource,
    iterations: Vec<usize>,
    pad: u32,
}

fn compose(
    document: &SceneDocument,
    effective: &[ResolvedObject],
    paths: &PreparedPaths,
    scene_frame: u64,
    effect_layers: &[Option<EffectLayer>],
    clips: &crate::clip::ClipPlan,
) -> Result<RasterSurface, Refusal> {
    crate::render_work::cpu_frame();
    let mut surface = RasterSurface::transparent(document.canvas.width, document.canvas.height)
        .with_depth(document.color_depth);
    let mut by_object: HashMap<&str, Vec<&crate::rasterise::PreparedPath>> = HashMap::new();
    for path in paths.paths() {
        by_object.entry(path.object_id()).or_default().push(path);
    }
    let layers = LayerPixels {
        document,
        effective,
        effect_layers,
    };
    // 3.19: each clip child's and track matte source's matte this frame,
    // built when first needed.
    let mut mattes: HashMap<usize, Vec<crate::colour_pipeline::WorkingRgba>> = HashMap::new();
    for index in PreparedScene::draw_order(document) {
        let object = &document.objects[index];
        let id = object.base().id.as_str();
        let mode = object.base().blend_mode();
        let effects = object.base().effects();
        // 3.19: a clip child is never drawn itself; it is a matte. A track
        // matte source is a matte too, and is also drawn like any layer when
        // its own visibility says so (3.30, Masking spec v2, 6.2).
        if clips.is_clip.get(index) == Some(&true) {
            continue;
        }
        let clip = clips.clip_of.get(index).copied().flatten();
        let track = clips.track_of.get(index).copied().flatten();
        // 3.28: Preserve Underlying Transparency is drawn alone too, then scaled
        // by the alpha of what is below it.
        let preserve = object.base().preserves_underlying_transparency();
        if clip.is_some() || track.is_some() || preserve {
            // 3.19: a clipped or matted object is drawn alone, as the GPU
            // samples it, multiplied by its clip's matte alpha and then by its
            // track matte's value, then blended in its mode.
            let resolved = &effective[index];
            if !(resolved.visible && resolved.opacity > 0.0) {
                continue;
            }
            let mut layer = RasterSurface::transparent(surface.width(), surface.height())
                .with_depth(document.color_depth);
            if let Some((pixels, w, h, rows, state)) = layers.warped(index)? {
                layer.warp_blend(&pixels, w, h, &rows, state.opacity, BlendMode::Normal, 0);
            } else if let Some(object_paths) = by_object.get(id) {
                VelloCpuRasteriser.rasterise_into(object_paths, &mut layer);
            }
            for &index in clip.iter().chain(track.map(|(source, _)| source).iter()) {
                matte(&layers, clips, index, &mut mattes)?;
            }
            if let Some(clip) = clip {
                for (px, m) in layer.pixels_mut().iter_mut().zip(&mattes[&clip]) {
                    *px = px.scaled(m.a);
                }
            }
            if let Some((source, mode)) = track {
                for (px, m) in layer.pixels_mut().iter_mut().zip(&mattes[&source]) {
                    *px = px.scaled(crate::clip::track_value(*m, mode));
                }
            }
            if preserve {
                for (px, below) in layer.pixels_mut().iter_mut().zip(surface.pixels()) {
                    *px = px.scaled(below.a);
                }
            }
            surface.blend_layer(
                &layer,
                mode,
                crate::blend::dissolve_seed(id, mode, scene_frame),
            );
            continue;
        }
        if effect_layers.get(index).and_then(Option::as_ref).is_some() {
            // 3.22: the effects run on the object's layer-space pixels (the
            // GPU's source), which are then warped onto the canvas exactly
            // as the composite pass samples them.
            let resolved = &effective[index];
            if !(resolved.visible && resolved.opacity > 0.0) {
                continue;
            }
            let (pixels, w, h, rows, state) = layers
                .warped(index)?
                .expect("an object with a layer is warped from it");
            let seed = crate::blend::dissolve_seed(id, mode, scene_frame);
            surface.warp_blend(&pixels, w, h, &rows, state.opacity, mode, seed);
            continue;
        }
        if mode != BlendMode::Normal {
            let shown = effective
                .get(index)
                .is_some_and(|resolved| resolved.visible && resolved.opacity > 0.0);
            if !shown {
                continue;
            }
            let mut layer = RasterSurface::transparent(surface.width(), surface.height())
                .with_depth(document.color_depth);
            if let Some(object_paths) = by_object.get(id) {
                VelloCpuRasteriser.rasterise_into(object_paths, &mut layer);
            }
            if !effects.is_empty() {
                // 3.22: effects act on the layer's own pixels before its
                // opacity, as After Effects orders them: the paths and glyphs
                // of an object with effects are drawn at full opacity
                // (`PreparedPaths::prepare`, `text`), and it applies here.
                let opacity = effective[index].opacity as f32;
                let chain: Vec<crate::effects::PackedEffect> = effects
                    .iter()
                    .map(|instance| {
                        let mut packed = crate::effects::PackedEffect::identity();
                        packed.pack(instance, document.working_color_space);
                        packed
                    })
                    .collect();
                crate::effects::apply_chain(&chain, layer.pixels_mut());
                layer.scale(opacity);
            }
            surface.blend_layer(
                &layer,
                mode,
                crate::blend::dissolve_seed(id, mode, scene_frame),
            );
            continue;
        }
        if let Some(object_paths) = by_object.get(id) {
            VelloCpuRasteriser.rasterise_into(object_paths, &mut surface);
        }
    }
    Ok(surface)
}

/// An object's layer-space pixels with its effects run, and how it is warped
/// onto the canvas this frame (3.22; 3.19 for clips and masks).
struct LayerPixels<'a> {
    document: &'a SceneDocument,
    effective: &'a [ResolvedObject],
    effect_layers: &'a [Option<EffectLayer>],
}

type Warped = (
    Vec<crate::colour_pipeline::WorkingRgba>,
    usize,
    usize,
    [f32; 12],
    crate::compositor::LayerState,
);

impl LayerPixels<'_> {
    /// `None` when the object is not drawn in its own layer space.
    fn warped(&self, index: usize) -> Result<Option<Warped>, Refusal> {
        let Some(layer) = self.effect_layers.get(index).and_then(Option::as_ref) else {
            return Ok(None);
        };
        let object = &self.document.objects[index];
        let source = &layer.source;
        // Prepared without a GPU, so always drawn on the CPU.
        let layer_surface = source
            .surface
            .as_ref()
            .expect("a CPU reference layer source is drawn on the CPU");
        let (w, h) = (source.width as usize, source.height as usize);
        let ctx = crate::effect_chain::EffectContext {
            origin: source.origin,
            size: [object.base().width, object.base().height],
            space: self.document.working_color_space,
            depth: self.document.color_depth,
        };
        let effects = object.base().effects();
        let mut plan = crate::effect_chain::EffectPlan::layout(effects, &layer.iterations);
        plan.pack(effects, &ctx);
        let weights: Vec<Option<Vec<f32>>> = source
            .effect_weights
            .iter()
            .map(|w| match w {
                Some(crate::layer_source::EffectWeights::Cpu(values)) => Some(values.clone()),
                _ => None,
            })
            .collect();
        let pixels = plan.run_with_weights(layer_surface.pixels(), w, h, &ctx, &weights);
        let state = crate::compositor::scene::layer_state(
            object.base().anchor,
            &self.effective[index],
            source.origin,
        );
        let rows = self.rows(index, state)?;
        Ok(Some((pixels, w, h, rows, state)))
    }

    fn rows(
        &self,
        index: usize,
        state: crate::compositor::LayerState,
    ) -> Result<[f32; 12], Refusal> {
        let canvas = &self.document.canvas;
        crate::compositor::layer_rows(canvas.width, canvas.height, state).map_err(|e| {
            crate::compositor::scene::mapping_refusal(
                &self.document.objects[index].base().id,
                &format!("objects[{index}]"),
                &e.to_string(),
            )
        })
    }
}

/// A clip child's or track matte source's matte (3.19): its pixels warped onto
/// the canvas at its own opacity, visible or not, times its own clip's matte
/// alpha, as the GPU composites it into its matte target.
fn matte(
    layers: &LayerPixels<'_>,
    clips: &crate::clip::ClipPlan,
    clip: usize,
    mattes: &mut HashMap<usize, Vec<crate::colour_pipeline::WorkingRgba>>,
) -> Result<(), Refusal> {
    // Outermost first: each matte multiplies the one around it.
    let mut chain = vec![clip];
    while let Some(outer) = clips.clip_of[*chain.last().expect("non-empty")] {
        if mattes.contains_key(&outer) || chain.len() > clips.clip_of.len() {
            break;
        }
        chain.push(outer);
    }
    for &index in chain.iter().rev() {
        if mattes.contains_key(&index) {
            continue;
        }
        let canvas = &layers.document.canvas;
        let mut surface = RasterSurface::transparent(canvas.width, canvas.height)
            .with_depth(layers.document.color_depth);
        let (pixels, w, h, _, _) = layers
            .warped(index)?
            .expect("a matte is drawn in its own layer space");
        let object = &layers.document.objects[index];
        let state = crate::compositor::scene::matte_state(
            object.base().anchor,
            &layers.effective[index],
            layers.effect_layers[index]
                .as_ref()
                .expect("a matte has a layer")
                .source
                .origin,
            object.base().opacity,
        );
        let rows = layers.rows(index, state)?;
        surface.warp_blend(&pixels, w, h, &rows, state.opacity, BlendMode::Normal, 0);
        if let Some(outer) = clips.clip_of[index] {
            for (p, o) in surface.pixels_mut().iter_mut().zip(&mattes[&outer]) {
                *p = p.scaled(o.a);
            }
        }
        mattes.insert(index, surface.pixels().to_vec());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::animation::{KeyframeChannel, SceneEasing, SceneKeyframe};
    use gx_contracts::color::ColorValue;
    use gx_contracts::control::{ControlField, ControlFieldKind};
    use gx_contracts::font::{
        EmbeddingPolicy, FontDefinition, FontFaceDefinition, FontFormat, FontLoadStatus,
        FontSource, FontStyle,
    };
    use gx_contracts::material::{BlendMode, MaterialDefinition, MaterialKind};
    use gx_contracts::scene::{
        AssetAvailability, AssetKind, AssetLibraryItem, GroupObject, ImageObject, ObjectBase,
        RectObject, SceneCanvas, SceneDocument, SceneTimeline, TextObject,
    };
    use gx_contracts::text_style::{StyleNumber, TextStyle};
    use gx_contracts::{RationalRate, Revision};

    fn document(objects: Vec<SceneObject>) -> SceneDocument {
        SceneDocument {
            working_color_space: gx_contracts::color::WorkingColorSpace::LinearSrgb,
            color_depth: gx_contracts::color::ColorDepth::BEFORE_DEPTH,
            id: "scene_1".into(),
            name: "Lower Third".into(),
            version: gx_contracts::scene::SCENE_SCHEMA_VERSION,
            revision: Some(Revision(1)),
            active_camera_id: None,
            canvas: SceneCanvas {
                width: 1920,
                height: 1080,
                frame_rate: RationalRate::P50,
            },
            timeline: SceneTimeline {
                duration_frames: 100,
                ..Default::default()
            },
            data_context: serde_json::Map::new(),
            assets: Vec::new(),
            fonts: Vec::new(),
            materials: Vec::new(),
            controls: Vec::new(),
            text_styles: Vec::new(),
            path_links: Vec::new(),
            guides: Vec::new(),
            scene_label: None,
            objects,
        }
    }

    fn rect(id: &str) -> SceneObject {
        SceneObject::Rect(RectObject {
            base: ObjectBase::new(id, id),
            radius: 0.0,
        })
    }

    fn logo_asset(hash: &str) -> AssetLibraryItem {
        AssetLibraryItem {
            asset_id: "asset_logo".into(),
            name: "Logo".into(),
            kind: AssetKind::Image,
            path: "images/logo.png".into(),
            checksum: Some(ContentHash(hash.into())),
            mime_type: Some("image/png".into()),
            size_bytes: Some(64),
            status: Some(AssetAvailability::Ready),
            provenance: Default::default(),
            color_space: None,
        }
    }

    fn inter() -> FontDefinition {
        FontDefinition {
            font_id: "font_inter".into(),
            family: "Inter".into(),
            display_name: "Inter".into(),
            faces: vec![FontFaceDefinition {
                face_id: "inter_400".into(),
                family: "Inter".into(),
                weight: 400,
                style: FontStyle::Normal,
                stretch: None,
                unicode_range: None,
                source: FontSource::File {
                    asset_id: "asset_inter".into(),
                    format: FontFormat::Ttf,
                    original_url: None,
                    stylesheet_url: None,
                },
                status: Some(FontLoadStatus::Ready),
                error_message: None,
            }],
            fallback_families: Vec::new(),
            embedding_policy: EmbeddingPolicy::Package,
            license: Some("SIL OFL 1.1".into()),
            enabled: true,
            source_label: None,
            status: FontLoadStatus::Ready,
            error_message: None,
        }
    }

    /// 3.15's done-when, rendered through the engine: a white rectangle
    /// under the same rectangle filled with 50%-alpha black. (The 50% is in
    /// the fill, not `opacity`: vector paths ignore object opacity today, a
    /// reopened-3.13 defect recorded 13 October 2026.) Every fully covered
    /// pixel gives the scene's working-space reference value to ±1 code
    /// value: sRGB Preview 128 / Program 115, linear Preview 188 / Program
    /// 180 (computed independently from the IEC 61966-2-1 and BT.709
    /// formulas; memory.md, 13 October 2026).
    #[test]
    fn a_rendered_half_black_overlap_follows_the_scenes_working_space() {
        use gx_contracts::color::{Rgba, WorkingColorSpace};
        let filled = |id: &str, color: Rgba| {
            let mut base = ObjectBase::new(id, id);
            base.width = 400.0;
            base.height = 200.0;
            base.fill = Some(ColorValue::Solid { color });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        for (space, preview, program) in [
            (WorkingColorSpace::Srgb, 128_u8, 115_u8),
            (WorkingColorSpace::LinearSrgb, 188, 180),
        ] {
            let mut scene = document(vec![
                filled("white", Rgba::srgb(1.0, 1.0, 1.0, 1.0)),
                filled("black", Rgba::srgb(0.0, 0.0, 0.0, 0.5)),
            ]);
            scene.working_color_space = space;
            let prepared = PreparedScene::prepare(
                scene,
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .expect("two rectangles prepare");
            for (output, expected) in [
                (OutputTransform::Srgb, preview),
                (OutputTransform::Rec709, program),
            ] {
                let frame = prepared.frame(output);
                let covered: Vec<&[u8]> = frame
                    .pixels
                    .chunks(4)
                    .filter(|pixel| pixel[3] == 255)
                    .collect();
                assert!(
                    covered.len() >= 10_000,
                    "{space:?}: only {} covered pixels",
                    covered.len()
                );
                assert!(
                    covered
                        .iter()
                        .all(|pixel| pixel[..3].iter().all(|c| c.abs_diff(expected) <= 1)),
                    "{space:?} {output:?}: expected {expected}, first covered pixel {:?}",
                    covered[0]
                );
            }
        }
    }

    /// 3.13: vector paths apply the object's effective opacity, its own and
    /// its ancestors'. Black at 50% over white gives the 50%-alpha reference
    /// values: Preview 128 in an sRGB scene, 188 in a linear one.
    #[test]
    fn vector_paths_apply_effective_opacity() {
        use gx_contracts::color::{Rgba, WorkingColorSpace};
        let rect_with = |id: &str, color: Rgba, opacity: f64| {
            let mut base = ObjectBase::new(id, id);
            base.width = 400.0;
            base.height = 200.0;
            base.opacity = opacity;
            base.fill = Some(ColorValue::Solid { color });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        let white = || rect_with("white", Rgba::srgb(1.0, 1.0, 1.0, 1.0), 1.0);
        let mut group = GroupObject {
            base: ObjectBase::new("g", "g"),
            child_ids: vec!["child".into()],
            clip_child_id: None,
        };
        group.base.opacity = 0.5;
        for (space, expected) in [
            (WorkingColorSpace::Srgb, 128_u8),
            (WorkingColorSpace::LinearSrgb, 188),
        ] {
            for (case, objects) in [
                (
                    "own opacity",
                    vec![
                        white(),
                        rect_with("black", Rgba::srgb(0.0, 0.0, 0.0, 1.0), 0.5),
                    ],
                ),
                (
                    "parent opacity",
                    vec![
                        white(),
                        SceneObject::Group(group.clone()),
                        rect_with("child", Rgba::srgb(0.0, 0.0, 0.0, 1.0), 1.0),
                    ],
                ),
            ] {
                let mut scene = document(objects);
                scene.working_color_space = space;
                let prepared = PreparedScene::prepare(
                    scene,
                    &HashSet::new(),
                    &AssetBytes::new(),
                    &MaterialSupport::fixed_function(),
                )
                .expect("the rectangles prepare");
                let frame = prepared.frame(OutputTransform::Srgb);
                let covered: Vec<&[u8]> = frame
                    .pixels
                    .chunks(4)
                    .filter(|pixel| pixel[3] == 255)
                    .collect();
                assert!(
                    covered.len() >= 10_000,
                    "{space:?} {case}: {} covered pixels",
                    covered.len()
                );
                assert!(
                    covered
                        .iter()
                        .all(|pixel| pixel[..3].iter().all(|c| c.abs_diff(expected) <= 1)),
                    "{space:?} {case}: expected {expected}, first covered pixel {:?}",
                    covered[0]
                );
            }
        }
    }

    /// 3.13: After Effects' Trim Paths on a shape's stroke, counted in lit
    /// pixels of a 10 px white stroke over transparency.
    #[test]
    fn trim_paths_cut_the_stroke_to_the_authored_window() {
        use gx_contracts::color::Rgba;
        use gx_contracts::scene::{BezierPath, FillRule, ShapeObject, Vec2};
        let v = |x: f64, y: f64| Vec2 { x, y };
        let shape =
            |vertices: Vec<Vec2>, closed: bool, scale_x: f64, trim: Option<(f64, f64, f64)>| {
                let mut base = ObjectBase::new("shape", "shape");
                base.x = 100.0;
                base.y = 100.0;
                base.scale_x = scale_x;
                base.stroke = Some(ColorValue::Solid {
                    color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
                });
                base.stroke_width = 10.0;
                let count = vertices.len();
                SceneObject::Shape(ShapeObject {
                    base,
                    path: BezierPath {
                        closed,
                        vertices,
                        in_tangents: vec![v(0.0, 0.0); count],
                        out_tangents: vec![v(0.0, 0.0); count],
                        vertex_ids: None,
                        vertex_kinds: None,
                        auto_tension: None,
                    },
                    compound_paths: None,
                    fill_enabled: false,
                    stroke_enabled: true,
                    fill_rule: FillRule::Nonzero,
                    trim_start: trim.map(|t| t.0),
                    trim_end: trim.map(|t| t.1),
                    trim_offset: trim.map(|t| t.2),
                    contour_ids: None,
                })
            };
        let lit = |object: SceneObject| -> usize {
            let prepared = PreparedScene::prepare(
                document(vec![object]),
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .expect("the shape prepares");
            prepared
                .frame(OutputTransform::Srgb)
                .pixels
                .chunks(4)
                .filter(|pixel| pixel[3] >= 128)
                .count()
        };
        let line = || vec![v(0.0, 0.0), v(360.0, 0.0)];
        let whole = lit(shape(line(), false, 1.0, None));
        assert!(
            (3500..=3700).contains(&whole),
            "the whole stroke lit {whole}"
        );
        let half = lit(shape(line(), false, 1.0, Some((0.0, 50.0, 0.0))));
        assert!((1700..=1900).contains(&half), "0-50 lit {half}");
        let middle = lit(shape(line(), false, 1.0, Some((25.0, 75.0, 0.0))));
        assert!((1700..=1900).contains(&middle), "25-75 lit {middle}");
        let swapped = lit(shape(line(), false, 1.0, Some((75.0, 25.0, 0.0))));
        assert_eq!(
            middle, swapped,
            "a start after the end draws the same window"
        );
        assert_eq!(
            lit(shape(line(), false, 1.0, Some((40.0, 40.0, 0.0)))),
            0,
            "an empty window draws nothing"
        );

        // Turned past the end, the window wraps to the beginning.
        let square = || vec![v(0.0, 0.0), v(200.0, 0.0), v(200.0, 200.0), v(0.0, 200.0)];
        let full_square = lit(shape(square(), true, 1.0, None));
        let wrapped = lit(shape(square(), true, 1.0, Some((0.0, 50.0, 75.0))));
        let ratio = wrapped as f64 / full_square as f64;
        assert!(
            (ratio - 0.5).abs() < 0.05,
            "a wrapped half lit {wrapped} of {full_square}"
        );

        // Measured in the shape's own coordinates: an L whose legs are equal
        // locally, scaled 3x horizontally. Half its local length is exactly
        // the horizontal leg, 300 px in the scene; measuring in scene space
        // would stop at 200 px.
        let ell = || vec![v(0.0, 0.0), v(100.0, 0.0), v(100.0, 100.0)];
        let scaled = PreparedScene::prepare(
            document(vec![shape(ell(), false, 3.0, Some((0.0, 50.0, 0.0)))]),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        );
        assert!(
            matches!(scaled, Err(Refusal::ScenePropertyNotDrawable { property, .. })
            if property == "scaled strokeWidth"),
            "a scaled stroke must not keep its unscaled width"
        );
    }

    /// 3.13: a binding applies on air. A rect bound to `pos.x` = 900 draws
    /// at 900, not at its authored 0.
    #[test]
    fn a_bound_property_draws_its_data_value() {
        use gx_contracts::color::Rgba;
        let mut base = ObjectBase::new("bar", "bar");
        base.width = 50.0;
        base.height = 50.0;
        base.fill = Some(ColorValue::Solid {
            color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
        });
        base.bindings = Some(serde_json::Map::from_iter([(
            "x".to_string(),
            serde_json::json!("pos.x"),
        )]));
        let mut scene = document(vec![SceneObject::Rect(RectObject { base, radius: 0.0 })]);
        scene.data_context =
            serde_json::from_value(serde_json::json!({ "pos": { "x": 900 } })).unwrap();
        let prepared = PreparedScene::prepare(
            scene,
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("the bound scene prepares");
        let frame = prepared.frame(OutputTransform::Srgb);
        let lit_at = |x: usize, y: usize| frame.pixels[(y * frame.width as usize + x) * 4 + 3] > 0;
        assert!(lit_at(920, 20), "the rect draws at its bound x");
        assert!(!lit_at(20, 20), "and not at its authored x");
        assert_eq!(
            prepared.document().objects[0].base().x,
            0.0,
            "the authored document is kept"
        );
    }

    /// 11.153: Hide when empty on air. A text bound to a name draws it; the same text with the name blank, null or missing is not drawn,
    /// and without Hide when empty a blank name draws nothing too but a missing one refuses the scene as it always did.
    #[test]
    fn hide_when_empty_leaves_an_empty_bound_text_undrawn() {
        use gx_contracts::color::Rgba;
        const INTER: &[u8] = include_bytes!("../tests/fixtures/Inter-Regular.ttf");
        let hash = ContentHash("inter".into());
        let mut scene = document(Vec::new());
        scene.assets.push(AssetLibraryItem {
            asset_id: "inter".into(),
            name: "Inter".into(),
            kind: AssetKind::Font,
            path: "fonts/inter.ttf".into(),
            checksum: Some(hash.clone()),
            mime_type: Some("font/ttf".into()),
            size_bytes: Some(INTER.len() as u64),
            status: Some(AssetAvailability::Ready),
            provenance: Default::default(),
            color_space: None,
        });
        let mut font = inter();
        if let FontSource::File { asset_id, .. } = &mut font.faces[0].source {
            *asset_id = "inter".into();
        }
        scene.fonts.push(font);
        let caption = |hide: Option<bool>| {
            let mut base = ObjectBase::new("caption", "caption");
            base.x = 100.0;
            base.y = 100.0;
            base.width = 600.0;
            base.height = 300.0;
            base.fill = Some(ColorValue::Solid {
                color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
            });
            base.hide_when_empty = hide;
            base.bindings = Some(serde_json::Map::from_iter([(
                "text".to_string(),
                serde_json::json!("p.name"),
            )]));
            SceneObject::Text(TextObject {
                base,
                text: "Authored".into(),
                font_id: "font_inter".into(),
                size: 200.0,
                layout: Default::default(),
                auto_fit: Default::default(),
                writing_mode: Default::default(),
                vertical_align: Default::default(),
                direction: Default::default(),
                text_case: Default::default(),
                decoration: Default::default(),
                overflow: Default::default(),
                max_lines: None,
                kerning: None,
                align: Default::default(),
                line_height: None,
                letter_spacing: 0.0,
                word_spacing: 0.0,
                paragraph_spacing: 0.0,
                text_indent: 0.0,
                baseline_shift: None,
                text_animator: None,
            })
        };
        let white_pixels = |hide: Option<bool>, data: serde_json::Value| {
            let mut composed = scene.clone();
            composed.objects = vec![caption(hide)];
            composed.data_context = serde_json::from_value(data).unwrap();
            PreparedScene::prepare(
                composed,
                &HashSet::from([hash.clone()]),
                &AssetBytes::from([(hash.clone(), INTER.to_vec())]),
                &MaterialSupport::fixed_function(),
            )
            .map(|prepared| {
                prepared
                    .frame(OutputTransform::Srgb)
                    .pixels
                    .chunks(4)
                    .filter(|pixel| pixel[0] > 200 && pixel[1] > 200 && pixel[2] > 200)
                    .count()
            })
        };
        let hiding = Some(true);
        assert!(
            white_pixels(hiding, serde_json::json!({ "p": { "name": "I" } })).unwrap() > 1000,
            "a value draws the text"
        );
        for empty in [
            serde_json::json!({ "p": { "name": "" } }),
            serde_json::json!({ "p": { "name": "   " } }),
            serde_json::json!({ "p": { "name": null } }),
            serde_json::json!({ "p": {} }),
        ] {
            assert_eq!(
                white_pixels(hiding, empty.clone()).expect("an empty value prepares"),
                0,
                "{empty} leaves the element undrawn"
            );
        }
        // Without it, a missing value is still refused by name: Hide when empty is the only way an empty value is allowed.
        assert!(matches!(
            white_pixels(None, serde_json::json!({ "p": {} })),
            Err(Refusal::BindingPathInvalid { .. })
        ));
    }

    /// 3.13: objects compose in draw order across kinds. A rect after a text
    /// covers it; the same rect with a lower `z_index` goes beneath it.
    #[test]
    fn objects_compose_in_draw_order_across_kinds() {
        use gx_contracts::color::Rgba;
        const INTER: &[u8] = include_bytes!("../tests/fixtures/Inter-Regular.ttf");
        let hash = ContentHash("inter".into());
        let mut scene = document(Vec::new());
        scene.assets.push(AssetLibraryItem {
            asset_id: "inter".into(),
            name: "Inter".into(),
            kind: AssetKind::Font,
            path: "fonts/inter.ttf".into(),
            checksum: Some(hash.clone()),
            mime_type: Some("font/ttf".into()),
            size_bytes: Some(INTER.len() as u64),
            status: Some(AssetAvailability::Ready),
            provenance: Default::default(),
            color_space: None,
        });
        let mut font = inter();
        if let FontSource::File { asset_id, .. } = &mut font.faces[0].source {
            *asset_id = "inter".into();
        }
        scene.fonts.push(font);
        let mut text = ObjectBase::new("caption", "caption");
        text.x = 100.0;
        text.y = 100.0;
        text.width = 600.0;
        text.height = 300.0;
        text.fill = Some(ColorValue::Solid {
            color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
        });
        let caption = SceneObject::Text(TextObject {
            base: text,
            text: "I".into(),
            font_id: "font_inter".into(),
            size: 200.0,
            layout: Default::default(),
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: Default::default(),
            text_case: Default::default(),
            decoration: Default::default(),
            overflow: Default::default(),
            max_lines: None,
            kerning: None,
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
            baseline_shift: None,
            text_animator: None,
        });
        let cover = |z_index: i32| {
            let mut base = ObjectBase::new("cover", "cover");
            base.x = 0.0;
            base.y = 0.0;
            base.width = 1000.0;
            base.height = 600.0;
            base.z_index = z_index;
            base.fill = Some(ColorValue::Solid {
                color: Rgba::srgb(1.0, 0.0, 0.0, 1.0),
            });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        let white_pixels = |objects: Vec<SceneObject>| {
            let mut composed = scene.clone();
            composed.objects = objects;
            let prepared = PreparedScene::prepare(
                composed,
                &HashSet::from([hash.clone()]),
                &AssetBytes::from([(hash.clone(), INTER.to_vec())]),
                &MaterialSupport::fixed_function(),
            )
            .expect("the scene prepares");
            prepared
                .frame(OutputTransform::Srgb)
                .pixels
                .chunks(4)
                .filter(|pixel| pixel[0] > 200 && pixel[1] > 200 && pixel[2] > 200)
                .count()
        };
        assert!(
            white_pixels(vec![caption.clone()]) > 1000,
            "the caption draws on its own"
        );
        assert_eq!(
            white_pixels(vec![caption.clone(), cover(0)]),
            0,
            "a rect after the text covers it"
        );
        assert!(
            white_pixels(vec![caption, cover(-1)]) > 1000,
            "a lower z-index draws beneath"
        );
    }

    /// 3.13: a shape is the union of its triangles. A semi-transparent stroke
    /// with a sharp corner composites every pixel once, so every lit pixel has
    /// the same alpha; overlapping join triangles must not darken it.
    #[test]
    fn a_semi_transparent_stroke_composites_each_pixel_once() {
        use gx_contracts::color::Rgba;
        use gx_contracts::scene::{BezierPath, FillRule, ShapeObject, Vec2};
        let v = |x: f64, y: f64| Vec2 { x, y };
        let mut base = ObjectBase::new("zigzag", "zigzag");
        base.x = 100.0;
        base.y = 100.0;
        base.stroke = Some(ColorValue::Solid {
            color: Rgba::srgb(1.0, 1.0, 1.0, 0.5),
        });
        base.stroke_width = 24.0;
        let zigzag = SceneObject::Shape(ShapeObject {
            base,
            path: BezierPath {
                closed: false,
                vertices: vec![v(0.0, 0.0), v(300.0, 0.0), v(0.0, 60.0), v(300.0, 120.0)],
                in_tangents: vec![v(0.0, 0.0); 4],
                out_tangents: vec![v(0.0, 0.0); 4],
                vertex_ids: None,
                vertex_kinds: None,
                auto_tension: None,
            },
            compound_paths: None,
            fill_enabled: false,
            stroke_enabled: true,
            fill_rule: FillRule::Nonzero,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
            contour_ids: None,
        });
        let prepared = PreparedScene::prepare(
            document(vec![zigzag]),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("the stroke prepares");
        let alphas: Vec<u8> = prepared
            .frame(OutputTransform::Srgb)
            .pixels
            .chunks(4)
            .map(|pixel| pixel[3])
            .filter(|alpha| *alpha > 0)
            .collect();
        // 3.17: edges are anti-aliased, so they carry partial alphas. Where
        // the zigzag overlaps itself at its joins it must still composite
        // once: no pixel exceeds the paint's own alpha, and the stroke's
        // interior carries exactly that alpha.
        let once = 128;
        assert!(
            alphas.iter().all(|alpha| *alpha <= once),
            "a pixel composited the stroke twice: max alpha {:?}",
            alphas.iter().max()
        );
        let interior = alphas.iter().filter(|alpha| **alpha == once).count();
        assert!(
            interior * 2 > alphas.len(),
            "most lit pixels are interior: {interior} of {}",
            alphas.len()
        );
    }

    #[test]
    fn a_scene_resolves_its_hierarchy_once_at_publish() {
        // Invariant 35: this is the work 1.x did per frame.
        let mut parent = GroupObject {
            base: ObjectBase::new("g", "g"),
            child_ids: vec!["r".into()],
            clip_child_id: None,
        };
        parent.base.x = 100.0;
        let objects = vec![SceneObject::Group(parent), rect("r")];

        let prepared = PreparedScene::prepare(
            document(objects),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("a scene with no assets prepares");

        assert_eq!(prepared.effective().len(), 2);
        assert_eq!(
            prepared.effective_object("r").expect("the rect resolves").x,
            100.0,
            "the child must carry its parent's transform, resolved at publish"
        );
        assert_eq!(
            prepared.renderable().count(),
            1,
            "a container draws nothing"
        );
    }

    #[test]
    fn a_declared_asset_the_engine_does_not_hold_blocks_the_scene() {
        // Invariant 29: a missing asset is a take blocker, not a hole in the
        // picture. It must refuse at publish, while somebody is watching.
        let scene = SceneDocument {
            assets: vec![logo_asset("deadbeef")],
            ..document(vec![rect("bg")])
        };
        match PreparedScene::prepare(
            scene.clone(),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        ) {
            Err(Refusal::AssetMissing { hash }) => assert_eq!(hash.0, "deadbeef"),
            other => panic!("a missing asset must refuse by name, got {other:?}"),
        }

        let available = HashSet::from([ContentHash("deadbeef".into())]);
        assert!(
            PreparedScene::prepare(
                scene,
                &available,
                &AssetBytes::new(),
                &MaterialSupport::fixed_function()
            )
            .is_ok(),
            "the same scene prepares once the bytes are held"
        );
    }

    #[test]
    fn an_object_referencing_a_font_the_scene_does_not_carry_refuses() {
        // The scene is self-describing (1.1): a font id that does not resolve
        // in the document will never resolve later, so it refuses now rather
        // than substituting a system face (3.6's rule, enforced at prepare).
        let text = SceneObject::Text(TextObject {
            base: ObjectBase::new("title", "title"),
            text: "Hello".into(),
            font_id: "font_absent".into(),
            size: 72.0,
            ..text_defaults()
        });
        match PreparedScene::prepare(
            document(vec![text]),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        ) {
            Err(Refusal::SceneFontUnknown { font_id, object }) => {
                assert_eq!(font_id, "font_absent");
                assert_eq!(object, "title");
            }
            other => panic!("an unresolvable font must refuse by name, got {other:?}"),
        }
    }

    #[test]
    fn the_editor_validator_and_the_engine_refuse_the_same_scene_for_the_same_reason() {
        // 7.4's done-when: "shares one enum with the engine". This is that
        // claim as a test. The Editor cannot call into this crate (invariant
        // 3), so the rules live in `gx_contracts::validate` and both sides run
        // them — and if anyone ever reintroduces a private copy here, the two
        // answers drift and this fails.
        let text = SceneObject::Text(TextObject {
            base: ObjectBase::new("title", "title"),
            text: "Hello".into(),
            font_id: "font_absent".into(),
            size: 72.0,
            ..text_defaults()
        });
        let scene = document(vec![text]);
        let support = MaterialSupport::fixed_function();

        let engine =
            PreparedScene::prepare(scene.clone(), &HashSet::new(), &AssetBytes::new(), &support)
                .expect_err("the engine refuses an unresolvable font");

        let editor = gx_contracts::validate::validate_scene_document(
            &scene,
            &support,
            &HashSet::new(),
            true,
        );

        assert_eq!(
            editor.first().map(|refusal| &refusal.code),
            Some(&engine),
            "the Editor must refuse exactly what the engine refuses"
        );
    }

    /// 3.13: the drawability checks live in contracts, so a scene the engine
    /// cannot draw is refused by the Editor's validator first, with the same
    /// refusal. One case per family the engine used to refuse alone, plus a
    /// light with nothing to light and a painted container.
    #[test]
    fn the_validator_and_the_engine_refuse_undrawable_scenes_identically() {
        let not_drawable =
            |object: &str, property: &str, owner: &str| Refusal::ScenePropertyNotDrawable {
                object: object.into(),
                property: property.into(),
                owner: owner.into(),
            };
        let solid = || {
            Some(ColorValue::Solid {
                color: gx_contracts::color::Rgba::srgb(1.0, 1.0, 1.0, 1.0),
            })
        };

        let mut gradient = rect("gradient");
        // 3.17: an angle beside explicit end points cannot be drawn as
        // authored.
        gradient.base_mut().width = 10.0;
        gradient.base_mut().height = 10.0;
        gradient.base_mut().fill = Some(ColorValue::LinearGradient {
            angle: 30.0,
            start_x: 0.0,
            start_y: 0.0,
            end_x: 1.0,
            end_y: 0.0,
            stops: Vec::new(),
            spread: Default::default(),
            coordinate_mode: Default::default(),
        });

        let mut parent = GroupObject {
            base: ObjectBase::new("parent", "parent"),
            child_ids: vec!["sheared".into()],
            clip_child_id: None,
        };
        parent.base.scale_x = 2.0;
        let mut sheared = rect("sheared");
        sheared.base_mut().rotation = 30.0;

        let mut indented = TextObject {
            base: ObjectBase::new("title", "title"),
            text: "Hello".into(),
            font_id: "font_inter".into(),
            size: 40.0,
            ..text_defaults()
        };
        indented.text_indent = -12.0;
        let mut text_scene = document(vec![SceneObject::Text(indented)]);
        text_scene.fonts.push(inter());

        let mut faded = rect("faded");
        faded.base_mut().opacity = 1.5;

        let mut stroked = rect("stroked");
        stroked.base_mut().stroke = solid();
        stroked.base_mut().stroke_width = 4.0;
        stroked.base_mut().scale_x = 2.0;

        let light: SceneObject = serde_json::from_value(serde_json::json!({
            "type": "light", "id": "key", "name": "key", "lightKind": "directional", "intensity": 1.0,
            "color": { "r": 1, "g": 1, "b": 1, "a": 1, "space": "srgb" }, "castShadow": false
        }))
        .expect("a minimal light parses");

        let mut painted_group = GroupObject {
            base: ObjectBase::new("painted", "painted"),
            child_ids: Vec::new(),
            clip_child_id: None,
        };
        painted_group.base.fill = solid();
        let painted_group = SceneObject::Group(painted_group);

        let cases = [
            (
                document(vec![gradient]),
                Refusal::GradientNotDrawable {
                    object: "gradient".into(),
                    paint: "fill".into(),
                    detail:
                        "angle 30 is not drawn beside explicit start and end points; set the points"
                            .into(),
                },
            ),
            (
                document(vec![SceneObject::Group(parent), sheared]),
                not_drawable(
                    "sheared",
                    "rotation under a non-uniformly scaled parent",
                    "3.16",
                ),
            ),
            (text_scene, not_drawable("title", "textIndent", "11.51")),
            (
                document(vec![faded]),
                not_drawable("faded", "opacity", "3.13"),
            ),
            (
                document(vec![stroked]),
                not_drawable("stroked", "scaled strokeWidth", "3.17"),
            ),
            (
                document(vec![rect("lit"), light]),
                Refusal::LightHasNoResponsiveMaterial {
                    light_id: "key".into(),
                },
            ),
            (
                document(vec![painted_group]),
                not_drawable("painted", "fill", "3.13"),
            ),
        ];
        let support = MaterialSupport::fixed_function();
        for (scene, expected) in cases {
            let editor = gx_contracts::validate::validate_scene_document(
                &scene,
                &support,
                &HashSet::new(),
                true,
            );
            let engine =
                PreparedScene::prepare(scene, &HashSet::new(), &AssetBytes::new(), &support)
                    .expect_err("the engine refuses what it cannot draw");
            assert_eq!(
                editor.first().map(|refusal| &refusal.code),
                Some(&expected),
                "validator"
            );
            assert_eq!(engine, expected, "engine");
        }
    }

    #[test]
    fn an_image_referencing_an_asset_id_the_library_lacks_refuses() {
        let image = SceneObject::Image(ImageObject {
            base: ObjectBase::new("logo", "logo"),
            asset_id: "asset_absent".into(),
            fit: Default::default(),
            slice: None,
        });
        match PreparedScene::prepare(
            document(vec![image]),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        ) {
            Err(Refusal::SceneAssetUnknown { asset_id, object }) => {
                assert_eq!(asset_id, "asset_absent");
                assert_eq!(object, "logo");
            }
            other => panic!("an unresolvable asset id must refuse by name, got {other:?}"),
        }
    }

    #[test]
    fn a_material_the_engine_cannot_draw_refuses_at_publish() {
        // 1.3's validator, called where it matters: the engine declares what
        // it can reproduce and the scene is held against that declaration.
        let scene = SceneDocument {
            materials: vec![MaterialDefinition {
                material_id: "material_1".into(),
                name: "Overlay".into(),
                kind: MaterialKind::Unlit,
                color: ColorValue::opaque_white(),
                opacity: 1.0,
                blend_mode: BlendMode::Overlay,
                alpha_mode: Default::default(),
                cull_mode: Default::default(),
                depth_mode: Default::default(),
                double_sided: false,
                textures: Vec::new(),
                shader_id: None,
            }],
            ..document(vec![rect("bg")])
        };
        assert!(
            matches!(
                PreparedScene::prepare(
                    scene.clone(),
                    &HashSet::new(),
                    &AssetBytes::new(),
                    &MaterialSupport::fixed_function()
                ),
                Err(Refusal::UnsupportedBlendMode {
                    mode: BlendMode::Overlay
                })
            ),
            "a fixed-function peer must refuse overlay rather than drawing screen"
        );
        assert!(
            PreparedScene::prepare(
                scene,
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport {
                    blend_modes: vec![BlendMode::Overlay],
                    ..MaterialSupport::fixed_function()
                }
            )
            .is_ok(),
            "a peer that declares overlay may draw it"
        );
    }

    #[test]
    fn a_repaired_hierarchy_refuses_at_publish_by_name() {
        // 3.13: the resolver still repairs the edge deterministically so an
        // author can keep editing, but publishing it would put a parent
        // choice nobody made on air, so the edge refuses by name.
        let group = SceneObject::Group(GroupObject {
            base: ObjectBase::new("g", "g"),
            child_ids: vec!["ghost".into()],
            clip_child_id: None,
        });
        let refused = PreparedScene::prepare(
            document(vec![group, rect("r")]),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        );
        assert!(
            matches!(&refused, Err(Refusal::SceneHierarchyInvalid { parent, child, problem }) if parent == "g" && child == "ghost" && problem == "missingChild"),
            "{:?}",
            refused.err()
        );
    }

    #[test]
    fn an_operator_contract_the_engine_cannot_address_refuses_at_publish() {
        // The control contract, the style library and the phase list are all
        // authoring surfaces the Editor maintains incrementally. A document
        // that reaches the engine by any other route is held against the same
        // rules here, before a single pixel is produced.
        let ambiguous = ControlField {
            field_id: "headline".into(),
            label: "Headline".into(),
            object_id: "bg".into(),
            property: "opacity".into(),
            kind: ControlFieldKind::Number,
            default: None,
        };
        let scene = SceneDocument {
            controls: vec![ambiguous.clone(), ambiguous],
            ..document(vec![rect("bg")])
        };
        assert!(matches!(
            PreparedScene::prepare(
                scene,
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function()
            ),
            Err(Refusal::ControlFieldDuplicate { field_id }) if field_id == "headline"
        ));

        let styled = SceneDocument {
            text_styles: vec![TextStyle {
                style_id: "headline".into(),
                name: "Headline".into(),
                font_id: "font_absent".into(),
                size: StyleNumber::Literal(32.0),
                line_height: None,
                letter_spacing: None,
                text_case: Default::default(),
                fill: None,
                stroke: None,
                stroke_width: None,
            }],
            ..document(vec![rect("bg")])
        };
        assert!(matches!(
            PreparedScene::prepare(
                styled,
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function()
            ),
            Err(Refusal::TextStyleFontUnknown { style_id, font_id })
                if style_id == "headline" && font_id == "font_absent"
        ));

        let overlapping = SceneDocument {
            timeline: SceneTimeline {
                duration_frames: 100,
                phases: vec![
                    TimelinePhase {
                        kind: PhaseKind::In,
                        name: None,
                        start_frame: 0,
                        end_frame: 30,
                    },
                    TimelinePhase {
                        kind: PhaseKind::Hold,
                        name: None,
                        start_frame: 20,
                        end_frame: 40,
                    },
                ],
                ..Default::default()
            },
            ..document(vec![rect("bg")])
        };
        assert!(matches!(
            PreparedScene::prepare(
                overlapping,
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function()
            ),
            Err(Refusal::TimelinePhaseOverlap { .. })
        ));
    }

    #[test]
    fn invalid_opacity_animation_refuses_at_prepare_and_valid_keys_render_in_both_spaces() {
        use gx_contracts::animation::CubicBezier;
        use gx_contracts::color::{Rgba, WorkingColorSpace};
        let rectangle = |id: &str, shade| {
            let mut base = ObjectBase::new(id, id);
            base.width = 12.0;
            base.height = 12.0;
            base.fill = Some(ColorValue::Solid {
                color: Rgba::srgb(shade, shade, shade, 1.0),
            });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        for (space, expected) in [
            (WorkingColorSpace::Srgb, 128_u8),
            (WorkingColorSpace::LinearSrgb, 188),
        ] {
            let mut scene = document(vec![rectangle("white", 1.0), rectangle("black", 0.0)]);
            scene.working_color_space = space;
            scene.canvas.width = 16;
            scene.canvas.height = 16;
            scene.timeline.channels = vec![KeyframeChannel {
                object_id: "black".into(),
                property: "opacity".into(),
                keys: vec![
                    SceneKeyframe {
                        frame: 0,
                        value: 0.0,
                        easing: SceneEasing::Linear,
                        bezier: None,
                    },
                    SceneKeyframe {
                        frame: 100,
                        value: 1.0,
                        easing: SceneEasing::Linear,
                        bezier: None,
                    },
                ],
            }];
            let prepared = PreparedScene::prepare(
                scene.clone(),
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .unwrap();
            let frame = prepared.frame_at(50, OutputTransform::Srgb).unwrap();
            let pixel = &frame.pixels[(5 * 16 + 5) * 4..][..4];
            assert!(
                pixel[..3].iter().all(|c| c.abs_diff(expected) <= 1),
                "{space:?}: {pixel:?}"
            );
            scene.timeline.channels[0].keys[0].easing = SceneEasing::CustomBezier;
            scene.timeline.channels[0].keys[0].bezier = Some(CubicBezier {
                x1: 0.25,
                y1: 1.4,
                x2: 0.75,
                y2: 1.4,
            });
            assert!(
                matches!(PreparedScene::prepare(scene, &HashSet::new(), &AssetBytes::new(), &MaterialSupport::fixed_function()),
                Err(Refusal::KeyframeValueOutOfDomain { object, property, frame: 0, .. }) if object == "black" && property == "opacity")
            );
        }
    }

    #[test]
    fn animated_frames_are_evaluated_before_rasterisation() {
        let mut shape = RectObject {
            base: ObjectBase::new("card", "card"),
            radius: 0.0,
        };
        shape.base.width = 12.0;
        shape.base.height = 12.0;
        shape.base.fill = Some(ColorValue::opaque_white());
        let mut scene = document(vec![SceneObject::Rect(shape)]);
        scene.canvas.width = 64;
        scene.canvas.height = 32;
        scene.timeline.channels = vec![KeyframeChannel {
            object_id: "card".into(),
            property: "x".into(),
            keys: vec![
                SceneKeyframe {
                    frame: 0,
                    value: 0.0,
                    easing: SceneEasing::Linear,
                    bezier: None,
                },
                SceneKeyframe {
                    frame: 100,
                    value: 40.0,
                    easing: SceneEasing::Linear,
                    bezier: None,
                },
            ],
        }];
        let prepared = PreparedScene::prepare(
            scene,
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .unwrap();

        assert!(prepared.has_animation());
        assert_eq!(
            prepared.frame_at(0, OutputTransform::Srgb).unwrap(),
            prepared.frame(OutputTransform::Srgb)
        );
        assert_ne!(
            prepared.frame_at(100, OutputTransform::Srgb).unwrap(),
            prepared.frame(OutputTransform::Srgb),
            "the authored x channel must move pixels before output encoding"
        );
    }

    fn text_defaults() -> TextObject {
        TextObject {
            base: ObjectBase::new("x", "x"),
            text: String::new(),
            font_id: String::new(),
            size: 0.0,
            layout: Default::default(),
            auto_fit: Default::default(),
            writing_mode: Default::default(),
            vertical_align: Default::default(),
            direction: Default::default(),
            text_case: Default::default(),
            decoration: Default::default(),
            overflow: Default::default(),
            max_lines: None,
            kerning: None,
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
            baseline_shift: None,
            text_animator: None,
        }
    }

    /// 3.19: on the CPU reference, a clip group's clip child clips every other
    /// descendant at its own opacity, visible or not, and is never drawn;
    /// nested clip groups multiply; a group outside any clip is untouched.
    #[test]
    fn clip_groups_clip_their_other_descendants_at_the_clip_childs_own_opacity() {
        use gx_contracts::color::Rgba;
        let rect = |id: &str, x: f64, w: f64, opacity: f64, visible: bool| {
            let mut base = ObjectBase::new(id, id);
            base.x = x;
            base.y = 0.0;
            base.width = w;
            base.height = 40.0;
            base.opacity = opacity;
            base.visible = visible;
            base.fill = Some(ColorValue::Solid {
                color: Rgba::srgb(1.0, 1.0, 1.0, 1.0),
            });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        let group = |id: &str, children: &[&str], clip: &str, opacity: f64| {
            let mut base = ObjectBase::new(id, id);
            base.opacity = opacity;
            SceneObject::Group(GroupObject {
                base,
                child_ids: children.iter().map(|c| (*c).into()).collect(),
                clip_child_id: Some(clip.into()),
            })
        };
        // Outer: a hidden clip at 80% over x 0..100, a fill over 0..300 and a
        // nested group clipped to x 50..150 holding a fill over 0..300.
        let scene = document(vec![
            group("outer", &["clip", "fill", "inner"], "clip", 0.5),
            rect("clip", 0.0, 100.0, 0.8, false),
            rect("fill", 0.0, 300.0, 1.0, true),
            group("inner", &["inner-clip", "inner-fill"], "inner-clip", 1.0),
            rect("inner-clip", 50.0, 100.0, 1.0, true),
            rect("inner-fill", 0.0, 300.0, 1.0, true),
        ]);
        let prepared = PreparedScene::prepare(
            scene,
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("the clipped scene prepares");
        let frame = prepared.frame(OutputTransform::Srgb);
        let alpha = |x: usize| frame.pixels[(20 * frame.width as usize + x) * 4 + 3];
        // x 25: the fill at 0.5 x 0.8 = 0.4; the nested fill is outside its clip.
        assert_eq!(alpha(25), 102);
        // x 75: both fills at 0.4: 0.4 + 0.4 x 0.6 = 0.64.
        assert_eq!(alpha(75), 163);
        // x 125: inside the nested clip but outside the outer one: nothing.
        // x 200: outside both. The visible nested clip child is not drawn.
        assert_eq!([alpha(125), alpha(200)], [0, 0]);
    }

    /// 3.19: on the CPU reference, each track matte mode lets through what its
    /// name says, the source at its own opacity, and the source is drawn only
    /// when its own visibility says so (3.30, Masking spec v2, 6.2).
    #[test]
    fn track_mattes_let_through_alpha_or_luma_and_a_hidden_source_is_not_drawn() {
        use gx_contracts::color::Rgba;
        use gx_contracts::scene::{TrackMatte, TrackMatteMode};
        let rect = |id: &str, x: f64, y: f64, w: f64, h: f64, colour: Rgba| {
            let mut base = ObjectBase::new(id, id);
            (base.x, base.y, base.width, base.height) = (x, y, w, h);
            base.fill = Some(ColorValue::Solid { color: colour });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        // A red source over x 0..100 (Rec.709 luma 0.2126), hidden: it still
        // mattes. `shown` below turns its eye on.
        let build = |visible: bool| {
            let mut objects = vec![rect(
                "source",
                0.0,
                0.0,
                100.0,
                500.0,
                Rgba::srgb(1.0, 0.0, 0.0, 1.0),
            )];
            objects[0].base_mut().visible = visible;
            let modes = [
                TrackMatteMode::Alpha,
                TrackMatteMode::AlphaInverted,
                TrackMatteMode::Luma,
                TrackMatteMode::LumaInverted,
            ];
            for (k, mode) in modes.into_iter().enumerate() {
                let mut consumer = rect(
                    &format!("consumer-{k}"),
                    0.0,
                    100.0 * k as f64,
                    200.0,
                    40.0,
                    Rgba::srgb(1.0, 1.0, 1.0, 1.0),
                );
                consumer.base_mut().track_matte = Some(TrackMatte {
                    source_id: "source".into(),
                    mode,
                });
                objects.push(consumer);
            }
            let prepared = PreparedScene::prepare(
                document(objects),
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .expect("the matted scene prepares");
            prepared.frame(OutputTransform::Srgb)
        };
        let frame = build(false);
        let alpha = |x: usize, y: usize| frame.pixels[(y * frame.width as usize + x) * 4 + 3];
        // Inside the source (x 50), then outside it (x 150), per mode.
        let rows: Vec<[u8; 2]> = (0..4)
            .map(|k| [alpha(50, 100 * k + 20), alpha(150, 100 * k + 20)])
            .collect();
        assert_eq!(rows[0], [255, 0], "alpha");
        assert_eq!(rows[1], [0, 255], "inverted alpha");
        assert_eq!(rows[2], [54, 0], "luma 0.2126");
        assert_eq!(rows[3], [201, 255], "inverted luma 0.7874");
        // Between the consumers, inside the source: a hidden source draws nothing.
        assert_eq!(alpha(50, 70), 0, "a hidden matte source is not drawn");
        // Visible, the same source is drawn as well, and still mattes.
        let shown = build(true);
        let seen = |x: usize, y: usize| shown.pixels[(y * shown.width as usize + x) * 4 + 3];
        assert_eq!(seen(50, 70), 255, "a visible matte source is drawn");
        assert_eq!(seen(150, 20), 0, "and the matte reads it the same");
    }

    fn white_square_shape(x0: f64, ids: Vec<u32>) -> (SceneObject, gx_contracts::scene::BezierPath) {
        use gx_contracts::color::Rgba;
        use gx_contracts::scene::{BezierPath, FillRule, ShapeObject, Vec2};
        let v = |x: f64, y: f64| Vec2 { x, y };
        let path = BezierPath {
            closed: true,
            vertices: vec![v(x0, 100.0), v(x0 + 100.0, 100.0), v(x0 + 100.0, 200.0), v(x0, 200.0)],
            in_tangents: vec![v(0.0, 0.0); 4],
            out_tangents: vec![v(0.0, 0.0); 4],
            vertex_ids: Some(ids),
            vertex_kinds: None,
            auto_tension: None,
        };
        let mut base = ObjectBase::new("box", "box");
        base.fill = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0) });
        let shape = SceneObject::Shape(ShapeObject {
            base,
            path: path.clone(),
            compound_paths: None,
            fill_enabled: true,
            stroke_enabled: false,
            fill_rule: FillRule::Nonzero,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
            contour_ids: None,
        });
        (shape, path)
    }

    /// 11.112: an animated path is evaluated by vertex id and re-rasterised each frame on
    /// the reference; between keys of different topology the earlier key holds.
    #[test]
    fn an_animated_path_moves_between_its_keys_and_holds_across_a_topology_change() {
        use gx_contracts::animation::SceneEasing;
        use gx_contracts::path_anim::{PathChannel, PathKey};
        use gx_contracts::path_geometry::PathTarget;
        let (shape, left) = white_square_shape(100.0, vec![0, 1, 2, 3]);
        let (_, right) = white_square_shape(500.0, vec![0, 1, 2, 3]);
        let build = |second: gx_contracts::scene::BezierPath| {
            let mut doc = document(vec![shape.clone()]);
            doc.timeline.duration_frames = 100;
            doc.timeline.path_channels = vec![PathChannel {
                object_id: "box".into(),
                target: PathTarget::Shape { subpath: 0 },
                keys: vec![
                    PathKey { frame: 0, path: left.clone(), easing: SceneEasing::Linear, bezier: None },
                    PathKey { frame: 20, path: second, easing: SceneEasing::Linear, bezier: None },
                ],
            }];
            PreparedScene::prepare(doc, &HashSet::new(), &AssetBytes::new(), &MaterialSupport::fixed_function())
                .expect("the animated path prepares")
        };
        let alpha = |f: &crate::Frame, x: usize, y: usize| f.pixels[(y * f.width as usize + x) * 4 + 3];
        let scene = build(right.clone());
        assert!(scene.has_animation(), "a path channel is animation");
        let at = |frame: u64| scene.frame_at(frame, OutputTransform::Srgb).expect("the frame renders");
        let (f0, f10, f20) = (at(0), at(10), at(20));
        assert_eq!((alpha(&f0, 150, 150), alpha(&f0, 350, 150), alpha(&f0, 550, 150)), (255, 0, 0));
        assert_eq!((alpha(&f10, 150, 150), alpha(&f10, 350, 150), alpha(&f10, 550, 150)), (0, 255, 0), "halfway between the keys");
        assert_eq!((alpha(&f20, 150, 150), alpha(&f20, 350, 150), alpha(&f20, 550, 150)), (0, 0, 255));
        assert_eq!(alpha(&at(500), 550, 150), 255, "held after the last key");
        // The same frame twice is the same pixels: the evaluation has no state.
        assert_eq!(at(10).pixels, f10.pixels);
        // Different ids in the same order of count: the earlier key holds, nothing is swapped by index.
        let (_, odd) = white_square_shape(500.0, vec![0, 2, 1, 3]);
        let held = build(odd);
        let frame = held.frame_at(10, OutputTransform::Srgb).expect("the frame renders");
        assert_eq!(frame.pixels, f0.pixels, "held on the first key");
    }

    /// A large scene: `n` shapes, and a path channel of `keys` keys for each of the first `channels` of them.
    fn large_animated_document(n: usize, channels: usize, keys: usize) -> SceneDocument {
        use gx_contracts::animation::SceneEasing;
        use gx_contracts::path_anim::{PathChannel, PathKey};
        use gx_contracts::path_geometry::PathTarget;
        let mut objects = Vec::with_capacity(n);
        let mut path_channels = Vec::new();
        for i in 0..n {
            let (SceneObject::Shape(mut shape), path) = white_square_shape(10.0 + i as f64, vec![0, 1, 2, 3]) else { unreachable!() };
            shape.base.id = format!("box-{i}");
            if i < channels {
                path_channels.push(PathChannel {
                    object_id: shape.base.id.clone(),
                    target: PathTarget::Shape { subpath: 0 },
                    keys: (0..keys).map(|k| PathKey { frame: k as u64, path: path.clone(), easing: SceneEasing::Linear, bezier: None }).collect(),
                });
            }
            objects.push(SceneObject::Shape(shape));
        }
        let mut doc = document(objects);
        doc.timeline.duration_frames = keys as u64 + 1;
        doc.timeline.path_channels = path_channels;
        doc
    }

    /// The work of a frame copies the one object it draws, not the document, and puts the document back as it was, even after a panic.
    #[test]
    fn a_frame_of_an_animated_source_copies_one_object_and_leaves_the_document_as_it_was() {
        use crate::layer_source::{local_document, with_local_document};
        let mut doc = large_animated_document(50, 10, 4);
        let before = doc.clone();
        let seen = with_local_document(&mut doc, 7, [3.0, 4.0], |local| {
            let expected = local_document(&before, 7, [3.0, 4.0]);
            assert_eq!(local, &expected, "the document the work sees is the copy it saw before");
            (local.objects.len(), local.objects[0].base().id.clone(), local.objects[0].base().x)
        });
        assert_eq!(seen, (1, "box-7".to_string(), 3.0));
        assert_eq!(doc, before, "the document is as it was");
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_local_document(&mut doc, 3, [0.0, 0.0], |_| panic!("a draw that fails half way"))
        }));
        assert!(caught.is_err());
        assert_eq!(doc, before, "a panic in the middle puts the objects back too");
    }

    /// The copy a frame makes no longer grows with the scene (measured, printed): 2,000 shapes, 200 of them with 8-key path channels.
    #[test]
    fn a_frame_of_an_animated_source_costs_less_than_copying_the_document() {
        use crate::layer_source::{local_document, with_local_document};
        let mut doc = large_animated_document(2000, 200, 8);
        let rounds = 40;
        let start = std::time::Instant::now();
        for r in 0..rounds {
            let local = local_document(&doc, r % 200, [0.0, 0.0]);
            std::hint::black_box(&local);
        }
        let whole = start.elapsed();
        let start = std::time::Instant::now();
        for r in 0..rounds {
            with_local_document(&mut doc, r % 200, [0.0, 0.0], |local| {
                std::hint::black_box(local);
            });
        }
        let swapped = start.elapsed();
        println!("per frame and animated layer: copy of the document {:?}, one object {:?}", whole / rounds as u32, swapped / rounds as u32);
        assert!(swapped * 5 < whole, "one object ({swapped:?}) should cost far less than the document ({whole:?})");
    }

    /// 11.113: an auto vertex draws the handles derived from its neighbours, and a drawn path
    /// with those handles written out is the same picture.
    #[test]
    fn an_auto_vertex_draws_the_derived_handles() {
        use gx_contracts::path_geometry::{derive_auto_handles, effective};
        use gx_contracts::scene::{BezierPath, FillRule, ShapeObject, Vec2, VertexKind};
        let v = |x: f64, y: f64| Vec2 { x, y };
        let auto = BezierPath {
            closed: true,
            vertices: vec![v(100.0, 100.0), v(300.0, 60.0), v(500.0, 100.0), v(300.0, 300.0)],
            in_tangents: vec![v(0.0, 0.0); 4],
            out_tangents: vec![v(0.0, 0.0); 4],
            vertex_ids: None,
            vertex_kinds: Some(vec![VertexKind::Auto; 4]),
            auto_tension: None,
        };
        let mut written = auto.clone();
        for i in 0..4 {
            let (inn, out) = derive_auto_handles(&auto, i);
            written.in_tangents[i] = inn;
            written.out_tangents[i] = out;
        }
        written.vertex_kinds = None;
        assert_eq!(effective(&auto).out_tangents, written.out_tangents);
        let render = |path: BezierPath| {
            let (mut object, _) = white_square_shape(0.0, vec![0, 1, 2, 3]);
            if let SceneObject::Shape(ShapeObject { path: slot, fill_rule, .. }) = &mut object {
                *slot = path;
                *fill_rule = FillRule::Nonzero;
            }
            PreparedScene::prepare(document(vec![object]), &HashSet::new(), &AssetBytes::new(), &MaterialSupport::fixed_function())
                .expect("the shape prepares")
                .frame(OutputTransform::Srgb)
        };
        let (a, b) = (render(auto.clone()), render(written));
        assert_eq!(a.pixels, b.pixels, "derived handles draw as the same handles written out");
        // And they are not the straight polygon: the corners of a stored-handle-free polygon differ.
        let mut polygon = auto;
        polygon.vertex_kinds = None;
        assert_ne!(render(polygon).pixels, a.pixels);
    }

    /// 3.30: two layers may matte each other (a matte reads its source before the source's own matte, so nothing recurses), and a matte
    /// whose source is gone leaves the layer drawn without one.
    #[test]
    fn layers_that_matte_each_other_render_and_a_gone_source_passes_through() {
        use gx_contracts::color::Rgba;
        use gx_contracts::scene::{TrackMatte, TrackMatteMode};
        let rect_at = |id: &str, x: f64, source: Option<&str>| {
            let mut base = ObjectBase::new(id, id);
            (base.x, base.y, base.width, base.height) = (x, 0.0, 100.0, 40.0);
            base.fill = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0) });
            base.track_matte = source.map(|s| TrackMatte { source_id: s.into(), mode: TrackMatteMode::Alpha });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        let render = |objects: Vec<SceneObject>| {
            PreparedScene::prepare(document(objects), &HashSet::new(), &AssetBytes::new(), &MaterialSupport::fixed_function())
                .expect("the scene prepares")
                .frame(OutputTransform::Srgb)
        };
        let alpha = |f: &crate::Frame, x: usize| f.pixels[(20 * f.width as usize + x) * 4 + 3];
        // A (0..100) matted by B (50..150) and B by A: each shows only where the other is, so both show 50..100.
        let mutual = render(vec![rect_at("a", 0.0, Some("b")), rect_at("b", 50.0, Some("a"))]);
        assert_eq!([alpha(&mutual, 25), alpha(&mutual, 75), alpha(&mutual, 125)], [0, 255, 0]);
        // A chain: c is matted by a, which is matted by b. The matte reads a's pixels (0..100), not a after b.
        let hidden = |mut object: SceneObject| {
            object.base_mut().visible = false;
            object
        };
        let chain = render(vec![hidden(rect_at("a", 0.0, Some("b"))), hidden(rect_at("b", 50.0, None)), rect_at("c", 20.0, Some("a"))]);
        assert_eq!(alpha(&chain, 30), 255, "c shows over a's own pixels, 20..100, inside a");
        assert_eq!(alpha(&chain, 110), 0);
        // A source that is not in the scene: the layer is drawn, unmatted.
        let gone = render(vec![rect_at("a", 0.0, Some("missing"))]);
        assert_eq!([alpha(&gone, 25), alpha(&gone, 75), alpha(&gone, 125)], [255, 255, 0]);
    }

    /// 3.30 (spec 6.5): the matte inspection views are drawn by the engine from a changed copy of the document.
    #[test]
    fn the_matte_views_draw_the_alpha_the_luma_and_the_layer_with_and_without_its_matte() {
        use gx_contracts::color::Rgba;
        use gx_contracts::matte_view::{matte_view_document, MatteView, MatteViewRequest};
        use gx_contracts::scene::{TrackMatte, TrackMatteMode};
        let rect_at = |id: &str, x: f64, colour: Rgba, source: Option<&str>| {
            let mut base = ObjectBase::new(id, id);
            (base.x, base.y, base.width, base.height) = (x, 0.0, 100.0, 40.0);
            base.fill = Some(ColorValue::Solid { color: colour });
            base.track_matte = source.map(|s| TrackMatte { source_id: s.into(), mode: TrackMatteMode::Alpha });
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        let doc = document(vec![
            rect_at("card", 0.0, Rgba::srgb(0.0, 0.0, 1.0, 1.0), Some("disc")),
            rect_at("disc", 50.0, Rgba::srgb(1.0, 0.5, 0.0, 0.5), None),
        ]);
        let render = |view: Option<MatteView>| {
            let shown = match view {
                Some(view) => matte_view_document(&doc, &MatteViewRequest { object_id: "card".into(), view }).unwrap(),
                None => doc.clone(),
            };
            PreparedScene::prepare(shown, &HashSet::new(), &AssetBytes::new(), &MaterialSupport::fixed_function())
                .expect("the view prepares")
                .frame(OutputTransform::Srgb)
        };
        let px = |f: &crate::Frame, x: usize| {
            let i = (20 * f.width as usize + x) * 4;
            [f.pixels[i], f.pixels[i + 1], f.pixels[i + 2], f.pixels[i + 3]]
        };
        // The source's alpha: white where the source is, at its own half alpha; nothing elsewhere.
        let alpha = render(Some(MatteView::Alpha));
        assert_eq!(px(&alpha, 25), [0, 0, 0, 0]);
        let a = px(&alpha, 100);
        assert!(a[0] > 250 && a[1] > 250 && a[2] > 250 && (126..=129).contains(&a[3]), "{a:?}");
        // The luma: a grey, not the orange, at about half the orange's luma (alpha times Y).
        let luma = render(Some(MatteView::Luma));
        let l = px(&luma, 100);
        assert!(l[0] == l[1] && l[1] == l[2], "grey: {l:?}");
        assert!(l[3] >= 126 && l[3] <= 129, "{l:?}");
        // Without its matte the card is whole; with it the card is where the disc is, and the disc itself is not drawn.
        let before = render(Some(MatteView::Before));
        assert_eq!([px(&before, 25)[2], px(&before, 25)[3]], [255, 255]);
        let applied = render(Some(MatteView::Applied));
        assert_eq!(px(&applied, 25)[3], 0);
        assert!((126..=129).contains(&px(&applied, 75)[3]), "the matte's own half alpha: {:?}", px(&applied, 75));
        assert_eq!(px(&applied, 125)[3], 0);
        // The ordinary frame is not any of them.
        assert_ne!(render(None).pixels, applied.pixels);
    }

    /// 11.108: a mask's variable feather, from the contract's points to the layer's pixels.
    #[test]
    fn a_mask_with_feather_points_softens_its_edge_by_the_amount_the_points_give_along_it() {
        use gx_contracts::color::Rgba;
        use gx_contracts::scene::{BezierPath, FeatherPoint, Mask, MaskFalloff, MaskMode, Vec2};
        let v = |x: f64, y: f64| Vec2 { x, y };
        let build = |points: Option<Vec<FeatherPoint>>, falloff: Option<MaskFalloff>| {
            let mut base = ObjectBase::new("card", "card");
            (base.x, base.y, base.width, base.height) = (0.0, 0.0, 200.0, 80.0);
            base.fill = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0) });
            base.masks = Some(vec![Mask {
                id: None,
                path: BezierPath {
                    closed: true,
                    vertices: vec![v(40.0, 0.0), v(160.0, 0.0), v(160.0, 80.0), v(40.0, 80.0)],
                    in_tangents: vec![v(0.0, 0.0); 4],
                    out_tangents: vec![v(0.0, 0.0); 4],
                    vertex_ids: None,
                    vertex_kinds: None,
                    auto_tension: None,
                },
                mode: MaskMode::Add,
                feather: 0.0,
                feather_y: None,
                falloff,
                feather_points: points,
                expansion: 0.0,
                opacity: 1.0,
                inverted: false,
            }]);
            PreparedScene::prepare(
                document(vec![SceneObject::Rect(RectObject { base, radius: 0.0 })]),
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .expect("the scene prepares")
            .frame(OutputTransform::Srgb)
        };
        let alpha = |f: &crate::Frame, x: usize| f.pixels[(40 * f.width as usize + x) * 4 + 3];
        // The left edge (segment 3, from (40,80) back up to (40,0)) fades 20 pixels inward; the right edge stays hard.
        let points = vec![FeatherPoint { segment: 3, t: 0.5, radius: -20.0, tension: 0.0 }, FeatherPoint { segment: 1, t: 0.5, radius: 0.0, tension: 0.0 }];
        let linear = build(Some(points.clone()), Some(MaskFalloff::Linear));
        assert_eq!(alpha(&linear, 20), 0, "outside the mask");
        assert!((i32::from(alpha(&linear, 50)) - 127).abs() <= 8, "ten pixels in, halfway through a 20 pixel fade: {}", alpha(&linear, 50));
        assert_eq!(alpha(&linear, 100), 255);
        assert_eq!(alpha(&linear, 158), 255, "the right edge is hard up to the edge");
        assert_eq!(alpha(&linear, 165), 0);
        // Smooth is not linear: a quarter in it is less than a quarter.
        let smooth = build(Some(points), None);
        assert!(alpha(&smooth, 45) < alpha(&linear, 45), "{} against {}", alpha(&smooth, 45), alpha(&linear, 45));
        // No points: the edge is hard, as a mask with no feather is.
        let hard = build(None, None);
        assert_eq!([alpha(&hard, 38), alpha(&hard, 42)], [0, 255]);
    }

    /// 3.28: an effect with a mask reference acts only where its masks cover,
    /// and a mask in mode `none` serves as the reference without clipping.
    #[test]
    fn an_effect_with_a_mask_reference_acts_only_where_the_mask_covers() {
        use gx_contracts::color::Rgba;
        use gx_contracts::effect::{Effect, EffectInstance, Fill};
        use gx_contracts::scene::{BezierPath, Mask, MaskMode, Vec2};
        let v = |x: f64, y: f64| Vec2 { x, y };
        let left_half = BezierPath {
            closed: true,
            vertices: vec![v(0.0, 0.0), v(100.0, 0.0), v(100.0, 40.0), v(0.0, 40.0)],
            in_tangents: vec![v(0.0, 0.0); 4],
            out_tangents: vec![v(0.0, 0.0); 4],
            vertex_ids: None,
            vertex_kinds: None,
            auto_tension: None,
        };
        let build = |reference: Option<&str>, mode: MaskMode| {
            let mut base = ObjectBase::new("card", "card");
            (base.x, base.y, base.width, base.height) = (0.0, 0.0, 200.0, 40.0);
            base.fill = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0) });
            base.masks = Some(vec![Mask {
                id: Some("left".into()),
                path: left_half.clone(),
                mode,
                feather: 0.0,
                feather_y: None,
                falloff: None,
                feather_points: None,
                expansion: 0.0,
                opacity: 1.0,
                inverted: false,
            }]);
            let mut fx = EffectInstance::new(
                "red",
                Effect::Fill(Fill { color: Rgba::srgb(1.0, 0.0, 0.0, 1.0), opacity: 1.0 }),
            );
            fx.mask_ids = reference.map(|id| vec![id.to_string()]);
            base.effects = Some(vec![fx]);
            let prepared = PreparedScene::prepare(
                document(vec![SceneObject::Rect(RectObject { base, radius: 0.0 })]),
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .expect("the scene prepares");
            prepared.frame(OutputTransform::Srgb)
        };
        let px = |f: &crate::Frame, x: usize| {
            let i = (20 * f.width as usize + x) * 4;
            [f.pixels[i], f.pixels[i + 1], f.pixels[i + 2], f.pixels[i + 3]]
        };
        // With a reference in mode none: the fill is red on the left, the layer is whole and white on the right.
        let limited = build(Some("left"), MaskMode::None);
        assert_eq!(px(&limited, 50), [255, 0, 0, 255], "red where the mask covers");
        assert_eq!(px(&limited, 150), [255, 255, 255, 255], "untouched, and not clipped, outside it");
        // The same effect with no reference is red everywhere the layer is (the mask in mode none clips nothing).
        let everywhere = build(None, MaskMode::None);
        assert_eq!([px(&everywhere, 50), px(&everywhere, 150)], [[255, 0, 0, 255]; 2]);
    }

    /// 3.28 (M-37): the effect's reference changes where the effect acts and nothing about
    /// the layer's own mask: a clipping mask and a reference mask are two different things.
    #[test]
    fn changing_an_effect_reference_does_not_change_the_layers_own_mask() {
        use gx_contracts::color::Rgba;
        use gx_contracts::effect::{Effect, EffectInstance, Fill};
        use gx_contracts::scene::{BezierPath, Mask, MaskMode, Vec2};
        let v = |x: f64, y: f64| Vec2 { x, y };
        let strip = |id: &str, mode: MaskMode, x1: f64| Mask {
            id: Some(id.into()),
            path: BezierPath {
                closed: true,
                vertices: vec![v(0.0, 0.0), v(x1, 0.0), v(x1, 40.0), v(0.0, 40.0)],
                in_tangents: vec![v(0.0, 0.0); 4],
                out_tangents: vec![v(0.0, 0.0); 4],
                vertex_ids: None,
                vertex_kinds: None,
                auto_tension: None,
            },
            mode,
            feather: 0.0,
            feather_y: None,
            falloff: None,
            feather_points: None,
            expansion: 0.0,
            opacity: 1.0,
            inverted: false,
        };
        let build = |reference: &str| {
            let mut base = ObjectBase::new("card", "card");
            (base.x, base.y, base.width, base.height) = (0.0, 0.0, 200.0, 40.0);
            base.fill = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0) });
            // A clip over x 0..150, and a reference-only mask over x 0..50 (mode none).
            base.masks = Some(vec![strip("clip", MaskMode::Add, 150.0), strip("only", MaskMode::None, 50.0), strip("wide", MaskMode::None, 100.0)]);
            let mut fx = EffectInstance::new(
                "red",
                Effect::Fill(Fill { color: Rgba::srgb(1.0, 0.0, 0.0, 1.0), opacity: 1.0 }),
            );
            fx.mask_ids = Some(vec![reference.to_string()]);
            base.effects = Some(vec![fx]);
            PreparedScene::prepare(
                document(vec![SceneObject::Rect(RectObject { base, radius: 0.0 })]),
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .expect("the scene prepares")
            .frame(OutputTransform::Srgb)
        };
        let px = |f: &crate::Frame, x: usize| {
            let i = (20 * f.width as usize + x) * 4;
            [f.pixels[i], f.pixels[i + 1], f.pixels[i + 2], f.pixels[i + 3]]
        };
        for (reference, red_to) in [("only", 50), ("wide", 100)] {
            let frame = build(reference);
            assert_eq!(px(&frame, red_to / 2), [255, 0, 0, 255], "{reference}: red inside the reference");
            assert_eq!(px(&frame, red_to + 20), [255, 255, 255, 255], "{reference}: white outside it, inside the clip");
            // The clip is the same whichever mask the effect names.
            assert_eq!(px(&frame, 140)[3], 255, "{reference}: the clip keeps x 140");
            assert_eq!(px(&frame, 160)[3], 0, "{reference}: the clip removes x 160");
        }
    }

    /// 3.28: Preserve Underlying Transparency scales a layer by the alpha of
    /// what is composited below it, so it shows only over what is there.
    #[test]
    fn preserve_underlying_transparency_shows_a_layer_only_over_what_is_below() {
        use gx_contracts::color::Rgba;
        let rect = |id: &str, x: f64, w: f64, opacity: f64, preserve: bool| {
            let mut base = ObjectBase::new(id, id);
            (base.x, base.y, base.width, base.height) = (x, 0.0, w, 40.0);
            base.opacity = opacity;
            base.fill = Some(ColorValue::Solid { color: Rgba::srgb(1.0, 1.0, 1.0, 1.0) });
            base.preserve_underlying_transparency = preserve.then_some(true);
            SceneObject::Rect(RectObject { base, radius: 0.0 })
        };
        // Below: a half-opaque rect over x 0..100. Above: a full-width layer.
        let build = |preserve: bool| {
            let prepared = PreparedScene::prepare(
                document(vec![rect("below", 0.0, 100.0, 0.5, false), rect("above", 0.0, 200.0, 1.0, preserve)]),
                &HashSet::new(),
                &AssetBytes::new(),
                &MaterialSupport::fixed_function(),
            )
            .expect("the scene prepares");
            prepared.frame(OutputTransform::Srgb)
        };
        let plain = build(false);
        let kept = build(true);
        let alpha = |f: &crate::Frame, x: usize| f.pixels[(20 * f.width as usize + x) * 4 + 3];
        // Without the switch the layer covers everything it spans.
        assert_eq!([alpha(&plain, 50), alpha(&plain, 150)], [255, 255]);
        // With it: over the half-opaque rect it is half as opaque again, over nothing it is nothing.
        // below .5, then above scaled by .5 over it: .5 + .5 * .5 = .75.
        assert!((i32::from(alpha(&kept, 50)) - 191).abs() <= 1, "{}", alpha(&kept, 50));
        assert_eq!(alpha(&kept, 150), 0, "over nothing it shows nothing");
    }

    /// The render features (3.17 to 3.19) authored through the scene edits, as
    /// an MCP agent sends them, then drawn by the CPU reference: the edits
    /// reach the pixels, not only the stored document. A masked rect, a
    /// trimmed stroke beside an untrimmed one, a clip group and a track
    /// matte, each checked by where it is lit and where it is not.
    #[test]
    fn a_scene_authored_by_edits_draws_what_the_edits_say() {
        use gx_contracts::command::{apply_edits, EditContext, SceneEdit};
        let place = |ids: &[&str], x: Option<f64>, y: f64| {
            let mut edits = Vec::new();
            for id in ids {
                if let Some(x) = x {
                    edits.push(serde_json::json!({ "edit": "setObjectField", "objectIds": [id], "field": { "name": "x", "value": x } }));
                }
                edits.push(serde_json::json!({ "edit": "setObjectField", "objectIds": [id], "field": { "name": "y", "value": y } }));
            }
            edits
        };
        let at = |id: &str, x: f64, y: f64| place(&[id], Some(x), y);
        let corner = |points: [(f64, f64); 4]| {
            let vertex = |(x, y): (f64, f64)| serde_json::json!({ "x": x, "y": y });
            let none = serde_json::json!({ "x": 0.0, "y": 0.0 });
            serde_json::json!({
                "closed": true,
                "vertices": points.map(vertex),
                "inTangents": [none, none, none, none],
                "outTangents": [none, none, none, none],
            })
        };
        let white = serde_json::json!({ "type": "solid", "color": { "r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0, "space": "srgb" } });
        let line = serde_json::json!({
            "closed": false,
            "vertices": [{ "x": 0.0, "y": 0.0 }, { "x": 200.0, "y": 0.0 }],
            "inTangents": [{ "x": 0.0, "y": 0.0 }, { "x": 0.0, "y": 0.0 }],
            "outTangents": [{ "x": 0.0, "y": 0.0 }, { "x": 0.0, "y": 0.0 }],
        });
        let mut edits: Vec<serde_json::Value> = vec![
            serde_json::json!({ "edit": "createObject", "kind": "rect", "name": "Card" }),
            serde_json::json!({ "edit": "createObject", "kind": "rect", "name": "Clip" }),
            serde_json::json!({ "edit": "createObject", "kind": "rect", "name": "Content" }),
            serde_json::json!({ "edit": "createObject", "kind": "rect", "name": "Plate" }),
            serde_json::json!({ "edit": "createObject", "kind": "rect", "name": "Source" }),
            serde_json::json!({ "edit": "createObject", "kind": "group", "name": "Stack" }),
            serde_json::json!({ "edit": "createShape", "name": "Trimmed", "path": line }),
            serde_json::json!({ "edit": "createShape", "name": "Whole", "path": line }),
        ];
        // rect-1 at x 0, rect-2 at 400, rect-3 at 500, rect-4 at 800, rect-5 at 900.
        for (id, x) in [
            ("rect-1", 0.0),
            ("rect-2", 400.0),
            ("rect-3", 500.0),
            ("rect-4", 800.0),
            ("rect-5", 900.0),
        ] {
            edits.extend(at(id, x, 0.0));
        }
        // A created group is centred in the canvas like any object, and its
        // children are placed from it, so put it at the origin.
        edits.extend(at("group-1", 0.0, 0.0));
        edits.extend(place(&["shape-1"], None, 300.0));
        edits.extend(place(&["shape-2"], None, 400.0));
        edits.extend([
            // A mask over the left half of the 200 x 120 card.
            serde_json::json!({ "edit": "setObjectMasks", "objectId": "rect-1", "masks": [{
                "path": corner([(0.0, 0.0), (100.0, 0.0), (100.0, 120.0), (0.0, 120.0)]),
                "mode": "add", "feather": 0.0, "expansion": 0.0, "opacity": 1.0, "inverted": false }] }),
            // A clip group: rect-2 clips rect-3.
            serde_json::json!({ "edit": "setGroupChildren", "groupId": "group-1", "childIds": ["rect-2", "rect-3"] }),
            serde_json::json!({ "edit": "setClipChild", "groupId": "group-1", "clipChildId": "rect-2" }),
            // An alpha matte: rect-5 lets rect-4 through where they overlap.
            serde_json::json!({ "edit": "setTrackMatte", "objectId": "rect-4", "trackMatte": { "sourceId": "rect-5", "mode": "alpha" } }),
        ]);
        // Two 10 px white strokes along the same 200 px line; one trimmed to 0-50.
        for id in ["shape-1", "shape-2"] {
            edits
                .push(serde_json::json!({ "edit": "setPaint", "objectIds": [id], "slot": "fill" }));
            edits.push(serde_json::json!({ "edit": "setPaint", "objectIds": [id], "slot": "stroke", "paint": white }));
            edits
                .push(serde_json::json!({ "edit": "setStroke", "objectIds": [id], "width": 10.0 }));
        }
        edits.push(serde_json::json!({ "edit": "setTrim", "objectId": "shape-1", "start": 0.0, "end": 50.0 }));

        let edits: Vec<SceneEdit> = serde_json::from_value(serde_json::Value::Array(edits))
            .expect("the wire JSON is a batch of scene edits");
        let mut scene = document(Vec::new());
        apply_edits(&mut scene, &edits, &EditContext::default()).expect("the batch applies");

        let prepared = PreparedScene::prepare(
            scene,
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("the authored scene prepares");
        let frame = prepared.frame(OutputTransform::Srgb);
        let alpha = |x: usize, y: usize| frame.pixels[(y * frame.width as usize + x) * 4 + 3];
        // The mask keeps the card's left half.
        assert_eq!([alpha(50, 60), alpha(150, 60)], [255, 0], "mask");
        // The clip child clips its sibling and is never drawn: only the
        // overlap of x 500..600 is lit, not the clip's own 400..500 or the
        // content's 600..700.
        assert_eq!(
            [alpha(450, 60), alpha(550, 60), alpha(650, 60)],
            [0, 255, 0],
            "clip group"
        );
        // The matte source lets the plate through where they overlap, and is
        // drawn where it stands alone because it is visible (3.30).
        assert_eq!(
            [alpha(850, 60), alpha(950, 60), alpha(1050, 60)],
            [0, 255, 255],
            "track matte"
        );
        // The trimmed stroke lights half what the untrimmed one does.
        let lit = |y: usize| (0..400).filter(|&x| alpha(x, y) >= 128).count();
        let (trimmed, whole) = (lit(300), lit(400));
        assert!((190..=210).contains(&whole), "the whole stroke lit {whole}");
        assert!(
            (95..=105).contains(&trimmed),
            "the trimmed stroke lit {trimmed} of {whole}"
        );
        assert!(
            alpha(50, 300) >= 128 && alpha(150, 300) == 0,
            "trim keeps 0 to 50"
        );
    }

    /// The MCP gap edits (16 Nov 2026), as wire JSON through `apply_edits`, drawn
    /// by the CPU reference: width, draw order, a blend mode, a compound shape, a
    /// replaced shape path, an effect and an anchor each change what is drawn.
    #[test]
    fn the_layout_edits_draw_what_they_say() {
        use gx_contracts::command::{apply_edits, EditContext, SceneEdit};
        let field = |id: &str, name: &str, value: serde_json::Value| serde_json::json!({ "edit": "setObjectField", "objectIds": [id], "field": { "name": name, "value": value } });
        let at = |id: &str, x: f64, y: f64| {
            [
                field(id, "x", serde_json::json!(x)),
                field(id, "y", serde_json::json!(y)),
            ]
        };
        let solid = |r: f64, g: f64, b: f64| serde_json::json!({ "type": "solid", "color": { "r": r, "g": g, "b": b, "a": 1.0, "space": "srgb" } });
        let fill = |id: &str, paint: serde_json::Value| serde_json::json!({ "edit": "setPaint", "objectIds": [id], "slot": "fill", "paint": paint });
        let square = |x: f64, y: f64, side: f64| {
            let p = |x: f64, y: f64| serde_json::json!({ "x": x, "y": y });
            let zero = p(0.0, 0.0);
            serde_json::json!({
                "closed": true,
                "vertices": [p(x, y), p(x + side, y), p(x + side, y + side), p(x, y + side)],
                "inTangents": [zero, zero, zero, zero],
                "outTangents": [zero, zero, zero, zero],
            })
        };
        let line = serde_json::json!({
            "closed": false,
            "vertices": [{ "x": 0.0, "y": 0.0 }, { "x": 60.0, "y": 0.0 }],
            "inTangents": [{ "x": 0.0, "y": 0.0 }, { "x": 0.0, "y": 0.0 }],
            "outTangents": [{ "x": 0.0, "y": 0.0 }, { "x": 0.0, "y": 0.0 }],
        });
        let mut edits: Vec<serde_json::Value> = (0..8)
            .map(|i| serde_json::json!({ "edit": "createObject", "kind": "rect", "name": format!("R{i}") }))
            .collect();
        edits.push(serde_json::json!({ "edit": "createShape", "name": "Pair",
            "path": square(0.0, 0.0, 50.0), "compoundPaths": [square(100.0, 0.0, 50.0)] }));
        edits.push(serde_json::json!({ "edit": "createShape", "name": "Swap", "path": line }));
        edits.push(serde_json::json!({ "edit": "createShape", "name": "Ring",
            "path": square(0.0, 0.0, 100.0), "compoundPaths": [square(25.0, 25.0, 50.0)] }));
        // Each 200 x 120 rect gets its place.
        for (id, x, y) in [
            ("rect-1", 0.0, 0.0),
            ("rect-2", 400.0, 0.0),
            ("rect-3", 400.0, 0.0),
            ("rect-4", 800.0, 0.0),
            ("rect-5", 800.0, 0.0),
            ("rect-6", 0.0, 500.0),
            ("rect-7", 300.0, 500.0),
            ("rect-8", 800.0, 500.0),
            ("shape-1", 0.0, 300.0),
            ("shape-2", 400.0, 300.0),
            ("shape-3", 0.0, 700.0),
        ] {
            // A shape is created at the origin; its x of 0 is no change.
            if id.starts_with("shape") && x == 0.0 {
                edits.push(field(id, "y", serde_json::json!(y)));
            } else {
                edits.extend(at(id, x, y));
            }
        }
        edits.extend([
            // Width: rect-1 grows from 200 to 300.
            field("rect-1", "width", serde_json::json!(300.0)),
            // Draw order: red rect-2 is raised over blue rect-3.
            fill("rect-2", solid(1.0, 0.0, 0.0)),
            fill("rect-3", solid(0.0, 0.0, 1.0)),
            field("rect-2", "zIndex", serde_json::json!(1)),
            // Blend: green rect-4 multiplies over red rect-5, which is black.
            fill("rect-4", solid(0.0, 1.0, 0.0)),
            fill("rect-5", solid(1.0, 0.0, 0.0)),
            field("rect-4", "zIndex", serde_json::json!(1)),
            serde_json::json!({ "edit": "setBlendMode", "objectIds": ["rect-4"], "blendMode": "multiply" }),
            // A line becomes a filled square.
            serde_json::json!({ "edit": "setShapePath", "shapeId": "shape-2", "path": square(0.0, 0.0, 60.0) }),
            fill("shape-2", solid(1.0, 1.0, 1.0)),
            // Even-odd cuts the inner square out of the ring.
            serde_json::json!({ "edit": "setShapePath", "shapeId": "shape-3", "path": square(0.0, 0.0, 100.0),
                "compoundPaths": [square(25.0, 25.0, 50.0)], "fillRule": "evenodd" }),
            // The same grey, one with one stop of exposure.
            fill("rect-6", solid(0.25, 0.25, 0.25)),
            fill("rect-7", solid(0.25, 0.25, 0.25)),
            serde_json::json!({ "edit": "setEffects", "objectId": "rect-7", "effects": [
                { "effectId": "lift", "effect": "exposure", "exposure": 1.0, "offset": 0.0, "gammaCorrection": 1.0 }] }),
            // Rotated a quarter turn about its centre rather than its corner.
            serde_json::json!({ "edit": "setAnchor", "objectIds": ["rect-8"], "anchor": { "x": 100.0, "y": 60.0 } }),
            field("rect-8", "rotation", serde_json::json!(90.0)),
        ]);
        let edits: Vec<SceneEdit> = serde_json::from_value(serde_json::Value::Array(edits))
            .expect("the wire JSON is a batch of scene edits");
        let mut scene = document(Vec::new());
        apply_edits(&mut scene, &edits, &EditContext::default()).expect("the batch applies");
        let prepared = PreparedScene::prepare(
            scene,
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("the authored scene prepares");
        let frame = prepared.frame(OutputTransform::Srgb);
        let px = |x: usize, y: usize| {
            let i = (y * frame.width as usize + x) * 4;
            [
                frame.pixels[i],
                frame.pixels[i + 1],
                frame.pixels[i + 2],
                frame.pixels[i + 3],
            ]
        };
        let alpha = |x: usize, y: usize| px(x, y)[3];
        assert_eq!([alpha(250, 60), alpha(350, 60)], [255, 0], "width 300");
        let [r, _, b, _] = px(450, 60);
        assert!(
            r > 200 && b < 50,
            "the raised red rect is on top: {:?}",
            px(450, 60)
        );
        let [r, g, _, a] = px(850, 60);
        assert!(
            a == 255 && r < 20 && g < 20,
            "green multiplied over red: {:?}",
            px(850, 60)
        );
        assert_eq!(
            [alpha(25, 325), alpha(75, 325), alpha(125, 325)],
            [255, 0, 255],
            "both subpaths of the compound shape, nothing between"
        );
        assert_eq!(alpha(430, 330), 255, "the replaced path is a filled square");
        assert_eq!(
            [alpha(10, 710), alpha(50, 750)],
            [255, 0],
            "an even-odd compound shape has a hole"
        );
        // One stop doubles linear light: sRGB 0.25 (code 64) is linear 0.051,
        // doubled 0.102, which is sRGB code 90.
        let (plain, lifted) = (px(50, 560)[0], px(350, 560)[0]);
        assert_eq!(plain, 64, "the plain grey");
        assert!(
            (88..=92).contains(&lifted),
            "one stop of exposure: {plain} to {lifted}"
        );
        // About its centre (anchor 100, 60 at x 800, y 500) the quarter-turned
        // rect spans x 740..860 and y 400..600; about its corner it would not
        // reach y 590 at x 800, and unrotated it would cover x 880.
        assert_eq!([alpha(800, 590), alpha(880, 500)], [255, 0], "anchor");
    }
}
