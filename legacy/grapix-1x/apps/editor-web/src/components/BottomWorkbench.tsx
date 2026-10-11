import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { AssetMaterialPanel } from "./AssetMaterialPanel";
import { DataPanel } from "./DataPanel";
import { Inspector } from "./Inspector";
import { TimelinePanel } from "./TimelinePanel";

type WorkbenchTab = "properties" | "materials" | "data" | "timeline";

const tabs: Array<{ id: WorkbenchTab; label: string }> = [
  { id: "properties", label: "Properties" },
  { id: "materials", label: "Materials" },
  { id: "data", label: "Data Binding" },
  { id: "timeline", label: "Timeline" }
];

export function BottomWorkbench() {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("properties");
  const [open, setOpen] = useState(true);

  return (
    <section className={`bottom-workbench ${open ? "open" : "closed"}`}>
      <div className="workbench-tabs" role="tablist" aria-label="Bottom workbench">
        {tabs.map((tab) => (
          <button
            className={`workbench-tab ${activeTab === tab.id ? "active" : ""}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
          >
            {tab.label}
          </button>
        ))}
        <button className="workbench-collapse" onClick={() => setOpen((value) => !value)} title={open ? "Collapse workbench" : "Expand workbench"}>
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </div>
      {open ? (
        <div className="workbench-content">
          {activeTab === "properties" ? <Inspector /> : null}
          {activeTab === "materials" ? <AssetMaterialPanel /> : null}
          {activeTab === "data" ? <DataPanel /> : null}
          {activeTab === "timeline" ? <TimelinePanel /> : null}
        </div>
      ) : null}
    </section>
  );
}
