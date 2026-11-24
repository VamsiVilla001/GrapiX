// The panel registry (plan row 11.93): what each kind of panel is allowed to do.
//
// The dock model never asks "which panel is this?". It asks the registry what a panel type may do: whether
// it can be opened twice, closed, floated, how small it may be, where it goes when first opened, and which
// application and capability it belongs to. A panel that needs a feature the build does not have is
// *unavailable*: it is shown as a labelled placeholder, never dropped from a saved layout.

import type { AppKind } from "./dock-model";

export interface PanelDefinition {
  /** The stable name of the kind of panel, such as `object-manager`. Never its visible title. */
  readonly type: string;
  readonly title: string;
  readonly app: AppKind | "both";
  /** At most one open at a time in a workspace. Opening it again shows the one that is open. */
  readonly singleton: boolean;
  /** Where it goes when it is opened and has no earlier place: a tab group's id, and a tab position in it. */
  readonly defaultPlacement?: { readonly groupHint: string; readonly tabIndex?: number };
  /** The smallest it may be, in CSS pixels. */
  readonly minSize?: { readonly width: number; readonly height: number };
  readonly allowClose: boolean;
  readonly allowFloat: boolean;
  readonly allowMultiple: boolean;
  /** It can be pinned to one thing (an inspector kept on one object) while another instance follows the selection. */
  readonly supportsContextPin?: boolean;
  /** A feature of the build the panel needs. Without it the panel is unavailable, not removed. */
  readonly capability?: string;
}

export type RegistryRefusal = { readonly refused: string; readonly code: "PANEL_REGISTRATION_INVALID"; readonly type: string };

export function isRegistryRefused<T>(result: T | RegistryRefusal): result is RegistryRefusal {
  return typeof result === "object" && result !== null && "code" in result && (result as RegistryRefusal).code === "PANEL_REGISTRATION_INVALID";
}

export interface PanelRegistry {
  readonly definitions: readonly PanelDefinition[];
  get(type: string): PanelDefinition | undefined;
  has(type: string): boolean;
  /** The definitions this application can show, in registration order. */
  forApp(app: AppKind): PanelDefinition[];
}

export type Unavailable = { readonly instanceType: string; readonly reason: string };

function bad(type: string, reason: string): RegistryRefusal {
  return { code: "PANEL_REGISTRATION_INVALID", type, refused: `panel "${type}" cannot be registered: ${reason}` };
}

const TYPE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Build a registry, or refuse the first definition that cannot be one, with the reason. Registering the same
 *  type twice, a contradictory set of capabilities and an unusable size are all refused. */
export function createPanelRegistry(definitions: readonly PanelDefinition[]): PanelRegistry | RegistryRefusal {
  const seen = new Set<string>();
  for (const definition of definitions) {
    const { type } = definition;
    if (typeof type !== "string" || !TYPE_NAME.test(type)) return bad(String(type), "a type is lower-case words joined by hyphens, such as object-manager");
    if (seen.has(type)) return bad(type, "that type is already registered; give one of them another type name");
    seen.add(type);
    if (definition.title.trim() === "") return bad(type, "it has no title");
    if (definition.app !== "editor" && definition.app !== "playout" && definition.app !== "both") return bad(type, `its application "${String(definition.app)}" is not editor, playout or both`);
    if (definition.singleton && definition.allowMultiple) return bad(type, "a panel cannot be both a singleton and allow more than one");
    if (definition.supportsContextPin === true && !definition.allowMultiple) return bad(type, "a panel that can be pinned needs to allow more than one, so one can stay pinned while another follows");
    if (definition.minSize !== undefined) {
      const { width, height } = definition.minSize;
      if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return bad(type, "its smallest size must be a positive width and height");
    }
    if (definition.defaultPlacement !== undefined) {
      const { groupHint, tabIndex } = definition.defaultPlacement;
      if (groupHint.trim() === "") return bad(type, "its default placement names no group");
      if (tabIndex !== undefined && !(Number.isInteger(tabIndex) && tabIndex >= 0)) return bad(type, "its default tab position must be a whole number, zero or more");
    }
    if (definition.capability !== undefined && definition.capability.trim() === "") return bad(type, "its capability is blank");
  }
  const byType = new Map(definitions.map((definition) => [definition.type, definition]));
  return {
    definitions: [...definitions],
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    forApp: (app) => definitions.filter((definition) => definition.app === "both" || definition.app === app),
  };
}

/** Why a panel type cannot be shown here, or `undefined` when it can. A type the registry has never heard of
 *  (a saved layout from a newer build) is unavailable too. */
export function unavailableReason(
  registry: PanelRegistry,
  panelType: string,
  app: AppKind,
  capabilities: ReadonlySet<string>,
): string | undefined {
  const definition = registry.get(panelType);
  if (definition === undefined) return `this build does not know a panel called ${panelType}`;
  if (definition.app !== "both" && definition.app !== app) return `${definition.title} belongs to the ${definition.app} application`;
  if (definition.capability !== undefined && !capabilities.has(definition.capability)) {
    return `${definition.title} needs ${definition.capability}, which this build does not have`;
  }
  return undefined;
}
