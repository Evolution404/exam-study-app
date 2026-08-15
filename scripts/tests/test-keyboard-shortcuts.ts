import assert from "node:assert/strict";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  normalizeKeyboardShortcuts,
  resolveKeyboardShortcut,
  shortcutConflicts,
  shortcutFromKeyboardEvent,
} from "../../src/lib/practice/keyboard-shortcuts";
import { shouldSubmitOnChoice } from "../../src/lib/practice/answer-submission";

function key(key: string, modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {}) {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, key("a")), { type: "option", optionIndex: 0 });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, key("H", { shiftKey: true })), { type: "option", optionIndex: 5 });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, key("ArrowLeft")), { type: "previous" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, key("r")), { type: "next" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, key("Enter")), { type: "confirm" });
assert.equal(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, key("Escape")), undefined);

const customized = normalizeKeyboardShortcuts({
  enabled: true,
  bindings: {
    ...DEFAULT_KEYBOARD_SHORTCUTS.bindings,
    confirm: ["Control+Enter", "Space"],
    previous: ["Alt+K"],
    next: ["Meta+Shift+J"],
  },
});
assert.deepEqual(customized.bindings.confirm, ["Control+Enter", "Space"]);
assert.deepEqual(resolveKeyboardShortcut(customized, key("Enter", { ctrlKey: true })), { type: "confirm" });
assert.deepEqual(resolveKeyboardShortcut(customized, key("k", { altKey: true })), { type: "previous" });
assert.deepEqual(resolveKeyboardShortcut(customized, key("J", { metaKey: true, shiftKey: true })), { type: "next" });
assert.equal(shortcutFromKeyboardEvent(key("Shift")), "", "modifier-only presses are not shortcuts");

const conflicted = normalizeKeyboardShortcuts({
  enabled: true,
  bindings: { ...DEFAULT_KEYBOARD_SHORTCUTS.bindings, previous: ["A"] },
});
assert.deepEqual([...shortcutConflicts(conflicted).keys()], ["A"]);
assert.equal(resolveKeyboardShortcut(conflicted, key("A", { shiftKey: true })), undefined);
assert.equal(resolveKeyboardShortcut({ ...DEFAULT_KEYBOARD_SHORTCUTS, enabled: false }, key("Enter")), undefined);

assert.equal(shouldSubmitOnChoice("单选", true), true);
assert.equal(shouldSubmitOnChoice("判断", true), true);
assert.equal(shouldSubmitOnChoice("单选", false), false);
assert.equal(shouldSubmitOnChoice("判断", false), false);
assert.equal(shouldSubmitOnChoice("多选", true), false, "multi-select must always wait for explicit confirmation");

console.log("keyboard and submission tests passed: multiple combos, remapping, conflicts and manual submit mode");
