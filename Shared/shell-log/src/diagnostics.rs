//! The menu both shells carry: Help, then two ways to export a diagnostic bundle
//! (build plan 2.14, ADR-0004 §8).
//!
//! - **Export diagnostic bundle (all modules)**: every module that wrote a log.
//! - **Export diagnostic bundle (this module only)**: the shell's own module
//!   (`editor` or `playout`), for a report about this product alone.
//!
//! Either runs [`gx_diag::export_for_shell`] on its own thread (hashing the
//! executables takes seconds, and the menu must not hold the window), under a
//! correlation id of its own, then shows the bundle in the file manager. The
//! outcome is on the shell's record (`diag.bundle`, `diag.bundle_failed`,
//! `diag.credential_found`). When a bundle cannot be written the log folder is
//! opened instead, so the person finds what there is: the shells have no dialog
//! of their own to say more, and Playout carries no dialog dependency.

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Runtime;

/// The identifier of the item that exports every module.
pub const EXPORT_ITEM_ID: &str = "gx-diag-export";

/// The identifier of the item that exports the shell's own module.
pub const EXPORT_MODULE_ITEM_ID: &str = "gx-diag-export-module";

/// What the all-modules item says.
pub const EXPORT_ITEM_TEXT: &str = "Export diagnostic bundle (all modules)";

/// The menu the items are in.
pub const MENU_TEXT: &str = "Help";

/// Set to any value to export without opening the file manager (an automated
/// check, a machine with nobody at it).
pub const NO_REVEAL_ENV: &str = "GX_DIAG_NO_REVEAL";

/// What the own-module item says for `module`.
pub fn module_item_text(module: &str) -> String {
    format!("Export diagnostic bundle ({module} only)")
}

/// Give `builder` the Help menu with both export items, and handle them.
/// `module` is the shell's own module: its folder under the log root.
pub fn with_diagnostics_menu<R: Runtime>(
    builder: tauri::Builder<R>,
    module: &'static str,
) -> tauri::Builder<R> {
    builder
        .menu(move |handle| {
            let all = MenuItemBuilder::with_id(EXPORT_ITEM_ID, EXPORT_ITEM_TEXT).build(handle)?;
            let own = MenuItemBuilder::with_id(EXPORT_MODULE_ITEM_ID, module_item_text(module))
                .build(handle)?;
            let help = SubmenuBuilder::new(handle, MENU_TEXT)
                .item(&all)
                .item(&own)
                .build()?;
            MenuBuilder::new(handle).item(&help).build()
        })
        .on_menu_event(move |_app, event| {
            // The thread ends by itself; nothing waits for it.
            let _ = handle_menu_event(event.id().as_ref(), module);
        })
}

/// What a menu event does: an export item starts an export and returns its
/// thread; any other item does nothing. `module` is the shell's own module.
pub fn handle_menu_event(id: &str, module: &str) -> Option<std::thread::JoinHandle<()>> {
    let modules: Vec<String> = match id {
        EXPORT_ITEM_ID => Vec::new(),
        EXPORT_MODULE_ITEM_ID => vec![module.to_owned()],
        _ => return None,
    };
    Some(std::thread::spawn(move || export_and_show(&modules)))
}

fn export_and_show(modules: &[String]) {
    let _scope = gx_telemetry::corr::enter(&gx_telemetry::corr::mint("diag"));
    let show = std::env::var_os(NO_REVEAL_ENV).is_none();
    match gx_diag::export_for_shell(modules) {
        Ok(collected) => {
            if show {
                let shown = gx_diag::reveal(&collected.path);
                tracing::info!(event = "diag.revealed", shown);
            }
        }
        Err(_) => {
            // Already on record by `export_for_shell`; the person is shown the logs.
            if show {
                if let Ok(root) = gx_telemetry::sink::log_directory() {
                    gx_diag::reveal_folder(&root);
                }
            }
        }
    }
}
