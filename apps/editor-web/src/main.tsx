import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { useEditorStore } from "./store/editorStore";
import { useUiStore } from "./store/uiStore";
import "./styles.css";

// One-time UI-cache reset: clears persisted dock layout, panel splits and panel
// prefs (all "grapix-*" localStorage keys — scenes are stored via the API, not
// here) whenever the UI version changes, so a reskin/layout change starts fresh
// instead of restoring a stale cached layout. Bump the version to force a reset.
const UI_CACHE_VERSION = "2026-07-25-vizrt";
try {
  if (localStorage.getItem("grapix-ui-cache-version") !== UI_CACHE_VERSION) {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("grapix-") && key !== "grapix-ui-cache-version") {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem("grapix-ui-cache-version", UI_CACHE_VERSION);
  }
} catch {
  // localStorage unavailable — ignore.
}

// Dev-only debug handles (like window.__grapixRenderers) for driving the editor
// in verification/automation. Stripped from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __grapixStore?: unknown; __grapixUi?: unknown }).__grapixStore = useEditorStore;
  (window as unknown as { __grapixStore?: unknown; __grapixUi?: unknown }).__grapixUi = useUiStore;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
