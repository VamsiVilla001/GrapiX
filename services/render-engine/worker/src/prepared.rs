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
use crate::rasterise::{LyonPathRasteriser, PathRasteriser, PreparedPaths, RasterSurface};
use crate::rasterizer::Frame;
use crate::text::{prepare_texts, PreparedTexts};

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
        let resolved = gx_contracts::bindings::resolve_scene_bindings(&document)?;
        // 3.13: what this engine cannot draw refuses by name, never drops.
        crate::support::refuse_what_the_software_path_cannot_draw(&resolved)?;

        let resolution = resolve_hierarchy(&resolved.objects);
        let paths = PreparedPaths::prepare(&resolved, &resolution.effective)?;
        let texts = prepare_texts(&resolved, asset_bytes)?;
        let meshes = prepare_meshes(&resolved, available, asset_bytes, support)?;
        let mut effect_layers = Vec::with_capacity(resolved.objects.len());
        for (index, object) in resolved.objects.iter().enumerate() {
            if object.base().effects().is_empty() {
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
            )?;
            effect_layers.push(Some(EffectLayer { source, iterations }));
        }
        let static_frame = OnceLock::new();
        if build_reference {
            let _ = static_frame.set(compose(
                &resolved,
                &resolution.effective,
                &paths,
                &texts,
                0,
                &effect_layers,
            )?);
        }
        let by_id = resolution
            .effective
            .iter()
            .enumerate()
            .map(|(index, object)| (object.id.clone(), index))
            .collect();

        Ok(Self {
            document,
            resolved,
            effective: resolution.effective,
            effect_layers,
            diagnostics: resolution.diagnostics,
            by_id,
            paths,
            static_frame,
            texts,
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
                    &self.texts,
                    0,
                    &self.effect_layers,
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
        let resolution = resolve_hierarchy(&evaluated.objects);
        let paths = PreparedPaths::prepare(&evaluated, &resolution.effective)?;
        let surface = compose(
            &evaluated,
            &resolution.effective,
            &paths,
            &self.texts,
            scene_frame,
            &self.effect_layers,
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
        let resolution = resolve_hierarchy(&evaluated.objects);
        let paths = PreparedPaths::prepare(&evaluated, &resolution.effective)?;
        compose(
            &evaluated,
            &resolution.effective,
            &paths,
            &self.texts,
            scene_frame,
            &self.effect_layers,
        )
    }

    /// Glyph runs shaped from packaged fonts only.
    pub fn texts(&self) -> &PreparedTexts {
        &self.texts
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
/// An object with effects in its own layer space (3.22).
#[derive(Debug, Clone)]
struct EffectLayer {
    source: crate::layer_source::LayerSource,
    iterations: Vec<usize>,
}

fn compose(
    document: &SceneDocument,
    effective: &[ResolvedObject],
    paths: &PreparedPaths,
    texts: &PreparedTexts,
    scene_frame: u64,
    effect_layers: &[Option<EffectLayer>],
) -> Result<RasterSurface, Refusal> {
    crate::render_work::cpu_frame();
    let mut surface = RasterSurface::transparent(document.canvas.width, document.canvas.height);
    let mut by_object: HashMap<&str, Vec<&crate::rasterise::PreparedPath>> = HashMap::new();
    for path in paths.paths() {
        by_object.entry(path.object_id()).or_default().push(path);
    }
    for index in PreparedScene::draw_order(document) {
        let object = &document.objects[index];
        let id = object.base().id.as_str();
        let mode = object.base().blend_mode();
        let effects = object.base().effects();
        if let Some(layer) = effect_layers.get(index).and_then(Option::as_ref) {
            // 3.22: the effects run on the object's layer-space pixels (the
            // GPU's source), which are then warped onto the canvas exactly
            // as the composite pass samples them.
            let resolved = &effective[index];
            if !(resolved.visible && resolved.opacity > 0.0) {
                continue;
            }
            let source = &layer.source;
            let (w, h) = (
                source.surface.width() as usize,
                source.surface.height() as usize,
            );
            let ctx = crate::effect_chain::EffectContext {
                origin: source.origin,
                size: [object.base().width, object.base().height],
                space: document.working_color_space,
            };
            let mut plan = crate::effect_chain::EffectPlan::layout(effects, &layer.iterations);
            plan.pack(effects, &ctx);
            let pixels = plan.run(source.surface.pixels(), w, h, &ctx);
            let state = crate::compositor::scene::layer_state(
                object.base().anchor,
                resolved,
                source.origin,
            );
            let rows = crate::compositor::layer_rows(surface.width(), surface.height(), state)
                .map_err(|e| {
                    crate::compositor::scene::mapping_refusal(
                        id,
                        &format!("objects[{index}]"),
                        &e.to_string(),
                    )
                })?;
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
            let mut layer = RasterSurface::transparent(surface.width(), surface.height());
            if let Some(object_paths) = by_object.get(id) {
                LyonPathRasteriser.rasterise_into(object_paths, &mut layer);
            }
            if matches!(object, SceneObject::Text(_)) {
                crate::text::rasterise_text(texts, id, document, effective, &mut layer)?;
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
            LyonPathRasteriser.rasterise_into(object_paths, &mut surface);
        }
        if matches!(object, SceneObject::Text(_)) {
            crate::text::rasterise_text(texts, id, document, effective, &mut surface)?;
        }
    }
    Ok(surface)
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
                    },
                    compound_paths: None,
                    fill_enabled: false,
                    stroke_enabled: true,
                    fill_rule: FillRule::Nonzero,
                    trim_start: trim.map(|t| t.0),
                    trim_end: trim.map(|t| t.1),
                    trim_offset: trim.map(|t| t.2),
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
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
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
            },
            compound_paths: None,
            fill_enabled: false,
            stroke_enabled: true,
            fill_rule: FillRule::Nonzero,
            trim_start: None,
            trim_end: None,
            trim_offset: None,
        });
        let prepared = PreparedScene::prepare(
            document(vec![zigzag]),
            &HashSet::new(),
            &AssetBytes::new(),
            &MaterialSupport::fixed_function(),
        )
        .expect("the stroke prepares");
        let alphas: std::collections::BTreeSet<u8> = prepared
            .frame(OutputTransform::Srgb)
            .pixels
            .chunks(4)
            .map(|pixel| pixel[3])
            .filter(|alpha| *alpha > 0)
            .collect();
        assert_eq!(
            alphas.len(),
            1,
            "lit pixels carry several alphas: {alphas:?}"
        );
    }

    #[test]
    fn a_scene_resolves_its_hierarchy_once_at_publish() {
        // Invariant 35: this is the work 1.x did per frame.
        let mut parent = GroupObject {
            base: ObjectBase::new("g", "g"),
            child_ids: vec!["r".into()],
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
        gradient.base_mut().fill = Some(ColorValue::LinearGradient {
            angle: 0.0,
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
        };
        parent.base.scale_x = 2.0;
        let mut sheared = rect("sheared");
        sheared.base_mut().rotation = 30.0;

        let mut underlined = TextObject {
            base: ObjectBase::new("title", "title"),
            text: "Hello".into(),
            font_id: "font_inter".into(),
            size: 40.0,
            ..text_defaults()
        };
        underlined.decoration.underline = true;
        let mut text_scene = document(vec![SceneObject::Text(underlined)]);
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
        };
        painted_group.base.fill = solid();
        let painted_group = SceneObject::Group(painted_group);

        let cases = [
            (
                document(vec![gradient]),
                Refusal::UnsupportedPathGradient {
                    object: "gradient".into(),
                    paint: "fill".into(),
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
            (text_scene, not_drawable("title", "decoration", "3.18")),
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
            align: Default::default(),
            line_height: None,
            letter_spacing: 0.0,
            word_spacing: 0.0,
            paragraph_spacing: 0.0,
            text_indent: 0.0,
        }
    }
}
