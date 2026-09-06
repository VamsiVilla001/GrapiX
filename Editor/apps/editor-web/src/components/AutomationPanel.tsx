import type {
  AssetLibraryItem,
  GrapixTriggerRule,
  SceneAutomationDefinition,
  SceneScriptPermission,
  TriggerEventType
} from "@grapix/shared-types";
import { Braces, Play, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { fireSceneEvent, importSceneScriptToApi } from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";

const defaultPermissions: SceneScriptPermission[] = ["read-data", "patch-data", "emit-event"];

export function AutomationPanel() {
  const scene = useEditorStore((state) => state.scene);
  const saveScene = useEditorStore((state) => state.saveScene);
  const updateAutomation = useEditorStore((state) => state.updateAutomation);
  const attachSceneScript = useEditorStore((state) => state.attachSceneScript);
  const fileRef = useRef<HTMLInputElement>(null);
  const [eventType, setEventType] = useState<TriggerEventType>("data-change");
  const [eventName, setEventName] = useState("score.changed");
  const [conditionPath, setConditionPath] = useState("score.home");
  const [conditionValue, setConditionValue] = useState("10");
  const [actionType, setActionType] = useState<"preview-scene" | "take-scene" | "emit-event">("take-scene");
  const [transitionId, setTransitionId] = useState("cut");
  const [result, setResult] = useState("");
  const automation = scene.automation ?? emptyAutomation();

  function addTrigger() {
    const trigger: GrapixTriggerRule = {
      triggerId: createId("trigger"),
      name: `${eventName} → ${actionType}`,
      enabled: true,
      event: { type: eventType, name: eventName },
      condition: conditionPath.trim()
        ? {
            kind: "compare",
            left: { source: "scene-data", path: conditionPath.trim() },
            operator: "gte",
            right: { source: "literal", value: parseLiteral(conditionValue) }
          }
        : undefined,
      actions: actionType === "emit-event"
        ? [{ type: "emit-event", name: `${eventName}.matched` }]
        : actionType === "take-scene"
          ? [{ type: actionType, sceneId: scene.id, transitionId: transitionId === "cut" ? undefined : transitionId }]
          : [{ type: actionType, sceneId: scene.id }],
      priority: 100,
      cooldownMs: 250
    };
    updateAutomation({ ...automation, triggers: [...automation.triggers, trigger] });
  }

  async function testEvent(execute: boolean) {
    try {
      // Same guarded write as Save, so a trigger test cannot leave the status indicator
      // claiming the scene is unsaved after it has just been persisted.
      if (!(await saveScene())) {
        setResult("The scene could not be saved, so the trigger was not fired.");
        return;
      }
      const response = await fireSceneEvent(scene.id, {
        type: eventType,
        name: eventName,
        timestampMs: Date.now(),
        payload: {}
      }, execute);
      setResult(JSON.stringify(response, null, 2));
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Trigger test failed");
    }
  }

  async function attachScript(file: File) {
    try {
      const imported = await importSceneScriptToApi(file, defaultPermissions);
      const asset: AssetLibraryItem = {
        assetId: imported.asset.assetId,
        storageAssetId: imported.asset.assetId,
        name: imported.asset.fileName,
        kind: "script",
        source: imported.asset.contentUrl,
        mimeType: imported.asset.mimeType,
        sizeBytes: imported.asset.sizeBytes,
        checksum: imported.asset.checksum,
        importedAt: imported.asset.importedAt,
        status: "READY"
      };
      attachSceneScript(imported.script, asset);
      setResult(`Attached ${file.name}. Execution is restricted to the control-sandbox SDK boundary.`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Script import failed");
    }
  }

  return (
    <section className="automation-panel">
      <div className="automation-grid">
        <label>Event
          <select value={eventType} onChange={(event) => setEventType(event.target.value as TriggerEventType)}>
            {["manual", "api", "webhook", "data-change", "timer", "timecode", "keyboard", "scene-event"].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <label>Name<input value={eventName} onChange={(event) => setEventName(event.target.value)} /></label>
        <label>Scene-data path<input value={conditionPath} onChange={(event) => setConditionPath(event.target.value)} /></label>
        <label>Minimum/equal value<input value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} /></label>
        <label>Action
          <select value={actionType} onChange={(event) => setActionType(event.target.value as typeof actionType)}>
            <option value="preview-scene">Preview scene</option>
            <option value="take-scene">Take scene</option>
            <option value="emit-event">Emit event</option>
          </select>
        </label>
        <label>Transition
          <select
            disabled={actionType !== "take-scene"}
            value={transitionId}
            onChange={(event) => setTransitionId(event.target.value)}
          >
            {automation.transitions.map((transition) => (
              <option key={transition.transitionId} value={transition.transitionId}>
                {transition.name} · {transition.durationFrames}f
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="automation-toolbar">
        <button onClick={addTrigger}><Plus size={13} /> Add conditional trigger</button>
        <button onClick={() => {
          const nextId = createId("mix");
          updateAutomation({
            ...automation,
            transitions: [...automation.transitions, {
              transitionId: nextId,
              name: `Mix ${automation.transitions.filter((item) => item.kind === "mix").length + 1}`,
              kind: "mix",
              durationFrames: Math.round(scene.timeline.fps / 2),
              easing: "ease-in-out"
            }]
          });
          setTransitionId(nextId);
        }}><Plus size={13} /> Mix definition</button>
        <button onClick={() => void testEvent(false)}><Braces size={13} /> Dry run</button>
        <button onClick={() => void testEvent(true)}><Play size={13} /> Execute</button>
      </div>
      <div className="manager-list">
        {automation.triggers.map((trigger) => (
          <article className="manager-list-item" key={trigger.triggerId}>
            <input
              checked={trigger.enabled}
              type="checkbox"
              onChange={(event) => updateAutomation({
                ...automation,
                triggers: automation.triggers.map((item) =>
                  item.triggerId === trigger.triggerId ? { ...item, enabled: event.target.checked } : item
                )
              })}
            />
            <div><strong>{trigger.name}</strong><span>{trigger.event.type} · {trigger.actions.length} action(s)</span></div>
            <button onClick={() => updateAutomation({
              ...automation,
              triggers: automation.triggers.filter((item) => item.triggerId !== trigger.triggerId)
            })}><Trash2 size={13} /></button>
          </article>
        ))}
      </div>
      <div className="automation-toolbar">
        <button onClick={() => fileRef.current?.click()}><Upload size={13} /> Attach scene JavaScript</button>
        <input
          accept=".js,.mjs"
          hidden
          ref={fileRef}
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void attachScript(file);
            event.target.value = "";
          }}
        />
        <span>{automation.script?.enabled ? automation.script.scriptId : "No script"}</span>
      </div>
      {result ? <pre className="automation-result">{result}</pre> : null}
    </section>
  );
}

function emptyAutomation(): SceneAutomationDefinition {
  return {
    version: 1,
    transitions: [{
      transitionId: "cut",
      name: "Cut",
      kind: "cut",
      durationFrames: 0,
      easing: "linear"
    }],
    triggers: []
  };
}

function parseLiteral(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}
