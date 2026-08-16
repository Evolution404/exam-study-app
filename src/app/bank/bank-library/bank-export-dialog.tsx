"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { ModalPortal } from "@/app/ui/modal-portal";
import { buildQuestionBankXlsx, buildQuestionBankZip, collectExportImages, downloadExport, questionExportJson, sanitizeFileName } from "@/lib/question/question-bank-export";
import { bankTitle, type Bank, type Note, type Question } from "./bank-library-shared";

export function BankExportDialog({ bank, questions, notes, onClose, onNotice }: { bank: Bank; questions: Question[]; notes: Note[]; onClose: () => void; onNotice: (message: string) => void }) {
  const [busy, setBusy] = useState<"excel" | "json" | null>(null);
  async function exportBank(format: "excel" | "json") {
    setBusy(format);
    try {
      const noteMap = new Map(notes.map((note) => [note.questionId, note.content]));
      const baseName = sanitizeFileName(bankTitle(bank));
      const { images, missing } = await collectExportImages(questions);
      if (format === "excel") {
        const bytes = buildQuestionBankXlsx(questions, noteMap, images);
        await downloadExport(`${baseName}.xlsx`, new Blob([bytes.slice()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      } else if (images.size) {
        const bytes = buildQuestionBankZip(bankTitle(bank), questions, noteMap, images);
        await downloadExport(`${baseName}.zip`, new Blob([bytes.slice()], { type: "application/zip" }));
      } else {
        const text = questionExportJson(bankTitle(bank), questions, noteMap);
        await downloadExport(`${baseName}.json`, new Blob([text], { type: "application/json" }));
      }
      onClose();
      const label = format === "excel" ? "Excel" : images.size ? "压缩包（JSON + 图片）" : "JSON";
      onNotice(`题库“${bankTitle(bank)}”已导出为 ${label}${missing.length ? `，${missing.length} 张图片已不在本机缓存，未能导出` : ""}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog small"><header><div><span className="section-kicker">导出题库</span><h2>{bankTitle(bank)}</h2></div><button className="icon-button" aria-label="关闭导出" onClick={onClose}><X size={17} /></button></header><div><p className="export-summary">共 {questions.length.toLocaleString()} 道题，将导出题干、题型、答案、标签、解析与选项。含图片时：Excel 以 WPS 单元格图片嵌入（Excel 打开不显示图），JSON 自动打包为含图片的 zip。</p></div><footer><button disabled={busy !== null} onClick={onClose}>取消</button><button disabled={busy !== null} onClick={() => void exportBank("excel")}>{busy === "excel" ? "正在导出…" : "导出 Excel"}</button><button className="primary" disabled={busy !== null} onClick={() => void exportBank("json")}>{busy === "json" ? "正在导出…" : "导出 JSON"}</button></footer></section></div></ModalPortal>;
}
