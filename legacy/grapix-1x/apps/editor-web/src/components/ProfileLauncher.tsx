import { KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useProfileStore } from "../store/profileStore";

/**
 * The launch screen. GrapiX opens here, not in the workspace: a profile carries the
 * workspace layout and the importer credentials, so nothing can meaningfully render until
 * one is chosen.
 */
export function ProfileLauncher() {
  const profiles = useProfileStore((state) => state.profiles);
  const status = useProfileStore((state) => state.status);
  const error = useProfileStore((state) => state.error);
  const loadProfiles = useProfileStore((state) => state.loadProfiles);
  const launchProfile = useProfileStore((state) => state.launchProfile);
  const createProfile = useProfileStore((state) => state.createProfile);
  const deleteProfile = useProfileStore((state) => state.deleteProfile);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [figmaToken, setFigmaToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setFormError("Give the profile a name.");

      return;
    }

    setBusy(true);
    setFormError(null);

    try {
      await createProfile({
        name: name.trim(),
        description: description.trim() || undefined,
        figmaToken: figmaToken.trim() || undefined
      });
      setName("");
      setDescription("");
      setFigmaToken("");
      setCreating(false);
    } catch (createError) {
      setFormError(createError instanceof Error ? createError.message : "Could not create the profile.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="launcher-shell">
      <div className="launcher-card">
        <header className="launcher-header">
          <div>
            <h1>GrapiX</h1>
            <p>Choose a profile to open the workspace.</p>
          </div>
          <button
            className="launcher-ghost-button"
            onClick={() => void loadProfiles()}
            title="Reload profiles"
            type="button"
          >
            <RefreshCw size={15} />
          </button>
        </header>

        {status === "loading" ? (
          <div className="launcher-empty">
            <Loader2 className="launcher-spin" size={18} /> Loading profiles…
          </div>
        ) : null}

        {error ? <div className="launcher-error">{error}</div> : null}

        {status !== "loading" && !profiles.length && !creating ? (
          <div className="launcher-empty">
            No profiles yet. Create one to get started.
          </div>
        ) : null}

        {profiles.length ? (
          <ul className="launcher-list">
            {profiles.map((profile) => (
              <li className="launcher-item" key={profile.profileId}>
                <button
                  className="launcher-item-main"
                  disabled={status === "launching"}
                  onClick={() => void launchProfile(profile.profileId)}
                  type="button"
                >
                  <span className="launcher-item-name">{profile.name}</span>
                  <span className="launcher-item-meta">
                    {profile.description ? `${profile.description} · ` : ""}
                    {profile.credentialHints.figmaToken.present
                      ? `Figma token ····${profile.credentialHints.figmaToken.last4}`
                      : "No Figma token"}
                    {profile.lastOpenedAt
                      ? ` · opened ${new Date(profile.lastOpenedAt).toLocaleString()}`
                      : " · never opened"}
                  </span>
                </button>
                <button
                  className="launcher-ghost-button"
                  onClick={() => {
                    if (window.confirm(`Delete profile "${profile.name}"? This cannot be undone.`)) {
                      void deleteProfile(profile.profileId);
                    }
                  }}
                  title="Delete profile"
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {creating ? (
          <div className="launcher-form">
            <label htmlFor="profile-name">Profile name</label>
            <input
              autoFocus
              id="profile-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Match Day"
              value={name}
            />

            <label htmlFor="profile-description">Description</label>
            <input
              id="profile-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Weekend league graphics"
              value={description}
            />

            <label htmlFor="profile-token">
              <KeyRound size={13} /> Figma personal access token
            </label>
            <input
              id="profile-token"
              onChange={(event) => setFigmaToken(event.target.value)}
              placeholder="figd_…"
              type="password"
              value={figmaToken}
            />
            <p className="launcher-hint">
              Optional, and only needed for the REST import fallback. It is stored by the local
              GrapiX service and never sent back to this window. The Figma plugin does not need it.
            </p>

            {formError ? <div className="launcher-error">{formError}</div> : null}

            <div className="launcher-form-actions">
              <button
                className="launcher-secondary-button"
                onClick={() => {
                  setCreating(false);
                  setFormError(null);
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="launcher-primary-button"
                disabled={busy}
                onClick={() => void submit()}
                type="button"
              >
                {busy ? "Creating…" : "Create and launch"}
              </button>
            </div>
          </div>
        ) : (
          <button className="launcher-primary-button" onClick={() => setCreating(true)} type="button">
            <Plus size={15} /> New profile
          </button>
        )}
      </div>
    </div>
  );
}
