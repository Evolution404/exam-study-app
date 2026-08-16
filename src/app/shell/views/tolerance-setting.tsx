"use client";
import { useState } from "react";

export function ToleranceSetting({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const parsed = Number(draft);
    const next = Math.min(100, Math.max(0, Number.isFinite(parsed) ? parsed : value));
    setDraft(String(next));
    onChange(next);
  }
  return <label className="preference-row number-preference"><div><strong>计算题允许误差</strong><p>按标准答案的相对误差比例判定；例如答案 100、误差 1% 时，99–101 都算正确。</p></div><span className="number-setting"><input aria-label="计算题允许误差" type="number" min="0" max="100" step="0.1" inputMode="decimal" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>%</em></span></label>;
}
