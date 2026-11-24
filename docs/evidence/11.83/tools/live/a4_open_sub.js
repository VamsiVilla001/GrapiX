(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const edit = document.querySelector('.app-menu[data-menu="edit"]');
  edit.open = true;
  await wait(300);
  const first = edit.querySelector('[data-menu-item="edit.line-up.left"]');
  if (first.offsetParent === null) edit.querySelector('[data-menu-item="edit.line-up"] .menu-sub-toggle').click();
  await wait(500);
  first.scrollIntoView({ block: "center" });
  await wait(200);
  return { visible: first.offsetParent !== null };
})()
