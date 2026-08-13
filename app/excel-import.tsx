"use client";

import { useState } from "react";
import { Download, LoaderCircle } from "lucide-react";

export function ExcelTemplateAction({ onNotice }: { onNotice: (message: string) => void }) {
  const [downloading, setDownloading] = useState(false);

  async function downloadTemplate() {
    try {
      setDownloading(true);
      const response = await fetch(`${import.meta.env.BASE_URL}题库模板.xlsx`);
      if (!response.ok) throw new Error("模板下载失败，请稍后重试");
      const file = new File([await response.blob()], "拾卷题库模板.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      if (mobile && navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        try {
          await navigator.share({ title: "拾卷题库模板", text: "保存或分享拾卷 Excel 题库模板", files: [file] });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (!(error instanceof DOMException) || !["NotAllowedError", "SecurityError"].includes(error.name)) throw error;
          // Browser mobile emulation and restricted PWA contexts may expose
          // Web Share without permission to open the system share sheet.
          // Fall through to a normal download instead of surfacing the raw
          // "Permission denied" browser error.
        }
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

  return <button type="button" disabled={downloading} onClick={() => void downloadTemplate()}>{downloading ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{downloading ? "正在准备…" : "Excel 模板"}</button>;
}
