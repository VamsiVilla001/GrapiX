import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  WebviewWindow,
  getCurrentWebviewWindow
} from "@tauri-apps/api/webviewWindow";

import {
  isProgramExplicitlyCleared,
  monitorStreamUrl,
  playoutApi,
  subscribeToPlayoutEvents
} from "./api";

/**
 * A decorated native Program window for a configured virtual output.
 *
 * The render engine remains the source: this window only paints the Program monitor stream.
 * Closing it cannot stop Program or the local-only adapter. The output id is display identity;
 * every configured virtual output receives the same byte-identical Program frame today.
 */
export function VirtualOutputWindow({ outputId }: { outputId: string }) {
  const nativeWindow = "__TAURI_INTERNALS__" in window;
  const [painting, setPainting] = useState(false);
  const [programExplicitlyCleared, setProgramExplicitlyCleared] = useState(false);
  const [stayOnTop, setStayOnTop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `GrapiX Windowed Output — ${outputId}`;
  }, [outputId]);

  useEffect(() => {
    if (!nativeWindow) return;
    let cancelled = false;
    const current = getCurrentWebviewWindow();
    void Promise.all([current.isAlwaysOnTop(), current.isFullscreen()])
      .then(([alwaysOnTop, isFullscreen]) => {
        if (!cancelled) {
          setStayOnTop(alwaysOnTop);
          setFullscreen(isFullscreen);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWindowError(`Could not read window state: ${String(error)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nativeWindow]);

  useEffect(() => {
    let cancelled = false;
    const refreshProgramState = async () => {
      try {
        const status = await playoutApi.status();
        if (!cancelled) setProgramExplicitlyCleared(isProgramExplicitlyCleared(status));
      } catch {
        // Keep the last trustworthy state. The event source and polling both recover.
      }
    };

    void refreshProgramState();
    const detachEvents = subscribeToPlayoutEvents((kind) => {
      if (kind === "runtime.changed") void refreshProgramState();
    });
    const statusTimer = window.setInterval(refreshProgramState, 3000);
    return () => {
      cancelled = true;
      detachEvents();
      window.clearInterval(statusTimer);
    };
  }, []);

  async function closeOutput() {
    setWindowError(null);
    try {
      if (nativeWindow) {
        await getCurrentWebviewWindow().close();
      } else {
        window.close();
      }
    } catch (error) {
      setWindowError(`Could not close windowed output: ${String(error)}`);
    }
  }

  async function toggleStayOnTop() {
    if (!nativeWindow) return;
    setWindowError(null);
    const next = !stayOnTop;
    try {
      await getCurrentWebviewWindow().setAlwaysOnTop(next);
      setStayOnTop(next);
      setContextMenu(null);
    } catch (error) {
      setWindowError(`Could not change stay-on-top state: ${String(error)}`);
    }
  }

  async function toggleFullscreen() {
    if (!nativeWindow) return;
    setWindowError(null);
    try {
      const current = getCurrentWebviewWindow();
      const next = !(await current.isFullscreen());
      await current.setFullscreen(next);
      setFullscreen(next);
      setContextMenu(null);
    } catch (error) {
      setWindowError(`Could not change full-screen state: ${String(error)}`);
    }
  }

  async function minimizeOutput() {
    if (!nativeWindow) return;
    setWindowError(null);
    setContextMenu(null);
    try {
      await getCurrentWebviewWindow().minimize();
    } catch (error) {
      setWindowError(`Could not minimize windowed output: ${String(error)}`);
    }
  }

  function openContextMenu(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    if (nativeWindow) {
      const current = getCurrentWebviewWindow();
      void Promise.all([current.isAlwaysOnTop(), current.isFullscreen()])
        .then(([alwaysOnTop, isFullscreen]) => {
          setStayOnTop(alwaysOnTop);
          setFullscreen(isFullscreen);
        })
        .catch(() => undefined);
    }
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 188))
    });
  }

  return (
    <main
      className="virtual-output-window"
      onContextMenu={openContextMenu}
      onPointerDown={() => setContextMenu(null)}
    >
      {!painting ? <div className="virtual-output-status">Waiting for Program…</div> : null}
      <img
        className={painting ? "painting" : ""}
        src={monitorStreamUrl("program", "fill", "output")}
        alt={`Windowed virtual output ${outputId}`}
        onLoad={() => setPainting(true)}
        onError={() => setPainting(false)}
      />
      {programExplicitlyCleared ? (
        <div className="virtual-output-clear" aria-hidden="true" />
      ) : null}
      {contextMenu ? (
        <div
          className="virtual-output-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={stayOnTop}
            disabled={!nativeWindow}
            onClick={() => void toggleStayOnTop()}
          >
            <span aria-hidden="true">{stayOnTop ? "✓" : ""}</span>
            Stay on top
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={fullscreen}
            disabled={!nativeWindow}
            onClick={() => void toggleFullscreen()}
          >
            <span aria-hidden="true">{fullscreen ? "✓" : ""}</span>
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!nativeWindow}
            onClick={() => void minimizeOutput()}
          >
            <span aria-hidden="true">—</span>
            Minimize
          </button>
          <div className="virtual-output-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => void closeOutput()}>
            <span aria-hidden="true">×</span>
            Close windowed output
          </button>
          {windowError ? <p role="alert">{windowError}</p> : null}
        </div>
      ) : null}
    </main>
  );
}

/** Open a decorated native Program window in Tauri, with a browser fallback for development. */
export async function openVirtualOutputWindow(outputId: string): Promise<boolean> {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("virtualOutput", "program");
  url.searchParams.set("outputId", outputId);

  if (!("__TAURI_INTERNALS__" in window)) {
    return (
      window.open(
        url,
        `grapix-virtual-output-${outputId}`,
        "popup=yes,width=1280,height=720,menubar=no,toolbar=no,location=no,status=no,resizable=yes"
      ) !== null
    );
  }

  const safeOutputId = outputId.replace(
    /[^a-zA-Z0-9_-]/gu,
    (character) => `-${character.codePointAt(0)?.toString(16) ?? "0"}-`
  );
  const label = `virtual-output-${safeOutputId || "program"}`;
  const existing = await WebviewWindow.getByLabel(label);

  if (existing) {
    await existing.unminimize();
    await existing.show();
    await existing.setFocus();
    return true;
  }

  const outputWindow = new WebviewWindow(label, {
    url: `${url.pathname}${url.search}`,
    title: `GrapiX Windowed Output — ${outputId}`,
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    resizable: true,
    decorations: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    fullscreen: false,
    center: true
  });

  return new Promise<boolean>((resolve, reject) => {
    void outputWindow.once("tauri://created", () => resolve(true));
    void outputWindow.once<unknown>("tauri://error", (event) => {
      reject(new Error(`Native virtual output window creation failed: ${String(event.payload)}`));
    });
  });
}
