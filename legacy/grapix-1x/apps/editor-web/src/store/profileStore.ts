import type { ProfilePublic, ProfileWorkspaceLayout } from "@grapix/shared-types";
import { create } from "zustand";
import {
  createProfileOnApi,
  deleteProfileOnApi,
  launchProfileOnApi,
  listProfilesFromApi,
  updateProfileOnApi
} from "../lib/apiClient";

/**
 * The active profile gates the workspace: nothing renders until one is launched.
 *
 * A profile owns the workspace layout and the credentials the importers need. Credential
 * values are write-only from here — the API returns a hint, never the token.
 */

const ACTIVE_PROFILE_KEY = "grapix-active-profile-v1";

export type ProfileStatus = "loading" | "ready" | "launching" | "error";

interface ProfileState {
  profiles: ProfilePublic[];
  activeProfile: ProfilePublic | null;
  status: ProfileStatus;
  error: string | null;
  loadProfiles: () => Promise<void>;
  createProfile: (input: { name: string; description?: string; figmaToken?: string }) => Promise<void>;
  launchProfile: (profileId: string) => Promise<void>;
  closeProfile: () => void;
  deleteProfile: (profileId: string) => Promise<void>;
  setFigmaToken: (token: string) => Promise<void>;
  saveWorkspaceLayout: (layout: ProfileWorkspaceLayout) => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  activeProfile: null,
  status: "loading",
  error: null,

  loadProfiles: async () => {
    set({ status: "loading", error: null });

    try {
      const profiles = await listProfilesFromApi();
      set({ profiles, status: "ready" });

      // Re-launch the last profile so a reload does not send the operator back to the
      // launcher mid-show.
      const remembered = readRememberedProfileId();

      if (remembered && profiles.some((profile) => profile.profileId === remembered)) {
        await get().launchProfile(remembered);
      }
    } catch (error) {
      set({
        status: "error",
        error:
          error instanceof Error
            ? `${error.message}. Is the GrapiX API running on 127.0.0.1:4100?`
            : "Could not reach the GrapiX API."
      });
    }
  },

  createProfile: async (input) => {
    const profile = await createProfileOnApi(input);
    set((state) => ({ profiles: [profile, ...state.profiles] }));
    await get().launchProfile(profile.profileId);
  },

  launchProfile: async (profileId) => {
    set({ status: "launching", error: null });

    try {
      const profile = await launchProfileOnApi(profileId);
      rememberProfileId(profileId);
      set((state) => ({
        activeProfile: profile,
        status: "ready",
        profiles: state.profiles.map((entry) => (entry.profileId === profileId ? profile : entry))
      }));
    } catch (error) {
      set({
        status: "error",
        error: error instanceof Error ? error.message : "Could not launch that profile."
      });
    }
  },

  closeProfile: () => {
    rememberProfileId(null);
    set({ activeProfile: null, status: "ready", error: null });
  },

  deleteProfile: async (profileId) => {
    await deleteProfileOnApi(profileId);
    const active = get().activeProfile;

    if (active?.profileId === profileId) {
      rememberProfileId(null);
    }

    set((state) => ({
      profiles: state.profiles.filter((profile) => profile.profileId !== profileId),
      activeProfile: active?.profileId === profileId ? null : active
    }));
  },

  setFigmaToken: async (token) => {
    const active = get().activeProfile;

    if (!active) {
      return;
    }

    const profile = await updateProfileOnApi(active.profileId, { figmaToken: token });
    set((state) => ({
      activeProfile: profile,
      profiles: state.profiles.map((entry) =>
        entry.profileId === profile.profileId ? profile : entry
      )
    }));
  },

  saveWorkspaceLayout: (layout) => {
    const active = get().activeProfile;

    if (!active) {
      return;
    }

    // Layout changes fire on every drag; persist optimistically and do not block the UI.
    set({ activeProfile: { ...active, workspaceLayout: layout } });

    void updateProfileOnApi(active.profileId, { workspaceLayout: layout }).catch(() => {
      // A dropped layout save is not worth interrupting an operator for.
    });
  }
}));

function readRememberedProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY);
  } catch {
    return null;
  }
}

function rememberProfileId(profileId: string | null): void {
  try {
    if (profileId) {
      localStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
    } else {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  } catch {
    // Private-mode storage failures must not stop a launch.
  }
}
