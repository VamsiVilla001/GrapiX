// The Editor's agent surface: one description of a panel that renders as DOM
// and reads as machine-readable state (build plan 11.5-11.17).
//
// **The rule this module exists to hold.** A panel is described once. The
// same node tree produces the accessible DOM a person uses and the snapshot an
// agent reads, so the two cannot disagree: a control a person can see is one an
// agent can find, and an action an agent is offered is one the panel actually
// performs. Two descriptions of one panel would drift the moment either side
// changed, which is the failure invariant 27 names — and here the drift would
// be an agent confidently operating a control that is no longer there.
//
// **Unavailable is never silent.** An action that cannot run right now carries
// the reason it cannot. A greyed control that does not say why is the interface
// form of the silent fallback the architecture forbids (invariant 18): the
// caller — human or model — is left to guess, and guessing is what puts the
// wrong graphic on air. `disabled` therefore takes a reason, not a boolean.
//
// **Assistive technology and agents want the same thing.** Both need to know
// what a thing is, what state it is in, and what can be done to it. Serving
// them from one description is why the ARIA here is structural rather than
// decorative: `aria-level` on a tree row is the same fact the agent snapshot
// reports as `level`, derived from the same node.

/// What a node is. A deliberately small set: these are the roles the Editor's
/// panels actually use, and an unrecognised role would render as a `div` with
/// no semantics, which is worse than refusing to add one here.
export type UiRole =
  | "treegrid"
  | "row"
  | "gridcell"
  | "group"
  | "list"
  | "listitem"
  | "region"
  | "toolbar"
  | "status"
  | "alert";

/// Why an action cannot run. Free text, shown to a person and returned to an
/// agent verbatim: both need the specific condition, not "unavailable".
export type Unavailable = string;

/// Something a panel can do, and whether it can do it now.
export interface UiAction {
  /// Stable across renders. An agent addresses an action by this name, so it
  /// is part of the contract rather than a label that may be reworded.
  readonly name: string;
  /// What a person reads.
  readonly label: string;
  /// `undefined` means available. A string is the named reason it is not.
  readonly unavailable?: Unavailable;
}

/// Tri-state for a value across a multi-selection.
///
/// `Mixed` is a real state, not an absence: two objects with different
/// opacities have a defined answer to "what is the opacity", and it is
/// "they differ". Rendering that as empty, or as the first object's value,
/// is how an edit silently flattens a property the author never touched
/// (11.9's done-when).
export type Mixed = { readonly mixed: true };
export const MIXED: Mixed = { mixed: true };

export type MaybeMixed<T> = T | Mixed;

export function isMixed<T>(value: MaybeMixed<T>): value is Mixed {
  return typeof value === "object" && value !== null && "mixed" in value;
}

/// Collapse a set of values into one, or report that they differ.
export function unify<T>(values: readonly T[]): MaybeMixed<T> | undefined {
  if (values.length === 0) return undefined;
  const [first, ...rest] = values;
  return rest.every((value) => Object.is(value, first)) ? first : MIXED;
}

/// One node of a panel.
export interface UiNode {
  /// Stable identity. An agent selects and acts by this, so it must survive a
  /// re-render of the same logical thing.
  readonly id: string;
  readonly role: UiRole;
  /// The accessible name. Required: a node nobody can name is a node nobody —
  /// person or model — can refer to.
  readonly label: string;
  /// Extra context announced after the label.
  readonly description?: string;
  /// Depth in a tree, 1-based, as `aria-level` defines it.
  readonly level?: number;
  readonly selected?: boolean;
  /// `undefined` for a node that does not expand.
  readonly expanded?: boolean;
  /// The value a cell carries, already formatted for display.
  readonly value?: string;
  /// An inline editor for the node's existing edit action.
  readonly input?: {
    readonly type: "text" | "number" | "checkbox";
    readonly value: string;
    readonly mixed?: boolean;
  };
  readonly image?: { readonly src: string; readonly alt: string };
  readonly actions?: readonly UiAction[];
  readonly children?: readonly UiNode[];
}

// ---------------------------------------------------------------------------
// The agent projection
// ---------------------------------------------------------------------------

/// One node as an agent reads it.
export interface AgentNode {
  readonly id: string;
  readonly role: UiRole;
  readonly label: string;
  readonly description?: string;
  readonly level?: number;
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly value?: string;
  readonly actions: readonly AgentAction[];
  readonly children: readonly AgentNode[];
}

export interface AgentAction {
  readonly name: string;
  readonly label: string;
  readonly available: boolean;
  /// Present exactly when `available` is false.
  readonly unavailableReason?: string;
}

/// Project a panel into the shape an agent reads.
///
/// Derived from the node tree rather than from the DOM: reading the DOM back
/// would make the snapshot depend on rendering having happened and on the
/// browser's interpretation of it, and a panel that has not been drawn yet is
/// still a panel an agent may ask about.
export function agentView(node: UiNode): AgentNode {
  return {
    id: node.id,
    role: node.role,
    label: node.label,
    ...(node.description === undefined ? {} : { description: node.description }),
    ...(node.level === undefined ? {} : { level: node.level }),
    ...(node.selected === undefined ? {} : { selected: node.selected }),
    ...(node.expanded === undefined ? {} : { expanded: node.expanded }),
    ...(node.value === undefined ? {} : { value: node.value }),
    actions: (node.actions ?? []).map(projectAction),
    children: (node.children ?? []).map(agentView),
  };
}

function projectAction(action: UiAction): AgentAction {
  return action.unavailable === undefined
    ? { name: action.name, label: action.label, available: true }
    : {
        name: action.name,
        label: action.label,
        available: false,
        unavailableReason: action.unavailable,
      };
}

/// Find a node by id, depth-first.
///
/// The addressing primitive an agent needs: it reads a snapshot, picks an id,
/// and acts on it. Returning `undefined` rather than throwing lets the caller
/// report "that node is gone" as the named condition it is.
export function findNode(root: UiNode, id: string): UiNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

/// Resolve an action by name on a node, saying why if it cannot run.
///
/// Every failure is named: no such node, no such action, or the action's own
/// reason. A caller that got `false` with no explanation would have to guess
/// which of the three happened.
export type ActionOutcome =
  | { readonly ok: true; readonly action: UiAction }
  | { readonly ok: false; readonly reason: string };

export function resolveAction(root: UiNode, nodeId: string, actionName: string): ActionOutcome {
  const node = findNode(root, nodeId);
  if (!node) {
    return { ok: false, reason: `no node ${nodeId} in this panel` };
  }
  const action = (node.actions ?? []).find((candidate) => candidate.name === actionName);
  if (!action) {
    const offered = (node.actions ?? []).map((candidate) => candidate.name).join(", ");
    return {
      ok: false,
      reason: `${nodeId} has no action ${actionName}${offered ? `; it offers ${offered}` : ""}`,
    };
  }
  if (action.unavailable !== undefined) {
    return { ok: false, reason: action.unavailable };
  }
  return { ok: true, action };
}

// ---------------------------------------------------------------------------
// The DOM projection
// ---------------------------------------------------------------------------

/// The subset of the DOM this module needs.
///
/// Declared structurally so the renderer can be exercised without a browser:
/// the mapping from node to ARIA is the part that has to be right, and tying
/// it to a real `Document` would make it untestable headlessly for no gain.
export interface ElementLike {
  setAttribute(name: string, value: string): void;
  appendChild(child: ElementLike): void;
  textContent: string | null;
}

export interface DocumentLike {
  createElement(tag: string): ElementLike;
}

/// The HTML element each role is rendered as.
const TAG_FOR_ROLE: Record<UiRole, string> = {
  treegrid: "div",
  row: "div",
  gridcell: "div",
  group: "div",
  list: "ul",
  listitem: "li",
  region: "section",
  toolbar: "div",
  status: "div",
  alert: "div",
};

/// Render a node tree into DOM carrying the ARIA the same tree reports.
///
/// The attributes are not decoration. `aria-level`, `aria-selected` and
/// `aria-expanded` are the facts a screen reader announces and the facts
/// [`agentView`] reports, written from one source so they cannot diverge.
export function renderNode(document: DocumentLike, node: UiNode): ElementLike {
  const element = document.createElement(TAG_FOR_ROLE[node.role]);
  element.setAttribute("role", node.role);
  element.setAttribute("id", node.id);
  element.setAttribute("aria-label", node.label);
  if (node.description !== undefined) {
    element.setAttribute("aria-description", node.description);
  }
  if (node.level !== undefined) {
    element.setAttribute("aria-level", String(node.level));
  }
  if (node.selected !== undefined) {
    element.setAttribute("aria-selected", String(node.selected));
  }
  if (node.expanded !== undefined) {
    element.setAttribute("aria-expanded", String(node.expanded));
  }
  if (node.value !== undefined && node.input === undefined) {
    element.textContent = node.value;
  }
  if (node.image !== undefined) {
    const image = document.createElement("img");
    image.setAttribute("src", node.image.src);
    image.setAttribute("alt", node.image.alt);
    image.setAttribute("title", node.image.alt);
    image.setAttribute("class", "graphic-thumbnail");
    element.appendChild(image);
  }
  // A live region announces its own changes. Status is polite; an alert
  // interrupts, which is why only genuinely blocking conditions use it.
  if (node.role === "status") {
    element.setAttribute("aria-live", "polite");
  }
  if (node.role === "alert") {
    element.setAttribute("aria-live", "assertive");
  }

  for (const action of node.actions ?? []) {
    if (action.name === "edit" && node.input !== undefined) {
      const input = document.createElement("input");
      input.setAttribute("type", node.input.type);
      input.setAttribute("class", "property-value");
      input.setAttribute("aria-label", node.label);
      // Which node the input edits, as a button's `data-for` says.
      input.setAttribute("data-for", node.id);
      if (node.id.startsWith("inspector/")) {
        input.setAttribute("data-inspector-field", node.id.slice("inspector/".length));
      }
      input.setAttribute("value", node.input.value);
      input.setAttribute("step", "any");
      if (node.input.mixed) input.setAttribute("placeholder", "Mixed");
      if (node.input.type === "checkbox" && node.input.value === "true") input.setAttribute("checked", "");
      if (action.unavailable !== undefined) {
        input.setAttribute("disabled", "");
        input.setAttribute("title", action.unavailable);
      }
      element.appendChild(input);
      continue;
    }
    const button = document.createElement("button");
    button.setAttribute("type", "button");
    button.setAttribute("data-action", action.name);
    button.setAttribute("data-for", node.id);
    button.textContent = action.label;
    if (action.unavailable !== undefined) {
      button.setAttribute("disabled", "");
      // The reason travels with the control. A disabled button that does not
      // say why is the interface's version of a silent refusal.
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("title", action.unavailable);
      button.setAttribute("data-unavailable", action.unavailable);
    }
    element.appendChild(button);
  }

  for (const child of node.children ?? []) {
    element.appendChild(renderNode(document, child));
  }
  return element;
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

/// The rows of a tree, in the order arrow keys walk them.
///
/// Collapsed rows hide their descendants from navigation exactly as they hide
/// them from view: a keyboard user and a screen reader must traverse what is
/// actually shown, not the underlying model.
export function visibleRows(root: UiNode): UiNode[] {
  const rows: UiNode[] = [];
  const walk = (node: UiNode): void => {
    for (const child of node.children ?? []) {
      if (child.role === "row") {
        rows.push(child);
        if (child.expanded !== false) walk(child);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return rows;
}

export type NavKey = "ArrowUp" | "ArrowDown" | "Home" | "End";

/// Where the focus moves. Returns the current row when the move is not
/// possible, so focus never lands on nothing.
export function moveFocus(root: UiNode, currentId: string, key: NavKey): string {
  const rows = visibleRows(root);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return currentId;

  const index = rows.findIndex((row) => row.id === currentId);
  switch (key) {
    case "Home":
      return first.id;
    case "End":
      return last.id;
    case "ArrowUp":
      return (index > 0 ? rows[index - 1]! : first).id;
    case "ArrowDown":
      return (index >= 0 && index < rows.length - 1 ? rows[index + 1] : last)!.id;
  }
}
