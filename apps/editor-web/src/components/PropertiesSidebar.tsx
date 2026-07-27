import type { BindingMap, SceneObject, SceneProperty } from "@grapix/shared-types";
import { Inspector } from "./Inspector";
import { MaterialsTab } from "./MaterialsTab";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";

export const propertyInspectorTabs = ["Properties", "Materials", "Text", "Data Binding"] as const;
export type PropertyInspectorTab = (typeof propertyInspectorTabs)[number];
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
  "rotationX",
  "rotationY",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ",
  "opacity"
];

export function PropertiesSidebar() {
  const propertiesTab = useUiStore((state) => state.propertiesTab);
  const setPropertiesTab = useUiStore((state) => state.setPropertiesTab);

  return (
    <aside className="properties-sidebar">
      <div className="properties-tabs">
        {propertyInspectorTabs.map((tab) => (
          <button
            className={`properties-tab ${propertiesTab === tab ? "active" : ""}`}
            key={tab}
            onClick={() => setPropertiesTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="properties-tab-body">
        <PropertyInspectorContent tab={propertiesTab} />
      </div>
    </aside>
  );
}

export function PropertyInspectorContent(props: { tab: PropertyInspectorTab }) {
  if (props.tab === "Properties") return <Inspector />;
  if (props.tab === "Materials") return <MaterialsTab />;
  if (props.tab === "Text") return <TextProperties />;
  return <DataBindingProperties />;
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

  if (["rotationX", "rotationY", "rotationZ", "scaleZ"].includes(property)) {
    return object.type === "mesh";
  }

  if (property === "rotation" && object.type === "mesh") {
    return false;
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
