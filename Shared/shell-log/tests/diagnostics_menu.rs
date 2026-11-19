//! 2.14: the menu both shells carry, and what choosing each item does.
//!
//! One test, because it points the log root at a scratch folder through the
//! environment and that is process-wide.

use gx_shell_log::diagnostics::{module_item_text, EXPORT_MODULE_ITEM_ID};
use gx_shell_log::{
    handle_menu_event, handle_telemetry_item, with_diagnostics_menu, EXPORT_ITEM_ID,
    EXPORT_ITEM_TEXT, MENU_TEXT, TELEMETRY_EVENT, TELEMETRY_ITEM_ID, TELEMETRY_ITEM_TEXT,
};
use tauri::menu::MenuItemKind;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Listener;

fn log(root: &std::path::Path, module: &str, file: &str) {
    std::fs::create_dir_all(root.join(module)).unwrap();
    std::fs::write(
        root.join(module).join(file),
        "{\"ts\":\"2026-11-17T10:00:01.000000Z\",\"seq\":1,\"level\":\"info\",\"event\":\"x.start\",\"fields\":{}}\n",
    )
    .unwrap();
}

fn bundles(root: &std::path::Path) -> Vec<Vec<String>> {
    let mut paths: Vec<_> = std::fs::read_dir(root.join("bundles"))
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    paths.sort();
    paths
        .iter()
        .map(|path| {
            let archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
            archive.file_names().map(str::to_owned).collect()
        })
        .collect()
}

#[test]
fn a_shell_has_both_export_items_under_help_and_each_writes_its_bundle() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let root = std::env::temp_dir().join(format!("gx-shell-diag-{}-{nanos}", std::process::id()));
    log(&root, "engine", "worker-20261117T100000Z-7.jsonl");
    log(&root, "editor", "shell-20261117T100000Z-8.jsonl");
    std::env::set_var("GX_LOG_DIR", &root);
    std::env::set_var("GX_DIAG_NO_REVEAL", "1");

    // The menu: Help, with the two items.
    let app = with_diagnostics_menu(mock_builder(), "editor")
        .build(mock_context(noop_assets()))
        .expect("the app builds with the menu");
    let menu = app.menu().expect("the app has a menu");
    let help = menu
        .items()
        .expect("the menu's items")
        .into_iter()
        .find_map(|item| match item {
            MenuItemKind::Submenu(submenu) if submenu.text().ok().as_deref() == Some(MENU_TEXT) => {
                Some(submenu)
            }
            _ => None,
        })
        .expect("a Help menu");
    let text_of = |id: &str| match help.get(id) {
        Some(MenuItemKind::MenuItem(item)) => item.text().expect("its text"),
        _ => panic!("{id} is not a plain item under Help"),
    };
    assert_eq!(text_of(TELEMETRY_ITEM_ID), TELEMETRY_ITEM_TEXT);
    assert_eq!(text_of(EXPORT_ITEM_ID), EXPORT_ITEM_TEXT);
    assert_eq!(text_of(EXPORT_MODULE_ITEM_ID), module_item_text("editor"));
    assert_eq!(
        module_item_text("editor"),
        "Export diagnostic bundle (editor only)"
    );

    // The telemetry item asks the page to open its panel, and starts no export.
    let opened = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = std::sync::Arc::clone(&opened);
    app.handle().listen(TELEMETRY_EVENT, move |_| {
        seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    assert!(!handle_telemetry_item(app.handle(), EXPORT_ITEM_ID));
    assert!(!handle_telemetry_item(app.handle(), "some-other-item"));
    assert!(handle_telemetry_item(app.handle(), TELEMETRY_ITEM_ID));
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert_eq!(opened.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(handle_menu_event(TELEMETRY_ITEM_ID, "editor").is_none());
    assert!(bundles(&root).is_empty());

    // Another item does nothing.
    assert!(handle_menu_event("some-other-item", "editor").is_none());
    assert!(bundles(&root).is_empty());

    // This module only: the Editor's logs and summary, and nothing of the engine's.
    handle_menu_event(EXPORT_MODULE_ITEM_ID, "editor")
        .expect("the own-module item starts an export")
        .join()
        .expect("the export finished");
    let made = bundles(&root);
    assert_eq!(made.len(), 1, "{made:?}");
    let names = &made[0];
    assert!(
        names
            .iter()
            .any(|n| n == "modules/editor/logs/shell-20261117T100000Z-8.jsonl"),
        "{names:?}"
    );
    assert!(
        names.iter().any(|n| n == "modules/editor/summary.json"),
        "{names:?}"
    );
    assert!(
        !names.iter().any(|n| n.starts_with("modules/engine/")),
        "{names:?}"
    );
    std::fs::remove_dir_all(root.join("bundles")).unwrap();

    // All modules: both.
    handle_menu_event(EXPORT_ITEM_ID, "editor")
        .expect("the all-modules item starts an export")
        .join()
        .expect("the export finished");
    let made = bundles(&root);
    assert_eq!(made.len(), 1, "{made:?}");
    let names = &made[0];
    for expected in [
        "manifest.json",
        "modules/editor/summary.json",
        "modules/engine/summary.json",
        "modules/engine/logs/worker-20261117T100000Z-7.jsonl",
        "modules/engine/devices.json",
    ] {
        assert!(
            names.iter().any(|n| n == expected),
            "{expected} in {names:?}"
        );
    }

    // A page's own Help menu (the Editor has no native one) starts the same export.
    std::fs::remove_dir_all(root.join("bundles")).unwrap();
    gx_shell_log::export_diagnostics(false, "editor")
        .join()
        .expect("the export finished");
    let made = bundles(&root);
    assert_eq!(made.len(), 1, "{made:?}");
    assert!(
        made[0].iter().any(|n| n == "modules/editor/summary.json"),
        "{:?}",
        made[0]
    );
    assert!(
        !made[0].iter().any(|n| n.starts_with("modules/engine/")),
        "{:?}",
        made[0]
    );
    let _ = std::fs::remove_dir_all(root);
}
