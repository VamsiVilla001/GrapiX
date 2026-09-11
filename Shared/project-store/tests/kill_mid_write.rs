//! Process-death verification for build-plan step 2.6.
//!
//! This invokes the real writer binary and terminates it repeatedly while it
//! is replacing the same document. A parser-only unit test cannot cover the
//! operating system's process-death and rename window.

#![forbid(unsafe_code)]

use std::fs;
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gx_contracts::platform::service_data_root;
use gx_project_store::{ProjectDocument, ProjectStore};

const KILL_ITERATIONS: u32 = 48;

#[test]
fn killing_a_writer_mid_save_leaves_a_complete_project_document() {
    let store = ProjectStore::open().unwrap();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let project = store.project_key(format!("test-kill-{}-{nonce}", std::process::id()));
    let project_directory = service_data_root()
        .unwrap()
        .join("projects")
        .join(project.display());
    store
        .save(
            &project,
            &ProjectDocument::new(&project, serde_json::json!({ "version": 1 })),
        )
        .unwrap();
    let writer = std::env::current_exe()
        .unwrap()
        .parent()
        .and_then(|directory| directory.parent())
        .unwrap()
        .join(if cfg!(windows) {
            "project_store_writer.exe"
        } else {
            "project_store_writer"
        });
    assert!(
        writer.is_file(),
        "cargo must build the project-store writer binary at {}",
        writer.display()
    );
    for iteration in 0..KILL_ITERATIONS {
        let mut child = Command::new(&writer)
            .arg(project.display())
            .spawn()
            .unwrap();
        thread::sleep(Duration::from_millis(2 + u64::from(iteration % 17)));
        child.kill().unwrap();
        child.wait().unwrap();

        let loaded = store.load(&project).unwrap();
        assert!(matches!(loaded.contents["version"].as_u64(), Some(1 | 2)));
    }

    fs::remove_dir_all(project_directory).unwrap();
}
