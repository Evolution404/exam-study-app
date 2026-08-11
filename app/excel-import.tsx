"use client";

import { useRef, useState } from "react";
import { Download, FileSpreadsheet, LoaderCircle } from "lucide-react";
import { importQuestionBankV6 } from "@/lib/db-v6";
import { importFileName, parseQuestionBankWorkbook } from "@/lib/xlsx-import";

export function ExcelImportActions({ onNotice }: { onNotice: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const [downloading, setDownloading] = useState(false);

  async function downloadTemplate() {
    try {
      setDownloading(true);
      const response = await fetch(`${import.meta.env.BASE_URL}题库模板.xlsx`);
      if (!response.ok) throw new Error("模板下载失败，请稍后重试");
      const file = new File([await response.blob()], "拾卷题库模板.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      if (mobile && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({ title: "拾卷题库模板", text: "保存或分享拾卷 Excel 题库模板", files: [file] });
        return;
      }
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onNotice(error instanceof Error ? error.message : "模板下载失败");
    } finally {
      setDownloading(false);
    }
  }

  async function importWorkbook(file?: File) {
    if (!file) return;
    try {
      setImporting(true);
      onNotice("正在校验 Excel 题库…");
      const bankFileName = importFileName(file.name);
      const questions = await parseQuestionBankWorkbook(await file.arrayBuffer());
      const bank = await importQuestionBankV6(bankFileName, questions);
      onNotice(`已从 Excel 导入「${bank.displayName || bank.name}」的 ${bank.questionCount} 道题`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Excel 题库导入失败");
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return <>
    <button type="button" disabled={downloading} onClick={() => void downloadTemplate()}>{downloading ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{downloading ? "正在准备模板…" : "下载 Excel 模板"}</button>
    <button type="button" disabled={importing} onClick={() => inputRef.current?.click()}>
      {importing ? <LoaderCircle className="spin" size={17} /> : <FileSpreadsheet size={17} />}
      {importing ? "校验中…" : "导入 Excel"}
    </button>
    <input
      ref={inputRef}
      type="file"
      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      hidden
      onChange={(event) => void importWorkbook(event.target.files?.[0])}
    />
  </>;
}
