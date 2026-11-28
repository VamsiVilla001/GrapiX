// The pages of the Settings window's left nav (plan row 11.81, Figma E4).
//
// A page is either live (it has content the Editor really has) or waiting: a waiting page is listed, dimmed, and says what it waits for
// and which plan row builds it, so the nav never promises a page that does nothing. The Figma nav also lists Colour and output and Help
// and diagnostics, and the spec lists nine more sections; none of them has content yet and no row owns them, so none is drawn (the owner
// decides which become rows). The roles of the AI page are not in the contracts (the UI session's screen map, C-17): what a token may
// do is the closed list of authorities in `Shared/contracts/src/auth.rs`, and the tiers an MCP client reaches are row 8.14.

export type SettingsPageId = "general" | "shortcuts" | "ai";

export interface SettingsPage {
  readonly id: SettingsPageId;
  readonly label: string;
  /** The page has content the Editor really has. */
  readonly live: boolean;
  /** For a waiting page: what it waits for, in words. */
  readonly waitsFor?: string;
  /** For a waiting page: the plan rows that build it. */
  readonly rows?: readonly string[];
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "general", label: "General", live: true },
  { id: "shortcuts", label: "Shortcuts", live: true },
  {
    id: "ai",
    label: "AI and MCP access",
    live: false,
    waitsFor:
      "Access is by role and credential, never by the name of the AI provider, and no role can cue, take out, clear or change what is on air: only Playout does that. The roles an AI client can hold are not decided yet (the Figma screen names Reader, Designer assistant and Reviewer; the contracts have no such roles), and creating a token and reading the audit log have no commands to call.",
    rows: ["8.14"],
  },
];

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "general";

/** The page with this id, or undefined for an id that is not a page. */
export function settingsPage(id: string): SettingsPage | undefined {
  return SETTINGS_PAGES.find((page) => page.id === id);
}

/** The page to show for a request: the one asked for if it is a page, otherwise the first (General). */
export function resolvePage(id: string | undefined): SettingsPage {
  return (id === undefined ? undefined : settingsPage(id)) ?? SETTINGS_PAGES[0]!;
}

/** The line a waiting page's nav entry carries as its tooltip: what it waits for, and the rows. */
export function waitingLine(page: SettingsPage): string {
  if (page.live) return "";
  const rows = page.rows === undefined || page.rows.length === 0 ? "" : ` (row ${page.rows.join(", ")})`;
  return `Not built yet${rows}.`;
}
