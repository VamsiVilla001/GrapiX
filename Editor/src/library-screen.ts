// The Library as its own screen (visibility decision of 26 Nov 2026, Figma B13). One strip of tabs over one full-size body: the
// screen shows the panel each tab names, brought out of its dock for as long as the screen is open and put back where it stood
// when it closes. Nothing is rebuilt: the panels, their state and every control in them are the same ones the docks hold.
//
// Assets, Colours and Layer styles are the one Assets panel under three of its own tabs (`libraryTab`); the other four tabs are
// the panels the library has always had (Text styles, Fonts, Effects & Presets, Materials).

export type LibraryScreenTab = "assets" | "colours" | "layer-styles" | "text-styles" | "fonts" | "effects" | "materials";

export interface ScreenTab {
  readonly id: LibraryScreenTab;
  readonly label: string;
  /** The dock panel the tab shows. */
  readonly panel: "assets" | "text-styles" | "fonts" | "effects" | "materials";
  /** The Assets panel's own tab, for the three tabs that are one panel. */
  readonly libraryTab?: "assets" | "colours" | "layer-styles";
}

export const SCREEN_TABS: readonly ScreenTab[] = [
  { id: "assets", label: "Assets", panel: "assets", libraryTab: "assets" },
  { id: "colours", label: "Colours", panel: "assets", libraryTab: "colours" },
  { id: "layer-styles", label: "Layer styles", panel: "assets", libraryTab: "layer-styles" },
  { id: "text-styles", label: "Text styles", panel: "text-styles" },
  { id: "fonts", label: "Fonts", panel: "fonts" },
  { id: "effects", label: "Effects & Presets", panel: "effects" },
  { id: "materials", label: "Materials", panel: "materials" },
];

/** The tab with this id, or the first (Assets) for anything else. */
export function screenTab(id: string | undefined): ScreenTab {
  return SCREEN_TABS.find((tab) => tab.id === id) ?? SCREEN_TABS[0]!;
}

/** The screen tab a dock panel belongs to, for opening the screen where the person already was. Undefined for a panel the library does not hold. */
export function tabForPanel(panel: string, libraryTab: string): LibraryScreenTab | undefined {
  if (panel === "assets") return screenTab(libraryTab).panel === "assets" && SCREEN_TABS.some((tab) => tab.id === libraryTab) ? (libraryTab as LibraryScreenTab) : "assets";
  return SCREEN_TABS.find((tab) => tab.panel === panel)?.id;
}

// --- The Data screen -------------------------------------------------------------------------------------------------------------
// The same kind of screen for what a graphic does with data (visibility decision of 26 Nov 2026, Figma B4: the Properties Data block and
// the Data screen): the take page, the template controls an operator may drive, the data the graphic reads, and the publish checks.

export type DataScreenTab = "take-page" | "control-contract" | "bindings" | "publish";

export interface DataTab {
  readonly id: DataScreenTab;
  readonly label: string;
  /** The dock panel the tab shows. */
  readonly panel: DataScreenTab;
}

export const DATA_TABS: readonly DataTab[] = [
  { id: "bindings", label: "Data", panel: "bindings" },
  { id: "control-contract", label: "Template controls", panel: "control-contract" },
  { id: "take-page", label: "Take page", panel: "take-page" },
  { id: "publish", label: "Publish", panel: "publish" },
];

/** The Data screen's tab with this id, or the first (Data) for anything else. */
export function dataTab(id: string | undefined): DataTab {
  return DATA_TABS.find((tab) => tab.id === id) ?? DATA_TABS[0]!;
}
