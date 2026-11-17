//! 2.17: an Editor edit and the publish that carries it are followed by one id
//! from the shell to the engine's log.
//!
//! A real worker process (it skips cleanly when the binary is not built, as the
//! other shell integration test does), a real shell state publishing to it over
//! the asset plane. Edits are made under the ids the front end would give them
//! (`ed-edit-N`), the publish under its own (`ed-pub-N`). The engine's
//! `publish.accepted` is written under the publish's id and names the edits it
//! carries, so a search for an edit's id finds its own shell records and, through
//! the engine's `carries`, the publish that took it to the engine.

use std::net::{Ipv4Addr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use gx_contracts::command::{
    CreateObject, EditScene, EditorCommand, OpenScene, SceneEdit, SceneSource, SceneTarget,
    SessionKey,
};
use gx_editor::Workspace;
use gx_editor_shell::ShellState;
use tracing_subscriber::layer::SubscriberExt;

fn worker_binary() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let debug = current.parent()?.parent()?;
    let candidate = debug.join(if cfg!(windows) {
        "gx-render-worker.exe"
    } else {
        "gx-render-worker"
    });
    candidate.exists().then_some(candidate)
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind ephemeral");
    listener.local_addr().expect("local addr").port()
}

struct KillOnDrop(Child);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Scratch(PathBuf);
impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "gx-editor-shell-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("scratch directory");
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn records(directory: &Path) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect::<Vec<serde_json::Value>>()
        })
        .collect()
}

/// The records a search for `id` finds: those written under it, and those that
/// name it as a carried edit.
fn follow<'a>(id: &str, files: &'a [serde_json::Value]) -> Vec<&'a serde_json::Value> {
    files
        .iter()
        .filter(|r| {
            r["corr"] == id
                || r["fields"]["carries"]
                    .as_str()
                    .is_some_and(|ids| ids.split(',').any(|carried| carried == id))
        })
        .collect()
}

fn create_rect(session: SessionKey) -> EditorCommand {
    EditorCommand::EditScene(EditScene {
        target: SceneTarget::Session { session },
        edits: vec![SceneEdit::CreateObject(CreateObject {
            kind: "rect".into(),
            name: "Bar".into(),
        })],
        module: None,
        if_revision: None,
    })
}

#[test]
fn an_edit_is_followed_by_one_id_from_the_shell_through_the_publish_to_the_engine() {
    let Some(binary) = worker_binary() else {
        eprintln!("SKIP: gx-render-worker binary not built");
        return;
    };
    let scratch = Scratch::new("carry-live");
    let packages = scratch.0.join("packages");
    std::fs::create_dir_all(&packages).unwrap();
    let engine_logs = scratch.0.join("engine-logs");
    let asset = free_port();
    let _worker = KillOnDrop(
        Command::new(&binary)
            .env("GX_LOG_DIR", &engine_logs)
            .args(["--port", &free_port().to_string()])
            .args(["--asset-port", &asset.to_string()])
            .arg("--recovery-journal")
            .arg(scratch.0.join("recovery.json"))
            .arg("--package-dir")
            .arg(&packages)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the worker starts"),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    while TcpStream::connect((Ipv4Addr::LOCALHOST, asset)).is_err() {
        assert!(Instant::now() < deadline, "the worker did not come up");
        std::thread::sleep(Duration::from_millis(50));
    }
    let endpoint = format!("127.0.0.1:{asset}");

    // The shell, logging to its own scratch folder.
    let shell_logs = scratch.0.join("shell-logs");
    let guard = gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new(
        "editor",
        "shell",
        &shell_logs,
    ))
    .expect("the shell's sink starts");
    let state = ShellState::new(Workspace::new(None))
        .with_asset_root(scratch.0.join("assets"))
        .with_package_directory(packages.clone());
    tracing::subscriber::with_default(tracing_subscriber::registry().with(guard.layer()), || {
        let call = |id: &str| gx_telemetry::corr::enter(id);
        let session = {
            let _call = call("ed-open");
            state
                .execute_command(EditorCommand::OpenScene(OpenScene {
                    source: SceneSource::New {
                        id: "card".into(),
                        name: "Card".into(),
                    },
                }))
                .expect("a new scene opens")
                .session
                .expect("a session")
                .session
        };
        let target = SceneTarget::Session { session };
        for id in ["ed-edit-1", "ed-edit-2"] {
            let _call = call(id);
            state
                .execute_command(create_rect(session))
                .expect("applies");
        }
        {
            let _call = call("ed-pub-1");
            let first = state
                .publish_target(&endpoint, target.clone())
                .expect("publishes");
            assert_eq!(first.revision.0, 1);
        }
        {
            let _call = call("ed-edit-3");
            state
                .execute_command(create_rect(session))
                .expect("applies");
        }
        {
            let _call = call("ed-pub-2");
            let second = state
                .publish_target(&endpoint, target.clone())
                .expect("publishes");
            assert_eq!(second.revision.0, 2);
        }
        {
            // No edit since: the publish names none.
            let _call = call("ed-pub-3");
            let third = state.publish_target(&endpoint, target).expect("publishes");
            assert_eq!(third.revision.0, 3);
        }
    });
    guard.finish().expect("the shell's log is written");

    // The engine writes its file on its own thread: wait for the three publishes.
    let deadline = Instant::now() + Duration::from_secs(30);
    let engine = loop {
        let found = records(&engine_logs.join("engine"));
        if found
            .iter()
            .filter(|r| r["event"] == "publish.accepted")
            .count()
            >= 3
            || Instant::now() > deadline
        {
            break found;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let shell = records(&shell_logs.join("editor"));

    let accepted: Vec<&serde_json::Value> = engine
        .iter()
        .filter(|r| r["event"] == "publish.accepted")
        .collect();
    assert_eq!(accepted.len(), 3, "{engine:#?}");
    // Each publish is written under its own id and names exactly the edits since
    // the one before; a publish with no edit names none.
    assert_eq!(accepted[0]["corr"], "ed-pub-1");
    assert_eq!(accepted[0]["fields"]["carries"], "ed-edit-1,ed-edit-2");
    assert_eq!(accepted[1]["corr"], "ed-pub-2");
    assert_eq!(accepted[1]["fields"]["carries"], "ed-edit-3");
    assert_eq!(accepted[2]["corr"], "ed-pub-3");
    assert!(
        accepted[2]["fields"].get("carries").is_none(),
        "{}",
        accepted[2]
    );

    // The shell's own record of each publish says the same.
    let published: Vec<&serde_json::Value> = shell
        .iter()
        .filter(|r| r["event"] == "editor.publish" && r["fields"]["result"] == "published")
        .collect();
    assert_eq!(published.len(), 3);
    assert_eq!(published[0]["fields"]["carries"], "ed-edit-1,ed-edit-2");
    assert_eq!(published[1]["fields"]["carries"], "ed-edit-3");
    assert!(published[2]["fields"].get("carries").is_none());

    // One search for an edit's id follows it from the shell to the engine: its
    // own command record, and the engine's publish.
    let both: Vec<serde_json::Value> = shell.iter().chain(engine.iter()).cloned().collect();
    for (edit, publish) in [
        ("ed-edit-1", "ed-pub-1"),
        ("ed-edit-2", "ed-pub-1"),
        ("ed-edit-3", "ed-pub-2"),
    ] {
        let found = follow(edit, &both);
        assert!(
            found
                .iter()
                .any(|r| r["event"] == "editor.command" && r["fields"]["result"] == "applied"),
            "{edit}: the edit itself is on record"
        );
        assert!(
            found
                .iter()
                .any(|r| r["event"] == "publish.accepted" && r["corr"] == publish),
            "{edit}: the engine's publish.accepted for {publish} is found by it"
        );
    }
    // And not by an id it did not carry: the first publish does not name edit 3.
    assert!(!follow("ed-edit-3", &both)
        .iter()
        .any(|r| r["event"] == "publish.accepted" && r["corr"] == "ed-pub-1"));
}
