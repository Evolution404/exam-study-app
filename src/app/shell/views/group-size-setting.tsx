"use client";
import { useState } from "react";

export function GroupSizeSetting({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  function commit() {
    const next = Math.min(500, Math.max(1, Math.floor(Number(draft) || value || 30)));
    setDraft(String(next));
    onChange(next);
  }
  return <label className="preference-row number-preference"><div><strong>每组题目数量</strong><p>用于首页推荐和“随机一组”练习；可填写 1–500 题。</p></div><span className="number-setting"><input aria-label="每组题目数量" type="number" min="1" max="500" step="1" inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>题</em></span></label>;
}
