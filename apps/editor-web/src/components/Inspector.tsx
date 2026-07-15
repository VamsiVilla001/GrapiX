import { getMaterialBindingId, isMaterialCompatible, type BindingMap, type SceneObject, type SceneProperty } from "@grapix/shared-types";
import { Eye, EyeOff, Lock, Unlock } from "lucide-react";
import { useEditorStore } from "../store/editorStore";

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

export function Inspector() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const updateObject = useEditorStore((state) => state.updateObject);
  const updateObjectBindings = useEditorStore((state) => state.updateObjectBindings);
  const assignMaterialSlot = useEditorStore((state) => state.assignMaterialSlot);
  const object = scene.objects.find((item) => item.id === selectedObjectId);

  if (!object) {
    return (
      <aside className="inspector">
        <h2>Inspector</h2>
        <div className="empty-panel">No object selected</div>
      </aside>
    );
  }

  function patch(patchValue: Partial<SceneObject>) {
    updateObject(object!.id, patchValue);
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
    <aside className="inspector">
      <div className="panel-heading">
        <h2>Inspector</h2>
        <div className="mini-action-row">
          <button
            className="mini-icon-button"
            onClick={() => patch({ visible: !object.visible })}
            title={object.visible ? "Hide object" : "Show object"}
          >
            {object.visible ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
          </button>
          <button
            className="mini-icon-button"
            onClick={() => patch({ locked: !object.locked })}
            title={object.locked ? "Unlock object" : "Lock object"}
          >
            {object.locked ? <Lock size={16} aria-hidden="true" /> : <Unlock size={16} aria-hidden="true" />}
          </button>
        </div>
      </div>

      <section className="field-section">
        <TextField label="Name" value={object.name} onChange={(value) => patch({ name: value })} />
        <SelectField
          label="Main Material"
          value={getMaterialBindingId(object.materialSlots.main) ?? ""}
          options={["", ...scene.materials.filter((material) => isMaterialCompatible(material, object.type)).map((material) => material.materialId)]}
          renderOption={(value) =>
            value ? scene.materials.find((material) => material.materialId === value)?.name ?? value : "None"
          }
          onChange={(value) => assignMaterialSlot(object.id, "main", value)}
        />
        {object.type === "text" ? (
          <TextField label="Text" value={object.text} onChange={(value) => patch({ text: value } as Partial<SceneObject>)} />
        ) : null}
        {object.type === "image" ? (
          <TextField label="Image URL" value={object.src} onChange={(value) => patch({ src: value } as Partial<SceneObject>)} />
        ) : null}
      </section>

      <section className="field-section two-column">
        <NumberField label="X" value={object.x} onChange={(value) => patch({ x: value })} />
        <NumberField label="Y" value={object.y} onChange={(value) => patch({ y: value })} />
        <NumberField label="Z" value={object.zDepth} onChange={(value) => patch({ zDepth: value })} />
        <TextField label="Layer" value={object.layerId} onChange={(value) => patch({ layerId: value || "main" })} />
        <NumberField label="W" value={object.width} onChange={(value) => patch({ width: value })} />
        <NumberField label="H" value={object.height} onChange={(value) => patch({ height: value })} />
        <NumberField label="Rotate" value={object.rotation} onChange={(value) => patch({ rotation: value })} />
        <NumberField
          label="Opacity"
          value={object.opacity}
          step={0.05}
          min={0}
          max={1}
          onChange={(value) => patch({ opacity: value })}
        />
      </section>

      <section className="field-section two-column">
        <ColorField label="Fill" value={object.fill} onChange={(value) => patch({ fill: value })} />
        <ColorField label="Stroke" value={object.stroke} onChange={(value) => patch({ stroke: value })} />
        <NumberField label="Stroke" value={object.strokeWidth} min={0} onChange={(value) => patch({ strokeWidth: value })} />
        {object.type === "rect" ? (
          <NumberField label="Radius" value={object.radius} min={0} onChange={(value) => patch({ radius: value } as Partial<SceneObject>)} />
        ) : null}
      </section>

      {object.type === "text" ? (
        <section className="field-section two-column">
          <NumberField
            label="Font"
            value={object.fontSize}
            min={8}
            onChange={(value) => patch({ fontSize: value } as Partial<SceneObject>)}
          />
          <SelectField
            label="Weight"
            value={object.fontWeight}
            options={["400", "500", "600", "700", "800"]}
            onChange={(value) => patch({ fontWeight: value } as Partial<SceneObject>)}
          />
          <SelectField
            label="Align"
            value={object.align}
            options={["left", "center", "right"]}
            onChange={(value) => patch({ align: value } as Partial<SceneObject>)}
          />
        </section>
      ) : null}

      <section className="field-section binding-section">
        <h3>Bindings</h3>
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
      </section>
    </aside>
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
      <input
        type="color"
        value={safeColor}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: T[];
  renderOption?: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>
        {props.options.map((option) => (
          <option value={option} key={option}>
            {props.renderOption ? props.renderOption(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}
