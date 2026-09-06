//! GrapiX Playout desktop shell.
//!
//! A window around the operator UI plus a supervisor for the processes it needs. The
//! deliberate constraint: this shell is never authoritative for what is on air. Program
//! state lives in the render engine, so closing this window leaves the show running, and
//! reopening it adopts whatever is already there rather than restarting it.

mod supervisor;

use std::path::{Path, PathBuf};

use supervisor::{PlayoutSupervisor, RuntimeLayout, SupervisorSnapshot};
use tauri::Manager;

/// Resolve the account directory shared with the Editor and seed it from the authoritative
/// legacy Editor account when upgrading an installation that previously split the stores.
fn shared_auth_root(data_root: &Path) -> Result<PathBuf, String> {
    let parent = data_root.parent().unwrap_or(data_root);
    let shared = parent.join("com.grapix.shared");
    std::fs::create_dir_all(&shared)
        .map_err(|error| format!("cannot create shared account directory: {error}"))?;

    let candidates = [parent.join("com.grapix.editor"), data_root.to_path_buf()];
    for name in ["users.json", "signing-secret"] {
        let target = shared.join(name);
        if target.exists() {
            continue;
        }
        if let Some(source) = candidates
            .iter()
            .map(|root| root.join(name))
            .find(|path| path.is_file())
        {
            std::fs::copy(&source, &target)
                .map_err(|error| format!("cannot migrate shared {name}: {error}"))?;
        }
    }
    Ok(shared)
}

#[tauri::command]
fn supervisor_status(supervisor: tauri::State<'_, PlayoutSupervisor>) -> SupervisorSnapshot {
    supervisor.snapshot()
}

/// The control service's own view of the engine, as raw JSON.
///
/// Passed through rather than reinterpreted: the operator UI already knows how to read this
/// shape, and a shell that paraphrased it would give an operator a second, slightly different
/// truth about what is on air.
#[tauri::command]
fn engine_status() -> Option<String> {
    supervisor::control_engine_status()
}

/// The repository root, four levels above `Playout/apps/desktop-tauri/src-tauri`.
fn workspace_root() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .parent()?
        .parent()
        .map(Path::to_path_buf)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![supervisor_status, engine_status])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let workspace = workspace_root().filter(|path| path.exists());
            let resources = app.path().resource_dir().ok().filter(|path| path.exists());
            let data_root = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("cannot resolve AppData directory: {error}"))?;
            std::fs::create_dir_all(&data_root)
                .map_err(|error| format!("cannot create data directory: {error}"))?;
            let auth_root = shared_auth_root(&data_root)?;
            let layout = RuntimeLayout {
                workspace_root: workspace,
                resource_root: resources,
                data_root,
                auth_root,
            };
            app.manage(PlayoutSupervisor::start(layout, app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Auxiliary virtual-output windows are disposable confidence views. Closing
                // one must not stop the control service or disturb the main operator window.
                if window.label() != "main" {
                    return;
                }
                if let Some(supervisor) = window.app_handle().try_state::<PlayoutSupervisor>() {
                    // Stops only what this shell started. An adopted engine may be on air.
                    supervisor.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the GrapiX Playout shell");
}
