//! Per-thread executed work counters, used to audit the Program frame path.
//! Preparation and reference rasterisation record at their actual call sites;
//! frame traces are differences, rather than asserted constant zeroes.
use serde::Serialize;
use std::cell::Cell;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderWork {
    pub cpu_full_frame_rasterizations: u64,
    pub cpu_source_rasterizations: u64,
    pub gpu_resource_builds: u64,
    pub gpu_layer_dispatches: u64,
    /// 3.21 output-encode dispatches (one per tile per frame).
    pub gpu_output_dispatches: u64,
    /// 3.22 effect-step dispatches (one per effect per layer per frame).
    pub gpu_effect_dispatches: u64,
    /// Tile pixels the layer dispatches covered: each layer runs over its
    /// footprint and the previous layer's on the tile, not the whole tile
    /// (3.21).
    pub gpu_layer_pixels: u64,
    /// 11.61: texts shaped (font lookup, line layout and glyph outlines for
    /// one text object). A frame that only moves a text animator shapes none:
    /// it places the outlines that were shaped at prepare.
    pub cpu_text_shapings: u64,
}

thread_local! { static WORK: Cell<RenderWork> = Cell::new(RenderWork::default()); }

impl RenderWork {
    pub fn snapshot() -> Self {
        WORK.with(Cell::get)
    }
    pub fn since(self, before: Self) -> Self {
        Self {
            cpu_full_frame_rasterizations: self.cpu_full_frame_rasterizations
                - before.cpu_full_frame_rasterizations,
            cpu_source_rasterizations: self.cpu_source_rasterizations
                - before.cpu_source_rasterizations,
            gpu_resource_builds: self.gpu_resource_builds - before.gpu_resource_builds,
            gpu_layer_dispatches: self.gpu_layer_dispatches - before.gpu_layer_dispatches,
            gpu_output_dispatches: self.gpu_output_dispatches - before.gpu_output_dispatches,
            gpu_effect_dispatches: self.gpu_effect_dispatches - before.gpu_effect_dispatches,
            gpu_layer_pixels: self.gpu_layer_pixels - before.gpu_layer_pixels,
            cpu_text_shapings: self.cpu_text_shapings - before.cpu_text_shapings,
        }
    }
}

fn record(f: impl FnOnce(&mut RenderWork)) {
    WORK.with(|cell| {
        let mut value = cell.get();
        f(&mut value);
        cell.set(value);
    });
}
pub(crate) fn cpu_frame() {
    record(|w| w.cpu_full_frame_rasterizations += 1);
}
pub(crate) fn cpu_source() {
    record(|w| w.cpu_source_rasterizations += 1);
}
pub(crate) fn gpu_build() {
    record(|w| w.gpu_resource_builds += 1);
}
pub(crate) fn gpu_dispatch(count: usize) {
    record(|w| w.gpu_layer_dispatches += count as u64);
}
pub(crate) fn gpu_output_dispatch(count: usize) {
    record(|w| w.gpu_output_dispatches += count as u64);
}
pub(crate) fn gpu_effect_dispatch(count: usize) {
    record(|w| w.gpu_effect_dispatches += count as u64);
}
pub(crate) fn gpu_layer_area(pixels: u64) {
    record(|w| w.gpu_layer_pixels += pixels);
}
pub(crate) fn text_shaping() {
    record(|w| w.cpu_text_shapings += 1);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramFrameTrace {
    pub engine_frame: u64,
    pub scene_frame: u64,
    pub backend: &'static str,
    pub work: RenderWork,
}
