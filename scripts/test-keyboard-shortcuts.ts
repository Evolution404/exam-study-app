import assert from "node:assert/strict";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  normalizeKeyboardShortcuts,
  resolveKeyboardShortcut,
  shortcutConflicts,
} from "../lib/keyboard-shortcuts";

assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "a"), { type: "option", optionIndex: 0 });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "H"), { type: "option", optionIndex: 5 });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "e"), { type: "previous" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "K"), { type: "previous" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "r"), { type: "next" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "J"), { type: "next" });

const customized = normalizeKeyboardShortcuts({ optionKeys: ["1", "2", "3", "4", "5", "6"], previousKeys: ["q", "w"], nextKeys: ["o", "p"], enabled: true });
assert.deepEqual(customized.optionKeys, ["1", "2", "3", "4", "5", "6"]);
assert.deepEqual(resolveKeyboardShortcut(customized, "q"), { type: "previous" });

const conflicted = { ...DEFAULT_KEYBOARD_SHORTCUTS, previousKeys: ["A", "K"] as [string, string] };
assert.deepEqual([...shortcutConflicts(conflicted)], ["A"]);
assert.equal(resolveKeyboardShortcut(conflicted, "A"), undefined);
assert.equal(resolveKeyboardShortcut({ ...DEFAULT_KEYBOARD_SHORTCUTS, enabled: false }, "A"), undefined);

console.log("keyboard shortcut tests passed: defaults, customization, conflicts, disabled state");
