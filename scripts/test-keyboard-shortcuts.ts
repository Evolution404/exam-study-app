import assert from "node:assert/strict";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  normalizeKeyboardShortcuts,
  resolveKeyboardShortcut,
  shortcutConflicts,
} from "../lib/keyboard-shortcuts";
import { shouldSubmitOnChoice } from "../lib/answer-submission";

assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "a"), { type: "option", optionIndex: 0 });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "H"), { type: "option", optionIndex: 5 });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "e"), { type: "previous" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "K"), { type: "previous" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "r"), { type: "next" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "J"), { type: "next" });
assert.deepEqual(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "Enter"), { type: "confirm" });
assert.equal(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "ArrowLeft"), undefined, "ArrowLeft must not be truncated to the A option shortcut");
assert.equal(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "ArrowRight"), undefined, "ArrowRight must remain a navigation-only key");
assert.equal(resolveKeyboardShortcut(DEFAULT_KEYBOARD_SHORTCUTS, "Escape"), undefined, "unmapped named control keys must not be interpreted as character shortcuts");

const customized = normalizeKeyboardShortcuts({ optionKeys: ["1", "2", "3", "4", "5", "6"], previousKeys: ["q", "w"], nextKeys: ["o", "p"], enabled: true });
assert.deepEqual(customized.optionKeys, ["1", "2", "3", "4", "5", "6"]);
assert.deepEqual(resolveKeyboardShortcut(customized, "q"), { type: "previous" });

const conflicted = { ...DEFAULT_KEYBOARD_SHORTCUTS, previousKeys: ["A", "K"] as [string, string] };
assert.deepEqual([...shortcutConflicts(conflicted)], ["A"]);
assert.equal(resolveKeyboardShortcut(conflicted, "A"), undefined);
assert.equal(resolveKeyboardShortcut({ ...DEFAULT_KEYBOARD_SHORTCUTS, enabled: false }, "A"), undefined);
assert.equal(resolveKeyboardShortcut({ ...DEFAULT_KEYBOARD_SHORTCUTS, enabled: false }, "Enter"), undefined);

assert.equal(shouldSubmitOnChoice("单选", true), true);
assert.equal(shouldSubmitOnChoice("判断", true), true);
assert.equal(shouldSubmitOnChoice("单选", false), false);
assert.equal(shouldSubmitOnChoice("判断", false), false);
assert.equal(shouldSubmitOnChoice("多选", true), false, "multi-select must always wait for explicit confirmation");

console.log("keyboard and submission tests passed: Enter confirmation, defaults, customization, conflicts and manual submit mode");
