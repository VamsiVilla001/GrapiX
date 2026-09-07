/**
 * Profile storage.
 *
 * Profiles live in `data/profiles/`, which is gitignored. Credentials never leave this
 * module towards the editor: every read path the HTTP layer uses returns `ProfilePublic`,
 * and the raw token is only handed to the importers running inside this service.
 */

import {
  createDefaultWorkspaceLayout,
  createProfileId,
  toProfilePublic,
  type Profile,
  type ProfileCredentials,
  type ProfilePublic,
  type ProfileWorkspaceLayout
} from "@grapix/shared-types";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const profileRoot = path.join(workspaceRoot, "data", "profiles");

export interface CreateProfileInput {
  name: string;
  description?: string;
  figmaToken?: string;
}

export interface UpdateProfileInput {
  name?: string;
  description?: string;
  workspaceLayout?: ProfileWorkspaceLayout | null;
  settings?: Record<string, unknown>;
  /** Empty string clears the stored token; undefined leaves it untouched. */
  figmaToken?: string;
}

export async function ensureProfileStorage(): Promise<void> {
  await mkdir(profileRoot, { recursive: true });
}

export async function listProfiles(): Promise<ProfilePublic[]> {
  await ensureProfileStorage();
  const files = await readdir(profileRoot);
  const profiles: ProfilePublic[] = [];

  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const profile = await readProfileFile(path.join(profileRoot, file));

    if (profile) {
      profiles.push(toProfilePublic(profile));
    }
  }

  return profiles.sort((a, b) =>
    (b.lastOpenedAt ?? b.updatedAt).localeCompare(a.lastOpenedAt ?? a.updatedAt)
  );
}

export async function createProfile(input: CreateProfileInput): Promise<ProfilePublic> {
  const name = input.name.trim();

  if (!name) {
    throw new ProfileError("A profile needs a name.", 400);
  }

  const now = new Date().toISOString();
  const profile: Profile = {
    profileId: createProfileId(),
    name,
    description: input.description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    workspaceLayout: createDefaultWorkspaceLayout(),
    settings: {},
    credentials: input.figmaToken?.trim() ? { figmaToken: input.figmaToken.trim() } : {}
  };

  await writeProfile(profile);

  return toProfilePublic(profile);
}

export async function updateProfile(
  profileId: string,
  input: UpdateProfileInput
): Promise<ProfilePublic> {
  // Serialised per profile: the editor fires dock and panel-size saves together, and two
  // interleaved read-modify-write cycles would drop one of them.
  return withProfileLock(profileId, async () => {
    const profile = await readProfile(profileId);

    if (!profile) {
      throw new ProfileError("Profile not found.", 404);
    }

    const credentials: ProfileCredentials = { ...profile.credentials };

    if (input.figmaToken !== undefined) {
      const trimmed = input.figmaToken.trim();

      if (trimmed) {
        credentials.figmaToken = trimmed;
      } else {
        delete credentials.figmaToken;
      }
    }

    const updated: Profile = {
      ...profile,
      name: input.name?.trim() || profile.name,
      description:
        input.description === undefined ? profile.description : input.description.trim() || undefined,
      workspaceLayout: mergeWorkspaceLayout(profile.workspaceLayout, input.workspaceLayout),
      settings: input.settings ? { ...profile.settings, ...input.settings } : profile.settings,
      credentials,
      updatedAt: new Date().toISOString()
    };

    await writeProfile(updated);

    return toProfilePublic(updated);
  });
}

/**
 * Merges a partial layout save instead of replacing the whole thing, so a dock change and
 * a panel-size change arriving together do not overwrite one another. An explicit null
 * still clears the layout.
 */
function mergeWorkspaceLayout(
  current: ProfileWorkspaceLayout | null,
  incoming: ProfileWorkspaceLayout | null | undefined
): ProfileWorkspaceLayout | null {
  if (incoming === undefined) {
    return current;
  }

  if (incoming === null) {
    return null;
  }

  return {
    dock: Object.keys(incoming.dock ?? {}).length ? incoming.dock : (current?.dock ?? {}),
    panelSizes: { ...(current?.panelSizes ?? {}), ...(incoming.panelSizes ?? {}) }
  };
}

const profileLocks = new Map<string, Promise<unknown>>();

/** Chains work per profile id so writes to one file never interleave. */
async function withProfileLock<T>(profileId: string, run: () => Promise<T>): Promise<T> {
  const previous = profileLocks.get(profileId) ?? Promise.resolve();
  const next = previous.then(run, run);
  // Keep the chain alive but never let a rejection poison the next waiter.
  const chained = next.catch(() => undefined);

  profileLocks.set(profileId, chained);

  try {
    return await next;
  } finally {
    if (profileLocks.get(profileId) === chained) {
      profileLocks.delete(profileId);
    }
  }
}

/** Marks the profile opened and returns it. This is what "launch" means server-side. */
export async function launchProfile(profileId: string): Promise<ProfilePublic> {
  return withProfileLock(profileId, async () => {
    const profile = await readProfile(profileId);

    if (!profile) {
      throw new ProfileError("Profile not found.", 404);
    }

    const opened: Profile = {
      ...profile,
      lastOpenedAt: new Date().toISOString()
    };

    await writeProfile(opened);

    return toProfilePublic(opened);
  });
}

export async function deleteProfile(profileId: string): Promise<void> {
  const profile = await readProfile(profileId);

  if (!profile) {
    throw new ProfileError("Profile not found.", 404);
  }

  await unlink(profilePath(profileId));
}

/**
 * Reads a credential for server-side use. The only path by which a secret leaves storage,
 * and it is never reachable from an HTTP response body.
 */
export async function readProfileCredential(
  profileId: string,
  key: keyof ProfileCredentials
): Promise<string | undefined> {
  const profile = await readProfile(profileId);

  if (!profile) {
    throw new ProfileError("Profile not found.", 404);
  }

  return profile.credentials[key];
}

export class ProfileError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProfileError";
    this.status = status;
  }
}

async function readProfile(profileId: string): Promise<Profile | null> {
  return readProfileFile(profilePath(profileId));
}

async function readProfileFile(filePath: string): Promise<Profile | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Profile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/**
 * Atomic write: a reader must never observe a half-written profile. Write to a temp file
 * in the same directory, then rename — rename is atomic within a volume.
 */
async function writeProfile(profile: Profile): Promise<void> {
  await ensureProfileStorage();

  const target = profilePath(profile.profileId);
  const temp = `${target}.${process.pid}.tmp`;

  await writeFile(temp, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

function profilePath(profileId: string): string {
  return path.join(profileRoot, `${safeSegment(profileId)}.json`);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}
