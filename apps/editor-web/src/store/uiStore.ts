import { create } from "zustand";

type PropertiesTab = "Properties" | "Animation" | "Text" | "Data Binding";

interface UiState {
  zoom: number;
  snapping: boolean;
  propertiesTab: PropertiesTab;
  timelinePlaying: boolean;
  currentFrame: number;
  setZoom: (zoom: number) => void;
  toggleSnapping: () => void;
  setPropertiesTab: (tab: PropertiesTab) => void;
  setCurrentFrame: (frame: number) => void;
  toggleTimelinePlayback: () => void;
  goToStart: () => void;
  stepTimeline: (durationFrames: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  zoom: 100,
  snapping: true,
  propertiesTab: "Properties",
  timelinePlaying: false,
  currentFrame: 0,
  setZoom: (zoom) => set({ zoom }),
  toggleSnapping: () => set((state) => ({ snapping: !state.snapping })),
  setPropertiesTab: (propertiesTab) => set({ propertiesTab }),
  setCurrentFrame: (currentFrame) => set({ currentFrame: Math.max(0, Math.round(currentFrame)) }),
  toggleTimelinePlayback: () => set((state) => ({ timelinePlaying: !state.timelinePlaying })),
  goToStart: () => set({ currentFrame: 0, timelinePlaying: false }),
  stepTimeline: (durationFrames) =>
    set((state) => {
      const nextFrame = Math.min(state.currentFrame + 1, durationFrames);

      return {
        currentFrame: nextFrame,
        timelinePlaying: nextFrame < durationFrames
      };
    })
}));
