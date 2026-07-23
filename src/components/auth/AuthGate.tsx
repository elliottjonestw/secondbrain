import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Session } from "@secondbrain/shared";
import AuthView from "../../views/AuthView";
import RecoveryView from "../../views/RecoveryView";
import { restoreSession } from "../../lib/auth";
import { getCachedSession } from "../../lib/authStore";
import { takeRecoveryLink } from "../../lib/recoveryLink";

/**
 * Decides whether the app mounts at all.
 *
 * It sits ABOVE `<App>` deliberately. `useAssistantChat` is called once inside
 * App and owns an in-flight turn plus the microphone lifecycle; gating inside
 * App would leave that hook alive behind a login screen, and gating below it
 * would put a surface unmount in the middle of a turn — the exact shape of bug
 * CLAUDE.md documents. Signing out here unmounts the whole tree, which aborts
 * the turn and clears the transcript, both of which are what you want when a
 * different person might be about to sign in.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  // Seeded from cache so a returning user doesn't see the login screen flash
  // while /auth/me is in flight. It is a rendering hint only — the server
  // re-authorizes every request regardless.
  const [session, setSession] = useState<Session | null>(() => getCachedSession());
  const [checking, setChecking] = useState(true);
  // Read once, in a lazy initializer, because reading it CONSUMES it — the
  // token is scrubbed from the URL as it's taken. A plain call in the render
  // body would return the token on the first pass and null on every re-render,
  // which reads as the screen randomly abandoning itself.
  const [recovery, setRecovery] = useState(() => takeRecoveryLink());

  // Pasting a reset link into a tab that already has the app open changes only
  // the fragment, which is a same-document navigation: nothing remounts and no
  // effect re-runs, so the screen would silently never appear. Rare — most
  // links are opened from a mail client, which is a full load — but the failure
  // is invisible rather than noisy, so it's worth one listener.
  useEffect(() => {
    const onHashChange = () => {
      const next = takeRecoveryLink();
      if (next) setRecovery(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await restoreSession();
      if (cancelled) return;
      setSession(resolved);
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // An emailed link outranks everything, signed in or not. Completing a reset
  // revokes every session anyway, so rendering the app behind it would only
  // show state that is about to be invalidated; and the link has to work on
  // whatever device happened to open the mail, which usually has no session.
  if (recovery) return <RecoveryView link={recovery} />;

  // Only block on the very first check, and only when there's nothing cached
  // to show. A user with a valid cached session goes straight into the app and
  // the confirmation happens behind them.
  if (checking && !session) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-400">
        {t("common.loading")}
      </div>
    );
  }

  if (!session) return <AuthView onSignedIn={setSession} />;

  // `key` on the session's user id forces a full remount when a different
  // account signs in, so no view can carry the previous user's rows in state.
  return <div key={session.user.id} className="h-full">{children}</div>;
}
