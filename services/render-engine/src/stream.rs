//! Preview streaming.
//!
//! `preview.request` renders one frame per request, which is right for a still but wrong
//! for watching an animation: every frame costs a round trip and the client has to guess
//! the interval. A stream lets the engine own the cadence.
//!
//! Design decisions worth stating, because each is a place this could go wrong:
//!
//! - **Per-client delivery.** A preview frame is a JPEG of tens or hundreds of
//!   kilobytes, requested by one client for its own viewport. Broadcasting it to every
//!   connection would push Editor previews at Playout, which never asked. Frames are
//!   addressed to the subscriber and filtered at the socket.
//!
//! - **Never at the expense of Program.** The stream loop is bounded by
//!   `preview.max_stream_fps` and skips a tick it cannot serve rather than queueing.
//!   Program has an absolute deadline; a preview does not.
//!
//! - **A dropped frame is dropped, not buffered.** Falling behind on a preview must not
//!   grow memory. The tick is skipped and counted.
//!
//! - **The pixel budget still applies.** The same `resolve_source` check as a one-off
//!   preview: a stream cannot ask for the full 50,000² stage any more than a still can.
//!
//! - **Streams die with their client.** A stream whose subscriber has gone is stopped
//!   when the socket closes, so a reconnecting Editor cannot accumulate them.

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::engine::Engine;

/// How often the loop wakes when no stream is running.
const IDLE_POLL_MS: u64 = 250;

/// A registered stream.
#[derive(Debug, Clone)]
pub struct PreviewStream {
    pub stream_id: String,
    /// The client that asked for it. Frames go only here.
    pub client_id: String,
    pub channel: String,
    pub source: serde_json::Value,
    pub encoding: String,
    pub quality: u8,
    pub target_fps: f64,
    pub show_tile_debug: bool,
    /// Monotonic frame counter for this stream, not the scene's frame.
    pub frames_sent: u64,
    pub frames_skipped: u64,
    /// Wall-clock milliseconds when the next frame is due.
    pub next_due_ms: u64,
    pub last_error: Option<String>,
}

impl PreviewStream {
    pub fn interval_ms(&self) -> u64 {
        if self.target_fps <= 0.0 {
            return 1_000;
        }
        // At least 1 ms, so a nonsense target cannot become a spin loop.
        ((1_000.0 / self.target_fps).round() as u64).max(1)
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "streamId": self.stream_id,
            "clientId": self.client_id,
            "channel": self.channel,
            "encoding": self.encoding,
            "targetFps": self.target_fps,
            "framesSent": self.frames_sent,
            "framesSkipped": self.frames_skipped,
            "lastError": self.last_error,
        })
    }
}

/// Drives every registered preview stream.
///
/// One task for all streams rather than one per stream: a stream is cheap to represent
/// and the GPU is the contended resource, so serialising them is both simpler and
/// closer to what the hardware can actually do.
pub struct PreviewStreamer {
    engine: Arc<Mutex<Engine>>,
}

impl PreviewStreamer {
    pub fn new(engine: Arc<Mutex<Engine>>) -> Self {
        Self { engine }
    }

    pub async fn run(self) {
        loop {
            let (has_streams, next_wait_ms) = {
                let guard = self.engine.lock().await;
                (guard.has_preview_streams(), guard.next_stream_wait_ms())
            };

            if !has_streams {
                tokio::time::sleep(std::time::Duration::from_millis(IDLE_POLL_MS)).await;
                continue;
            }

            if next_wait_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(next_wait_ms.min(IDLE_POLL_MS)))
                    .await;
                continue;
            }

            // The render is synchronous GPU work, so it goes off the async runtime. A
            // preview must never block the protocol server: an operator has to be able
            // to take something off air while a preview is rendering.
            let engine = Arc::clone(&self.engine);
            let outcome = tokio::task::spawn_blocking(move || {
                let mut guard = engine.blocking_lock();
                guard.render_due_preview_streams()
            })
            .await;

            match outcome {
                Ok(rendered) => {
                    if rendered == 0 {
                        // Nothing was due after all, or every due stream failed. Yield
                        // rather than spinning.
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                }
                Err(join_error) => {
                    tracing::error!(%join_error, "preview stream task panicked");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    }
}
