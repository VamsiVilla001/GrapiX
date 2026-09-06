import { useMemo, useState } from "react";
import {
  PropertyInspectorContent,
  type PropertyInspectorTab
} from "../../../components/PropertiesSidebar";
import { useEditorStore } from "../../../store/editorStore";
import {
  multiSelectionTabs,
  multiSelectionTitle,
  objectInspectorTabsFor,
  objectInspectorTitle
} from "../services/objectInspectorTabs";
import { batchMaterialSurface } from "../services/multiSelection";
import { SelectionInspector } from "./SelectionInspector";
import { ObjectInspectorTabStrip } from "./ObjectInspectorTabStrip";

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
  // The whole set, not just the active member: reading only `selectedObjectId` is what made the panel
  // edit one object out of twelve while looking exactly as it does for one.
  const selectedObjectIds = useEditorStore((state) => state.selectedObjectIds);

  const selected = useMemo(
    () => scene?.objects.find((object) => object.id === selectedObjectId) ?? null,
    [scene, selectedObjectId]
  );
  /** Every selected object, in selection order, for the batch surface. */
  const selectedObjects = useMemo(
    () => selectedObjectIds
      .map((id) => scene?.objects.find((object) => object.id === id))
      .filter((object): object is NonNullable<typeof object> => Boolean(object)),
    [scene, selectedObjectIds]
  );
  const multi = selectedObjects.length > 1;
  const layout = multi
    ? multiSelectionTabs({ materials: batchMaterialSurface(selectedObjects) })
    : objectInspectorTabsFor(selected);

  // Held locally rather than in the shared ui store: the valid set changes with the selection,
  // so a tab remembered globally can be one this object does not have.
  const [requestedTab, setRequestedTab] = useState<string | null>(null);
  const activeTab =
    layout && requestedTab && layout.tabs.includes(requestedTab)
      ? requestedTab
      : layout?.tabs[0] ?? null;
  const headerId = "object-inspector-heading";

  if (!scene || !layout || !activeTab) {
    return (
      <section className="object-inspector" aria-label="Object Inspector">
        <header className="object-inspector-header">
          <span>{objectInspectorTitle(scene?.name ?? "no scene", null)}</span>
        </header>
        <div className="object-inspector-empty">Select an object to edit its properties.</div>
      </section>
    );
  }

  return (
    <section className="object-inspector" aria-labelledby={headerId}>
      <header className="object-inspector-header">
        <span id={headerId}>
          {multi
            ? multiSelectionTitle(scene.name, selectedObjects.length)
            : objectInspectorTitle(scene.name, selected)}
        </span>
      </header>
      <ObjectInspectorTabStrip
        activeTab={activeTab}
        label="Object Inspector sections"
        onSelect={setRequestedTab}
        tabs={layout.tabs}
      >
        {/*
          With a set selected, the leading tab is the batch surface rather than a type editor — a
          selection of twelve is not "a Quad" however many quads are in it. Transform and Materials
          still route to the shared editors, which read the selection for themselves.

          With one object, the leading tab is that object's kind and its content is the general property
          editor. Mapping it back to "Properties" keeps one implementation rather than a copy per type.
        */}
        {multi && activeTab === layout.typeTab ? (
          <SelectionInspector />
        ) : (
          <PropertyInspectorContent
            tab={(activeTab === layout.typeTab ? "Properties" : activeTab) as PropertyInspectorTab}
          />
        )}
      </ObjectInspectorTabStrip>
    </section>
  );
}
