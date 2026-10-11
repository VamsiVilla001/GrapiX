import { Database, RefreshCcw } from "lucide-react";
import { useEditorStore } from "../store/editorStore";

export function DataPanel() {
  const dataJson = useEditorStore((state) => state.dataJson);
  const dataError = useEditorStore((state) => state.dataError);
  const setDataJson = useEditorStore((state) => state.setDataJson);
  const applyDataJson = useEditorStore((state) => state.applyDataJson);

  return (
    <section className="data-panel">
      <div className="panel-heading">
        <h2>
          <Database size={17} aria-hidden="true" />
          Live Data
        </h2>
        <button className="compact-button" onClick={applyDataJson}>
          <RefreshCcw size={15} aria-hidden="true" />
          Apply
        </button>
      </div>
      <textarea
        spellCheck={false}
        value={dataJson}
        onChange={(event) => setDataJson(event.target.value)}
        aria-label="Live data JSON"
      />
      {dataError ? <div className="error-text">{dataError}</div> : null}
    </section>
  );
}
