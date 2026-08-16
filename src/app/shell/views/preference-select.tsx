"use client";
import { AppSelect } from "@/app/ui/app-select";

export function PreferenceSelect({ title, detail, value, options, onChange }: { title: string; detail: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  const selectId = `preference-select-${title}`;
  return <label htmlFor={selectId} className="preference-row select-preference"><div><strong>{title}</strong><p>{detail}</p></div><AppSelect id={selectId} ariaLabel={title} value={value} onValueChange={onChange} options={options.map(([optionValue, label]) => ({ value: optionValue, label }))} /></label>;
}
