import { useId, useState } from "react";
import { BookOpen, CalendarRange, CheckCircle2, Clock3 } from "lucide-react";

type ScopeChipId = "total" | "done" | "pending" | "scope";

function compactScopeLabel(label: string) {
  const rolling = label.match(/^近\s*(\d+)\s*天$/);
  if (rolling) return `${rolling[1]}天`;
  if (label === "全部时间") return "永久";
  return "轮次";
}

export function ScopeSummaryChips({ total, done, scopeLabel, totalLabel = "题目" }: {
  total: number;
  done: number;
  scopeLabel: string;
  totalLabel?: string;
}) {
  const pending = Math.max(0, total - done);
  const [active, setActive] = useState<ScopeChipId>();
  const popoverId = useId();
  const totalHeading = totalLabel === "可用" ? "可用题目" : "题目总数";
  const chips = [
    { id: "total" as const, tone: "total", icon: <BookOpen size={12} />, value: total.toLocaleString(), heading: totalHeading, detail: `当前选择范围内共有 ${total.toLocaleString()} 道题。` },
    { id: "done" as const, tone: "done", icon: <CheckCircle2 size={12} />, value: done.toLocaleString(), heading: "已做题目", detail: `${scopeLabel}内至少作答过一次，共 ${done.toLocaleString()} 道题。` },
    { id: "pending" as const, tone: "pending", icon: <Clock3 size={12} />, value: pending.toLocaleString(), heading: "未做题目", detail: `${scopeLabel}内尚无作答记录，共 ${pending.toLocaleString()} 道题。` },
    { id: "scope" as const, tone: "scope", icon: <CalendarRange size={12} />, value: compactScopeLabel(scopeLabel), heading: "统计周期", detail: `已做和未做按“${scopeLabel}”计算。` },
  ];
  const explanation = chips.find((chip) => chip.id === active);
  return <div className="scope-summary-chips" aria-label={`统计范围：${scopeLabel}，共 ${total} 题，已做 ${done} 题，未做 ${pending} 题`}>
    {chips.map((chip) => <button type="button" key={chip.id} className={`scope-summary-chip tone-${chip.tone}`} aria-label={`${chip.heading}：${chip.value}`} aria-expanded={active === chip.id} aria-describedby={active === chip.id ? popoverId : undefined} title={`点击查看${chip.heading}说明`} onClick={() => setActive(active === chip.id ? undefined : chip.id)} onKeyDown={(event) => { if (event.key === "Escape") { setActive(undefined); event.currentTarget.blur(); } }} onBlur={() => setActive(undefined)}>{chip.icon}<strong>{chip.value}</strong></button>)}
    {explanation && <span id={popoverId} className="scope-summary-popover" role="tooltip"><strong>{explanation.heading}</strong><small>{explanation.detail}</small></span>}
  </div>;
}
