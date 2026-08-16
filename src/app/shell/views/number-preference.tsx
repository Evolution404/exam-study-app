"use client";
import { useState } from "react";

export function NumberPreference({ title, detail, value, min, max, unit, onChange }: { title: string; detail: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const next = Math.min(max, Math.max(min, Math.floor(Number(draft) || value)));
    setDraft(String(next));
    onChange(next);
  };
  return <label className="preference-row number-preference"><div><strong>{title}</strong><p>{detail}</p></div><span className="number-setting"><input aria-label={title} type="number" min={min} max={max} inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><em>{unit}</em></span></label>;
}
