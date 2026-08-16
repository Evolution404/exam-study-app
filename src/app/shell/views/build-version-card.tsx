"use client";
import { BadgeInfo } from "lucide-react";
import { formatBuildTimestamp } from "../helpers";

export function BuildVersionCard() {
  const builtAt = formatBuildTimestamp();
  return <section className="preference-card version-card"><div className="settings-title"><span><BadgeInfo /></span><div><h2>客户端版本</h2><p>用于确认当前设备是否已经加载最新发布版本。</p></div></div><dl><div><dt>提交哈希</dt><dd><code>{__APP_COMMIT_SHA__.slice(0, 12)}</code></dd></div><div><dt>提交时间</dt><dd>{builtAt}</dd></div></dl></section>;
}
