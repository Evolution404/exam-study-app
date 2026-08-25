from pathlib import Path
import json

# 1) Checkpoint validator must consume the one canonical QuestionType list.
checkpoint = Path("src/lib/sync/sync-v7-checkpoint.ts")
text = checkpoint.read_text()
import_marker = 'import { SYNC_V7_ASSET_PREFIX } from "./sync-v7-head";\n'
question_import = 'import { QUESTION_TYPE_ORDER } from "../../types/types";\n'
if question_import not in text:
    if import_marker not in text:
        raise SystemExit("checkpoint import marker not found")
    text = text.replace(import_marker, import_marker + question_import, 1)
const_marker = 'const SHA1 = /^[a-f0-9]{40}$/;\n'
question_set = 'const QUESTION_TYPES = new Set<string>(QUESTION_TYPE_ORDER);\n'
if question_set not in text:
    if const_marker not in text:
        raise SystemExit("checkpoint constant marker not found")
    text = text.replace(const_marker, const_marker + question_set, 1)
old_validation = '  if (!["判断", "单选", "多选", "计算"].includes(String(value.type))) fail(`state.questions[${index}].type is invalid`);\n'
new_validation = '  if (!QUESTION_TYPES.has(String(value.type))) fail(`state.questions[${index}].type is invalid`);\n'
if old_validation in text:
    text = text.replace(old_validation, new_validation, 1)
elif new_validation not in text:
    raise SystemExit("checkpoint question-type validator marker not found")
checkpoint.write_text(text)

# 2) Exact structural comparison: no JSON string allocation and no false writes
# when property insertion order differs. This intentionally preserves exact value
# semantics; it does not assume updatedAt/revision is a complete version token.
reconcile = Path("src/lib/db/db-v7-reconcile.ts")
text = reconcile.read_text()
old_equal = '''function equivalent(left: unknown, right: unknown): boolean {\n  return JSON.stringify(left) === JSON.stringify(right);\n}\n'''
new_equal = '''function equivalent(left: unknown, right: unknown): boolean {\n  if (Object.is(left, right)) return true;\n  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;\n  if (Array.isArray(left) || Array.isArray(right)) {\n    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;\n    for (let index = 0; index < left.length; index += 1) {\n      if (!equivalent(left[index], right[index])) return false;\n    }\n    return true;\n  }\n  if (left instanceof Date || right instanceof Date) {\n    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();\n  }\n  const leftRecord = left as Record<string, unknown>;\n  const rightRecord = right as Record<string, unknown>;\n  const leftKeys = Object.keys(leftRecord);\n  const rightKeys = Object.keys(rightRecord);\n  if (leftKeys.length !== rightKeys.length) return false;\n  for (const key of leftKeys) {\n    if (!Object.prototype.hasOwnProperty.call(rightRecord, key) || !equivalent(leftRecord[key], rightRecord[key])) return false;\n  }\n  return true;\n}\n'''
if old_equal in text:
    text = text.replace(old_equal, new_equal, 1)
elif new_equal not in text:
    raise SystemExit("reconcile equivalent marker not found")
reconcile.write_text(text)

# 3) Permanent end-to-end remote restore regression registration.
package = Path("package.json")
data = json.loads(package.read_text())
scripts = data["scripts"]
if "test:sync-restore-question-types" not in scripts:
    rebuilt = {}
    for key, value in scripts.items():
        rebuilt[key] = value
        if key == "test:sync-restore-full-claimed-guard":
            rebuilt["test:sync-restore-question-types"] = "tsx scripts/tests/test-sync-restore-question-types.ts"
    data["scripts"] = rebuilt
package.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

groups = Path("scripts/tools/test-groups.mjs")
text = groups.read_text()
marker = '    "test:sync-restore-full-claimed-guard",\n'
addition = marker + '    "test:sync-restore-question-types",\n'
if '"test:sync-restore-question-types"' not in text:
    if marker not in text:
        raise SystemExit("integration group marker not found")
    text = text.replace(marker, addition, 1)
groups.write_text(text)

# 4) Performance regression: semantically identical records with different JS
# property order must not trigger an IndexedDB write.
regression = Path("scripts/tests/test-sync-incremental-install.ts")
text = regression.read_text()
marker = '  assert.equal(questionClearCalls, 0, "update/delete reconciliation must also avoid table.clear()");\n'
addition = marker + '''\n  const reorderedFirst = {\n    deviceId: updatedFirst.deviceId,\n    updatedAt: updatedFirst.updatedAt,\n    contentFingerprint: updatedFirst.contentFingerprint,\n    tags: [...updatedFirst.tags],\n    answer: updatedFirst.answer,\n    options: updatedFirst.options.map((option) => option.map((block) => ({ ...block }))),\n    content: updatedFirst.content.map((block) => ({ ...block })),\n    type: updatedFirst.type,\n    id: updatedFirst.id,\n  } as QuestionV7;\n  let finalProgressLabel = "";\n  const noOp = await installProjection(projection([reorderedFirst]), {\n    onProgress: (progress) => { finalProgressLabel = progress.label; },\n  });\n  assert.equal(noOp, true, "semantically identical projection should complete");\n  assert.equal(finalProgressLabel, "本机数据无需改写", "property-order-only differences must not create needless IndexedDB writes");\n'''
if "property-order-only differences" not in text:
    if marker not in text:
        raise SystemExit("incremental regression marker not found")
    text = text.replace(marker, addition, 1)
regression.write_text(text)

# Remove the one-shot tooling from the verified result.
Path(".github/workflows/finalize-remote-restore-perf.yml").unlink(missing_ok=True)
Path("scripts/tools/finalize-remote-restore-perf.py").unlink(missing_ok=True)
