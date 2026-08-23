"use client";
import { Cloud, Home, Library, Link2, ListFilter, Settings2 } from "lucide-react";
import { formatBuildTimestampShort, type View } from "./helpers";

const navItems = [
  { id: "home" as const, label: "今日", icon: Home },
  { id: "banks" as const, label: "题库", icon: Library },
  { id: "practiceSetup" as const, label: "练习", icon: ListFilter },
  { id: "relations" as const, label: "知识整理", icon: Link2 },
  { id: "preferences" as const, label: "配置", icon: Settings2 },
  { id: "settings" as const, label: "同步", icon: Cloud },
];
const mobileNavItems = navItems.filter(({ id }) => id !== "settings").map((item) => item.id === "relations" ? { ...item, label: "整理" } : item);

export function ShellSidebar({ view, open, pending, onOpenView, onClose }: { view: View; open: boolean; pending: number; onOpenView: (view: View) => void; onClose: () => void }) {
  return <>
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
      <div className="brand"><span className="brand-mark">拾</span><span>拾卷</span></div>
      <nav>
        {navItems.map(({ id, label, icon: Icon }) => (
          <button key={id} className={`${view === id ? "nav-active" : ""} ${id === "settings" ? "desktop-sync-nav" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => onOpenView(id)}>
            <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="local-dot" />本地数据已保存
        <small>{pending ? `${pending} 条等待同步` : "没有待同步更改"}</small>
        <small className="sidebar-build"><code>{__APP_COMMIT_SHA__.slice(0, 7)}</code> · {formatBuildTimestampShort()}</small>
      </div>
    </aside>
    <button className={`sidebar-backdrop ${open ? "visible" : ""}`} aria-label="关闭导航" onClick={onClose} />
  </>;
}

export function MobileTabbar({ view, onOpenView }: { view: View; onOpenView: (view: View) => void }) {
  return <nav className={`mobile-tabbar ${view === "practice" ? "hidden" : ""}`} aria-label="手机主导航">
    {mobileNavItems.map(({ id, label, icon: Icon }) => (
      <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => onOpenView(id)}>
        <Icon size={20} strokeWidth={view === id ? 2.2 : 1.8} />
        <span>{label}</span>
      </button>
    ))}
  </nav>;
}
