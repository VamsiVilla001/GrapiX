// Builds the hand-off patch for the Settings window (11.81, E4) from COPIES of the live main.ts and index.html: every edit must match the
// live text exactly or this stops, so a patch is only written when it would apply. The repo files are not touched.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = "D:/Project KK/Personal projects/GrapiX/agent/worktree";
const scratch = path.resolve("handoff");
fs.rmSync(scratch, { recursive: true, force: true });
for (const dir of ["a/Editor/web", "b/Editor/web"]) fs.mkdirSync(path.join(scratch, dir), { recursive: true });

const files = ["main.ts", "index.html"];
const text = {};
for (const f of files) {
  text[f] = fs.readFileSync(path.join(repo, "Editor/web", f), "utf8");
  fs.writeFileSync(path.join(scratch, "a/Editor/web", f), text[f]);
}

function edit(file, find, replace) {
  if (text[file].split(find).length !== 2) throw new Error(`${file}: the text to replace is not there exactly once:\n${find.slice(0, 120)}`);
  text[file] = text[file].replace(find, replace);
}

// main.ts 1: the registry's key table, and the view
edit("main.ts", "import {\n  commandById,\n  decideKey,", "import {\n  SHORTCUTS,\n  commandById,\n  decideKey,");
edit("main.ts", 'import { MACHINE_FIELDS, toValue, USER_FIELDS, usageLine, type FieldSpec } from "../src/settings-form";\n', 'import { MACHINE_FIELDS, toValue, USER_FIELDS, usageLine, type FieldSpec } from "../src/settings-form";\nimport { createSettingsWindow } from "../src/settings-window-view";\n');

// main.ts 2: the window, made once; General is drawn into the element it gives
edit(
  "main.ts",
  "async function renderSettings(): Promise<void> {\n  const settings = await readSettings();\n  ui.settingsBody.replaceChildren();\n",
  `/** The Settings window's nav and pages (11.81, Figma E4). General is drawn into \`settingsWindow.general\` by \`renderSettings\` below, as it always was;
 *  Shortcuts and the page that waits for row 8.14 are drawn by the view (src/settings-window-view.ts). The two resets belong to General. */
const settingsWindow = createSettingsWindow(document, ui.settingsBody, {
  shortcuts: SHORTCUTS,
  labelOf: (command) => commandById(command)?.label,
  onShow: (page) => {
    ui.settingsResetUser.hidden = page !== "general";
    ui.settingsResetMachine.hidden = page !== "general";
  },
});

/** What the General page says first (it was a paragraph of the dialog; it belongs to the page it explains). */
function settingsLead(): HTMLElement {
  const lead = document.createElement("p");
  lead.className = "settings-lead";
  const bold = (words: string): HTMLElement => {
    const strong = document.createElement("strong");
    strong.textContent = words;
    return strong;
  };
  lead.append("Changes are saved as you make them. ", bold("Yours"), " follows you to another computer; ", bold("This computer"), " stays here. What changes how a graphic looks is not here: that belongs to the project.");
  return lead;
}

async function renderSettings(): Promise<void> {
  const settings = await readSettings();
  const general = settingsWindow.general;
  general.replaceChildren(settingsLead());
`,
);
edit("main.ts", "    ui.settingsBody.append(section);", "    general.append(section);");

// index.html: the lead moves into General; the stylesheet is linked
edit(
  "index.html",
  '        <p class="settings-lead">Changes are saved as you make them. <strong>Yours</strong> follows you to another computer; <strong>This computer</strong> stays here. What changes how a graphic looks is not here: that belongs to the project.</p>\n',
  "",
);
edit("index.html", '    <link rel="stylesheet" href="style.css" />\n', '    <link rel="stylesheet" href="style.css" />\n    <link rel="stylesheet" href="settings-window.css" />\n');

for (const f of files) fs.writeFileSync(path.join(scratch, "b/Editor/web", f), text[f]);
const diff = spawnSync("diff", ["-u", "--label", "a/Editor/web/main.ts", "--label", "b/Editor/web/main.ts", path.join(scratch, "a/Editor/web/main.ts"), path.join(scratch, "b/Editor/web/main.ts")], { encoding: "utf8" });
const diff2 = spawnSync("diff", ["-u", "--label", "a/Editor/web/index.html", "--label", "b/Editor/web/index.html", path.join(scratch, "a/Editor/web/index.html"), path.join(scratch, "b/Editor/web/index.html")], { encoding: "utf8" });
const patch = `${diff.stdout}${diff2.stdout}`;
fs.writeFileSync(path.join(scratch, "settings-window.patch"), patch);
console.log(patch);
