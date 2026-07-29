mod supervisor;

use std::path::{Path, PathBuf};

use supervisor::{DesktopSupervisor, SupervisorSnapshot};
use tauri::Manager;

#[tauri::command]
fn supervisor_status(supervisor: tauri::State<'_, DesktopSupervisor>) -> SupervisorSnapshot {
    supervisor.snapshot()
}

/// The repository root, four levels above `Editor/apps/desktop-tauri/src-tauri`.
///
/// One level deeper than before the Phase 2 migration. A wrong answer here is not a compile
/// error — the supervisor would look for services in the wrong place and quietly start none.
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
        .invoke_handler(tauri::generate_handler![supervisor_status])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let root = workspace_root().ok_or("failed to resolve GrapiX workspace root")?;
            app.manage(DesktopSupervisor::start(root, app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(supervisor) = window.app_handle().try_state::<DesktopSupervisor>() {
                    supervisor.shutdown();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
