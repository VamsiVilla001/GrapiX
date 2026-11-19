//! The menu both shells carry: Help, with the live telemetry panel (build plan
//! 2.27) and two ways to export a diagnostic bundle (2.14, ADR-0004 §8).
//!
//! - **Live telemetry**: asks the page to open its telemetry panel, by emitting
//!   [`TELEMETRY_EVENT`] to the window. The page owns the panel and the read;
//!   the menu owns only the way in, so both apps have it in the same place.
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
use tauri::{AppHandle, Emitter, Runtime};

/// The identifier of the item that opens the live telemetry panel.
pub const TELEMETRY_ITEM_ID: &str = "gx-telemetry-open";

/// What the telemetry item says.
pub const TELEMETRY_ITEM_TEXT: &str = "Live telemetry…";

/// The event the page listens for to open its telemetry panel.
pub const TELEMETRY_EVENT: &str = "gx-open-telemetry";

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
            let telemetry =
                MenuItemBuilder::with_id(TELEMETRY_ITEM_ID, TELEMETRY_ITEM_TEXT).build(handle)?;
            let all = MenuItemBuilder::with_id(EXPORT_ITEM_ID, EXPORT_ITEM_TEXT).build(handle)?;
            let own = MenuItemBuilder::with_id(EXPORT_MODULE_ITEM_ID, module_item_text(module))
                .build(handle)?;
            let help = SubmenuBuilder::new(handle, MENU_TEXT)
                .item(&telemetry)
                .separator()
                .item(&all)
                .item(&own)
                .build()?;
            MenuBuilder::new(handle).item(&help).build()
        })
        .on_menu_event(move |app, event| {
            if handle_telemetry_item(app, event.id().as_ref()) {
                return;
            }
            // The thread ends by itself; nothing waits for it.
            let _ = handle_menu_event(event.id().as_ref(), module);
        })
}

/// Export a diagnostic bundle from a page's own Help menu (the Editor has no
/// native menu): every module when `all_modules`, else `module` only. The same
/// export the native items start; the outcome is on the shell's record.
pub fn export_diagnostics(all_modules: bool, module: &str) -> std::thread::JoinHandle<()> {
    let id = if all_modules {
        EXPORT_ITEM_ID
    } else {
        EXPORT_MODULE_ITEM_ID
    };
    handle_menu_event(id, module).expect("an export item id always starts an export")
}

/// The telemetry item asks the page to open its panel. Returns whether `id` was
/// that item; any other item is left to [`handle_menu_event`].
pub fn handle_telemetry_item<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    if id != TELEMETRY_ITEM_ID {
        return false;
    }
    if let Err(error) = app.emit(TELEMETRY_EVENT, ()) {
        tracing::warn!(event = "telemetry.open_failed", detail = %error);
    }
    true
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
