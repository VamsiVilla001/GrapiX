//! What both shells share of logging: the invoke wrapper (build-plan row 2.13, ADR-0004 §2, §6)
//! and the diagnostic bundle's menu item (row 2.14, [`diagnostics`]).
//!
//! A front end sends its correlation id as the request header
//! [`gx_telemetry::ui::CORR_HEADER`]. [`scoped`] wraps a shell's whole invoke
//! handler, reads that header for every command, and runs the command inside a
//! correlation scope, so each record the command writes (and each control-plane
//! or asset-plane request it makes) carries the call's id with no change to any
//! command. A call with no header, or one whose id is not plain, still gets an
//! id: the shell mints one.
//!
//! **Synchronous commands only.** The scope belongs to the thread the call
//! arrived on, and a synchronous command runs on it. An `async` command would
//! run elsewhere and write without the id; both shells' commands are all
//! synchronous, and a test here fails if a command ran outside its scope.

#![forbid(unsafe_code)]

pub mod diagnostics;

pub use diagnostics::{
    export_diagnostics, handle_menu_event, handle_telemetry_item, with_diagnostics_menu,
    EXPORT_ITEM_ID, EXPORT_ITEM_TEXT, MENU_TEXT, TELEMETRY_EVENT, TELEMETRY_ITEM_ID,
    TELEMETRY_ITEM_TEXT,
};

use tauri::ipc::Invoke;
use tauri::Runtime;

/// Wrap `handler` (the value of `tauri::generate_handler!`) so each command
/// runs inside the scope of the correlation id its call carried.
pub fn scoped<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let header = invoke
            .message
            .headers()
            .get(gx_telemetry::ui::CORR_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let _scope = gx_telemetry::ui::enter_call(header.as_deref(), invoke.message.command());
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    /// The id the command itself sees: what its own log records would carry.
    #[tauri::command]
    fn probe() -> Option<String> {
        gx_telemetry::corr::current()
    }

    fn call(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        header: Option<&str>,
    ) -> Option<String> {
        let mut headers = tauri::http::HeaderMap::new();
        if let Some(value) = header {
            headers.insert(
                gx_telemetry::ui::CORR_HEADER,
                tauri::http::HeaderValue::from_str(value).expect("a header value"),
            );
        }
        let response = get_ipc_response(
            webview,
            InvokeRequest {
                cmd: "probe".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::default(),
                headers,
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("the command ran");
        response
            .deserialize::<Option<String>>()
            .expect("an optional id")
    }

    #[test]
    fn a_command_runs_inside_the_scope_of_the_id_its_call_carried() {
        let app = mock_builder()
            .invoke_handler(scoped(tauri::generate_handler![probe]))
            .build(mock_context(noop_assets()))
            .expect("the mock app builds");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("the mock window builds");

        // The id the front end minted.
        assert_eq!(
            call(&webview, Some("ed-1a2b-7")).as_deref(),
            Some("ed-1a2b-7")
        );
        // None: the shell mints one, so every call can be followed.
        let minted = call(&webview, None).expect("an id was minted");
        assert!(minted.starts_with("shell-"), "{minted}");
        // One that is not plain, a credential among them: replaced.
        for hostile in ["gx1.payload.mac", "has a space", &"x".repeat(200)] {
            let replaced = call(&webview, Some(hostile)).expect("an id was minted");
            assert!(replaced.starts_with("shell-"), "{replaced}");
        }
        // The scope ends with the call: another call is another action.
        assert_ne!(call(&webview, None), call(&webview, None));
        assert_eq!(gx_telemetry::corr::current(), None);
    }
}
