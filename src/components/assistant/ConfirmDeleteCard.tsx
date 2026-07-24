// The confirmation card the assistant shows before running a delete tool.
//
// F-01 hardening: every `delete_*` tool pauses the agentic loop on this card,
// and only proceeds when the user clicks Delete. No text in the model's context
// can authorise a delete — only this click can. The card carries identity the
// executor derived from the looked-up row (not whatever the model claimed), so
// the user is always confirming the real item.
//
// It is transient: it lives only while a delete is pending, renders at the foot
// of the transcript (not attached to any persisted message), and disappears the
// moment the user resolves it. Built on the same `Button` primitives the rest
// of the app uses for destructive actions, so it reads as part of the UI rather
// than a foreign dialog.

import { useState } from "react";
import { Trash2, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import type { ConfirmDeleteRequest } from "../../lib/ai";

export default function ConfirmDeleteCard({
  req,
  onResolve,
}: {
  req: ConfirmDeleteRequest;
  /** Delivers the user's decision and dismisses the card. */
  onResolve: (approved: boolean) => void;
}) {
  const { t } = useTranslation();
  // Lock both buttons the moment one is clicked: a double-click (or a click on
  // Cancel racing the Stop button) must not resolve the same pending Promise
  // twice — the second resolve is a no-op against the resolver ref, but the UI
  // would still flash both states.
  const [resolved, setResolved] = useState<"" | "approve" | "deny">("");

  const resolve = (approved: boolean) => {
    if (resolved) return;
    setResolved(approved ? "approve" : "deny");
    onResolve(approved);
  };

  const labelKey = `assistant.confirmDelete.type.${req.type}` as const;
  const typeLabel = t(labelKey);
  const title = t("assistant.confirmDelete.title", { type: typeLabel });

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50/60 p-3 shadow-sm dark:border-red-900/50 dark:bg-red-900/10"
      role="alertdialog"
      aria-label={title}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-red-700 dark:text-red-300">{title}</div>
          <div className="mt-0.5 truncate text-sm text-neutral-700 dark:text-neutral-200" title={req.label}>
            {req.label || t("assistant.confirmDelete.untitled")}
          </div>
          {req.sub && (
            <div className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">{req.sub}</div>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => resolve(false)} disabled={!!resolved}>
          {resolved === "deny" ? t("assistant.confirmDelete.cancelled") : t("assistant.confirmDelete.cancel")}
        </Button>
        <Button variant="danger" onClick={() => resolve(true)} disabled={!!resolved}>
          <span className="flex items-center gap-1.5">
            <Trash2 size={14} />
            {resolved === "approve" ? t("assistant.confirmDelete.deleting") : t("common.delete")}
          </span>
        </Button>
      </div>
    </div>
  );
}
