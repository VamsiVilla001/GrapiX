//! The structured log sink (build plan 2.11, ADR-0004).
//!
//! Every process writes one JSON Lines file under the log root, one event per
//! line, in the schema ADR-0004 fixes: `ts` (UTC, RFC 3339, microseconds),
//! `mono` (nanoseconds since the sink started), `seq` (per process, from 1),
//! `process`, `pid`, `version`, `level`, `target`, `event`, and, when the event
//! names them, `corr`, `epoch` and `frame`, then the event's other `fields`.
//!
//! **The caller never waits.** An event is numbered and offered to a bounded
//! queue; if the queue is full it is not written, and nothing else happens on
//! the calling thread. One writer thread drains the queue to disk. The writer
//! sees every gap in `seq` and writes a `log.lost` record stating exactly
//! which numbers were not written, so a loss is itself on record and the file
//! never has an unexplained hole (ADR-0004 §3). Dropping the [`LogGuard`]
//! drains what is queued and flushes, so a clean exit loses nothing.
//!
//! **Files rotate by size** (`<process>-<UTC start>-<pid>-<part>.jsonl`) and
//! files older than the retention period are removed when a sink starts. The
//! as-run log (12.11) is not written here: it is synced per record and lives
//! in its own directory, which this sweep never touches.
//!
//! Credentials never reach a line: a field is rendered through `tracing`'s
//! own formatting, and [`crate::Redacted`] renders only its marker.

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tracing::field::{Field as TracingField, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// How a sink is set up. [`LogConfig::new`] gives the ADR-0004 defaults.
#[derive(Debug, Clone)]
pub struct LogConfig {
    /// The product this process belongs to (`engine`, `editor`, `playout`,
    /// `mcp`): its files go in `<directory>/<product>/`.
    pub product: String,
    /// This process's name in its file names and in every line.
    pub process: String,
    /// The log root, normally `gx_contracts::platform::log_root()`.
    pub directory: PathBuf,
    /// Events the queue holds before new ones are not written.
    pub queue: usize,
    /// A file is closed and the next part opened once it reaches this size.
    pub max_file_bytes: u64,
    /// Files older than this are removed when a sink starts.
    pub retention: Duration,
    /// Test only: hold the writer this long per line, to make it slower than
    /// its callers.
    #[cfg(test)]
    pub(crate) writer_delay: Option<Duration>,
}

/// ADR-0004 §7: 50 MB files, kept 30 days.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const DEFAULT_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
pub const DEFAULT_QUEUE: usize = 65_536;

impl LogConfig {
    pub fn new(product: &str, process: &str, directory: impl Into<PathBuf>) -> Self {
        Self {
            product: product.to_owned(),
            process: process.to_owned(),
            directory: directory.into(),
            queue: DEFAULT_QUEUE,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            retention: DEFAULT_RETENTION,
            #[cfg(test)]
            writer_delay: None,
        }
    }
}

/// What the layer hands the writer: one event, already numbered and rendered.
struct Line {
    seq: u64,
    json: String,
}

/// What reaches the writer: a line, or the guard telling it to finish.
enum Msg {
    Line(Line),
    /// Write what is queued, state any loss, write `log.stop`, flush, end.
    /// Explicit because a globally installed subscriber keeps a sender alive
    /// for the life of the process, so the queue never closes by itself.
    Stop,
}

struct Shared {
    process: String,
    pid: u32,
    started: Instant,
    /// The last number handed out; the writer reads it at shutdown to state a
    /// loss at the very end of the file.
    issued: AtomicU64,
}

/// The `tracing` layer that turns each event into a line of the schema and
/// offers it to the queue. Cloning it shares the queue and the numbering.
#[derive(Clone)]
pub struct JsonLayer {
    shared: Arc<Shared>,
    /// Only layers and the guard hold senders, never the writer.
    sender: SyncSender<Msg>,
}

/// Keeps the writer running. Dropping it drains the queue, writes any final
/// `log.lost`, flushes and joins the writer.
pub struct LogGuard {
    layer: Option<JsonLayer>,
    stop: SyncSender<Msg>,
    writer: Option<JoinHandle<io::Result<()>>>,
    directory: PathBuf,
}

impl LogGuard {
    /// The layer to install in a subscriber.
    pub fn layer(&self) -> JsonLayer {
        self.layer
            .clone()
            .expect("the layer lives as long as the guard")
    }

    /// The directory this process's files are written into.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Stop: drain, state any final loss, flush, and report a write failure.
    pub fn finish(mut self) -> io::Result<()> {
        self.stop()
    }

    fn stop(&mut self) -> io::Result<()> {
        self.layer.take();
        let Some(writer) = self.writer.take() else {
            return Ok(());
        };
        // A blocking send: the writer is draining, so there is room soon, and
        // at shutdown waiting is right. A writer that already ended has
        // dropped its receiver, and the join below reports why.
        let _ = self.stop.send(Msg::Stop);
        writer
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("the log writer thread panicked")))
    }
}

impl Drop for LogGuard {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            // Nowhere left to log it but stderr.
            eprintln!("log sink: the last lines could not be written: {error}");
        }
    }
}

/// Start a sink: create the product directory, remove expired files, open
/// the first part and start the writer.
pub fn start(config: LogConfig) -> io::Result<LogGuard> {
    let directory = config.directory.join(&config.product);
    std::fs::create_dir_all(&directory)?;
    let expired = remove_expired(&directory, config.retention);
    let (sender, receiver) = sync_channel(config.queue.max(1));
    let started = Instant::now();
    let shared = Arc::new(Shared {
        process: config.process.clone(),
        pid: std::process::id(),
        started,
        issued: AtomicU64::new(0),
    });
    let stem = format!(
        "{}-{}-{}",
        config.process,
        compact_utc(SystemTime::now()),
        std::process::id()
    );
    let mut files = Files {
        directory: directory.clone(),
        stem,
        part: 0,
        max_bytes: config.max_file_bytes.max(1),
        written: 0,
        file: None,
    };
    files.next()?;
    let writer_shared = Arc::clone(&shared);
    #[cfg(test)]
    let delay = config.writer_delay;
    #[cfg(not(test))]
    let delay: Option<Duration> = None;
    let writer = std::thread::Builder::new()
        .name(format!("gx-log-{}", config.process))
        .spawn(move || write_loop(receiver, files, &writer_shared, delay))?;
    let layer = JsonLayer {
        shared: Arc::clone(&shared),
        sender,
    };
    // The first record says what this file is; the second, what was swept.
    layer.offer(
        tracing::Level::INFO,
        "gx_telemetry::sink",
        "log.start",
        Map::from_iter([
            ("product".to_owned(), Value::from(config.product.clone())),
            (
                "directory".to_owned(),
                Value::from(directory.display().to_string()),
            ),
        ]),
    );
    if expired > 0 {
        layer.offer(
            tracing::Level::INFO,
            "gx_telemetry::sink",
            "log.expired",
            Map::from_iter([("files".to_owned(), Value::from(expired))]),
        );
    }
    Ok(LogGuard {
        stop: layer.sender.clone(),
        layer: Some(layer),
        writer: Some(writer),
        directory,
    })
}

/// Start a sink and install it as this process's subscriber, with the filter
/// from `GX_LOG` (or `RUST_LOG`), default `info` (ADR-0004 §4, the user's
/// decision: every state change and anomaly at info).
///
/// Refuses if a subscriber is already installed: the sink would then receive
/// nothing, and a process that believes it logs while writing an empty file
/// is the silent gap this sink exists to prevent. Call it first, at start.
pub fn init_logging(config: LogConfig) -> io::Result<LogGuard> {
    use tracing_subscriber::layer::SubscriberExt;
    let guard = start(config)?;
    let filter = std::env::var("GX_LOG")
        .ok()
        .and_then(|value| tracing_subscriber::EnvFilter::try_new(value).ok())
        .or_else(|| tracing_subscriber::EnvFilter::try_from_default_env().ok())
        .unwrap_or_else(|| tracing_subscriber::EnvFilter::new("info"));
    let subscriber = tracing_subscriber::registry()
        .with(filter)
        .with(guard.layer());
    tracing::subscriber::set_global_default(subscriber).map_err(|_| {
        io::Error::other(
            "a tracing subscriber is already installed, so the log sink would receive nothing",
        )
    })?;
    Ok(guard)
}

impl JsonLayer {
    /// Number one event and offer it to the queue; never waits.
    fn offer(
        &self,
        level: tracing::Level,
        target: &str,
        event: &str,
        mut fields: Map<String, Value>,
    ) {
        let seq = self.shared.issued.fetch_add(1, Ordering::SeqCst) + 1;
        let mut line = Map::new();
        line.insert("ts".into(), Value::from(rfc3339_utc(SystemTime::now())));
        line.insert(
            "mono".into(),
            Value::from(
                u64::try_from(self.shared.started.elapsed().as_nanos()).unwrap_or(u64::MAX),
            ),
        );
        line.insert("seq".into(), Value::from(seq));
        line.insert("process".into(), Value::from(self.shared.process.clone()));
        line.insert("pid".into(), Value::from(self.shared.pid));
        line.insert("version".into(), Value::from(env!("CARGO_PKG_VERSION")));
        line.insert(
            "level".into(),
            Value::from(level.as_str().to_ascii_lowercase()),
        );
        line.insert("target".into(), Value::from(target));
        line.insert("event".into(), Value::from(event));
        for key in ["corr", "epoch", "frame", "refusal"] {
            if let Some(value) = fields.remove(key) {
                line.insert(key.into(), value);
            }
        }
        line.insert("fields".into(), Value::Object(fields));
        let json = Value::Object(line).to_string();
        match self.sender.try_send(Msg::Line(Line { seq, json })) {
            Ok(()) | Err(TrySendError::Disconnected(_)) => {}
            // Not written; the writer will see the gap in `seq` and say so.
            Err(TrySendError::Full(_)) => {}
        }
    }
}

/// Collects an event's fields as JSON values.
#[derive(Default)]
struct Fields {
    map: Map<String, Value>,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &TracingField, value: &dyn std::fmt::Debug) {
        self.map
            .insert(field.name().to_owned(), Value::from(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &TracingField, value: &str) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }
    fn record_i64(&mut self, field: &TracingField, value: i64) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }
    fn record_u64(&mut self, field: &TracingField, value: u64) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }
    fn record_f64(&mut self, field: &TracingField, value: f64) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }
    fn record_bool(&mut self, field: &TracingField, value: bool) {
        self.map.insert(field.name().to_owned(), Value::from(value));
    }
}

impl<S: Subscriber> Layer<S> for JsonLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let mut map = fields.map;
        // The event's name is its `event` field; an event that has none (a
        // dependency's own message) is named by its target and keeps its
        // message as a field.
        let name = match map.remove("event") {
            Some(Value::String(name)) => name,
            Some(other) => other.to_string(),
            None => format!("{}.message", event.metadata().target()),
        };
        self.offer(
            *event.metadata().level(),
            event.metadata().target(),
            &name,
            map,
        );
    }
}

/// The files of one process, rotated by size.
struct Files {
    directory: PathBuf,
    stem: String,
    part: u32,
    max_bytes: u64,
    written: u64,
    file: Option<BufWriter<File>>,
}

impl Files {
    fn next(&mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
        }
        self.part += 1;
        let path = self
            .directory
            .join(format!("{}-{}.jsonl", self.stem, self.part));
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        self.file = Some(BufWriter::new(file));
        self.written = 0;
        Ok(())
    }

    fn write_line(&mut self, json: &str) -> io::Result<()> {
        if self.written > 0 && self.written + json.len() as u64 + 1 > self.max_bytes {
            self.next()?;
        }
        let file = self.file.as_mut().expect("a file is open");
        file.write_all(json.as_bytes())?;
        file.write_all(b"\n")?;
        self.written += json.len() as u64 + 1;
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

/// The record that states which numbers were not written. It has no `seq` of
/// its own: it describes the gap rather than taking a place in it.
fn lost_line(shared: &Shared, from: u64, to: u64) -> String {
    let fields = Map::from_iter([
        ("count".to_owned(), Value::from(to - from + 1)),
        ("fromSeq".to_owned(), Value::from(from)),
        ("toSeq".to_owned(), Value::from(to)),
    ]);
    Value::Object(Map::from_iter([
        ("ts".to_owned(), Value::from(rfc3339_utc(SystemTime::now()))),
        (
            "mono".to_owned(),
            Value::from(u64::try_from(shared.started.elapsed().as_nanos()).unwrap_or(u64::MAX)),
        ),
        ("seq".to_owned(), Value::Null),
        ("process".to_owned(), Value::from(shared.process.clone())),
        ("pid".to_owned(), Value::from(shared.pid)),
        ("version".to_owned(), Value::from(env!("CARGO_PKG_VERSION"))),
        ("level".to_owned(), Value::from("warn")),
        ("target".to_owned(), Value::from("gx_telemetry::sink")),
        ("event".to_owned(), Value::from("log.lost")),
        ("fields".to_owned(), Value::Object(fields)),
    ]))
    .to_string()
}

/// The last record of a run: the sink stopped, after the line numbered `last`.
fn stop_line(shared: &Shared, last: u64) -> String {
    Value::Object(Map::from_iter([
        ("ts".to_owned(), Value::from(rfc3339_utc(SystemTime::now()))),
        (
            "mono".to_owned(),
            Value::from(u64::try_from(shared.started.elapsed().as_nanos()).unwrap_or(u64::MAX)),
        ),
        ("seq".to_owned(), Value::Null),
        ("process".to_owned(), Value::from(shared.process.clone())),
        ("pid".to_owned(), Value::from(shared.pid)),
        ("version".to_owned(), Value::from(env!("CARGO_PKG_VERSION"))),
        ("level".to_owned(), Value::from("info")),
        ("target".to_owned(), Value::from("gx_telemetry::sink")),
        ("event".to_owned(), Value::from("log.stop")),
        (
            "fields".to_owned(),
            Value::Object(Map::from_iter([("lastSeq".to_owned(), Value::from(last))])),
        ),
    ]))
    .to_string()
}

fn write_loop(
    receiver: Receiver<Msg>,
    mut files: Files,
    shared: &Shared,
    delay: Option<Duration>,
) -> io::Result<()> {
    let mut last = 0u64;
    let write = |files: &mut Files, line: Line, last: &mut u64| -> io::Result<()> {
        if line.seq > *last + 1 {
            files.write_line(&lost_line(shared, *last + 1, line.seq - 1))?;
        }
        files.write_line(&line.json)?;
        *last = line.seq;
        if let Some(delay) = delay {
            std::thread::sleep(delay);
        }
        Ok(())
    };
    // Block for the next message, then take whatever else is waiting before
    // flushing, so a burst is one flush and a quiet log is flushed at once.
    let mut stopping = false;
    while !stopping {
        let Ok(first) = receiver.recv() else {
            break;
        };
        let mut next = Some(first);
        while let Some(message) = next.take().or_else(|| receiver.try_recv().ok()) {
            match message {
                Msg::Line(line) => write(&mut files, line, &mut last)?,
                // Keep draining what is already queued, then end.
                Msg::Stop => stopping = true,
            }
        }
        files.flush()?;
    }
    // Stopped, or every sender is gone. Anything numbered after the last line
    // written was not written.
    let issued = shared.issued.load(Ordering::SeqCst);
    if issued > last {
        files.write_line(&lost_line(shared, last + 1, issued))?;
    }
    files.write_line(&stop_line(shared, last))?;
    files.flush()
}

/// Remove `.jsonl` files in `directory` last modified before the retention
/// period; returns how many. Unreadable entries are left alone.
fn remove_expired(directory: &Path, retention: Duration) -> u64 {
    let Some(cutoff) = SystemTime::now().checked_sub(retention) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|modified| modified < cutoff);
        if old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn parts(time: SystemTime) -> (i64, u32, u32, u64, u64, u64, u32) {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (year, month, day) = civil((secs / 86_400) as i64);
    let rem = secs % 86_400;
    (
        year,
        month,
        day,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        since.subsec_micros(),
    )
}

/// `2026-11-16T11:41:05.123456Z`.
pub fn rfc3339_utc(time: SystemTime) -> String {
    let (y, mo, d, h, mi, s, us) = parts(time);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{us:06}Z")
}

/// `20261116T114105Z`, for file names.
fn compact_utc(time: SystemTime) -> String {
    let (y, mo, d, h, mi, s, _) = parts(time);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    fn scratch(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("gx-sink-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lines(directory: &Path) -> Vec<Value> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(directory)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
            .collect();
        // Parts in order: the part number is the last dash-separated field.
        files.sort_by_key(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.rsplit('-').next())
                .and_then(|n| n.parse::<u32>().ok())
                .unwrap_or(0)
        });
        files
            .iter()
            .flat_map(|path| {
                std::fs::read_to_string(path)
                    .unwrap()
                    .lines()
                    .map(|line| {
                        serde_json::from_str::<Value>(line)
                            .unwrap_or_else(|e| panic!("a line that is not JSON: {e}: {line}"))
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Every number from 1 to the highest issued is either a written line or
    /// inside exactly one `log.lost` range, and nothing else is.
    fn accounted(records: &[Value]) -> (u64, u64, u64) {
        let mut written = std::collections::BTreeSet::new();
        let mut lost = 0u64;
        let mut covered = std::collections::BTreeSet::new();
        for r in records {
            if r["event"] == "log.stop" {
                continue;
            }
            if r["event"] == "log.lost" {
                let (from, to) = (
                    r["fields"]["fromSeq"].as_u64().unwrap(),
                    r["fields"]["toSeq"].as_u64().unwrap(),
                );
                assert_eq!(r["fields"]["count"].as_u64().unwrap(), to - from + 1);
                assert!(r["seq"].is_null());
                for s in from..=to {
                    assert!(covered.insert(s), "seq {s} stated lost twice");
                }
                lost += to - from + 1;
            } else {
                let s = r["seq"].as_u64().expect("a numbered line");
                assert!(written.insert(s), "seq {s} written twice");
            }
        }
        let max = written.iter().chain(&covered).max().copied().unwrap_or(0);
        for s in 1..=max {
            assert!(
                written.contains(&s) != covered.contains(&s),
                "seq {s} is neither written nor stated lost, or both"
            );
        }
        (written.len() as u64, lost, max)
    }

    #[test]
    fn a_flood_never_makes_the_caller_wait_and_every_loss_is_stated() {
        let dir = scratch("flood");
        let mut config = LogConfig::new("engine", "worker", &dir);
        config.queue = 32;
        // The writer takes 1 ms a line: 5,000 events would take 5 s to write,
        // so a caller that waited for the writer would take that long too.
        config.writer_delay = Some(Duration::from_millis(1));
        let guard = start(config).unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        let mut slowest = Duration::ZERO;
        let started = Instant::now();
        tracing::subscriber::with_default(subscriber, || {
            for frame in 0..5_000u64 {
                let before = Instant::now();
                tracing::info!(event = "frame.late", frame, late_us = 1_200u64);
                slowest = slowest.max(before.elapsed());
            }
        });
        let emitting = started.elapsed();
        guard.finish().unwrap();
        assert!(
            emitting < Duration::from_millis(1_500),
            "5,000 events took {emitting:?}: the caller waited for the writer"
        );
        assert!(
            slowest < Duration::from_millis(50),
            "one event took {slowest:?}"
        );
        let records = lines(&dir.join("engine"));
        for record in &records {
            for key in [
                "ts", "mono", "process", "pid", "version", "level", "target", "event", "fields",
            ] {
                assert!(!record[key].is_null(), "{key} missing: {record}");
            }
            assert!(record.get("seq").is_some(), "seq missing: {record}");
        }
        let (written, lost, max) = accounted(&records);
        assert!(lost > 0, "the flood was meant to overflow a 32-event queue");
        assert_eq!(written + lost, max, "every number accounted for");
        assert_eq!(max, 5_001, "log.start plus 5,000 events");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_line_carries_the_schema_and_never_a_credential() {
        let dir = scratch("schema");
        let guard = start(LogConfig::new("playout", "shell", &dir)).unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        let token = crate::Redacted::new("gx1.secret-token-value");
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(
                event = "playout.connect",
                corr = "c-41",
                epoch = 7u64,
                frame = 1250u64,
                endpoint = "127.0.0.1:4177",
                token = %token,
            );
            tracing::warn!("a dependency's plain message");
        });
        guard.finish().unwrap();
        let text = std::fs::read_dir(dir.join("playout"))
            .unwrap()
            .flatten()
            .map(|e| std::fs::read_to_string(e.path()).unwrap())
            .collect::<String>();
        assert!(
            !text.contains("secret-token-value"),
            "a credential reached the log"
        );
        let records = lines(&dir.join("playout"));
        let connect = records
            .iter()
            .find(|r| r["event"] == "playout.connect")
            .expect("the event was written");
        for key in [
            "ts", "mono", "seq", "process", "pid", "version", "level", "target", "event", "fields",
        ] {
            assert!(!connect[key].is_null(), "{key} missing: {connect}");
        }
        let ts = connect["ts"].as_str().unwrap();
        assert!(
            ts.len() == 27 && ts.ends_with('Z') && &ts[10..11] == "T",
            "{ts}"
        );
        assert_eq!(connect["process"], "shell");
        assert_eq!(connect["level"], "info");
        assert_eq!(connect["corr"], "c-41");
        assert_eq!(connect["epoch"], 7);
        assert_eq!(connect["frame"], 1250);
        assert_eq!(connect["fields"]["endpoint"], "127.0.0.1:4177");
        assert_eq!(connect["fields"]["token"], crate::REDACTION_MARKER);
        assert_eq!(
            records[0]["event"], "log.start",
            "the file says what it is first"
        );
        let plain = records
            .iter()
            .find(|r| r["level"] == "warn")
            .expect("the plain message was written");
        assert!(plain["event"].as_str().unwrap().ends_with(".message"));
        assert_eq!(plain["fields"]["message"], "a dependency's plain message");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn files_rotate_by_size_and_the_numbering_runs_on() {
        let dir = scratch("rotate");
        let mut config = LogConfig::new("editor", "shell", &dir);
        config.max_file_bytes = 4_096;
        let guard = start(config).unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        tracing::subscriber::with_default(subscriber, || {
            for i in 0..400u64 {
                tracing::info!(event = "edit.applied", batch = i, command = "editScene");
            }
        });
        guard.finish().unwrap();
        let parts = std::fs::read_dir(dir.join("editor")).unwrap().count();
        assert!(parts > 5, "400 lines over 4 KB files made {parts} files");
        for entry in std::fs::read_dir(dir.join("editor")).unwrap().flatten() {
            assert!(
                entry.metadata().unwrap().len() <= 4_096 + 512,
                "a part ran over its size"
            );
        }
        let records = lines(&dir.join("editor"));
        let (written, lost, max) = accounted(&records);
        assert_eq!((written, lost, max), (401, 0, 401));
        let seqs: Vec<u64> = records.iter().filter_map(|r| r["seq"].as_u64()).collect();
        assert!(
            seqs.windows(2).all(|w| w[1] == w[0] + 1),
            "parts read in order run 1, 2, 3..."
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn expired_files_are_removed_at_start_and_others_kept() {
        let dir = scratch("retention");
        let product = dir.join("engine");
        std::fs::create_dir_all(&product).unwrap();
        let old = product.join("worker-20261001T000000Z-1-1.jsonl");
        let recent = product.join("worker-20261115T000000Z-2-1.jsonl");
        let other = product.join("notes.txt");
        for path in [&old, &recent, &other] {
            std::fs::write(path, b"{}\n").unwrap();
        }
        let month_ago = SystemTime::now() - Duration::from_secs(31 * 24 * 60 * 60);
        for path in [&old, &other] {
            File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(month_ago)
                .unwrap();
        }
        let guard = start(LogConfig::new("engine", "worker", &dir)).unwrap();
        guard.finish().unwrap();
        assert!(!old.exists(), "a 31-day-old log was kept");
        assert!(recent.exists(), "a recent log was removed");
        assert!(other.exists(), "a file that is not a log was removed");
        let records = lines(&product);
        assert!(
            records
                .iter()
                .any(|r| r["event"] == "log.expired" && r["fields"]["files"] == 1),
            "the sweep is on record"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn finishing_returns_while_a_subscriber_still_holds_the_layer() {
        // `init_logging` installs a global subscriber that holds a layer for
        // the life of the process. Finishing must not wait for it to go.
        let dir = scratch("outlive");
        let guard = start(LogConfig::new("engine", "host", &dir)).unwrap();
        let held = guard.layer();
        let subscriber = tracing_subscriber::registry().with(held.clone());
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(event = "engine.start", adapter = "test");
        });
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(guard.finish());
        });
        let result = finished
            .recv_timeout(Duration::from_secs(10))
            .expect("finish returned while a layer was still held");
        result.unwrap();
        let records = lines(&dir.join("engine"));
        assert_eq!(records.last().unwrap()["event"], "log.stop");
        assert_eq!(records.last().unwrap()["fields"]["lastSeq"], 2);
        assert!(records.iter().any(|r| r["event"] == "engine.start"));
        // A late event from the held layer is not written and does not hang.
        let late = tracing_subscriber::registry().with(held);
        tracing::subscriber::with_default(late, || {
            tracing::info!(event = "engine.late");
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn utc_time_is_formatted_from_the_epoch() {
        let t = UNIX_EPOCH + Duration::from_micros(1_794_829_265_123_456);
        assert_eq!(rfc3339_utc(t), "2026-11-16T11:41:05.123456Z");
        assert_eq!(compact_utc(t), "20261116T114105Z");
        assert_eq!(rfc3339_utc(UNIX_EPOCH), "1970-01-01T00:00:00.000000Z");
        // A leap day.
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(rfc3339_utc(leap), "2000-02-29T00:00:00.000000Z");
    }
}
