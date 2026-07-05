import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("grapixDesktop", {
  apiBaseUrl: "http://127.0.0.1:4100",
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  }
});
