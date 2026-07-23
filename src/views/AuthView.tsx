import { useState, type FormEvent } from "react";
import { Brain, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Session } from "@secondbrain/shared";
import { Button } from "../components/ui";
import { login, register, requestPasswordReset } from "../lib/auth";
import { ApiError, OfflineError } from "../lib/api";

/** Mirrors the server's floor. Enforced here only — the server never receives
 *  a password to measure, by design. */
const MIN_PASSWORD = 12;

type Mode = "login" | "register" | "forgot";

export default function AuthView({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once a reset link has been requested. The message is deliberately the
  // same whether or not that address has an account — the server answers
  // identically so this form can't be used to test an email list, and showing
  // anything more specific here would hand back the answer it withheld.
  const [resetSent, setResetSent] = useState(false);

  const isRegister = mode === "register";
  const isForgot = mode === "forgot";

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
    setResetSent(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (isForgot) {
      setBusy(true);
      try {
        await requestPasswordReset(email);
        setResetSent(true);
      } catch (err) {
        if (err instanceof OfflineError) setError(t("auth.offline"));
        else if (err instanceof ApiError) setError(err.message);
        else setError(t("auth.genericError"));
      }
      setBusy(false);
      return;
    }

    if (isRegister) {
      if (password.length < MIN_PASSWORD) {
        setError(t("auth.passwordTooShort", { min: MIN_PASSWORD }));
        return;
      }
      if (password !== confirm) {
        setError(t("auth.passwordMismatch"));
        return;
      }
    }

    setBusy(true);
    try {
      // Both paths run argon2id in here, which takes real time on purpose —
      // hence the pending state rather than an optimistic transition.
      const session = isRegister
        ? await register(email, password)
        : await login(email, password, deviceLabel());
      onSignedIn(session);
    } catch (err) {
      if (err instanceof OfflineError) setError(t("auth.offline"));
      else if (err instanceof ApiError) setError(err.message);
      else setError(t("auth.genericError"));
      setBusy(false);
    }
    // No setBusy(false) on success: the gate swaps this view out, and clearing
    // it first flashes an enabled button on a screen that is going away.
  }

  return (
    <div className="flex h-full items-center justify-center bg-neutral-50 p-6 dark:bg-neutral-900">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Brain size={36} className="text-blue-600" />
          <h1 className="text-xl font-bold">{t("app.name")}</h1>
          <p className="text-sm text-neutral-500">
            {isForgot
              ? t("auth.forgotSubtitle")
              : isRegister
                ? t("auth.registerSubtitle")
                : t("auth.loginSubtitle")}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-500">{t("auth.email")}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
              disabled={busy}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800"
            />
          </label>

          {!isForgot && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-500">{t("auth.password")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              // Tells a password manager to offer generation on sign-up and
              // the saved entry on sign-in; the wrong value here is why
              // managers sometimes refuse to fill.
              autoComplete={isRegister ? "new-password" : "current-password"}
              disabled={busy}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800"
            />
          </label>
          )}

          {mode === "login" && (
            <p className="text-right text-xs">
              <button
                type="button"
                onClick={() => switchMode("forgot")}
                disabled={busy}
                className="text-blue-600 hover:underline disabled:opacity-50"
              >
                {t("auth.forgotPassword")}
              </button>
            </p>
          )}

          {isRegister && (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-neutral-500">{t("auth.confirmPassword")}</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  disabled={busy}
                  className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800"
                />
              </label>
              {/* Recovery now exists, and it runs entirely through this
                  address — so it is worth saying before someone signs up with
                  a mailbox they can't reach. */}
              <p className="text-xs text-neutral-500">{t("auth.verifyOnRegisterNote")}</p>
            </>
          )}

          {resetSent && (
            <p className="rounded-lg bg-neutral-100 px-3 py-2 text-sm leading-relaxed text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {t("auth.resetSent")}
            </p>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" disabled={busy} className="w-full !py-2">
            <span className="flex items-center justify-center gap-2">
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy
                ? t("auth.working")
                : isForgot
                  ? t("auth.sendResetLink")
                  : isRegister
                    ? t("auth.createAccount")
                    : t("auth.signIn")}
            </span>
          </Button>
        </form>

        {isForgot ? (
          <p className="mt-5 text-center text-sm">
            <button
              type="button"
              onClick={() => switchMode("login")}
              disabled={busy}
              className="font-medium text-blue-600 hover:underline disabled:opacity-50"
            >
              {t("auth.backToSignIn")}
            </button>
          </p>
        ) : (
          <p className="mt-5 text-center text-sm text-neutral-500">
            {isRegister ? t("auth.haveAccount") : t("auth.noAccount")}{" "}
            <button
              type="button"
              onClick={() => switchMode(isRegister ? "login" : "register")}
              disabled={busy}
              className="font-medium text-blue-600 hover:underline disabled:opacity-50"
            >
              {isRegister ? t("auth.signIn") : t("auth.createAccount")}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/** A human-readable name for this device, shown in the session list. Derived
 *  from the platform rather than asked for — one more field on a sign-in form
 *  is not worth it. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown device";
}
