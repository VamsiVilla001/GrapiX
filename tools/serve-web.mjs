// A static file server used only to exercise a shell's web layer in a real
// browser during development. Tauri serves these files itself at runtime;
// this exists so the page can be opened over a genuine origin, since ES
// modules do not load from `file://`.

import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8199);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const target = join(root, relative === "" ? "index.html" : relative);

  // Never serve outside the root, whatever the path claims.
  if (!target.startsWith(root)) {
    response.writeHead(403).end("outside the served root");
    return;
  }
  try {
    const bytes = await readFile(target);
    response.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream" });
    response.end(bytes);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
