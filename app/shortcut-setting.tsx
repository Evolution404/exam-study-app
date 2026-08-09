import { KeyRound, RotateCcw } from "lucide-react";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  normalizeShortcutKey,
  shortcutConflicts,
  type KeyboardShortcuts,
} from "@/lib/keyboard-shortcuts";

const optionLabels = ["A", "B", "C", "D", "E", "F"];

export function ShortcutSetting({ value, onChange }: { value: KeyboardShortcuts; onChange: (value: KeyboardShortcuts) => void }) {
  const conflicts = shortcutConflicts(value);

  function updateKeys(field: "optionKeys" | "previousKeys" | "nextKeys", index: number, key: string) {
    const keys = [...value[field]];
    keys[index] = normalizeShortcutKey(key);
    onChange({ ...value, [field]: keys });
  }

  function keyInput(field: "optionKeys" | "previousKeys" | "nextKeys", index: number, label: string) {
    const key = value[field][index];
    return <input
      aria-label={label}
      className={conflicts.has(key) ? "conflict" : ""}
      inputMode="text"
      maxLength={1}
      value={key}
      onChange={(event) => updateKeys(field, index, event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
    />;
  }

  return <section className="preference-card shortcut-preference-card">
    <div className="settings-title"><span><KeyRound /></span><div><h2>电脑快捷键</h2><p>答题页生效；输入解析、搜索或编辑题目时会自动停用。</p></div></div>
    <label className="preference-row shortcut-enabled"><div><strong>启用快捷键</strong><p>方向键仍可用于上一题和下一题。</p></div><input aria-label="启用电脑快捷键" type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    <div className={`shortcut-editor ${value.enabled ? "" : "disabled"}`} aria-disabled={!value.enabled}>
      <div className="shortcut-group"><div><strong>选择选项</strong><small>按显示顺序对应 A–F</small></div><div className="shortcut-option-grid">{optionLabels.map((label, index) => <label key={label}><span>选项 {label}</span>{keyInput("optionKeys", index, `选项 ${label} 快捷键`)}</label>)}</div></div>
      <div className="shortcut-navigation-grid"><div><strong>上一题</strong><span>{keyInput("previousKeys", 0, "上一题快捷键一")}{keyInput("previousKeys", 1, "上一题快捷键二")}</span></div><div><strong>下一题</strong><span>{keyInput("nextKeys", 0, "下一题快捷键一")}{keyInput("nextKeys", 1, "下一题快捷键二")}</span></div></div>
      {conflicts.size > 0 && <p className="shortcut-conflict">按键冲突：{[...conflicts].join("、")}。冲突按键在答题时不会执行。</p>}
      <button className="shortcut-reset" type="button" onClick={() => onChange({ ...DEFAULT_KEYBOARD_SHORTCUTS, optionKeys: [...DEFAULT_KEYBOARD_SHORTCUTS.optionKeys], previousKeys: [...DEFAULT_KEYBOARD_SHORTCUTS.previousKeys], nextKeys: [...DEFAULT_KEYBOARD_SHORTCUTS.nextKeys] })}><RotateCcw size={15} />恢复默认快捷键</button>
    </div>
  </section>;
}
