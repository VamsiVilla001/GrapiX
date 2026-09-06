mod supervisor;

use std::path::{Path, PathBuf};

use supervisor::{DesktopSupervisor, RuntimeLayout, SupervisorSnapshot};
use tauri::Manager;

/// Resolve the account directory shared by every GrapiX desktop product and seed it from an
/// existing installation without deleting or overwriting either product's legacy files.
fn shared_auth_root(data_root: &Path) -> Result<PathBuf, String> {
    let parent = data_root.parent().unwrap_or(data_root);
    let shared = parent.join("com.grapix.shared");
    std::fs::create_dir_all(&shared)
        .map_err(|error| format!("cannot create shared account directory: {error}"))?;

    let editor_legacy = parent.join("com.grapix.editor");
    for name in ["users.json", "signing-secret"] {
        let target = shared.join(name);
        if target.exists() {
            continue;
        }
        let source = editor_legacy.join(name);
        if source.is_file() {
            std::fs::copy(&source, &target)
                .map_err(|error| format!("cannot migrate shared {name}: {error}"))?;
        }
    }
    Ok(shared)
}

#[tauri::command]
fn supervisor_status(supervisor: tauri::State<'_, DesktopSupervisor>) -> SupervisorSnapshot {
    supervisor.snapshot()
}

/// Choose an After Effects project with the platform's own file dialog.
///
/// A browser file input reports a filename and never a location, and the project service needs the
/// location: registering a project is what makes its folder readable. So the path can only come
/// from a native dialog or from the author typing it, and a shell that can open one should.
///
/// `None` is a cancelled dialog, not a failure — the panel reports the two differently. The dialog
/// is opened through `AsyncFileDialog` because a Tauri command runs off the main thread, and a
/// blocking dialog raised from there deadlocks on macOS.
#[tauri::command]
async fn pick_ae_project() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose an After Effects project")
        .add_filter("After Effects project", &["aep"])
        .pick_file()
        .await
        .map(|handle| handle.path().to_string_lossy().into_owned())
}
/// Choose a project folder on disk with the platform's native folder dialog.
#[tauri::command]
async fn pick_project_folder() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose or create a GrapiX project folder")
        .pick_folder()
        .await
        .map(|handle| handle.path().to_string_lossy().into_owned())
}

/// Name a `.gpxpkg` project file with the platform's own save dialog.
///
/// This is the first thing an operator sees when they save a scene in a session that has no
/// project yet, so it is a *save* dialog rather than a folder picker: they type a project name,
/// choose where it lives, and the folder layout is created around the file they named. The same
/// order After Effects and XPression use, and the reason a scene can never be written somewhere
/// nobody chose.
#[tauri::command]
async fn pick_project_save_path() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Save GrapiX project")
        .add_filter("GrapiX project", &["gpx"])
        .set_file_name("Untitled Project.gpxpkg")
        .save_file()
        .await
        .map(|handle| handle.path().to_string_lossy().into_owned())
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
        .invoke_handler(tauri::generate_handler![
            supervisor_status,
            pick_ae_project,
            pick_project_folder,
            pick_project_save_path
        ])
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
            let auth_root = shared_auth_root(&data_root)?;

            let layout = RuntimeLayout {
                workspace_root: workspace,
                resource_root: resources,
                data_root,
                auth_root,
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
