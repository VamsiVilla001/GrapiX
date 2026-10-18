#!/usr/bin/env node
// Structural guard. Cheap, so run it after touching any manifest, moving any
// file, or adding an Editor surface. It fails on a cross-domain dependency or a
// second authoring path rather than letting one appear quietly and be
// discovered months later.
//
// Enforces:
//   invariant 1  Shared is contracts, and cannot depend on Editor or Playout
//   invariant 3  Editor and Playout never import renderer internals
//   invariant 23 generated output is generated, never hand-authored
//   invariant 60 every authoring mutation is an `EditorCommand`:
//     R1 the Tauri surface is exactly `cmd_execute` plus the named reads
//     R2 store writes happen only in the Editor store chokepoints
//     R3 Editor-side crates never call contract mutators except via `apply_edits`
//     R4 the browser invokes only named shell commands, never with a document
//     R5 Editor MCP structs never carry a whole `SceneDocument` (the per-tool
//        input rule is a Rust test in Shared/contracts/src/mcp.rs)
//     R6 Editor-side crates never depend on a control-plane client (invariant 4)
//     R7 every generated schema carries its generated header
//     R8 nothing but the control plane binds port 4100 (project-api would have
//        to accept only `EditorCommand`)
//
// `check(files)` is pure over an explicit file set so the rules can be tested
// with synthetic files; walking the repository happens only from the CLI.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIPPED_DIRECTORIES = ["node_modules", "target", "dist", ".git", ".claude", "agent", "legacy", "bindings"];

/** The one mutating Tauri command and the pure reads (spec 11.36 §4.4). */
const SHELL_MUTATE = ["cmd_execute"];
const SHELL_READ = [
  "cmd_session_view", "cmd_publish", "cmd_take_page_preview",
  "cmd_object_kinds", "cmd_animation_surface", "cmd_control_properties",
  "cmd_starter_presets", "cmd_motion_presets", "cmd_default_endpoint", "cmd_project_list",
  "cmd_scene_list", "cmd_scene_read", "cmd_take_page_list", "cmd_take_page_read",
  "cmd_font_bytes", "cmd_project_assets", "cmd_asset_bytes",
];
/** Font ingest (11.13) and asset import (11.39): write only the
 *  content-addressed asset cache and return a batch that reaches a scene as
 *  one `addFonts` or `addAssets` edit. Held to the read rule: no authoring
 *  document or command parameter. */
const SHELL_PREPARE = ["cmd_font_prepare_files", "cmd_font_prepare_link", "cmd_asset_prepare_files", "cmd_project_assets_adopt"];
const SHELL_SURFACE = new Set([...SHELL_MUTATE, ...SHELL_READ, ...SHELL_PREPARE]);
const READ_SURFACE = new Set([...SHELL_READ, ...SHELL_PREPARE]);

const DOCUMENT_TYPES = /\b(?:SceneDocument|TakePage|TextStyle|ControlField|SceneKeyframe|TimelinePhase|DataContext|EditorCommand|SceneEdit)\b/;
const STORE_WRITES = /\.(?:write_scene|delete_scene|create_project|write_take_page|confirm)\s*\(|\breplace_asset_bytes\s*\(|\bgx_fs::write_atomic\s*\(|\bfs::write\s*\(/;
const CONTRACT_MUTATORS = /\b(?:create_object|delete_object|duplicate_object|rename_object|set_base_property|apply_property_edit|create_keyframe|set_keyframe|update_keyframe|move_keyframe|remove_keyframe|apply_preset_phase|instantiate_phase_channels|set_phase|remove_phase|declare_control_field|remove_control_field|replace_control_field|save_text_style|apply_text_style|set_object_field|set_object_visible|set_object_locked|set_binding|replace_data_context|relink_material|delete_material)\s*\(/g;
const CONTROL_PLANE_CLIENTS = /\bgx-(?:control-plane|control-transport|playout)\b/;
const EDITOR_CRATES = /^(?:Editor\/shell|services\/editor|services\/editor-mcp|mocks\/mock-editor)\//;
const STORE_WRITE_ALLOWED = new Set([
  "services/editor/src/project.rs", "services/editor/src/design_system.rs",
  "services/editor/src/fidelity.rs", "services/editor/src/command.rs",
]);
const CFG_TEST = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/;
const TAURI_ATTRIBUTE = /#\s*\[\s*tauri::command\b/g;
const TAURI_FUNCTION = /#\s*\[\s*tauri::command\s*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/g;
const INVOKE = /(\bfunction\s+)?\binvoke\s*(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*\(/g;
const DOCUMENT_KEY = /[{,]\s*(?:\.\.\.\s*)?["']?(?:scene|document)["']?\s*(?=[:,}]|$)/;

const RUST_CHAR = /b?'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/y;
const RUST_RAW_STRING = /b?r(#*)"/y;
const REGEX_PRECEDER = /(?:[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)$/;

/**
 * Remove comments, keeping every offset: comments become spaces, so an index
 * into the result is an index into the source. With `blankStrings`, string
 * contents are blanked too (delimiters kept), so braces, commas and words
 * inside literals cannot steer structural matching.
 */
function scrub(text, language, { blankStrings = false } = {}) {
  const out = text.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (out[index] !== "\n" && out[index] !== "\r") out[index] = " ";
  };
  const drop = (end) => { blank(i, end); i = end; };
  /** A literal spanning `[i, end)` whose opening delimiter is `open` long and closes with `terminator`. */
  const literal = (end, open, terminator) => {
    const close = text.endsWith(terminator, end) && end - terminator.length >= i + open ? terminator.length : 0;
    if (blankStrings) blank(i + open, end - close);
    i = end;
  };
  const lineEnd = (from) => {
    const end = text.indexOf("\n", from);
    return end < 0 ? text.length : end;
  };
  const quoted = (from, quote, multiline) => {
    for (let index = from; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\\") index += 1;
      else if (character === quote) return index + 1;
      else if (!multiline && character === "\n") return index;
    }
    return text.length;
  };
  /** The last few significant characters before `i`, for telling a regex literal from division. */
  const preceding = () => {
    let index = i - 1;
    while (index >= 0 && /\s/.test(out[index])) index -= 1;
    return out.slice(Math.max(0, index - 5), index + 1).join("");
  };

  while (i < text.length) {
    const character = text[i];
    const next = text[i + 1];
    if (language === "toml") {
      if (character === "#") drop(lineEnd(i));
      else if (character === "\"" || character === "'") literal(quoted(i + 1, character, false), 1, character);
      else i += 1;
      continue;
    }
    if (character === "/" && next === "/") { drop(lineEnd(i)); continue; }
    if (character === "/" && next === "*") {
      let depth = 0;
      let index = i;
      while (index < text.length) {
        if (text.startsWith("/*", index)) { depth += 1; index += 2; }
        else if (text.startsWith("*/", index)) {
          index += 2;
          // Rust block comments nest; TypeScript ones end at the first `*/`.
          if (--depth === 0 || language !== "rust") break;
        } else index += 1;
      }
      drop(index);
      continue;
    }
    if (language === "rust") {
      const identifierBefore = i > 0 && /\w/.test(text[i - 1]);
      RUST_RAW_STRING.lastIndex = i;
      const raw = identifierBefore ? null : RUST_RAW_STRING.exec(text);
      if (raw) {
        const terminator = `"${raw[1]}`;
        const close = text.indexOf(terminator, i + raw[0].length);
        literal(close < 0 ? text.length : close + terminator.length, raw[0].length, terminator);
        continue;
      }
      if (character === "'" || (character === "b" && next === "'" && !identifierBefore)) {
        RUST_CHAR.lastIndex = i;
        const char = RUST_CHAR.exec(text);
        // Not a char literal: a lifetime such as `'_` or `'static`.
        if (char) literal(i + char[0].length, char[0].startsWith("b") ? 2 : 1, "'");
        else i += 1;
        continue;
      }
      if (character === "\"") { literal(quoted(i + 1, "\"", true), 1, "\""); continue; }
      i += 1;
      continue;
    }
    // TypeScript / JavaScript.
    if (character === "\"" || character === "'") { literal(quoted(i + 1, character, false), 1, character); continue; }
    if (character === "`") { literal(quoted(i + 1, "`", true), 1, "`"); continue; }
    if (character === "/" && (preceding() === "" || REGEX_PRECEDER.test(preceding()))) {
      let index = i + 1;
      let inClass = false;
      for (; index < text.length && text[index] !== "\n"; index += 1) {
        const c = text[index];
        if (c === "\\") index += 1;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) { index += 1; break; }
      }
      literal(index, 1, "/");
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Index of the bracket closing the one at `open`, in string-blanked code. */
function closing(code, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (pairs[character]) stack.push(pairs[character]);
    else if (character === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/** Top-level comma-separated spans of `code[from, to)`. */
function topLevelSpans(code, from, to) {
  const spans = [];
  let depth = 0;
  let start = from;
  for (let index = from; index < to; index += 1) {
    const character = code[index];
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      spans.push([start, index]);
      start = index + 1;
    }
  }
  if (code.slice(start, to).trim()) spans.push([start, to]);
  return spans;
}

/** A Rust source with comments removed (`text`) and strings also blanked (`code`), cut at `#[cfg(test)]`. */
function rustSource(raw) {
  let text = scrub(raw, "rust");
  let code = scrub(raw, "rust", { blankStrings: true });
  const test = code.search(CFG_TEST);
  if (test >= 0) {
    text = text.slice(0, test);
    code = code.slice(0, test);
  }
  return { text, code };
}

function normalize(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** `path:line` for an offset into a file (scrubbed text keeps source offsets). */
function at(path, text, index) {
  let line = 1;
  for (let offset = text.indexOf("\n"); offset >= 0 && offset < index; offset = text.indexOf("\n", offset + 1)) line += 1;
  return `${path}:${line}`;
}

function checkProductBoundaries(path, text, add) {
  if (path.startsWith("Shared/") && path.endsWith("Cargo.toml")) {
    for (const crate of ["gx-engine-host", "gx-render-worker"]) {
      if (new RegExp(`^\\s*${crate}\\s*=`, "m").test(text)) add(path, `Shared depends on product crate ${crate} (invariant 1)`);
    }
  }
  if (path.startsWith("Shared/") && /\.(?:ts|tsx|rs)$/.test(path)
    && (/from\s+["'][^"']*(?:Editor|Playout)\//.test(text) || /\buse\s+(?:gx_engine_host|gx_render_worker)\b/.test(text))) {
    add(path, "Shared imports from a product (invariant 1)");
  }
  if (/^(?:Editor|Playout)\//.test(path) && /\.(?:ts|tsx)$/.test(path)) {
    const domain = path.split("/")[0];
    const other = domain === "Editor" ? "Playout" : "Editor";
    if (new RegExp(`from\\s+["'][^"']*${other}/`).test(text)) add(path, `${domain} imports ${other} (invariant 1)`);
    if (/from\s+["'][^"']*(?:render-engine\/|gx-render-worker)/.test(text)) add(path, `${domain} imports renderer internals (invariant 3)`);
  }
  if (path.startsWith("Shared/generated-ts/src/") && path.endsWith(".ts")
    && !/generated by|GENERATED by/i.test(text.slice(0, 200))) {
    add(path, "hand-authored file in generated output (invariant 23)");
  }
}

function checkTauriSurface(path, { code }, add, shell) {
  const attributes = [...code.matchAll(TAURI_ATTRIBUTE)].length;
  const functions = [...code.matchAll(TAURI_FUNCTION)];
  if (functions.length !== attributes) {
    add(path, `unparsed tauri command: ${attributes} #[tauri::command] attribute(s) but ${functions.length} parsed fn(s) (R1)`);
  }
  for (const match of functions) {
    const name = match[1];
    shell.functions.add(name);
    const open = match.index + match[0].length - 1;
    const close = closing(code, open);
    const params = close < 0 ? code.slice(open + 1) : code.slice(open + 1, close);
    if (!SHELL_SURFACE.has(name)) add(at(path, code, match.index), `Tauri command ${name} is not in SHELL_SURFACE (R1)`);
    if (READ_SURFACE.has(name) && DOCUMENT_TYPES.test(params)) {
      add(at(path, code, match.index), `read command ${name} accepts an authoring document/command parameter (R1)`);
    }
    if (name === "cmd_execute") {
      const bodyOpen = close < 0 ? -1 : code.indexOf("{", close);
      const bodyClose = bodyOpen < 0 ? -1 : closing(code, bodyOpen);
      const body = bodyClose < 0 ? "" : code.slice(bodyOpen + 1, bodyClose);
      if (!/:\s*(?:serde_json::)?Value\b/.test(params) || !/\bparse_command\s*\(/.test(body)) {
        add(at(path, code, match.index), "cmd_execute must take serde_json::Value and call parse_command( (R1)");
      }
    }
  }
  for (const handler of code.matchAll(/\bgenerate_handler!\s*\[/g)) {
    const open = handler.index + handler[0].length - 1;
    const close = closing(code, open);
    shell.handlerSeen = true;
    for (const [start, end] of topLevelSpans(code, open + 1, close < 0 ? code.length : close)) {
      shell.handlers.add(code.slice(start, end).trim().split("::").pop().trim());
    }
  }
}

function checkInvokes(path, raw, add) {
  const text = scrub(raw, "ts");
  const code = scrub(raw, "ts", { blankStrings: true });
  for (const match of code.matchAll(INVOKE)) {
    if (match[1]) continue; // `function invoke(...)`: a declaration, not a call.
    const open = match.index + match[0].length - 1;
    const close = closing(code, open);
    const args = topLevelSpans(code, open + 1, close < 0 ? code.length : close);
    const [first, second] = args.map(([start, end]) => text.slice(start, end).trim());
    if (first === undefined) {
      add(at(path, code, match.index), "invoke first argument must be a literal command name (R4)");
      continue;
    }
    // `invoke<T>(command: string, …)` in an interface or class is a signature.
    if (/^[A-Za-z_$][\w$]*\??\s*:/.test(first)) continue;
    const name = first.match(/^(["'`])([^"'`\\$]*)\1$/);
    if (!name) add(at(path, code, match.index), `invoke first argument must be a literal command name, got \`${first.replace(/\s+/g, " ")}\` (R4)`);
    else if (!SHELL_SURFACE.has(name[2])) add(at(path, code, match.index), `invoke command ${name[2]} is not in SHELL_SURFACE (R4)`);
    if (second?.startsWith("{") && DOCUMENT_KEY.test(second)) {
      add(at(path, code, match.index), "invoke arguments may not carry scene/document data (R4)");
    }
  }
}

/** Check an explicit file set. Paths are repository-relative; `\` is accepted. */
export function check(files) {
  const violations = [];
  const add = (path, message) => violations.push(`${path}: ${message}`);
  const shell = { functions: new Set(), handlers: new Set(), handlerSeen: false };

  for (const file of files) {
    const path = normalize(file.path);
    const raw = file.text;
    checkProductBoundaries(path, raw, add);
    if (path.includes("/tests/") || path.startsWith("tests/")) continue;

    const editorSide = EDITOR_CRATES.test(path);
    if (path.endsWith(".rs")) {
      const source = rustSource(raw);
      if (editorSide) {
        const write = STORE_WRITE_ALLOWED.has(path) ? null : STORE_WRITES.exec(source.code);
        if (write) add(at(path, source.code, write.index), `store write ${write[0].trim()} outside the Editor store chokepoints (R2)`);
        for (const match of source.code.matchAll(CONTRACT_MUTATORS)) {
          add(at(path, source.code, match.index), `contract mutator ${match[0].replace(/\s*\($/, "")} outside apply_edits (R3)`);
        }
      }
      if (path.startsWith("Editor/shell/src/")) checkTauriSurface(path, source, add, shell);
      if (path.startsWith("services/editor-mcp/src/")) {
        for (const match of source.code.matchAll(/\bstruct\s+(\w+)[^{;(]*([{(])/g)) {
          const open = match.index + match[0].length - 1;
          const close = closing(source.code, open);
          if (/\bSceneDocument\b/.test(source.code.slice(open, close < 0 ? undefined : close))) {
            add(at(path, source.code, match.index), `MCP struct ${match[1]} carries a SceneDocument (R5)`);
          }
        }
      }
      const listener = path === "Shared/control-plane/src/bind.rs" ? null : /(?:bind|listen|TcpListener)[^;\n]*\b4100\b/.exec(source.text);
      if (listener) {
        add(at(path, source.text, listener.index), "port 4100 bound outside the control plane: project-api must accept only EditorCommand (R8)");
      }
    }
    const manifest = editorSide && basename(path) === "Cargo.toml" ? CONTROL_PLANE_CLIENTS.exec(scrub(raw, "toml")) : null;
    if (manifest) {
      add(at(path, raw, manifest.index), `Editor-side crate depends on control-plane client ${manifest[0]} (R6, invariant 4)`);
    }
    if (/^Editor\/(?:web|src)\/.*\.tsx?$/.test(path)) checkInvokes(path, raw, add);
    if (path.startsWith("Shared/generated-ts/schemas/")) {
      if (!path.endsWith(".schema.json")) add(path, "schema output must end in .schema.json (R7)");
      if (!/"\$comment"\s*:\s*"GENERATED by/.test(raw.slice(0, 200))) {
        add(path, "schema is missing its generated $comment header in the first 200 characters (R7)");
      }
    }
  }

  if (shell.functions.size > 0 && !shell.handlerSeen) add("Editor/shell/src", "missing generate_handler! command set (R1)");
  if (shell.handlerSeen) {
    for (const name of shell.handlers) {
      if (!shell.functions.has(name)) add("Editor/shell/src", `generate_handler! lists ${name}, which is not a parsed #[tauri::command] fn (R1)`);
    }
    for (const name of shell.functions) {
      if (!shell.handlers.has(name)) add("Editor/shell/src", `#[tauri::command] fn ${name} is missing from generate_handler! (R1)`);
    }
  }
  return violations;
}

/** Every repository file a rule inspects, as `{path, text}` with `/` separators. */
export function repositoryFiles(root = ROOT) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRECTORIES.includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      const path = relative(root, full).split(sep).join("/");
      if (/\.(?:rs|ts|tsx)$/.test(entry) || entry === "Cargo.toml" || path.startsWith("Shared/generated-ts/schemas/")) {
        out.push({ path, text: readFileSync(full, "utf8") });
      }
    }
  };
  visit(root);
  return out;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const violations = check(repositoryFiles());
  if (violations.length > 0) {
    console.error("check:boundaries FAILED\n");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(`\n${violations.length} violation(s). See docs/invariants.md.`);
    process.exit(1);
  }
  console.log("check:boundaries OK");
}
