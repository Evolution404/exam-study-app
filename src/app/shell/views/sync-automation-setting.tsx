"use client";
import { Cloud } from "lucide-react";
import type { PracticePreferences } from "../helpers";
import { NumberPreference } from "./number-preference";

export function SyncAutomationSetting({ preferences, onChange }: { preferences: PracticePreferences; onChange: (value: PracticePreferences) => void }) {
  return <section className="preference-card"><div className="settings-title"><span><Cloud /></span><div><h2>后台同步</h2><p>两项功能默认关闭，开启后使用 v7 变更集和热窗口增量同步。</p></div></div><div className="preference-list">
    <label className="preference-row"><div><strong>累计事件后自动同步</strong><p>本地待同步事件达到设定数量时，在后台完成拉取、合并和上传。</p></div><input aria-label="累计事件后自动同步" type="checkbox" checked={preferences.autoSyncEnabled} onChange={(event) => onChange({ ...preferences, autoSyncEnabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    {preferences.autoSyncEnabled && <NumberPreference title="自动同步阈值" detail="本地累计多少条待同步事件后开始同步，可填写 1–1000。" value={preferences.autoSyncEventThreshold} min={1} max={1000} unit="条" onChange={(autoSyncEventThreshold) => onChange({ ...preferences, autoSyncEventThreshold })} />}
    <label className="preference-row"><div><strong>定期拉取远程数据</strong><p>只下载并合并其他设备的新数据，不会主动上传当前设备的数据。</p></div><input aria-label="定期拉取远程数据" type="checkbox" checked={preferences.periodicPullEnabled} onChange={(event) => onChange({ ...preferences, periodicPullEnabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    {preferences.periodicPullEnabled && <NumberPreference title="远程拉取间隔" detail="最短 30 秒；页面保持打开时生效。" value={preferences.periodicPullSeconds} min={30} max={86400} unit="秒" onChange={(periodicPullSeconds) => onChange({ ...preferences, periodicPullSeconds })} />}
  </div></section>;
}
