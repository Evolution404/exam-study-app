from pathlib import Path
import re


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    found = text.count(old)
    if found < count:
        raise SystemExit(f"missing replacement in {path}: expected {count}, found {found}: {old[:120]!r}")
    p.write_text(text.replace(old, new, count))


# ---- Domain + sync -------------------------------------------------------
replace(
    "src/lib/db/v7-types.ts",
    '''export interface BankV7 extends Omit<LegacyBank, "questionCount"> {\n  sortOrder: number;\n  questionCount: number;\n}\n''',
    '''export interface BankV7 extends Omit<LegacyBank, "questionCount"> {\n  sortOrder: number;\n  questionCount: number;\n  /** Disabled banks stay synchronized/managed but are excluded from new study scopes. */\n  enabled?: boolean;\n}\n\nexport function isBankEnabled(bank: Pick<BankV7, "enabled">): boolean {\n  return bank.enabled !== false;\n}\n''',
)

replace(
    "src/lib/db/db-v7-bank.ts",
    'import type { BankFolderV7, BankQuestionMembership, BankV7, QuestionV7 } from "./v7-types";',
    'import { isBankEnabled, type BankFolderV7, type BankQuestionMembership, type BankV7, type QuestionV7 } from "./v7-types";',
)
replace(
    "src/lib/db/db-v7-bank.ts",
    '''    sortOrder: Number.isFinite(values.sortOrder) ? Number(values.sortOrder) : await dbV7.banks.count(),\n    questionCount: 0,\n    importedAt:''',
    '''    sortOrder: Number.isFinite(values.sortOrder) ? Number(values.sortOrder) : await dbV7.banks.count(),\n    questionCount: 0,\n    enabled: values.enabled ?? true,\n    importedAt:''',
)
replace(
    "src/lib/db/db-v7-bank.ts",
    'changes: Partial<Pick<BankV7, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder">>',
    'changes: Partial<Pick<BankV7, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder" | "enabled">>',
)
replace(
    "src/lib/db/db-v7-bank.ts",
    '''export async function getQuestionsForBanksV7(bankIds: readonly string[]): Promise<QuestionV7[]> {\n  const result: QuestionV7[] = [];\n  const seen = new Set<string>();\n  for (const bankId of uniqueStrings(bankIds)) {''',
    '''export async function getQuestionsForBanksV7(bankIds: readonly string[]): Promise<QuestionV7[]> {\n  const result: QuestionV7[] = [];\n  const seen = new Set<string>();\n  const requestedIds = uniqueStrings(bankIds);\n  const enabledIds = (await dbV7.banks.bulkGet(requestedIds)).flatMap((bank) => bank && isBankEnabled(bank) ? [bank.id] : []);\n  for (const bankId of enabledIds) {''',
)

# New imported banks explicitly default enabled. Existing/target banks preserve their state.
replace(
    "src/lib/db/db-v7-question.ts",
    '''      sortOrder: await dbV7.banks.count(),\n      questionCount: 0,\n      importedAt: timestamp,''',
    '''      sortOrder: await dbV7.banks.count(),\n      questionCount: 0,\n      enabled: true,\n      importedAt: timestamp,''',
)

replace(
    "src/lib/sync/sync-v7-checkpoint.ts",
    '''  assertSafeInt(value.questionCount, `state.banks[${index}].questionCount`);\n  assertDate(value.importedAt, `state.banks[${index}].importedAt`);''',
    '''  assertSafeInt(value.questionCount, `state.banks[${index}].questionCount`);\n  if (value.enabled !== undefined && typeof value.enabled !== "boolean") fail(`state.banks[${index}].enabled must be boolean`);\n  assertDate(value.importedAt, `state.banks[${index}].importedAt`);''',
)

# ---- Bank management facade --------------------------------------------
replace(
    "src/app/bank/bank-library/bank-library-shared.ts",
    'import type { AttemptStatsV7, BankFolderV7, NoteV7, PracticeRunV7, QuestionTypeV7 } from "@/lib/db/v7-types";',
    'import { isBankEnabled, type AttemptStatsV7, type BankFolderV7, type NoteV7, type PracticeRunV7, type QuestionTypeV7 } from "@/lib/db/v7-types";',
)
replace(
    "src/app/bank/bank-library/bank-library-shared.ts",
    '''export type AttemptStats = AttemptStatsV7 & { bankId: string };\n\nexport type BankQuickMode''',
    '''export type AttemptStats = AttemptStatsV7 & { bankId: string };\nexport { isBankEnabled };\n\nexport type BankQuickMode''',
)
replace(
    "src/app/bank/bank-library/bank-library-shared.ts",
    'Partial<Pick<BankV7, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder">>',
    'Partial<Pick<BankV7, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder" | "enabled">>',
)

# ---- App-wide enabled study scope --------------------------------------
replace(
    "src/app/shell/app-shell.tsx",
    'import type { ActivePractice, GitHubSettings } from "@/types/types";',
    'import type { ActivePractice, GitHubSettings } from "@/types/types";\nimport { isBankEnabled } from "@/lib/db/v7-types";',
)
replace(
    "src/app/shell/app-shell.tsx",
    '''  const banks = useLiveQuery(async () => (await dbV7.banks.toArray()).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)), []) ?? [];\n  const validSelectedBankIds = selectedBankIds.filter((id) => banks.some((bank) => bank.id === id));\n  const activeBankIds = validSelectedBankIds;''',
    '''  const bankRows = useLiveQuery(async () => (await dbV7.banks.toArray()).sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)), []);\n  const banks = bankRows ?? [];\n  const enabledBanks = banks.filter(isBankEnabled);\n  const validSelectedBankIds = selectedBankIds.filter((id) => enabledBanks.some((bank) => bank.id === id));\n  const activeBankIds = validSelectedBankIds;\n\n  useEffect(() => {\n    if (bankRows === undefined) return;\n    const next = selectedBankIds.filter((id) => bankRows.some((bank) => bank.id === id && isBankEnabled(bank)));\n    if (next.length === selectedBankIds.length && next.every((id, index) => id === selectedBankIds[index])) return;\n    setSelectedBankIds(next);\n    localStorage.setItem("study-current-banks", JSON.stringify(next));\n  }, [bankRows, selectedBankIds]);''',
)

shell_path = Path("src/app/shell/app-shell.tsx")
shell = shell_path.read_text()
replacements = {
    '<ShellTopbar banks={banks}': '<ShellTopbar banks={enabledBanks}',
    'stats={stats} banks={banks} latestPracticeRun=': 'stats={stats} banks={enabledBanks} latestPracticeRun=',
    'rounds={reviewRounds} banks={banks} currentBankIds=': 'rounds={reviewRounds} banks={enabledBanks} currentBankIds=',
    'onStartTag={(tag) => { const bankIds = banks.map((bank) => bank.id);': 'onStartTag={(tag) => { const bankIds = enabledBanks.map((bank) => bank.id);',
    '<PreferencesView preferences={preferences} rounds={reviewRounds} banks={banks}': '<PreferencesView preferences={preferences} rounds={reviewRounds} banks={enabledBanks}',
    '<SearchView key={`search-${searchRevision}`} query={query} onQueryChange={setQuery} banks={banks}': '<SearchView key={`search-${searchRevision}`} query={query} onQueryChange={setQuery} banks={enabledBanks}',
}
for old, new in replacements.items():
    if old not in shell:
        raise SystemExit(f"missing AppShell scope replacement: {old}")
    shell = shell.replace(old, new, 1)
shell_path.write_text(shell)

# An old active review round may still name a bank that was later disabled.
replace(
    "src/app/practice/practice-setup.tsx",
    'if (round) { setBankIds([...round.bankIds]); onBankChange([...round.bankIds]); }',
    'if (round) { const nextBankIds = round.bankIds.filter((id) => banks.some((bank) => bank.id === id)); setBankIds(nextBankIds); onBankChange(nextBankIds); }',
)

# ---- Management view ----------------------------------------------------
replace(
    "src/app/bank/bank-library-view.tsx",
    'import { bankTitle, deleteBankFolder, reorderBanks, sortedBanks, type Bank, type BankFolder } from "./bank-library/bank-library-shared";',
    'import { bankTitle, deleteBankFolder, isBankEnabled, reorderBanks, saveBank, sortedBanks, type Bank, type BankFolder } from "./bank-library/bank-library-shared";',
)
replace(
    "src/app/bank/bank-library-view.tsx",
    '''  const [showUnfiled, setShowUnfiled] = useState(false);\n  const ordered = sortedBanks(banks);''',
    '''  const [showUnfiled, setShowUnfiled] = useState(false);\n  const [bankFilter, setBankFilter] = useState<"all" | "enabled" | "disabled">("all");\n  const ordered = sortedBanks(banks);\n  const enabledCount = banks.filter(isBankEnabled).length;\n  const disabledCount = banks.length - enabledCount;\n  const visibleOrdered = ordered.filter((bank) => bankFilter === "all" ? true : bankFilter === "enabled" ? isBankEnabled(bank) : !isBankEnabled(bank));\n  const visibleFolders = bankFilter === "all" ? folders : folders.filter((folder) => visibleOrdered.some((bank) => bank.folderId === folder.id));\n  const reorderEnabled = bankFilter === "all";''',
)
replace(
    "src/app/bank/bank-library-view.tsx",
    '''  function moveBank(bank: Bank, offset: number) {\n    const members =''',
    '''  async function toggleBankEnabled(bank: Bank) {\n    const enabled = !isBankEnabled(bank);\n    try {\n      await saveBank(bank.id, { enabled });\n      onNotice(enabled ? `题库“${bankTitle(bank)}”已启用` : `题库“${bankTitle(bank)}”已停用，将不再出现在首页、练习和搜索中`);\n    } catch (error) {\n      onNotice(error instanceof Error ? `题库状态保存失败：${error.message}` : "题库状态保存失败");\n    }\n  }\n\n  function moveBank(bank: Bank, offset: number) {\n    if (!reorderEnabled) return;\n    const members =''',
)
replace(
    "src/app/bank/bank-library-view.tsx",
    '<div className="bank-management-tools"><div><strong>整理工具</strong><small>题库分组、模板与未归档内容</small></div><div className="bank-management-tools-actions"><button onClick={() => setFolderDialog("new")}><FolderPlus size={16} />新建文件夹</button><ExcelTemplateAction onNotice={onNotice} /><button className={showUnfiled ? "active" : ""} onClick={() => setShowUnfiled((value) => !value)}><FileText size={16} />{showUnfiled ? "隐藏未归档" : "未归档题目"}</button></div></div>',
    '<div className="bank-management-tools"><div><strong>整理工具</strong><small>{enabledCount} 个启用 · {disabledCount} 个停用</small></div><div className="bank-management-tools-actions"><button className={bankFilter === "all" ? "active" : ""} onClick={() => setBankFilter("all")}>全部 {banks.length}</button><button className={bankFilter === "enabled" ? "active" : ""} onClick={() => setBankFilter("enabled")}>已启用 {enabledCount}</button><button className={bankFilter === "disabled" ? "active" : ""} onClick={() => setBankFilter("disabled")}>已停用 {disabledCount}</button><button onClick={() => setFolderDialog("new")}><FolderPlus size={16} />新建文件夹</button><ExcelTemplateAction onNotice={onNotice} /><button className={showUnfiled ? "active" : ""} onClick={() => setShowUnfiled((value) => !value)}><FileText size={16} />{showUnfiled ? "隐藏未归档" : "未归档题目"}</button></div></div>',
)
replace(
    "src/app/bank/bank-library-view.tsx",
    '''    {banks.length ? <div className="bank-folder-list">\n      {folders.map((folder) => <BankFolderSection key={folder.id} folder={folder} banks={ordered.filter((bank) => bank.folderId === folder.id)} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && void placeBank(draggedBankId, folder.id, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} onEditFolder={() => setFolderDialog(folder)} onDeleteFolder={() => setPendingFolderDelete(folder)} />)}\n      <BankFolderSection banks={ordered.filter((bank) => !bank.folderId || !folders.some((folder) => folder.id === bank.folderId))} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && void placeBank(draggedBankId, undefined, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} />\n    </div> :''',
    '''    {banks.length ? (visibleOrdered.length ? <div className="bank-folder-list">\n      {visibleFolders.map((folder) => <BankFolderSection key={folder.id} folder={folder} banks={visibleOrdered.filter((bank) => bank.folderId === folder.id)} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && reorderEnabled && void placeBank(draggedBankId, folder.id, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} onToggleEnabled={(bank) => void toggleBankEnabled(bank)} reorderEnabled={reorderEnabled} onEditFolder={() => setFolderDialog(folder)} onDeleteFolder={() => setPendingFolderDelete(folder)} />)}\n      <BankFolderSection banks={visibleOrdered.filter((bank) => !bank.folderId || !folders.some((folder) => folder.id === bank.folderId))} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && reorderEnabled && void placeBank(draggedBankId, undefined, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} onToggleEnabled={(bank) => void toggleBankEnabled(bank)} reorderEnabled={reorderEnabled} />\n    </div> : <div className="folder-drop-empty">{bankFilter === "enabled" ? "暂无启用题库" : bankFilter === "disabled" ? "暂无停用题库" : "暂无题库"}</div>) :''',
)

# ---- Management card ----------------------------------------------------
p = Path("src/app/bank/bank-library/bank-folder-section.tsx")
text = p.read_text()
text = text.replace(
    'import { bankTitle, fullDate, type Bank, type BankFolder } from "./bank-library-shared";',
    'import { bankTitle, fullDate, isBankEnabled, type Bank, type BankFolder } from "./bank-library-shared";',
    1,
)
start = text.index("function SortableBankItem(")
end = text.index("\n\nexport function BankFolderSection", start)
new_item = '''function SortableBankItem({ bank, index, total, onOpen, onMove, onToggleEnabled, reorderEnabled }: { bank: Bank; index: number; total: number; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onToggleEnabled: (bank: Bank) => void; reorderEnabled: boolean }) {\n  const enabled = isBankEnabled(bank);\n  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bank.id, disabled: !reorderEnabled });\n  return <article ref={setNodeRef} data-drag-id={bank.id} data-drag-index={index} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }} className={isDragging ? "drag-active" : ""}><button type="button" className="bank-drag" disabled={!reorderEnabled} aria-label={reorderEnabled ? `拖动${bankTitle(bank)}排序` : `${bankTitle(bank)}筛选视图不可排序`} style={{ opacity: reorderEnabled ? 1 : .28, cursor: reorderEnabled ? "grab" : "default" }} {...attributes} {...listeners}><GripVertical size={18} /></button><button className="bank-management-main" onClick={() => onOpen(bank)}><span className="bank-color" style={{ background: bank.color || "#dfe9e2", opacity: enabled ? 1 : .55 }}><BookOpenCheck size={18} /></span><span><strong>{bankTitle(bank)}</strong><small>{bank.questionCount.toLocaleString()} 题 · {fullDate(bank.importedAt)}{enabled ? "" : " · 已停用"}</small></span><ChevronRight size={17} /></button><div style={{ paddingRight: 7, display: "flex", alignItems: "center", gap: 4 }}><button type="button" aria-pressed={enabled} aria-label={`${enabled ? "停用" : "启用"}${bankTitle(bank)}`} onClick={() => onToggleEnabled(bank)} style={{ minWidth: 44, height: 28, border: "1px solid var(--color-border)", borderRadius: 8, padding: "0 8px", color: enabled ? "var(--color-primary)" : "var(--color-text-muted)", background: enabled ? "var(--color-primary-soft)" : "var(--color-surface-muted)", cursor: "pointer", fontSize: 10, fontWeight: 700 }}>{enabled ? "启用" : "停用"}</button>{reorderEnabled && <div className="bank-order-buttons" style={{ paddingRight: 0 }}><button aria-label="向上移动" disabled={index === 0} onClick={() => onMove(bank, -1)}><ArrowUp size={14} /></button><button aria-label="向下移动" disabled={index === total - 1} onClick={() => onMove(bank, 1)}><ArrowDown size={14} /></button></div>}</div></article>;\n}'''
text = text[:start] + new_item + text[end:]
old_signature = 'export function BankFolderSection({ folder, banks, draggedBankId, onDrag, onDrop, onOpen, onMove, onEditFolder, onDeleteFolder }: { folder?: BankFolder; banks: Bank[]; draggedBankId?: string; onDrag: (id?: string) => void; onDrop: (beforeId?: string) => void; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onEditFolder?: () => void; onDeleteFolder?: () => void }) {'
new_signature = 'export function BankFolderSection({ folder, banks, draggedBankId, onDrag, onDrop, onOpen, onMove, onToggleEnabled, reorderEnabled = true, onEditFolder, onDeleteFolder }: { folder?: BankFolder; banks: Bank[]; draggedBankId?: string; onDrag: (id?: string) => void; onDrop: (beforeId?: string) => void; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onToggleEnabled: (bank: Bank) => void; reorderEnabled?: boolean; onEditFolder?: () => void; onDeleteFolder?: () => void }) {'
if old_signature not in text:
    raise SystemExit("missing BankFolderSection signature")
text = text.replace(old_signature, new_signature, 1)
text = text.replace('''  function reorder(from: number, to: number) {\n    if (from < 0''', '''  function reorder(from: number, to: number) {\n    if (!reorderEnabled) return;\n    if (from < 0''', 1)
text = text.replace('''  function handleDragStart(event: DragStartEvent) {\n    onDrag''', '''  function handleDragStart(event: DragStartEvent) {\n    if (!reorderEnabled) return;\n    onDrag''', 1)
text = text.replace('''  function handleDragOver(event: DragOverEvent) {\n    const { active''', '''  function handleDragOver(event: DragOverEvent) {\n    if (!reorderEnabled) return;\n    const { active''', 1)
text = text.replace('''  function handleDragEnd(event: DragEndEvent) {\n    const { active''', '''  function handleDragEnd(event: DragEndEvent) {\n    if (!reorderEnabled) { onDrag(undefined); return; }\n    const { active''', 1)
old_item = '<SortableBankItem key={bank.id} bank={bank} index={index} total={ordered.length} onOpen={onOpen} onMove={onMove} />'
if old_item not in text:
    raise SystemExit("missing SortableBankItem render")
text = text.replace(old_item, '<SortableBankItem key={bank.id} bank={bank} index={index} total={ordered.length} onOpen={onOpen} onMove={onMove} onToggleEnabled={onToggleEnabled} reorderEnabled={reorderEnabled} />', 1)
p.write_text(text)

# ---- Regression contracts ----------------------------------------------
replace(
    "scripts/tests/test-v7-ui-data-flow.ts",
    'import { resumeIndexAfterLastAnswer } from "../../src/lib/practice/practice-resume";',
    'import { resumeIndexAfterLastAnswer } from "../../src/lib/practice/practice-resume";\nimport { isBankEnabled } from "../../src/lib/db/v7-types";',
)
replace(
    "scripts/tests/test-v7-ui-data-flow.ts",
    'const scope = normalizeProgressScope(undefined);',
    'assert.equal(isBankEnabled({}), true, "旧题库缺少 enabled 字段时必须默认启用");\nassert.equal(isBankEnabled({ enabled: true }), true);\nassert.equal(isBankEnabled({ enabled: false }), false);\n\nconst scope = normalizeProgressScope(undefined);',
)
replace(
    "scripts/tests/test-v7-ui-data-flow.ts",
    '''const study = source("shell/app-shell.tsx");\nassert.match(study, /importTargetBankIdRef/,''',
    '''const study = source("shell/app-shell.tsx");\nassert.match(study, /const enabledBanks = banks\\.filter\\(isBankEnabled\\)/, "AppShell 必须集中定义学习可见题库");\nassert.match(study, /BankLibraryView banks=\\{banks\\}/, "题库管理必须继续接收全部题库");\nassert.match(study, /Dashboard[\\s\\S]*?banks=\\{enabledBanks\\}/, "首页只显示启用题库");\nassert.match(study, /PracticeSetupView[\\s\\S]*?banks=\\{enabledBanks\\}/, "新练习只使用启用题库");\nassert.match(study, /SearchView[\\s\\S]*?banks=\\{enabledBanks\\}/, "搜索只使用启用题库");\nassert.match(study, /localStorage\\.setItem\\("study-current-banks", JSON\\.stringify\\(next\\)\\)/, "远端停用后必须清理本机幽灵选择");\nassert.match(bank, /已启用 \\{enabledCount\\}/, "题库管理应提供启用筛选");\nassert.match(bank, /已停用 \\{disabledCount\\}/, "题库管理应提供停用筛选");\nassert.match(bank, /saveBank\\(bank\\.id, \\{ enabled \\}\\)/, "启停必须走同步题库更新");\nassert.match(study, /importTargetBankIdRef/,''',
)

replace(
    "scripts/tests/test-db-v7.ts",
    '''  splitQuestionV7,\n  saveNoteV7,''',
    '''  splitQuestionV7,\n  updateBankV7,\n  saveNoteV7,''',
)
p = Path("scripts/tests/test-db-v7.ts")
p.write_text(p.read_text() + '''\n\n// Disabled bank is a synchronized visibility state, not a delete.\n{\n  const visibilityBank = await createBankV7("题库启停测试");\n  assert.equal(visibilityBank.enabled, true, "new banks explicitly default enabled");\n  const visibilityQuestion = await createQuestionV7(visibilityBank.id, { type: "单选", stem: "停用题库仍保留内容", options: ["A", "B"], answer: "A" });\n  await updateBankV7(visibilityBank.id, { enabled: false });\n  assert.equal((await dbV7.banks.get(visibilityBank.id))?.enabled, false);\n  assert.equal((await getQuestionsForBanksV7([visibilityBank.id])).length, 0, "disabled bank must be excluded from new study queries");\n  assert.equal((await getBankQuestionsV7(visibilityBank.id)).length, 1, "disabled bank must remain readable in management");\n  await updateBankV7(visibilityBank.id, { enabled: true });\n  assert.deepEqual((await getQuestionsForBanksV7([visibilityBank.id])).map((question) => question.id), [visibilityQuestion.id]);\n}\n''')

print("bank enabled feature patch applied")
