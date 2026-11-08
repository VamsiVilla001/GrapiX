import assert from "node:assert/strict";
import test from "node:test";
import { check, repositoryFiles } from "../check-boundaries.mjs";

function violations(path, text) {
  return check([{ path, text }]);
}

// One synthetic file per rule (spec 11.36 §4.6), each asserting its violation.
const cases = [
  ["a new Tauri mutation is refused", "Editor/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_object_hide(scene: SceneDocument) {}\n\ntauri::generate_handler![cmd_object_hide];",
    /Tauri command cmd_object_hide is not in SHELL_SURFACE \(R1\)/],
  ["a read command cannot gain a TakePage parameter", "Editor/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_scene_read(state: State<'_, App>, page: TakePage) {}\n\ntauri::generate_handler![cmd_scene_read];",
    /read command cmd_scene_read accepts an authoring document/],
  ["a multi-line Tauri fn the guard cannot parse is refused", "Editor/shell/src/lib.rs",
    "#[tauri::command]\npub(crate) async fn cmd_scene_read<R: Runtime>(\n    app: AppHandle<R>,\n    page: TakePage,\n) {}",
    /unparsed tauri command: 1 #\[tauri::command\] attribute\(s\) but 0 parsed fn\(s\)/],
  ["a store write in the shell is refused", "Editor/shell/src/lib.rs",
    "fn change(store: &Projects) { store.write_scene(project, &scene); }",
    /store write \.write_scene\( outside the Editor store chokepoints \(R2\)/],
  ["a filesystem write in the shell is refused", "Editor/shell/src/lib.rs",
    "fn save(path: &Path, bytes: &[u8]) { std::fs::write(path, bytes).unwrap(); }",
    /store write fs::write\( outside the Editor store chokepoints \(R2\)/],
  ["a contract mutator in editor-mcp is refused", "services/editor-mcp/src/lib.rs",
    "fn change(scene: &mut SceneDocument) { gx_contracts::authoring::create_object(scene, \"rect\"); }",
    /contract mutator create_object outside apply_edits \(R3\)/],
  ["an unknown TS invoke is refused", "Editor/src/inspector.ts",
    "await invoke<SceneDocument>(\"cmd_object_hide\", { objectId });",
    /invoke command cmd_object_hide is not in SHELL_SURFACE \(R4\)/],
  ["a non-literal TS invoke is refused", "Editor/web/main.ts",
    "const name = \"cmd_execute\";\nawait tauri.core.invoke(name, { command });",
    /invoke first argument must be a literal command name, got `name` \(R4\)/],
  ["a scene document cannot cross TS invoke", "Editor/web/main.ts",
    "await invoke(\"cmd_execute\", { scene });",
    /invoke arguments may not carry scene\/document data \(R4\)/],
  ["a headerless schema is refused", "Shared/generated-ts/schemas/commands/CreateScene.schema.json",
    "{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"title\": \"CreateScene\"\n}\n",
    /schema is missing its generated \$comment header in the first 200 characters \(R7\)/],
  ["a control-plane client in an Editor-side manifest is refused", "mocks/mock-editor/Cargo.toml",
    "[package]\nname = \"gx-mock-editor\"\n\n[dependencies]\ngx-control-plane = { workspace = true }\n",
    /Editor-side crate depends on control-plane client gx-control-plane \(R6/],
  ["a port 4100 listener outside the control plane is refused", "services/editor/src/api.rs",
    "fn serve() { let listener = TcpListener::bind(\"127.0.0.1:4100\").unwrap(); }",
    /project-api must accept only EditorCommand \(R8\)/],
  ["a consumer matching on a Locality variant is refused", "services/playout/src/lib.rs",
    "fn route(cap: &EngineCapability) -> u8 { match cap.locality { Locality::Lan => 1, _ => 0 } }",
    /branches on a Locality variant.*\(R9, 5\.5\)/],
  ["the asset plane's handoff negotiation may match on Locality (5.8)", "Shared/asset-plane/src/handoff.rs",
    "pub fn handoff_for(locality: Locality) -> AssetHandoff { match locality { Locality::CoLocated => AssetHandoff::LocalPath, Locality::Lan => AssetHandoff::ChunkedUpload } }",
    /^$/],
  ["declaring a Locality value is not a branch", "Shared/control-transport/src/client.rs",
    "fn placeholder() -> EngineCapability { EngineCapability { locality: Locality::CoLocated, ..base() } }",
    /^$/],
  ["a TypeScript consumer comparing locality is refused", "Editor/src/preview.ts",
    "export const remote = (cap: { locality: string }) => cap.locality === \"Lan\";",
    /branches on the engine's locality \(R9, 5\.5\)/],
];

for (const [name, path, text, expected] of cases) {
  test(name, () => assert.match(violations(path, text).join("\n"), expected));
}

test("commented-out code, cfg(test) code and tests/ paths trigger no rule", () => {
  const rust = [
    "// create_object(scene);",
    "/* std::fs::write(path, bytes); /* nested */ store.write_scene(p, &s); */",
    "fn lifetimes<'a>(value: &'a str) -> &'static str { let brace = '{'; \"}\" }",
    "#[cfg(test)]",
    "mod tests { fn t() { create_object(scene); std::fs::write(p, b); } }",
  ].join("\n");
  assert.deepEqual(violations("services/editor-mcp/src/lib.rs", rust), []);
  assert.deepEqual(violations("services/editor-mcp/tests/surface.rs", "fn t() { create_object(scene); }"), []);
  assert.deepEqual(violations("Editor/web/main.ts", "// invoke(name, { scene });\n/* invoke(\"cmd_object_hide\") */\nconst url = \"http://x\"; // invoke(name)"), []);
  assert.deepEqual(violations("mocks/mock-editor/Cargo.toml", "[dependencies]\n# gx-control-plane = { workspace = true }\n"), []);
});

test("the allowed surface passes", () => {
  const shell = [
    "#[tauri::command]",
    "fn cmd_execute(",
    "    state: tauri::State<'_, ShellState>,",
    "    command: serde_json::Value,",
    ") -> Result<CommandOutcome, EditorError> {",
    "    let command = parse_command(command)?;",
    "    state.execute(command)",
    "}",
    "#[tauri::command]",
    "fn cmd_object_kinds() -> Vec<&'static str> { vec![] }",
    "tauri::generate_handler![cmd_execute, cmd_object_kinds]",
  ].join("\n");
  assert.deepEqual(violations("Editor/shell/src/lib.rs", shell), []);
  const ts = "declare const invoke: <T>(command: string) => Promise<T>;\n"
    + "await invoke<readonly [string, ControlField[\"kind\"]][]>(\"cmd_control_properties\", { kind });\n"
    + "await tauri.core.invoke<CommandOutcome>(\"cmd_execute\", { command: { command: \"saveScene\", sceneId } });";
  assert.deepEqual(violations("Editor/src/command-client.ts", ts), []);
});

test("the real tree has zero boundary violations", () => {
  assert.deepEqual(check(repositoryFiles()), []);
});
