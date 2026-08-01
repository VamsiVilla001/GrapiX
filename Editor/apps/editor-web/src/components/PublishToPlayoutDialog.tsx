import type { SceneDocument } from "@grapix/shared-types";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { saveSceneToApi } from "../lib/apiClient";
import { publishSceneToPlayout } from "../lib/playoutPublisher";
import { useEditorStore } from "../store/editorStore";
import { useProjectStore } from "../store/projectStore";
import { useTemplateStore } from "../store/templateStore";
import { useUiStore } from "../store/uiStore";

/**
 * Selects the immutable scene version that is promoted to Playout.
 *
 * Publishing never changes the scene open in the Editor and never patches an on-air engine
 * scene. Playout stores a new library version, so the designer can keep editing another
 * template while the previously published version remains live.
 */
export function PublishToPlayoutDialog({ onClose }: { onClose: () => void }) {
  const templates = useTemplateStore((state) => state.templates);
  const selectedTemplateId = useTemplateStore((state) => state.selectedTemplateId);
  const openedTemplateId = useTemplateStore((state) => state.openedTemplateId);
  const activeScene = useEditorStore((state) => state.scene);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const colorSpace = useProjectStore((state) => state.settings.colorSpace);
  const [choice, setChoice] = useState(
    selectedTemplateId ?? openedTemplateId ?? templates[0]?.templateId ?? ""
  );
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape" && !publishing) onClose();
    }
    window.addEventListener("keydown", closeFromKeyboard);
    return () => window.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose, publishing]);

  const deployable = useMemo(
    () => templates.map((template) => ({
      template,
      // The active editor state is the freshest source. The global catalogue sync normally
      // already contains it, but choosing it directly closes the effect-timing gap on a click.
      scene:
        hasActiveScene && openedTemplateId === template.templateId
          ? { ...activeScene, id: template.sceneId }
          : template.scene
    })),
    [activeScene, hasActiveScene, openedTemplateId, templates]
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const selected = deployable.find((candidate) => candidate.template.templateId === choice);
    if (!selected) return;

    setPublishing(true);
    setError(null);
    try {
      const scene: SceneDocument = structuredClone(selected.scene);
      await saveSceneToApi(scene);
      const result = await publishSceneToPlayout(scene, {
        colorSpace,
        // Only the mounted template can be rendered without switching the Editor.
        // Capture its held final frame for the library card, then restore the playhead.
        withoutThumbnail: openedTemplateId !== selected.template.templateId,
        thumbnailRestoreFrame: currentFrame
      });
      window.alert(
        `Published "${result.published.name}" to Playout as version ${result.published.version}.\n\n`
        + "The published version is immutable; you can continue editing other scenes while it is live."
      );
      onClose();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Publish to Playout failed");
    } finally {
      setPublishing(false);
    }
  }

  return createPortal(
    <div
      className="material-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !publishing) onClose();
      }}
    >
      <form
        className="material-create-dialog publish-playout-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-playout-title"
      >
        <header>
          <strong id="publish-playout-title">Publish scene to Playout</strong>
          <button aria-label="Close" disabled={publishing} onClick={onClose} type="button">×</button>
        </header>

        <p className="material-dialog-note">
          Select the scene revision that is ready for broadcast. Publishing does not switch
          the editor or replace the version currently on air.
        </p>

        <div className="publish-scene-list" role="radiogroup" aria-label="Scenes ready to deploy">
          {deployable.map(({ template, scene }) => (
            <label className={choice === template.templateId ? "selected" : ""} key={template.templateId}>
              <input
                checked={choice === template.templateId}
                disabled={publishing}
                name="deployment-scene"
                onChange={() => setChoice(template.templateId)}
                type="radio"
                value={template.templateId}
              />
              <span className="publish-scene-id">{template.shortLabel}</span>
              <span>
                <strong>{template.name}</strong>
                <small>{scene.objects.length} objects · revision {scene.revision ?? 0}</small>
              </span>
            </label>
          ))}
          {deployable.length === 0 ? (
            <p className="material-dialog-note">No scenes exist. Create a template before publishing.</p>
          ) : null}
        </div>

        {error ? <p className="publish-playout-error">{error}</p> : null}

        <footer>
          <button disabled={publishing} onClick={onClose} type="button">Cancel</button>
          <button className="primary" disabled={!choice || publishing} type="submit">
            {publishing ? "Publishing…" : "Deploy selected scene"}
          </button>
        </footer>
      </form>
    </div>,
    document.body
  );
}

