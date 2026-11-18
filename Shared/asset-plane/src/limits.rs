//! What the asset plane holds every connection to (build plan 2.22).
//!
//! A stalled or hostile peer costs the engine a bounded thread for a bounded
//! time, as on the control plane: a connection that sends nothing is dropped at
//! the first-frame deadline, a frame that begins must arrive whole, a peer that
//! does not read cannot hold a write for ever, the listener holds at most so
//! many connections, and a transfer is bounded in bytes as it arrives, not after
//! it has been assembled and hashed.
//!
//! Unlike a control connection, an asset connection is request and reply for the
//! length of one publish or one transfer (`AssetTransferClient` is scoped to
//! one), so a quiet one is dropped too, after `idle_deadline`.

use std::io::{self, Read};
use std::net::TcpStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::package::MAX_PACKAGE_BYTES;
use crate::preflight::ASSET_TRANSFER_CHUNK_BYTES;

/// The bounds an asset listener holds every connection to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetLimits {
    /// Connections held at once. One more is closed at once and logged.
    pub max_connections: usize,
    /// From accept to the first frame.
    pub first_frame_deadline: Duration,
    /// Between one request and the next on a connection that has begun.
    pub idle_deadline: Duration,
    /// Once a frame has begun, the time it has to arrive whole.
    pub frame_deadline: Duration,
    /// How long one write may wait for a peer that does not read.
    pub write_deadline: Duration,
    /// The most chunks one transfer may declare. A package is at most
    /// `MAX_PACKAGE_BYTES`, sent in chunks of `ASSET_TRANSFER_CHUNK_BYTES`.
    pub max_transfer_chunks: u32,
    /// The most chunk bytes one connection may send in all.
    pub max_connection_bytes: u64,
}

impl Default for AssetLimits {
    fn default() -> Self {
        let chunks = MAX_PACKAGE_BYTES / ASSET_TRANSFER_CHUNK_BYTES as u64;
        Self {
            max_connections: 16,
            first_frame_deadline: Duration::from_secs(10),
            idle_deadline: Duration::from_secs(60),
            // A publish frame may be tens of megabytes on a slow link.
            frame_deadline: Duration::from_secs(30),
            write_deadline: Duration::from_secs(10),
            max_transfer_chunks: u32::try_from(chunks).unwrap_or(u32::MAX),
            max_connection_bytes: MAX_PACKAGE_BYTES,
        }
    }
}

/// A place in the connection count, given back when the connection ends.
pub(crate) struct Permit(Arc<AtomicUsize>);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Take a place if fewer than `max` are held.
pub(crate) fn take_permit(held: &Arc<AtomicUsize>, max: usize) -> Option<Permit> {
    let mut now = held.load(Ordering::SeqCst);
    loop {
        if now >= max {
            return None;
        }
        match held.compare_exchange(now, now + 1, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return Some(Permit(Arc::clone(held))),
            Err(seen) => now = seen,
        }
    }
}

/// Apply the per-stream limits to an accepted stream. Returns what could not be
/// applied, by name: a limit that is not in force is never silently claimed.
pub(crate) fn configure(stream: &TcpStream, limits: &AssetLimits) -> Vec<String> {
    let mut problems = Vec::new();
    if let Err(error) = stream.set_nodelay(true) {
        problems.push(format!("low latency: {error}"));
    }
    if let Err(error) = stream.set_write_timeout(Some(limits.write_deadline)) {
        problems.push(format!("write deadline: {error}"));
    }
    problems
}

/// The shortest read deadline set: a zero timeout is an error to the system.
const SHORTEST_DEADLINE: Duration = Duration::from_millis(1);

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

fn late(deadline: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("a frame that had begun did not arrive within {deadline:?}"),
    )
}

/// Read until `buffer` is full, all of it within `deadline` of `started`.
fn read_exact_by(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    started: Instant,
    deadline: Duration,
) -> io::Result<()> {
    let mut filled = 0;
    while filled < buffer.len() {
        let left = deadline
            .checked_sub(started.elapsed())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| late(deadline))?;
        stream.set_read_timeout(Some(left.max(SHORTEST_DEADLINE)))?;
        match stream.read(&mut buffer[filled..]) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if is_timeout(&error) => return Err(late(deadline)),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// A frame whose length prefix has been read, and when it began.
pub(crate) struct FrameStart {
    /// The length the peer declared. Not yet checked against any maximum:
    /// that is the caller's, before it allocates.
    pub(crate) length: usize,
    started: Instant,
}

/// Wait up to `first` for a frame's first byte, then read the rest of its length
/// prefix within `frame`. `None` is a clean end of the stream between frames.
pub(crate) fn read_frame_start(
    stream: &mut TcpStream,
    first: Duration,
    frame: Duration,
) -> io::Result<Option<FrameStart>> {
    stream.set_read_timeout(Some(first.max(SHORTEST_DEADLINE)))?;
    let mut one = [0u8; 1];
    loop {
        match stream.read(&mut one) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if is_timeout(&error) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("no request arrived within {first:?}"),
                ))
            }
            Err(error) => return Err(error),
        }
    }
    let started = Instant::now();
    let mut prefix = [0u8; 4];
    prefix[0] = one[0];
    read_exact_by(stream, &mut prefix[1..], started, frame)?;
    Ok(Some(FrameStart {
        length: u32::from_be_bytes(prefix) as usize,
        started,
    }))
}

/// The body of a frame whose prefix [`read_frame_start`] read, within the rest of
/// the frame's time. The caller has checked `start.length` against its maximum.
pub(crate) fn read_frame_body(
    stream: &mut TcpStream,
    start: &FrameStart,
    frame: Duration,
) -> io::Result<Vec<u8>> {
    let mut body = vec![0u8; start.length];
    read_exact_by(stream, &mut body, start.started, frame)?;
    Ok(body)
}
