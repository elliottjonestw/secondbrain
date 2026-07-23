import { useEffect, useState, type FormEvent } from "react";
import { Brain, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";
import { resetPassword, verifyEmail } from "../lib/auth";
import { clearAuth } from "../lib/authStore";
import { ApiError, OfflineError } from "../lib/api";
import type { RecoveryLink } from "../lib/recoveryLink";

/** Mirrors the server's floor, enforced here only — the server never receives
 *  a password to measure. Same rule as AuthView. */
const MIN_PASSWORD = 12;

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800";

/**
 * The screen an emailed link lands on: choosing a new password, or confirming
 * an address.
 *
 * It renders above the auth gate and ignores whether anyone is signed in.
 * That's deliberate for the reset case — completing a reset revokes every
 * session server-side, so a signed-in user who follows a reset link is about to
 * be signed out regardless, and letting the app render behind a screen whose
 * whole purpose is invalidating that session is just confusing.
 *
 * Both paths finish at a reload rather than a state transition. The session,
 * the response cache and every module-scoped cache in the app are all stale by
 * then, and a reload is the same "simplest correct reset" that sign-out uses.
 */
export default function RecoveryView({ link }: { link: RecoveryLink }) {
  return link.kind === "reset" ? <ResetPane token={link.token} /> : <VerifyPane token={link.token} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-900">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Brain size={36} className="text-blue-600" />
          <h1 className="text-xl font-bold">{t("app.name")}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Every exit from this screen is a full reload into the login view. */
function finish(): void {
  clearAuth();
  window.location.reload();
}

function ResetPane({ token }: { token: string }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (password.length < MIN_PASSWORD) {
      setError(t("auth.passwordTooShort", { min: MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }

    setBusy(true);
    try {
      // Runs argon2id, which takes real time by design — hence the pending
      // state rather than an optimistic transition.
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof OfflineError) setError(t("auth.offline"));
      else if (err instanceof ApiError) setError(err.message);
      else setError(t("auth.genericError"));
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Shell>
        <div className="space-y-4 text-center">
          <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-green-600">
            <Check size={16} /> {t("auth.resetDone")}
          </p>
          <p className="text-sm leading-relaxed text-neutral-500">{t("auth.resetSignedOutEverywhere")}</p>
          <Button variant="primary" className="w-full !py-2" onClick={finish}>
            {t("auth.signIn")}
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="mb-5 text-center text-sm text-neutral-500">{t("auth.resetSubtitle")}</p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-500">{t("auth.newPassword")}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            autoFocus
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-500">{t("auth.confirmPassword")}</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="w-full !py-2">
          <span className="flex items-center justify-center gap-2">
            {busy && <Loader2 size={15} className="animate-spin" />}
            {busy ? t("auth.working") : t("auth.setPassword")}
          </span>
        </Button>
      </form>

      <p className="mt-5 text-center text-sm">
        <button type="button" onClick={finish} disabled={busy} className="text-blue-600 hover:underline disabled:opacity-50">
          {t("auth.backToSignIn")}
        </button>
      </p>
    </Shell>
  );
}

function VerifyPane({ token }: { token: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await verifyEmail(token);
        if (!cancelled) setState("done");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : t("auth.genericError"));
        setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  return (
    <Shell>
      <div className="space-y-4 text-center">
        {state === "working" && (
          <p className="flex items-center justify-center gap-2 text-sm text-neutral-500">
            <Loader2 size={15} className="animate-spin" /> {t("auth.verifying")}
          </p>
        )}
        {state === "done" && (
          <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-green-600">
            <Check size={16} /> {t("auth.verifyDone")}
          </p>
        )}
        {state === "failed" && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </p>
        )}
        {state !== "working" && (
          // Confirming doesn't sign anyone in or out, but the cached session
          // carries the old `email_verified` — a reload is what makes Settings
          // agree with what just happened.
          <Button variant="primary" className="w-full !py-2" onClick={() => window.location.reload()}>
            {t("common.continue")}
          </Button>
        )}
      </div>
    </Shell>
  );
}
