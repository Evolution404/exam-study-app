"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { FileText, FileUp, FolderPlus, Library, Plus } from "lucide-react";
import { dbV7 } from "@/lib/db/db-v7";
import { listUnfiledQuestionsV7 } from "@/lib/db/app-data-v7";
import { ExcelTemplateAction } from "@/app/bank/excel-import";
import { AppSelect } from "@/app/ui/app-select";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";
import type { ProgressScope } from "@/lib/practice/progress-scope";
import { bankTitle, deleteBankFolder, isBankEnabled, reorderBanks, saveBank, sortedBanks, type Bank, type BankFolder } from "./bank-library/bank-library-shared";
import { BankDetail } from "./bank-library/bank-detail";
import { BankDeleteDialog } from "./bank-library/bank-delete-dialog";
import { BankCreateDialog, BankEditDialog, FolderDialog } from "./bank-library/bank-dialogs";
import { BankFolderSection } from "./bank-library/bank-folder-section";
import { UnfiledQuestionSection } from "./bank-library/unfiled-question-section";

export type { BankQuickMode } from "./bank-library/bank-library-shared";

type BankFilter = "all" | "enabled" | "disabled";

export function BankLibraryView({ banks, progressScope = { type: "rolling", days: 90 }, progressScopeLabel = "近 90 天", wrongRemovalStreak, onImport, onImportInto, onOpenRun, onNotice }: { banks: Bank[]; progressScope?: ProgressScope; progressScopeLabel?: string; wrongRemovalStreak: number; onImport: () => void; onImportInto: (bankId: string) => void; onOpenRun: (runId: string) => void; onNotice: (message: string) => void }) {
  const folders = useLiveQuery(() => dbV7.bankFolders.orderBy("sortOrder").toArray(), []) ?? [];
  const [activeBankId, setActiveBankId] = useState<string>();
  const [tab, setTab] = useState<"overview" | "questions">("overview");
  const [editingBank, setEditingBank] = useState<Bank>();
  const [creatingBank, setCreatingBank] = useState(false);
  const [folderDialog, setFolderDialog] = useState<BankFolder | "new">();
  const [draggedBankId, setDraggedBankId] = useState<string>();
  const [pendingBankDelete, setPendingBankDelete] = useState<Bank>();
  const [pendingFolderDelete, setPendingFolderDelete] = useState<BankFolder>();
  const [deleting, setDeleting] = useState(false);
  const [showUnfiled, setShowUnfiled] = useState(false);
  const [bankFilter, setBankFilter] = useState<BankFilter>("all");
  const ordered = sortedBanks(banks);
  const enabledCount = banks.filter(isBankEnabled).length;
  const disabledCount = banks.length - enabledCount;
  const visibleOrdered = ordered.filter((bank) => bankFilter === "all" ? true : bankFilter === "enabled" ? isBankEnabled(bank) : !isBankEnabled(bank));
  const visibleFolders = bankFilter === "all" ? folders : folders.filter((folder) => visibleOrdered.some((bank) => bank.folderId === folder.id));
  const visibleUnfiledBanks = visibleOrdered.filter((bank) => !bank.folderId || !folders.some((folder) => folder.id === bank.folderId));
  const reorderEnabled = bankFilter === "all";
  const activeBank = banks.find((bank) => bank.id === activeBankId);
  const unfiledQuestions = useLiveQuery(() => showUnfiled ? listUnfiledQuestionsV7() : Promise.resolve([]), [showUnfiled]) ?? [];

  async function placeBank(bankId: string, folderId: string | undefined, beforeId?: string) {
    console.log("[drag-debug] place-bank start", { bankId, folderId, beforeId, allBanks: banks.map((bank) => `${bank.id}:${bank.folderId ?? "none"}`) });
    const members = sortedBanks(banks.filter((bank) => bank.folderId === folderId && bank.id !== bankId));
    const index = beforeId ? Math.max(0, members.findIndex((bank) => bank.id === beforeId)) : members.length;
    members.splice(index < 0 ? members.length : index, 0, banks.find((bank) => bank.id === bankId)!);
    console.log("[drag-debug] place-bank persist", { bankId, folderId, beforeId, nextIds: members.map((bank) => bank.id) });
    await reorderBanks(members.map((bank) => bank.id), folderId);
    setDraggedBankId(undefined);
  }

  async function toggleBankEnabled(bank: Bank) {
    const enabled = !isBankEnabled(bank);
    try {
      await saveBank(bank.id, { enabled });
      onNotice(enabled ? `题库“${bankTitle(bank)}”已启用` : `题库“${bankTitle(bank)}”已停用，将不再出现在首页、练习和搜索中`);
    } catch (error) {
      onNotice(error instanceof Error ? `题库状态保存失败：${error.message}` : "题库状态保存失败");
    }
  }

  function moveBank(bank: Bank, offset: number) {
    if (!reorderEnabled) return;
    const members = sortedBanks(banks.filter((item) => item.folderId === bank.folderId));
    const index = members.findIndex((item) => item.id === bank.id);
    const target = index + offset;
    if (target < 0 || target >= members.length) return;
    [members[index], members[target]] = [members[target], members[index]];
    void reorderBanks(members.map((item) => item.id), bank.folderId);
  }

  if (activeBank) return <><BankDetail bank={activeBank} folders={folders} progressScope={progressScope} progressScopeLabel={progressScopeLabel} tab={tab} wrongRemovalStreak={wrongRemovalStreak} onTab={setTab} onImportQuestions={() => onImportInto(activeBank.id)} onBack={() => { setActiveBankId(undefined); setTab("overview"); }} onEdit={() => setEditingBank(activeBank)} onDelete={() => setPendingBankDelete(activeBank)} onOpenRun={onOpenRun} onNotice={onNotice} />{editingBank && <BankEditDialog bank={editingBank} folders={folders} onClose={() => setEditingBank(undefined)} onSaved={(name) => { setEditingBank(undefined); onNotice(`题库“${name}”已保存`); }} />}{pendingBankDelete && <BankDeleteDialog bank={pendingBankDelete} busy={deleting} onBusy={setDeleting} onClose={() => setPendingBankDelete(undefined)} onDeleted={(message) => { setActiveBankId(undefined); setTab("overview"); setPendingBankDelete(undefined); onNotice(message); }} onNotice={onNotice} />}</>;
  return <>
    <div className="page-heading compact bank-management-heading"><div><p className="eyebrow">资料资产管理</p><h1>题库管理</h1><p>直接创建空白题库并逐题维护，也可以导入已有文件快速开始。</p></div><div className="bank-primary-actions"><button className="primary" onClick={() => setCreatingBank(true)}><Plus size={16} />新建题库</button><button className="secondary" onClick={onImport}><FileUp size={16} />导入题库</button></div></div>
    <div className="bank-management-tools"><div><strong>整理工具</strong><small>已启用 {enabledCount} · 已停用 {disabledCount}</small></div><div className="bank-management-tools-actions"><div style={{ width: 150, flex: "0 0 150px" }}><AppSelect ariaLabel="题库状态筛选" value={bankFilter} onValueChange={(value) => setBankFilter(value as BankFilter)} options={[{ value: "all", label: `全部 ${banks.length}` }, { value: "enabled", label: `已启用 ${enabledCount}` }, { value: "disabled", label: `已停用 ${disabledCount}` }]} /></div><button onClick={() => setFolderDialog("new")}><FolderPlus size={16} />新建文件夹</button><ExcelTemplateAction onNotice={onNotice} /><button className={showUnfiled ? "active" : ""} onClick={() => setShowUnfiled((value) => !value)}><FileText size={16} />{showUnfiled ? "隐藏未归档" : "未归档题目"}</button></div></div>
    {showUnfiled && <UnfiledQuestionSection questions={unfiledQuestions} onNotice={onNotice} />}
    {banks.length ? (visibleOrdered.length ? <div className="bank-folder-list">
      {visibleFolders.map((folder) => <BankFolderSection key={folder.id} folder={folder} banks={visibleOrdered.filter((bank) => bank.folderId === folder.id)} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && reorderEnabled && void placeBank(draggedBankId, folder.id, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} onToggleEnabled={(bank) => void toggleBankEnabled(bank)} reorderEnabled={reorderEnabled} onEditFolder={() => setFolderDialog(folder)} onDeleteFolder={() => setPendingFolderDelete(folder)} />)}
      {(bankFilter === "all" || visibleUnfiledBanks.length > 0) && <BankFolderSection banks={visibleUnfiledBanks} draggedBankId={draggedBankId} onDrag={setDraggedBankId} onDrop={(beforeId) => draggedBankId && reorderEnabled && void placeBank(draggedBankId, undefined, beforeId)} onOpen={(bank) => setActiveBankId(bank.id)} onMove={moveBank} onToggleEnabled={(bank) => void toggleBankEnabled(bank)} reorderEnabled={reorderEnabled} />}
    </div> : <div className="folder-drop-empty">{bankFilter === "enabled" ? "暂无启用题库" : bankFilter === "disabled" ? "暂无停用题库" : "暂无题库"}</div>) : <section className="bank-empty-state"><span className="bank-empty-icon"><Library size={25} /></span><div><span className="section-kicker">从这里开始</span><h2>建立你的第一个题库</h2><p>新建空白题库后可手动添加题目；已有资料则可直接导入 JSON 或 XLSX 文件。</p></div><div className="bank-empty-actions"><button className="primary" onClick={() => setCreatingBank(true)}><Plus size={16} />新建空白题库</button><button className="secondary" onClick={onImport}><FileUp size={16} />导入现有题库</button></div></section>}
    {creatingBank && <BankCreateDialog folders={folders} onClose={() => setCreatingBank(false)} onCreated={(bank) => { setCreatingBank(false); setActiveBankId(bank.id); setTab("questions"); onNotice(`题库“${bankTitle(bank)}”已创建，可以开始添加题目`); }} />}
    {editingBank && <BankEditDialog bank={editingBank} folders={folders} onClose={() => setEditingBank(undefined)} onSaved={(name) => { setEditingBank(undefined); onNotice(`题库“${name}”已保存`); }} />}
    {folderDialog && <FolderDialog folder={folderDialog === "new" ? undefined : folderDialog} onClose={() => setFolderDialog(undefined)} onSaved={(name) => { setFolderDialog(undefined); onNotice(`文件夹“${name}”已保存`); }} />}
    <ConfirmDialog open={Boolean(pendingFolderDelete)} eyebrow="题库分组" title="删除这个文件夹？" tone="danger" busy={deleting} confirmLabel="删除文件夹" onCancel={() => setPendingFolderDelete(undefined)} onConfirm={async () => { if (!pendingFolderDelete) return; try { setDeleting(true); await deleteBankFolder(pendingFolderDelete.id); setPendingFolderDelete(undefined); onNotice("文件夹已删除，题库已移到未分组"); } finally { setDeleting(false); } }} description={<><strong>文件夹“{pendingFolderDelete?.name}”会被删除</strong><span>其中的题库会移到“未分组”，题库和学习记录不会被删除。</span></>} />
  </>;
}
