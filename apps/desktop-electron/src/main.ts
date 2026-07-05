import { app, BrowserWindow, Menu, net, protocol, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");
const editorDistPath = path.join(workspaceRoot, "apps", "editor-web", "dist");
const apiEntryPath = path.join(workspaceRoot, "services", "api-server", "dist", "index.js");
const apiBaseUrl = "http://127.0.0.1:4100";

let mainWindow: BrowserWindow | null = null;
let apiServer: { close: () => Promise<void> } | null = null;

interface ApiServerModule {
  startApiServer: (options: { host: string; port: number; logger: boolean }) => Promise<{ close: () => Promise<void> }>;
}

app.setName("GrapiX");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "grapix",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
});

app.whenReady().then(async () => {
  registerEditorProtocol();
  installApplicationMenu();
  await startLocalApi();
  createMainWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopLocalApi();
});

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#0b0f14",
    title: "GrapiX",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);

    return { action: "deny" };
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[grapix-window] failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`);
    if (process.env.GRAPIX_ELECTRON_SMOKE === "1") {
      app.exit(1);
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    console.log(`[grapix-window] loaded ${mainWindow?.webContents.getURL() ?? "unknown url"}`);
    if (process.env.GRAPIX_ELECTRON_SMOKE === "1") {
      setTimeout(() => app.quit(), 800);
    }
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[grapix-window] renderer process gone: ${details.reason}`);
  });

  const editorDevUrl = process.env.GRAPIX_EDITOR_URL;

  if (editorDevUrl) {
    void mainWindow.loadURL(editorDevUrl);
  } else {
    void mainWindow.loadURL("grapix://editor/index.html");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerEditorProtocol(): void {
  protocol.handle("grapix", (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.normalize(path.join(editorDistPath, requestedPath));

    if (!filePath.startsWith(editorDistPath)) {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

async function startLocalApi(): Promise<void> {
  if (await isApiOnline()) {
    return;
  }

  const apiModule = await import(pathToFileURL(apiEntryPath).href) as ApiServerModule;

  apiServer = await apiModule.startApiServer({
    host: "127.0.0.1",
    port: 4100,
    logger: true
  });

  await waitForApi();
}

function stopLocalApi(): void {
  void apiServer?.close();
  apiServer = null;
}

async function waitForApi(): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if (await isApiOnline()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
}

async function isApiOnline(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`);

    return response.ok;
  } catch {
    return false;
  }
}

function installApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => createMainWindow()
        },
        { type: "separator" },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => BrowserWindow.getFocusedWindow()?.reload()
        },
        { type: "separator" },
        {
          label: "Quit",
          accelerator: "Alt+F4",
          role: "quit"
        }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" }
      ]
    }
  ]);

  Menu.setApplicationMenu(menu);
}
