(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const edit = document.querySelector('.app-menu[data-menu="edit"]');
  edit.open = true;
  await wait(300);
  edit.querySelector('[data-menu-item="edit.line-up"] .menu-sub-toggle').click();
  await wait(500);
  return [...edit.querySelectorAll('[data-menu-item^="edit.line-up."]')].map((n) => `${n.dataset.menuItem}: ${n.textContent.trim().slice(0, 40)}${n.getAttribute("aria-disabled") === "true" ? " [dimmed]" : ""}`);
})()
