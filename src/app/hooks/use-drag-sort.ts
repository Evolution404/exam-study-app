import { useLayoutEffect, useRef, useState, type DragEvent } from "react";

export interface UseDragSortOptions<T> {
  items: readonly T[];
  /** Called when the preview order should change. Live lists commit every move. */
  onReorder?: (next: T[]) => void;
  /** Called once at the end of a drag when `commitOnDrop` is true. */
  onCommit?: (next: T[]) => void;
  commitOnDrop?: boolean;
}

/**
 * Shared HTML5 drag-sort logic with FLIP move animation.
 *
 * The hook keeps a private preview order so `onDragOver` can reorder in real
 * time while the user is still dragging. When `commitOnDrop` is true, the
 * reordered list is only committed once on drop/drag-end (suitable for lists
 * whose source of truth is persisted elsewhere); otherwise `onReorder` fires
 * on every move (suitable for local component state).
 */
export function useDragSort<T>({ items, onReorder, onCommit, commitOnDrop = false }: UseDragSortOptions<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ordered, setOrdered] = useState<T[]>(() => [...items]);
  const [draggedIndex, setDraggedIndex] = useState<number | undefined>(undefined);
  const draggedIndexRef = useRef<number | undefined>(undefined);
  const draggingRef = useRef(false);
  const pendingCommitRef = useRef<T[] | undefined>(undefined);
  const firstRectsRef = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    if (!draggingRef.current) setOrdered([...items]);
  }, [items]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const firstRects = firstRectsRef.current;
    if (!container || !firstRects.size) return;
    const animations: Animation[] = [];
    for (const element of [...container.querySelectorAll<HTMLElement>("[data-drag-id]")]) {
      const id = element.dataset.dragId;
      if (!id) continue;
      const before = firstRects.get(id);
      if (!before) continue;
      const after = element.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (dx || dy) {
        animations.push(element.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: 180, easing: "ease-out" },
        ));
      }
    }
    firstRectsRef.current = new Map();
    return () => { for (const animation of animations) animation.cancel(); };
  }, [ordered]);

  function captureRects() {
    const container = containerRef.current;
    if (!container) return;
    const rects = new Map<string, DOMRect>();
    for (const element of [...container.querySelectorAll<HTMLElement>("[data-drag-id]")]) {
      const id = element.dataset.dragId;
      if (id) rects.set(id, element.getBoundingClientRect());
    }
    firstRectsRef.current = rects;
  }

  function movePreview(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= ordered.length || to >= ordered.length) return;
    captureRects();
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrdered(next);
    if (commitOnDrop) pendingCommitRef.current = next;
    else onReorder?.(next);
  }

  function startDrag(index: number, event: DragEvent<HTMLElement>) {
    draggingRef.current = true;
    draggedIndexRef.current = index;
    setDraggedIndex(index);
    event.dataTransfer?.setData?.("text/plain", String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function computeTarget(event: DragEvent<HTMLElement>): number {
    const container = containerRef.current;
    const from = draggedIndexRef.current;
    if (!container || from === undefined) return from ?? 0;
    const dragged = container.querySelector<HTMLElement>(`[data-drag-index="${from}"]`);
    let target = 0;
    for (const element of [...container.querySelectorAll<HTMLElement>("[data-drag-index]")]) {
      if (element === dragged) continue;
      const rect = element.getBoundingClientRect();
      if (event.clientY > rect.top + rect.height / 2) target += 1;
    }
    return target;
  }

  function overDrag(_index: number, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const from = draggedIndexRef.current;
    if (from === undefined) return;
    const target = computeTarget(event);
    if (target === from) return;
    movePreview(from, target);
    draggedIndexRef.current = target;
    setDraggedIndex(target);
  }

  function dropDrag(_index: number, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const from = draggedIndexRef.current;
    if (from !== undefined) {
      const target = computeTarget(event);
      if (target !== from) {
        movePreview(from, target);
        draggedIndexRef.current = target;
      }
    }
    finishDrag();
  }

  function finishDrag() {
    if (draggingRef.current && commitOnDrop && pendingCommitRef.current) {
      onCommit?.(pendingCommitRef.current);
    }
    pendingCommitRef.current = undefined;
    draggingRef.current = false;
    draggedIndexRef.current = undefined;
    setDraggedIndex(undefined);
  }

  function handlers(index: number) {
    return {
      draggable: true as const,
      onDragStart: (event: DragEvent<HTMLElement>) => startDrag(index, event),
      onDragOver: (event: DragEvent<HTMLElement>) => overDrag(index, event),
      onDrop: (event: DragEvent<HTMLElement>) => dropDrag(index, event),
      onDragEnd: () => finishDrag(),
    };
  }

  return { ordered, containerRef, draggedIndex, dragHandlers: handlers };
}
