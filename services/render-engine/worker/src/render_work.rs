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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramFrameTrace {
    pub engine_frame: u64,
    pub scene_frame: u64,
    pub backend: &'static str,
    pub work: RenderWork,
}
