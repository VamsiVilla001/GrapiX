//! Repeatedly replace one project document for the project-store kill test.
//!
//! The parent process terminates this helper at arbitrary points while it is
//! writing, exercising the actual process-death window rather than a mocked
//! error path.

#![forbid(unsafe_code)]

use gx_project_store::{ProjectDocument, ProjectStore};

fn main() {
    let Some(name) = std::env::args().nth(1) else {
        eprintln!("usage: project_store_writer <project-name>");
        std::process::exit(2);
    };
    let store = ProjectStore::open().unwrap_or_else(|error| {
        eprintln!("could not open project store: {error}");
        std::process::exit(1);
    });
    let project = store.project_key(name);
    let payload = "x".repeat(512 * 1024);
    let mut document = ProjectDocument::new(
        &project,
        serde_json::json!({
            "version": 1,
            "payload": payload,
        }),
    );

    loop {
        document.contents["version"] = serde_json::json!(1);
        store.save(&project, &document).unwrap_or_else(|error| {
            eprintln!("could not save project: {error}");
            std::process::exit(1);
        });
        document.contents["version"] = serde_json::json!(2);
        store.save(&project, &document).unwrap_or_else(|error| {
            eprintln!("could not save project: {error}");
            std::process::exit(1);
        });
    }
}
