"use client";
import { ChevronRight, FileUp } from "lucide-react";

export function EmptyImport({ onImport }: { onImport: () => void }) {
  return <button className="empty-import" onClick={onImport}><span><FileUp size={22} /></span><div><strong>导入题库</strong><small>支持 JSON / XLSX，数据只写入本机</small></div><ChevronRight size={18} /></button>;
}
