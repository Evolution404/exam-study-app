export interface KeyboardShortcuts {
  enabled: boolean;
  optionKeys: [string, string, string, string, string, string];
  previousKeys: [string, string];
  nextKeys: [string, string];
}

export type KeyboardShortcutAction =
  | { type: "option"; optionIndex: number }
  | { type: "previous" }
  | { type: "next" };

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
  enabled: true,
  optionKeys: ["A", "S", "D", "F", "G", "H"],
  previousKeys: ["E", "K"],
  nextKeys: ["R", "J"],
};

export function normalizeShortcutKey(value: unknown) {
  if (typeof value !== "string") return "";
  return Array.from(value.trim().toLocaleUpperCase("en-US"))[0] ?? "";
}

function normalizeKeyTuple<T extends readonly string[]>(value: unknown, defaults: T): T {
  if (!Array.isArray(value)) return [...defaults] as unknown as T;
  return defaults.map((fallback, index) => typeof value[index] === "string" ? normalizeShortcutKey(value[index]) : fallback) as unknown as T;
}

export function normalizeKeyboardShortcuts(value: unknown): KeyboardShortcuts {
  const input = value && typeof value === "object" ? value as Partial<KeyboardShortcuts> : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_KEYBOARD_SHORTCUTS.enabled,
    optionKeys: normalizeKeyTuple(input.optionKeys, DEFAULT_KEYBOARD_SHORTCUTS.optionKeys),
    previousKeys: normalizeKeyTuple(input.previousKeys, DEFAULT_KEYBOARD_SHORTCUTS.previousKeys),
    nextKeys: normalizeKeyTuple(input.nextKeys, DEFAULT_KEYBOARD_SHORTCUTS.nextKeys),
  };
}

export function shortcutConflicts(shortcuts: KeyboardShortcuts) {
  const counts = new Map<string, number>();
  for (const key of [...shortcuts.optionKeys, ...shortcuts.previousKeys, ...shortcuts.nextKeys]) {
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function resolveKeyboardShortcut(shortcuts: KeyboardShortcuts, key: string): KeyboardShortcutAction | undefined {
  if (!shortcuts.enabled) return undefined;
  if (Array.from(key).length !== 1) return undefined;
  const normalized = normalizeShortcutKey(key);
  if (!normalized || shortcutConflicts(shortcuts).has(normalized)) return undefined;
  const optionIndex = shortcuts.optionKeys.indexOf(normalized);
  if (optionIndex >= 0) return { type: "option", optionIndex };
  if (shortcuts.previousKeys.includes(normalized)) return { type: "previous" };
  if (shortcuts.nextKeys.includes(normalized)) return { type: "next" };
  return undefined;
}
