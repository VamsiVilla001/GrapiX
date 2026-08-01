import type { BindingMap, SceneObject, SceneProperty } from "@grapix/shared-types";
import { Inspector } from "./Inspector";
import { TextFontControls } from "./TextFontControls";
import { MaterialsTab } from "./MaterialsTab";
import { ColorField, NumberField, SelectField, TextField } from "./inspectorFields";
import { useEditorStore } from "../store/editorStore";
import { bindablePropertiesFor } from "../store/objectPropertySupport";
import { useUiStore } from "../store/uiStore";

export const propertyInspectorTabs = ["Properties", "Materials", "Text", "Data Binding"] as const;
export type PropertyInspectorTab = (typeof propertyInspectorTabs)[number];

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
        <TextFontControls compact object={object} patch={patch} />
        <NumberField label="Size" value={object.fontSize} min={8} onChange={(fontSize) => patch({ fontSize } as Partial<SceneObject>)} />
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
        {bindablePropertiesFor(object)
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

