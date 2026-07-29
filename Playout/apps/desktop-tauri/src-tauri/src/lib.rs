//! GrapiX Playout desktop shell.
//!
//! A window around the operator UI plus a supervisor for the processes it needs. The
//! deliberate constraint: this shell is never authoritative for what is on air. Program
//! state lives in the render engine, so closing this window leaves the show running, and
//! reopening it adopts whatever is already there rather than restarting it.

mod supervisor;

use std::path::{Path, PathBuf};

use supervisor::{PlayoutSupervisor, SupervisorSnapshot};
use tauri::Manager;

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
            let root = workspace_root().ok_or("failed to resolve the GrapiX workspace root")?;
            app.manage(PlayoutSupervisor::start(root, app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(supervisor) = window.app_handle().try_state::<PlayoutSupervisor>() {
                    // Stops only what this shell started. An adopted engine may be on air.
                    supervisor.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the GrapiX Playout shell");
}
