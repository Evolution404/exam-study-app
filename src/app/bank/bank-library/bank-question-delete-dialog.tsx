"use client";
import { X } from "lucide-react";
import { ModalPortal } from "@/app/ui/modal-portal";
import { deleteQuestionV7, removeMembershipV7 } from "@/lib/db/db-v7";
import { bankTitle, type Bank, type Question } from "./bank-library-shared";

export function BankQuestionDeleteDialog({ question, bank, busy, onClose, onBusy, onNotice }: { question?: Question; bank: Bank; busy: boolean; onClose: () => void; onBusy: (value: boolean) => void; onNotice: (message: string) => void }) {
  if (!question) return null;
  const target = question;
  async function removeFromBank() {
    try { onBusy(true); await removeMembershipV7(bank.id, target.id); onClose(); onNotice(`题目已从「${bankTitle(bank)}」移除，可在未归档题目中找回`); }
    catch (error) { onNotice(error instanceof Error ? error.message : "移除题目失败"); }
    finally { onBusy(false); }
  }
  async function deleteGlobally() {
    try { onBusy(true); await deleteQuestionV7(target.id); onClose(); onNotice("题目及全部学习记录已删除"); }
    catch (error) { onNotice(error instanceof Error ? error.message : "删除题目失败"); }
    finally { onBusy(false); }
  }
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-question-delete-title"><header><div><span className="section-kicker">试题管理</span><h2 id="bank-question-delete-title">如何处理这道题？</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="取消删除题目"><X size={17} /></button></header><p><strong>{target.stem.slice(0, 64)}</strong></p><div className="delete-choice-list"><button disabled={busy} onClick={() => void removeFromBank()}><span>仅从当前题库移除</span><small>保留全局题目、历史作答和解析；题目会进入未归档题目。</small></button><button className="danger-button" disabled={busy} onClick={() => void deleteGlobally()}><span>全局删除题目及学习记录</span><small>从所有题库移除，并删除作答、解析、题组和练习引用。</small></button></div>{busy && <p>正在处理…</p>}<footer><button disabled={busy} onClick={onClose}>取消</button></footer></section></div></ModalPortal>;
}
