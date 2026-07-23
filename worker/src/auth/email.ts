import type { Bindings } from "../env";

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
export async function sendEmail(env: Bindings, msg: Message): Promise<void> {
  if (!env.RESEND_API_KEY) throw new EmailNotConfigured();

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
  });
}

export async function sendVerificationEmail(
  env: Bindings,
  to: string,
  token: string,
): Promise<void> {
  await sendEmail(env, {
    to,
    subject: "Confirm your Sekunda email address",
    text:
      `Open this link to confirm this address:\n\n${verifyLink(env.APP_URL, token)}\n\n` +
      `The link works once and expires in 24 hours.\n\n` +
      `Confirming means we can reach you if you ever forget your password. ` +
      `If you didn't create a Sekunda account, ignore this message.`,
  });
}
