//! The as-run record (row 12.11, ADR-0004 section 5): what went to air, at whose command, and
//! the frame the engine committed it to.
//!
//! One file per channel and day, `<root>/as-run/<channel>-<date>.jsonl`, one JSON object per line.
//!
//! * **Durable.** A record is written, flushed and synced before the reply it describes leaves
//!   the server, so what an operator was shown is on disk. It never passes the bounded log queue,
//!   so it is never one of the "lost" events.
//! * **Tamper-evident.** Every record carries `prev`, the SHA-256 (lower-case hex) of the exact
//!   text of the line before it (64 zeros for the first of a file). Removing, reordering or
//!   editing a line breaks the chain at that line, and [`verify`] names it.
//! * **Never in the way.** A record that cannot be written is reported to the caller, who counts
//!   it and says so on the log; Program commands are still accepted (ADR-0004 decision 3).
//!
//! The chain starts afresh in each day's file: a whole file removed is not detected here.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// `prev` of the first record in a file.
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// What the server knows about one Program command and what the engine answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsRunEntry {
    /// The wire name: `cue`, `take`, `clear`, `phase`, `configureOutput`.
    pub request: &'static str,
    pub operator: String,
    /// The credential's subject (never the credential), or `unprotected`.
    pub subject: String,
    pub role: Option<String>,
    /// `accepted` or `refused`.
    pub result: &'static str,
    /// The refusal's code name when it was refused.
    pub refusal: Option<&'static str>,
    /// The layer of the channel it was aimed at (the main layer when it named none).
    pub layer: String,
    /// The take (page) the command named, when it named one.
    pub page: Option<String>,
    pub revision: Option<u64>,
    pub content_hash: Option<String>,
    /// The phase the command named, when it named one.
    pub phase: Option<String>,
    /// The frame the engine committed to, in its own timebase.
    pub committed_frame: Option<u64>,
}

/// An open as-run log for one channel.
pub struct AsRunLog {
    directory: PathBuf,
    channel: String,
    /// The date and file the log is writing now, and the chain's state in it.
    current: Option<Current>,
    /// Records that could not be written since the log opened.
    failures: u64,
}

struct Current {
    date: String,
    file: File,
    seq: u64,
    prev: String,
}

impl AsRunLog {
    /// Open the log for `channel` under `<root>/as-run`. The directory is made if it is not
    /// there; today's file is continued if it already exists (a restart carries on the chain).
    pub fn open(root: &Path, channel: &str) -> io::Result<Self> {
        let directory = root.join("as-run");
        fs::create_dir_all(&directory)?;
        let mut log = Self {
            directory,
            channel: channel.to_owned(),
            current: None,
            failures: 0,
        };
        log.ensure(&today())?;
        Ok(log)
    }

    /// The file a given date's records go to.
    pub fn path_for(&self, date: &str) -> PathBuf {
        self.directory
            .join(format!("{}-{date}.jsonl", self.channel))
    }

    /// How many records could not be written since this log opened.
    pub fn failures(&self) -> u64 {
        self.failures
    }

    /// Write one record and sync it. On failure the count goes up and the error is returned;
    /// the caller decides what to say, and never refuses the command because of it.
    pub fn record(&mut self, entry: &AsRunEntry) -> io::Result<()> {
        let result = self.write(entry, &timestamp());
        if result.is_err() {
            self.failures += 1;
            // A file that failed once is reopened for the next record, from what is on disk.
            self.current = None;
        }
        result
    }

    fn write(&mut self, entry: &AsRunEntry, now: &Stamp) -> io::Result<()> {
        self.ensure(&now.date)?;
        let current = self.current.as_mut().expect("ensure opened the file");
        let seq = current.seq + 1;
        let line = serde_json::to_string(&serde_json::json!({
            "seq": seq,
            "prev": current.prev,
            "ts": now.text,
            "channel": self.channel,
            "layer": entry.layer,
            "request": entry.request,
            "operator": entry.operator,
            "subject": entry.subject,
            "role": entry.role,
            "result": entry.result,
            "refusal": entry.refusal,
            "page": entry.page,
            "revision": entry.revision,
            "contentHash": entry.content_hash,
            "phase": entry.phase,
            "committedFrame": entry.committed_frame,
        }))
        .map_err(io::Error::other)?;
        current.file.write_all(line.as_bytes())?;
        current.file.write_all(b"\n")?;
        current.file.flush()?;
        current.file.sync_data()?;
        current.seq = seq;
        current.prev = digest(&line);
        Ok(())
    }

    /// Have `date`'s file open, continuing its chain if it already has records.
    fn ensure(&mut self, date: &str) -> io::Result<()> {
        if self.current.as_ref().is_some_and(|c| c.date == date) {
            return Ok(());
        }
        let path = self.path_for(date);
        let (seq, prev) = last_state(&path)?;
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        self.current = Some(Current {
            date: date.to_owned(),
            file,
            seq,
            prev,
        });
        Ok(())
    }
}

/// The sequence number and chain hash a file ends at: `(0, GENESIS)` for a new one.
fn last_state(path: &Path) -> io::Result<(u64, String)> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok((0, GENESIS.to_owned()))
        }
        Err(error) => return Err(error),
    };
    let mut last = None;
    for line in BufReader::new(file).lines() {
        let line = line?;
        if !line.is_empty() {
            last = Some(line);
        }
    }
    Ok(match last {
        None => (0, GENESIS.to_owned()),
        Some(line) => {
            let seq = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|v| v["seq"].as_u64())
                .unwrap_or(0);
            (seq, digest(&line))
        }
    })
}

fn digest(line: &str) -> String {
    format!("{:x}", Sha256::digest(line.as_bytes()))
}

/// Where a file's chain is broken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainBreak {
    /// 1-based line number of the first line that does not follow its predecessor.
    pub line: usize,
    pub because: String,
}

impl std::fmt::Display for ChainBreak {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the as-run chain breaks at line {}: {}",
            self.line, self.because
        )
    }
}

/// Check a whole file: each record's `prev` is the digest of the line before it and its `seq`
/// follows. Returns the number of records, or the first line that does not belong.
pub fn verify(path: &Path) -> Result<u64, ChainBreak> {
    let file = File::open(path).map_err(|error| ChainBreak {
        line: 0,
        because: format!("cannot be read: {error}"),
    })?;
    let mut prev = GENESIS.to_owned();
    let mut seq = 0u64;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let number = index + 1;
        let line = line.map_err(|error| ChainBreak {
            line: number,
            because: format!("cannot be read: {error}"),
        })?;
        let value: serde_json::Value = serde_json::from_str(&line).map_err(|error| ChainBreak {
            line: number,
            because: format!("is not a record: {error}"),
        })?;
        if value["prev"].as_str() != Some(prev.as_str()) {
            return Err(ChainBreak {
                line: number,
                because: "its prev is not the digest of the line before it".to_owned(),
            });
        }
        if value["seq"].as_u64() != Some(seq + 1) {
            return Err(ChainBreak {
                line: number,
                because: format!("its seq is not {}", seq + 1),
            });
        }
        seq += 1;
        prev = digest(&line);
    }
    Ok(seq)
}

struct Stamp {
    date: String,
    text: String,
}

fn timestamp() -> Stamp {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    stamp(since.as_secs(), since.subsec_micros())
}

fn stamp(secs: u64, micros: u32) -> Stamp {
    let (year, month, day) = civil((secs / 86_400) as i64);
    let rem = secs % 86_400;
    let date = format!("{year:04}-{month:02}-{day:02}");
    let text = format!(
        "{date}T{:02}:{:02}:{:02}.{micros:06}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    );
    Stamp { date, text }
}

fn today() -> String {
    timestamp().date
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "gx-as-run-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn entry(request: &'static str, frame: Option<u64>) -> AsRunEntry {
        AsRunEntry {
            request,
            operator: "Asha Rao".to_owned(),
            subject: "playout-1".to_owned(),
            role: Some("Playout".to_owned()),
            result: "accepted",
            refusal: None,
            layer: "main".to_owned(),
            page: Some("lower-third".to_owned()),
            revision: Some(4),
            content_hash: Some("ab".repeat(32)),
            phase: None,
            committed_frame: frame,
        }
    }

    fn lines(path: &Path) -> Vec<String> {
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn rewrite(path: &Path, lines: &[String]) {
        let mut text = lines.join("\n");
        text.push('\n');
        fs::write(path, text).unwrap();
    }

    fn five(root: &Path) -> (AsRunLog, PathBuf) {
        let mut log = AsRunLog::open(root, "program").unwrap();
        for n in 0..5 {
            log.record(&entry("take", Some(100 + n))).unwrap();
        }
        let path = log.path_for(&today());
        (log, path)
    }

    #[test]
    fn a_record_carries_who_what_and_the_committed_frame_and_the_chain_verifies() {
        let root = root();
        let (_log, path) = five(&root);
        assert_eq!(verify(&path), Ok(5));
        let first: serde_json::Value = serde_json::from_str(&lines(&path)[0]).unwrap();
        assert_eq!(first["seq"], 1);
        assert_eq!(first["prev"], GENESIS);
        assert_eq!(first["operator"], "Asha Rao");
        assert_eq!(first["subject"], "playout-1");
        assert_eq!(first["request"], "take");
        assert_eq!(first["page"], "lower-third");
        assert_eq!(first["revision"], 4);
        assert_eq!(first["committedFrame"], 100);
        assert_eq!(first["channel"], "program");
        assert_eq!(first["layer"], "main");
        assert!(first["ts"].as_str().unwrap().ends_with('Z'));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_file_is_named_for_its_channel_and_day() {
        let root = root();
        let log = AsRunLog::open(&root, "program").unwrap();
        let path = log.path_for("2026-11-19");
        assert!(
            path.ends_with("as-run/program-2026-11-19.jsonl")
                || path.ends_with("as-run\\program-2026-11-19.jsonl")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_edited_line_breaks_the_chain_at_the_next_line() {
        let root = root();
        let (_log, path) = five(&root);
        let mut all = lines(&path);
        all[1] = all[1].replace("\"committedFrame\":101", "\"committedFrame\":999");
        rewrite(&path, &all);
        let broken = verify(&path).unwrap_err();
        assert_eq!(
            broken.line, 3,
            "the edit is found where the chain stops matching: {broken}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_removed_line_is_found_where_it_was() {
        let root = root();
        let (_log, path) = five(&root);
        let mut all = lines(&path);
        all.remove(2);
        rewrite(&path, &all);
        assert_eq!(verify(&path).unwrap_err().line, 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn two_lines_swapped_are_found() {
        let root = root();
        let (_log, path) = five(&root);
        let mut all = lines(&path);
        all.swap(1, 2);
        rewrite(&path, &all);
        assert_eq!(verify(&path).unwrap_err().line, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_removed_last_line_is_not_a_break_but_a_shorter_chain() {
        let root = root();
        let (_log, path) = five(&root);
        let mut all = lines(&path);
        all.pop();
        rewrite(&path, &all);
        assert_eq!(
            verify(&path),
            Ok(4),
            "a tail cannot be told from a shorter day by the chain alone"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_restart_carries_the_chain_on() {
        let root = root();
        let (log, path) = five(&root);
        drop(log);
        let mut again = AsRunLog::open(&root, "program").unwrap();
        again.record(&entry("clear", Some(200))).unwrap();
        assert_eq!(verify(&path), Ok(6));
        let last: serde_json::Value = serde_json::from_str(lines(&path).last().unwrap()).unwrap();
        assert_eq!(last["seq"], 6);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_refusal_is_a_record_too() {
        let root = root();
        let mut log = AsRunLog::open(&root, "program").unwrap();
        let mut refused = entry("take", None);
        refused.result = "refused";
        refused.refusal = Some("RevisionMismatch");
        log.record(&refused).unwrap();
        let line: serde_json::Value =
            serde_json::from_str(&lines(&log.path_for(&today()))[0]).unwrap();
        assert_eq!(line["result"], "refused");
        assert_eq!(line["refusal"], "RevisionMismatch");
        assert!(line["committedFrame"].is_null());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_record_that_cannot_be_written_is_counted_and_the_log_recovers() {
        let root = root();
        let mut log = AsRunLog::open(&root, "program").unwrap();
        log.record(&entry("take", Some(1))).unwrap();
        let real = log.directory.clone();
        // The place it writes to goes away (a failed drive, a removed folder).
        log.directory = root.join("gone").join("deeper");
        log.current = None;
        assert!(log.record(&entry("take", Some(2))).is_err());
        assert_eq!(log.failures(), 1, "the failure is counted");
        // It comes back: the chain carries on from what is on disk, with nothing in between.
        log.directory = real;
        log.record(&entry("take", Some(3))).unwrap();
        assert_eq!(verify(&log.path_for(&today())), Ok(2));
        assert_eq!(log.failures(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_new_day_starts_a_new_file_and_chain() {
        let root = root();
        let mut log = AsRunLog::open(&root, "program").unwrap();
        let day_one = stamp(1_000_000_000, 0);
        let day_two = stamp(1_000_086_400, 0);
        log.write(&entry("take", Some(1)), &day_one).unwrap();
        log.write(&entry("take", Some(2)), &day_two).unwrap();
        assert_eq!(verify(&log.path_for(&day_one.date)), Ok(1));
        assert_eq!(verify(&log.path_for(&day_two.date)), Ok(1));
        assert_ne!(day_one.date, day_two.date);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_civil_date_is_right() {
        assert_eq!(stamp(0, 0).text, "1970-01-01T00:00:00.000000Z");
        assert_eq!(stamp(951_782_400, 5).text, "2000-02-29T00:00:00.000005Z");
        assert_eq!(stamp(1_700_000_000, 0).text, "2023-11-14T22:13:20.000000Z");
    }
}
