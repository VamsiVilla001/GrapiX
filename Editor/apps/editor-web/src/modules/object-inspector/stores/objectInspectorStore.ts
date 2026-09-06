import { create } from "zustand";

export type ObjectInspectorDisclosureId = "imported-design" | "masks";

interface ObjectInspectorState {
  /** Advanced sections collapsed for this application session. Never persisted. */
  collapsedDisclosures: ObjectInspectorDisclosureId[];
  toggleDisclosure: (id: ObjectInspectorDisclosureId) => void;
  setDisclosureExpanded: (id: ObjectInspectorDisclosureId, expanded: boolean) => void;
}

/**
 * Object Inspector state whose lifetime is the running application.
 *
 * A dock move unmounts and remounts the panel, so component state loses the author's disclosure
 * choices. Local storage would retain them after a reload and across unrelated scenes. This store
 * deliberately does neither: it survives component remounts and dies with the session.
 */
export const useObjectInspectorStore = create<ObjectInspectorState>((set) => ({
  collapsedDisclosures: [],
  toggleDisclosure: (id) => set((state) => ({
    collapsedDisclosures: state.collapsedDisclosures.includes(id)
      ? state.collapsedDisclosures.filter((entry) => entry !== id)
      : [...state.collapsedDisclosures, id]
  })),
  setDisclosureExpanded: (id, expanded) => set((state) => {
    const collapsed = state.collapsedDisclosures.includes(id);
    if (expanded === !collapsed) return state;
    return {
      collapsedDisclosures: expanded
        ? state.collapsedDisclosures.filter((entry) => entry !== id)
        : [...state.collapsedDisclosures, id]
    };
  })
}));
