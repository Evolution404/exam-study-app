import { useEffect, useRef, useState } from "react";
import { KeyRound, Plus, RotateCcw, X } from "lucide-react";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  formatKeyboardShortcut,
  KEYBOARD_SHORTCUT_ACTIONS,
  shortcutConflicts,
  shortcutFromKeyboardEvent,
  type KeyboardShortcutActionId,
  type KeyboardShortcuts,
} from "@/lib/keyboard-shortcuts";

export function ShortcutSetting({ value, onChange }: { value: KeyboardShortcuts; onChange: (value: KeyboardShortcuts) => void }) {
  const [capturing, setCapturing] = useState<KeyboardShortcutActionId>();
  const captureRef = useRef<HTMLButtonElement>(null);
  const conflicts = shortcutConflicts(value);

  useEffect(() => { if (capturing) captureRef.current?.focus(); }, [capturing]);

  function removeShortcut(id: KeyboardShortcutActionId, shortcut: string) {
    onChange({ ...value, bindings: { ...value.bindings, [id]: value.bindings[id].filter((item) => item !== shortcut) } });
  }

  function capture(event: React.KeyboardEvent, id: KeyboardShortcutActionId) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { setCapturing(undefined); return; }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) return;
    onChange({ ...value, bindings: { ...value.bindings, [id]: [...new Set([...value.bindings[id], shortcut])] } });
    setCapturing(undefined);
  }

  return <section className="preference-card shortcut-preference-card">
    <div className="settings-title"><span><KeyRound /></span><div><h2>电脑快捷键</h2><p>每个功能可绑定多个普通键或组合键；点击添加后直接按下想使用的快捷键。</p></div></div>
    <label className="preference-row shortcut-enabled"><div><strong>启用快捷键</strong><p>输入框、编辑器和弹窗打开时会自动暂停。</p></div><input aria-label="启用电脑快捷键" type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} /><span className="toggle" aria-hidden="true" /></label>
    <div className={`shortcut-editor shortcut-binding-editor ${value.enabled ? "" : "disabled"}`} aria-disabled={!value.enabled}>
      <div className="shortcut-binding-list">{KEYBOARD_SHORTCUT_ACTIONS.map((action) => <div className="shortcut-binding-row" key={action.id}><div><strong>{action.label}</strong><small>{action.detail}</small></div><div className="shortcut-binding-values">{value.bindings[action.id].map((shortcut) => <span className={conflicts.has(shortcut) ? "conflict" : ""} key={shortcut}><kbd>{formatKeyboardShortcut(shortcut)}</kbd><button type="button" aria-label={`删除 ${action.label} 的 ${formatKeyboardShortcut(shortcut)}`} onClick={() => removeShortcut(action.id, shortcut)}><X size={12} /></button></span>)}{capturing === action.id ? <button ref={captureRef} type="button" className="shortcut-capture active" onKeyDown={(event) => capture(event, action.id)} onBlur={() => setCapturing(undefined)}>请按快捷键…</button> : <button type="button" className="shortcut-capture" onClick={() => setCapturing(action.id)}><Plus size={13} />添加</button>}</div></div>)}</div>
      {conflicts.size > 0 && <p className="shortcut-conflict">存在冲突：{[...conflicts.keys()].map(formatKeyboardShortcut).join("、")}。冲突组合不会执行。</p>}
      <button className="shortcut-reset" type="button" onClick={() => onChange(normalizeDefaults())}><RotateCcw size={15} />恢复默认快捷键</button>
    </div>
  </section>;
}

function normalizeDefaults(): KeyboardShortcuts {
  return { enabled: DEFAULT_KEYBOARD_SHORTCUTS.enabled, bindings: Object.fromEntries(Object.entries(DEFAULT_KEYBOARD_SHORTCUTS.bindings).map(([id, values]) => [id, [...values]])) as KeyboardShortcuts["bindings"] };
}
