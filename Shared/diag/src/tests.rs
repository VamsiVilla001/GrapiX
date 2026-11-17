//! 2.14: what a bundle holds, what it leaves out, and that no credential is in it.

use super::*;
use std::collections::BTreeSet;

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let path =
            std::env::temp_dir().join(format!("gx-diag-{label}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).expect("scratch folder");
        Self(path)
    }

    fn file(&self, relative: &str, content: &str) -> PathBuf {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().expect("a parent")).expect("folder");
        fs::write(&path, content).expect("file");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn set_age(path: &Path, hours: u64) {
    let file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open to set its time");
    file.set_modified(SystemTime::now() - Duration::from_secs(hours * 3600))
        .expect("set the modification time");
}

fn record(seq: u64, event: &str, fields: &str) -> String {
    format!(
        "{{\"ts\":\"2026-11-17T10:00:{seq:02}.000000Z\",\"mono\":{seq},\"seq\":{seq},\"process\":\"worker\",\"pid\":100,\"version\":\"0.1.0\",\"level\":\"info\",\"target\":\"t\",\"event\":\"{event}\",\"fields\":{fields}}}\n"
    )
}

fn options(scratch: &Scratch) -> Options {
    Options {
        log_root: scratch.0.join("logs"),
        hours: 24,
        now: SystemTime::now(),
        output: scratch.0.join("out").join("bundle.zip"),
        binary_dirs: vec![scratch.0.join("bin")],
        journal: Some(scratch.0.join("data").join("recovery.json")),
        max_log_bytes: DEFAULT_MAX_LOG_BYTES,
        modules: Vec::new(),
        environment: Vec::new(),
        home: None,
        roots: BTreeMap::new(),
    }
}

/// Every member of the archive, by name.
fn read_bundle(path: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut archive =
        ZipArchive::new(fs::File::open(path).expect("the bundle opens")).expect("a zip");
    let mut members = BTreeMap::new();
    for index in 0..archive.len() {
        let mut member = archive.by_index(index).expect("a member");
        let mut bytes = Vec::new();
        member.read_to_end(&mut bytes).expect("it reads");
        members.insert(member.name().to_owned(), bytes);
    }
    members
}

fn json_of(members: &BTreeMap<String, Vec<u8>>, name: &str) -> Value {
    serde_json::from_slice(
        members
            .get(name)
            .unwrap_or_else(|| panic!("no {name} in {:?}", members.keys())),
    )
    .unwrap_or_else(|e| panic!("{name} is not JSON: {e}"))
}

/// A machine with logs of two products, an old log, a bundles folder, a journal
/// and an executable.
fn machine(scratch: &Scratch) {
    let engine = [
        record(1, "log.start", "{}"),
        record(2, "engine.start", r#"{"tier":"T0","adapter":"NVIDIA RTX","live_capable":true,"rate":"50/1","locality":"CoLocated","clock":"FreeRun","token_required":true,"log_directory":"C:\\x"}"#),
        record(3, "engine.heartbeat", "{}"),
    ]
    .concat();
    scratch.file("logs/engine/worker-20261117T100000Z-100.jsonl", &engine);
    scratch.file(
        "logs/mcp/editor-mcp-20261117T100500Z-200.jsonl",
        &record(1, "mcp.start", "{}"),
    );
    let old = scratch.file(
        "logs/editor/shell-20261110T100000Z-300.jsonl",
        &record(1, "editor.start", "{}"),
    );
    set_age(&old, 100);
    scratch.file("logs/bundles/grapix-diag-earlier.zip", "not a log");
    // A log file that is not any module's (the folder bundles are written into) is not collected.
    scratch.file(
        "logs/bundles/stray-20261117T100000Z-9.jsonl",
        &record(1, "stray.start", "{}"),
    );
    scratch.file("logs/engine/not-a-log.txt", "ignored");
    scratch.file("bin/gx-render-worker.exe", "worker bytes");
    scratch.file("bin/other.exe", "not ours");
    scratch.file(
        "data/recovery.json",
        r#"{"schemaVersion":2,"epoch":7,"published":{"live/lower-third":{"revision":3,"contentHash":"aa"}},"preparedScenes":[{"takeId":"live/lower-third","revision":3,"document":{"title":"CUSTOMER SECRET HEADLINE"}}],"verifiedAssets":["x","y"],"cued":null,"program":null}"#,
    );
}

#[test]
fn a_credential_is_found_and_replaced_wherever_it_is() {
    let (out, count) = scrub(
        b"a gx1.eyJhIjoxfQ.sig_-9 and \"gx1.b.c\" and gx1. alone",
        &[],
    );
    assert_eq!(count, 2);
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text, "a gx1.REDACTED and \"gx1.REDACTED\" and gx1. alone");
    // A malformed one is replaced too, and bytes that are not UTF-8 pass through.
    let (out, count) = scrub(b"\xff\xfe gx1.partial \x00", &[]);
    assert_eq!((out, count), (b"\xff\xfe gx1.REDACTED \x00".to_vec(), 1));
    // Known secrets, as plain text; a short one is not a secret worth a rule.
    let secrets = vec!["hunter2-hunter2".to_owned(), "abc".to_owned()];
    let (out, count) = scrub(b"x hunter2-hunter2 y abc z hunter2-hunter2", &secrets);
    assert_eq!(count, 2);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "x REDACTED y abc z REDACTED"
    );
}

#[test]
fn a_bundle_holds_the_logs_in_the_window_and_what_the_manifest_says() {
    let scratch = Scratch::new("holds");
    machine(&scratch);
    let mut options = options(&scratch);
    options.environment = vec![
        ("GX_LOG".into(), "debug".into()),
        ("GX_LOG_DIR".into(), "C:\\Users\\Someone\\logs".into()),
        ("GX_API_TOKEN".into(), "gx1.pretend.credential-value".into()),
        ("GX_SHARED_SECRET".into(), "super-secret-value".into()),
    ];
    options.home = Some("C:\\Users\\Someone".into());
    options
        .roots
        .insert("log".into(), "C:\\Users\\Someone\\AppData\\Logs".into());
    let collected = collect(&options).expect("the bundle is written");
    assert_eq!(collected.redacted(), 0);
    assert_eq!(collected.log_files, 2);
    assert_eq!(collected.as_run_files, 0);

    let members = read_bundle(&options.output);
    let names: BTreeSet<&str> = members.keys().map(String::as_str).collect();
    for expected in [
        "manifest.json",
        "versions.json",
        "capability.json",
        "modules/engine/devices.json",
        "environment.json",
        "modules/engine/recovery.json",
        "modules/engine/logs/worker-20261117T100000Z-100.jsonl",
        "modules/mcp/logs/editor-mcp-20261117T100500Z-200.jsonl",
    ] {
        assert!(names.contains(expected), "{expected} in {names:?}");
    }
    // The old log, the bundles folder and a file that is not a log are not in it.
    assert!(
        !names.iter().any(|n| n.contains("editor/shell-20261110")),
        "{names:?}"
    );
    assert!(
        !names
            .iter()
            .any(|n| n.contains("bundles") || n.contains("not-a-log")),
        "{names:?}"
    );

    // The manifest names every other member with the hash of what is in it.
    let manifest = json_of(&members, "manifest.json");
    assert_eq!(manifest["format"], BUNDLE_FORMAT);
    assert_eq!(manifest["windowHours"], 24);
    let listed = manifest["files"].as_array().expect("a list");
    assert_eq!(listed.len(), members.len() - 1);
    for entry in listed {
        let path = entry["path"].as_str().expect("a path");
        let bytes = members
            .get(path)
            .unwrap_or_else(|| panic!("{path} listed but not in the archive"));
        assert_eq!(entry["bytes"], bytes.len(), "{path}");
        assert_eq!(entry["sha256"], hex(&Sha256::digest(bytes)), "{path}");
    }
    let engine = listed
        .iter()
        .find(|e| e["path"] == "modules/engine/logs/worker-20261117T100000Z-100.jsonl")
        .expect("the engine log is listed");
    assert_eq!(engine["firstSeq"], 1);
    assert_eq!(engine["lastSeq"], 3);
    assert_eq!(engine["firstTs"], "2026-11-17T10:00:01.000000Z");

    // No as-run log exists: the manifest says so and why, rather than saying nothing.
    assert_eq!(manifest["sections"]["asRun"]["present"], false);
    assert!(manifest["sections"]["asRun"]["note"]
        .as_str()
        .is_some_and(|n| n.contains("12.11")));

    // Versions and the hash of the executable beside the collector (and not the other one).
    let versions = json_of(&members, "versions.json");
    let runs = versions["runs"].as_array().expect("runs");
    assert!(runs.iter().any(|r| r["module"] == "engine"
        && r["process"] == "worker"
        && r["pid"] == 100
        && r["version"] == "0.1.0"));
    assert!(runs
        .iter()
        .any(|r| r["module"] == "mcp" && r["process"] == "editor-mcp" && r["pid"] == 200));
    let binaries = versions["binaries"].as_array().expect("binaries");
    assert_eq!(binaries.len(), 1, "{binaries:?}");
    assert_eq!(binaries[0]["name"], "gx-render-worker.exe");
    assert_eq!(binaries[0]["module"], "engine");
    assert_eq!(binaries[0]["sha256"], hex(&Sha256::digest(b"worker bytes")));

    // The capability surface, at this protocol.
    let capability = json_of(&members, "capability.json");
    assert_eq!(
        capability["protocolVersion"],
        gx_contracts::PROTOCOL_VERSION
    );
    assert!(capability["surface"].is_object());

    // The device and adapter the engine reported.
    let devices = json_of(&members, "modules/engine/devices.json");
    assert_eq!(devices["starts"][0]["tier"], "T0");
    assert_eq!(devices["starts"][0]["adapter"], "NVIDIA RTX");
    assert!(devices["starts"][0].get("log_directory").is_none());

    // The sanitised configuration: secret names are not shown, the home folder is not named.
    let environment = json_of(&members, "environment.json");
    assert_eq!(environment["variables"]["GX_LOG"], "debug");
    assert_eq!(environment["variables"]["GX_API_TOKEN"], "<redacted>");
    assert_eq!(environment["variables"]["GX_SHARED_SECRET"], "<redacted>");
    assert_eq!(environment["variables"]["GX_LOG_DIR"], "<home>\\logs");
    assert_eq!(environment["roots"]["log"], "<home>\\AppData\\Logs");
    let everything = members
        .values()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .collect::<String>();
    assert!(
        !everything.contains("Someone"),
        "the user's name is in the bundle"
    );
    assert!(!everything.contains("super-secret-value") && !everything.contains("gx1.pretend"));

    // The journal: what it holds, never the scene.
    let recovery = json_of(&members, "modules/engine/recovery.json");
    assert_eq!(recovery["present"], true);
    assert_eq!(recovery["epoch"], 7);
    assert_eq!(recovery["published"]["live/lower-third"]["revision"], 3);
    assert_eq!(recovery["preparedScenes"][0]["takeId"], "live/lower-third");
    assert!(recovery["preparedScenes"][0]["documentBytes"]
        .as_u64()
        .is_some_and(|n| n > 0));
    assert_eq!(recovery["verifiedAssets"], 2);
    assert!(
        !everything.contains("CUSTOMER SECRET HEADLINE"),
        "a scene body is in the bundle"
    );
}

#[test]
fn a_credential_in_a_log_is_replaced_counted_and_named() {
    let scratch = Scratch::new("credential");
    machine(&scratch);
    scratch.file(
        "logs/mcp/editor-mcp-20261117T100500Z-200.jsonl",
        &format!(
            "{}{}",
            record(1, "mcp.start", "{}"),
            record(
                2,
                "mcp.call",
                r#"{"detail":"sent gx1.eyJhIjoxfQ.mac and again gx1.second.credential"}"#
            )
        ),
    );
    let mut options = options(&scratch);
    options.environment = vec![("GX_TOKEN".into(), "a-secret-token-value".into())];
    scratch.file(
        "logs/engine/worker-20261117T100000Z-100.jsonl",
        &record(1, "log.start", r#"{"note":"a-secret-token-value"}"#),
    );
    let collected = collect(&options).expect("the bundle is still written");
    assert_eq!(collected.redacted(), 3);
    let mut by_member: Vec<(String, usize)> = collected
        .redactions
        .iter()
        .map(|r| (r.member.clone(), r.count))
        .collect();
    by_member.sort();
    assert_eq!(
        by_member,
        [
            (
                "modules/engine/logs/worker-20261117T100000Z-100.jsonl".to_owned(),
                1
            ),
            (
                "modules/mcp/logs/editor-mcp-20261117T100500Z-200.jsonl".to_owned(),
                2
            ),
        ]
    );
    let members = read_bundle(&options.output);
    let everything = members
        .values()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .collect::<String>();
    assert!(
        !everything.contains("eyJhIjoxfQ")
            && !everything.contains("gx1.second")
            && !everything.contains("a-secret-token-value")
    );
    assert!(everything.contains("gx1.REDACTED"));
    // The lines are still JSON, so the log still reads.
    let mcp = String::from_utf8(
        members["modules/mcp/logs/editor-mcp-20261117T100500Z-200.jsonl"].clone(),
    )
    .unwrap();
    for line in mcp.lines() {
        serde_json::from_str::<Value>(line).expect("a redacted line is still JSON");
    }
    assert_eq!(json_of(&members, "manifest.json")["credentialsRedacted"], 3);
}

#[test]
fn the_as_run_log_is_included_when_there_is_one() {
    let scratch = Scratch::new("as-run");
    machine(&scratch);
    scratch.file(
        "logs/as-run/main-2026-11-17.jsonl",
        &record(1, "asrun.take", "{}"),
    );
    let old = scratch.file(
        "logs/as-run/main-2026-11-01.jsonl",
        &record(1, "asrun.take", "{}"),
    );
    set_age(&old, 400);
    let options = options(&scratch);
    let collected = collect(&options).expect("written");
    assert_eq!(collected.as_run_files, 1);
    let members = read_bundle(&options.output);
    assert!(members.contains_key("as-run/main-2026-11-17.jsonl"));
    // The as-run log is the channel's, not a module's: it is not also collected as one.
    assert!(
        !members
            .keys()
            .any(|name| name.starts_with("modules/as-run/")),
        "{:?}",
        members.keys()
    );
    assert!(!members.contains_key("as-run/main-2026-11-01.jsonl"));
    let manifest = json_of(&members, "manifest.json");
    assert_eq!(manifest["sections"]["asRun"]["present"], true);
    assert_eq!(manifest["sections"]["asRun"]["files"], 1);
}

#[test]
fn the_size_cap_keeps_the_newest_logs_and_names_what_it_left_out() {
    let scratch = Scratch::new("cap");
    let big = "x".repeat(400);
    scratch.file(
        "logs/engine/worker-20261117T090000Z-1.jsonl",
        &format!("{big}\n"),
    );
    scratch.file(
        "logs/engine/worker-20261117T100000Z-2.jsonl",
        &format!("{big}\n"),
    );
    scratch.file(
        "logs/engine/worker-20261117T110000Z-3.jsonl",
        &format!("{big}\n"),
    );
    set_age(
        &scratch
            .0
            .join("logs/engine/worker-20261117T090000Z-1.jsonl"),
        5,
    );
    set_age(
        &scratch
            .0
            .join("logs/engine/worker-20261117T100000Z-2.jsonl"),
        3,
    );
    let mut options = options(&scratch);
    options.max_log_bytes = 900;
    let collected = collect(&options).expect("written");
    assert_eq!(collected.log_files, 2);
    assert_eq!(
        collected.left_out,
        ["modules/engine/logs/worker-20261117T090000Z-1.jsonl"]
    );
    let members = read_bundle(&options.output);
    assert!(members.contains_key("modules/engine/logs/worker-20261117T110000Z-3.jsonl"));
    assert!(members.contains_key("modules/engine/logs/worker-20261117T100000Z-2.jsonl"));
    assert_eq!(
        json_of(&members, "manifest.json")["sections"]["logs"]["leftOut"][0],
        "modules/engine/logs/worker-20261117T090000Z-1.jsonl"
    );
}

#[test]
fn a_machine_with_nothing_still_gets_a_bundle_that_says_so() {
    let scratch = Scratch::new("empty");
    let mut options = options(&scratch);
    options.journal = None;
    let collected = collect(&options).expect("written");
    assert_eq!(collected.log_files, 0);
    assert!(collected.modules.is_empty());
    let members = read_bundle(&options.output);
    let manifest = json_of(&members, "manifest.json");
    assert_eq!(manifest["sections"]["logs"]["files"], 0);
    assert_eq!(manifest["modules"].as_array().map(Vec::len), Some(0));
    assert_eq!(manifest["sections"]["recovery"]["present"], false);
    assert!(
        !members.keys().any(|name| name.starts_with("modules/")),
        "{:?}",
        members.keys()
    );
    assert!(!options.output.with_extension("zip.partial").exists());
}

#[test]
fn a_journal_that_is_not_json_is_named_and_not_copied() {
    let scratch = Scratch::new("badjournal");
    scratch.file("data/recovery.json", "{ this is not json CUSTOMER TEXT");
    let options = options(&scratch);
    collect(&options).expect("written");
    let members = read_bundle(&options.output);
    let recovery = json_of(&members, "modules/engine/recovery.json");
    assert_eq!(recovery["unreadable"], "the journal is not valid JSON");
    assert!(
        !String::from_utf8_lossy(&members["modules/engine/recovery.json"])
            .contains("CUSTOMER TEXT")
    );
}

#[test]
fn run_names_parse_with_hyphenated_processes_and_part_numbers() {
    assert_eq!(
        run_of("worker-20261117T100000Z-100.jsonl"),
        Some(("worker".into(), "20261117T100000Z".into(), 100))
    );
    assert_eq!(
        run_of("editor-mcp-20261117T100500Z-200.jsonl"),
        Some(("editor-mcp".into(), "20261117T100500Z".into(), 200))
    );
    assert_eq!(
        run_of("worker-20261117T100000Z-100-2.jsonl"),
        Some(("worker".into(), "20261117T100000Z".into(), 100))
    );
    assert_eq!(run_of("notes.jsonl"), None);
    assert_eq!(run_of("worker-20261117T100000Z-100.txt"), None);
}

#[test]
fn the_home_folder_is_replaced_whatever_its_case_and_wherever_it_is() {
    assert_eq!(
        anonymise(
            "C:\\USERS\\Someone\\a and c:\\users\\someone\\b",
            Some("C:\\Users\\Someone")
        ),
        "<home>\\a and <home>\\b"
    );
    assert_eq!(anonymise("/x/y", Some("")), "/x/y");
    assert_eq!(anonymise("/x/y", None), "/x/y");
}

#[test]
fn a_bundle_is_named_for_the_moment_it_was_made() {
    // 1_000_000_000 seconds after the epoch is 2001-09-09T01:46:40Z.
    let name = bundle_name(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000));
    assert_eq!(name, "grapix-diag-20010909T014640Z.zip");
}

#[cfg(windows)]
#[test]
fn executables_are_found_by_their_name_alone() {
    for (name, expected) in [
        ("gx-render-worker.exe", true),
        ("gx-diag.exe", true),
        ("gx-render-worker.pdb", false),
        ("other.exe", false),
        ("gx-x.d", false),
    ] {
        assert_eq!(is_gx_executable(Path::new(name)), expected, "{name}");
    }
}

/// A machine whose modules each did something worth a summary.
fn busy_machine(scratch: &Scratch) {
    machine(scratch);
    let level = |seq: u64, level: &str, event: &str, extra: &str| {
        format!(
            "{{\"ts\":\"2026-11-17T10:00:{seq:02}.000000Z\",\"seq\":{seq},\"process\":\"shell\",\"pid\":400,\"version\":\"0.1.0\",\"level\":\"{level}\",\"event\":\"{event}\",\"fields\":{{}}{extra}}}\n"
        )
    };
    let playout = [
        level(1, "info", "log.start", ""),
        level(
            2,
            "info",
            "operator.take",
            ",\"corr\":\"po-1\",\"refusal\":\"unknownTake\"",
        ),
        level(3, "warn", "log.previous_unfinished", ""),
        level(4, "error", "playout.failed", ",\"corr\":\"po-2\""),
        level(5, "warn", "log.lost", ""),
        "this line is not json\n".to_owned(),
        level(6, "info", "playout.stop", ""),
        level(7, "info", "log.stop", ""),
    ]
    .concat();
    scratch.file("logs/playout/shell-20261117T100000Z-400.jsonl", &playout);
    let frames = [
        record(4, "frame.late", "{}"),
        record(5, "frame.missed", "{}"),
        record(6, "frame.late", "{}"),
    ]
    .concat();
    let path = scratch
        .0
        .join("logs/engine/worker-20261117T100000Z-100.jsonl");
    let mut engine = fs::read_to_string(&path).unwrap();
    engine.push_str(&frames);
    fs::write(&path, engine).unwrap();
    scratch.file("bin/gx-playout.exe", "playout bytes");
    scratch.file("bin/gx-editor-mcp.exe", "mcp bytes");
    scratch.file("bin/gx-conformance.exe", "a tool");
}

#[test]
fn each_module_has_its_own_folder_and_a_summary_that_reads_without_opening_a_log() {
    let scratch = Scratch::new("modules");
    busy_machine(&scratch);
    let options = options(&scratch);
    let collected = collect(&options).expect("written");
    assert_eq!(collected.modules, ["engine", "mcp", "playout"]);
    let members = read_bundle(&options.output);

    // Everything a module wrote is under its own folder, and nothing of another's.
    for (module, log) in [
        ("engine", "worker-20261117T100000Z-100.jsonl"),
        ("mcp", "editor-mcp-20261117T100500Z-200.jsonl"),
        ("playout", "shell-20261117T100000Z-400.jsonl"),
    ] {
        assert!(
            members.contains_key(&format!("modules/{module}/logs/{log}")),
            "{module}"
        );
        assert!(
            members.contains_key(&format!("modules/{module}/summary.json")),
            "{module}"
        );
    }
    assert!(
        !members.keys().any(|name| name.starts_with("logs/")),
        "{:?}",
        members.keys()
    );
    // The engine's own files are in the engine's folder, and only there.
    assert!(members.contains_key("modules/engine/devices.json"));
    assert!(members.contains_key("modules/engine/recovery.json"));
    assert!(!members.contains_key("modules/playout/devices.json"));

    // Playout's summary: its run and how it ended, its records by level, its
    // refusal, its lost-record notice, the killed predecessor it named, the
    // line that would not parse, its newest problems first, and its executable.
    let playout = json_of(&members, "modules/playout/summary.json");
    assert_eq!(playout["module"], "playout");
    assert_eq!(playout["wroteInWindow"], true);
    assert_eq!(playout["runs"][0]["process"], "shell");
    assert_eq!(playout["runs"][0]["pid"], 400);
    assert_eq!(playout["runs"][0]["ended"], "ended in order");
    assert_eq!(playout["logs"]["files"], 1);
    assert_eq!(playout["logs"]["unparsedLines"], 1);
    assert_eq!(playout["records"]["byLevel"]["info"], 4);
    assert_eq!(playout["records"]["byLevel"]["warn"], 2);
    assert_eq!(playout["records"]["byLevel"]["error"], 1);
    assert_eq!(playout["records"]["refusals"], 1);
    assert_eq!(playout["records"]["lostRecordNotices"], 1);
    assert_eq!(playout["records"]["unfinishedPredecessors"], 1);
    assert_eq!(playout["problems"]["total"], 3);
    assert_eq!(playout["problems"]["newest"][0]["event"], "log.lost");
    assert_eq!(playout["problems"]["newest"][1]["event"], "playout.failed");
    assert_eq!(playout["problems"]["newest"][1]["corr"], "po-2");
    let own: Vec<&str> = playout["binaries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert_eq!(own, ["gx-playout.exe"]);

    // The engine's: its frames, a run that did not end in order, its executable.
    let engine = json_of(&members, "modules/engine/summary.json");
    assert_eq!(engine["records"]["framesLate"], 2);
    assert_eq!(engine["records"]["framesMissed"], 1);
    assert!(engine["runs"][0]["ended"]
        .as_str()
        .is_some_and(|e| e.starts_with("no log.stop")));
    assert_eq!(engine["binaries"][0]["name"], "gx-render-worker.exe");
    assert_eq!(engine["problems"]["total"], 0);

    // The manifest lists the modules with their headline numbers.
    let manifest = json_of(&members, "manifest.json");
    assert_eq!(manifest["modulesRequested"], "all");
    let listed = manifest["modules"].as_array().expect("modules");
    assert_eq!(listed.len(), 3);
    let playout_row = listed
        .iter()
        .find(|m| m["module"] == "playout")
        .expect("playout is listed");
    assert_eq!(playout_row["errors"], 1);
    assert_eq!(playout_row["warnings"], 2);
    assert_eq!(playout_row["refusals"], 1);
    assert_eq!(playout_row["summary"], "modules/playout/summary.json");

    // Every executable is in the top-level list with its module; a tool is under "tools".
    let versions = json_of(&members, "versions.json");
    let by_name: BTreeMap<String, String> = versions["binaries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["name"].as_str().unwrap().to_owned(),
                b["module"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(by_name["gx-render-worker.exe"], "engine");
    assert_eq!(by_name["gx-playout.exe"], "playout");
    assert_eq!(by_name["gx-editor-mcp.exe"], "mcp");
    assert_eq!(by_name["gx-conformance.exe"], "tools");
}

#[test]
fn a_bundle_of_chosen_modules_holds_those_modules_and_nothing_of_the_others() {
    let scratch = Scratch::new("chosen");
    busy_machine(&scratch);
    let mut options = options(&scratch);
    options.modules = vec!["playout".to_owned(), "editor".to_owned()];
    let collected = collect(&options).expect("written");
    // Asked for by name, so in the bundle even though the Editor wrote nothing in the window.
    assert_eq!(collected.modules, ["editor", "playout"]);
    assert_eq!(collected.log_files, 1);
    let members = read_bundle(&options.output);
    assert!(members.contains_key("modules/playout/logs/shell-20261117T100000Z-400.jsonl"));
    assert!(
        !members
            .keys()
            .any(|name| name.starts_with("modules/engine/") || name.starts_with("modules/mcp/")),
        "{:?}",
        members.keys()
    );
    let editor = json_of(&members, "modules/editor/summary.json");
    assert_eq!(editor["wroteInWindow"], false);
    assert_eq!(editor["logs"]["files"], 0);
    let manifest = json_of(&members, "manifest.json");
    assert_eq!(
        manifest["modulesRequested"],
        serde_json::json!(["playout", "editor"])
    );
    // What belongs to no one module is still there.
    for shared in ["capability.json", "environment.json", "versions.json"] {
        assert!(members.contains_key(shared), "{shared}");
    }

    // The engine alone: its logs, its device and its journal summary.
    options.modules = vec!["engine".to_owned()];
    options.output = scratch.0.join("out").join("engine.zip");
    collect(&options).expect("written");
    let members = read_bundle(&options.output);
    assert!(members.contains_key("modules/engine/devices.json"));
    assert_eq!(
        json_of(&members, "modules/engine/recovery.json")["present"],
        true
    );
    assert!(!members
        .keys()
        .any(|name| name.starts_with("modules/playout/")));
}

#[test]
fn an_executable_belongs_to_the_module_its_name_says() {
    for (name, module) in [
        ("gx-render-worker.exe", "engine"),
        ("gx-engine-host", "engine"),
        ("gx-editor.exe", "editor"),
        ("gx-playout.exe", "playout"),
        ("gx-editor-mcp.exe", "mcp"),
        ("gx-playout-mcp", "mcp"),
        ("gx-diag.exe", "tools"),
        ("gx-mock-engine.exe", "tools"),
    ] {
        assert_eq!(module_of_binary(name), module, "{name}");
    }
}

#[test]
fn an_archive_that_does_not_read_back_as_written_is_refused() {
    let scratch = Scratch::new("readback");
    let path = scratch.0.join("a.zip");
    let file = fs::File::create(&path).expect("the archive");
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    archive.start_file("a.txt", options).expect("a member");
    archive.write_all(b"one").expect("written");
    archive
        .start_file("manifest.json", options)
        .expect("the manifest");
    archive.write_all(b"{}").expect("written");
    archive.finish().expect("finished");
    let member = |name: &str, bytes: &[u8]| Member {
        path: name.to_owned(),
        bytes: bytes.to_vec(),
        redactions: 0,
        extra: Value::Null,
    };

    // As meant: it reads back.
    assert!(read_back(&path, &[member("a.txt", b"one")], b"{}").is_ok());
    // A member that reads back different, one that is missing, one that was not meant, and a
    // manifest that is not the one meant are each refused, naming what is wrong.
    let different = read_back(&path, &[member("a.txt", b"two")], b"{}").unwrap_err();
    assert!(different.contains("a.txt"), "{different}");
    assert!(read_back(
        &path,
        &[member("a.txt", b"one"), member("b.txt", b"x")],
        b"{}"
    )
    .is_err());
    assert!(read_back(&path, &[], b"{}").is_err());
    let manifest = read_back(&path, &[member("a.txt", b"one")], b"{\"x\":1}").unwrap_err();
    assert!(manifest.contains("manifest.json"), "{manifest}");
}
