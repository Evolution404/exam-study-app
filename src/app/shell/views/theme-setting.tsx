"use client";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { PracticePreferences } from "../helpers";

export function ThemeSetting({ value, onChange }: { value: PracticePreferences["themeMode"]; onChange: (value: PracticePreferences["themeMode"]) => void }) {
  const choices: Array<{ value: PracticePreferences["themeMode"]; label: string; detail: string; icon: React.ReactNode }> = [
    { value: "system", label: "跟随系统", detail: "随系统自动切换", icon: <Monitor size={19} /> },
    { value: "light", label: "浅色", detail: "始终使用浅色", icon: <Sun size={19} /> },
    { value: "dark", label: "深色", detail: "始终使用夜间模式", icon: <Moon size={19} /> },
  ];
  return <div className="theme-setting" role="radiogroup" aria-label="外观主题">{choices.map((choice) => <button type="button" role="radio" aria-checked={value === choice.value} className={value === choice.value ? "active" : ""} key={choice.value} onClick={() => onChange(choice.value)}><span>{choice.icon}</span><strong>{choice.label}</strong><small>{choice.detail}</small>{value === choice.value && <Check size={15} />}</button>)}</div>;
}
