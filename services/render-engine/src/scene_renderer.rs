//! Persistent scene renderer, shared by Program and Preview.
//!
//! Program renders every frame, forever, and a preview stream renders many frames a
//! second, so nothing that can be built once may be built per frame. The first implementation called the core's `render_single_frame`,
//! which is a convenience for one-off renders: it compiles both shader pipelines and
//! allocates a fresh render target on every call. Measured on an RTX 3070 Ti that
//! cost **482 ms per frame** against a 20 ms budget at 50 fps — 9,304 frames dropped
//! in three minutes. Program was technically on air and rendering roughly two frames
//! a second.
//!
//! What is kept across frames here:
//!
//! - the quad and mesh pipelines (shader compilation, the expensive part)
//! - the render target and its read-back buffer, keyed by output size
//! - the text renderer and its glyph caches
//! - the prepared scene, keyed by revision — preparing re-parses the document and
//!   re-shapes every text run, which is pure waste when nothing changed
//! - the mesh frame, keyed by the same revision, matching what the daemon's own
//!   render loop does
//!
//! Rebuilt only when the thing it depends on actually changes: a resize rebuilds the
//! target, a scene edit rebuilds the prepared scene, and neither touches the other.
//!
//! Program and Preview hold **separate instances**. They render different regions at
//! different sizes, and sharing one would make every preview repoint rebuild the Program
//! render target — a resize on the thing that is on air, to serve a thumbnail.

use std::sync::Arc;

use grapix_render_core::output::VideoFrame;
use grapix_render_core::renderer::gpu::GpuContext;
use grapix_render_core::renderer::{frame, mesh, pipeline, text};
use grapix_render_core::scene::PreparedScene;

/// What the cached scene was prepared from. A change in any part invalidates it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SceneKey {
    scene_id: String,
    revision: u64,
    /// Stage origin and size, quantised: the rebase depends on them.
    bounds: (i64, i64, i64, i64),
}

impl SceneKey {
    fn new(scene_id: &str, revision: u64, bounds: (f64, f64, f64, f64)) -> Self {
        Self {
            scene_id: scene_id.to_string(),
            revision,
            // Quantised to whole logical units: a sub-unit stage move does not change
            // what has to be re-prepared, and comparing f64 for equality would make
            // the cache miss on noise.
            bounds: (
                bounds.0.round() as i64,
                bounds.1.round() as i64,
                bounds.2.round() as i64,
                bounds.3.round() as i64,
            ),
        }
    }
}

pub struct SceneRenderer {
    quad_pipeline: pipeline::QuadPipeline,
    mesh_pipeline: mesh::MeshPipeline,
    text_renderer: text::NativeTextRenderer,

    target: frame::FrameTarget,
    target_size: (u32, u32),

    scene_key: Option<SceneKey>,
    prepared: Option<Arc<PreparedScene>>,
    mesh_frame: Option<mesh::MeshFrame>,
    /// Sampled every frame. Invalidated with the prepared scene, because it is read out of
    /// the same document.
    animation: Arc<crate::animation::SceneAnimation>,

    /// True once a quad-budget overflow has been reported, so it is said once.
    warned_overflow: bool,
    /// Fixed-capacity prepared packet source for the quad pipeline. Reused on
    /// every frame; overflow is clipped at the documented scene ceiling.
    quads: Vec<pipeline::QuadUniforms>,
}

impl SceneRenderer {
    pub fn new(gpu: &GpuContext, width: u32, height: u32) -> Self {
        Self {
            quad_pipeline: pipeline::QuadPipeline::new(&gpu.device),
            mesh_pipeline: mesh::MeshPipeline::new(&gpu.device),
            text_renderer: text::NativeTextRenderer::new(),
            target: frame::FrameTarget::new(&gpu.device, width, height),
            target_size: (width, height),
            scene_key: None,
            prepared: None,
            mesh_frame: None,
            animation: Arc::new(crate::animation::SceneAnimation::default()),
            warned_overflow: false,
            quads: Vec::with_capacity(pipeline::MAX_QUADS_PER_FRAME),
        }
    }

    /// Resize the render target, keeping the pipelines.
    ///
    /// Only the target depends on the output size; recompiling the shaders because an
    /// operator changed the output resolution would drop frames for no reason.
    pub fn resize(&mut self, gpu: &GpuContext, width: u32, height: u32) {
        if self.target_size == (width, height) {
            return;
        }
        self.target = frame::FrameTarget::new(&gpu.device, width, height);
        self.target_size = (width, height);
        tracing::info!(width, height, "program render target resized");
    }

    pub fn size(&self) -> (u32, u32) {
        self.target_size
    }

    /// Whether the next `render` call would have to re-prepare the scene.
    ///
    /// Exposed so the caller can avoid cloning the scene document on every frame: the
    /// document is only needed when it is going to be re-prepared, which is rare.
    pub fn needs_prepare(
        &self,
        scene_id: &str,
        revision: u64,
        bounds: (f64, f64, f64, f64),
    ) -> bool {
        match &self.scene_key {
            None => true,
            Some(key) => {
                self.prepared.is_none() || key != &SceneKey::new(scene_id, revision, bounds)
            }
        }
    }

    /// Render one Program frame.
    ///
    /// `prepare` is only called when the key changed; it is passed as a closure so the
    /// caller keeps ownership of the rebase and the engine's error reporting. It returns the
    /// prepared scene **and** the animation read from the same document, so the two can never
    /// disagree about which revision they describe.
    pub fn render(
        &mut self,
        gpu: &GpuContext,
        scene_id: &str,
        revision: u64,
        bounds: (f64, f64, f64, f64),
        frame_index: u64,
        prepare: impl FnOnce() -> Result<(PreparedScene, crate::animation::SceneAnimation), String>,
    ) -> Result<VideoFrame, String> {
        let key = SceneKey::new(scene_id, revision, bounds);

        if self.scene_key.as_ref() != Some(&key) || self.prepared.is_none() {
            let (prepared, animation) = prepare()?;
            let prepared = Arc::new(prepared);
            // The mesh frame is derived from the prepared scene, so it is invalidated
            // by exactly the same change.
            self.mesh_frame = Some(self.mesh_pipeline.prepare_frame(
                &gpu.device,
                &gpu.queue,
                &prepared,
            ));
            if !animation.is_empty() {
                tracing::info!(
                    scene_id,
                    animated_objects = animation.animated_object_count(),
                    "scene carries animation; Program will sample it per frame"
                );
            }
            self.prepared = Some(prepared);
            self.animation = Arc::new(animation);
            self.scene_key = Some(key);
        }

        let prepared = self
            .prepared
            .as_ref()
            .expect("prepared scene is set above")
            .clone();
        let animation = Arc::clone(&self.animation);

        // A still scene builds quads straight from the prepared objects. An animated one
        // patches copies of the animatable numeric fields first: cheap arithmetic over small
        // structs, and specifically NOT a re-prepare, which costs hundreds of milliseconds.
        let origin = (bounds.0 as f32, bounds.1 as f32);
        let animated_rects = (!animation.is_empty()).then(|| {
            let mut rects = prepared.rects.clone();
            let mut texts = prepared.texts.clone();
            animation.apply(frame_index, origin, &mut rects, &mut texts);
            (rects, texts)
        });

        // Meshes are not quads: their transform is a per-draw uniform, so an animated mesh is
        // updated in place on the cached mesh frame. Before this, a mesh animated in the Editor
        // (three.js reads the object every frame) and sat still on Program — the same scene
        // rendering differently in the two places, with nothing to indicate it.
        if !animation.is_empty() {
            if let Some(mesh_frame) = self.mesh_frame.as_mut() {
                let transforms = animation.mesh_transforms(frame_index, origin, &prepared.meshes);
                mesh_frame.update_model_transforms(&gpu.queue, &transforms);
            }
        }

        let requested_quad_count = match &animated_rects {
            Some((rects, _)) => {
                pipeline::QuadPipeline::build_frame_quads_into(&prepared, rects, &mut self.quads)
            }
            None => pipeline::QuadPipeline::build_frame_quads_into(
                &prepared,
                &prepared.rects,
                &mut self.quads,
            ),
        };
        if requested_quad_count > pipeline::MAX_QUADS_PER_FRAME {
            if !self.warned_overflow {
                tracing::warn!(
                    quads = requested_quad_count,
                    max = pipeline::MAX_QUADS_PER_FRAME,
                    "scene exceeds the per-frame quad budget; the extra quads are not rendered"
                );
                self.warned_overflow = true;
            }
        }

        let lease = self
            .target
            .try_acquire_frame()
            .ok_or_else(|| "bounded video frame pool is exhausted".to_string())?;
        let mut video = self
            .target
            .render_and_read_back(
                &gpu.device,
                &gpu.queue,
                &mut self.quad_pipeline,
                &self.quads,
                &self.mesh_pipeline,
                self.mesh_frame.as_ref(),
                frame_index,
                lease,
            )
            .map_err(|error| format!("render failed: {error}"))?;

        match &animated_rects {
            Some((_, texts)) => self
                .text_renderer
                .composite_texts(&mut video, &prepared, texts),
            None => self.text_renderer.composite(&mut video, &prepared),
        }
        video.frame_index = frame_index;
        Ok(video)
    }

    /// Drop the cached scene, forcing a re-prepare on the next frame.
    ///
    /// Called when a scene is edited, unloaded, or resynchronised: rendering a
    /// document nobody else holds is invisible from the output, which makes it the
    /// worst kind of stale cache.
    pub fn invalidate_scene(&mut self) {
        self.scene_key = None;
        self.prepared = None;
        self.mesh_frame = None;
    }
}
