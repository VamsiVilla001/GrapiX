//! `gx-diag`: collect a diagnostic bundle (build plan 2.14).
//!
//! ```text
//! gx-diag [--module NAME]... [--hours N] [--out FILE] [--log-root DIR]
//!         [--journal FILE] [--bin-dir DIR]...
//! ```
//!
//! With no `--module` the bundle holds every module that wrote a log in the
//! window; with one or more it holds those modules only (`engine`, `editor`,
//! `playout`, `mcp`, ...).
//!
//! Exit status: 0 the bundle was written; 1 it could not be; 2 a usage error;
//! 3 it was written and a credential was found in what it collected and
//! replaced (a credential in a log is a bug: the bundle is safe to send, the
//! log that held the credential is not).

#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::process::ExitCode;

use gx_diag::{collect, Options, DEFAULT_HOURS};

const USAGE: &str = "gx-diag [--module NAME]... [--hours N] [--out FILE] [--log-root DIR] [--journal FILE] [--bin-dir DIR]...";

fn main() -> ExitCode {
    let mut hours = DEFAULT_HOURS;
    let mut out: Option<PathBuf> = None;
    let mut log_root: Option<PathBuf> = None;
    let mut journal: Option<PathBuf> = None;
    let mut bin_dirs: Vec<PathBuf> = Vec::new();
    let mut modules: Vec<String> = Vec::new();
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let name = arg.to_string_lossy().into_owned();
        let mut value = |what: &str| -> Result<std::ffi::OsString, ExitCode> {
            args.next().ok_or_else(|| {
                eprintln!("error: {name} needs {what}");
                ExitCode::from(2)
            })
        };
        match name.as_str() {
            "--hours" => {
                match value("a number of hours").map(|v| v.to_string_lossy().parse::<u64>()) {
                    Ok(Ok(n)) if n > 0 => hours = n,
                    Ok(_) => {
                        eprintln!("error: --hours needs a whole number above 0");
                        return ExitCode::from(2);
                    }
                    Err(code) => return code,
                }
            }
            "--module" => match value("a module name") {
                Ok(v) => {
                    let module = v.to_string_lossy().into_owned();
                    // A module is a folder name under the log root, nothing else.
                    let plain = !module.is_empty()
                        && module
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
                    if !plain
                        || module == gx_diag::AS_RUN_FOLDER
                        || module == gx_diag::BUNDLES_FOLDER
                    {
                        eprintln!("error: --module needs a module name such as engine, editor, playout or mcp");
                        return ExitCode::from(2);
                    }
                    if !modules.contains(&module) {
                        modules.push(module);
                    }
                }
                Err(code) => return code,
            },
            "--out" => match value("a file path") {
                Ok(v) => out = Some(PathBuf::from(v)),
                Err(code) => return code,
            },
            "--log-root" => match value("a folder") {
                Ok(v) => log_root = Some(PathBuf::from(v)),
                Err(code) => return code,
            },
            "--journal" => match value("a file path") {
                Ok(v) => journal = Some(PathBuf::from(v)),
                Err(code) => return code,
            },
            "--bin-dir" => match value("a folder") {
                Ok(v) => bin_dirs.push(PathBuf::from(v)),
                Err(code) => return code,
            },
            "--help" | "-h" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("error: unknown argument {other}");
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        }
    }

    let mut options = match Options::for_this_machine(hours) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(1);
        }
    };
    if let Some(root) = log_root {
        options.output = root
            .join(gx_diag::BUNDLES_FOLDER)
            .join(gx_diag::bundle_name(options.now));
        options
            .roots
            .insert("log".to_owned(), root.display().to_string());
        options.log_root = root;
    }
    if let Some(out) = out {
        options.output = out;
    }
    if let Some(journal) = journal {
        options.journal = Some(journal);
    }
    if !bin_dirs.is_empty() {
        options.binary_dirs = bin_dirs;
    }
    options.modules = modules;

    match collect(&options) {
        Ok(collected) => {
            println!("bundle: {}", collected.path.display());
            println!(
                "size: {} bytes, {} members",
                collected.bytes, collected.files
            );
            if collected.modules.is_empty() {
                println!("modules: none wrote a log in the window");
            } else {
                println!("modules: {}", collected.modules.join(", "));
            }
            println!("logs: {} files", collected.log_files);
            if collected.as_run_files > 0 {
                println!("as-run: {} files", collected.as_run_files);
            } else {
                println!("as-run: none in the window (the as-run record is build-plan row 12.11)");
            }
            for member in &collected.left_out {
                println!("left out (size cap): {member}");
            }
            if collected.redacted() > 0 {
                eprintln!(
                    "WARNING: {} credential(s) were found in what was collected and replaced in the bundle:",
                    collected.redacted()
                );
                for redaction in &collected.redactions {
                    eprintln!("  {}: {}", redaction.member, redaction.count);
                }
                eprintln!(
                    "A credential in a log is a bug. The bundle is safe to send; the log is not."
                );
                return ExitCode::from(3);
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::from(1)
        }
    }
}
