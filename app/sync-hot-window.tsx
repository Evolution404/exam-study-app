"use client";

import type { SyncHotWindowState } from "@/lib/github-sync";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 1024 * 10 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const formatSyncedAt = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** 设备短标识：取 device_ 之后、第一个 - 之前的部分（device_36b8fad0-… → 36b8fad0），保证在 3 列格子里单行放得下。 */
const shortDeviceId = (deviceId: string) => {
  const core = deviceId.startsWith("device_") ? deviceId.slice("device_".length) : deviceId;
  const dash = core.indexOf("-");
  return dash === -1 ? core : core.slice(0, dash);
};

/**
 * 热窗口状态面板：检查点代数、当前头、分段数、检查点体积（实际/解压）、
 * 设备水位数、上次同步（时间 + 设备短 id，本设备额外标记）与热窗口填充进度。
 * 同步页连接卡与同步抽屉共用，保证两处展示的信息完全一致。
 */
export function SyncHotWindowPanel({ hotWindow, syncedAt }: { hotWindow: SyncHotWindowState | null | undefined; syncedAt?: string | null }) {
  if (!hotWindow) return null;
  const lastSyncLabel = hotWindow.latestSync
    ? `${formatSyncedAt(hotWindow.latestSync.syncedAt)} · ${hotWindow.latestSync.isSelf ? "本设备 " : ""}${shortDeviceId(hotWindow.latestSync.deviceId)}`
    : syncedAt
      ? formatSyncedAt(syncedAt)
      : "—";
  return <dl className="sync-hot-window" role="status" aria-label="热窗口状态">
    <div><dt>检查点</dt><dd>{hotWindow.hasCheckpoint ? `第 ${hotWindow.checkpointGeneration} 代` : "未建立"}</dd></div>
    <div><dt>当前头</dt><dd>第 {hotWindow.generation} 代</dd></div>
    <div><dt>分段</dt><dd>{hotWindow.segmentCount}</dd></div>
    <div><dt>检查点体积</dt><dd>{hotWindow.checkpointSize !== undefined ? (hotWindow.checkpointStoredSize !== undefined && hotWindow.checkpointStoredSize !== hotWindow.checkpointSize ? `${formatBytes(hotWindow.checkpointStoredSize)} / 解压 ${formatBytes(hotWindow.checkpointSize)}` : formatBytes(hotWindow.checkpointSize)) : "—"}</dd></div>
    <div><dt>设备</dt><dd>{hotWindow.deviceCount} 台</dd></div>
    <div><dt>上次同步</dt><dd title={hotWindow.latestSync?.deviceId}>{lastSyncLabel}</dd></div>
    <div className="sync-hot-window-fill"><dt>热窗口</dt><dd><span>{formatBytes(hotWindow.hotBytes)} / {formatBytes(hotWindow.hotBytesMax)}</span><i aria-hidden="true"><b style={{ width: `${Math.min(100, Math.round((hotWindow.hotBytes / hotWindow.hotBytesMax) * 100))}%` }} /></i></dd></div>
  </dl>;
}
