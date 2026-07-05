import { create } from "zustand";
import type { SceneDocument, TemplateScene } from "@grapix/shared-types";
import {
  createEmptyTemplateScene,
  createSeedTemplateCatalog,
  formatNumericSceneId,
  profileFromScene,
  sceneToTemplateScene
} from "../lib/templateCatalog";

export type TemplateViewMode = "thumbnails" | "list";

interface TemplateState {
  templates: TemplateScene[];
  selectedTemplateId: string | null;
  openedTemplateId: string | null;
  searchTerm: string;
  viewMode: TemplateViewMode;
  setSearchTerm: (searchTerm: string) => void;
  setViewMode: (viewMode: TemplateViewMode) => void;
  selectTemplate: (templateId: string) => void;
  openTemplateEditor: (templateId: string) => void;
  toggleFavorite: (templateId: string) => void;
  addNewTemplate: () => TemplateScene;
  createTemplateFromScene: (scene: SceneDocument) => void;
  updateTemplateScene: (templateId: string, scene: SceneDocument) => void;
  duplicateTemplate: (templateId: string) => void;
  renameTemplate: (templateId: string, name: string) => void;
  changeTemplateId: (templateId: string, sceneId: string) => void;
  deleteTemplate: (templateId: string) => void;
}

const seedCatalog = createSeedTemplateCatalog();

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: seedCatalog.templates,
  selectedTemplateId: seedCatalog.templates[0]?.templateId ?? null,
  openedTemplateId: null,
  searchTerm: "",
  viewMode: readTemplateViewMode(),
  setSearchTerm: (searchTerm) => set({ searchTerm }),
  setViewMode: (viewMode) => {
    localStorage.setItem("grapix-template-view-mode-v1", viewMode);
    set({ viewMode });
  },
  selectTemplate: (selectedTemplateId) => set({ selectedTemplateId }),
  openTemplateEditor: (openedTemplateId) =>
    set({
      openedTemplateId,
      selectedTemplateId: openedTemplateId
    }),
  toggleFavorite: (templateId) =>
    set((state) => ({
      templates: state.templates.map((template) =>
        template.templateId === templateId ? { ...template, favorite: !template.favorite } : template
      )
    })),
  addNewTemplate: () => {
    const nextId = getNextNumericSceneId(get().templates);
    const template = sceneToTemplateScene(createEmptyTemplateScene(nextId), nextId - 1);

    set((state) => ({
      templates: [...state.templates, template],
      selectedTemplateId: template.templateId,
      openedTemplateId: template.templateId
    }));

    return template;
  },
  createTemplateFromScene: (scene) => {
    const nextId = getNextNumericSceneId(get().templates);
    const template = sceneToTemplateScene(scene, nextId - 1);

    set((state) => ({
      templates: [...state.templates, template],
      selectedTemplateId: template.templateId,
      openedTemplateId: template.templateId
    }));
  },
  updateTemplateScene: (templateId, scene) =>
    set((state) => ({
      templates: state.templates.map((template) =>
        template.templateId === templateId
          ? {
              ...template,
              scene: {
                ...scene,
                id: template.sceneId
              },
              name: scene.name,
              videoProfile: profileFromScene(scene),
              updatedAt: new Date().toISOString()
            }
          : template
      )
    })),
  duplicateTemplate: (templateId) => {
    const source = get().templates.find((template) => template.templateId === templateId);

    if (!source) {
      return;
    }

    const sceneId = formatNumericSceneId(getNextNumericSceneId(get().templates));
    const duplicated: TemplateScene = {
      ...source,
      templateId: `${source.templateId}_copy_${Date.now()}`,
      sceneId,
      shortLabel: sceneId,
      name: `${source.name} Copy`,
      favorite: false,
      scene: {
        ...source.scene,
        id: sceneId,
        name: `${source.scene.name} Copy`
      },
      updatedAt: new Date().toISOString()
    };

    set((state) => ({
      templates: [...state.templates, duplicated],
      selectedTemplateId: duplicated.templateId
    }));
  },
  renameTemplate: (templateId, name) =>
    set((state) => ({
      templates: state.templates.map((template) =>
        template.templateId === templateId
          ? {
              ...template,
              name,
              scene: {
                ...template.scene,
                name
              },
              updatedAt: new Date().toISOString()
            }
          : template
      )
    })),
  changeTemplateId: (templateId, sceneId) =>
    set((state) => ({
      templates: state.templates.map((template) =>
        template.templateId === templateId
          ? {
              ...template,
              sceneId: normalizeNumericSceneId(sceneId, template.sceneId),
              shortLabel: normalizeNumericSceneId(sceneId, template.sceneId),
              scene: {
                ...template.scene,
                id: normalizeNumericSceneId(sceneId, template.sceneId)
              },
              updatedAt: new Date().toISOString()
            }
          : template
      )
    })),
  deleteTemplate: (templateId) =>
    set((state) => {
      const templates = state.templates.filter((template) => template.templateId !== templateId);
      const fallback = templates[0];

      return {
        templates,
        selectedTemplateId: state.selectedTemplateId === templateId ? fallback?.templateId ?? null : state.selectedTemplateId,
        openedTemplateId: state.openedTemplateId === templateId ? null : state.openedTemplateId
      };
    })
}));

function getNextNumericSceneId(templates: TemplateScene[]): number {
  const highestId = templates.reduce((highest, template) => {
    const numericId = Number(template.sceneId);

    return Number.isFinite(numericId) ? Math.max(highest, numericId) : highest;
  }, 0);

  return highestId + 1;
}

function normalizeNumericSceneId(value: string, fallback: string): string {
  const digits = value.replace(/\D+/g, "");

  if (!digits) {
    return fallback;
  }

  return formatNumericSceneId(Number(digits));
}

function readTemplateViewMode(): TemplateViewMode {
  const storedViewMode = localStorage.getItem("grapix-template-view-mode-v1");

  return storedViewMode === "list" ? "list" : "thumbnails";
}
