"use client";

import { useEffect, useRef } from "react";
import { ArrowRightLeft, X } from "lucide-react";
import { ModalPortal } from "@/app/modal-portal";
import {
  SyncEventManager,
  type SyncEventManagerProps,
} from "@/app/sync-event-manager";

export interface SyncEventDrawerProps extends Omit<SyncEventManagerProps, "showBatchSections" | "className"> {
  open: boolean;
  onClose: () => void;
  title?: string;
}

export function SyncEventDrawer({ open, onClose, title = "本次同步", items, ...managerProps }: SyncEventDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;
  const syncingCount = items.filter((item) => item.state === "claimed").length;
  const pendingCount = items.filter((item) => item.state === "pending" || item.state === "blocked").length;
  const committedCount = items.filter((item) => item.state === "committed").length;

  return <ModalPortal>
    <div className="sync-event-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="sync-event-drawer" role="dialog" aria-modal="true" aria-labelledby="sync-event-drawer-title">
        <header className="sync-event-drawer-header">
          <div className="sync-event-drawer-heading"><span><ArrowRightLeft size={19} /></span><div><p>同步队列</p><h2 id="sync-event-drawer-title">{title}</h2><small>{syncingCount ? `正在同步 ${syncingCount} · ` : ""}等待 {pendingCount} · 已同步 {committedCount}</small></div></div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭同步抽屉" onClick={onClose}><X size={19} /></button>
        </header>
        <SyncEventManager {...managerProps} items={items} showBatchSections className="sync-event-drawer-manager" />
      </aside>
    </div>
  </ModalPortal>;
}
