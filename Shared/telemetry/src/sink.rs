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
    /// Held while a record takes its number and is offered to the queue
    /// (2.25), so the queue receives records in the order of their numbers.
    /// Without it two threads could number 48 and 49 and queue 49 first; the
    /// writer then stated 48 lost and wrote it after.
    order: std::sync::Mutex<()>,
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
        order: std::sync::Mutex::new(()),
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
    // 2.16: looked for once this process's own file exists and is held, so that
    // two runs starting at the same moment each see the other's (and list it as
    // running); its own file is passed over by name.
    let earlier = find_earlier(&directory, &config.process, &files.stem);
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
    // The first record says what this file is, and which runs of this process
    // were still running when it started (2.16: what a later start reads to know
    // which kills no start has named yet); the second, what was swept.
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
            ("running".to_owned(), Value::from(earlier.running)),
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
    for found in earlier.unfinished {
        layer.offer(
            tracing::Level::WARN,
            "gx_telemetry::sink",
            "log.previous_unfinished",
            found.into_fields(),
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

/// Where logs go: `GX_LOG_DIR` when it is set (tests, the conformance
/// harness, an operator who wants logs on another drive), otherwise the
/// platform log root (`gx_contracts::platform::log_root`).
pub fn log_directory() -> io::Result<PathBuf> {
    if let Some(dir) = std::env::var_os("GX_LOG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    gx_contracts::platform::log_root().map_err(|refusal| io::Error::other(refusal.to_string()))
}

/// Start this process's log and install it, or say on stderr why not and
/// carry on: a logging fault never stops a product, and never takes a graphic
/// off air (ADR-0004, user decision 16 Nov 2026).
pub fn init_process_logging(product: &str, process: &str) -> Option<LogGuard> {
    let started = log_directory()
        .and_then(|directory| init_logging(LogConfig::new(product, process, directory)));
    match started {
        Ok(guard) => Some(guard),
        Err(error) => {
            eprintln!("{product} {process}: the log could not be started ({error}); running without a log file");
            None
        }
    }
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
        let mut line = Map::new();
        line.insert("ts".into(), Value::from(rfc3339_utc(SystemTime::now())));
        line.insert(
            "mono".into(),
            Value::from(
                u64::try_from(self.shared.started.elapsed().as_nanos()).unwrap_or(u64::MAX),
            ),
        );
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
        // A record that does not name its own action belongs to the one this
        // thread is working for, if a scope is entered (2.13).
        if !line.contains_key("corr") {
            if let Some(id) = crate::corr::current() {
                line.insert("corr".into(), Value::from(id));
            }
        }
        line.insert("fields".into(), Value::Object(fields));
        // 2.25: number, render and offer under one short lock, never waiting on
        // the queue itself (try_send), so a full queue still drops rather than
        // blocks, and the dropped number is a gap the writer states.
        let _in_order = self
            .shared
            .order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = self.shared.issued.fetch_add(1, Ordering::SeqCst) + 1;
        line.insert("seq".into(), Value::from(seq));
        #[cfg(test)]
        tests::between_number_and_queue(Arc::as_ptr(&self.shared) as usize, seq);
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
        let file = open_as_writer(&path)?;
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

/// What a start found among the earlier runs of its process (2.16).
#[derive(Debug, Default)]
struct Earlier {
    /// Runs that are gone without `log.stop` and that no earlier start can have
    /// named, oldest first: one `log.previous_unfinished` each.
    unfinished: Vec<Unfinished>,
    /// Runs still holding their file, as `<process>-<start>-<pid>`, oldest first:
    /// this start's `log.start` lists them as `running`.
    running: Vec<String>,
}

/// One earlier run's files: the first part (which opens with its `log.start`)
/// and the last (which says how it ended).
#[derive(Debug, Default)]
struct Run {
    first: Option<(u32, PathBuf)>,
    last: Option<(u32, PathBuf)>,
}

/// What the first line of a run says about its own start.
enum Head {
    /// A `log.start` with `running`: the runs it found still running (2.16 on).
    Listed(Vec<String>),
    /// A `log.start` without the list: written before 2.16.
    Unlisted,
    /// No whole first line, or not a `log.start`: killed before it wrote one,
    /// or its first part was removed by the retention sweep.
    Missing,
}

/// The first line of `path`, as a [`Head`].
fn head(path: &Path) -> Head {
    use std::io::{BufRead, BufReader, Read};
    let Ok(file) = File::open(path) else {
        return Head::Missing;
    };
    // A first line cut off by a kill is not whole JSON, so it does not parse.
    let mut line = String::new();
    if BufReader::new(file.take(64 * 1024))
        .read_line(&mut line)
        .is_err()
    {
        return Head::Missing;
    }
    let Ok(record) = serde_json::from_str::<Value>(&line) else {
        return Head::Missing;
    };
    if record["event"] != "log.start" {
        return Head::Missing;
    }
    match record["fields"]["running"].as_array() {
        Some(names) => Head::Listed(
            names
                .iter()
                .filter_map(|name| name.as_str().map(str::to_owned))
                .collect(),
        ),
        None => Head::Unlisted,
    }
}

/// An earlier run of this process whose last file does not end in `log.stop`,
/// and which is not still running (2.16).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Unfinished {
    /// The run's last file, by name.
    file: String,
    /// The run's start, as it is in the file name (`20261116T114105Z`).
    started: String,
    pid: u32,
    /// What the file's last whole record says; `None` for a file with none.
    last_seq: Option<u64>,
    last_ts: Option<String>,
    last_event: Option<String>,
}

impl Unfinished {
    fn into_fields(self) -> Map<String, Value> {
        Map::from_iter([
            ("file".to_owned(), Value::from(self.file)),
            ("started".to_owned(), Value::from(self.started)),
            ("predecessor_pid".to_owned(), Value::from(self.pid)),
            ("last_seq".to_owned(), Value::from(self.last_seq)),
            ("last_ts".to_owned(), Value::from(self.last_ts)),
            ("last_event".to_owned(), Value::from(self.last_event)),
        ])
    }
}

/// `<process>-<UTC start>-<pid>-<part>.jsonl` as (process, start, pid, part).
/// The process name may itself contain dashes; the other three never do.
fn parse_name(name: &str) -> Option<(&str, &str, u32, u32)> {
    let mut fields = name.strip_suffix(".jsonl")?.rsplitn(4, '-');
    let part = fields.next()?.parse().ok()?;
    let pid = fields.next()?.parse().ok()?;
    let started = fields.next()?;
    let process = fields.next()?;
    Some((process, started, pid, part))
}

/// Windows sharing flags. A writer opens its file allowing others to read it and
/// nothing else, so another process asking to write to it is refused exactly
/// while the writer has it open (2.16).
#[cfg(windows)]
const SHARE_READ: u32 = 1;
#[cfg(windows)]
const SHARE_ALL: u32 = 1 | 2 | 4;
#[cfg(windows)]
const ERROR_SHARING_VIOLATION: i32 = 32;

/// Open a log file for appending and keep it held, so that [`held_by_a_writer`]
/// can tell a process that is still running from one that is gone.
fn open_as_writer(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(SHARE_READ);
    }
    let file = options.open(path)?;
    // Elsewhere an advisory shared lock does the same. A filesystem that cannot
    // lock only loses the distinction, never a line.
    #[cfg(not(windows))]
    let _ = file.lock_shared();
    Ok(file)
}

/// Whether some process has `path` open as a log writer right now. A process
/// that was killed holds nothing: the system closed its files with it, and a
/// process id that has since been reused by something else changes nothing.
fn held_by_a_writer(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        match OpenOptions::new()
            .append(true)
            .share_mode(SHARE_ALL)
            .open(path)
        {
            Err(error) => error.raw_os_error() == Some(ERROR_SHARING_VIOLATION),
            Ok(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        File::open(path)
            .is_ok_and(|file| matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)))
    }
}

/// The last whole record of a file: the last line that is a JSON object. A line
/// cut off by a kill, and the fragment a tail read starts in, are skipped.
fn last_record(path: &Path) -> Option<Value> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL_BYTES: u64 = 64 * 1024;
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut tail = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut tail).ok()?;
    String::from_utf8_lossy(&tail)
        .lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .filter(Value::is_object)
        })
}

/// The earlier runs of `process` that a start must name, and those still
/// running (2.16). A kill is named once, by the first start after it, whether
/// or not runs of the process overlap, without reading every file:
///
/// Walking back from the newest run, the walk stops at the newest that lists,
/// in its `log.start`, the runs it found still running. Every run that was
/// already gone when that run started was named by it then, so the only runs
/// that can still be unnamed are that run, the runs it listed, and any newer
/// run passed on the way (one killed before it wrote its first line). Runs that
/// started in the same second are taken together, since their order is not
/// known. Each of these is probed: a run still holding its file is running
/// (listed by this start in turn); one that is gone without `log.stop` is named.
///
/// Files from before 2.16 have no list. The walk then stops at the first such
/// run that is gone, as the old rule did, so the first start after the upgrade
/// names one run, not every old one; every older run is probed so that the
/// ones still running are listed and named when they end.
fn find_earlier(directory: &Path, process: &str, own: &str) -> Earlier {
    use std::collections::{BTreeMap, BTreeSet};
    type Key = (String, u32);
    // The race this order closes (two starts, each scanning before the other's
    // file exists) cannot be staged in a test, so the tests check the order.
    #[cfg(test)]
    assert!(
        directory.join(format!("{own}-1.jsonl")).exists(),
        "a start looks at earlier runs only once its own file exists"
    );
    // One entry per run, (start, pid), with its first and last parts.
    let mut runs: BTreeMap<Key, Run> = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Earlier::default();
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some((owner, started, pid, part)) = parse_name(&name) else {
            continue;
        };
        if owner != process {
            continue;
        }
        // This start's own file, opened just before: not an earlier run.
        if format!("{owner}-{started}-{pid}") == own {
            continue;
        }
        let run = runs.entry((started.to_owned(), pid)).or_default();
        if run.last.as_ref().is_none_or(|(last, _)| part >= *last) {
            run.last = Some((part, entry.path()));
        }
        if run.first.as_ref().is_none_or(|(first, _)| part < *first) {
            run.first = Some((part, entry.path()));
        }
    }
    let name_of = |(started, pid): &Key| format!("{process}-{started}-{pid}");
    let held = |run: &Run| -> bool {
        run.last
            .as_ref()
            .is_some_and(|(_, path)| held_by_a_writer(path))
    };

    let mut candidates: BTreeSet<&Key> = BTreeSet::new();
    let mut stop_at: Option<&str> = None;
    let mut unlisted = false;
    for (key, run) in runs.iter().rev() {
        if stop_at.is_some_and(|second| second != key.0) {
            break;
        }
        candidates.insert(key);
        let Some((_, first)) = &run.first else {
            continue;
        };
        match head(first) {
            Head::Listed(names) => {
                candidates.extend(runs.keys().filter(|other| names.contains(&name_of(other))));
                stop_at.get_or_insert(&key.0);
            }
            Head::Unlisted if !held(run) => {
                stop_at.get_or_insert(&key.0);
                unlisted = true;
            }
            Head::Unlisted | Head::Missing => {}
        }
    }
    if unlisted {
        let older: Vec<&Key> = runs
            .iter()
            .filter(|&(key, run)| !candidates.contains(key) && held(run))
            .map(|(key, _)| key)
            .collect();
        candidates.extend(older);
    }

    let mut earlier = Earlier::default();
    for key in candidates {
        let run = &runs[key];
        let Some((_, path)) = &run.last else {
            continue;
        };
        if held(run) {
            earlier.running.push(name_of(key));
            continue;
        }
        let last = last_record(path);
        let event = last
            .as_ref()
            .and_then(|record| record["event"].as_str())
            .map(str::to_owned);
        if event.as_deref() == Some("log.stop") {
            continue;
        }
        earlier.unfinished.push(Unfinished {
            file: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            started: key.0.clone(),
            pid: key.1,
            last_seq: last.as_ref().and_then(|record| record["seq"].as_u64()),
            last_ts: last
                .as_ref()
                .and_then(|record| record["ts"].as_str())
                .map(str::to_owned),
            last_event: event,
        });
    }
    earlier
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
    fn a_record_carries_the_entered_correlation_scope_unless_it_names_its_own() {
        let dir = scratch("corr");
        let guard = start(LogConfig::new("playout", "shell", &dir)).unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(event = "before.scope");
            {
                let _scope = crate::corr::enter("po-9");
                tracing::info!(event = "inside.scope");
                tracing::info!(event = "own.corr", corr = "other-1");
            }
            tracing::info!(event = "after.scope");
        });
        guard.finish().unwrap();
        let records = lines(&dir.join("playout"));
        let named = |event: &str| {
            records
                .iter()
                .find(|r| r["event"] == event)
                .unwrap_or_else(|| panic!("no {event} in {records:#?}"))
        };
        assert!(named("before.scope")["corr"].is_null());
        assert_eq!(named("inside.scope")["corr"], "po-9");
        assert_eq!(
            named("own.corr")["corr"],
            "other-1",
            "an event's own id wins"
        );
        assert!(
            named("after.scope")["corr"].is_null(),
            "the scope ended with its guard"
        );
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

    /// A pause a test can put between a record taking its number and being
    /// queued: the window in which the 2.25 race happened.
    /// The pauses, one per sink: the sink's identity maps to the number to hold
    /// and the release. Keyed by sink, not held in one slot: tests run in parallel
    /// and every sink numbers its records from 1, so one slot (or a hook keyed by
    /// number alone) was taken, overwritten or dropped by whichever test reached it
    /// first, and the order test failed about one run in four.
    type Pauses = std::collections::HashMap<usize, (u64, std::sync::mpsc::Receiver<()>)>;
    static PAUSE_AT: std::sync::LazyLock<std::sync::Mutex<Pauses>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(Pauses::new()));

    pub(super) fn between_number_and_queue(sink: usize, seq: u64) {
        let waiting = {
            let mut pauses = PAUSE_AT
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match pauses.get(&sink) {
                Some((at, _)) if *at == seq => pauses.remove(&sink).map(|(_, release)| release),
                _ => None,
            }
        };
        if let Some(release) = waiting {
            let _ = release.recv_timeout(Duration::from_secs(5));
        }
    }

    /// 2.25: a record held between its number and the queue (the race's window)
    /// does not let a later record overtake it: the file holds 1, 2, 3 in order and
    /// no `log.lost`. Before the fix the later one was queued first, and the writer
    /// stated the held one lost and then wrote it.
    #[test]
    fn a_record_held_after_its_number_is_not_overtaken_or_stated_lost() {
        let dir = scratch("order");
        let guard = start(LogConfig::new("engine", "worker", &dir)).unwrap();
        let dispatch = tracing::Dispatch::new(tracing_subscriber::registry().with(guard.layer()));
        // log.start took 1; the held record is 2.
        let (release, held) = std::sync::mpsc::channel();
        let sink = Arc::as_ptr(
            &guard
                .layer
                .as_ref()
                .expect("the layer lives as long as the guard")
                .shared,
        ) as usize;
        PAUSE_AT.lock().unwrap().insert(sink, (2, held));
        let first = {
            let dispatch = dispatch.clone();
            std::thread::spawn(move || {
                tracing::dispatcher::with_default(&dispatch, || {
                    tracing::info!(event = "order.first");
                });
            })
        };
        // Let the first thread reach the pause holding number 2.
        while PAUSE_AT.lock().unwrap().contains_key(&sink) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let second = {
            let dispatch = dispatch.clone();
            std::thread::spawn(move || {
                tracing::dispatcher::with_default(&dispatch, || {
                    tracing::info!(event = "order.second");
                });
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        release.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        drop(dispatch);
        guard.finish().unwrap();
        let records = lines(&dir.join("engine"));
        assert!(
            !records.iter().any(|r| r["event"] == "log.lost"),
            "a written record was stated lost: {records:#?}"
        );
        let events: Vec<(&str, u64)> = records
            .iter()
            .filter(|r| r["event"].as_str().is_some_and(|e| e.starts_with("order.")))
            .map(|r| (r["event"].as_str().unwrap(), r["seq"].as_u64().unwrap()))
            .collect();
        assert_eq!(
            events,
            [("order.first", 2), ("order.second", 3)],
            "{records:#?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A pause set for one sink is never taken by another: every sink numbers its
    /// records from 1, and tests run in parallel, so a hook keyed by number alone
    /// was consumed by whichever sink reached it first (the order test failed about
    /// one run in four). Here the pause belongs to sink A and sink B logs through
    /// its number: B is not held and the pause is still waiting for A.
    #[test]
    fn a_pause_set_for_one_sink_is_not_taken_by_another() {
        let dir_a = scratch("pause-a");
        let dir_b = scratch("pause-b");
        let a = start(LogConfig::new("engine", "worker", &dir_a)).unwrap();
        let b = start(LogConfig::new("engine", "worker", &dir_b)).unwrap();
        let sink_a = Arc::as_ptr(&a.layer.as_ref().unwrap().shared) as usize;
        let (release, held) = std::sync::mpsc::channel::<()>();
        PAUSE_AT.lock().unwrap().insert(sink_a, (2, held));
        let dispatch = tracing::Dispatch::new(tracing_subscriber::registry().with(b.layer()));
        let began = std::time::Instant::now();
        tracing::dispatcher::with_default(&dispatch, || {
            tracing::info!(event = "other.first");
            tracing::info!(event = "other.second");
        });
        assert!(
            began.elapsed() < Duration::from_secs(2),
            "sink B was held by sink A's pause"
        );
        assert!(
            PAUSE_AT.lock().unwrap().contains_key(&sink_a),
            "sink B consumed sink A's pause"
        );
        PAUSE_AT.lock().unwrap().remove(&sink_a);
        drop(release);
        drop(dispatch);
        a.finish().unwrap();
        b.finish().unwrap();
        let _ = std::fs::remove_dir_all(dir_a);
        let _ = std::fs::remove_dir_all(dir_b);
    }

    /// 2.25: many threads logging at once leave every number written once, in
    /// order, and nothing stated lost when the queue has room.
    #[test]
    fn threads_logging_at_once_write_every_number_once_and_in_order() {
        for round in 0..5 {
            let dir = scratch(&format!("flood-{round}"));
            let mut config = LogConfig::new("engine", "worker", &dir);
            config.queue = 100_000;
            let guard = start(config).unwrap();
            let dispatch =
                tracing::Dispatch::new(tracing_subscriber::registry().with(guard.layer()));
            let threads: Vec<_> = (0..8)
                .map(|t| {
                    let dispatch = dispatch.clone();
                    std::thread::spawn(move || {
                        tracing::dispatcher::with_default(&dispatch, || {
                            for i in 0..400u64 {
                                tracing::info!(event = "flood", thread = t, i);
                            }
                        });
                    })
                })
                .collect();
            for thread in threads {
                thread.join().unwrap();
            }
            drop(dispatch);
            guard.finish().unwrap();
            let records = lines(&dir.join("engine"));
            assert!(
                !records.iter().any(|r| r["event"] == "log.lost"),
                "round {round}"
            );
            let seqs: Vec<u64> = records.iter().filter_map(|r| r["seq"].as_u64()).collect();
            assert!(
                seqs.windows(2).all(|w| w[1] == w[0] + 1),
                "round {round}: numbers out of order"
            );
            assert_eq!(seqs.len() as u64, 8 * 400 + 1, "round {round}");
            let _ = std::fs::remove_dir_all(dir);
        }
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

    // --- 2.16: a start names the earlier run that left no stop record ---------------

    /// The start stamp of every fabricated run: far in the future, so it sorts
    /// after any real file this process writes in the same folder.
    const LATER: &str = "29990101T000000Z";

    fn record(seq: u64, event: &str) -> String {
        serde_json::json!({
            "ts": format!("2999-01-01T00:00:{seq:02}.000000Z"),
            "seq": seq,
            "pid": 4242,
            "process": "worker",
            "event": event,
        })
        .to_string()
    }

    /// An earlier run's file, as a process that ended left it: `lines` whole
    /// records and then `tail`, which may be a line cut off in the middle.
    fn earlier_run(directory: &Path, name: &str, lines: &[String], tail: &str) -> PathBuf {
        let folder = directory.join("engine");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join(name);
        let mut text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        text.push_str(tail);
        std::fs::write(&path, text).unwrap();
        path
    }

    /// Start and finish a sink for `engine/worker`; the records it wrote.
    fn start_and_finish(directory: &Path, process: &str) -> Vec<Value> {
        let guard = start(LogConfig::new("engine", process, directory)).unwrap();
        guard.finish().unwrap();
        // Only this process's own files: an earlier run's file may end in a
        // line that was cut off, which is the point of some tests.
        let mut files: Vec<PathBuf> = std::fs::read_dir(directory.join("engine"))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .and_then(parse_name)
                    .is_some_and(|(_, _, pid, _)| pid == std::process::id())
            })
            .collect();
        files.sort();
        files
            .iter()
            .flat_map(|path| {
                std::fs::read_to_string(path)
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str::<Value>(line).unwrap())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn unfinished(records: &[Value]) -> Vec<&Value> {
        records
            .iter()
            .filter(|r| r["event"] == "log.previous_unfinished")
            .collect()
    }

    /// A 2.16 `log.start`, listing the runs it found still running.
    fn listed_start(running: &[&str]) -> String {
        serde_json::json!({
            "ts": "2999-01-01T00:00:01.000000Z",
            "seq": 1,
            "pid": 4242,
            "process": "worker",
            "event": "log.start",
            "fields": { "running": running },
        })
        .to_string()
    }

    /// The files named by this start's `log.previous_unfinished` records.
    fn named_files(records: &[Value]) -> Vec<String> {
        unfinished(records)
            .iter()
            .map(|r| r["fields"]["file"].as_str().unwrap().to_owned())
            .collect()
    }

    /// What this start's `log.start` lists as still running.
    fn listed_running(records: &[Value]) -> Vec<String> {
        let start = records.iter().find(|r| r["event"] == "log.start").unwrap();
        start["fields"]["running"]
            .as_array()
            .expect("log.start lists the runs still running")
            .iter()
            .map(|name| name.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn a_start_names_an_earlier_run_that_left_no_stop_record() {
        let dir = scratch("unfinished");
        let name = format!("worker-{LATER}-4242-1.jsonl");
        earlier_run(
            &dir,
            &name,
            &[
                record(1, "log.start"),
                record(2, "engine.heartbeat"),
                record(3, "engine.heartbeat"),
            ],
            "",
        );
        let records = start_and_finish(&dir, "worker");
        let events: Vec<&str> = records
            .iter()
            .map(|r| r["event"].as_str().unwrap())
            .collect();
        assert_eq!(events, ["log.start", "log.previous_unfinished", "log.stop"]);
        assert!(listed_running(&records).is_empty(), "nothing was running");
        let named = &records[1];
        assert_eq!(named["level"], "warn");
        let fields = &named["fields"];
        assert_eq!(fields["file"], name.as_str());
        assert_eq!(fields["started"], LATER);
        assert_eq!(fields["predecessor_pid"], 4242);
        assert_eq!(fields["last_seq"], 3);
        assert_eq!(fields["last_ts"], "2999-01-01T00:00:03.000000Z");
        assert_eq!(fields["last_event"], "engine.heartbeat");
    }

    #[test]
    fn an_earlier_run_that_finished_is_not_named() {
        let dir = scratch("finished");
        earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-1.jsonl"),
            &[record(1, "log.start"), record(2, "log.stop")],
            "",
        );
        assert!(unfinished(&start_and_finish(&dir, "worker")).is_empty());
    }

    #[test]
    fn an_earlier_run_still_holding_its_file_is_not_called_unfinished() {
        let dir = scratch("alive");
        let path = earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-1.jsonl"),
            &[record(1, "log.start"), record(2, "engine.heartbeat")],
            "",
        );
        // Another engine, still running: it holds its file as the sink does.
        let holder = open_as_writer(&path).unwrap();
        let beside = start_and_finish(&dir, "worker");
        assert!(
            unfinished(&beside).is_empty(),
            "a running sibling is not a killed predecessor"
        );
        assert_eq!(
            listed_running(&beside),
            [format!("worker-{LATER}-4242")],
            "the start lists it as running"
        );
        // Once it is gone, with no stop record, the next start names it.
        drop(holder);
        let after = start_and_finish(&dir, "worker");
        let named = unfinished(&after);
        assert_eq!(named.len(), 1, "named once it no longer holds its file");
        assert_eq!(named[0]["fields"]["last_seq"], 2);
    }

    /// Runs from before 2.16 list nothing in their `log.start`: the walk stops at
    /// the first that is gone, as the old rule did.
    #[test]
    fn before_2_16_only_the_newest_run_that_is_gone_decides() {
        let dir = scratch("newest");
        let older = "worker-29980101T000000Z-4241-1.jsonl".to_owned();
        let newer = format!("worker-{LATER}-4242-1.jsonl");
        earlier_run(&dir, &older, &[record(1, "log.start")], "");
        earlier_run(
            &dir,
            &newer,
            &[record(1, "log.start"), record(2, "engine.heartbeat")],
            "",
        );
        let records = start_and_finish(&dir, "worker");
        let named = unfinished(&records);
        assert_eq!(named.len(), 1, "one kill is named once");
        assert_eq!(named[0]["fields"]["file"], newer.as_str());

        // A newer run that finished hides the older one that did not: its own
        // start named it already.
        let dir = scratch("newest-finished");
        earlier_run(&dir, &older, &[record(1, "log.start")], "");
        earlier_run(
            &dir,
            &newer,
            &[record(1, "log.start"), record(2, "log.stop")],
            "",
        );
        assert!(unfinished(&start_and_finish(&dir, "worker")).is_empty());
    }

    #[test]
    fn the_last_part_of_a_rotated_run_is_the_one_that_decides() {
        let dir = scratch("parts");
        earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-1.jsonl"),
            &[record(1, "log.start")],
            "",
        );
        earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-2.jsonl"),
            &[record(2, "engine.heartbeat"), record(3, "log.stop")],
            "",
        );
        assert!(
            unfinished(&start_and_finish(&dir, "worker")).is_empty(),
            "part 1 has no stop record because the run went on into part 2"
        );
        let dir = scratch("parts-killed");
        earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-1.jsonl"),
            &[record(1, "log.start")],
            "",
        );
        let second = format!("worker-{LATER}-4242-2.jsonl");
        earlier_run(&dir, &second, &[record(2, "engine.heartbeat")], "");
        let named = start_and_finish(&dir, "worker");
        assert_eq!(unfinished(&named)[0]["fields"]["file"], second.as_str());
    }

    #[test]
    fn a_line_cut_off_by_a_kill_is_skipped_and_an_empty_file_is_named_too() {
        let dir = scratch("cut");
        earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-1.jsonl"),
            &[record(1, "log.start"), record(2, "engine.heartbeat")],
            r#"{"ts":"2999-01-01T00:00:09.000000Z","seq":9,"ev"#,
        );
        let named = start_and_finish(&dir, "worker");
        assert_eq!(unfinished(&named)[0]["fields"]["last_seq"], 2);

        let dir = scratch("empty");
        earlier_run(&dir, &format!("worker-{LATER}-4242-1.jsonl"), &[], "");
        let named = start_and_finish(&dir, "worker");
        let fields = &unfinished(&named)[0]["fields"];
        assert!(fields["last_seq"].is_null() && fields["last_event"].is_null());
    }

    #[test]
    fn another_process_name_is_not_mistaken_for_this_one() {
        let dir = scratch("names");
        // `shell` is another process; `worker-2` is another whose name starts
        // with this one's.
        earlier_run(
            &dir,
            &format!("shell-{LATER}-4242-1.jsonl"),
            &[record(1, "log.start")],
            "",
        );
        earlier_run(
            &dir,
            &format!("worker-2-{LATER}-4242-1.jsonl"),
            &[record(1, "log.start")],
            "",
        );
        assert!(unfinished(&start_and_finish(&dir, "worker")).is_empty());
        assert_eq!(
            parse_name("worker-2-29990101T000000Z-4242-7.jsonl"),
            Some(("worker-2", "29990101T000000Z", 4242, 7))
        );
        assert_eq!(parse_name("notes.txt"), None);
        assert_eq!(parse_name("worker-x-1.jsonl"), None);
    }

    /// Two runs overlap: X starts, Y starts beside it (and lists X as running),
    /// X is killed, Y ends in order. The next start is the first after X's death
    /// and names X, though the newest run, Y, finished.
    #[test]
    fn with_overlapping_runs_a_kill_is_named_by_the_first_start_after_it() {
        let dir = scratch("overlap");
        let x = "worker-29980101T000000Z-4241".to_owned();
        earlier_run(
            &dir,
            &format!("{x}-1.jsonl"),
            &[listed_start(&[]), record(2, "engine.heartbeat")],
            "",
        );
        earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-1.jsonl"),
            &[listed_start(&[&x]), record(2, "log.stop")],
            "",
        );
        let records = start_and_finish(&dir, "worker");
        assert_eq!(named_files(&records), [format!("{x}-1.jsonl")]);
        assert_eq!(unfinished(&records)[0]["fields"]["last_seq"], 2);
    }

    /// X is killed while Y runs; Z starts after X's death, names it, and lists Y.
    /// While Y and Z still run, a further start names nothing: X was named once.
    #[test]
    fn a_kill_named_once_is_not_named_again_while_its_siblings_run() {
        let dir = scratch("once");
        let x = "worker-29970101T000000Z-4240".to_owned();
        let y = "worker-29980101T000000Z-4241".to_owned();
        let z = format!("worker-{LATER}-4242");
        earlier_run(
            &dir,
            &format!("{x}-1.jsonl"),
            &[listed_start(&[]), record(2, "engine.heartbeat")],
            "",
        );
        let y_file = earlier_run(
            &dir,
            &format!("{y}-1.jsonl"),
            &[listed_start(&[&x]), record(2, "engine.heartbeat")],
            "",
        );
        let z_file = earlier_run(
            &dir,
            &format!("{z}-1.jsonl"),
            &[listed_start(&[&y]), record(2, "log.previous_unfinished")],
            "",
        );
        let y_holds = open_as_writer(&y_file).unwrap();
        let z_holds = open_as_writer(&z_file).unwrap();
        let records = start_and_finish(&dir, "worker");
        assert!(named_files(&records).is_empty(), "X was named by Z already");
        assert_eq!(listed_running(&records), [y.as_str(), z.as_str()]);
        // Once Y is gone too, the next start names Y, and only Y.
        drop(y_holds);
        let records = start_and_finish(&dir, "worker");
        assert_eq!(named_files(&records), [format!("{y}-1.jsonl")]);
        drop(z_holds);
    }

    /// The newest run was killed before it wrote its first line: it is named,
    /// and the walk goes on past it to the newest run that lists what it found.
    #[test]
    fn a_run_killed_before_its_first_line_is_named_and_passed_over() {
        let dir = scratch("first-line");
        let k = "worker-29970101T000000Z-4240".to_owned();
        earlier_run(
            &dir,
            &format!("{k}-1.jsonl"),
            &[listed_start(&[]), record(2, "engine.heartbeat")],
            "",
        );
        earlier_run(
            &dir,
            "worker-29980101T000000Z-4241-1.jsonl",
            &[listed_start(&[&k]), record(2, "log.stop")],
            "",
        );
        let empty = format!("worker-{LATER}-4242-1.jsonl");
        earlier_run(&dir, &empty, &[], r#"{"ts":"2999-01-01T00:00:00"#);
        let records = start_and_finish(&dir, "worker");
        assert_eq!(named_files(&records), [format!("{k}-1.jsonl"), empty]);
    }

    /// The newest run has no list (a build from before 2.16) and is gone, so the
    /// walk stops there, naming no backlog; an older run behind it that still
    /// holds its file (as only a 2.16 writer does, so: a downgrade, or a newer
    /// build started first) is listed, so that it is named when it ends. A
    /// pre-2.16 writer does not hold its file and cannot be told from a dead one.
    #[test]
    fn a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed() {
        let dir = scratch("upgrade");
        // Dated before this test's own starts, as old runs are: the second start
        // below must find the first one's list as the newest.
        let old = "worker-20000101T000000Z-4240".to_owned();
        let older_file = earlier_run(
            &dir,
            &format!("{old}-1.jsonl"),
            &[record(1, "log.start")],
            "",
        );
        earlier_run(
            &dir,
            "worker-20000102T000000Z-4241-1.jsonl",
            &[record(1, "log.start")],
            "",
        );
        earlier_run(
            &dir,
            "worker-20000103T000000Z-4242-1.jsonl",
            &[record(1, "log.start"), record(2, "log.stop")],
            "",
        );
        let holder = open_as_writer(&older_file).unwrap();
        let records = start_and_finish(&dir, "worker");
        assert!(named_files(&records).is_empty(), "no backlog is named");
        assert_eq!(listed_running(&records), [old.as_str()]);
        // That start is now an earlier run. Two starts of one process within a
        // second share a file name (a real process never starts twice), so its
        // file is renamed as if it began the day after the runs above.
        let engine = dir.join("engine");
        let mine = std::fs::read_dir(&engine)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .and_then(parse_name)
                    .is_some_and(|(_, _, pid, _)| pid == std::process::id())
            })
            .unwrap();
        let earlier = format!("worker-20000104T000000Z-{}-1.jsonl", std::process::id());
        std::fs::rename(&mine, engine.join(earlier)).unwrap();
        // It ends without a stop record: the next start names it.
        drop(holder);
        let records = start_and_finish(&dir, "worker");
        assert_eq!(named_files(&records), [format!("{old}-1.jsonl")]);
    }

    /// A long run rotated into a second part: its list is in its first part's
    /// `log.start`, and that is the one read.
    #[test]
    fn a_rotated_runs_list_is_read_from_its_first_part() {
        let dir = scratch("rotated-list");
        let k = "worker-29970101T000000Z-4240".to_owned();
        earlier_run(
            &dir,
            &format!("{k}-1.jsonl"),
            &[listed_start(&[]), record(2, "engine.heartbeat")],
            "",
        );
        earlier_run(
            &dir,
            "worker-29980101T000000Z-4241-1.jsonl",
            &[record(1, "log.start"), record(2, "log.stop")],
            "",
        );
        let rotated = format!("worker-{LATER}-4242");
        earlier_run(
            &dir,
            &format!("{rotated}-1.jsonl"),
            &[listed_start(&[&k])],
            "",
        );
        let second = earlier_run(
            &dir,
            &format!("{rotated}-2.jsonl"),
            &[record(2, "engine.heartbeat")],
            "",
        );
        // Still running, in its second part; it found K running when it started.
        let holder = open_as_writer(&second).unwrap();
        let records = start_and_finish(&dir, "worker");
        assert_eq!(named_files(&records), [format!("{k}-1.jsonl")]);
        assert_eq!(listed_running(&records), [rotated.as_str()]);
        drop(holder);
    }

    /// Two runs that started in the same second cannot be ordered: both are
    /// taken as newest, so a kill of either is named.
    #[test]
    fn runs_that_started_in_the_same_second_are_taken_together() {
        let dir = scratch("same-second");
        earlier_run(
            &dir,
            &format!("worker-{LATER}-4242-1.jsonl"),
            &[listed_start(&[]), record(2, "log.stop")],
            "",
        );
        let other = format!("worker-{LATER}-4241-1.jsonl");
        earlier_run(
            &dir,
            &other,
            &[listed_start(&[]), record(2, "engine.heartbeat")],
            "",
        );
        assert_eq!(named_files(&start_and_finish(&dir, "worker")), [other]);
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
