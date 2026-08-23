export type KeyboardShortcutActionId =
  | "optionA" | "optionB" | "optionC" | "optionD" | "optionE" | "optionF"
  | "confirm" | "previous" | "next";

export interface KeyboardShortcuts {
  enabled: boolean;
  bindings: Record<KeyboardShortcutActionId, string[]>;
}

export type KeyboardShortcutAction =
  | { type: "option"; optionIndex: number }
  | { type: "previous" }
  | { type: "next" }
  | { type: "confirm" };

export const KEYBOARD_SHORTCUT_ACTIONS: Array<{ id: KeyboardShortcutActionId; label: string; detail: string }> = [
  { id: "optionA", label: "选择选项 A", detail: "选择当前显示的第一个选项" },
  { id: "optionB", label: "选择选项 B", detail: "选择当前显示的第二个选项" },
  { id: "optionC", label: "选择选项 C", detail: "选择当前显示的第三个选项" },
  { id: "optionD", label: "选择选项 D", detail: "选择当前显示的第四个选项" },
  { id: "optionE", label: "选择选项 E", detail: "选择当前显示的第五个选项" },
  { id: "optionF", label: "选择选项 F", detail: "选择当前显示的第六个选项" },
  { id: "confirm", label: "确认答案", detail: "提交当前已经选择的答案" },
  { id: "previous", label: "上一题", detail: "切换到上一道题" },
  { id: "next", label: "下一题", detail: "切换到下一道题" },
];

const DEFAULT_BINDINGS: KeyboardShortcuts["bindings"] = {
  optionA: ["A"], optionB: ["S"], optionC: ["D"], optionD: ["F"], optionE: ["G"], optionF: ["H"],
  confirm: ["Enter"], previous: ["ArrowLeft", "E"], next: ["ArrowRight", "R"],
};

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
  enabled: true,
  bindings: Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([id, values]) => [id, [...values]])) as KeyboardShortcuts["bindings"],
};

const MODIFIER_ORDER = ["Meta", "Control", "Alt", "Shift"] as const;
const MODIFIER_KEYS = new Set<string>([...MODIFIER_ORDER, "OS", "AltGraph"]);
const KEY_ALIASES: Record<string, string> = {
  " ": "Space", Spacebar: "Space", Esc: "Escape", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown",
  Del: "Delete", Return: "Enter", OS: "Meta",
};

function normalizeBaseKey(value: string) {
  const key = KEY_ALIASES[value] ?? value;
  if (key.length === 1) return key.toLocaleUpperCase("en-US");
  return key;
}

function normalizeKeyboardShortcut(value: unknown) {
  if (typeof value !== "string") return "";
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return "";
  const modifiers = new Set(parts.slice(0, -1).map((part) => part === "Ctrl" ? "Control" : part === "Cmd" || part === "Command" ? "Meta" : part));
  const base = normalizeBaseKey(parts.at(-1)!);
  if (!base || MODIFIER_KEYS.has(base)) return "";
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), base].join("+");
}

export function shortcutFromKeyboardEvent(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  const base = normalizeBaseKey(event.key);
  if (!base || MODIFIER_KEYS.has(base)) return "";
  const modifiers = [event.metaKey && "Meta", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean) as string[];
  if (base.length === 1 && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) modifiers.splice(modifiers.indexOf("Shift"), 1);
  return normalizeKeyboardShortcut([...modifiers, base].join("+"));
}

export function formatKeyboardShortcut(value: string) {
  return value.replace(/Meta/g, "⌘").replace(/Control/g, "Ctrl").replace(/Alt/g, "Alt").replace(/Shift/g, "Shift").replace(/ArrowLeft/g, "←").replace(/ArrowRight/g, "→").replace(/ArrowUp/g, "↑").replace(/ArrowDown/g, "↓").replace(/Space/g, "空格");
}

function normalizeBindings(input: unknown): KeyboardShortcuts["bindings"] {
  const record = input && typeof input === "object" ? input as Partial<Record<KeyboardShortcutActionId, unknown>> : {};
  return Object.fromEntries(KEYBOARD_SHORTCUT_ACTIONS.map(({ id }) => {
    const source = Array.isArray(record[id]) ? record[id] : DEFAULT_BINDINGS[id];
    const values = [...new Set(source.map(normalizeKeyboardShortcut).filter(Boolean))];
    return [id, values];
  })) as KeyboardShortcuts["bindings"];
}

export function normalizeKeyboardShortcuts(value: unknown): KeyboardShortcuts {
  const input = value && typeof value === "object" ? value as Partial<KeyboardShortcuts> : {};
  return { enabled: typeof input.enabled === "boolean" ? input.enabled : true, bindings: normalizeBindings(input.bindings) };
}

export function shortcutConflicts(shortcuts: KeyboardShortcuts) {
  const owners = new Map<string, KeyboardShortcutActionId[]>();
  for (const { id } of KEYBOARD_SHORTCUT_ACTIONS) {
    for (const shortcut of shortcuts.bindings[id]) owners.set(shortcut, [...(owners.get(shortcut) ?? []), id]);
  }
  return new Map([...owners].filter(([, actions]) => actions.length > 1));
}

export function resolveKeyboardShortcut(shortcuts: KeyboardShortcuts, event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): KeyboardShortcutAction | undefined {
  if (!shortcuts.enabled) return undefined;
  const shortcut = shortcutFromKeyboardEvent(event);
  if (!shortcut || shortcutConflicts(shortcuts).has(shortcut)) return undefined;
  const id = KEYBOARD_SHORTCUT_ACTIONS.find((action) => shortcuts.bindings[action.id].includes(shortcut))?.id;
  if (!id) return undefined;
  if (id.startsWith("option")) return { type: "option", optionIndex: id.charCodeAt(id.length - 1) - 65 };
  return { type: id } as KeyboardShortcutAction;
}
