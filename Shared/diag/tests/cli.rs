//! 2.14: the real `gx-diag` binary, run as an operator runs it.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn scratch(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let path = std::env::temp_dir().join(format!(
        "gx-diag-cli-{label}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("scratch folder");
    path
}

fn log_line(event: &str, fields: &str) -> String {
    format!(
        "{{\"ts\":\"2026-11-17T10:00:01.000000Z\",\"mono\":1,\"seq\":1,\"process\":\"worker\",\"pid\":7,\"version\":\"0.1.0\",\"level\":\"info\",\"target\":\"t\",\"event\":\"{event}\",\"fields\":{fields}}}\n"
    )
}

fn run(args: &[&str], envs: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gx-diag"));
    command.args(args);
    // Nothing of the operator's own: the run sees only what the test gives it.
    command.env_remove("GX_LOG_DIR");
    for (name, value) in envs {
        command.env(name, value);
    }
    command.output().expect("gx-diag runs")
}

fn members(path: &Path) -> Vec<(String, Vec<u8>)> {
    let mut archive =
        zip::ZipArchive::new(fs::File::open(path).expect("the bundle opens")).expect("a zip");
    (0..archive.len())
        .map(|i| {
            let mut member = archive.by_index(i).expect("a member");
            let mut bytes = Vec::new();
            member.read_to_end(&mut bytes).expect("reads");
            (member.name().to_owned(), bytes)
        })
        .collect()
}

#[test]
fn the_command_writes_a_bundle_and_says_what_is_in_it() {
    let dir = scratch("ok");
    let logs = dir.join("logs");
    fs::create_dir_all(logs.join("engine")).unwrap();
    fs::write(
        logs.join("engine").join("worker-20261117T100000Z-7.jsonl"),
        log_line("engine.start", r#"{"tier":"T0","adapter":"Test GPU"}"#),
    )
    .unwrap();
    let out = dir.join("bundle.zip");
    let output = run(
        &[
            "--log-root",
            logs.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
            "--hours",
            "48",
            "--journal",
            dir.join("none.json").to_str().unwrap(),
        ],
        &[],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let said = String::from_utf8_lossy(&output.stdout);
    assert!(
        said.contains("bundle:") && said.contains("logs: 1 files"),
        "{said}"
    );
    assert!(
        said.contains("as-run: none") && said.contains("12.11"),
        "{said}"
    );
    let names: Vec<String> = members(&out).into_iter().map(|(n, _)| n).collect();
    for expected in [
        "manifest.json",
        "versions.json",
        "capability.json",
        "modules/engine/devices.json",
        "environment.json",
        "modules/engine/recovery.json",
        "modules/engine/logs/worker-20261117T100000Z-7.jsonl",
    ] {
        assert!(
            names.iter().any(|n| n == expected),
            "{expected} in {names:?}"
        );
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_credential_in_a_log_gives_exit_three_names_the_file_and_is_not_in_the_bundle() {
    let dir = scratch("credential");
    let logs = dir.join("logs");
    fs::create_dir_all(logs.join("mcp")).unwrap();
    fs::write(
        logs.join("mcp").join("editor-mcp-20261117T100000Z-9.jsonl"),
        log_line(
            "mcp.call",
            r#"{"detail":"token gx1.eyJhIjoxfQ.macmacmac leaked"}"#,
        ),
    )
    .unwrap();
    let out = dir.join("bundle.zip");
    let output = run(
        &[
            "--log-root",
            logs.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
            "--journal",
            dir.join("none.json").to_str().unwrap(),
        ],
        &[("GX_TEST_SECRET", "a-secret-value-12345")],
    );
    assert_eq!(
        output.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let warned = String::from_utf8_lossy(&output.stderr);
    assert!(
        warned.contains("WARNING")
            && warned.contains("modules/mcp/logs/editor-mcp-20261117T100000Z-9.jsonl: 1"),
        "{warned}"
    );
    assert!(
        !warned.contains("eyJhIjoxfQ"),
        "the warning must not repeat the credential: {warned}"
    );
    for (name, bytes) in members(&out) {
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains("eyJhIjoxfQ")
                && !text.contains("macmacmac")
                && !text.contains("a-secret-value-12345"),
            "{name}"
        );
    }
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn bad_arguments_exit_two_and_write_nothing() {
    let dir = scratch("usage");
    for args in [
        vec!["--module", "../escape"],
        vec!["--module", "bundles"],
        vec!["--module"],
        vec!["--hours", "0"],
        vec!["--hours", "many"],
        vec!["--hours"],
        vec!["--nope"],
    ] {
        let output = run(&args, &[]);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(run(&["--help"], &[]).status.code(), Some(0));
    assert!(fs::read_dir(&dir).unwrap().next().is_none());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_command_collects_one_module_when_asked() {
    let dir = scratch("module");
    let logs = dir.join("logs");
    for (module, file) in [
        ("engine", "worker-20261117T100000Z-7.jsonl"),
        ("playout", "shell-20261117T100000Z-8.jsonl"),
    ] {
        fs::create_dir_all(logs.join(module)).unwrap();
        fs::write(logs.join(module).join(file), log_line("x.start", "{}")).unwrap();
    }
    let out = dir.join("playout.zip");
    let output = run(
        &[
            "--module",
            "playout",
            "--log-root",
            logs.to_str().unwrap(),
            "--out",
            out.to_str().unwrap(),
            "--journal",
            dir.join("none.json").to_str().unwrap(),
        ],
        &[],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let said = String::from_utf8_lossy(&output.stdout);
    assert!(said.contains("modules: playout"), "{said}");
    let names: Vec<String> = members(&out).into_iter().map(|(n, _)| n).collect();
    assert!(
        names
            .iter()
            .any(|n| n == "modules/playout/logs/shell-20261117T100000Z-8.jsonl"),
        "{names:?}"
    );
    assert!(
        names.iter().any(|n| n == "modules/playout/summary.json"),
        "{names:?}"
    );
    assert!(
        !names.iter().any(|n| n.starts_with("modules/engine/")),
        "{names:?}"
    );
    let _ = fs::remove_dir_all(dir);
}
