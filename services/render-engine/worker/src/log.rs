//! What the engine writes to its log (build plan 2.12, ADR-0004 §4).
//!
//! One place names every engine event and its fields, so a search or a
//! dashboard built on them breaks here, loudly, if one is renamed. The events
//! go through `tracing` into the process's JSON Lines sink (`gx-telemetry`),
//! which never makes the caller wait, so calling these from the frame path is
//! allowed.
//!
//! **At `info`, always:** every Program request (cue, take, clear, phase) and
//! output configuration and headless render, accepted with the frame the
//! engine committed or refused with its refusal code; every publish; every
//! late frame and every run of missed frames; and a heartbeat once a second
//! with the totals, so a quiet minute is visibly quiet rather than missing.
//! **At `debug`:** the read requests a client polls (capability, status,
//! performance), which would otherwise fill the file with nothing.

use std::time::{Duration, Instant};

use gx_asset_plane::publish::PublishReply;
use gx_control_plane::message::{ClientRequest, EngineReply};

use crate::metrics::FrameSample;

/// What a request asked for, taken before it is handled (handling consumes it).
pub(crate) struct RequestNote {
    kind: &'static str,
    take_id: Option<String>,
    revision: Option<u64>,
    content_hash: Option<String>,
    at: Option<String>,
    phase: Option<String>,
    output: Option<String>,
}

impl RequestNote {
    pub(crate) fn of(request: &ClientRequest) -> Self {
        let mut note = Self {
            kind: request.name(),
            take_id: None,
            revision: None,
            content_hash: None,
            at: None,
            phase: None,
            output: None,
        };
        match request {
            ClientRequest::Cue(r) => {
                note.take_id = Some(r.take_id.0.clone());
                note.revision = Some(r.revision.0);
                note.content_hash = r.content_hash.as_ref().map(|h| h.0.clone());
                note.at = Some(format!("{:?}", r.at));
            }
            ClientRequest::Take(r) => {
                note.take_id = Some(r.take_id.0.clone());
                note.revision = Some(r.revision.0);
                note.content_hash = r.content_hash.as_ref().map(|h| h.0.clone());
                note.at = Some(format!("{:?}", r.at));
            }
            ClientRequest::Clear(r) => note.at = Some(format!("{:?}", r.at)),
            ClientRequest::Phase(r) => {
                note.phase = Some(r.phase.clone());
                note.at = Some(format!("{:?}", r.at));
            }
            ClientRequest::ConfigureOutput(config) => note.output = Some(format!("{config:?}")),
            ClientRequest::Render(r) => return Self::render(r),
            ClientRequest::Authenticate { .. }
            | ClientRequest::Capability { .. }
            | ClientRequest::Status
            | ClientRequest::Stop
            | ClientRequest::Performance => {}
        }
        note
    }

    /// A headless render, noted where it is answered: the control transport
    /// hands a render to the engine by `handle_detached`, not by `handle`.
    pub(crate) fn render(request: &gx_control_plane::render::RenderRequest) -> Self {
        Self {
            kind: "render",
            take_id: Some(request.take_id.0.clone()),
            revision: Some(request.revision.0),
            content_hash: None,
            at: None,
            phase: None,
            output: None,
        }
    }

    /// Whether this request is a poll, logged at `debug` only.
    fn is_read(&self) -> bool {
        matches!(self.kind, "capability" | "status" | "performance")
    }
}

/// Log one handled request and the engine's answer.
pub(crate) fn request(note: &RequestNote, reply: &EngineReply, epoch: u64) {
    let (result, frame, refusal, detail) = match reply {
        EngineReply::Cued(c) | EngineReply::Taken(c) | EngineReply::Cleared(c) => {
            ("committed", Some(c.frame), None, None)
        }
        EngineReply::PhaseCommitted(p) => ("committed", Some(p.committed.frame), None, None),
        EngineReply::Refused(r) => ("refused", None, Some(r.code_name()), Some(r.to_string())),
        EngineReply::OutputConfigured { .. } => ("configured", None, None, None),
        EngineReply::Rendered(_) => ("rendered", None, None, None),
        _ => ("answered", None, None, None),
    };
    let event = event_name(note.kind);
    if note.is_read() {
        tracing::debug!(event, epoch, result, refusal, request = note.kind);
        return;
    }
    let take_id = note.take_id.as_deref();
    let content_hash = note.content_hash.as_deref();
    let at = note.at.as_deref();
    let phase = note.phase.as_deref();
    let output = note.output.as_deref();
    match refusal {
        Some(refusal) => tracing::info!(
            event,
            epoch,
            result,
            refusal,
            detail = detail.as_deref(),
            take_id,
            revision = note.revision,
            content_hash,
            at,
            phase,
            output,
        ),
        None => tracing::info!(
            event,
            epoch,
            frame,
            result,
            take_id,
            revision = note.revision,
            content_hash,
            at,
            phase,
            output,
        ),
    }
}

/// `program.take`, `output.configure`, ...: the stable event name of a request.
fn event_name(kind: &str) -> &'static str {
    match kind {
        "cue" => "program.cue",
        "take" => "program.take",
        "clear" => "program.clear",
        "phase" => "program.phase",
        "configureOutput" => "output.configure",
        "render" => "render.request",
        "capability" => "engine.capability",
        "status" => "engine.status",
        "performance" => "engine.performance",
        "authenticate" => "engine.authenticate",
        _ => "engine.request",
    }
}

/// Log a publish the asset plane handed over, and what came of it. A publish
/// that names the edits it holds (2.17) writes them as `carries`, the ids
/// comma-separated, so a search for an edit's id finds the publish that carried
/// it; a publish that names none writes no field.
pub(crate) fn publish(take_id: &str, reply: &PublishReply) {
    let carries = gx_telemetry::corr::carried_text();
    let carries = carries.as_deref();
    match reply {
        PublishReply::Published {
            take_id,
            revision,
            content_hash,
        } => tracing::info!(
            event = "publish.accepted",
            take_id = take_id.0.as_str(),
            revision = revision.0,
            content_hash = content_hash.0.as_str(),
            carries,
        ),
        PublishReply::Refused(refusal) => tracing::info!(
            event = "publish.refused",
            take_id,
            refusal = ?refusal,
            carries,
        ),
    }
}

/// Log a frame's anomalies: a frame rendered past its interval, and frames the
/// clock passed that were never emitted. A frame on time writes nothing.
pub(crate) fn frame(sample: &FrameSample, epoch: u64) {
    if sample.missed_before > 0 {
        tracing::warn!(
            event = "frame.missed",
            epoch,
            frame = sample.frame,
            missed = sample.missed_before,
        );
    }
    if sample.late {
        tracing::info!(
            event = "frame.late",
            epoch,
            frame = sample.frame,
            render_us = sample.render_nanos / 1_000,
            interval_us = sample.interval_nanos / 1_000,
        );
    }
}

/// 3.24: the load governor moved the level non-live work is shed at. Climbing is
/// a warning (Program was at risk); falling is info. Every shift has its reason.
pub(crate) fn load_shift(transition: &crate::governor::Transition, frame: u64, epoch: u64) {
    if transition.to > transition.from {
        tracing::warn!(
            event = "load.shift",
            epoch,
            frame,
            from = %transition.from,
            to = %transition.to,
            shed = transition.to.describes(),
            reason = %transition.reason,
        );
    } else {
        tracing::info!(
            event = "load.shift",
            epoch,
            frame,
            from = %transition.from,
            to = %transition.to,
            shed = transition.to.describes(),
            reason = %transition.reason,
        );
    }
}

/// The once-a-second record that the engine is running and how it is doing.
#[derive(Debug)]
pub(crate) struct Heartbeat {
    last: Option<Instant>,
    /// The clock source and reference the last heartbeat saw, so a change is
    /// on record (`clock.changed`) within a second of happening.
    clock: Option<(String, String)>,
}

/// How often the heartbeat is written (ADR-0004 §4, the user's decision).
pub(crate) const HEARTBEAT: Duration = Duration::from_secs(1);

/// The totals a heartbeat reports.
pub(crate) struct Totals {
    pub epoch: u64,
    pub frame: u64,
    pub rendered: u64,
    pub late: u64,
    pub missed: u64,
    pub dropped: u64,
    pub program: Option<String>,
    pub output_inhibited: bool,
    pub clock: String,
    pub reference: String,
}

impl Heartbeat {
    pub(crate) fn new() -> Self {
        Self {
            last: None,
            clock: None,
        }
    }

    /// Write a heartbeat if one is due at `now`; returns whether it wrote.
    pub(crate) fn beat(&mut self, now: Instant, totals: impl FnOnce() -> Totals) -> bool {
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < HEARTBEAT)
        {
            return false;
        }
        self.last = Some(now);
        let t = totals();
        tracing::info!(
            event = "engine.heartbeat",
            epoch = t.epoch,
            frame = t.frame,
            rendered = t.rendered,
            late = t.late,
            missed = t.missed,
            dropped = t.dropped,
            program = t.program.as_deref(),
            output_inhibited = t.output_inhibited,
            clock = t.clock.as_str(),
            reference = t.reference.as_str(),
        );
        let now_clock = (t.clock, t.reference);
        if let Some(before) = self.clock.as_ref().filter(|before| **before != now_clock) {
            tracing::info!(
                event = "clock.changed",
                epoch = t.epoch,
                frame = t.frame,
                from_clock = before.0.as_str(),
                to_clock = now_clock.0.as_str(),
                from_reference = before.1.as_str(),
                to_reference = now_clock.1.as_str(),
            );
        }
        self.clock = Some(now_clock);
        true
    }
}
