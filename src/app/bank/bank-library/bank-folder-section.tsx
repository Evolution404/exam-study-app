"use client";
import { useState } from "react";
import { ArrowDown, ArrowUp, BookOpenCheck, ChevronRight, Folder, FolderOpen, GripVertical, Library, Pencil, Trash2 } from "lucide-react";
import { DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { bankTitle, fullDate, isBankEnabled, type Bank, type BankFolder } from "./bank-library-shared";

function SortableBankItem({ bank, index, total, onOpen, onMove, onToggleEnabled, reorderEnabled }: { bank: Bank; index: number; total: number; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onToggleEnabled: (bank: Bank) => void; reorderEnabled: boolean }) {
  const enabled = isBankEnabled(bank);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bank.id, disabled: !reorderEnabled });
  return <article ref={setNodeRef} data-drag-id={bank.id} data-drag-index={index} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }} className={isDragging ? "drag-active" : ""}><button type="button" className="bank-drag" disabled={!reorderEnabled} aria-label={reorderEnabled ? `拖动${bankTitle(bank)}排序` : `${bankTitle(bank)}筛选视图不可排序`} style={{ opacity: reorderEnabled ? 1 : .28, cursor: reorderEnabled ? "grab" : "default" }} {...attributes} {...listeners}><GripVertical size={18} /></button><button className="bank-management-main" onClick={() => onOpen(bank)}><span className="bank-color" style={{ background: bank.color || "#dfe9e2", opacity: enabled ? 1 : .55 }}><BookOpenCheck size={18} /></span><span><strong>{bankTitle(bank)}</strong><small>{bank.questionCount.toLocaleString()} 题 · {fullDate(bank.importedAt)}{enabled ? "" : " · 已停用"}</small></span><ChevronRight size={17} /></button><div style={{ paddingRight: 7, display: "flex", alignItems: "center", gap: 4 }}><button type="button" className="secondary" aria-pressed={enabled} aria-label={`${enabled ? "停用" : "启用"}${bankTitle(bank)}`} onClick={() => onToggleEnabled(bank)} style={{ minWidth: 44, minHeight: 28, height: 28, border: "1px solid var(--color-border)", borderRadius: 8, padding: "0 8px", color: enabled ? "var(--color-primary)" : "var(--color-text-muted)", background: enabled ? "var(--color-primary-soft)" : "var(--color-surface-muted)", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>{enabled ? "启用" : "停用"}</button>{reorderEnabled && <div className="bank-order-buttons" style={{ paddingRight: 0 }}><button aria-label="向上移动" disabled={index === 0} onClick={() => onMove(bank, -1)}><ArrowUp size={14} /></button><button aria-label="向下移动" disabled={index === total - 1} onClick={() => onMove(bank, 1)}><ArrowDown size={14} /></button></div>}</div></article>;
}

export function BankFolderSection({ folder, banks, draggedBankId, onDrag, onDrop, onOpen, onMove, onToggleEnabled, reorderEnabled = true, onEditFolder, onDeleteFolder }: { folder?: BankFolder; banks: Bank[]; draggedBankId?: string; onDrag: (id?: string) => void; onDrop: (beforeId?: string) => void; onOpen: (bank: Bank) => void; onMove: (bank: Bank, offset: number) => void; onToggleEnabled: (bank: Bank) => void; reorderEnabled?: boolean; onEditFolder?: () => void; onDeleteFolder?: () => void }) {
  const [preview, setPreview] = useState<{ source: Bank[]; value: Bank[] }>(() => ({ source: banks, value: banks }));
  const ordered = preview.value;
  // 同步父级顺序：仅在父级数据变化时重置预览，不在 effect 中 setState。
  if (preview.source !== banks) {
    setPreview({ source: banks, value: banks });
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function reorder(from: number, to: number) {
    if (!reorderEnabled) return;
    if (from < 0 || to < 0 || from >= ordered.length || to >= ordered.length || from === to) return;
    setPreview({ source: preview.source, value: arrayMove(ordered, from, to) });
  }

  function handleDragStart(event: DragStartEvent) {
    if (!reorderEnabled) return;
    onDrag(String(event.active.id));
  }
  function handleDragOver(event: DragOverEvent) {
    if (!reorderEnabled) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ordered.findIndex((bank) => bank.id === active.id);
    const to = ordered.findIndex((bank) => bank.id === over.id);
    reorder(from, to);
  }
  function handleDragEnd(event: DragEndEvent) {
    if (!reorderEnabled) { onDrag(undefined); return; }
    const { active, over } = event;
    // onDragOver 已经实时更新过 preview。dnd-kit 在预览更新后，over 可能已经回到
    // active 自身；此时仍必须提交预览顺序，不能当成 no-op 丢掉。
    const previewChanged = banks.some((bank, index) => ordered[index]?.id !== bank.id);
    if (!previewChanged && (!over || active.id === over.id)) {
      onDrag(undefined);
      return;
    }
    let next = ordered;
    if (!previewChanged) {
      const from = ordered.findIndex((bank) => bank.id === active.id);
      const to = over ? ordered.findIndex((bank) => bank.id === over.id) : -1;
      if (from >= 0 && to >= 0 && from !== to) next = arrayMove(ordered, from, to);
    }
    const movedIndex = next.findIndex((bank) => bank.id === active.id);
    const beforeId = movedIndex >= 0 && movedIndex + 1 < next.length ? next[movedIndex + 1].id : undefined;
    console.log("[drag-debug] drag-end commit", { folderId: folder?.id, activeId: String(active.id), overId: over ? String(over.id) : null, previewChanged, previewIds: ordered.map((bank) => bank.id), nextIds: next.map((bank) => bank.id), beforeId });
    // 提交期间保持 dragging 状态，等 placeBank 持久化后由父级清除；
    // 立即 onDrag(undefined) 会让 props 先回到旧顺序，导致其它卡片闪烁。
    onDrop(beforeId);
  }

  return <section className={`bank-folder ${draggedBankId ? "drag-active" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(); }}><header><span className="folder-icon">{folder ? <FolderOpen size={18} /> : <Library size={18} />}</span><div><h2>{folder?.name ?? "未分组"}</h2><p>{folder?.description || `${banks.length} 个题库`}</p></div><strong>{banks.length}</strong>{folder && <div className="folder-actions"><button aria-label={`编辑文件夹${folder.name}`} onClick={onEditFolder}><Pencil size={15} /></button><button aria-label={`删除文件夹${folder.name}`} onClick={onDeleteFolder}><Trash2 size={15} /></button></div>}</header><DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}><SortableContext items={ordered.map((bank) => bank.id)} strategy={verticalListSortingStrategy}><div className="bank-management-grid">{ordered.map((bank, index) => <SortableBankItem key={bank.id} bank={bank} index={index} total={ordered.length} onOpen={onOpen} onMove={onMove} onToggleEnabled={onToggleEnabled} reorderEnabled={reorderEnabled} />)}</div></SortableContext></DndContext>{!ordered.length && <div className="folder-drop-empty"><Folder size={20} />将题库拖到这里</div>}</section>;
}
