import type { SceneObject } from "@grapix/shared-types";

/**
 * Which Object Inspector tabs apply to which kind of object.
 *
 * The inspector used to show a fixed strip — Properties, Materials, Text, Data Binding — for
 * everything selected. A mesh offered a Text tab, a camera offered Materials, and a marker
 * offered both. Every one of those is a dead end an operator has to learn to ignore.
 *
 * This cannot be derived from the contract: `materialSlots` and `bindings` live on
 * `BaseSceneObject`, so *every* type carries them and field presence would put Materials on a
 * camera. Applicability is an editorial judgement about what the object is for, so it is
 * declared here, per type, and read rather than inferred.
 *
 * Adding an object type means adding a row. That is deliberate — the compiler demands the row
 * because the map is exhaustive over `SceneObject["type"]`, so a new type cannot quietly
 * inherit a default set of tabs that makes no sense for it.
 */

/** Tabs after the leading type tab. The type tab is always present and always first. */
export const OPTIONAL_OBJECT_INSPECTOR_TABS = ["Transform", "Materials", "Text", "Data Binding"] as const;
export type OptionalObjectInspectorTab = (typeof OPTIONAL_OBJECT_INSPECTOR_TABS)[number];

interface TypeDescriptor {
  /**
   * Name of the leading tab, which is the object's own kind.
   *
   * XPression names it after the type — "Quad", "Text", "Sphere" — so the tab strip itself tells
   * the operator what is selected. `rect` is presented as Quad because that is the name in the
   * Object Library and on the object's own inspector in the reference product.
   */
  typeTab: string;
  optional: readonly OptionalObjectInspectorTab[];
}

const DESCRIPTORS: Record<SceneObject["type"], TypeDescriptor> = {
  // A text object's leading tab is already called Text and already carries the full type editor,
  // so listing "Text" again produced two tabs with the same name. React saw duplicate keys, and
  // clicking either one selected the same tab — the dedicated panel was unreachable. The type tab
  // is the text editor; nothing is lost by naming it once.
  text: { typeTab: "Text", optional: ["Transform", "Materials", "Data Binding"] },

  // Surfaces that take a material and can be driven by data.
  rect: { typeTab: "Quad", optional: ["Transform", "Materials", "Data Binding"] },
  ellipse: { typeTab: "Ellipse", optional: ["Transform", "Materials", "Data Binding"] },
  image: { typeTab: "Image", optional: ["Transform", "Materials", "Data Binding"] },
  shape: { typeTab: "Shape", optional: ["Transform", "Materials", "Data Binding"] },
  paint: { typeTab: "Paint", optional: ["Transform", "Materials", "Data Binding"] },
  mesh: { typeTab: "Mesh", optional: ["Transform", "Materials", "Data Binding"] },

  // A stroke, not a surface: it has no material faces to bind, but its geometry and colour are
  // legitimately data-driven.
  line: { typeTab: "Line", optional: ["Transform", "Data Binding"] },

  // Scene furniture has no material surface, but its placement still needs a precise numeric
  // editor independent of its type-specific camera/light controls.
  light: { typeTab: "Light", optional: ["Transform"] },
  camera: { typeTab: "Camera", optional: ["Transform"] },

  // Containers inherit transform state into their descendants. Markers are timeline metadata
  // and have no painted or spatial controls of their own.
  layer: { typeTab: "Layer", optional: ["Transform"] },
  group: { typeTab: "Group", optional: ["Transform"] },
  marker: { typeTab: "Marker", optional: [] }
};

export interface ObjectInspectorTabs {
  /** Every tab to show, in order, with the type tab first. */
  tabs: string[];
  /** The leading tab's name, so the caller can tell it apart from the shared ones. */
  typeTab: string;
}

/**
 * Tabs for the current selection.
 *
 * With nothing selected there is nothing type-specific to show, so the caller renders its empty
 * state rather than a strip of tabs that all say "select an object".
 */
export function objectInspectorTabsFor(object: SceneObject | null): ObjectInspectorTabs | null {
  if (!object) return null;
  const descriptor = DESCRIPTORS[object.type];
  if (!descriptor) return null;
  return {
    typeTab: descriptor.typeTab,
    // Names are the identity of a tab — they key the strip and they are what the caller matches a
    // remembered selection against. A repeat is therefore not a cosmetic duplicate but a tab that
    // cannot be selected, so it is removed here rather than left to each caller to notice.
    tabs: [descriptor.typeTab, ...descriptor.optional].filter(
      (tab, index, all) => all.indexOf(tab) === index
    )
  };
}

/** The contextual panel title, matching XPression's "Object Inspector - <scene> - Quad Object". */
export function objectInspectorTitle(sceneName: string, object: SceneObject | null): string {
  const descriptor = object ? DESCRIPTORS[object.type] : null;
  if (!descriptor) return `Object Inspector - ${sceneName}`;
  return `Object Inspector - ${sceneName} - ${descriptor.typeTab} Object`;
}
