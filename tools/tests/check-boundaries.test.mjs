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
  ["the bridge's exemption is that one file only", "Editor/src/command-client.ts",
    "const name = \"cmd_execute\";\nawait tauri.core.invoke(name, { command });",
    /invoke first argument must be a literal command name, got `name` \(R4\)/],
  ["a log command that takes a document is refused", "Editor/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_log(scene: SceneDocument) {}\n\ntauri::generate_handler![cmd_log];",
    /read command cmd_log accepts an authoring document/],
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
  ["a socket bound outside the listed bind sites is refused", "services/playout/src/net.rs",
    "fn listen() { let l = std::net::TcpListener::bind(\"127.0.0.1:0\").unwrap(); }",
    /a socket is bound outside the listed bind sites.*\(R10, 2\.21\)/],
  ["a tokio listener outside the listed bind sites is refused", "services/playout-mcp/src/net.rs",
    "async fn listen() { let l = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap(); }",
    /a socket is bound outside the listed bind sites.*\(R10, 2\.21\)/],
  ["a listed bind site that never asks the policy is refused", "Shared/asset-plane/src/publish.rs",
    "pub fn bind(addr: SocketAddr) -> io::Result<Server> { Ok(Server { listener: TcpListener::bind(addr)? }) }",
    /a listed bind site binds a socket without asking gx_contracts::endpoints::check_listen \(R10, 2\.21\)/],
  ["a listed bind site that asks the policy is allowed", "services/mcp-server/src/wire.rs",
    "fn serve(addr: SocketAddr) -> io::Result<()> { check_http_listen(addr)?; let l = TcpListener::bind(addr)?; Ok(()) }",
    /^$/],
  ["the conformance harness may bind scratch sockets", "conformance/src/scene_plane.rs",
    "fn scratch() { let l = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok(); }",
    /^$/],
  ["the engine's control endpoint written out is refused", "Playout/shell/src/lib.rs",
    "pub const DEFAULT_CONTROL_ENDPOINT: &str = \"127.0.0.1:4400\";",
    /the engine's host:port 127\.0\.0\.1:4400 is written out.*\(R11, 2\.21\)/],
  ["the engine's asset endpoint written out is refused", "services/editor/src/publish.rs",
    "const ENDPOINT: &str = \"localhost:4401\";",
    /the engine's host:port localhost:4401 is written out.*\(R11, 2\.21\)/],
  ["the endpoints module is where the engine's endpoint is written", "Shared/contracts/src/endpoints.rs",
    "pub const DEFAULT_CONTROL_ENDPOINT: &str = \"127.0.0.1:4400\";",
    /^$/],
  ["a front end writing the engine's endpoint out is refused", "Playout/web/src/connect.ts",
    "export const ENGINE = \"127.0.0.1:4400\";",
    /the engine's host:port 127\.0\.0\.1:4400 is written out.*\(R11, 2\.21\)/],
  ["a consumer matching on a Locality variant is refused", "services/playout/src/lib.rs",
    "fn route(cap: &EngineCapability) -> u8 { match cap.locality { Locality::Lan => 1, _ => 0 } }",
    /branches on a Locality variant.*\(R9, 5\.5\)/],
  ["the Editor's publish may not choose a route by Locality (5.10)", "services/editor/src/publish.rs",
    "fn route(engine: SocketAddr) -> u8 { match declared(engine) { Locality::Lan => 1, _ => 0 } }",
    /branches on a Locality variant.*\(R9, 5\.5\)/],
  ["the Editor shell may not hold a control-plane client (5.10)", "Editor/shell/Cargo.toml",
    "[package]\nname = \"gx-editor-shell\"\n\n[dependencies]\ngx-control-transport = { workspace = true }\n",
    /Editor-side crate depends on control-plane client gx-control-transport \(R6/],
  ["the asset plane's handoff negotiation may match on Locality (5.8)", "Shared/asset-plane/src/handoff.rs",
    "pub fn handoff_for(locality: Locality) -> AssetHandoff { match locality { Locality::CoLocated => AssetHandoff::LocalPath, Locality::Lan => AssetHandoff::ChunkedUpload } }",
    /^$/],
  ["declaring a Locality value is not a branch", "Shared/control-transport/src/client.rs",
    "fn placeholder() -> EngineCapability { EngineCapability { locality: Locality::CoLocated, ..base() } }",
    /^$/],
  ["a TypeScript consumer comparing locality is refused", "Editor/src/preview.ts",
    "export const remote = (cap: { locality: string }) => cap.locality === \"Lan\";",
    /branches on the engine's locality \(R9, 5\.5\)/],
  // ---- 2.26: Playout is held to what the Editor is held to.
  ["a Playout shell command outside its surface is refused", "Playout/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_edit_scene(state: State<'_, Connection>) {}\n\ntauri::generate_handler![cmd_edit_scene];",
    /Tauri command cmd_edit_scene is not in PLAYOUT_SHELL_SURFACE \(R1\)/],
  ["an Editor command is not a Playout command", "Playout/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_execute(command: serde_json::Value) {}\n\ntauri::generate_handler![cmd_execute];",
    /Tauri command cmd_execute is not in PLAYOUT_SHELL_SURFACE \(R1\)/],
  ["a Playout command cannot take an authoring document", "Playout/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_take(state: State<'_, Connection>, scene: SceneDocument) {}\n\ntauri::generate_handler![cmd_take];",
    /read command cmd_take accepts an authoring document\/command parameter \(R1\)/],
  ["a Playout command missing from its handler list is refused", "Playout/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_status() {}\n#[tauri::command]\nfn cmd_take() {}\n\ntauri::generate_handler![cmd_status];",
    /Playout\/shell\/src: #\[tauri::command\] fn cmd_take is missing from generate_handler! \(R1\)/],
  ["a Playout handler that is not a command is refused", "Playout/shell/src/lib.rs",
    "#[tauri::command]\nfn cmd_status() {}\n\ntauri::generate_handler![cmd_status, cmd_cue];",
    /Playout\/shell\/src: generate_handler! lists cmd_cue, which is not a parsed #\[tauri::command\] fn \(R1\)/],
  ["a Playout page invoking a command it does not have is refused", "Playout/web/main.js",
    "await invoke(\"cmd_object_hide\", { objectId });",
    /invoke command cmd_object_hide is not in PLAYOUT_SHELL_SURFACE \(R4\)/],
  ["a Playout page cannot invoke an Editor command", "Playout/web/main.js",
    "await invoke(\"cmd_execute\", { command });",
    /invoke command cmd_execute is not in PLAYOUT_SHELL_SURFACE \(R4\)/],
  ["a Playout page invoking by a non-literal name is refused", "Playout/web/main.js",
    "async function send(command) { return invoke(command, {}); }",
    /invoke first argument must be a literal command name, got `command` \(R4\)/],
  ["a Playout page carrying a document is refused", "Playout/web/main.js",
    "await invoke(\"cmd_take\", { scene });",
    /invoke arguments may not carry scene\/document data \(R4\)/],
  ["the wrapper's exemption does not reach a call outside its body", "Playout/web/main.js",
    "function invoke(command, args) { return bridge.invoke(command, args); }\nasync function other(command) { return bridge.invoke(command, {}); }",
    /invoke first argument must be a literal command name, got `command` \(R4\)/],
  ["only the listed file may declare the wrapper", "Playout/web/other.js",
    "function invoke(command, args) { return bridge.invoke(command, args); }",
    /invoke first argument must be a literal command name, got `command` \(R4\)/],
  ["a front end in JavaScript writing the engine's endpoint out is refused", "Playout/web/connect.js",
    "export const ENGINE = \"127.0.0.1:4400\";",
    /the engine's host:port 127\.0\.0\.1:4400 is written out.*\(R11, 2\.21\)/],
  ["a module script in tools writing the engine's endpoint out is refused", "tools/launch-extra.mjs",
    "const ENGINE = 'localhost:4401';",
    /the engine's host:port localhost:4401 is written out.*\(R11, 2\.21\)/],
  ["a JavaScript consumer comparing locality is refused", "Playout/web/route.js",
    "export const remote = (cap) => cap.locality === \"Lan\";",
    /branches on the engine's locality \(R9, 5\.5\)/],
  ["a TcpSocket listener outside the bind sites is refused", "services/playout/src/net.rs",
    "fn listen() { let socket = tokio::net::TcpSocket::new_v4().unwrap(); socket.bind(a).unwrap(); let l = socket.listen(8).unwrap(); }",
    /a socket is bound outside the listed bind sites.*\(R10, 2\.21\)/],
  ["a socket crate outside the bind sites is refused", "services/playout/src/net.rs",
    "fn listen() { let s = socket2::Socket::new(Domain::IPV4, Type::STREAM, None).unwrap(); }",
    /a socket is bound outside the listed bind sites.*\(R10, 2\.21\)/],
  ["a Unix listener outside the bind sites is refused", "services/playout/src/net.rs",
    "fn listen(p: &Path) { let l = std::os::unix::net::UnixListener::bind(p).unwrap(); }",
    /a socket is bound outside the listed bind sites.*\(R10, 2\.21\)/],
  ["a named-pipe server outside the bind sites is refused", "services/playout/src/net.rs",
    "fn listen(name: &str) { let server = ServerOptions::new().first_pipe_instance(true).create(name).unwrap(); }",
    /a socket is bound outside the listed bind sites.*\(R10, 2\.21\)/],
  ["a raw Windows named pipe outside the bind sites is refused", "Playout/shell/src/pipe.rs",
    "fn listen() { let h = unsafe { CreateNamedPipeW(name, mode, 0, 255, 0, 0, 0, null()) }; }",
    /a socket is bound outside the listed bind sites.*\(R10, 2\.21\)/],
  ["a listed bind site that opens a Unix listener without the policy is refused", "Shared/control-plane/src/bind.rs",
    "fn bind_local(p: &Path) -> io::Result<UnixListener> { UnixListener::bind(p) }",
    /a listed bind site binds a socket without asking gx_contracts::endpoints::check_listen \(R10, 2\.21\)/],
  ["a listed bind site that opens a Unix listener after asking the policy is allowed", "Shared/control-plane/src/bind.rs",
    "fn bind_local(p: &Path) -> io::Result<UnixListener> { check_local_listen(p)?; UnixListener::bind(p) }",
    /^$/],
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

test("the log command and the one bridge file are allowed", () => {
  const shell = [
    "#[tauri::command]",
    "fn cmd_log(entry: gx_telemetry::ui::UiEntry) -> Result<(), String> { Ok(()) }",
    "tauri::generate_handler![cmd_log]",
  ].join("\n");
  assert.deepEqual(violations("Editor/shell/src/lib.rs", shell), []);
  assert.deepEqual(violations("Playout/shell/src/lib.rs", shell), []);
  // The bridge calls the shell with the name it was handed; nowhere else may.
  const bridge = "export function call(core, command, args) { return core.invoke(command, args, { headers }); }";
  assert.deepEqual(violations("Editor/src/shell-bridge.ts", bridge), []);
  assert.deepEqual(
    violations("Editor/web/main.ts", "await shell().invoke<void>(\"cmd_log\", { entry });"),
    [],
  );
});

test("2.26: Playout's allowed surface, the wrapper, comments and test paths trigger no rule", () => {
  const shell = [
    "#[tauri::command]",
    "fn cmd_sign_in(state: tauri::State<'_, Connection>, name: String) -> Result<OperatorSession, PlayoutError> { sign_in(&state, &name) }",
    "#[tauri::command]",
    "fn cmd_take(state: tauri::State<'_, Connection>, take_id: String, revision: u64, content_hash: Option<String>, frame: Option<u64>) {}",
    "tauri::generate_handler![cmd_sign_in, cmd_take]",
  ].join("\n");
  assert.deepEqual(violations("Playout/shell/src/lib.rs", shell), []);
  const page = [
    "function invoke(command, args) { return bridge.invoke(command, args); }",
    "async function doTake() { await invoke(\"cmd_take\", { takeId }); }",
    "// invoke(name, { scene }); the engine is at 127.0.0.1:4400",
  ].join("\n");
  assert.deepEqual(violations("Playout/web/main.js", page), []);
  assert.deepEqual(violations("Playout/web/shell-bridge.js", "export function call(core, command) { return core.invoke(command, {}); }"), []);
  assert.deepEqual(violations("tools/tests/launch.test.mjs", "const ENGINE = '127.0.0.1:4400';"), []);
  assert.deepEqual(violations("services/playout/src/net.rs", "// TcpSocket::new_v4()\nfn f() { let s = \"UnixListener\"; }"), []);
  assert.deepEqual(violations("conformance/src/scene_plane.rs", "fn scratch() { let s = tokio::net::TcpSocket::new_v4(); }"), []);
});

test("2.26: the walk reads the scripts the rules now cover", () => {
  const paths = repositoryFiles().map((file) => file.path);
  for (const expected of ["Playout/web/main.js", "Playout/web/shell-bridge.js", "tools/engine-ports.mjs", "Playout/shell/src/lib.rs"]) {
    assert.ok(paths.includes(expected), `${expected} is not read`);
  }
  assert.ok(!paths.some((path) => path.startsWith("agent/") || path.includes("node_modules/")));
});

test("the real tree has zero boundary violations", () => {
  assert.deepEqual(check(repositoryFiles()), []);
});
