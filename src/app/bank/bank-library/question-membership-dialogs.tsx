"use client";

import "../question-membership.css";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowRightLeft, Check, Library, Plus, Search, X } from "lucide-react";
import { AppSelect } from "@/app/ui/app-select";
import { ModalPortal } from "@/app/ui/modal-portal";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { loadImageAssetV7 } from "@/app/bank/question-editor";
import { addMembershipV7, addMembershipsV7, dbV7, setQuestionMembershipsV7 } from "@/lib/db/db-v7";
import { getQuestionViewV7, listQuestionViewsAvailableFromOtherBanksV7, questionPlainViewV7 } from "@/lib/db/app-data-v7";
import type { BankV7, QuestionTypeV7 } from "@/lib/db/v7-types";
import { QUESTION_TYPE_ORDER } from "@/types/types";

function bankLabel(bank: BankV7) {
  return bank.displayName?.trim() || bank.name;
}

export function QuestionMembershipDialog({ questionId, currentBankId, onClose, onSaved, onNotice }: {
  questionId: string;
  currentBankId?: string;
  onClose: () => void;
  onSaved: (result: { added: number; removed: number }) => void;
  onNotice: (message: string) => void;
}) {
  const data = useLiveQuery(async () => {
    const [view, banks] = await Promise.all([
      getQuestionViewV7(questionId, currentBankId),
      dbV7.banks.orderBy("sortOrder").toArray(),
    ]);
    return { view, banks };
  }, [questionId, currentBankId]);
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>([]);
  const [initializedQuestionId, setInitializedQuestionId] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data?.view || initializedQuestionId === questionId) return;
    setSelectedBankIds(data.view.memberships.map((membership) => membership.bankId));
    setInitializedQuestionId(questionId);
  }, [data, initializedQuestionId, questionId]);

  const visibleBanks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return (data?.banks ?? []).filter((bank) => !normalized || [bankLabel(bank), bank.name, bank.description ?? ""].join(" ").toLocaleLowerCase("zh-CN").includes(normalized));
  }, [data?.banks, query]);

  async function save() {
    try {
      setSaving(true);
      const result = await setQuestionMembershipsV7(questionId, selectedBankIds);
      onSaved(result);
      onClose();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "所属题库保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <ModalPortal><div className="membership-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="membership-dialog" role="dialog" aria-modal="true" aria-labelledby="membership-dialog-title">
    <header><div><span className="section-kicker">题目归属</span><h2 id="membership-dialog-title">管理所属题库</h2><p>勾选表示同一题目实体加入该题库；取消勾选只移除归属，不删除题目和学习记录。</p></div><button className="icon-button" aria-label="关闭所属题库管理" onClick={onClose}><X size={18} /></button></header>
    <div className="membership-dialog-body">
      <label className="membership-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索题库" /></label>
      <div className="membership-bank-list">{visibleBanks.map((bank) => { const checked = selectedBankIds.includes(bank.id); return <label key={bank.id} className={checked ? "selected" : ""}><input type="checkbox" checked={checked} onChange={() => setSelectedBankIds((current) => current.includes(bank.id) ? current.filter((id) => id !== bank.id) : [...current, bank.id])} /><span><strong>{bankLabel(bank)}</strong><small>{bank.id === currentBankId ? "当前题库" : `${bank.questionCount} 道题`}</small></span>{checked && <Check size={16} />}</label>; })}</div>
      {!visibleBanks.length && <div className="membership-empty">没有符合条件的题库</div>}
      <div className="membership-selection-summary"><Library size={16} /><span>{selectedBankIds.length ? `保存后属于 ${selectedBankIds.length} 个题库` : "保存后进入未归档题目"}</span></div>
    </div>
    <footer><button className="secondary" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving || !data?.view} onClick={() => void save()}>{saving ? "保存中…" : "保存所属题库"}</button></footer>
  </section></div></ModalPortal>;
}

export function AddFromOtherBanksDialog({ bank, onClose, onAdded, onNotice }: {
  bank: BankV7;
  onClose: () => void;
  onAdded: (count: number) => void;
  onNotice: (message: string) => void;
}) {
  const views = useLiveQuery(() => listQuestionViewsAvailableFromOtherBanksV7(bank.id), [bank.id]) ?? [];
  const banks = useLiveQuery(() => dbV7.banks.orderBy("sortOrder").toArray(), [bank.id]) ?? [];
  const [query, setQuery] = useState("");
  const [sourceBankId, setSourceBankId] = useState("all");
  const [type, setType] = useState<"全部" | QuestionTypeV7>("全部");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [visible, setVisible] = useState(80);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return views.filter((view) => {
      if (type !== "全部" && view.question.type !== type) return false;
      if (sourceBankId !== "all" && !view.memberships.some((membership) => membership.bankId === sourceBankId)) return false;
      if (!normalized) return true;
      const plain = questionPlainViewV7(view.question);
      const bankNames = view.banks.map(bankLabel).join(" ");
      return `${plain.searchText} ${bankNames}`.toLocaleLowerCase("zh-CN").includes(normalized);
    });
  }, [query, sourceBankId, type, views]);
  const eligible = filtered.filter((view) => !view.memberships.some((membership) => membership.bankId === bank.id));
  const allEligibleSelected = eligible.length > 0 && eligible.every((view) => selectedIds.includes(view.question.id));

  async function addSelected() {
    if (!selectedIds.length) return;
    try {
      setSaving(true);
      const count = selectedIds.length === 1
        ? Number(await addMembershipV7(bank.id, selectedIds[0]))
        : await addMembershipsV7(bank.id, selectedIds);
      setSelectedIds([]);
      onAdded(count);
      onClose();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "从其他题库添加失败");
    } finally {
      setSaving(false);
    }
  }

  return <ModalPortal><div className="membership-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="membership-dialog membership-source-dialog" role="dialog" aria-modal="true" aria-labelledby="membership-source-title">
    <header><div><span className="section-kicker">复用已有题目</span><h2 id="membership-source-title">从其他题库添加</h2><p>添加到「{bankLabel(bank)}」。不会复制题目内容，只会建立新的题库归属。</p></div><button className="icon-button" aria-label="关闭从其他题库添加" onClick={onClose}><X size={18} /></button></header>
    <div className="membership-source-controls"><label className="membership-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.currentTarget.value); setVisible(80); }} placeholder="搜索题干、答案、标签或题库" /></label><AppSelect ariaLabel="来源题库" value={sourceBankId} onValueChange={(value) => { setSourceBankId(value); setVisible(80); }} options={[{ value: "all", label: "全部其他题库" }, ...banks.filter((item) => item.id !== bank.id).map((item) => ({ value: item.id, label: bankLabel(item) }))]} /><AppSelect ariaLabel="题型" value={type} onValueChange={(value) => { setType(value as "全部" | QuestionTypeV7); setVisible(80); }} options={["全部", ...QUESTION_TYPE_ORDER].map((value) => ({ value, label: value }))} /></div>
    <div className="membership-source-select-all"><label><input type="checkbox" checked={allEligibleSelected} disabled={!eligible.length} onChange={() => setSelectedIds(allEligibleSelected ? selectedIds.filter((id) => !eligible.some((view) => view.question.id === id)) : [...new Set([...selectedIds, ...eligible.map((view) => view.question.id)])])} />选择当前筛选中可添加的 {eligible.length} 道</label><span>已选择 {selectedIds.length} 道</span></div>
    <div className="membership-source-list">{filtered.slice(0, visible).map((view) => {
      const already = view.memberships.some((membership) => membership.bankId === bank.id);
      const checked = selectedIds.includes(view.question.id);
      const sources = view.banks.filter((item) => item.id !== bank.id).map(bankLabel);
      return <article key={view.question.id} className={already ? "already" : checked ? "selected" : ""}><label><input type="checkbox" disabled={already} checked={already || checked} onChange={() => setSelectedIds((current) => current.includes(view.question.id) ? current.filter((id) => id !== view.question.id) : [...current, view.question.id])} /></label><div><div className="membership-source-meta"><em>{view.question.type}</em>{view.question.tags.slice(0, 3).map((tag) => <i key={tag}>{tag}</i>)}</div><ContentBlockRenderer blocks={view.question.content} loadAsset={loadImageAssetV7} /><small>{sources.slice(0, 2).join(" · ")}{sources.length > 2 ? ` · +${sources.length - 2}` : ""}</small></div><span>{already ? "当前题库已有" : "可添加"}</span></article>;
    })}</div>
    {!filtered.length && <div className="membership-empty"><Search size={20} />没有符合条件的其他题库题目</div>}
    {visible < filtered.length && <button className="membership-load-more" onClick={() => setVisible((value) => value + 80)}>继续加载（{visible} / {filtered.length}）</button>}
    <div className="membership-shared-note"><ArrowRightLeft size={17} /><span><strong>加入后是共享题目</strong><small>以后修改内容会影响所有所属题库；只想修改某个题库时，可在编辑保存时拆分为独立题目。</small></span></div>
    <footer><button className="secondary" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving || !selectedIds.length} onClick={() => void addSelected()}><Plus size={16} />{saving ? "添加中…" : `添加 ${selectedIds.length} 道到当前题库`}</button></footer>
  </section></div></ModalPortal>;
}

export function BulkAddToBanksDialog({ currentBankId, questionIds, onClose, onAdded, onNotice }: {
  currentBankId: string;
  questionIds: string[];
  onClose: () => void;
  onAdded: (count: number, bankCount: number) => void;
  onNotice: (message: string) => void;
}) {
  const banks = useLiveQuery(() => dbV7.banks.orderBy("sortOrder").toArray(), [currentBankId]) ?? [];
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!selectedBankIds.length || !questionIds.length) return;
    try {
      setSaving(true);
      let count = 0;
      for (const bankId of selectedBankIds) count += await addMembershipsV7(bankId, questionIds);
      onAdded(count, selectedBankIds.length);
      onClose();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "批量添加到题库失败");
    } finally {
      setSaving(false);
    }
  }

  return <ModalPortal><div className="membership-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="membership-dialog membership-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="membership-bulk-title"><header><div><span className="section-kicker">批量归属</span><h2 id="membership-bulk-title">将 {questionIds.length} 道题添加到题库</h2><p>重复归属会自动跳过，不会复制题目。</p></div><button className="icon-button" aria-label="关闭批量添加到题库" onClick={onClose}><X size={18} /></button></header><div className="membership-dialog-body"><div className="membership-bank-list">{banks.filter((bank) => bank.id !== currentBankId).map((bank) => { const checked = selectedBankIds.includes(bank.id); return <label key={bank.id} className={checked ? "selected" : ""}><input type="checkbox" checked={checked} onChange={() => setSelectedBankIds((current) => current.includes(bank.id) ? current.filter((id) => id !== bank.id) : [...current, bank.id])} /><span><strong>{bankLabel(bank)}</strong><small>{bank.questionCount} 道题</small></span>{checked && <Check size={16} />}</label>; })}</div>{banks.length <= 1 && <div className="membership-empty">还没有其他题库可添加</div>}</div><footer><button className="secondary" disabled={saving} onClick={onClose}>取消</button><button className="primary" disabled={saving || !selectedBankIds.length} onClick={() => void add()}>{saving ? "添加中…" : `添加到 ${selectedBankIds.length} 个题库`}</button></footer></section></div></ModalPortal>;
}
