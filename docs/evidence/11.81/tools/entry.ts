import { SHORTCUTS, commandById } from "D:/Project KK/Personal projects/GrapiX/agent/worktree/Editor/src/command-registry";
import { createSettingsWindow } from "D:/Project KK/Personal projects/GrapiX/agent/worktree/Editor/src/settings-window-view";
import { MACHINE_FIELDS, USER_FIELDS, usageLine, type FieldSpec } from "D:/Project KK/Personal projects/GrapiX/agent/worktree/Editor/src/settings-form";

const dialog = document.getElementById("settings-dialog") as HTMLDialogElement;
const gated = ["settings-reset-user", "settings-reset-machine"].map((id) => document.getElementById(id)!);
const win = createSettingsWindow(document, document.getElementById("settings-window")!, {
  shortcuts: SHORTCUTS,
  labelOf: (command) => commandById(command)?.label,
  onShow: (id) => {
    for (const element of gated) element.hidden = id !== "general";
  },
});

// General: the rows main.ts draws, from the real field specs (sample values), into the element the window gives it.
function section(title: string, note: string, scope: string, fields: Record<string, FieldSpec>): HTMLElement {
  const box = document.createElement("section");
  box.className = "settings-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const sub = document.createElement("span");
  sub.className = "settings-note";
  sub.textContent = note;
  heading.append(sub);
  box.append(heading);
  for (const [key, spec] of Object.entries(fields)) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("label");
    label.htmlFor = "setting-" + scope + "-" + key;
    label.textContent = spec.label;
    const input = document.createElement("input");
    input.id = "setting-" + scope + "-" + key;
    input.type = spec.kind === "toggle" ? "checkbox" : "text";
    const help = document.createElement("p");
    help.className = "settings-help";
    help.textContent = spec.help + " " + usageLine(spec);
    row.append(label, input, help);
    box.append(row);
  }
  return box;
}
const lead = document.createElement("p");
lead.id = "settings-lead";
lead.className = "settings-lead";
lead.textContent = "Changes are saved as you make them. Yours follows you to another computer; This computer stays here.";
win.general.append(lead, section("Yours", "Follows you to another computer.", "user", USER_FIELDS), section("This computer", "Stays on this computer.", "machine", MACHINE_FIELDS));
(window as unknown as { __win: typeof win }).__win = win;
dialog.showModal();
(window as unknown as { __expected: unknown }).__expected = { commands: new Set(SHORTCUTS.map((s) => s.command)).size, keys: SHORTCUTS.length, fields: Object.keys(USER_FIELDS).length + Object.keys(MACHINE_FIELDS).length };
