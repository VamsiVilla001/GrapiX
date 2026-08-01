import { useMemo, useState } from "react";
import {
  PropertyInspectorContent,
  type PropertyInspectorTab
} from "../../../components/PropertiesSidebar";
import { useEditorStore } from "../../../store/editorStore";
import {
  objectInspectorTabsFor,
  objectInspectorTitle
} from "../services/objectInspectorTabs";

/**
 * Properties of the selected object, tabbed by what the object actually is.
 *
 * Split out of the object tree, which had grown both jobs: the tree listed objects *and* carried
 * the property tabs, so the panel was two products in one dock. XPression keeps them apart —
 * Object Manager lists, Object Inspector edits — and so does this.
 *
 * The tab strip is per-type (see `objectInspectorTabs`), so a mesh no longer offers a Text tab
 * and a camera no longer offers Materials. The leading tab is named after the object's kind, the
 * way the reference product does it, which makes the strip itself say what is selected.
 */
export function ObjectInspector() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);

  const selected = useMemo(
    () => scene?.objects.find((object) => object.id === selectedObjectId) ?? null,
    [scene, selectedObjectId]
  );
  const layout = objectInspectorTabsFor(selected);

  // Held locally rather than in the shared ui store: the valid set changes with the selection,
  // so a tab remembered globally can be one this object does not have.
  const [requestedTab, setRequestedTab] = useState<string | null>(null);
  const activeTab =
    layout && requestedTab && layout.tabs.includes(requestedTab)
      ? requestedTab
      : layout?.tabs[0] ?? null;

  if (!scene || !layout || !activeTab) {
    return (
      <section className="object-inspector">
        <header className="object-inspector-header">
          <span>{objectInspectorTitle(scene?.name ?? "no scene", null)}</span>
        </header>
        <div className="object-inspector-empty">Select an object to edit its properties.</div>
      </section>
    );
  }

  return (
    <section className="object-inspector">
      <header className="object-inspector-header">
        <span>{objectInspectorTitle(scene.name, selected)}</span>
      </header>
      <div className="properties-tabs">
        {layout.tabs.map((tab) => (
          <button
            className={`properties-tab ${activeTab === tab ? "active" : ""}`}
            key={tab}
            onClick={() => setRequestedTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="properties-tab-body">
        {/*
          The leading tab is the object's own kind, and its content is the general property
          editor. Mapping it back to "Properties" keeps one implementation of that editor rather
          than a second copy per type.
        */}
        <PropertyInspectorContent
          tab={(activeTab === layout.typeTab ? "Properties" : activeTab) as PropertyInspectorTab}
        />
      </div>
    </section>
  );
}
