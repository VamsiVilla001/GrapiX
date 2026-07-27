import { createHash } from "node:crypto";

const MAX_SCRIPT_BYTES = 128 * 1024;
const forbiddenPatterns: Array<[RegExp, string]> = [
  [/\bimport\s*(?:\(|[\w{*])/u, "imports are not allowed; use only @grapix/sdk APIs"],
  [/\brequire\s*\(/u, "require() is not allowed"],
  [/\b(?:process|globalThis|global|window|document)\b/u, "host globals are not allowed"],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/u, "network APIs are not allowed"],
  [/\b(?:eval|Function|WebAssembly)\b/u, "dynamic code generation is not allowed"],
  [/\b(?:SharedArrayBuffer|Atomics)\b/u, "shared-memory APIs are not allowed"],
  [/\b(?:child_process|worker_threads|node:|file:)\b/u, "Node and filesystem APIs are not allowed"]
];

export interface SceneScriptImportReport {
  accepted: boolean;
  checksum: string;
  sizeBytes: number;
  errors: string[];
  warnings: string[];
  apiVersion: 1;
  execution: "control-sandbox";
}

export function inspectSceneScript(bytes: Buffer, fileName: string): SceneScriptImportReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const extension = fileName.toLowerCase().split(".").pop();
  if (extension !== "js" && extension !== "mjs") {
    errors.push("Scene scripts must use a .js or .mjs extension");
  }
  if (bytes.length === 0) errors.push("Scene script is empty");
  if (bytes.length > MAX_SCRIPT_BYTES) errors.push("Scene script exceeds the 128 KiB limit");
  if (bytes.includes(0)) errors.push("Scene script must be UTF-8 text without NUL bytes");

  const source = bytes.toString("utf8");
  if (!/\bexport\s+default\b/u.test(source)) {
    errors.push("Scene script must export one default GrapiX scene module");
  }
  if (!/\bdefineSceneScript\s*\(/u.test(source)) {
    warnings.push("Use defineSceneScript(...) from the GrapiX SDK for validation and typed authoring");
  }
  for (const [pattern, message] of forbiddenPatterns) {
    if (pattern.test(source)) errors.push(message);
  }

  return {
    accepted: errors.length === 0,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    errors,
    warnings,
    apiVersion: 1,
    execution: "control-sandbox"
  };
}
