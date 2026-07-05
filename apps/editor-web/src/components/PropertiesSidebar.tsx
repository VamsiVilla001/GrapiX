import type { BindingMap, SceneKeyframe, SceneObject, SceneProperty } from "@grapix/shared-types";
import { KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Inspector } from "./Inspector";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

const tabs = ["Properties", "Animation", "Text", "Data Binding"] as const;
const bindableProperties: SceneProperty[] = [
  "text",
  "src",
  "fill",
  "stroke",
  "visible",
  "x",
  "y",
  "zDepth",
  "width",
  "height",
  "rotation",
  "opacity"
];

export function PropertiesSidebar() {
  const propertiesTab = useUiStore((state) => state.propertiesTab);
  const setPropertiesTab = useUiStore((state) => state.setPropertiesTab);

  return (
    <aside className="properties-sidebar">
      <div className="properties-tabs">
        {tabs.map((tab) => (
          <button
            className={`properties-tab ${propertiesTab === tab ? "active" : ""}`}
            key={tab}
            onClick={() => setPropertiesTab(tab)}
          >
            {tab}
          </button>
        ))}
        <button className="panel-icon-button" title="Reset view"><RotateCcw size={14} /></button>
      </div>
      <div className="properties-tab-body">
        {propertiesTab === "Properties" ? <Inspector /> : null}
        {propertiesTab === "Animation" ? <AnimationProperties /> : null}
        {propertiesTab === "Text" ? <TextProperties /> : null}
        {propertiesTab === "Data Binding" ? <DataBindingProperties /> : null}
      </div>
      <section className="output-previews">
        <div className="output-header">Output Previews</div>
        <div className="preview-grid">
          <div className="preview-tile wide">16:9</div>
          <div className="preview-tile tall">9:16</div>
          <div className="preview-tile square">1:1</div>
        </div>
      </section>
    </aside>
  );
}

function AnimationProperties() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const addObjectKeyframe = useEditorStore((state) => state.addObjectKeyframe);
  const updateObjectKeyframe = useEditorStore((state) => state.updateObjectKeyframe);
  const deleteObjectKeyframe = useEditorStore((state) => state.deleteObjectKeyframe);
  const updateTimeline = useEditorStore((state) => state.updateTimeline);
  const currentFrame = useUiStore((state) => state.currentFrame);
  const setCurrentFrame = useUiStore((state) => state.setCurrentFrame);
  const selectedObject = scene.objects.find((object) => object.id === selectedObjectId);
  const selectedKeyframes = scene.timeline.keyframes.filter((keyframe) => keyframe.objectId === selectedObjectId);

  if (!selectedObject) {
    return <EmptyState>Select an object to animate</EmptyState>;
  }

  return (
    <section className="property-tab-panel">
      <Header title="Animation" subtitle={selectedObject.name} />
      <div className="field-section two-column">
        <NumberField label="Frame" value={currentFrame} min={0} max={scene.timeline.durationFrames} onChange={setCurrentFrame} />
        <NumberField
          label="Duration"
          value={scene.timeline.durationFrames}
          min={1}
          onChange={(durationFrames) => updateTimeline({ durationFrames })}
        />
        <SelectField
          label="FPS"
          value={String(scene.timeline.fps)}
          options={["24", "30", "50", "60"]}
          onChange={(fps) => updateTimeline({ fps: Number(fps) })}
        />
      </div>
      <button className="wide-action-button" onClick={() => addObjectKeyframe(selectedObject.id, currentFrame)}>
        <Plus size={14} /> Add Keyframe
      </button>
      <div className="keyframe-list">
        {selectedKeyframes.length === 0 ? <div className="empty-panel compact">No keyframes yet</div> : null}
        {selectedKeyframes.map((keyframe) => (
          <KeyframeRow
            key={keyframe.id}
            keyframe={keyframe}
            maxFrame={scene.timeline.durationFrames}
            onUpdate={updateObjectKeyframe}
            onDelete={deleteObjectKeyframe}
          />
        ))}
      </div>
    </section>
  );
}

function TextProperties() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const updateObject = useEditorStore((state) => state.updateObject);
  const object = scene.objects.find((item) => item.id === selectedObjectId);

  if (!object || object.type !== "text") {
    return <EmptyState>Select a text object</EmptyState>;
  }

  function patch(patchValue: Partial<SceneObject>) {
    updateObject(object!.id, patchValue);
  }

  return (
    <section className="property-tab-panel">
      <Header title="Text" subtitle={object.name} />
      <div className="field-section">
        <TextField label="Content" value={object.text} onChange={(text) => patch({ text } as Partial<SceneObject>)} />
      </div>
      <div className="field-section two-column">
        <NumberField label="Size" value={object.fontSize} min={8} onChange={(fontSize) => patch({ fontSize } as Partial<SceneObject>)} />
        <SelectField
          label="Weight"
          value={object.fontWeight}
          options={["400", "500", "600", "700", "800"]}
          onChange={(fontWeight) => patch({ fontWeight } as Partial<SceneObject>)}
        />
        <SelectField
          label="Align"
          value={object.align}
          options={["left", "center", "right"]}
          onChange={(align) => patch({ align } as Partial<SceneObject>)}
        />
        <ColorField label="Fill" value={object.fill} onChange={(fill) => patch({ fill })} />
      </div>
    </section>
  );
}

function DataBindingProperties() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const updateObjectBindings = useEditorStore((state) => state.updateObjectBindings);
  const object = scene.objects.find((item) => item.id === selectedObjectId);

  if (!object) {
    return <EmptyState>Select an object to bind data</EmptyState>;
  }

  function setBinding(property: SceneProperty, path: string) {
    const bindings: BindingMap = {
      ...object!.bindings,
      [property]: path
    };

    if (!path.trim()) {
      delete bindings[property];
    }

    updateObjectBindings(object!.id, bindings);
  }

  return (
    <section className="property-tab-panel">
      <Header title="Data Binding" subtitle={object.name} />
      <div className="field-section binding-section">
        {bindableProperties
          .filter((property) => isPropertySupported(object, property))
          .map((property) => (
            <label className="binding-row" key={property}>
              <span>{property}</span>
              <input
                value={object.bindings[property] ?? ""}
                onChange={(event) => setBinding(property, event.target.value)}
                placeholder="data.path"
              />
            </label>
          ))}
      </div>
      <pre className="binding-preview">{JSON.stringify(scene.dataContext, null, 2)}</pre>
    </section>
  );
}

function KeyframeRow(props: {
  keyframe: SceneKeyframe;
  maxFrame: number;
  onUpdate: (keyframeId: string, patch: Partial<SceneKeyframe>) => void;
  onDelete: (keyframeId: string) => void;
}) {
  return (
    <div className="keyframe-row">
      <KeyRound size={14} />
      <NumberField
        label="Frame"
        value={props.keyframe.frame}
        min={0}
        max={props.maxFrame}
        onChange={(frame) => props.onUpdate(props.keyframe.id, { frame })}
      />
      <SelectField
        label="Ease"
        value={props.keyframe.easing}
        options={["linear", "ease-in", "ease-out", "ease-in-out"]}
        onChange={(easing) => props.onUpdate(props.keyframe.id, { easing })}
      />
      <button className="panel-icon-button danger" title="Delete keyframe" onClick={() => props.onDelete(props.keyframe.id)}>
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function Header(props: { title: string; subtitle: string }) {
  return (
    <div className="property-tab-header">
      <h2>{props.title}</h2>
      <span>{props.subtitle}</span>
    </div>
  );
}

function EmptyState(props: { children: string }) {
  return (
    <section className="property-tab-panel">
      <div className="empty-panel">{props.children}</div>
    </section>
  );
}

function isPropertySupported(object: SceneObject, property: SceneProperty): boolean {
  if (property === "text") {
    return object.type === "text";
  }

  if (property === "src") {
    return object.type === "image";
  }

  return true;
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

function ColorField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const safeColor = props.value.startsWith("#") ? props.value : "#ffffff";

  return (
    <label className="field color-field">
      <span>{props.label}</span>
      <input type="color" value={safeColor} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>
        {props.options.map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
