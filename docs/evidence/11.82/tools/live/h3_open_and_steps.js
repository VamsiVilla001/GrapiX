(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__historyRows = () =>
    [...document.querySelectorAll("#history-list .history-row")].map((b) =>
      [b.dataset.step ?? "-", b.querySelector(".history-what").textContent, b.querySelector(".history-from").textContent, b.classList.contains("undone") ? "undone" : "applied", b.getAttribute("aria-current") === "step" ? "CURRENT" : ""].join(" | "),
    );
  window.__activity = (n = 4) => [...document.querySelectorAll("#log li")].slice(0, n).map((li) => li.textContent.trim().slice(0, 110));
  const out = {};

  // File > Recent projects > the last test project.
  const file = document.querySelector('.app-menu[data-menu="file"]');
  file.open = true;
  await wait(300);
  file.querySelector('[data-menu-item="file.open-recent"] .menu-sub-toggle').click();
  await wait(900);
  const recent = [...document.querySelectorAll(".menu-recent")];
  out.recent = recent.map((b) => b.textContent.trim().slice(0, 50) + (b.disabled ? " [missing]" : ""));
  const pick = recent.find((b) => !b.disabled && b.textContent.includes("LiveFinals7")) ?? recent.find((b) => !b.disabled);
  pick.click();
  await wait(2500);
  file.open = false;
  out.project = $("project-summary").textContent.slice(0, 70);

  $("new-scene").click();
  await wait(1200);
  out.afterNew = { activity: window.__activity(2), historyLead: $("history-lead").textContent, rows: window.__historyRows() };

  for (const kind of ["rect", "ellipse", "text"]) {
    document.querySelector(`.creation-tools [data-create-kind="${kind}"], .creation-tools [data-kind="${kind}"]`).click();
    await wait(900);
  }
  out.afterCreates = {
    undoDisabled: $("undo").disabled,
    redoDisabled: $("redo").disabled,
    activity: window.__activity(3),
    dialogOpen: $("history-dialog").open,
    lead: $("history-lead").textContent,
    rows: window.__historyRows(),
    error: $("history-error").textContent,
  };
  return out;
})()
