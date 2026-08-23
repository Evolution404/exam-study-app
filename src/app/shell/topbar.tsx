"use client";
import type { PointerEventHandler } from "react";
import { ChevronRight, LoaderCircle, Menu, RefreshCw } from "lucide-react";
import { QuickSearch } from "@/app/search/quick-search";
import type { SearchContentScope } from "@/app/search/search-matching";
import type { BankV7 } from "@/lib/db/v7-types";
import type { SyncProgress } from "@/lib/sync/sync-application";

type PointerHandler = PointerEventHandler<HTMLButtonElement>;

export function ShellTopbar({ banks, activeBankIds, syncing, restoring, holding, pending, progress, onToggleMenu, onOpenSearch, onSync, onOpenQueue, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture }: {
  banks: BankV7[];
  activeBankIds: string[];
  syncing: boolean;
  restoring: boolean;
  holding: boolean;
  pending: number;
  progress?: SyncProgress;
  onToggleMenu: () => void;
  onOpenSearch: (keyword: string, questionId?: string, contentScope?: SearchContentScope) => void;
  onSync: () => void;
  onOpenQueue: () => void;
  onPointerDown: PointerHandler;
  onPointerMove: PointerHandler;
  onPointerUp: PointerHandler;
  onPointerCancel: PointerHandler;
  onLostPointerCapture: PointerHandler;
}) {
  const busy = syncing || restoring;
  return <>
    <header className="topbar">
      <button className="icon-button mobile-menu" aria-label="打开导航" onClick={onToggleMenu}><Menu size={20} /></button>
      <QuickSearch banks={banks} activeBankIds={activeBankIds} onOpenSearch={onOpenSearch} />
      <div className="quick-sync-split"><button className={`sync-pill quick-sync ${busy ? "syncing" : ""} ${holding ? "holding" : ""}`} disabled={busy} aria-label="单击立即同步，长按恢复本地记录" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onLostPointerCapture={onLostPointerCapture} onContextMenu={(event) => event.preventDefault()} onClick={(event) => { if (event.detail === 0) onSync(); }}><span className="quick-sync-icon"><svg className="quick-sync-progress" viewBox="0 0 32 32" aria-hidden="true"><circle className="track" cx="16" cy="16" r="14" /><circle className="value" cx="16" cy="16" r="14" /></svg>{busy ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}</span><span className="quick-sync-label">{holding ? "恢复" : restoring ? "恢复中" : syncing ? "同步中" : "同步"}</span></button><button className="sync-queue-trigger" type="button" aria-label={`查看本次同步，共 ${pending} 组待同步事件`} onClick={onOpenQueue}>{pending.toLocaleString("zh-CN")}<ChevronRight size={14} /></button></div>
    </header>
    {progress && <div className="top-sync-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><span>{progress.label}<em>{progress.percent}%</em></span><i aria-hidden="true"><b style={{ width: `${progress.percent}%` }} /></i></div>}
  </>;
}
