/** Copies the static plugin UI next to the bundled sandbox code. */

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

await mkdir(path.join(root, "dist"), { recursive: true });
await copyFile(path.join(root, "ui.html"), path.join(root, "dist", "ui.html"));

console.log("copied ui.html -> dist/ui.html");
