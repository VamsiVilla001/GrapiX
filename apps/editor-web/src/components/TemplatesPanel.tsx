import type { SceneObject, TemplateScene } from "@grapix/shared-types";
import { Check, ChevronDown, Filter, Grid2X2, List, Plus, Search, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { sortObjectsForRender } from "../rendering/sceneMaterial";
import { useEditorStore } from "../store/editorStore";
import { type TemplateViewMode, useTemplateStore } from "../store/templateStore";

const contextMenuItems = [
  "New",
  "To Sequencer",
  "Edit Script Events...",
  "Edit Visual Logic...",
  "Duplicate",
  "Rename",
  "Change ID...",
  "Convert Dimensions...",
  "Detach from Parent",
  "Export Scene...",
  "Regenerate All Thumbnails...",
  "Delete"
] as const;

type ContextMenuItem = (typeof contextMenuItems)[number];

interface ContextMenuState {
  templateId: string;
  x: number;
  y: number;
}

export function TemplatesPanel() {
  const scene = useEditorStore((state) => state.scene);
  const loadScene = useEditorStore((state) => state.loadScene);
  const setSceneId = useEditorStore((state) => state.setSceneId);
  const setSceneName = useEditorStore((state) => state.setSceneName);
  const templates = useTemplateStore((state) => state.templates);
  const selectedTemplateId = useTemplateStore((state) => state.selectedTemplateId);
  const openedTemplateId = useTemplateStore((state) => state.openedTemplateId);
  const searchTerm = useTemplateStore((state) => state.searchTerm);
  const viewMode = useTemplateStore((state) => state.viewMode);
  const setSearchTerm = useTemplateStore((state) => state.setSearchTerm);
  const setViewMode = useTemplateStore((state) => state.setViewMode);
  const selectTemplate = useTemplateStore((state) => state.selectTemplate);
  const openTemplateEditor = useTemplateStore((state) => state.openTemplateEditor);
  const toggleFavorite = useTemplateStore((state) => state.toggleFavorite);
  const addNewTemplate = useTemplateStore((state) => state.addNewTemplate);
  const updateTemplateScene = useTemplateStore((state) => state.updateTemplateScene);
  const duplicateTemplate = useTemplateStore((state) => state.duplicateTemplate);
  const renameTemplate = useTemplateStore((state) => state.renameTemplate);
  const changeTemplateId = useTemplateStore((state) => state.changeTemplateId);
  const deleteTemplate = useTemplateStore((state) => state.deleteTemplate);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const skipNextTemplateSync = useRef(false);
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const visibleTemplates = useMemo(
    () => templates.filter((template) => templateMatchesSearch(template, normalizedSearch)),
    [normalizedSearch, templates]
  );

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!viewMenuOpen) {
      return undefined;
    }

    const closeMenu = () => setViewMenuOpen(false);
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [viewMenuOpen]);

  useEffect(() => {
    if (!openedTemplateId) {
      return;
    }

    if (skipNextTemplateSync.current) {
      skipNextTemplateSync.current = false;
      return;
    }

    updateTemplateScene(openedTemplateId, scene);
  }, [openedTemplateId, scene, updateTemplateScene]);

  function createAndOpenTemplate() {
    const template = addNewTemplate();
    skipNextTemplateSync.current = true;
    loadScene(template.scene);
  }

  function deleteSelectedTemplate() {
    if (selectedTemplateId) {
      deleteTemplate(selectedTemplateId);
    }
  }

  function openContextMenu(event: MouseEvent, templateId: string) {
    event.preventDefault();
    selectTemplate(templateId);
    setContextMenu({
      templateId,
      x: event.clientX,
      y: event.clientY
    });
  }

  function runContextAction(item: ContextMenuItem, templateId: string) {
    const template = templates.find((entry) => entry.templateId === templateId);

    if (!template) {
      return;
    }

    switch (item) {
      case "New":
        createAndOpenTemplate();
        break;
      case "Duplicate":
        duplicateTemplate(templateId);
        break;
      case "Rename": {
        const name = window.prompt("Rename template", template.name);
        if (name?.trim()) {
          updateTemplateName(templateId, name.trim());
        }
        break;
      }
      case "Change ID...": {
        const sceneId = window.prompt("Change numeric scene ID", template.sceneId);
        if (sceneId?.trim()) {
          updateTemplateId(templateId, sceneId.trim());
        }
        break;
      }
      case "Export Scene...":
        exportTemplateScene(template);
        break;
      case "Delete":
        deleteTemplate(templateId);
        break;
      case "To Sequencer":
      case "Edit Script Events...":
      case "Edit Visual Logic...":
      case "Convert Dimensions...":
      case "Detach from Parent":
      case "Regenerate All Thumbnails...":
        window.alert(`${item} is reserved for the next template tooling pass.`);
        break;
    }

    setContextMenu(null);
  }

  useEffect(() => {
    function deleteFromKeyboard(event: KeyboardEvent) {
      if (event.key !== "Delete" || !selectedTemplateId || isEditableElement(event.target)) {
        return;
      }

      event.preventDefault();
      deleteTemplate(selectedTemplateId);
    }

    window.addEventListener("keydown", deleteFromKeyboard);

    return () => window.removeEventListener("keydown", deleteFromKeyboard);
  }, [deleteTemplate, selectedTemplateId]);

  function updateTemplateName(templateId: string, name: string) {
    renameTemplate(templateId, name);

    if (openedTemplateId === templateId) {
      setSceneName(name);
    }
  }

  function updateTemplateId(templateId: string, sceneId: string) {
    changeTemplateId(templateId, sceneId);

    if (openedTemplateId === templateId) {
      const normalizedSceneId = normalizeNumericId(sceneId);

      if (normalizedSceneId) {
        setSceneId(normalizedSceneId);
      }
    }
  }

  function selectViewMode(nextViewMode: TemplateViewMode) {
    setViewMode(nextViewMode);
    setViewMenuOpen(false);
  }

  return (
    <aside className="templates-panel flat-templates-panel">
      <div className="panel-header-row templates-header-row">
        <strong>TEMPLATES</strong>
        <div className="template-header-actions">
          <div className="template-view-wrapper">
            <button
              className="template-view-button"
              onClick={(event) => {
                event.stopPropagation();
                setViewMenuOpen((open) => !open);
              }}
              title="View mode"
            >
              {viewMode === "thumbnails" ? <Grid2X2 size={15} /> : <List size={15} />}
              <span>View</span>
              <ChevronDown size={14} />
            </button>
            {viewMenuOpen ? (
              <div className="template-view-menu" onClick={(event) => event.stopPropagation()} role="menu">
                <button
                  className={viewMode === "thumbnails" ? "active" : ""}
                  onClick={() => selectViewMode("thumbnails")}
                  role="menuitemradio"
                  aria-checked={viewMode === "thumbnails"}
                >
                  <Check className="view-check" size={15} />
                  <Grid2X2 size={15} />
                  <span>Thumbnails</span>
                </button>
                <button
                  className={viewMode === "list" ? "active" : ""}
                  onClick={() => selectViewMode("list")}
                  role="menuitemradio"
                  aria-checked={viewMode === "list"}
                >
                  <Check className="view-check" size={15} />
                  <List size={15} />
                  <span>List</span>
                </button>
              </div>
            ) : null}
          </div>
          <button className="text-action primary" onClick={createAndOpenTemplate} title="New template">
            <Plus size={16} /> New
          </button>
          <button
            className="text-action danger"
            disabled={!selectedTemplateId}
            onClick={deleteSelectedTemplate}
            title="Delete selected template"
          >
            <Trash2 size={15} /> Delete
          </button>
        </div>
      </div>
      <label className="template-search">
        <Search size={18} />
        <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search templates..." />
        <Filter size={18} />
      </label>
      <div className="template-section-title">
        Scenes / Templates ({visibleTemplates.length})
        {openedTemplateId ? <span>Editing {templates.find((template) => template.templateId === openedTemplateId)?.sceneId}</span> : null}
      </div>
      <div className={`template-card-list ${viewMode === "list" ? "list-view" : "thumbnail-view"}`}>
        {visibleTemplates.length === 0 ? (
          <div className="empty-panel compact template-empty-state">
            <strong>No templates yet</strong>
            <span>Click New to create an empty scene template.</span>
          </div>
        ) : null}
        {visibleTemplates.map((template) => (
          <TemplateCard
            key={template.templateId}
            template={template}
            viewMode={viewMode}
            selected={selectedTemplateId === template.templateId}
            onSelect={() => selectTemplate(template.templateId)}
            onOpen={() => {
              skipNextTemplateSync.current = true;
              openTemplateEditor(template.templateId);
              loadScene(template.scene);
            }}
            onContextMenu={(event) => openContextMenu(event, template.templateId)}
            onToggleFavorite={() => toggleFavorite(template.templateId)}
            onChangeName={(name) => updateTemplateName(template.templateId, name)}
            onChangeId={(sceneId) => updateTemplateId(template.templateId, sceneId)}
          />
        ))}
      </div>
      {contextMenu ? (
        <div className="template-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenuItems.map((item) => (
            <button
              className={item === "Delete" ? "danger" : ""}
              key={item}
              onClick={(event) => {
                event.stopPropagation();
                runContextAction(item, contextMenu.templateId);
              }}
              role="menuitem"
            >
              <span>{item}</span>
              <kbd>{shortcutForMenuItem(item)}</kbd>
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function TemplateCard(props: {
  template: TemplateScene;
  viewMode: TemplateViewMode;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onToggleFavorite: () => void;
  onChangeName: (name: string) => void;
  onChangeId: (sceneId: string) => void;
}) {
  return (
    <div
      className={`template-card ${props.viewMode === "list" ? "list-row" : "thumbnail-card"} ${props.template.thumbnailVariant} ${props.selected ? "selected" : ""}`}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
      onContextMenu={props.onContextMenu}
      role="button"
      tabIndex={0}
      title={`${props.template.name} (${props.template.videoProfile.label})`}
    >
      <div className="template-preview-shell" style={{ aspectRatio: `${props.template.scene.canvas.width} / ${props.template.scene.canvas.height}` }}>
        <svg
          className="template-preview-svg"
          viewBox={`0 0 ${props.template.scene.canvas.width} ${props.template.scene.canvas.height}`}
          aria-hidden="true"
        >
          <rect width={props.template.scene.canvas.width} height={props.template.scene.canvas.height} fill={props.template.scene.canvas.background} />
          {sortObjectsForRender(props.template.scene.objects).map((object) => renderTemplateObject(object))}
        </svg>
        <span className="template-profile-pill">{props.template.videoProfile.width}x{props.template.videoProfile.height}</span>
      </div>
      <div className="template-card-meta">
        <div className="template-card-title-row">
          <span className="template-card-index">{shortPreviewLabel(props.template.sceneId)}</span>
          <label className="template-name-field" onClick={(event) => event.stopPropagation()}>
            <span>Name</span>
            <input
              value={props.template.name}
              onChange={(event) => props.onChangeName(event.target.value)}
              onDoubleClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.stopPropagation()}
            />
          </label>
        </div>
        <small className="template-profile-text">{props.template.videoProfile.label}</small>
        <label className="template-id-field" onClick={(event) => event.stopPropagation()}>
          <span>ID</span>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={props.template.sceneId}
            onChange={(event) => props.onChangeId(event.target.value)}
            onDoubleClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          />
        </label>
        <button
          className={`template-star ${props.template.favorite ? "active" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleFavorite();
          }}
          title={props.template.favorite ? "Remove favorite" : "Add favorite"}
        >
          <Star size={17} fill={props.template.favorite ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
  );
}

function templateMatchesSearch(template: TemplateScene, search: string): boolean {
  if (!search) {
    return true;
  }

  return [
    template.name,
    template.sceneId,
    template.shortLabel,
    template.videoProfile.label,
    `${template.videoProfile.width}x${template.videoProfile.height}`,
    template.videoProfile.timebase
  ]
    .join(" ")
    .toLowerCase()
    .includes(search);
}

function shortPreviewLabel(sceneId: string): string {
  return sceneId.split("-").at(-1) ?? sceneId;
}

function normalizeNumericId(value: string): string {
  const digits = value.replace(/\D+/g, "");

  if (!digits) {
    return "";
  }

  return String(Number(digits)).padStart(3, "0");
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.matches("input, textarea, select, [contenteditable='true']");
}

function renderTemplateObject(object: SceneObject) {
  const commonProps = {
    key: object.id,
    transform: `translate(${object.x} ${object.y}) rotate(${object.rotation})`,
    opacity: object.opacity,
    visibility: object.visible ? "visible" : "hidden"
  } as const;

  switch (object.type) {
    case "text":
      return (
        <text
          {...commonProps}
          x={0}
          y={0}
          fill={object.fill}
          fontFamily={object.fontFamily}
          fontSize={object.fontSize}
          fontWeight={object.fontWeight}
          dominantBaseline="hanging"
        >
          {object.text}
        </text>
      );
    case "rect":
      return <rect {...commonProps} width={object.width} height={object.height} rx={object.radius} fill={object.fill} stroke={object.stroke} strokeWidth={object.strokeWidth} />;
    case "ellipse":
      return <ellipse {...commonProps} cx={object.width / 2} cy={object.height / 2} rx={object.width / 2} ry={object.height / 2} fill={object.fill} stroke={object.stroke} strokeWidth={object.strokeWidth} />;
    case "image":
      return <image {...commonProps} href={object.src} width={object.width} height={object.height} preserveAspectRatio={object.objectFit === "stretch" ? "none" : "xMidYMid slice"} />;
    case "line":
      return (
        <polyline
          {...commonProps}
          points={object.points.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
        />
      );
    case "mesh":
      return <rect {...commonProps} width={object.width} height={object.height} rx={12} fill={object.fill} stroke={object.stroke} strokeWidth={object.strokeWidth} />;
    case "light":
      return <circle {...commonProps} cx={object.width / 2} cy={object.height / 2} r={Math.min(object.width, object.height) / 2} fill={object.color} />;
    case "camera":
      return <rect {...commonProps} width={object.width} height={object.height} rx={10} fill={object.fill} stroke={object.stroke} strokeWidth={object.strokeWidth} />;
    case "layer":
    case "group":
      return <rect {...commonProps} width={object.width} height={object.height} rx={10} fill="none" stroke={object.stroke} strokeWidth={object.strokeWidth} strokeDasharray="18 12" />;
    case "marker":
      return <circle {...commonProps} cx={object.width / 2} cy={object.height / 2} r={Math.min(object.width, object.height) / 2} fill={object.fill} stroke={object.stroke} strokeWidth={object.strokeWidth} />;
  }
}

function shortcutForMenuItem(item: ContextMenuItem): string {
  switch (item) {
    case "Edit Script Events...":
      return "Shift+Ctrl+E";
    case "Rename":
      return "F2";
    case "Change ID...":
      return "F7";
    case "Delete":
      return "Del";
    default:
      return "";
  }
}

function exportTemplateScene(template: TemplateScene): void {
  const blob = new Blob([JSON.stringify(template.scene, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${template.sceneId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
