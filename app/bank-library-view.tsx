"use client";

import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowDown, ArrowLeft, ArrowUp, BookOpenCheck, ChevronRight, Edit3, FilePlus2,
  FileUp, Folder, FolderOpen, FolderPlus, GripVertical, Library, Pencil, Plus,
  Search, Trash2, X,
} from "lucide-react";
import { QuestionEditor, type QuestionChanges } from "@/app/question-editor";
import { MathText } from "@/app/math-text";
import {
  createQuestion, db, deleteBank, deleteBankFolder, deleteQuestion, reorderBanks, saveBank,
  saveBankFolder, updateQuestion,
} from "@/lib/db";
import type { Bank, BankFolder, Question, QuestionType } from "@/lib/types";

export type BankQuickMode = "random30" | "sequential" | "wrong" | "favorite" | "difficult";

function bankTitle(bank: Bank) { return bank.displayName?.trim() || bank.name; }
function fullDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function sortedBanks(banks: Bank[]) { return [...banks].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.importedAt.localeCompare(b.importedAt)); }

export function BankLibraryView({ banks, onImport, onNotice }: { banks: Bank[]; onImport: () => void; onNotice: (message: string) => void }) {
  const folders = useLiveQuery(() => db.bankFolders.orderBy("sortOrder").toArray(), []) ?? [];
  const [activeBankId, setActiveBankId] = useState<string>();
  const [tab, setTab] = useState<"overview" | "questions">("overview");
  const [editingBank, setEditingBank] = useState<Bank>();
  const [folderDialog, setFolderDialog] = useState<BankFolder | "new">();
  const [draggedBankId, setDraggedBankId] = useState<string>();
  const ordered = sortedBanks(banks);
  const activeBank = banks.find((bank) => bank.id === activeBankId);

  async function placeBank(bankId: string, folderId: string | undefined, beforeId?: string) {
    const members = sortedBanks(banks.filter((bank) => bank.folderId === folderId && bank.id !== bankId));
    const index = beforeId ? Math.max(0, members.findIndex((bank) => bank.id === beforeId)) : members.length;
    members.splice(index < 0 ? members.length : index, 0, banks.find((bank) => bank.id === bankId)!);
    await reorderBanks(members.map((bank) => bank.id), folderId);
    setDraggedBankId(undefined);
  }

  function moveBank(bank: Bank, offset: number) {
    const members = sortedBanks(banks.filter((item) => item.folderId === bank.folderId));
    const index = members.findIndex((item) => item.id === bank.id);
    const target = index + offset;
    if (target < 0 || target >= members.length) return;
    [members[index], members[target]] = [members[target], members[index]];
    void reorderBanks(members.map((item) => item.id), bank.folderId);
  }

  async function removeBank(bank: Bank) {
    if (!window.confirm(`永久删除题库“${bankTitle(bank)}”及其 ${bank.questionCount} 道题、作答记录和解析？此操作会同步到其他设备。`)) return;
    await deleteBank(bank.id);
    setActiveBankId(undefined); setTab("overview");
    onNotice(`题库“${bankTitle(bank)}”已删除`);
  }

  if (activeBank) return <><BankDetail bank={activeBank} folders={folders} tab={tab} onTab={setTab} onBack={() => { setActiveBankId(undefined); setTab("overview"); }} onEdit={() => setEditingBank(activeBank)} onDelete={() => void removeBank(activeBank)} onNotice={onNotice} />{editingBank && <BankEditDialog bank={editingBank} folders={folders} onClose={() => setEditingBank(undefined)} onSaved={(name) => { setEditingBank(undefined); onNotice(`题库“${name}”已保存`); }} />}</>;
  return <>
    <div className="page-heading compact bank-management-heading"><div><p className="eyebrow">资料资产管理</p><h1>题库管理</h1><p>拖动调整顺序，用文件夹聚合题库；做题请前往练习中心。</p></div><div className="heading-actions"><button onClick={() => setFolderDialog("new")}><FolderPlus size={17} />新建文件夹</button><button className="primary" onClick={onImport}><FileUp size={17} />导入题库</button></div></div>
    {banks.length ? <div className="bank-folder-list">
      {folders.map((folder) => <BankFolderSection key={folder.id} folder={folder} banks={ordered.filter((bank) => bank.folderId === folder.id)} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && void placeBank(draggedBankId, folder.id, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} onEditFolder={() => setFolderDialog(folder)} onDeleteFolder={async () => { if (window.confirm(`删除文件夹“${folder.name}”？其中题库会移到“未分组”，不会被删除。`)) { await deleteBankFolder(folder.id); onNotice("文件夹已删除，题库已移到未分组"); } }} />)}
      <BankFolderSection banks={ordered.filter((bank) => !bank.folderId || !folders.some((folder) => folder.id === bank.folderId))} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && void placeBank(draggedBankId, undefined, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} />
    </div> : <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入 JSON 题库</strong><small>导入后可在这里分组、排序和管理试题</small></div><ChevronRight size={18} /></button>}
    {editingBank && <BankEditDialog bank={editingBank} folders={folders} onClose={() => setEditingBank(undefined)} onSaved={(name) => { setEditingBank(undefined); onNotice(`题库“${name}”已保存`); }} />}
    {folderDialog && <FolderDialog folder={folderDialog === "new" ? undefined : folderDialog} onClose={() => setFolderDialog(undefined)} onSaved={(name) => { setFolderDialog(undefined); onNotice(`文件夹“${name}”已保存`); }} />}
  </>;
}

function BankFolderSection({ folder, banks, draggedBankId, onDrag, onDrop, onOpen, onMove, onEditFolder, onDeleteFolder }: { folder?: BankFolder; banks: Bank[]; draggedBankId?: string; onDrag: (id?: string) => void; onDrop: (beforeId?: string) => void; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onEditFolder?: () => void; onDeleteFolder?: () => void }) {
  return <section className={`bank-folder ${draggedBankId ? "drag-active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(); }}><header><span className="folder-icon">{folder ? <FolderOpen size={18} /> : <Library size={18} />}</span><div><h2>{folder?.name ?? "未分组"}</h2><p>{folder?.description || `${banks.length} 个题库`}</p></div><strong>{banks.length}</strong>{folder && <div className="folder-actions"><button aria-label={`编辑文件夹${folder.name}`} onClick={onEditFolder}><Pencil size={15} /></button><button aria-label={`删除文件夹${folder.name}`} onClick={onDeleteFolder}><Trash2 size={15} /></button></div>}</header><div className="bank-management-grid">{banks.map((bank, index) => <article key={bank.id} draggable onDragStart={() => onDrag(bank.id)} onDragEnd={() => onDrag(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); event.preventDefault(); onDrop(bank.id); }}><span className="bank-drag"><GripVertical size={18} /></span><button className="bank-management-main" onClick={() => onOpen(bank)}><span className="bank-color" style={{ background: bank.color || "#dfe9e2" }}><BookOpenCheck size={18} /></span><span><strong>{bankTitle(bank)}</strong><small>{bank.questionCount.toLocaleString()} 题 · {fullDate(bank.importedAt)}</small></span><ChevronRight size={17} /></button><div className="bank-order-buttons"><button aria-label="向上移动" disabled={index === 0} onClick={() => onMove(bank, -1)}><ArrowUp size={14} /></button><button aria-label="向下移动" disabled={index === banks.length - 1} onClick={() => onMove(bank, 1)}><ArrowDown size={14} /></button></div></article>)}</div>{!banks.length && <div className="folder-drop-empty"><Folder size={20} />将题库拖到这里</div>}</section>;
}

function BankDetail({ bank, folders, tab, onTab, onBack, onEdit, onDelete, onNotice }: { bank: Bank; folders: BankFolder[]; tab: "overview" | "questions"; onTab: (tab: "overview" | "questions") => void; onBack: () => void; onEdit: () => void; onDelete: () => void; onNotice: (message: string) => void }) {
  const questions = useLiveQuery(() => db.questions.where("bankId").equals(bank.id).toArray(), [bank.id]) ?? [];
  const types = Object.fromEntries((["单选", "多选", "判断"] as QuestionType[]).map((type) => [type, questions.filter((question) => question.type === type).length])) as Record<QuestionType, number>;
  return <><div className="bank-detail-heading"><button onClick={onBack}><ArrowLeft size={16} />返回题库管理</button><div><span className="section-kicker">{folders.find((folder) => folder.id === bank.folderId)?.name ?? "未分组"}</span><h1>{bankTitle(bank)}</h1><p>{bank.description || "尚未填写题库说明"}</p></div><div><button onClick={onEdit}><Edit3 size={16} />编辑题库</button><button className="danger-button" onClick={onDelete}><Trash2 size={16} />删除题库</button></div></div><div className="bank-detail-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => onTab("overview")}>基本信息</button><button className={tab === "questions" ? "active" : ""} onClick={() => onTab("questions")}>试题管理 <span>{questions.length}</span></button></div>{tab === "overview" ? <section className="bank-overview-panel"><div className="bank-overview-types">{(["单选", "多选", "判断"] as QuestionType[]).map((type) => <article key={type}><strong>{types[type]}</strong><span>{type}</span></article>)}</div><dl><div><dt>系统原名</dt><dd>{bank.name}</dd></div><div><dt>展示名称</dt><dd>{bankTitle(bank)}</dd></div><div><dt>所属文件夹</dt><dd>{folders.find((folder) => folder.id === bank.folderId)?.name ?? "未分组"}</dd></div><div><dt>导入日期</dt><dd>{fullDate(bank.importedAt)}</dd></div></dl><button className="manage-questions-callout" onClick={() => onTab("questions")}><span><FilePlus2 size={21} /></span><div><strong>管理此题库的试题</strong><p>搜索、筛选、新增、编辑或删除题目。</p></div><ChevronRight size={18} /></button></section> : <QuestionManager bank={bank} questions={questions} onNotice={onNotice} />}</>;
}

function QuestionManager({ bank, questions, onNotice }: { bank: Bank; questions: Question[]; onNotice: (message: string) => void }) {
  const [query, setQuery] = useState(""); const [type, setType] = useState<"全部" | QuestionType>("全部"); const [visible, setVisible] = useState(80); const [editing, setEditing] = useState<Question>(); const [adding, setAdding] = useState(false);
  const filtered = useMemo(() => questions.filter((question) => (type === "全部" || question.type === type) && [question.stem, ...question.options, ...question.tags].join(" ").toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"))), [questions, query, type]);
  const blank: Question = { id: "new", bankId: bank.id, bankName: bankTitle(bank), stem: "", normalizedStem: "", answer: "A", options: ["", "", "", ""], type: "单选", tags: [] };
  return <section className="question-manager"><header><div className="question-manager-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisible(80); }} placeholder="搜索题干、选项或标签" /></div><select aria-label="筛选题型" value={type} onChange={(event) => { setType(event.target.value as "全部" | QuestionType); setVisible(80); }}><option>全部</option><option>单选</option><option>多选</option><option>判断</option></select><button className="primary" onClick={() => setAdding(true)}><Plus size={16} />新增题目</button></header><p className="question-manager-count">找到 {filtered.length} 道题，当前显示 {Math.min(visible, filtered.length)} 道</p><div className="managed-question-list">{filtered.slice(0, visible).map((question, index) => <article key={question.id}><span>{index + 1}</span><button onClick={() => setEditing(question)}><div><em>{question.type}</em>{question.tags.map((tag) => <i key={tag}>{tag}</i>)}</div><strong><MathText text={question.stem} /></strong><small>答案 {question.answer} · {question.options.length} 个选项</small></button><div><button aria-label="编辑题目" onClick={() => setEditing(question)}><Pencil size={15} /></button><button aria-label="删除题目" onClick={() => { if (window.confirm(`删除题目“${question.stem.slice(0, 32)}”？相关作答和解析也会删除。`)) void deleteQuestion(question.id).then(() => onNotice("题目已删除")); }}><Trash2 size={15} /></button></div></article>)}</div>{visible < filtered.length && <button className="search-load-more" onClick={() => setVisible(visible + 80)}>继续加载（{visible} / {filtered.length}）</button>}{!filtered.length && <div className="question-manager-empty"><Search /><h3>没有符合条件的题目</h3></div>}{editing && <QuestionEditor question={editing} onCancel={() => setEditing(undefined)} onSave={async (changes) => { await updateQuestion(editing.id, changes); setEditing(undefined); onNotice("题目已保存"); }} />}{adding && <QuestionEditor question={blank} title="新增题目" eyebrow={`添加到 ${bankTitle(bank)}`} submitLabel="添加题目" onCancel={() => setAdding(false)} onSave={async (changes: QuestionChanges) => { await createQuestion(bank.id, changes); setAdding(false); onNotice("新题目已添加"); }} />}</section>;
}

function BankEditDialog({ bank, folders, onClose, onSaved }: { bank: Bank; folders: BankFolder[]; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(bankTitle(bank)); const [description, setDescription] = useState(bank.description ?? ""); const [folderId, setFolderId] = useState(bank.folderId ?? ""); const [color, setColor] = useState(bank.color ?? "#dfe9e2");
  return <div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog"><header><div><span className="section-kicker">题库资料</span><h2>编辑题库</h2></div><button className="icon-button" aria-label="关闭编辑题库" onClick={onClose}><X size={17} /></button></header><div><label>展示名称<input value={name} onChange={(event) => setName(event.target.value)} /><small>系统原名保持为“{bank.name}”，不会影响同步识别。</small></label><label>题库说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途、范围或备注" /></label><label>所属文件夹<select value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">未分组</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><label>识别颜色<span className="color-field"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><em>{color}</em></span></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={async () => { const saved = await saveBank(bank.id, { displayName: name, description, folderId: folderId || undefined, color, sortOrder: bank.sortOrder }); onSaved(bankTitle(saved)); }}>保存题库</button></footer></section></div>;
}

function FolderDialog({ folder, onClose, onSaved }: { folder?: BankFolder; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(folder?.name ?? ""); const [description, setDescription] = useState(folder?.description ?? "");
  return <div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog small"><header><div><span className="section-kicker">题库分组</span><h2>{folder ? "编辑文件夹" : "新建文件夹"}</h2></div><button className="icon-button" aria-label="关闭文件夹编辑" onClick={onClose}><X size={17} /></button></header><div><label>文件夹名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：送电线路工" /></label><label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选" /></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={async () => { const saved = await saveBankFolder({ id: folder?.id, name, description }); onSaved(saved.name); }}>保存文件夹</button></footer></section></div>;
}
