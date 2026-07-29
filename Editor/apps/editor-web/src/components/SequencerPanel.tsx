import type { RundownDocument, SequenceDocument } from "@grapix/shared-types";
import { Braces, Plus, Save } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fireRundownEvent,
  listScenesFromApi,
  saveRundownOnApi,
  type ApiSceneSummary
} from "../lib/apiClient";

export function SequencerPanel() {
  const [rundown, setRundown] = useState<RundownDocument>(() => createRundown());
  const [scenes, setScenes] = useState<ApiSceneSummary[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [eventName, setEventName] = useState("cue.take");
  const [variablePath, setVariablePath] = useState("armed");
  const [variableValue, setVariableValue] = useState("true");
  const [message, setMessage] = useState("");
  const active = rundown.sequences.find((sequence) => sequence.sequenceId === rundown.activeSequenceId)
    ?? rundown.sequences[0];

  useEffect(() => {
    void listScenesFromApi().then((items) => {
      setScenes(items);
      setSelectedSceneId((current) => current || items[0]?.id || "");
    }).catch(() => setMessage("Save scenes to the project service before adding cues."));
  }, []);

  function updateActive(update: (sequence: SequenceDocument) => SequenceDocument) {
    if (!active) return;
    setRundown((current) => ({
      ...current,
      sequences: current.sequences.map((sequence) =>
        sequence.sequenceId === active.sequenceId ? update(sequence) : sequence
      ),
      updatedAt: new Date().toISOString()
    }));
  }

  function addSequence() {
    const sequence = createSequence(`Sequence ${rundown.sequences.length + 1}`);
    setRundown((current) => ({
      ...current,
      activeSequenceId: sequence.sequenceId,
      sequences: [...current.sequences, sequence],
      updatedAt: new Date().toISOString()
    }));
  }

  function addCue() {
    if (!active || !selectedSceneId) return;
    updateActive((sequence) => ({
      ...sequence,
      tracks: sequence.tracks.map((track, index) => index === 0
        ? {
            ...track,
            cues: [...track.cues, {
              cueId: createId("cue"),
              name: scenes.find((scene) => scene.id === selectedSceneId)?.name ?? selectedSceneId,
              sceneId: selectedSceneId,
              startFrame: track.cues.reduce((end, cue) => Math.max(end, cue.startFrame + cue.durationFrames), 0),
              durationFrames: 250,
              prewarmFrames: 50,
              autoTake: false
            }]
          }
        : track)
    }));
  }

  function addConditionalTake() {
    if (!active || !selectedSceneId) return;
    setRundown((current) => ({
      ...current,
      variables: {
        ...current.variables,
        [variablePath]: parseLiteral(variableValue)
      }
    }));
    updateActive((sequence) => ({
      ...sequence,
      triggers: [...sequence.triggers, {
        triggerId: createId("trigger"),
        name: `${eventName} → ${selectedSceneId}`,
        enabled: true,
        event: { type: "api", name: eventName },
        condition: {
          kind: "compare",
          left: { source: "rundown-variable", path: variablePath },
          operator: "eq",
          right: { source: "literal", value: parseLiteral(variableValue) }
        },
        actions: [{ type: "take-scene", sceneId: selectedSceneId }],
        priority: 100,
        cooldownMs: 250
      }]
    }));
  }

  async function dryRunTrigger() {
    try {
      await saveRundownOnApi(rundown);
      const response = await fireRundownEvent(rundown.rundownId, {
        type: "api",
        name: eventName,
        timestampMs: Date.now(),
        payload: {}
      });
      setMessage(JSON.stringify(response));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trigger dry run failed");
    }
  }

  async function save() {
    try {
      await saveRundownOnApi(rundown);
      setMessage("Rundown saved atomically.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rundown save failed");
    }
  }

  return (
    <section className="sequencer-panel">
      <div className="automation-toolbar">
        <input
          value={rundown.name}
          onChange={(event) => setRundown({ ...rundown, name: event.target.value })}
          aria-label="Rundown name"
        />
        <select
          value={active?.sequenceId ?? ""}
          onChange={(event) => setRundown({ ...rundown, activeSequenceId: event.target.value })}
        >
          {rundown.sequences.map((sequence) => <option key={sequence.sequenceId} value={sequence.sequenceId}>{sequence.name}</option>)}
        </select>
        <button onClick={addSequence}><Plus size={13} /> Sequence</button>
        <button onClick={() => void save()}><Save size={13} /> Save</button>
      </div>
      <div className="automation-toolbar">
        <select value={selectedSceneId} onChange={(event) => setSelectedSceneId(event.target.value)}>
          {scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}
        </select>
        <button disabled={!selectedSceneId} onClick={addCue}><Plus size={13} /> Scene cue</button>
      </div>
      <div className="automation-toolbar">
        <input value={eventName} onChange={(event) => setEventName(event.target.value)} aria-label="Trigger event name" />
        <input value={variablePath} onChange={(event) => setVariablePath(event.target.value)} aria-label="Rundown variable" />
        <input value={variableValue} onChange={(event) => setVariableValue(event.target.value)} aria-label="Required value" />
        <button disabled={!selectedSceneId} onClick={addConditionalTake}><Plus size={13} /> Conditional Take</button>
        <button onClick={() => void dryRunTrigger()}><Braces size={13} /> Dry run</button>
      </div>
      <div className="sequence-track">
        <strong>{active?.tracks[0]?.name ?? "Program"}</strong>
        <div className="sequence-cues">
          {(active?.tracks[0]?.cues ?? []).map((cue) => (
            <button className="sequence-cue" key={cue.cueId} title={`${cue.startFrame}–${cue.startFrame + cue.durationFrames}`}>
              {cue.name}
              <span>{cue.startFrame}f · prewarm {cue.prewarmFrames}f</span>
            </button>
          ))}
        </div>
      </div>
      <div className="manager-note">{active?.triggers.length ?? 0} conditional trigger(s) in this sequence.</div>
      {message ? <p className="manager-message">{message}</p> : null}
      <p className="manager-note">
        Each rundown holds multiple sequences and tracks. Conditional trigger rules are evaluated by the GrapiX SDK; on-air cursor ownership remains in the sequencer client.
      </p>
    </section>
  );
}

function createRundown(): RundownDocument {
  const timestamp = new Date().toISOString();
  const sequence = createSequence("Main");
  return {
    rundownId: createId("rundown"),
    name: "Untitled Rundown",
    version: 1,
    activeSequenceId: sequence.sequenceId,
    variables: { armed: true },
    sequences: [sequence],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createSequence(name: string): SequenceDocument {
  return {
    sequenceId: createId("sequence"),
    name,
    fps: 50,
    durationFrames: 18_000,
    tracks: [{
      trackId: createId("track"),
      name: "Program",
      role: "program",
      enabled: true,
      cues: []
    }],
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

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

function parseLiteral(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
