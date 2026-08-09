"use client";

import { useEffect, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, LoaderCircle, X } from "lucide-react";
import { ModalPortal } from "@/app/modal-portal";

export function ConfirmDialog({
  open,
  eyebrow = "请确认",
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "default",
  busy = false,
  hideCancel = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  eyebrow?: string;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger" | "success";
  busy?: boolean;
  hideCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open || busy || hideCancel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [busy, hideCancel, onCancel, open]);

  if (!open) return null;
  const Icon = tone === "danger" ? AlertTriangle : tone === "success" ? CheckCircle2 : HelpCircle;

  return <ModalPortal>
    <div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy && !hideCancel) onCancel();
    }}>
      <section className={`simple-dialog small confirm-dialog ${tone}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <header>
          <div><span className="section-kicker">{eyebrow}</span><h2 id="confirm-dialog-title">{title}</h2></div>
          {!hideCancel && <button className="icon-button" aria-label="关闭确认框" disabled={busy} onClick={onCancel}><X size={17} /></button>}
        </header>
        <div className="confirm-dialog-body"><span className="confirm-dialog-icon"><Icon size={22} /></span><div>{description}</div></div>
        <footer>
          {!hideCancel && <button disabled={busy} onClick={onCancel}>{cancelLabel}</button>}
          <button className={tone === "danger" ? "danger-button" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy && <LoaderCircle className="spin" size={17} />}{busy ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  </ModalPortal>;
}
