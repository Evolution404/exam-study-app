"use client";
import { ArrowDown, ArrowUp, BookOpenCheck, ChevronRight, Folder, FolderOpen, GripVertical, Library, Pencil, Trash2 } from "lucide-react";
import { useDragSort } from "@/app/hooks/use-drag-sort";
import { bankTitle, fullDate, type Bank, type BankFolder } from "./bank-library-shared";

export function BankFolderSection({ folder, banks, draggedBankId, onDrag, onDrop, onOpen, onMove, onEditFolder, onDeleteFolder }: { folder?: BankFolder; banks: Bank[]; draggedBankId?: string; onDrag: (id?: string) => void; onDrop: (beforeId?: string) => void; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onEditFolder?: () => void; onDeleteFolder?: () => void }) {
  const { ordered, containerRef, draggedIndex, dragHandlers } = useDragSort({
    items: banks,
    commitOnDrop: true,
    onCommit: (next) => {
      // 只提交被拖动的那张卡；找到它在新顺序中的位置，转换为 beforeId。
      const moved = banks.find((bank, index) => next[index]?.id !== bank.id);
      if (!moved) return;
      const movedIndex = next.findIndex((bank) => bank.id === moved.id);
      const beforeId = movedIndex >= 0 && movedIndex + 1 < next.length ? next[movedIndex + 1].id : undefined;
      onDrop(beforeId);
    },
  });

  return <section className={`bank-folder ${draggedBankId ? "drag-active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(); }}><header><span className="folder-icon">{folder ? <FolderOpen size={18} /> : <Library size={18} />}</span><div><h2>{folder?.name ?? "未分组"}</h2><p>{folder?.description || `${banks.length} 个题库`}</p></div><strong>{banks.length}</strong>{folder && <div className="folder-actions"><button aria-label={`编辑文件夹${folder.name}`} onClick={onEditFolder}><Pencil size={15} /></button><button aria-label={`删除文件夹${folder.name}`} onClick={onDeleteFolder}><Trash2 size={15} /></button></div>}</header><div className="bank-management-grid" ref={containerRef}>{ordered.map((bank, index) => { const handlers = dragHandlers(index); return <article key={bank.id} data-drag-id={bank.id} data-drag-index={index} {...handlers} onDragStart={(event) => { onDrag(bank.id); handlers.onDragStart(event); }} onDragEnd={() => { handlers.onDragEnd(); onDrag(undefined); }} onDrop={(event) => { if (draggedIndex !== undefined) { event.stopPropagation(); handlers.onDrop(event); } else { event.preventDefault(); event.stopPropagation(); onDrop(bank.id); } }}><span className="bank-drag"><GripVertical size={18} /></span><button className="bank-management-main" onClick={() => onOpen(bank)}><span className="bank-color" style={{ background: bank.color || "#dfe9e2" }}><BookOpenCheck size={18} /></span><span><strong>{bankTitle(bank)}</strong><small>{bank.questionCount.toLocaleString()} 题 · {fullDate(bank.importedAt)}</small></span><ChevronRight size={17} /></button><div className="bank-order-buttons"><button aria-label="向上移动" disabled={index === 0} onClick={() => onMove(bank, -1)}><ArrowUp size={14} /></button><button aria-label="向下移动" disabled={index === ordered.length - 1} onClick={() => onMove(bank, 1)}><ArrowDown size={14} /></button></div></article>; })}</div>{!ordered.length && <div className="folder-drop-empty"><Folder size={20} />将题库拖到这里</div>}</section>;
}
