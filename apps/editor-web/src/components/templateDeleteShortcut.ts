export interface TemplateDeleteShortcutState {
  key: string;
  hasSelection: boolean;
  targetInsideTemplatesPanel: boolean;
  targetIsEditable: boolean;
  defaultPrevented?: boolean;
}

export function shouldDeleteTemplateFromKeyboard(state: TemplateDeleteShortcutState): boolean {
  return state.key === "Delete"
    && state.hasSelection
    && state.targetInsideTemplatesPanel
    && !state.targetIsEditable
    && !state.defaultPrevented;
}
