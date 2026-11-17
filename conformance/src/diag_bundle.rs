//! 2.14 (ADR-0004 §8): a diagnostic bundle made from this run's own logs.
//!
//! The run's processes wrote their logs into one scratch folder
//! ([`run_log_directory`]). This suite runs the real `gx-diag` binary over that
//! folder, opens the archive it wrote, and checks what the row's done-when
//! lists: every process's log, module by module; versions and the hash of each
//! executable; the capability surface; the device and adapter the engine
//! reported; the sanitised configuration; the as-run log or the naming of its
//! absence; and no credential the run used.
//!
//! The logs of processes that are still running grow after the bundle copied
//! them, so a copy is checked to be the start of the file as it is now.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use gx_contracts::PROTOCOL_VERSION;
use serde_json::Value;

use crate::{expect, run_log_directory, Outcome, Report};

const PLANE: &str = "log";

const WRITES: &str = "gx-diag writes a bundle from the run's logs without finding a credential";
const LOGS: &str = "the bundle holds every log file the run wrote, module by module";
const SUMMARIES: &str = "each module in the bundle has a summary that names its runs";
const MACHINE: &str = "the bundle holds versions with a hash for each executable, the capability surface, the engine's device and adapter and the sanitised configuration";
const AS_RUN: &str = "the bundle holds the as-run log, or names that there is none";
const SECRETS: &str = "no credential the run used is in the bundle";

fn gx_diag() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let file = format!("gx-diag{}", std::env::consts::EXE_SUFFIX);
    let directory = current.parent()?;
    [directory.join(&file), directory.parent()?.join(&file)]
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn members(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a zip: {e}"))?;
    let mut found = BTreeMap::new();
    for index in 0..archive.len() {
        let mut member = archive.by_index(index).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        member.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        found.insert(member.name().to_owned(), bytes);
    }
    Ok(found)
}

fn json(members: &BTreeMap<String, Vec<u8>>, name: &str) -> Result<Value, String> {
    let bytes = members
        .get(name)
        .ok_or_else(|| format!("no {name} in the bundle"))?;
    serde_json::from_slice(bytes).map_err(|e| format!("{name} is not JSON: {e}"))
}

/// The log files the run wrote, as (module, file name, path).
fn run_logs() -> Vec<(String, String, PathBuf)> {
    let mut found = Vec::new();
    let Ok(modules) = std::fs::read_dir(run_log_directory()) else {
        return found;
    };
    for module in modules.flatten() {
        let name = module.file_name().to_string_lossy().into_owned();
        if !module.path().is_dir() || name == "bundles" || name == "as-run" {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(module.path()) {
            for file in files.flatten() {
                let file_name = file.file_name().to_string_lossy().into_owned();
                if file_name.ends_with(".jsonl") {
                    found.push((name.clone(), file_name, file.path()));
                }
            }
        }
    }
    found.sort();
    found
}

/// Run `gx-diag` over this run's logs and check the bundle. `secrets` are the
/// control-port secrets the run used.
pub fn diag_bundle_suite(secrets: &[&str], report: &mut Report) {
    let names = [WRITES, LOGS, SUMMARIES, MACHINE, AS_RUN, SECRETS];
    let skip_all = |report: &mut Report, why: String| {
        for name in names {
            report.record(PLANE, name, Outcome::Skip(why.clone()));
        }
    };
    let Some(binary) = gx_diag() else {
        return skip_all(
            report,
            "gx-diag is not built beside this executable (cargo build -p gx-diag)".to_owned(),
        );
    };
    let logs = run_logs();
    if logs.is_empty() {
        return skip_all(report, "no process of this run wrote a log file".to_owned());
    }
    let out = run_log_directory().join("bundles").join("conformance.zip");
    let nothing = run_log_directory().join("no-recovery-journal.json");
    let output = Command::new(&binary)
        .arg("--log-root")
        .arg(run_log_directory())
        .arg("--out")
        .arg(&out)
        .arg("--journal")
        .arg(&nothing)
        .env_remove("GX_LOG_DIR")
        .output();
    let output = match output {
        Ok(output) => output,
        Err(e) => return skip_all(report, format!("gx-diag could not be started: {e}")),
    };
    let said = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code();
    report.record(
        PLANE,
        WRITES,
        expect(
            code == Some(0) && out.exists(),
            format!(
                "gx-diag exited {code:?} and the bundle {}: {said}",
                if out.exists() { "exists" } else { "does not" }
            ),
        ),
    );
    let members = match members(&out) {
        Ok(members) => members,
        Err(why) => {
            for name in &names[1..] {
                report.record(
                    PLANE,
                    name,
                    Outcome::Fail(format!("the bundle does not open: {why}")),
                );
            }
            return;
        }
    };

    // Every log file of the run, module by module, as the file begins.
    let mut wrong: Vec<String> = Vec::new();
    for (module, file, path) in &logs {
        let member = format!("modules/{module}/logs/{file}");
        match (members.get(&member), std::fs::read(path)) {
            (Some(copy), Ok(now)) if !copy.is_empty() && now.starts_with(copy) => {}
            (Some(_), _) => wrong.push(format!("{member} is not the start of the file as it is")),
            (None, _) => wrong.push(format!("{member} is not in the bundle")),
        }
    }
    report.record(
        PLANE,
        LOGS,
        expect(wrong.is_empty(), format!("{} files: {wrong:?}", logs.len())),
    );

    // Each module's summary names its runs.
    let mut by_module: BTreeMap<&str, usize> = BTreeMap::new();
    for (module, _, _) in &logs {
        *by_module.entry(module.as_str()).or_default() += 1;
    }
    let mut wrong: Vec<String> = Vec::new();
    for (module, files) in &by_module {
        match json(&members, &format!("modules/{module}/summary.json")) {
            Ok(summary) => {
                let runs = summary["runs"].as_array().map_or(0, Vec::len);
                if summary["module"] != *module
                    || summary["logs"]["files"] != *files
                    || runs != *files
                {
                    wrong.push(format!(
                        "{module}: {files} files, summary says {} files and {runs} runs",
                        summary["logs"]["files"]
                    ));
                }
            }
            Err(why) => wrong.push(why),
        }
    }
    report.record(
        PLANE,
        SUMMARIES,
        expect(wrong.is_empty(), format!("{wrong:?}")),
    );

    // Versions and hashes, the capability surface, the device, the configuration.
    let machine = (|| -> Result<(), String> {
        let versions = json(&members, "versions.json")?;
        let binaries = versions["binaries"]
            .as_array()
            .ok_or("versions.json has no binaries")?;
        if !binaries.iter().any(|b| {
            b["name"]
                .as_str()
                .is_some_and(|n| n.starts_with("gx-render-worker"))
        }) {
            return Err("the render worker is not among the executables".to_owned());
        }
        for binary in binaries {
            let hash = binary["sha256"].as_str().unwrap_or("");
            if hash.len() != 64
                || !hash.bytes().all(|b| b.is_ascii_hexdigit())
                || binary["module"].as_str().is_none()
            {
                return Err(format!("{} has no SHA-256 or no module", binary["name"]));
            }
        }
        if versions["runs"].as_array().is_none_or(Vec::is_empty) {
            return Err("versions.json names no run".to_owned());
        }
        let capability = json(&members, "capability.json")?;
        if capability["protocolVersion"] != PROTOCOL_VERSION || !capability["surface"].is_object() {
            return Err(format!(
                "the capability surface is for protocol {}",
                capability["protocolVersion"]
            ));
        }
        let devices = json(&members, "modules/engine/devices.json")?;
        if devices["starts"]
            .as_array()
            .is_none_or(|s| s.is_empty() || s.iter().any(|d| d["tier"].as_str().is_none()))
        {
            return Err("the engine's device and adapter are not in the bundle".to_owned());
        }
        let environment = json(&members, "environment.json")?;
        if environment["os"].as_str().is_none()
            || !environment["variables"].is_object()
            || !environment["roots"].is_object()
        {
            return Err("environment.json is incomplete".to_owned());
        }
        Ok(())
    })();
    report.record(
        PLANE,
        MACHINE,
        expect(machine.is_ok(), machine.err().unwrap_or_default()),
    );

    // The as-run log, or its absence named.
    let manifest = json(&members, "manifest.json");
    let as_run = match &manifest {
        Ok(manifest) => match manifest["sections"]["asRun"]["present"].as_bool() {
            Some(true) => members.keys().any(|n| n.starts_with("as-run/")),
            Some(false) => manifest["sections"]["asRun"]["note"]
                .as_str()
                .is_some_and(|n| !n.is_empty()),
            None => false,
        },
        Err(_) => false,
    };
    report.record(
        PLANE,
        AS_RUN,
        expect(
            as_run,
            format!("{:?}", manifest.map(|m| m["sections"]["asRun"].clone())),
        ),
    );

    // No credential the run used, in any member, and none the collector had to replace.
    let mut found: Vec<String> = Vec::new();
    for (name, bytes) in &members {
        let text = String::from_utf8_lossy(bytes);
        for secret in secrets.iter().copied().chain(["gx1."]) {
            if text.contains(secret) {
                found.push(format!(
                    "{name} holds {:?}",
                    secret.chars().take(4).collect::<String>()
                ));
            }
        }
    }
    let redacted = json(&members, "manifest.json").map_or(u64::MAX, |m| {
        m["credentialsRedacted"].as_u64().unwrap_or(u64::MAX)
    });
    report.record(
        PLANE,
        SECRETS,
        expect(
            found.is_empty() && redacted == 0,
            format!("{found:?}, the collector replaced {redacted}"),
        ),
    );
}
