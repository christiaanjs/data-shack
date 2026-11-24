import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * Calls `onEscape` when Escape is pressed anywhere in the document while the caller is mounted.
 * Listening on the document (rather than the dialog element) keeps it working when focus has not
 * yet moved into the dialog, or has moved out of it.
 */
export function useEscape(onEscape: () => void, enabled = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handler.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/**
 * Modal confirmation for destructive actions. Render it only while the confirmation is open.
 *
 * Cancel is focused by default so a stray Enter cannot confirm, and Escape / the backdrop cancel
 * (both disabled while the action is running). A failure from the action is shown inside the
 * dialog so it stays open for a retry.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ComponentChildren;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEscape(onCancel, !busy);

  return (
    <div class="modal modal-open" role="alertdialog" aria-modal="true" aria-label={title}>
      <div class="modal-box space-y-3">
        <h3 class="font-bold text-lg">{title}</h3>
        <div class="text-sm">{message}</div>
        {error && (
          <div role="alert" class="alert alert-error py-2 text-sm">
            <span>{error}</span>
          </div>
        )}
        <div class="modal-action">
          <button
            ref={cancelRef}
            type="button"
            class="btn btn-sm"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="button" class="btn btn-sm btn-error" onClick={onConfirm} disabled={busy}>
            {busy && <span class="loading loading-xs" />}
            {confirmLabel}
          </button>
        </div>
      </div>
      <button
        type="button"
        class="modal-backdrop"
        onClick={() => {
          if (!busy) onCancel();
        }}
        aria-label="Close dialog"
      />
    </div>
  );
}
