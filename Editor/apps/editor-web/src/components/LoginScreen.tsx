import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { signIn } from "../lib/auth";

/**
 * The sign-in screen.
 *
 * Shown instead of the workspace until there is a verified user. It is a full-screen gate, not
 * a dialog over the app: an author who has not signed in has no scene open, and presenting the
 * editor behind a modal would suggest they can keep working without an identity, which is the
 * one thing the engine will no longer let them do.
 *
 * The form asks for a username or an email, because operators do not reliably remember which
 * they were registered with, and one field that accepts both is one fewer support call.
 */
export function LoginScreen() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const identifierRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    identifierRef.current?.focus();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(identifier, password);
      // On success the parent unmounts this screen: the auth store change is what replaces it.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
      setPassword("");
      setBusy(false);
    }
  }

  return createPortal(
    <div className="material-dialog-backdrop login-backdrop">
      <form
        className="material-create-dialog login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
        onSubmit={(event) => void submit(event)}
      >
        <header>
          <strong id="login-title">Sign in to GrapiX</strong>
        </header>

        <label className="login-field">
          <span>Username or email</span>
          <input
            ref={identifierRef}
            autoComplete="username"
            name="identifier"
            onChange={(event) => setIdentifier(event.target.value)}
            required
            type="text"
            value={identifier}
          />
        </label>

        <label className="login-field">
          <span>Password</span>
          <input
            autoComplete="current-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>

        {error ? <p className="material-dialog-error">{error}</p> : null}

        <footer>
          <button className="primary" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </footer>

        <p className="material-dialog-note">
          Sign-in is audited. Every scene load, edit and take is recorded against your account.
        </p>
      </form>
    </div>,
    document.body
  );
}
