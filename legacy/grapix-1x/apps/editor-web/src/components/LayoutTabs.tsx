const tabs = ["Layout 1", "Layout 2", "Layout 3", "Editor", "Material", "Animation", "Sequencer"];

export function LayoutTabs() {
  return (
    <div className="layout-tabs" role="tablist" aria-label="Layouts">
      {tabs.map((tab, index) => (
        <button className={`layout-tab ${index === 0 ? "active" : ""}`} key={tab} role="tab">
          {tab}
        </button>
      ))}
    </div>
  );
}
