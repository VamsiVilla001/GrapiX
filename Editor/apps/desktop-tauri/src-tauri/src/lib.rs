mod supervisor;

use std::path::{Path, PathBuf};

use supervisor::{DesktopSupervisor, RuntimeLayout, SupervisorSnapshot};
use tauri::Manager;

#[tauri::command]
fn supervisor_status(supervisor: tauri::State<'_, DesktopSupervisor>) -> SupervisorSnapshot {
    supervisor.snapshot()
}

/// The repository root, four levels above `Editor/apps/desktop-tauri/src-tauri`.
///
/// A packaged build has no such tree beside the .exe: `CARGO_MANIFEST_DIR` was recorded at
/// compile time and points at a machine that is not the operator's. This still returns a
/// path there, so callers must verify it exists before using it. `RuntimeLayout` does that.
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

            // Two resolutions matter here, and neither is guaranteed to exist.
            //
            // - `workspace_root` was baked in at compile time. Present on the developer's
            //   machine; a fantasy path on the operator's, so only used when it is really
            //   there.
            // - `resource_dir` is Tauri's own answer to "where did the installer put my
            //   `bundle.resources`?". Present in packaged builds; absent under `cargo run`.
            //
            // The supervisor is willing to work with just one. Data is always written under
            // the OS's per-user AppData dir so a Program-Files install stays read-only.
            let workspace = workspace_root().filter(|path| path.exists());
            let resources = app.path().resource_dir().ok().filter(|path| path.exists());
            let data_root = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("cannot resolve AppData directory: {error}"))?;
            std::fs::create_dir_all(&data_root)
                .map_err(|error| format!("cannot create data directory: {error}"))?;

            let layout = RuntimeLayout {
                workspace_root: workspace,
                resource_root: resources,
                data_root,
            };
            app.manage(DesktopSupervisor::start(layout, app.handle().clone()));
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
