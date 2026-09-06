import { useEffect, useRef, useState } from "react";
import { signIn } from "./auth";

/**
 * The operator sign-in screen.
 *
 * A full-screen gate rather than a dialog: an operator who has not signed in has no authority
 * to cue or take anything, and showing the transport controls behind a modal would suggest
 * otherwise. The engine would refuse them anyway - this is the honest version of that refusal,
 * shown before the operator reaches for a button rather than after.
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <div className="login-backdrop">
      <form className="login-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <strong>Sign in to GrapiX Playout</strong>
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

        {error ? <p className="login-error">{error}</p> : null}

        <footer>
          <button className="primary" disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </footer>

        <p className="login-note">
          Every cue, take and output change is recorded against your account.
        </p>
      </form>
    </div>
  );
}
