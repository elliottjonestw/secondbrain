import type { Bindings } from "../env";
import { QUOTA_LIMITS, consumeDailyQuota } from "../db/quota";

/**
 * Outbound transactional mail, via Resend.
 *
 * Resend rather than MailChannels because MailChannels stopped being free for
 * Workers; rather than SES/Postmark/SendGrid because those want a card or a
 * sales conversation, and this account is deliberately card-free (see
 * CLAUDE.md). Its free tier is ~100 messages a day, which is far more than
 * password resets for a handful of users will ever need.
 *
 * Only two messages are ever sent, both containing a single-use token, and
 * neither contains any of the user's data. That is worth stating because it is
 * what keeps handing a third party our users' addresses proportionate.
 */

/** Thrown when the environment has no API key. Callers must turn this into a
 *  response that is identical for every address — see `routes/auth.ts`. */
export class EmailNotConfigured extends Error {
  constructor() {
    super("RESEND_API_KEY is not set for this environment");
    this.name = "EmailNotConfigured";
  }
}

/**
 * Thrown when today's mail budget is gone (see `db/quota.ts`).
 *
 * Distinct from `EmailNotConfigured` so the logs can tell "this deployment
 * can't send mail" apart from "this deployment has sent all it may today" —
 * the first is a config error and the second is very likely someone abusing
 * the sign-up form. Callers treat both the same way in the RESPONSE, because
 * the alternative is an oracle: a caller who can tell that their own request
 * was refused for budget can tell that the address was real.
 */
export class MailBudgetExhausted extends Error {
  constructor() {
    super("The daily outbound mail budget is spent");
    this.name = "MailBudgetExhausted";
  }
}

interface Message {
  to: string;
  subject: string;
  text: string;
}

/**
 * Send one message. Throws on any failure, including a non-2xx from Resend.
 *
 * Nothing here is logged. The body carries a live reset token and the `to`
 * carries an address, and `[observability]` is on — the same rule that governs
 * routes/dav.ts applies for the same reason. The Resend error *status* is
 * safe to surface to our own logs; its body is not, because Resend echoes the
 * submitted message back in some error shapes.
 */
export async function sendEmail(env: Bindings, msg: Message, ip: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new EmailNotConfigured();

  // The daily budget is enforced HERE rather than per-route on purpose. Every
  // route that mails already carries a per-minute EMAIL_LIMIT, and that is the
  // pattern a new endpoint will copy; what it will not reliably copy is a
  // second, differently-shaped check. Putting the ceiling at the one place the
  // money is actually spent makes forgetting it impossible.
  //
  // Order matters: the IP bucket is consumed first, so a caller who is already
  // over their own share cannot also draw down the global budget. Both count
  // the attempt rather than the send, which means abuse trips the breaker
  // slightly early — the conservative direction for a ceiling whose whole job
  // is to not be crossed.
  //
  // A D1 failure propagates and no mail goes out. Failing open here would
  // reintroduce exactly the unbounded spend this exists to stop, and every
  // caller already treats a mail failure as survivable.
  if (!(await consumeDailyQuota(env.DB, `mail:ip:${ip}`, QUOTA_LIMITS.mailIp))) {
    throw new MailBudgetExhausted();
  }
  if (!(await consumeDailyQuota(env.DB, "mail:global", QUOTA_LIMITS.mailGlobal))) {
    throw new MailBudgetExhausted();
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
    }),
  });

  if (!res.ok) throw new Error(`Resend rejected the message (${res.status})`);
}

/**
 * The links.
 *
 * A token rides in the URL **fragment**, not the query string. A fragment is
 * never sent to a server and never appears in a `Referer`, so the token cannot
 * leak to GitHub Pages' logs, to any third-party script the page loads, or to
 * whatever site the user clicks through to next. A `?token=` would be the
 * conventional choice and is measurably worse.
 */
function resetLink(appUrl: string, token: string): string {
  return `${appUrl}#reset=${encodeURIComponent(token)}`;
}

function verifyLink(appUrl: string, token: string): string {
  return `${appUrl}#verify=${encodeURIComponent(token)}`;
}

/**
 * Both bodies are plain text and deliberately dull.
 *
 * English only, and not routed through `t()`: this text is composed in the
 * Worker, which has no locale catalogue and no reliable signal for the
 * recipient's language — the request that triggers it may not even come from
 * them. Localising it means storing a language preference per account, which
 * is a feature, not a formatting detail.
 */
export async function sendPasswordResetEmail(
  env: Bindings,
  to: string,
  token: string,
  ip: string,
): Promise<void> {
  await sendEmail(env, {
    to,
    subject: "Reset your Sekunda password",
    text:
      `Open this link to choose a new password:\n\n${resetLink(env.APP_URL, token)}\n\n` +
      `The link works once and expires in 30 minutes.\n\n` +
      `If you didn't ask for this, you can ignore it — nothing has changed, and ` +
      `whoever asked cannot see this message.\n\n` +
      `Note that resetting your password signs you out on every device.`,
  }, ip);
}

export async function sendVerificationEmail(
  env: Bindings,
  to: string,
  token: string,
  ip: string,
): Promise<void> {
  await sendEmail(env, {
    to,
    subject: "Confirm your Sekunda email address",
    text:
      `Open this link to confirm this address:\n\n${verifyLink(env.APP_URL, token)}\n\n` +
      `The link works once and expires in 24 hours.\n\n` +
      `Confirming means we can reach you if you ever forget your password. ` +
      `If you didn't create a Sekunda account, ignore this message.`,
  }, ip);
}
