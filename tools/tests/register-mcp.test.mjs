import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEntries, codexBlock, mergeCodex, mergeServers, removeServers, FIGMA, GRAPIX } from "../register-mcp.mjs";

const abs = process.platform === "win32" ? "C:\\gx\\gx-editor-mcp.exe" : "/gx/gx-editor-mcp";
const root = process.platform === "win32" ? "C:\\gx\\store" : "/gx/store";
const entries = buildEntries({ binary: abs, root });

test("the entries are the stdio Editor MCP and the local Figma server, with no secret", () => {
  assert.deepEqual(entries[GRAPIX], { command: abs, args: ["--root", root] });
  assert.deepEqual(entries[FIGMA], { type: "http", url: "http://127.0.0.1:3845/mcp" });
  assert.doesNotMatch(JSON.stringify(entries), /token|secret|authorization/i);
});

test("a relative path is refused: an agent starts from any folder", () => {
  assert.throws(() => buildEntries({ binary: "gx-editor-mcp", root }), /absolute/);
  assert.throws(() => buildEntries({ binary: abs, root: "store" }), /absolute/);
});

test("only a local Figma address is accepted", () => {
  assert.throws(() => buildEntries({ binary: abs, root, figmaUrl: "https://mcp.figma.com/mcp" }), /local/);
  assert.throws(() => buildEntries({ binary: abs, root, figmaUrl: "http://10.0.0.5:3845/mcp" }), /local/);
  assert.equal(buildEntries({ binary: abs, root, figmaUrl: "http://localhost:3845/mcp" })[FIGMA].url, "http://localhost:3845/mcp");
});

test("merging adds both and keeps every other server and key", () => {
  const before = { other: 1, mcpServers: { keep: { command: "x" } } };
  const { config, outcome } = mergeServers(before, entries);
  assert.deepEqual(outcome, { [GRAPIX]: "added", [FIGMA]: "added" });
  assert.equal(config.other, 1);
  assert.deepEqual(config.mcpServers.keep, { command: "x" });
  assert.deepEqual(before, { other: 1, mcpServers: { keep: { command: "x" } } }, "the input is not changed");
});

test("merging twice changes nothing", () => {
  const once = mergeServers({}, entries).config;
  const again = mergeServers(once, entries);
  assert.deepEqual(again.outcome, { [GRAPIX]: "unchanged", [FIGMA]: "unchanged" });
  assert.deepEqual(again.config, once);
});

test("a differing entry is a conflict and is left alone unless forced", () => {
  const mine = { mcpServers: { [GRAPIX]: { command: "other" } } };
  const kept = mergeServers(mine, entries);
  assert.equal(kept.outcome[GRAPIX], "conflict");
  assert.deepEqual(kept.config.mcpServers[GRAPIX], { command: "other" });
  const forced = mergeServers(mine, entries, { force: true });
  assert.equal(forced.outcome[GRAPIX], "replaced");
  assert.deepEqual(forced.config.mcpServers[GRAPIX], entries[GRAPIX]);
});

test("a config that is not an object is refused", () => {
  assert.throws(() => mergeServers([], entries), /JSON object/);
  assert.throws(() => mergeServers({ mcpServers: [] }, entries), /mcpServers/);
});

test("removing takes out the two and nothing else", () => {
  const full = mergeServers({ mcpServers: { keep: { command: "x" } } }, entries).config;
  const { config, outcome } = removeServers(full);
  assert.deepEqual(outcome, { [GRAPIX]: "removed", [FIGMA]: "removed" });
  assert.deepEqual(Object.keys(config.mcpServers), ["keep"]);
  assert.deepEqual(removeServers(config).outcome, { [GRAPIX]: "absent", [FIGMA]: "absent" });
});

test("the Codex table uses literal strings, so a Windows path needs no escaping", () => {
  const block = codexBlock({ command: String.raw`C:\gx\gx-editor-mcp.exe`, args: ["--root", String.raw`D:\store`] });
  assert.equal(
    block,
    ["[mcp_servers.grapix]", String.raw`command = 'C:\gx\gx-editor-mcp.exe'`, String.raw`args = ['--root', 'D:\store']`, ""].join("\n"),
  );
  assert.throws(() => codexBlock({ command: "it's", args: [] }), /literal/);
});

test("Codex merge appends once, keeps the rest, and never rewrites a different entry", () => {
  const entry = entries[GRAPIX];
  const before = '[mcp_servers.other]\ncommand = "x"\n';
  const once = mergeCodex(before, entry);
  assert.equal(once.outcome, "added");
  assert.ok(once.text.startsWith(before), "the existing text is untouched");
  assert.equal(mergeCodex(once.text, entry).outcome, "unchanged");
  assert.equal(mergeCodex(once.text, entry).text, once.text);
  const different = '[mcp_servers.grapix]\ncommand = "else"\n';
  const other = mergeCodex(different, entry);
  assert.equal(other.outcome, "conflict");
  assert.equal(other.text, different);
  assert.equal(mergeCodex("", entry).text, codexBlock(entry));
});
