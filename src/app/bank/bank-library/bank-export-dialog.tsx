"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { ModalPortal } from "@/app/ui/modal-portal";
import { collectExportImages, downloadExport, questionPortableExportFormat, sanitizeFileName } from "@/lib/question/question-bank-export";
import { questionBankIoWorker } from "@/lib/io/io-worker-client";
import { dbV7 } from "@/lib/db/db-v7";
import { loadImageAssetV7 } from "@/app/bank/question-editor";
import { isNativeApp } from "@/platform/environment";
import { platformFileService } from "@/platform/files";
import { bankTitle, type Bank, type Note, type Question } from "./bank-library-shared";

export function BankExportDialog({ bank, questions, notes, onClose, onNotice }: { bank: Bank; questions: Question[]; notes: Note[]; onClose: () => void; onNotice: (message: string) => void }) {
  const [busy, setBusy] = useState<"excel" | "portable" | null>(null);
  async function saveExport(filename: string, blob: Blob) {
    if (isNativeApp()) {
      await platformFileService.downloadExport(filename, blob);
      return;
    }
    await downloadExport(filename, blob);
  }

  async function loadExportAsset(assetId: string) {
    const descriptor = await dbV7.imageAssets.get(assetId);
    if (!descriptor) return undefined;
    const blob = descriptor.blob ?? await loadImageAssetV7(assetId);
    return blob ? { ...descriptor, blob } : descriptor;
  }

  async function exportBank(format: "excel" | "portable") {
    setBusy(format);
    try {
      const noteMap = new Map(notes.map((note) => [note.questionId, note.content]));
      const baseName = sanitizeFileName(bankTitle(bank));
      const portableFormat = questionPortableExportFormat(questions);
      if (format === "excel") {
        const { images, missing } = await collectExportImages(questions, { target: "excel", loadAsset: loadExportAsset });
        if (missing.length) throw new Error(`有 ${missing.length} 张题目图片无法读取，已取消导出。请先连接同步仓库并缓存图片后重试。`);
        // Image collection reads Dexie here; the workbook itself is built in
        // the io worker so large banks do not freeze the dialog.
        const built = await questionBankIoWorker.build({ kind: "xlsx", name: "", questions, notes: noteMap, images });
        if (built.kind !== "xlsx") throw new Error("导出结果类型不匹配，请重试。");
        await saveExport(`${baseName}.xlsx`, new Blob([built.bytes.slice()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      } else {
        if (portableFormat === "zip") {
          const { images, missing } = await collectExportImages(questions, { target: "bundle", loadAsset: loadExportAsset });
          if (missing.length) throw new Error(`有 ${missing.length} 张题目原图无法读取，已取消打包。请先连接同步仓库并缓存图片后重试。`);
          const built = await questionBankIoWorker.build({ kind: "zip", name: bankTitle(bank), questions, notes: noteMap, images });
          if (built.kind !== "zip") throw new Error("导出结果类型不匹配，请重试。");
          await saveExport(`${baseName}.zip`, new Blob([built.bytes.slice()], { type: "application/zip" }));
        } else {
          const built = await questionBankIoWorker.build({ kind: "json", name: bankTitle(bank), questions, notes: noteMap });
          if (built.kind !== "json") throw new Error("导出结果类型不匹配，请重试。");
          await saveExport(`${baseName}.json`, new Blob([built.text], { type: "application/json" }));
        }
      }
      onClose();
      const label = format === "excel" ? "Excel" : portableFormat === "zip" ? "ZIP（bank.json + 全部原图）" : "JSON";
      onNotice(`题库“${bankTitle(bank)}”已导出为 ${label}`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog small"><header><div><span className="section-kicker">导出题库</span><h2>{bankTitle(bank)}</h2></div><button className="icon-button" aria-label="关闭导出" onClick={onClose}><X size={17} /></button></header><div><p className="export-summary">共 {questions.length.toLocaleString()} 道题，将导出题干、题型、答案、标签、解析与选项。Excel 使用 WPS 单元格图片；便携导出在无图时生成 JSON，有图时生成包含 bank.json 与全部原图的 ZIP。</p></div><footer><button disabled={busy !== null} onClick={onClose}>取消</button><button disabled={busy !== null} onClick={() => void exportBank("excel")}>{busy === "excel" ? "正在导出…" : "导出 Excel"}</button><button className="primary" disabled={busy !== null} onClick={() => void exportBank("portable")}>{busy === "portable" ? "正在打包…" : "导出 JSON / ZIP"}</button></footer></section></div></ModalPortal>;
}
