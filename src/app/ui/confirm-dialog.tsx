"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, LoaderCircle, X } from "lucide-react";
import { ModalPortal } from "@/app/ui/modal-portal";

export function ConfirmDialog({
  open,
  eyebrow = "请确认",
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  secondaryLabel,
  tone = "default",
  busy = false,
  hideCancel = false,
  progress,
  error,
  onConfirm,
  onSecondary,
  onCancel,
}: {
  open: boolean;
  eyebrow?: string;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryLabel?: string;
  tone?: "default" | "danger" | "success";
  busy?: boolean;
  hideCancel?: boolean;
  progress?: { label: string; percent: number };
  error?: ReactNode;
  onConfirm: () => void;
  onSecondary?: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]:not(:disabled)");
      (initial ?? dialog).focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous) window.requestAnimationFrame(() => { if (previous.isConnected) previous.focus(); });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy && !hideCancel) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, hideCancel, onCancel, open]);

  if (!open) return null;
  const Icon = tone === "danger" ? AlertTriangle : tone === "success" ? CheckCircle2 : HelpCircle;

  return <ModalPortal>
    <div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy && !hideCancel) onCancel();
    }}>
      <section ref={dialogRef} className={`simple-dialog small confirm-dialog ${tone}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
        <header>
          <div><span className="section-kicker">{eyebrow}</span><h2 id={titleId}>{title}</h2></div>
          {!hideCancel && <button className="icon-button" aria-label="关闭确认框" disabled={busy} onClick={onCancel}><X size={17} /></button>}
        </header>
        <div className="confirm-dialog-body"><span className="confirm-dialog-icon"><Icon size={22} /></span><div id={descriptionId}>{description}{progress && <div className="dialog-progress" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span><strong>{progress.label}</strong><em>{progress.percent}%</em></span><i aria-hidden="true"><b style={{ width: `${progress.percent}%` }} /></i></div>}{error && <p className="editor-error confirm-dialog-error" role="alert">{error}</p>}</div></div>
        <footer>
          {!hideCancel && <button data-dialog-initial-focus disabled={busy} onClick={onCancel}>{cancelLabel}</button>}
          {onSecondary && secondaryLabel && <button className="confirm-dialog-secondary" disabled={busy} onClick={onSecondary}>{secondaryLabel}</button>}
          <button data-dialog-initial-focus={hideCancel ? true : undefined} className={tone === "danger" ? "danger-button" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy && <LoaderCircle className="spin" size={17} />}{busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  </ModalPortal>;
}
