//! 2.12 (ADR-0004): every process a conformance run starts writes its own
//! JSON Lines log, and what the run drove is in it.
//!
//! The run gives all its processes one scratch log folder
//! ([`run_log_directory`]) at the default level ([`logged`] removes any level
//! override from the caller's environment), then reads each process's file
//! back by the pid in its name: the render worker the control-plane suite
//! drove, the protected worker the scope suite drove, the engine host, and
//! the Editor's MCP server. The two windowed shells are not started here; a
//! conformance run opens no window.

use std::io::{BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde_json::Value;

use crate::{expect, Outcome, Report};

const PLANE: &str = "log";

/// Where this run's processes write their logs: one scratch folder a run,
/// never the operator's log root.
pub fn run_log_directory() -> &'static Path {
    static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
    DIRECTORY.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        std::env::temp_dir().join(format!(
            "gx-conformance-logs-{}-{nanos}",
            std::process::id()
        ))
    })
}

/// Have `command` log as a product does by default, into this run's folder:
/// `GX_LOG_DIR` names the folder, and a level set in the caller's environment
/// is removed, so what the run reads back is the default level.
pub fn logged(command: &mut Command) -> &mut Command {
    command
        .env("GX_LOG_DIR", run_log_directory())
        .env_remove("GX_LOG")
        .env_remove("RUST_LOG")
}

/// A product binary built beside the conformance executable, or one folder up
/// (where Cargo puts binaries when this runs from `deps`).
fn beside(name: &str) -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let directory = current.parent()?;
    [directory.join(&file), directory.parent()?.join(&file)]
        .into_iter()
        .find(|candidate| candidate.exists())
}

/// Remove this run's log folder. Called for a run with nothing to look into;
/// a failed run keeps it.
pub fn remove_run_logs() {
    let _ = std::fs::remove_dir_all(run_log_directory());
}

/// The parts of a log file name, `<process>-<UTC start>-<pid>-<part>.jsonl`:
/// the process, the pid and the part.
fn name_parts(path: &Path) -> Option<(String, u32, u32)> {
    let stem = path.file_name()?.to_str()?.strip_suffix(".jsonl")?;
    let mut from_right = stem.rsplitn(3, '-');
    let part = from_right.next()?.parse().ok()?;
    let pid = from_right.next()?.parse().ok()?;
    let (process, _started) = from_right.next()?.rsplit_once('-')?;
    Some((process.to_owned(), pid, part))
}

/// Every whole line of one file, parsed. A process the run killed may leave
/// its last line unfinished; a line with no end is not a line it wrote.
fn parse_file(path: &Path) -> Result<Vec<Value>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let whole = text
        .rsplit_once('\n')
        .map_or("", |(whole, _unfinished)| whole);
    whole
        .lines()
        .enumerate()
        .map(|(index, line)| {
            serde_json::from_str(line)
                .map_err(|e| format!("{} line {}: {e}", path.display(), index + 1))
        })
        .collect()
}

/// What one process wrote: every record of every part of its file, in order.
struct ProcessLog {
    records: Vec<Value>,
}

impl ProcessLog {
    fn read(product: &str, process: &str, pid: u32) -> Result<Self, String> {
        let directory = run_log_directory().join(product);
        let mut parts: Vec<(u32, PathBuf)> = std::fs::read_dir(&directory)
            .map_err(|e| format!("{} cannot be read: {e}", directory.display()))?
            .flatten()
            .map(|entry| entry.path())
            .filter_map(|path| match name_parts(&path) {
                Some((named, named_pid, part)) if named == process && named_pid == pid => {
                    Some((part, path))
                }
                _ => None,
            })
            .collect();
        if parts.is_empty() {
            return Err(format!(
                "no {process} log file for pid {pid} in {}",
                directory.display()
            ));
        }
        parts.sort();
        let mut records = Vec::new();
        for (_, path) in parts {
            records.extend(parse_file(&path)?);
        }
        Ok(Self { records })
    }

    /// [`Self::read`], read again until `ready` holds or five seconds pass.
    ///
    /// A process that is still running writes through its own thread, which
    /// never makes the caller wait; the record of what it was just driven to
    /// do may be a moment behind. The last read is returned either way, so a
    /// record that never comes is reported by the check that wanted it.
    fn read_when(
        product: &str,
        process: &str,
        pid: u32,
        ready: impl Fn(&Self) -> bool,
    ) -> Result<Self, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let read = Self::read(product, process, pid);
            let settled = match &read {
                Ok(log) => ready(log),
                // Not written yet, or not whole yet.
                Err(_) => false,
            };
            if settled || std::time::Instant::now() >= deadline {
                return read;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    fn events<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
        self.records.iter().filter(move |r| r["event"] == name)
    }

    fn last_event(&self) -> &str {
        self.records
            .last()
            .and_then(|r| r["event"].as_str())
            .unwrap_or("nothing")
    }
}

/// Why a record does not carry the schema's fields (ADR-0004 §1), if it does
/// not.
fn schema_fault(record: &Value) -> Option<String> {
    let text = |key: &str| record[key].as_str().is_some_and(|value| !value.is_empty());
    let ts = record["ts"].as_str().unwrap_or_default();
    let whole = ts.len() == "2026-11-16T08:45:01.303118Z".len()
        && ts.ends_with('Z')
        && ts.as_bytes().get(10) == Some(&b'T');
    let level = matches!(
        record["level"].as_str(),
        Some("error" | "warn" | "info" | "debug" | "trace")
    );
    // The sink's own two records about the sequence carry no number of
    // their own; every other record does.
    let own = matches!(record["event"].as_str(), Some("log.lost" | "log.stop"));
    let seq = if own {
        record["seq"].is_null()
    } else {
        record["seq"].as_u64().is_some_and(|seq| seq >= 1)
    };
    let fault = if !whole {
        "ts is not UTC RFC 3339 with microseconds"
    } else if record["mono"].as_u64().is_none() {
        "mono is not a count of nanoseconds"
    } else if !seq {
        "seq is not this record's number"
    } else if !text("process") || !text("version") || !text("event") || !text("target") {
        "process, version, event or target is missing"
    } else if record["pid"].as_u64().is_none() {
        "pid is missing"
    } else if !level {
        "level is not one of the five"
    } else if !record["fields"].is_object() && !record["fields"].is_null() {
        "fields is not an object"
    } else {
        return None;
    };
    Some(format!("{fault}: {record}"))
}

/// Why a file's sequence is not whole, if it is not: `seq` counts from 1, and
/// the only gap allowed is one a `log.lost` record states, where it happened.
fn sequence_fault(records: &[Value]) -> Option<String> {
    // `due` is the next number owed; `written` the last one in the file.
    let (mut due, mut written) = (1u64, 0u64);
    for record in records {
        match record["event"].as_str() {
            Some("log.lost") => {
                let (from, to) = (
                    record["fields"]["fromSeq"].as_u64(),
                    record["fields"]["toSeq"].as_u64(),
                );
                match (from, to) {
                    (Some(from), Some(to)) if from == due && to >= from => due = to + 1,
                    _ => return Some(format!("a loss stated out of place at {due}: {record}")),
                }
            }
            Some("log.stop") => {
                if record["fields"]["lastSeq"].as_u64() != Some(written) {
                    return Some(format!("log.stop names another last line than {written}"));
                }
            }
            _ => match record["seq"].as_u64() {
                Some(seq) if seq == due => {
                    written = seq;
                    due += 1;
                }
                other => return Some(format!("seq {other:?} where {due} was due")),
            },
        }
    }
    None
}

/// Why the heartbeats' counts of late and missed frames differ from the
/// frames on record, if they do. Each heartbeat carries the engine's totals;
/// by then every late frame has its `frame.late` record and every missed run
/// its `frame.missed`, so the two must agree at every heartbeat.
fn anomaly_fault(records: &[Value]) -> Option<String> {
    let (mut late, mut missed) = (0u64, 0u64);
    for record in records {
        match record["event"].as_str() {
            Some("frame.late") => late += 1,
            Some("frame.missed") => missed += record["fields"]["missed"].as_u64().unwrap_or(0),
            // A stated loss may have taken anomaly records with it: the
            // comparison no longer holds for this file.
            Some("log.lost") => return None,
            Some("engine.heartbeat") => {
                let counted = (
                    record["fields"]["late"].as_u64(),
                    record["fields"]["missed"].as_u64(),
                );
                if counted != (Some(late), Some(missed)) {
                    return Some(format!(
                        "a heartbeat counts {counted:?} late and missed where the records before it say ({late}, {missed}): {record}"
                    ));
                }
            }
            _ => {}
        }
    }
    None
}

fn record(report: &mut Report, name: &'static str, outcome: Result<(), String>) {
    report.record(
        PLANE,
        name,
        match outcome {
            Ok(()) => Outcome::Pass,
            Err(why) => Outcome::Fail(why),
        },
    );
}

fn require(condition: bool, failure: impl FnOnce() -> String) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(failure())
    }
}

/// The render worker the control-plane, preview, asset and headless suites
/// just drove over `control`, read from its own file.
pub fn engine_log_suite(pid: u32, control: SocketAddr, report: &mut Report) {
    // Ready when the client the suites used has been seen to leave: the last
    // thing the run did to this engine.
    let log = match ProcessLog::read_when("engine", "worker", pid, |log| {
        log.events("control.disconnected")
            .any(|r| r["fields"]["reason"] == "closed by the client")
    }) {
        Ok(log) => log,
        Err(why) => {
            report.record(
                PLANE,
                "the render worker writes its own log file",
                Outcome::Fail(why),
            );
            return;
        }
    };
    let records = &log.records;

    let start = log.events("engine.start").next();
    record(
        report,
        "the render worker writes its own log file, opened by log.start and engine.start",
        require(
            records.first().is_some_and(|r| r["event"] == "log.start"),
            || format!("the file opens with {:?}", records.first()),
        )
        .and_then(|()| start.ok_or_else(|| "no engine.start".to_owned()))
        .and_then(|start| {
            require(
                start["fields"]["control"] == control.to_string()
                    && start["epoch"].as_u64().is_some()
                    && start["fields"]["tier"].is_string()
                    && start["fields"]["token_required"] == false,
                || format!("engine.start does not describe this engine: {start}"),
            )
        }),
    );

    let committed = log.events("program.take").find(|r| {
        r["fields"]["result"] == "committed"
            && r["frame"].as_u64().is_some()
            && r["fields"]["take_id"].is_string()
            && r["fields"]["revision"].as_u64().is_some()
    });
    record(
        report,
        "a take the engine committed is in its log with the take, revision and committed frame",
        committed
            .map(|_| ())
            .ok_or_else(|| "no committed program.take with its frame".to_owned()),
    );

    let refused = records.iter().find(|r| {
        r["event"]
            .as_str()
            .is_some_and(|event| event.starts_with("program."))
            && r["fields"]["result"] == "refused"
            && r["refusal"].is_string()
            && r["fields"]["detail"].is_string()
    });
    record(
        report,
        "a Program request the engine refused is in its log with the refusal code and detail",
        refused
            .map(|_| ())
            .ok_or_else(|| "no refused program request with its code".to_owned()),
    );

    record(
        report,
        "a publish and a headless render are in the engine's log",
        require(log.events("publish.accepted").next().is_some(), || {
            "no publish.accepted".to_owned()
        })
        .and_then(|()| {
            require(
                log.events("render.request")
                    .any(|r| r["fields"]["result"] == "rendered"),
                || "no render.request that rendered".to_owned(),
            )
        }),
    );

    record(
        report,
        "a client connecting and leaving is in the engine's log",
        require(log.events("control.connected").next().is_some(), || {
            "no control.connected".to_owned()
        })
        .and_then(|()| {
            require(
                log.events("control.disconnected")
                    .any(|r| r["fields"]["reason"] == "closed by the client"),
                || "no control.disconnected for a client that left".to_owned(),
            )
        }),
    );

    // The default level: every heartbeat a second apart, and the status
    // polls this run made are not in the file.
    let beats: Vec<u64> = log
        .events("engine.heartbeat")
        .filter_map(|r| r["mono"].as_u64())
        .collect();
    let lifetime = records
        .last()
        .and_then(|r| r["mono"].as_u64())
        .unwrap_or(0)
        .saturating_sub(beats.first().copied().unwrap_or(0));
    let seconds = lifetime / 1_000_000_000;
    let too_close = beats
        .windows(2)
        .find(|pair| pair[1].saturating_sub(pair[0]) < 990_000_000);
    // The polls a client makes (capability, status, performance) are written
    // at `debug`, never at the default level. Checked by what was written, not
    // by level alone: a poll recorded at `info` is at the default level and is
    // the fault.
    let quiet = records.iter().find(|r| {
        matches!(r["level"].as_str(), Some("debug" | "trace"))
            || matches!(
                r["event"].as_str(),
                Some("engine.capability" | "engine.status" | "engine.performance")
            )
    });
    record(
        report,
        "at the default level the heartbeat is written once a second and a status poll is not written",
        require(too_close.is_none(), || {
            format!("two heartbeats less than a second apart: {too_close:?}")
        })
        .and_then(|()| {
            // At least one every two seconds of the engine's life: it keeps
            // coming, on a machine whose render loop was held up now and then.
            require(beats.len() as u64 >= (seconds / 2).max(1), || {
                format!("{} heartbeats in {seconds} s", beats.len())
            })
        })
        .and_then(|()| {
            require(quiet.is_none(), || {
                format!("a debug record at the default level: {quiet:?}")
            })
        }),
    );
}

/// The worker started with a control-port secret, which the scope suite just
/// drove with an author credential and a Playout one.
pub fn protected_engine_log_suite(pid: u32, report: &mut Report) {
    let log = match ProcessLog::read_when("engine", "worker", pid, |log| {
        log.events("control.refused")
            .any(|r| r["refusal"] == "scopeNotGranted")
    }) {
        Ok(log) => log,
        Err(why) => {
            report.record(
                PLANE,
                "the protected render worker writes its own log file",
                Outcome::Fail(why),
            );
            return;
        }
    };
    let authenticated = log.events("control.authenticated").find(|r| {
        r["fields"]["subject"].is_string()
            && r["fields"]["role"].is_string()
            && r["fields"]["scopes"].is_string()
    });
    record(
        report,
        "a credential the engine accepted is in its log by subject, role and scopes",
        require(
            log.events("engine.start")
                .any(|r| r["fields"]["token_required"] == true),
            || "engine.start does not say a token is required".to_owned(),
        )
        .and_then(|()| {
            authenticated
                .map(|_| ())
                .ok_or_else(|| "no control.authenticated".to_owned())
        }),
    );
    let denied = log.events("control.refused").find(|r| {
        r["refusal"] == "scopeNotGranted"
            && r["fields"]["subject"].is_string()
            && r["fields"]["request"].is_string()
    });
    record(
        report,
        "a request outside a credential's scopes is in the engine's log with the request and who asked",
        denied
            .map(|_| ())
            .ok_or_else(|| "no control.refused for scopeNotGranted".to_owned()),
    );
}

/// Run the engine host against the engine listening on `port`, which it must
/// adopt, and read the host's own file: start, the engine it found, exit,
/// and the log finished.
pub fn host_log_suite(worker: &Path, port: u16, epoch: Option<u64>, report: &mut Report) {
    const NAME: &str =
        "the engine host writes its own log file, from its start to the engine it adopted to a stated stop";
    let (Some(host), Some(epoch)) = (beside("gx-engine-host"), epoch) else {
        report.record(
            PLANE,
            NAME,
            Outcome::Skip(
                "the gx-engine-host binary is not built, or the engine did not answer status"
                    .to_owned(),
            ),
        );
        return;
    };
    let host = host.as_path();
    let packages = run_log_directory().join("host-packages");
    let spawned = logged(Command::new(host).args(["--port", &port.to_string(), "--worker"]))
        .arg(worker)
        .env("GX_EDITOR_PACKAGE_DIR", &packages)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            report.record(
                PLANE,
                NAME,
                Outcome::Skip(format!("could not run the host: {e}")),
            );
            return;
        }
    };
    let pid = child.id();
    let status = child.wait();
    let outcome = status
        .map_err(|e| e.to_string())
        .and_then(|status| {
            require(status.success(), || {
                format!("the host exited with {status} beside a running engine")
            })
        })
        .and_then(|()| ProcessLog::read("engine", "host", pid))
        .and_then(|log| {
            let ready = log.events("host.engine_ready").next();
            require(
                log.records
                    .first()
                    .is_some_and(|r| r["event"] == "log.start")
                    && log
                        .events("host.start")
                        .any(|r| r["fields"]["port"] == port),
                || "the file does not open with log.start and host.start for this port".to_owned(),
            )
            .and_then(|()| {
                require(
                    ready.is_some_and(|r| {
                        r["fields"]["provenance"] == "adopted" && r["epoch"] == epoch
                    }),
                    || format!("host.engine_ready is not this engine, adopted: {ready:?}"),
                )
            })
            .and_then(|()| {
                require(
                    log.events("host.exit").next().is_some() && log.last_event() == "log.stop",
                    || {
                        format!(
                            "the file ends with {}, not host.exit and log.stop",
                            log.last_event()
                        )
                    },
                )
            })
        });
    record(report, NAME, outcome);
}

/// Start the Editor's MCP server on stdio, make one call it answers and one
/// it refuses, close it, and read its file.
pub fn mcp_log_suite(report: &mut Report) {
    const FILE: &str =
        "the Editor MCP server writes its own log file, from its start to a stated stop";
    const CALLS: &str =
        "a tool call answered and a tool call refused are in the MCP server's log with tool, scope, duration and refusal code";
    const STDOUT: &str = "the MCP server's standard output carries only the protocol";
    let Some(binary) = beside("gx-editor-mcp") else {
        report.record(
            PLANE,
            FILE,
            Outcome::Skip("the gx-editor-mcp binary is not built".to_owned()),
        );
        return;
    };
    let root = run_log_directory().join("mcp-store");
    if let Err(e) = std::fs::create_dir_all(&root) {
        report.record(PLANE, FILE, Outcome::Skip(format!("no scratch store: {e}")));
        return;
    }
    let spawned = logged(Command::new(binary).arg("--root").arg(&root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            report.record(
                PLANE,
                FILE,
                Outcome::Skip(format!("could not run the server: {e}")),
            );
            return;
        }
    };
    let pid = child.id();
    let spoken = (|| -> Result<Vec<String>, String> {
        let mut input = child.stdin.take().ok_or("no stdin")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        let mut lines = Vec::new();
        let mut send = |message: Value| -> Result<(), String> {
            writeln!(input, "{message}")
                .and_then(|()| input.flush())
                .map_err(|e| e.to_string())
        };
        let mut read = |lines: &mut Vec<String>| -> Result<(), String> {
            let mut line = String::new();
            match output.read_line(&mut line) {
                Ok(0) => Err("the server closed its output before answering".to_owned()),
                Ok(_) => {
                    lines.push(line);
                    Ok(())
                }
                Err(e) => Err(e.to_string()),
            }
        };
        send(
            serde_json::json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": { "name": "gx-conformance", "version": "1" } } }),
        )?;
        read(&mut lines)?;
        send(serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
        send(
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "project.create",
                "arguments": { "project": "log-check", "idempotencyKey": "conformance-log-1" } } }),
        )?;
        read(&mut lines)?;
        send(
            serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "scenes.create",
                "arguments": { "project": "no-such-project", "sceneId": "s", "name": "S" } } }),
        )?;
        read(&mut lines)?;
        Ok(lines)
        // `input` drops here: the client closes the connection.
    })();
    let exited = child.wait();
    let lines = match spoken {
        Ok(lines) => lines,
        Err(why) => {
            report.record(
                PLANE,
                FILE,
                Outcome::Fail(format!("the exchange failed: {why}")),
            );
            return;
        }
    };
    let log = match ProcessLog::read("mcp", "editor-mcp", pid) {
        Ok(log) => log,
        Err(why) => {
            report.record(PLANE, FILE, Outcome::Fail(why));
            return;
        }
    };
    let events: Vec<&str> = log
        .records
        .iter()
        .filter_map(|r| r["event"].as_str())
        .collect();
    record(
        report,
        FILE,
        require(exited.as_ref().is_ok_and(|status| status.success()), || {
            format!("the server exited with {exited:?} when its client closed")
        })
        .and_then(|()| {
            require(
                events.first() == Some(&"log.start")
                    && log
                        .events("mcp.start")
                        .any(|r| r["fields"]["transport"] == "stdio"),
                || format!("the file does not open with log.start and mcp.start: {events:?}"),
            )
        })
        .and_then(|()| {
            require(
                events.ends_with(&["mcp.stop", "log.stop"])
                    && log
                        .events("mcp.stop")
                        .any(|r| r["fields"]["reason"] == "the client closed the connection"),
                || format!("the file does not end with mcp.stop and log.stop: {events:?}"),
            )
        }),
    );
    let answered = log.events("mcp.call").find(|r| {
        r["fields"]["result"] == "ok"
            && r["fields"]["tool"] == "project.create"
            && r["fields"]["scope"] == "Author"
            && r["fields"]["idempotency_key"] == "conformance-log-1"
            && r["fields"]["duration_us"].as_u64().is_some()
    });
    let refused = log.events("mcp.call").find(|r| {
        r["fields"]["result"] == "refused"
            && r["fields"]["tool"] == "scenes.create"
            && r["refusal"] == "projectNotFound"
    });
    record(
        report,
        CALLS,
        require(answered.is_some(), || {
            format!(
                "no answered project.create among {:?}",
                log.events("mcp.call").collect::<Vec<_>>()
            )
        })
        .and_then(|()| {
            require(refused.is_some(), || {
                "no refused scenes.create with projectNotFound".to_owned()
            })
        }),
    );
    let stray = lines.iter().find(|line| {
        serde_json::from_str::<Value>(line).map_or(true, |value| value["jsonrpc"] != "2.0")
    });
    report.record(
        PLANE,
        STDOUT,
        expect(
            stray.is_none(),
            format!("a line on stdout that is not JSON-RPC: {stray:?}"),
        ),
    );
}

/// Every file every process of this run wrote: each line parses and carries
/// the schema's fields, no sequence has an unstated gap, every late or missed
/// frame a heartbeat counts has its own record, and no credential is in any
/// of them. `secrets` are the control-port secrets the run used.
pub fn run_log_suite(secrets: &[&str], report: &mut Report) {
    const LINES: &str = "every line every process wrote parses and carries the schema's fields";
    const SEQUENCE: &str =
        "no log file has a gap in its sequence that a log.lost record does not state";
    const ANOMALIES: &str =
        "every late frame and missed frame a heartbeat counts has its own record";
    const SECRETS: &str = "no credential the run used is in any log file";

    let mut files: Vec<PathBuf> = Vec::new();
    for product in ["engine", "mcp", "editor", "playout"] {
        if let Ok(entries) = std::fs::read_dir(run_log_directory().join(product)) {
            files.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| name_parts(path).is_some()),
            );
        }
    }
    files.sort();
    if files.is_empty() {
        for name in [LINES, SEQUENCE, ANOMALIES, SECRETS] {
            report.record(
                PLANE,
                name,
                Outcome::Skip("no process of this run wrote a log file".to_owned()),
            );
        }
        return;
    }

    let (mut lines, mut sequence, mut anomalies, mut secret) = (None, None, None, None);
    let (mut late, mut heartbeats) = (0u64, 0u64);
    for path in &files {
        let name = path.display();
        match std::fs::read_to_string(path) {
            // A gx1 credential is `gx1.<payload>.<mac>`: its prefix alone is
            // enough to say one was written.
            Ok(text) => {
                if let Some(found) = secrets
                    .iter()
                    .copied()
                    .chain(["gx1."])
                    .find(|secret| text.contains(secret))
                {
                    secret.get_or_insert(format!(
                        "{name} holds a credential (it begins {:?})",
                        found.chars().take(4).collect::<String>()
                    ));
                }
            }
            Err(e) => {
                lines.get_or_insert(format!("{name}: {e}"));
                continue;
            }
        }
        let records = match parse_file(path) {
            Ok(records) => records,
            Err(why) => {
                lines.get_or_insert(why);
                continue;
            }
        };
        if let Some(fault) = records.iter().find_map(schema_fault) {
            lines.get_or_insert(format!("{name}: {fault}"));
        }
        // A part after the first continues its file's sequence; only a
        // first part must begin at 1.
        if name_parts(path).is_some_and(|(_, _, part)| part == 1) {
            if let Some(fault) = sequence_fault(&records) {
                sequence.get_or_insert(format!("{name}: {fault}"));
            }
            if let Some(fault) = anomaly_fault(&records) {
                anomalies.get_or_insert(format!("{name}: {fault}"));
            }
        }
        late += records
            .iter()
            .filter(|r| matches!(r["event"].as_str(), Some("frame.late" | "frame.missed")))
            .count() as u64;
        heartbeats += records
            .iter()
            .filter(|r| r["event"] == "engine.heartbeat")
            .count() as u64;
    }
    let fail = |fault: Option<String>| fault.map_or(Outcome::Pass, Outcome::Fail);
    report.record(PLANE, LINES, fail(lines));
    report.record(PLANE, SEQUENCE, fail(sequence));
    report.record(
        PLANE,
        ANOMALIES,
        match anomalies {
            Some(fault) => Outcome::Fail(fault),
            // Agreement on nothing is not evidence: say so (invariant 43).
            None if late == 0 || heartbeats == 0 => Outcome::Skip(
                "no frame was late or missed in this run, so no record was due".to_owned(),
            ),
            None => Outcome::Pass,
        },
    );
    report.record(PLANE, SECRETS, fail(secret));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(seq: u64, event: &str, fields: Value) -> Value {
        json!({ "ts": "2026-11-16T08:45:01.303118Z", "mono": seq * 1_000, "seq": seq,
            "process": "worker", "pid": 7, "version": "0.1.0", "level": "info",
            "target": "t", "event": event, "fields": fields })
    }

    fn lost(from: u64, to: u64) -> Value {
        let mut record = line(0, "log.lost", json!({ "fromSeq": from, "toSeq": to }));
        record["seq"] = Value::Null;
        record
    }

    #[test]
    fn a_file_name_gives_its_process_pid_and_part() {
        let parts = |name: &str| name_parts(Path::new(name));
        assert_eq!(
            parts("worker-20261116T084457Z-10474936-1.jsonl"),
            Some(("worker".to_owned(), 10_474_936, 1))
        );
        // A process name may itself hold a hyphen.
        assert_eq!(
            parts("editor-mcp-20261116T084307Z-10472956-12.jsonl"),
            Some(("editor-mcp".to_owned(), 10_472_956, 12))
        );
        assert_eq!(parts("stderr.log"), None);
        assert_eq!(parts("worker-1.jsonl"), None);
    }

    #[test]
    fn a_gap_is_a_fault_unless_a_loss_states_it_where_it_happened() {
        let whole = [line(1, "a", json!({})), line(2, "b", json!({}))];
        assert_eq!(sequence_fault(&whole), None);
        let gap = [line(1, "a", json!({})), line(3, "b", json!({}))];
        assert!(sequence_fault(&gap).is_some_and(|f| f.contains("where 2 was due")));
        let stated = [line(1, "a", json!({})), lost(2, 4), line(5, "b", json!({}))];
        assert_eq!(sequence_fault(&stated), None);
        // A loss that names other lines than the missing ones excuses nothing.
        let misplaced = [line(1, "a", json!({})), lost(3, 4), line(5, "b", json!({}))];
        assert!(sequence_fault(&misplaced).is_some());
        let mut stop = line(0, "log.stop", json!({ "lastSeq": 2 }));
        stop["seq"] = Value::Null;
        assert_eq!(
            sequence_fault(&[whole[0].clone(), whole[1].clone(), stop.clone()]),
            None
        );
        assert!(sequence_fault(&[whole[0].clone(), stop]).is_some());
        // A file that does not begin at 1 lost its beginning.
        assert!(sequence_fault(&[line(2, "a", json!({}))]).is_some());
    }

    #[test]
    fn a_heartbeat_must_agree_with_the_anomalies_on_record_before_it() {
        let beat = |seq, late: u64, missed: u64| {
            line(
                seq,
                "engine.heartbeat",
                json!({ "late": late, "missed": missed }),
            )
        };
        let agreed = [
            line(1, "frame.late", json!({})),
            line(2, "frame.missed", json!({ "missed": 3 })),
            beat(3, 1, 3),
            beat(4, 1, 3),
        ];
        assert_eq!(anomaly_fault(&agreed), None);
        // A late frame the engine counted and did not write.
        let unwritten = [beat(1, 1, 0)];
        assert!(anomaly_fault(&unwritten).is_some());
        // A missed run on record that the totals do not hold.
        let uncounted = [
            line(1, "frame.missed", json!({ "missed": 2 })),
            beat(2, 0, 0),
        ];
        assert!(anomaly_fault(&uncounted).is_some());
        // After a stated loss the comparison is not made.
        let after_loss = [lost(1, 2), beat(3, 5, 0)];
        assert_eq!(anomaly_fault(&after_loss), None);
    }

    #[test]
    fn a_record_without_the_schemas_fields_is_a_fault() {
        assert_eq!(schema_fault(&line(1, "a", json!({}))), None);
        for (key, wrong) in [
            ("ts", json!("16 Nov 2026 08:45")),
            ("mono", json!("soon")),
            ("seq", json!(0)),
            ("process", json!("")),
            ("pid", Value::Null),
            ("level", json!("loud")),
            ("event", Value::Null),
            ("fields", json!("text")),
        ] {
            let mut record = line(1, "a", json!({}));
            record[key] = wrong;
            assert!(schema_fault(&record).is_some(), "{key} was accepted");
        }
        // Only the sink's own two records go without a number.
        let mut numbered = lost(1, 2);
        numbered["seq"] = json!(4);
        assert!(schema_fault(&numbered).is_some());
        assert_eq!(schema_fault(&lost(1, 2)), None);
    }
}
