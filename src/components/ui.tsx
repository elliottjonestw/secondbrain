import { ReactNode, useEffect } from "react";
import { X, Flag } from "lucide-react";
import { useTranslation } from "react-i18next";

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl dark:bg-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-700"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>
        {children}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  type = "button",
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  type?: "button" | "submit";
  className?: string;
  disabled?: boolean;
}) {
  const styles = {
    default: "bg-neutral-100 text-neutral-800 hover:bg-neutral-200 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600",
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/** Priority levels, indexed 0–3. Labels come from the `priority.*` catalog keys
 * — call `t(priorityKey(n))` rather than hardcoding an English array. */
export function priorityKey(n: number): `priority.${0 | 1 | 2 | 3}` {
  const i = Math.max(0, Math.min(3, n)) as 0 | 1 | 2 | 3;
  return `priority.${i}`;
}

export const PRIORITY_COLORS = [
  "text-neutral-400",
  "text-sky-500",
  "text-amber-500",
  "text-red-500",
];

export function PriorityFlag({ priority }: { priority: number }) {
  const { t } = useTranslation();
  if (!priority) return null;
  return (
    <Flag
      size={14}
      className={PRIORITY_COLORS[priority]}
      fill="currentColor"
      aria-label={t(priorityKey(priority))}
    />
  );
}

export const CATEGORY_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#14b8a6", "#6b7280",
];
