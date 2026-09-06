import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { listScenesFromApi, readSceneFromApi, type ApiSceneSummary } from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";
import { useTemplateStore } from "../store/templateStore";

/**
 * Opens a scene stored by the project service.
 *
 * This is the Editor's only read path for a stored scene. Without it the
 * application was write-only: it saved scenes and could never load one back, so a
 * scene authored by the MCP server, by another agent, or in a previous session was
 * invisible — no cache to clear, simply no code path.
 *
 * The opened scene keeps its server id, so Save updates that scene instead of
 * forking a numeric-id copy. See `serverSceneToTemplateScene`.
 */
export function OpenSceneDialog({ onClose }: { onClose: () => void }) {
  const [scenes, setScenes] = useState<ApiSceneSummary[] | null>(null);
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const loadScene = useEditorStore((state) => state.loadScene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const openServerScene = useTemplateStore((state) => state.openServerScene);

  const refresh = useCallback(async () => {
    setError(null);
    setScenes(null);
    try {
      const listed = await listScenesFromApi();
      setScenes(listed);
      setChoice((current) =>
        listed.some((scene) => scene.id === current) ? current : listed[0]?.id ?? ""
      );
    } catch (cause) {
      setScenes([]);
      // No local hint: `request()` names an unreachable service and its address, and the
      // service's own text explains every other refusal. Appending "is the service running?"
      // to a 423 told the operator to check something that was working.
      setError(cause instanceof Error ? cause.message : "The scene list could not be read.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape" && !opening) onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose, opening]);

  async function open() {
    if (!choice || opening) return;
    if (
      hasActiveScene &&
      !window.confirm("Open this scene? Unsaved changes in the current scene are lost.")
    ) {
      return;
    }

    setOpening(true);
    setError(null);
    try {
      const scene = await readSceneFromApi(choice);
      // Catalogue first, then the editor: `loadScene` clears undo history, and the
      // opened template must already be selected when the editor reads it.
      openServerScene(scene);
      loadScene(scene);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The scene could not be opened.");
    } finally {
      setOpening(false);
    }
  }

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !opening) onClose();
      }}
    >
      <div
        className="material-create-dialog publish-playout-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-scene-title"
      >
        <header>
          <strong id="open-scene-title">Open scene</strong>
          <button aria-label="Close" disabled={opening} onClick={onClose} type="button">×</button>
        </header>

        <p className="material-dialog-note">
          Scenes stored by the project service, newest first. This includes scenes authored
          outside this window — by the GrapiX MCP server or a previous session.
        </p>

        <div className="publish-scene-list" role="radiogroup" aria-label="Stored scenes">
          {scenes === null ? <p className="material-dialog-note">Reading the scene library…</p> : null}

          {scenes?.map((scene) => (
            <label className={choice === scene.id ? "selected" : ""} key={scene.id}>
              <input
                checked={choice === scene.id}
                disabled={opening}
                name="open-scene"
                onChange={() => setChoice(scene.id)}
                type="radio"
                value={scene.id}
              />
              <span className="publish-scene-id">{scene.id}</span>
              <span>
                <strong>{scene.name}</strong>
                <small>
                  revision {scene.revision} · {scene.objectCount} objects ·{" "}
                  {scene.materialCount} materials · {new Date(scene.updatedAt).toLocaleString()}
                </small>
              </span>
            </label>
          ))}

          {scenes?.length === 0 && !error ? (
            <p className="material-dialog-note">
              The project service has no stored scenes yet. Save one with File &gt; Save.
            </p>
          ) : null}
        </div>

        {error ? <p className="publish-playout-error">{error}</p> : null}

        <footer>
          <button disabled={opening} onClick={() => void refresh()} type="button">Refresh</button>
          <button disabled={opening} onClick={onClose} type="button">Cancel</button>
          <button className="primary" disabled={!choice || opening} onClick={() => void open()} type="button">
            {opening ? "Opening…" : "Open scene"}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
