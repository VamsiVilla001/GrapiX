import type { AssetLibraryItem } from "@grapix/shared-types";
import { FileUp, Link2, Trash2, Type } from "lucide-react";
import { useRef, useState } from "react";
import { importFontFileToApi, linkFontOnApi } from "../lib/apiClient";
import { useEditorStore } from "../store/editorStore";

export function FontManagerPanel() {
  const scene = useEditorStore((state) => state.scene);
  const selectedObjectId = useEditorStore((state) => state.selectedObjectId);
  const addFontDefinition = useEditorStore((state) => state.addFontDefinition);
  const removeFontDefinition = useEditorStore((state) => state.removeFontDefinition);
  const assignFontToSelectedText = useEditorStore((state) => state.assignFontToSelectedText);
  const inputRef = useRef<HTMLInputElement>(null);
  const [family, setFamily] = useState("Inter");
  const [weight, setWeight] = useState(400);
  const [source, setSource] = useState<"css-url" | "adobe-fonts">("css-url");
  const [url, setUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [message, setMessage] = useState("");
  const selected = scene.objects.find((object) => object.id === selectedObjectId);

  async function importFile(file: File) {
    try {
      setMessage("Importing…");
      const result = await importFontFileToApi(file, { family, weight });
      addFontDefinition(result.font, importedFontAsset(result.asset));
      setMessage(`${result.font.displayName} packaged and ready.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Font import failed");
    }
  }

  async function addLink() {
    try {
      const font = await linkFontOnApi({
        source,
        family,
        weight,
        url: source === "css-url" ? url : undefined,
        projectId: source === "adobe-fonts" ? projectId : undefined
      });
      addFontDefinition(font);
      setMessage(`${font.displayName} linked; package remains network-dependent.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Font link failed");
    }
  }

  return (
    <section className="font-manager-panel">
      <div className="automation-toolbar">
        <input value={family} onChange={(event) => setFamily(event.target.value)} placeholder="Font family" />
        <input
          min={1}
          max={1000}
          type="number"
          value={weight}
          onChange={(event) => setWeight(Number(event.target.value))}
          title="Font weight"
        />
      </div>
      <div className="automation-toolbar">
        <button onClick={() => inputRef.current?.click()}><FileUp size={13} /> OTF/TTF/WOFF</button>
        <input
          accept=".otf,.ttf,.woff,.woff2"
          hidden
          ref={inputRef}
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = "";
          }}
        />
        <select value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
          <option value="css-url">CSS link</option>
          <option value="adobe-fonts">Adobe Fonts</option>
        </select>
      </div>
      <div className="automation-toolbar">
        {source === "css-url" ? (
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://fonts.googleapis.com/css2?…" />
        ) : (
          <input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="Adobe project ID" />
        )}
        <button onClick={() => void addLink()}><Link2 size={13} /> Link</button>
      </div>

      <div className="manager-list">
        {(scene.fonts ?? []).map((font) => (
          <article className="manager-list-item" key={font.fontId}>
            <div className="font-preview" style={{ fontFamily: `"${font.family}"` }}>Ag 0123</div>
            <div>
              <strong>{font.displayName}</strong>
              <span>{font.faces.map((face) => `${face.weight} ${face.source.kind}`).join(", ")}</span>
            </div>
            <button
              disabled={selected?.type !== "text"}
              onClick={() => assignFontToSelectedText(font.fontId)}
              title="Assign to selected text"
            >
              <Type size={13} />
            </button>
            <button onClick={() => removeFontDefinition(font.fontId)} title="Remove font definition">
              <Trash2 size={13} />
            </button>
          </article>
        ))}
        {(scene.fonts?.length ?? 0) === 0 ? <div className="empty-panel">No scene fonts</div> : null}
      </div>
      {message ? <p className="manager-message">{message}</p> : null}
      <p className="manager-note">
        File faces are checksummed into .gfxpkg. CSS and Adobe links stay explicit network dependencies and receive a preflight warning.
      </p>
    </section>
  );
}

function importedFontAsset(asset: {
  assetId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  importedAt: string;
  contentUrl: string;
}): AssetLibraryItem {
  return {
    assetId: asset.assetId,
    storageAssetId: asset.assetId,
    name: asset.fileName,
    kind: "font",
    source: asset.contentUrl,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    checksum: asset.checksum,
    importedAt: asset.importedAt,
    status: "READY"
  };
}
