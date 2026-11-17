//! The diagnostic bundle (build plan 2.14, ADR-0004 §8).
//!
//! One archive for a bug report: the last N hours of every process's log, the
//! as-run log when there is one, versions and the SHA-256 of each executable,
//! the capability surface, the device and adapter the engine reported, the
//! sanitised configuration, and what the engine's recovery journal holds
//! (never the scene bodies). `gx-diag` (the command) and the menu item in each
//! shell are this one function, [`collect`].
//!
//! **Module by module.** A module is one product's folder under the log root
//! (`engine`, `editor`, `playout`, `mcp`, ...). Everything a module wrote is
//! under `modules/<module>/` in the archive: its log files, and a `summary.json`
//! that says, without opening a log, which runs it had and how each ended, how
//! many records at each level, its refusals, lost lines and late or missed
//! frames, its newest errors and warnings, and the executables that belong to
//! it with their hashes. The engine's module also holds the device and adapter
//! it reported and what its recovery journal holds. A bundle can be made of
//! chosen modules only ([`Options::modules`]). What belongs to no one module
//! stays at the top: the manifest, the capability surface, the sanitised
//! configuration, every executable's hash, and the as-run log.
//!
//! **A bundle leaves the machine, so it holds no credential.** Credentials never
//! reach a log (invariant 54) and the log tests check it; the collector does not
//! rely on that. It scans every byte it copies for the credential shape
//! (`gx1.` and what follows) and for the values of the secrets in its own
//! environment, replaces each with a marker in the copy, counts them per file,
//! and says so in the manifest and in its result: a credential found in a log is
//! itself a bug, and a bundle that quietly cleaned it would hide the bug.
//!
//! **Whole files.** A log file is included whole when it was written to within
//! the window, so its `seq` runs without a gap and a `log.lost` record stays
//! beside the lines it explains. The manifest names each file with its first and
//! last timestamp and sequence number. A total size cap names what it leaves out.
//!
//! **Read back.** The archive is written beside its final name, opened again,
//! and every member is hashed and compared with the manifest before it is
//! renamed into place; one that does not match is removed, not handed over.
//!
//! Named limits: the as-run log (row 12.11) is included when it exists and its
//! absence is named when it does not; launch arguments of running processes are
//! not collected (the engine's own `engine.start` record says how it was
//! started); an executable's hash is of the file beside the collector, which is
//! not proof it is the file a running process was started from.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// The bundle's own format, so a reader knows what the manifest holds.
pub const BUNDLE_FORMAT: u32 = 1;

/// How many hours of log a bundle holds unless told otherwise.
pub const DEFAULT_HOURS: u64 = 24;

/// The most log bytes a bundle holds. Newest files first; the rest are named in
/// the manifest as left out.
pub const DEFAULT_MAX_LOG_BYTES: u64 = 256 * 1024 * 1024;

/// What replaces a credential in the copy.
const REDACTED: &str = "gx1.REDACTED";

/// The folder (beside the product folders) the shells write bundles into.
pub const BUNDLES_FOLDER: &str = "bundles";

/// The folder the as-run log lives in (ADR-0004 §5).
pub const AS_RUN_FOLDER: &str = "as-run";

/// What a collection reads from. [`Options::for_this_machine`] fills it in; a
/// test fills it in by hand.
#[derive(Debug, Clone)]
pub struct Options {
    /// The log root: one folder per product, one file per run.
    pub log_root: PathBuf,
    /// How far back a log file's last write may be, in hours.
    pub hours: u64,
    /// The moment the window is counted back from.
    pub now: SystemTime,
    /// The archive to write.
    pub output: PathBuf,
    /// Folders whose `gx-*` executables are named and hashed.
    pub binary_dirs: Vec<PathBuf>,
    /// The engine's recovery journal, if it has one.
    pub journal: Option<PathBuf>,
    /// The most log bytes to hold.
    pub max_log_bytes: u64,
    /// The modules to collect; empty means every module that has a log in the
    /// window. A module asked for by name is in the bundle even when it wrote
    /// nothing, and its summary says so.
    pub modules: Vec<String>,
    /// The `GX_*` environment, name and value.
    pub environment: Vec<(String, String)>,
    /// The user's home folder, replaced by `<home>` in the paths the bundle names.
    pub home: Option<String>,
    /// Where the platform keeps the roots, named in `environment.json`.
    pub roots: BTreeMap<String, String>,
}

impl Options {
    /// This machine's defaults: the log root (`GX_LOG_DIR` or the platform's),
    /// the executables beside this one, the engine's journal and the `GX_*`
    /// environment. The archive goes in the log root's `bundles` folder.
    pub fn for_this_machine(hours: u64) -> Result<Self, DiagError> {
        let now = SystemTime::now();
        let log_root = gx_telemetry::sink::log_directory().map_err(DiagError::LogRoot)?;
        let output = log_root.join(BUNDLES_FOLDER).join(bundle_name(now));
        let mut roots = BTreeMap::new();
        roots.insert("log".to_owned(), log_root.display().to_string());
        for (name, found) in [
            ("data", gx_contracts::platform::service_data_root()),
            ("cache", gx_contracts::platform::cache_root()),
            ("packages", gx_contracts::platform::package_exchange_root()),
        ] {
            roots.insert(
                name.to_owned(),
                found.map_or_else(|_| "unavailable".to_owned(), |p| p.display().to_string()),
            );
        }
        let journal = gx_contracts::platform::service_data_root()
            .ok()
            .map(|root| root.join("render-engine").join("recovery.json"));
        let binary_dirs = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .into_iter()
            .collect();
        Ok(Self {
            log_root,
            hours,
            now,
            output,
            binary_dirs,
            journal,
            max_log_bytes: DEFAULT_MAX_LOG_BYTES,
            modules: Vec::new(),
            environment: std::env::vars()
                .filter(|(name, _)| name.starts_with("GX_"))
                .collect(),
            home: std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .ok()
                .filter(|home| !home.is_empty()),
            roots,
        })
    }
}

/// What a collection did.
#[derive(Debug, Clone)]
pub struct Collected {
    /// The archive.
    pub path: PathBuf,
    /// Its size.
    pub bytes: u64,
    /// The members other than the manifest.
    pub files: usize,
    /// Log files included.
    pub log_files: usize,
    /// The modules in the bundle, in order.
    pub modules: Vec<String>,
    /// As-run files included.
    pub as_run_files: usize,
    /// Log files left out for the size cap.
    pub left_out: Vec<String>,
    /// Every credential found and replaced, by member.
    pub redactions: Vec<Redaction>,
}

impl Collected {
    /// Credentials found in what was collected, in all.
    pub fn redacted(&self) -> usize {
        self.redactions.iter().map(|r| r.count).sum()
    }
}

/// Credentials found in one member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redaction {
    pub member: String,
    pub count: usize,
}

/// Why a collection failed.
#[derive(Debug)]
pub enum DiagError {
    /// The log root could not be named.
    LogRoot(io::Error),
    /// The log root cannot be read.
    ReadLogRoot { path: PathBuf, source: io::Error },
    /// The archive could not be written.
    Write { path: PathBuf, source: io::Error },
    /// The archive did not read back as it was written; it was removed.
    ReadBack { detail: String },
}

impl std::fmt::Display for DiagError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LogRoot(source) => write!(f, "the log root cannot be named: {source}"),
            Self::ReadLogRoot { path, source } => {
                write!(
                    f,
                    "the log root {} cannot be read: {source}",
                    path.display()
                )
            }
            Self::Write { path, source } => {
                write!(
                    f,
                    "the bundle {} cannot be written: {source}",
                    path.display()
                )
            }
            Self::ReadBack { detail } => {
                write!(
                    f,
                    "the bundle did not read back as written, and was removed: {detail}"
                )
            }
        }
    }
}

impl std::error::Error for DiagError {}

/// The archive's file name for a moment: `grapix-diag-20261117T101353Z.zip`.
pub fn bundle_name(now: SystemTime) -> String {
    let stamp = gx_telemetry::sink::rfc3339_utc(now);
    let compact: String = stamp
        .chars()
        .take_while(|c| *c != '.' && *c != 'Z')
        .filter(|c| c.is_ascii_digit() || *c == 'T')
        .collect();
    format!("grapix-diag-{compact}Z.zip")
}

/// Replace every credential in `input` with a marker; return the copy and how
/// many were replaced.
///
/// A credential is `gx1.` followed by a run of letters, digits, `_`, `-` and `.`
/// (the payload and its MAC), so a malformed one is replaced too. `gx1.` with
/// nothing after it is not one. Each of `secrets` (those at least eight bytes
/// long) is replaced wherever it occurs, as plain text.
pub fn scrub(input: &[u8], secrets: &[String]) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(input.len());
    let mut count = 0;
    let mut index = 0;
    let prefix = b"gx1.";
    while index < input.len() {
        if input[index..].starts_with(prefix) {
            let mut end = index + prefix.len();
            while end < input.len() && is_token_byte(input[end]) {
                end += 1;
            }
            if end > index + prefix.len() {
                out.extend_from_slice(REDACTED.as_bytes());
                count += 1;
                index = end;
                continue;
            }
        }
        out.push(input[index]);
        index += 1;
    }
    for secret in secrets.iter().filter(|secret| secret.len() >= 8) {
        let (replaced, found) = replace_all(&out, secret.as_bytes(), b"REDACTED");
        out = replaced;
        count += found;
    }
    (out, count)
}

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn replace_all(haystack: &[u8], needle: &[u8], with: &[u8]) -> (Vec<u8>, usize) {
    if needle.is_empty() {
        return (haystack.to_vec(), 0);
    }
    let mut out = Vec::with_capacity(haystack.len());
    let mut found = 0;
    let mut index = 0;
    while index < haystack.len() {
        if haystack[index..].starts_with(needle) {
            out.extend_from_slice(with);
            found += 1;
            index += needle.len();
        } else {
            out.push(haystack[index]);
            index += 1;
        }
    }
    (out, found)
}

/// Whether an environment variable's name says its value is a secret.
fn is_secret_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIAL", "AUTH"]
        .iter()
        .any(|word| upper.contains(word))
}

/// `text` with the home folder replaced by `<home>`, wherever it occurs.
fn anonymise(text: &str, home: Option<&str>) -> String {
    let Some(home) = home.filter(|home| !home.is_empty()) else {
        return text.to_owned();
    };
    let lower_text = text.to_ascii_lowercase();
    let lower_home = home.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while let Some(at) = lower_text[index..].find(&lower_home) {
        out.push_str(&text[index..index + at]);
        out.push_str("<home>");
        index += at + home.len();
    }
    out.push_str(&text[index..]);
    out
}

/// One thing that goes into the archive.
struct Member {
    path: String,
    bytes: Vec<u8>,
    redactions: usize,
    extra: Value,
}

/// The first and last record of a JSON Lines file: timestamp and sequence.
fn span_of(bytes: &[u8]) -> Value {
    let mut lines = bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty());
    let first = lines
        .next()
        .and_then(|line| serde_json::from_slice::<Value>(line).ok());
    let last = lines
        .next_back()
        .or(None)
        .and_then(|line| serde_json::from_slice::<Value>(line).ok())
        .or_else(|| first.clone());
    let pick =
        |record: &Option<Value>, key: &str| record.as_ref().and_then(|r| r.get(key)).cloned();
    json!({
        "firstTs": pick(&first, "ts"),
        "lastTs": pick(&last, "ts"),
        "firstSeq": pick(&first, "seq"),
        "lastSeq": pick(&last, "seq"),
    })
}

/// Parse `<process>-<UTC start>-<pid>[-<part>].jsonl`.
fn run_of(name: &str) -> Option<(String, String, u64)> {
    let stem = name.strip_suffix(".jsonl")?;
    let mut parts: Vec<&str> = stem.split('-').collect();
    // An optional trailing part number, after the pid.
    if parts.len() >= 4
        && parts[parts.len() - 1].chars().all(|c| c.is_ascii_digit())
        && parts[parts.len() - 2].chars().all(|c| c.is_ascii_digit())
    {
        parts.pop();
    }
    if parts.len() < 3 {
        return None;
    }
    let pid = parts.pop()?.parse().ok()?;
    let started = parts.pop()?.to_owned();
    Some((parts.join("-"), started, pid))
}

fn modified_within(path: &Path, cutoff: SystemTime) -> Option<(SystemTime, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    (modified >= cutoff).then_some((modified, metadata.len()))
}

/// The module the engine's own files (device, recovery journal) belong to.
pub const ENGINE_MODULE: &str = "engine";

/// The module an executable belongs to, by its name. One that belongs to no
/// product (a tool, a mock) is under `tools`.
pub fn module_of_binary(name: &str) -> &'static str {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    match stem {
        "gx-render-worker" | "gx-engine-host" => ENGINE_MODULE,
        "gx-editor" => "editor",
        "gx-playout" => "playout",
        _ if stem.ends_with("-mcp") => "mcp",
        _ => "tools",
    }
}

/// How many of a module's newest errors and warnings its summary quotes.
const NEWEST_PROBLEMS: usize = 20;

/// What one module wrote, gathered while its logs are copied.
#[derive(Default)]
struct ModuleNotes {
    runs: Vec<Value>,
    files: usize,
    bytes: u64,
    levels: BTreeMap<String, u64>,
    refusals: u64,
    lost_records: u64,
    unfinished_predecessors: u64,
    frames_late: u64,
    frames_missed: u64,
    unparsed_lines: u64,
    redactions: usize,
    left_out: Vec<String>,
    problems: Vec<Value>,
    engine_starts: Vec<Value>,
}

impl ModuleNotes {
    /// Read one log file's records into the notes; how the run ended.
    fn read(&mut self, bytes: &[u8]) -> &'static str {
        let mut last_event = String::new();
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            let Ok(record) = serde_json::from_slice::<Value>(line) else {
                self.unparsed_lines += 1;
                continue;
            };
            let text = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or("");
            let level = text("level").to_owned();
            let event = text("event").to_owned();
            *self.levels.entry(level.clone()).or_default() += 1;
            if record.get("refusal").is_some_and(|r| !r.is_null()) {
                self.refusals += 1;
            }
            match event.as_str() {
                "log.lost" => self.lost_records += 1,
                "log.previous_unfinished" => self.unfinished_predecessors += 1,
                "frame.late" => self.frames_late += 1,
                "frame.missed" => self.frames_missed += 1,
                _ => {}
            }
            if level == "error" || level == "warn" {
                self.problems.push(json!({
                    "ts": record.get("ts"), "level": level, "event": event,
                    "process": record.get("process"), "pid": record.get("pid"),
                    "corr": record.get("corr"), "refusal": record.get("refusal"),
                }));
            }
            last_event = event;
        }
        if last_event == "log.stop" {
            "ended in order"
        } else {
            "no log.stop: still running when collected, or ended without one"
        }
    }

    fn summary(mut self, module: &str, binaries: &[Value]) -> Value {
        // Newest last in the file order; keep the newest few, newest first.
        self.problems.sort_by(|a, b| {
            let ts = |v: &Value| v.get("ts").and_then(Value::as_str).unwrap_or("").to_owned();
            ts(b).cmp(&ts(a))
        });
        let problems_total = self.problems.len();
        self.problems.truncate(NEWEST_PROBLEMS);
        let own: Vec<&Value> = binaries
            .iter()
            .filter(|binary| binary.get("module").and_then(Value::as_str) == Some(module))
            .collect();
        json!({
            "module": module,
            "wroteInWindow": self.files > 0,
            "runs": self.runs,
            "logs": { "files": self.files, "bytes": self.bytes, "leftOut": self.left_out, "unparsedLines": self.unparsed_lines },
            "records": {
                "byLevel": self.levels,
                "refusals": self.refusals,
                "lostRecordNotices": self.lost_records,
                "unfinishedPredecessors": self.unfinished_predecessors,
                "framesLate": self.frames_late,
                "framesMissed": self.frames_missed,
            },
            "problems": { "total": problems_total, "newest": self.problems },
            "credentialsRedacted": self.redactions,
            "binaries": own,
        })
    }
}

/// Collect a bundle as `options` says.
pub fn collect(options: &Options) -> Result<Collected, DiagError> {
    let cutoff = options
        .now
        .checked_sub(Duration::from_secs(options.hours.saturating_mul(3600)))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let home = options.home.as_deref();
    let wanted =
        |module: &str| options.modules.is_empty() || options.modules.iter().any(|m| m == module);

    // The secrets this process holds: replaced wherever they occur in what is copied.
    let secrets: Vec<String> = options
        .environment
        .iter()
        .filter(|(name, value)| is_secret_name(name) && !value.is_empty())
        .map(|(_, value)| value.clone())
        .collect();

    let mut members: Vec<Member> = Vec::new();
    let mut left_out: Vec<String> = Vec::new();
    let mut notes: BTreeMap<String, ModuleNotes> = BTreeMap::new();
    // A module asked for by name is in the bundle even when it wrote nothing.
    for module in &options.modules {
        notes.entry(module.clone()).or_default();
    }

    // 1. Logs, module by module: every product folder but the as-run folder
    // and the bundles folder.
    let mut candidates: Vec<(SystemTime, u64, String, String, PathBuf)> = Vec::new();
    let products = match fs::read_dir(&options.log_root) {
        Ok(entries) => entries.flatten().collect::<Vec<_>>(),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(source) => {
            return Err(DiagError::ReadLogRoot {
                path: options.log_root.clone(),
                source,
            })
        }
    };
    for product in &products {
        let module = product.file_name().to_string_lossy().into_owned();
        if !product.path().is_dir()
            || module == AS_RUN_FOLDER
            || module == BUNDLES_FOLDER
            || !wanted(&module)
        {
            continue;
        }
        let Ok(files) = fs::read_dir(product.path()) else {
            continue;
        };
        for file in files.flatten() {
            let file_name = file.file_name().to_string_lossy().into_owned();
            if !file_name.ends_with(".jsonl") {
                continue;
            }
            if let Some((modified, bytes)) = modified_within(&file.path(), cutoff) {
                candidates.push((
                    modified,
                    bytes,
                    module.clone(),
                    format!("modules/{module}/logs/{file_name}"),
                    file.path(),
                ));
            }
        }
    }
    // Newest first, so a size cap leaves out the oldest.
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.3.cmp(&b.3)));
    let mut log_bytes = 0u64;
    let mut kept: Vec<(String, String, PathBuf)> = Vec::new();
    for (_, bytes, module, member, path) in candidates {
        if log_bytes + bytes > options.max_log_bytes && !kept.is_empty() {
            notes
                .entry(module)
                .or_default()
                .left_out
                .push(member.clone());
            left_out.push(member);
            continue;
        }
        log_bytes += bytes;
        kept.push((member, module, path));
    }
    kept.sort();
    let mut all_runs: Vec<Value> = Vec::new();
    let mut log_files = 0;
    for (member, module, path) in &kept {
        let module_notes = notes.entry(module.clone()).or_default();
        let Ok(raw) = fs::read(path) else {
            let unreadable = format!("{member} (unreadable)");
            module_notes.left_out.push(unreadable.clone());
            left_out.push(unreadable);
            continue;
        };
        let (bytes, redactions) = scrub(&raw, &secrets);
        let span = span_of(&bytes);
        let ended = module_notes.read(&bytes);
        module_notes.files += 1;
        module_notes.bytes += bytes.len() as u64;
        module_notes.redactions += redactions;
        let file_name = member.rsplit('/').next().unwrap_or(member);
        if let Some((process, started, pid)) = run_of(file_name) {
            let version = first_record(&bytes)
                .and_then(|r| r.get("version").cloned())
                .unwrap_or(Value::Null);
            let run = json!({
                "module": module, "process": process, "pid": pid, "started": started,
                "version": version, "file": member, "ended": ended,
                "firstTs": span["firstTs"], "lastTs": span["lastTs"],
            });
            module_notes.runs.push(run.clone());
            all_runs.push(run);
        }
        if module == ENGINE_MODULE {
            module_notes
                .engine_starts
                .extend(engine_start_records(&bytes));
        }
        members.push(Member {
            path: member.clone(),
            bytes,
            redactions,
            extra: span,
        });
        log_files += 1;
    }

    // 2. The as-run log, when there is one. It belongs to the channel, not to a module.
    let mut as_run_files = 0;
    let as_run_dir = options.log_root.join(AS_RUN_FOLDER);
    if let Ok(files) = fs::read_dir(&as_run_dir) {
        let mut names: Vec<(String, PathBuf)> = files
            .flatten()
            .filter(|f| f.file_name().to_string_lossy().ends_with(".jsonl"))
            .filter(|f| modified_within(&f.path(), cutoff).is_some())
            .map(|f| (f.file_name().to_string_lossy().into_owned(), f.path()))
            .collect();
        names.sort();
        for (name, path) in names {
            let Ok(raw) = fs::read(&path) else { continue };
            let (bytes, redactions) = scrub(&raw, &secrets);
            let span = span_of(&bytes);
            members.push(Member {
                path: format!("{AS_RUN_FOLDER}/{name}"),
                bytes,
                redactions,
                extra: span,
            });
            as_run_files += 1;
        }
    }

    // 3. Versions and the hash of each executable, each named with its module.
    let mut binaries: Vec<Value> = Vec::new();
    for dir in &options.binary_dirs {
        let Ok(files) = fs::read_dir(dir) else {
            continue;
        };
        let mut found: Vec<PathBuf> = files
            .flatten()
            .map(|f| f.path())
            .filter(|p| p.is_file() && is_gx_executable(p))
            .collect();
        found.sort();
        for path in found {
            if let Some(entry) = binary_entry(&path, home) {
                binaries.push(entry);
            }
        }
    }
    let versions = json!({
        "collector": { "name": "gx-diag", "version": env!("CARGO_PKG_VERSION") },
        "runs": all_runs,
        "binaries": binaries,
    });
    push_json(&mut members, "versions.json", &versions, &secrets);

    // 4. The capability surface.
    let capability = json!({
        "protocolVersion": gx_contracts::PROTOCOL_VERSION,
        "surface": serde_json::to_value(gx_contracts::mcp::capability_surface()).unwrap_or(Value::Null),
    });
    push_json(&mut members, "capability.json", &capability, &secrets);

    // 5. The sanitised configuration.
    let mut variables = BTreeMap::new();
    for (name, value) in &options.environment {
        let shown = if is_secret_name(name) {
            "<redacted>".to_owned()
        } else {
            let (clean, _) = scrub(value.as_bytes(), &secrets);
            anonymise(&String::from_utf8_lossy(&clean), home)
        };
        variables.insert(name.clone(), shown);
    }
    let roots: BTreeMap<&String, String> = options
        .roots
        .iter()
        .map(|(name, path)| (name, anonymise(path, home)))
        .collect();
    let environment = json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "roots": roots,
        "variables": variables,
        "notCollected": "launch arguments of running processes, the user name, the host name, and any variable not named GX_*",
    });
    push_json(&mut members, "environment.json", &environment, &secrets);

    // 6. The engine's own: the device and adapter it reported, and what its
    // recovery journal holds, never the scene bodies. Only with the engine module.
    let mut recovery_present = false;
    let engine_in_bundle =
        wanted(ENGINE_MODULE) && (options.modules.is_empty() || notes.contains_key(ENGINE_MODULE));
    if engine_in_bundle {
        let journal_found = options
            .journal
            .as_ref()
            .map(|journal| (journal, fs::read(journal)));
        let engine_has_anything =
            notes.contains_key(ENGINE_MODULE) || matches!(&journal_found, Some((_, Ok(_))));
        if engine_has_anything {
            let engine = notes.entry(ENGINE_MODULE.to_owned()).or_default();
            let starts = std::mem::take(&mut engine.engine_starts);
            push_json(
                &mut members,
                &format!("modules/{ENGINE_MODULE}/devices.json"),
                &json!({ "source": "the engine's engine.start records in this module's logs", "starts": starts }),
                &secrets,
            );
            let recovery_path = format!("modules/{ENGINE_MODULE}/recovery.json");
            match journal_found {
                Some((journal, Ok(raw))) => {
                    recovery_present = true;
                    let summary = summarise_journal(&raw, journal, home);
                    push_json(&mut members, &recovery_path, &summary, &secrets);
                    let mut dropped = journal.as_os_str().to_owned();
                    dropped.push(".dropped.json");
                    if let Ok(report) = fs::read(PathBuf::from(dropped)) {
                        let (bytes, redactions) = scrub(&report, &secrets);
                        members.push(Member {
                            path: format!("modules/{ENGINE_MODULE}/recovery.dropped.json"),
                            bytes,
                            redactions,
                            extra: Value::Null,
                        });
                    }
                }
                Some((_, Err(source))) if source.kind() != io::ErrorKind::NotFound => {
                    recovery_present = true;
                    let note = json!({ "present": true, "unreadable": source.to_string() });
                    push_json(&mut members, &recovery_path, &note, &secrets);
                }
                _ => push_json(
                    &mut members,
                    &recovery_path,
                    &json!({ "present": false, "note": "no recovery journal was found where the engine keeps it on this machine" }),
                    &secrets,
                ),
            }
        }
    }

    // 7. Each module's summary.
    let mut module_list: Vec<Value> = Vec::new();
    let module_names: Vec<String> = notes.keys().cloned().collect();
    for (module, module_notes) in notes {
        let summary = module_notes.summary(&module, &binaries);
        module_list.push(json!({
            "module": module,
            "summary": format!("modules/{module}/summary.json"),
            "wroteInWindow": summary["wroteInWindow"],
            "logFiles": summary["logs"]["files"],
            "runs": summary["runs"].as_array().map_or(0, Vec::len),
            "errors": summary["records"]["byLevel"]["error"].as_u64().unwrap_or(0),
            "warnings": summary["records"]["byLevel"]["warn"].as_u64().unwrap_or(0),
            "refusals": summary["records"]["refusals"],
        }));
        push_json(
            &mut members,
            &format!("modules/{module}/summary.json"),
            &summary,
            &secrets,
        );
    }

    // The manifest, last, naming every other member.
    let mut redactions: Vec<Redaction> = Vec::new();
    let mut listed: Vec<Value> = Vec::new();
    for member in &members {
        if member.redactions > 0 {
            redactions.push(Redaction {
                member: member.path.clone(),
                count: member.redactions,
            });
        }
        let mut entry = json!({
            "path": member.path,
            "bytes": member.bytes.len(),
            "sha256": hex(&Sha256::digest(&member.bytes)),
            "redactions": member.redactions,
        });
        if let (Some(entry), Some(extra)) = (entry.as_object_mut(), member.extra.as_object()) {
            for (key, value) in extra {
                entry.insert(key.clone(), value.clone());
            }
        }
        listed.push(entry);
    }
    let manifest = json!({
        "format": BUNDLE_FORMAT,
        "createdAt": gx_telemetry::sink::rfc3339_utc(options.now),
        "windowHours": options.hours,
        "collector": { "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "logRoot": anonymise(&options.log_root.display().to_string(), home),
        "modulesRequested": if options.modules.is_empty() { json!("all") } else { json!(options.modules) },
        "modules": module_list,
        "sections": {
            "logs": { "files": log_files, "bytes": log_bytes, "leftOut": left_out },
            "asRun": if as_run_files > 0 {
                json!({ "present": true, "files": as_run_files })
            } else {
                json!({ "present": false, "note": "no as-run log was written in the window; the as-run record is build-plan row 12.11" })
            },
            "recovery": { "present": recovery_present, "sceneBodies": "never included" },
        },
        "credentialsRedacted": redactions.iter().map(|r| r.count).sum::<usize>(),
        "files": listed,
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap_or_default();

    let bytes = write_archive(&options.output, &members, &manifest_bytes)?;
    Ok(Collected {
        path: options.output.clone(),
        bytes,
        files: members.len(),
        log_files,
        modules: module_names,
        as_run_files,
        left_out,
        redactions,
    })
}

fn first_record(bytes: &[u8]) -> Option<Value> {
    bytes
        .split(|b| *b == b'\n')
        .find(|line| !line.is_empty())
        .and_then(|line| serde_json::from_slice(line).ok())
}

/// The device and adapter fields of each `engine.start` record in `bytes`.
fn engine_start_records(bytes: &[u8]) -> Vec<Value> {
    const KEYS: [&str; 9] = [
        "tier",
        "adapter",
        "live_capable",
        "rate",
        "locality",
        "clock",
        "reference",
        "token_required",
        "version",
    ];
    bytes
        .split(|b| *b == b'\n')
        .filter(|line| line.windows(14).any(|w| w == b"\"engine.start\""))
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter(|record| record.get("event").and_then(Value::as_str) == Some("engine.start"))
        .map(|record| {
            let fields = record.get("fields").cloned().unwrap_or(Value::Null);
            let mut picked = serde_json::Map::new();
            picked.insert(
                "ts".to_owned(),
                record.get("ts").cloned().unwrap_or(Value::Null),
            );
            picked.insert(
                "pid".to_owned(),
                record.get("pid").cloned().unwrap_or(Value::Null),
            );
            for key in KEYS {
                if let Some(value) = fields.get(key) {
                    picked.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(picked)
        })
        .collect()
}

fn is_gx_executable(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    let executable = cfg!(not(windows)) || name.ends_with(".exe");
    executable && stem.starts_with("gx-") && !stem.contains('.')
}

fn binary_entry(path: &Path, home: Option<&str>) -> Option<Value> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(gx_telemetry::sink::rfc3339_utc);
    Some(json!({
        "name": path.file_name()?.to_string_lossy(),
        "module": module_of_binary(&path.file_name()?.to_string_lossy()),
        "directory": anonymise(&path.parent()?.display().to_string(), home),
        "bytes": total,
        "sha256": hex(&hasher.finalize()),
        "modified": modified,
    }))
}

/// The journal's contents without the scene bodies: which takes it holds, their
/// revisions and hashes, how large each scene is, and the program and cue state.
fn summarise_journal(raw: &[u8], path: &Path, home: Option<&str>) -> Value {
    let location = anonymise(&path.display().to_string(), home);
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(gx_telemetry::sink::rfc3339_utc);
    let Ok(journal) = serde_json::from_slice::<Value>(raw) else {
        return json!({ "present": true, "path": location, "bytes": raw.len(), "unreadable": "the journal is not valid JSON" });
    };
    let scenes: Vec<Value> = journal
        .get("preparedScenes")
        .and_then(Value::as_array)
        .map(|scenes| {
            scenes
                .iter()
                .map(|scene| {
                    json!({
                        "takeId": scene.get("takeId"),
                        "revision": scene.get("revision"),
                        "documentBytes": scene.get("document").map_or(0, |d| serde_json::to_vec(d).map_or(0, |v| v.len())),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "present": true,
        "path": location,
        "bytes": raw.len(),
        "modified": modified,
        "schemaVersion": journal.get("schemaVersion"),
        "epoch": journal.get("epoch"),
        "published": journal.get("published"),
        "preparedScenes": scenes,
        "verifiedAssets": journal.get("verifiedAssets").and_then(Value::as_array).map_or(0, Vec::len),
        "cued": journal.get("cued"),
        "program": journal.get("program"),
        "revisionFloors": journal.get("revisionFloors"),
        "sceneBodies": "never included",
    })
}

fn push_json(members: &mut Vec<Member>, path: &str, value: &Value, secrets: &[String]) {
    let raw = serde_json::to_vec_pretty(value).unwrap_or_default();
    let (bytes, redactions) = scrub(&raw, secrets);
    members.push(Member {
        path: path.to_owned(),
        bytes,
        redactions,
        extra: Value::Null,
    });
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// Write the archive beside its name, read it back against the manifest and move
/// it into place. Returns its size.
fn write_archive(output: &Path, members: &[Member], manifest: &[u8]) -> Result<u64, DiagError> {
    let fail = |source: io::Error| DiagError::Write {
        path: output.to_path_buf(),
        source,
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(fail)?;
    }
    let mut partial = output.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    let written = (|| -> io::Result<()> {
        let file = fs::File::create(&partial)?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for member in members {
            archive
                .start_file(&member.path, options)
                .map_err(io::Error::other)?;
            archive.write_all(&member.bytes)?;
        }
        archive
            .start_file("manifest.json", options)
            .map_err(io::Error::other)?;
        archive.write_all(manifest)?;
        archive.finish().map_err(io::Error::other)?.sync_all()?;
        Ok(())
    })();
    if let Err(source) = written {
        let _ = fs::remove_file(&partial);
        return Err(fail(source));
    }
    if let Err(detail) = read_back(&partial, members, manifest) {
        let _ = fs::remove_file(&partial);
        return Err(DiagError::ReadBack { detail });
    }
    fs::rename(&partial, output).map_err(|source| {
        let _ = fs::remove_file(&partial);
        fail(source)
    })?;
    fs::metadata(output).map(|m| m.len()).map_err(fail)
}

/// Open the archive again and check every member against what was meant to go in.
fn read_back(path: &Path, members: &[Member], manifest: &[u8]) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut expected: BTreeMap<&str, &[u8]> = members
        .iter()
        .map(|m| (m.path.as_str(), m.bytes.as_slice()))
        .collect();
    expected.insert("manifest.json", manifest);
    if archive.len() != expected.len() {
        return Err(format!(
            "{} members written, {} meant",
            archive.len(),
            expected.len()
        ));
    }
    for index in 0..archive.len() {
        let mut member = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = member.name().to_owned();
        let mut bytes = Vec::new();
        member
            .read_to_end(&mut bytes)
            .map_err(|e| format!("{name}: {e}"))?;
        match expected.get(name.as_str()) {
            Some(want) if Sha256::digest(&bytes) == Sha256::digest(want) => {}
            Some(_) => return Err(format!("{name} reads back different from what was written")),
            None => return Err(format!("{name} was not meant to be in the archive")),
        }
    }
    Ok(())
}

/// Collect a bundle the way a shell's menu item does: this machine's defaults,
/// the archive in the log root's `bundles` folder, and the outcome on record.
pub fn export_for_shell(modules: &[String]) -> Result<Collected, DiagError> {
    let mut options = Options::for_this_machine(DEFAULT_HOURS)?;
    options.modules = modules.to_vec();
    let result = collect(&options);
    match &result {
        Ok(collected) => {
            tracing::info!(
                event = "diag.bundle",
                modules = collected.modules.join(",").as_str(),
                path = %collected.path.display(),
                files = collected.files,
                log_files = collected.log_files,
                as_run_files = collected.as_run_files,
                bytes = collected.bytes,
                credentials_redacted = collected.redacted(),
            );
            if collected.redacted() > 0 {
                // A credential in a log is a bug: say so loudly, naming where.
                let members: Vec<&str> = collected
                    .redactions
                    .iter()
                    .map(|r| r.member.as_str())
                    .collect();
                tracing::error!(
                    event = "diag.credential_found",
                    count = collected.redacted(),
                    members = members.join(",").as_str(),
                );
            }
        }
        Err(error) => tracing::error!(event = "diag.bundle_failed", detail = %error),
    }
    result
}

/// Open `folder` in the platform's file manager (Windows only, as [`reveal`]).
pub fn reveal_folder(folder: &Path) -> bool {
    if cfg!(windows) {
        std::process::Command::new("explorer.exe")
            .arg(folder)
            .spawn()
            .is_ok()
    } else {
        false
    }
}

/// Show `path` in the platform's file manager. Windows only (Windows is built
/// first); elsewhere nothing is opened and `false` says so.
pub fn reveal(path: &Path) -> bool {
    if cfg!(windows) {
        let mut argument = std::ffi::OsString::from("/select,");
        argument.push(path.as_os_str());
        std::process::Command::new("explorer.exe")
            .arg(argument)
            .spawn()
            .is_ok()
    } else {
        false
    }
}

#[cfg(test)]
mod tests;
