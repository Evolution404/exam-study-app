"use client";

import { useRef, useState } from "react";
import { Download, FileSpreadsheet, LoaderCircle } from "lucide-react";
import { importQuestionBank } from "@/lib/db";
import { importFileName, parseQuestionBankWorkbook } from "@/lib/xlsx-import";

export function ExcelImportActions({ onNotice }: { onNotice: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  function downloadTemplate() {
    const anchor = document.createElement("a");
    anchor.href = `${import.meta.env.BASE_URL}题库模板.xlsx`;
    anchor.download = "题库模板.xlsx";
    anchor.click();
  }

  async function importWorkbook(file?: File) {
    if (!file) return;
    try {
      setImporting(true);
      onNotice("正在校验 Excel 题库…");
      const bankFileName = importFileName(file.name);
      const questions = await parseQuestionBankWorkbook(await file.arrayBuffer());
      const bank = await importQuestionBank(bankFileName, questions);
      onNotice(`已从 Excel 导入「${bank.displayName || bank.name}」的 ${bank.questionCount} 道题`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Excel 题库导入失败");
    } finally {
      setImporting(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return <>
    <button type="button" onClick={downloadTemplate}><Download size={17} />下载 Excel 模板</button>
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
