"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { X } from "lucide-react";
import { deleteBankV7, deleteBankWithExclusiveQuestionsV7, dbV7 } from "@/lib/db/db-v7";
import { ModalPortal } from "@/app/ui/modal-portal";
import { bankTitle, type Bank } from "./bank-library-shared";

export function BankDeleteDialog({ bank, busy, onBusy, onClose, onDeleted, onNotice }: { bank: Bank; busy: boolean; onBusy: (value: boolean) => void; onClose: () => void; onDeleted: (message: string) => void; onNotice: (message: string) => void }) {
  const exclusiveCount = useLiveQuery(async () => {
    const memberships = await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).toArray();
    if (!memberships.length) return 0;
    const all = await dbV7.bankQuestionMemberships.where("questionId").anyOf(memberships.map((membership) => membership.questionId)).toArray();
    const counts = new Map<string, number>();
    for (const membership of all) counts.set(membership.questionId, (counts.get(membership.questionId) ?? 0) + 1);
    return memberships.filter((membership) => counts.get(membership.questionId) === 1).length;
  }, [bank.id]);

  async function removeBank(alsoDeleteQuestions: boolean) {
    try {
      onBusy(true);
      if (alsoDeleteQuestions) {
        const result = await deleteBankWithExclusiveQuestionsV7(bank.id);
        onDeleted(`题库“${bankTitle(bank)}”已删除，同时清理 ${result.deletedQuestions} 道独占题目`);
      } else {
        await deleteBankV7(bank.id);
        onDeleted(`题库“${bankTitle(bank)}”已删除，题目已保留`);
      }
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "删除题库失败");
    } finally {
      onBusy(false);
    }
  }

  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-delete-title"><header><div><span className="section-kicker">题库管理</span><h2 id="bank-delete-title">删除题库时如何处理题目？</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="取消删除题库"><X size={17} /></button></header><p className="delete-dialog-summary"><strong>{bankTitle(bank)}</strong><span>该题库共 {bank.questionCount.toLocaleString()} 道题，其中 {exclusiveCount === undefined ? "正在统计" : `${exclusiveCount.toLocaleString()} 道`}只属于这个题库。</span></p><div className="delete-choice-list"><button disabled={busy} onClick={() => void removeBank(false)}><span>只删除题库，保留题目</span><small>题目与学习记录继续保留；没有其他归属的题会进入“未归档题目”。</small></button><button className="danger-button" disabled={busy || exclusiveCount === undefined} onClick={() => void removeBank(true)}><span>删除题库和独占题目</span><small>永久删除只属于这个题库的 {exclusiveCount ?? 0} 道题及其学习记录；其他题库共用的题不会删除。</small></button></div>{busy && <p className="delete-dialog-progress">正在处理，请勿关闭…</p>}<footer><button disabled={busy} onClick={onClose}>取消</button></footer></section></div></ModalPortal>;
}
