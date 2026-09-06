import { useId, type KeyboardEvent, type ReactNode } from "react";
import { objectInspectorTabIndex } from "../services/objectInspectorTabs";

interface ObjectInspectorTabStripProps {
  activeTab: string;
  children: ReactNode;
  label: string;
  onSelect: (tab: string) => void;
  tabs: readonly string[];
}

/**
 * The Object Inspector's ARIA tab contract.
 *
 * Exactly one tab participates in native Tab order. Arrow keys, Home and End select and focus within
 * the strip; every other key remains native so fields keep ownership of drafts and Tab order.
 */
export function ObjectInspectorTabStrip(props: ObjectInspectorTabStripProps) {
  const instanceId = useId();
  const tabId = (tab: string) => `${instanceId}-tab-${domToken(tab)}`;
  const panelId = (tab: string) => `${instanceId}-panel-${domToken(tab)}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = objectInspectorTabIndex(index, props.tabs.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = props.tabs[nextIndex];
    props.onSelect(nextTab);
    document.getElementById(tabId(nextTab))?.focus();
  };

  return (
    <>
      <div
        aria-label={props.label}
        aria-orientation="horizontal"
        className="properties-tabs"
        role="tablist"
      >
        {props.tabs.map((tab, index) => (
          <button
            aria-controls={panelId(tab)}
            aria-selected={props.activeTab === tab}
            className={`properties-tab ${props.activeTab === tab ? "active" : ""}`}
            id={tabId(tab)}
            key={tab}
            onClick={() => props.onSelect(tab)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            role="tab"
            tabIndex={props.activeTab === tab ? 0 : -1}
            title={tab}
            type="button"
          >
            {tab === "Data Binding" ? "Data" : tab}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={tabId(props.activeTab)}
        className="properties-tab-body"
        id={panelId(props.activeTab)}
        role="tabpanel"
      >
        {props.children}
      </div>
    </>
  );
}

function domToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
