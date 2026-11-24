(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  // The test project, from File > Recent projects.
  const file = document.querySelector('.app-menu[data-menu="file"]');
  file.open = true;
  await wait(300);
  file.querySelector('[data-menu-item="file.open-recent"] .menu-sub-toggle').click();
  await wait(900);
  [...document.querySelectorAll(".menu-recent")].find((b) => !b.disabled && b.textContent.includes("LiveFinals7")).click();
  await wait(2500);
  file.open = false;
  if ($("start-dialog").open) $("start-dialog").close();
  $("new-scene").click();
  await wait(500);
  $("manager-create-name").value = "Arrange check";
  $("manager-create-name").dispatchEvent(new Event("input", { bubbles: true }));
  $("manager-create-form").requestSubmit();
  await wait(1500);
  for (let i = 0; i < 3; i++) {
    document.querySelector('.creation-tools [data-create-kind="rect"]').click();
    await wait(800);
  }
  out.objects = [...document.querySelectorAll('button[data-action="select"][data-for]')].map((b) => b.dataset.for);
  out.activity = [...document.querySelectorAll("#log li")].slice(0, 3).map((li) => li.textContent.trim().slice(0, 70));
  out.fields = [...document.querySelectorAll("[data-inspector-field]")].map((i) => i.dataset.inspectorField);
  return out;
})()
