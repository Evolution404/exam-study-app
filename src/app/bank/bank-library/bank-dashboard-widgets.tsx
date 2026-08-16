"use client";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { percent } from "./bank-library-shared";

export function DashboardMetric({ icon, label, value, suffix, detail, tone, onClick }: { icon: ReactNode; label: string; value: number; suffix?: string; detail: string; tone?: "warning"; onClick: () => void }) {
  return <button className={tone ? `bank-kpi ${tone}` : "bank-kpi"} onClick={onClick}><span>{icon}</span><div><small>{label}</small><strong>{value.toLocaleString()}<em>{suffix}</em></strong><p>{detail}</p></div><ChevronRight size={15} /></button>;
}
export function DashboardNumber({ value, label }: { value: number | string; label: string }) { return <div className="bank-dashboard-number"><strong>{typeof value === "number" ? value.toLocaleString() : value}</strong><span>{label}</span></div>; }
export function PanelTitle({ icon, eyebrow, title }: { icon: ReactNode; eyebrow: string; title: string }) { return <header className="bank-panel-title"><span>{icon}</span><div><small>{eyebrow}</small><h2>{title}</h2></div></header>; }
export function Distribution({ label, count, total, color }: { label: string; count: number; total: number; color: string }) { return <div className="bank-distribution"><span>{label}</span><div><i style={{ width: `${percent(count, total)}%`, background: color }} /></div><strong>{count}<small>{percent(count, total)}%</small></strong></div>; }
export function PriorityButton({ label, count, onClick, wide }: { label: string; count: number; onClick: () => void; wide?: boolean }) { return <button className={wide ? "wide" : ""} onClick={onClick}><span>{label}</span><strong>{count}</strong><ChevronRight size={15} /></button>; }
