/**
 * The mail module's public surface. Views and `ai.ts` import from here, never
 * from `client.ts` or `mime.ts` directly — the transport pick and the MIME
 * parser are implementation details, and the credential read lives behind them.
 */
export { DEFAULT_MAILBOX, getMessage, icloudAccount, listFolders, searchMail } from "./mailbox";
export { MailError } from "./types";
export type {
  MailAddress, MailAttachment, MailMessageDetail, MailMessageSummary, MailSearchParams,
} from "./types";
