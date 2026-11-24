(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rowsNow = () =>
    [...document.querySelectorAll("#history-list .history-row")].map((b) =>
      [b.dataset.step ?? "-", b.querySelector(".history-what").textContent, b.classList.contains("undone") ? "undone" : "applied", b.getAttribute("aria-current") === "step" ? "CURRENT" : ""].join(" | "),
    );
  const lines = () => document.querySelectorAll("#log li").length;
  const out = {};
  const start = $("start-dialog");
  out.startShown = start.open;
  // File > Recent projects > the test project, then the scene made in the last run.
  const file = document.querySelector('.app-menu[data-menu="file"]');
  file.open = true;
  await wait(300);
  file.querySelector('[data-menu-item="file.open-recent"] .menu-sub-toggle').click();
  await wait(900);
  const pick = [...document.querySelectorAll(".menu-recent")].find((b) => !b.disabled && b.textContent.includes("LiveFinals7"));
  pick.click();
  await wait(2500);
  file.open = false;
  if (start.open) start.close();
  $("new-scene").click();
  await wait(500);
  $("manager-create-name").value = "History check 2";
  $("manager-create-name").dispatchEvent(new Event("input", { bubbles: true }));
  $("manager-create-form").requestSubmit();
  await wait(1500);
  for (const kind of ["rect", "ellipse"]) {
    document.querySelector(`.creation-tools [data-create-kind="${kind}"], .creation-tools [data-kind="${kind}"]`).click();
    await wait(900);
  }
  $("history-open").click();
  await wait(900);
  out.rows = rowsNow();
  const before = lines();
  document.querySelector('#history-list .history-row[aria-current="step"]').click();
  await wait(900);
  out.currentClick = { newActivityLines: lines() - before, rows: rowsNow() };
  const before2 = lines();
  [...document.querySelectorAll("#history-list .history-row")][1].click();
  await wait(900);
  out.otherClick = { newActivityLines: lines() - before2, rows: rowsNow(), last: document.querySelector("#log li").textContent.trim().slice(0, 60) };
  return out;
})()
