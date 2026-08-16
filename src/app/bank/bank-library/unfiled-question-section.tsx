"use client";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { deleteQuestionsV7 } from "@/lib/db/db-v7";
import type { QuestionV7 } from "@/lib/db/v7-types";
import { loadImageAssetV7, SharedQuestionEditor, toQuestionViewModel } from "@/app/bank/question-editor";
import { ContentBlockRenderer } from "@/app/bank/content-block-renderer";
import { ConfirmDialog } from "@/app/ui/confirm-dialog";

export function UnfiledQuestionSection({ questions, onNotice }: { questions: QuestionV7[]; onNotice: (message: string) => void }) {
  const [editing, setEditing] = useState<QuestionV7>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const models = questions.map((question) => toQuestionViewModel(question));
  const allSelected = models.length > 0 && models.every((question) => selectedIds.includes(question.id));

  async function deleteSelected() {
    try {
      setDeleting(true);
      const count = await deleteQuestionsV7(selectedIds);
      setSelectedIds([]);
      setConfirmingDelete(false);
      onNotice(`已永久删除 ${count} 道未归档题目及其学习记录`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "批量删除未归档题目失败");
    } finally {
      setDeleting(false);
    }
  }

  return <section className="unfiled-question-section"><header><div><span className="section-kicker">全局题目仍保留</span><h2>未归档题目</h2><p>这些题目暂时没有任何题库归属，可批量清理或重新编辑。</p></div><strong>{questions.length} 道题</strong></header>{models.length ? <><div className="question-bulk-bar"><label><input type="checkbox" checked={allSelected} onChange={() => setSelectedIds(allSelected ? [] : models.map((question) => question.id))} />全选 {models.length} 道</label><span>已选 {selectedIds.length} 道</span><button className="danger-button" disabled={!selectedIds.length} onClick={() => setConfirmingDelete(true)}><Trash2 size={15} />批量删除</button></div><div className="managed-question-list selectable">{models.map((question) => <article key={question.id} className={selectedIds.includes(question.id) ? "selected" : ""}><label className="managed-question-check"><input type="checkbox" aria-label={`选择未归档题目 ${question.stem}`} checked={selectedIds.includes(question.id)} onChange={() => setSelectedIds(selectedIds.includes(question.id) ? selectedIds.filter((id) => id !== question.id) : [...selectedIds, question.id])} /></label><button onClick={() => setEditing(question.canonical)}><ContentBlockRenderer blocks={question.canonical.content} loadAsset={loadImageAssetV7} /><small>{question.type} · {question.tags.join("、") || "无标签"}</small></button></article>)}</div></> : <p className="question-manager-empty">暂无未归档题目。</p>}{editing && <SharedQuestionEditor question={editing} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); onNotice("未归档题目已保存"); }} />}<ConfirmDialog open={confirmingDelete} eyebrow="未归档题目" title={`永久删除 ${selectedIds.length} 道题？`} tone="danger" busy={deleting} confirmLabel="永久删除" onCancel={() => setConfirmingDelete(false)} onConfirm={() => void deleteSelected()} description={<><strong>所选题目没有任何题库归属</strong><span>题目、作答记录、统计、解析、题组和练习引用都会永久删除，此操作不可撤销。</span></>} /></section>;
}
