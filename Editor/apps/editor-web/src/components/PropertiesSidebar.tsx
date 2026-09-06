import {
  resolvePropertySource,
  type BindingMap,
  type PropertySource,
  type SceneObject,
  type SceneProperty
} from "@grapix/shared-types";
import { Inspector } from "./Inspector";
import { MaterialsTab } from "./MaterialsTab";
import { ParityNote } from "./inspectorFields";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import { bindablePropertiesFor } from "../store/objectPropertySupport";

/**
 * The Object Inspector's tab routes.
 *
 * "Text" is gone: a text object's leading tab already *is* the full text editor, so the extra route
 * was a second home for content, font, size, alignment and fill that nothing navigated to.
 */
export const propertyInspectorTabs = ["Properties", "Transform", "Materials", "Data Binding"] as const;
export type PropertyInspectorTab = (typeof propertyInspectorTabs)[number];

/*
 * `PropertiesSidebar` used to be here: a standalone tab shell with its own strip, reading a
 * `propertiesTab` field from the UI store. Nothing mounted it — the dockable `ObjectInspector` owns the
 * strip now, and picks the valid tabs per object type. It is deleted with the store field it was the
 * only reader of, rather than left as a second way to show the same panel.
 */

export function PropertyInspectorContent(props: { tab: PropertyInspectorTab }) {
  if (props.tab === "Properties") return <Inspector scope="type" />;
  if (props.tab === "Transform") return <Inspector scope="transform" />;
  if (props.tab === "Materials") return <MaterialsTab />;
  return <DataBindingProperties />;
}

/*
 * `TextProperties` used to live here: a second text editor duplicating content, the font controls,
 * size, alignment and fill. Nothing routed to it — no tab descriptor lists "Text" as an optional tab,
 * because a text object's *leading* tab is already the full type editor. It is deleted rather than
 * kept, because a dead second home for a property is how two homes come back.
 */
function DataBindingProperties() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const updateObjectBindings = useEditorStore((state) => state.updateObjectBindings);
  const currentFrame = useUiStore((state) => state.currentFrame);
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

  const bound = bindablePropertiesFor(object).filter((property) => object.bindings[property]?.trim());

  return (
    <section aria-labelledby="inspector-data-binding-heading" className="property-tab-panel">
      <Header id="inspector-data-binding-heading" title="Data Binding" subtitle={object.name} />
      {/*
        Program resolves no data bindings — `SceneDocumentDto` has no `dataContext` field and nothing in
        the native renderer reads a path — so every row here is Preview-only. Saying it once at the top
        is better than repeating it on eighteen rows, and not saying it at all is how an author rehearses
        a binding that will not be there on air.
      */}
      <ParityNote>
        Bindings resolve in the Editor's preview only. A published frame draws the authored or keyframed
        value, so a bound property is for rehearsal until Program can read scene data.
      </ParityNote>
      <div className="field-section binding-section">
        {bindablePropertiesFor(object).map((property) => (
          <BindingRow
            currentFrame={currentFrame}
            dataContext={scene.dataContext}
            key={property}
            object={object}
            onChange={(path) => setBinding(property, path)}
            property={property}
          />
        ))}
      </div>
      {bound.length === 0 ? (
        <p className="binding-empty">
          Nothing on this object is bound. Type a path such as <code>match.homeScore</code> into a field
          above; it is checked against the scene's data as you type.
        </p>
      ) : null}
      <SceneDataEditor />
    </section>
  );
}

/**
 * The scene's data, editable.
 *
 * `setDataJson`, `applyDataJson` and `dataError` had been in the store with **no consumer** since the
 * editor that used them was removed, so the Data Binding tab could name paths into data that nothing in
 * the application could create. A binding could be typed, and never resolved, and the tab's only
 * feedback was a `<pre>` dump of the empty object it was failing to find anything in.
 *
 * It is a JSON textarea rather than a structured editor because the data's shape is the *playout*
 * system's, not the Editor's: a rundown or an external feed supplies it on air, and this is the
 * rehearsal stand-in.
 */
function SceneDataEditor() {
  const dataJson = useEditorStore((state) => state.dataJson);
  const dataError = useEditorStore((state) => state.dataError);
  const setDataJson = useEditorStore((state) => state.setDataJson);
  const applyDataJson = useEditorStore((state) => state.applyDataJson);
  return (
    <div className="field-section scene-data-editor">
      <h3>Scene data</h3>
      <p className="binding-empty">
        The values the paths above resolve against. On air this arrives from the rundown; here it stands
        in for it so a binding can be rehearsed.
      </p>
      <textarea
        aria-label="Scene data as JSON"
        onChange={(event) => setDataJson(event.target.value)}
        rows={8}
        spellCheck={false}
        value={dataJson}
      />
      <div className="scene-data-actions">
        <button onClick={() => applyDataJson()} type="button">Apply data</button>
        {dataError ? <span className="scene-data-error">{dataError}</span> : null}
      </div>
    </div>
  );
}

/**
 * One binding, with what it resolves to right now.
 *
 * This replaced a bare text input beside a `<pre>` dump of the entire data context. The dump was the
 * only feedback an author got: it showed what data existed but never whether *this* path found any of
 * it, so a typo, a path into the wrong shape, and a working binding all looked identical. The row now
 * states its own resolution, which is the same question the field in the Transform tab answers.
 */
function BindingRow(props: {
  currentFrame: number;
  dataContext: Record<string, unknown>;
  object: SceneObject;
  onChange: (path: string) => void;
  property: SceneProperty;
}) {
  const source = resolvePropertySource(props.object, props.property, props.dataContext, props.currentFrame);
  const path = props.object.bindings[props.property] ?? "";
  const state = path.trim() ? source.kind : "unbound";
  return (
    <div className={`binding-row-group binding-${state}`}>
      <label className="binding-row">
        <span>{props.property}</span>
        <input
          aria-label={`${props.property} data path`}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder="data.path"
          value={path}
        />
      </label>
      {state === "unbound" ? null : (
        <p className="binding-resolution" data-state={state}>
          {bindingRowReadout(source)}
        </p>
      )}
    </div>
  );
}

/**
 * What the row says under its input.
 *
 * Shorter than the field's sentence, because the path is already visible in the input beside it: the row
 * has to answer "did this find anything, and is it the right shape".
 */
function bindingRowReadout(source: PropertySource): string {
  switch (source.kind) {
    case "bound":
      return `Resolves to ${formatBoundValue(source.preview)} — preview only`;
    case "binding-missing":
      return `Not found in the scene data. ${formatBoundValue(source.preview)} is drawn instead.`;
    case "binding-type-mismatch":
      return `Found a ${source.found}; this property needs a ${source.expected}. ${formatBoundValue(source.preview)} is drawn instead.`;
    case "binding-unsupported":
      return source.reason ?? "Nothing assigns this property on this object.";
    default:
      // A bound row cannot be static or keyframed: `resolvePropertySource` only returns those when the
      // path is empty, and an empty path renders no readout.
      return "";
  }
}

function formatBoundValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  return String(value);
}

function Header(props: { id: string; title: string; subtitle: string }) {
  return (
    <div className="property-tab-header">
      <h2 id={props.id}>{props.title}</h2>
      <span>{props.subtitle}</span>
    </div>
  );
}

function EmptyState(props: { children: string }) {
  return (
    <div className="property-tab-panel">
      <div className="empty-panel">{props.children}</div>
    </div>
  );
}

