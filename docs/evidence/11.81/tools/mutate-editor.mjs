// Mutation check of the Settings window modules (claude-grapix-f1, 25 Nov 2026). Mutates my own NEW files in place (nobody else edits them),
// keeps a backup of each in the scratchpad, restores in a finally block, and verifies the restore byte for byte at the end.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const editor = path.join(repo, "Editor");
const backups = path.resolve("mut-backup");
fs.mkdirSync(backups, { recursive: true });
const files = {
  shortcuts: path.join(editor, "src/settings-shortcuts.ts"),
  pages: path.join(editor, "src/settings-pages.ts"),
  view: path.join(editor, "src/settings-window-view.ts"),
};
const original = {};
for (const [key, file] of Object.entries(files)) {
  original[key] = fs.readFileSync(file, "utf8");
  fs.writeFileSync(path.join(backups, `${key}.orig`), original[key]);
}

const mutants = [
  ["shortcuts", "Space is no longer named", '{ " ": "Space" }', '{ " ": " " }'],
  ["shortcuts", "Ctrl is not written", 'chord.ctrl ? "Ctrl" : ""', '""'],
  ["shortcuts", "Shift is not written", 'chord.shift ? "Shift" : ""', '""'],
  ["shortcuts", "a key shared by two commands is not a clash until three", ".filter(([, commands]) => commands.length > 1)", ".filter(([, commands]) => commands.length > 2)"],
  ["shortcuts", "one command on a key twice is a clash", "if (!list.includes(command)) list.push(command);", "list.push(command);"],
  ["shortcuts", "a command lists the same key twice", "if (!entry.keys.includes(key)) entry.keys.push(key);", "entry.keys.push(key);"],
  ["shortcuts", "a command is its own clash", "if (other !== command) entry.others.add(other);", "entry.others.add(other);"],
  ["shortcuts", "an unlabelled command is shown with no name", "labelOf(command) ?? command", 'labelOf(command) ?? ""'],
  ["shortcuts", "a bare key is read as a typed chord", "&& words.some((word) => MODIFIERS.has(word)) &&", "&&"],
  ["shortcuts", "a modifier alone is read as a typed chord", "&& words.some((word) => !MODIFIERS.has(word));", ";"],
  ["shortcuts", "a typed chord is order-sensitive", '[...new Set(words)].sort().join(" ")', '[...new Set(words)].join(" ")'],
  ["shortcuts", "a key is compared with its words in file order", 'key.toLowerCase().split(" ").sort().join(" ") === wanted', 'key.toLowerCase() === wanted'],
  ["shortcuts", "a search needs only one word", "words.every((word) => haystack.includes(word))", "words.some((word) => haystack.includes(word))"],
  ["shortcuts", "a search ignores the command id", "${row.label} ${row.command} ${row.keys.join", "${row.label} ${row.keys.join"],
  ["shortcuts", "the key count is wrong", "sum + row.keys.length", "sum + 1"],
  ["shortcuts", "a search shows the full count", "shown === rows.length ?", "true ?"],
  ["shortcuts", "a clash is not said under the table", "clashing.length === 0\n    ?", "true\n    ?"],
  ["pages", "the AI page is called built", '    label: "AI and MCP access",\n    live: false,', '    label: "AI and MCP access",\n    live: true,'],
  ["pages", "the AI page names no row", 'rows: ["8.14"],', "rows: [],"],
  ["pages", "an unknown page shows Shortcuts", "SETTINGS_PAGES[0]!", "SETTINGS_PAGES[1]!"],
  ["pages", "a built page has a waiting line", 'if (page.live) return "";', ""],
  ["view", "the selected tab is reported unselected", 'tab.setAttribute("aria-selected", String(selected));', 'tab.setAttribute("aria-selected", String(!selected));'],
  ["view", "every panel is shown at once", "panel.hidden = pageId !== current;", "panel.hidden = false;"],
  ["view", "the arrow keys do not wrap", "order[(at + 1) % order.length]", "order[at + 1]"],
  ["view", "the page is not told which page is shown", "options.onShow?.(current);", ""],
  ["view", "every tab is in the tab order", 'tab.setAttribute("tabindex", selected ? "0" : "-1");', 'tab.setAttribute("tabindex", "0");'],
  ["view", "a waiting page is not dimmed", '`settings-tab${page.live ? "" : " is-soon"}`', '"settings-tab"'],
  ["view", "a waiting page has no tooltip", 'if (!page.live) tab.setAttribute("title", waitingLine(page));', ""],
  ["view", "the host does not get its grid class", 'root.classList.add("settings-window");', ""],
  ["view", "the search does not search", 'search.addEventListener("input", draw);', ""],
  ["view", "nothing is said when nothing matches", "if (shown.length === 0) {", "if (false) {"],
  ["view", "the count under the table is not updated", "summary.textContent = shortcutSummary(rows, shown.length);", ""],
  ["view", "a clash chip has no tooltip", 'chip.setAttribute("title",', "(() => 0)("],
  ["view", "a clash chip is not marked bad", 'chip.dataset.tone = "bad";', ""],
  ["view", "the tab list is not a tab list", 'nav.setAttribute("role", "tablist");', ""],
  ["view", "a panel is not tied to its tab", 'panel.setAttribute("aria-labelledby", tab.id);', ""],
  ["view", "the Home key does nothing", 'key === "Home" ? order[0] :', "false ? order[0] :"],
  ["view", "focus does not follow the selection", "tabs.get(target)?.focus();", ""],
];

let caught = 0;
const survivors = [];
try {
  for (const [key, name, find, replace] of mutants) {
    const text = original[key];
    if (!text.includes(find)) {
      console.log("NOT FOUND:", name);
      survivors.push(`${name} (pattern not found)`);
      continue;
    }
    fs.writeFileSync(files[key], text.replace(find, replace));
    const r = spawnSync("npx", ["vitest", "run", "tests/settings-shortcuts.test.ts", "tests/settings-pages.test.ts", "tests/settings-window-view.test.ts"], { cwd: editor, encoding: "utf8", shell: true, timeout: 120000 });
    fs.writeFileSync(files[key], text);
    const ok = r.status !== 0;
    if (ok) caught += 1;
    else survivors.push(name);
    console.log(ok ? "caught  " : "SURVIVED", name);
  }
} finally {
  for (const [key, file] of Object.entries(files)) fs.writeFileSync(file, original[key]);
}
const restored = Object.entries(files).every(([key, file]) => fs.readFileSync(file, "utf8") === fs.readFileSync(path.join(backups, `${key}.orig`), "utf8"));
console.log(JSON.stringify({ mutants: mutants.length, caught, survivors, restoredByteForByte: restored }));
