import {
  Box,
  Camera,
  Circle,
  Cone,
  Cuboid,
  Cylinder,
  Diamond,
  Disc3,
  Eclipse,
  Focus,
  Group,
  Layers,
  Lightbulb,
  LocateFixed,
  Minus,
  MousePointer2,
  Orbit,
  PanelTop,
  PenTool,
  Square,
  Sun,
  Type
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { type LibraryObjectKind, useEditorStore } from "../store/editorStore";
import { CollapsiblePanel, CollapsibleSection } from "./Collapsible";

interface LibraryItem {
  kind: LibraryObjectKind;
  label: string;
  icon: ReactNode;
  description: string;
}

const librarySections: Array<{ title: string; items: LibraryItem[] }> = [
  {
    title: "Base Objects",
    items: [
      { kind: "text", label: "Text", icon: <Type size={16} />, description: "Editable GPU text object" },
      { kind: "background", label: "Background", icon: <PanelTop size={16} />, description: "Full-frame background plate" }
    ]
  },
  {
    title: "Mesh Objects",
    items: [
      { kind: "model", label: "Import 3D Model", icon: <Box size={16} />, description: "Import a real GLB or embedded glTF 2.0 model" }
    ]
  },
  {
    title: "Primitives",
    items: [
      { kind: "quad", label: "Quad", icon: <Square size={16} />, description: "Flat rectangular primitive" },
      { kind: "sphere", label: "Sphere", icon: <Circle size={16} />, description: "True 3D sphere primitive" },
      { kind: "cube", label: "Cube", icon: <Cuboid size={16} />, description: "GPU cube-style primitive" },
      { kind: "cylinder", label: "Cylinder", icon: <Cylinder size={16} />, description: "GPU cylinder primitive" },
      { kind: "torus", label: "Torus", icon: <Orbit size={16} />, description: "GPU torus primitive" },
      { kind: "slab", label: "Slab", icon: <Diamond size={16} />, description: "Extruded slab primitive" },
      { kind: "line", label: "Lines", icon: <Minus size={16} />, description: "Editable line strip" },
      { kind: "shape", label: "Shape", icon: <PenTool size={16} />, description: "Bezier shape (pen tool)" }
    ]
  },
  {
    title: "Lights",
    items: [
      { kind: "directional-light", label: "Directional Light", icon: <Sun size={16} />, description: "Directional lighting control" },
      { kind: "point-light", label: "Point Light", icon: <Lightbulb size={16} />, description: "Point lighting control" },
      { kind: "spot-light", label: "Spot Light", icon: <Cone size={16} />, description: "Spot lighting control" }
    ]
  },
  {
    title: "Cameras",
    items: [
      { kind: "perspective-camera", label: "Persp. Camera", icon: <Camera size={16} />, description: "Perspective camera object" },
      { kind: "orthographic-camera", label: "Ortho. Camera", icon: <Focus size={16} />, description: "Orthographic camera object" }
    ]
  },
  {
    title: "Layers",
    items: [
      { kind: "layer-object", label: "Layer Object", icon: <Layers size={16} />, description: "Layer container object" },
      { kind: "camera-layer", label: "Camera Layer", icon: <LocateFixed size={16} />, description: "Camera-bound layer" }
    ]
  },
  {
    title: "Markers",
    items: [
      { kind: "event-marker", label: "Event Marker", icon: <Eclipse size={16} />, description: "Timeline event marker" }
    ]
  },
  {
    title: "Misc",
    items: [
      { kind: "group", label: "Group", icon: <Group size={16} />, description: "Object grouping container" }
    ]
  }
];

export function ObjectLibrary() {
  const addLibraryObject = useEditorStore((state) => state.addLibraryObject);
  const addModelObjectFromAsset = useEditorStore((state) => state.addModelObjectFromAsset);
  const importAsset = useEditorStore((state) => state.importAsset);
  const hasActiveScene = useEditorStore((state) => state.hasActiveScene);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredSections = useMemo(
    () =>
      librarySections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) =>
            `${section.title} ${item.label} ${item.description}`.toLowerCase().includes(normalizedSearch)
          )
        }))
        .filter((section) => section.items.length > 0),
    [normalizedSearch]
  );

  return (
    <CollapsiblePanel title="Object Library" className="dock-panel object-library" defaultOpen>
      <input
        hidden
        ref={modelInputRef}
        type="file"
        accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) {
            const assetId = await importAsset(file);
            if (assetId) addModelObjectFromAsset(assetId);
          }
          event.target.value = "";
        }}
      />
      <label className="object-library-search">
        <MousePointer2 size={14} />
        <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search objects" />
      </label>
      {!hasActiveScene ? (
        <div className="empty-panel compact object-library-disabled">
          Open a scene before adding objects.
        </div>
      ) : null}
      <div className="object-library-sections">
        {filteredSections.length === 0 ? <div className="empty-panel compact">No objects found</div> : null}
        {filteredSections.map((section) => (
          <ObjectSection title={section.title} key={section.title}>
            {section.items.map((item) => (
              <ObjectButton
                description={item.description}
                icon={item.icon}
                key={item.kind}
                label={item.label}
                disabled={!hasActiveScene}
                onClick={() => item.kind === "model"
                  ? modelInputRef.current?.click()
                  : addLibraryObject(item.kind)}
              />
            ))}
          </ObjectSection>
        ))}
      </div>
    </CollapsiblePanel>
  );
}

function ObjectSection(props: { title: string; children: ReactNode }) {
  return (
    <CollapsibleSection title={props.title}>
      <div className="object-library-list">{props.children}</div>
    </CollapsibleSection>
  );
}

function ObjectButton(props: { icon: ReactNode; label: string; description: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="object-library-button" disabled={props.disabled} onClick={props.onClick} title={props.description}>
      <span className="object-library-icon">{props.icon}</span>
      <span>{props.label}</span>
    </button>
  );
}
