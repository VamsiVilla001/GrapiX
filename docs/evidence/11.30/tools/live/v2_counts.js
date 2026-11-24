(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const project = "LiveFinals7";
  const out = {};
  for (const id of ["version-check", "version-check_v002", "version-check_v003", "version-check_v004", "version-check_v005"]) {
    const d = await invoke("cmd_scene_read", { project, sceneId: id });
    out[id] = { name: d.name, objects: d.objects.length, revision: d.revision ?? null };
  }
  return out;
})()
