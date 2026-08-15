"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as Tooltip from "@radix-ui/react-tooltip";

const EDGE_MARGIN = 12;
const OPEN_DELAY_MS = 250;
const GAP = 8;

/**
 * 全项目统一悬浮提示（替代原生 title=）：
 * - 桌面：tooltip **直接定位在鼠标停下的位置**（水平对准光标，垂直按 side 贴住），
 *   打开后不随鼠标实时移动；离开触发元素 / Esc / 点外部 / 键盘失焦即关闭。
 * - 触控：点按切换打开/关闭（第一次点按打开、再点按/点外部/Esc 关闭），浮层贴近点按位置。
 * - 键盘聚焦也会显示（此时锚定在触发元素中心）。
 * Radix Tooltip 负责状态与触发语义（asChild、焦点/Esc 骨架）；**不用其 popper 定位**
 * ——floating-ui 锚定触发元素，会把任何位移补偿掉，无法"跟随鼠标"。位置直接用
 * fixed + 鼠标 viewport 坐标计算，再做视口钳制。content 用 createPortal 直接挂到 body
 * （Tooltip.Portal 的 Presence 会延迟挂载，导致首帧测量不到尺寸）。点外部/Esc 关闭
 * 由本组件自行监听。label 为空时原样渲染 children。
 */
export function Hint({ label, side = "top", children }: { label?: ReactNode; side?: "top" | "bottom"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const openTimerRef = useRef<number>(0);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<Element | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const contentId = useId();

  useEffect(() => () => window.clearTimeout(openTimerRef.current), []);

  const trackMouse = (event: ReactPointerEvent) => {
    mouseRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleOpenChange = (next: boolean) => {
    openRef.current = next;
    if (next) {
      const m = mouseRef.current;
      // 先给一个初始位置（鼠标附近），content 挂载后测量尺寸再精确修正。
      setPos(m ? { x: m.x, y: m.y } : null);
    } else {
      setPos(null);
      window.clearTimeout(openTimerRef.current);
    }
    setOpen(next);
  };

  // 点外部 / Esc 关闭（绕过 Radix 的 DismissableLayer 后需自行处理）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (contentRef.current?.contains(target)) return;
      handleOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // content 挂载后测量尺寸，把位置修正为：水平居中 + 视口钳制。
  // 垂直方向按空间选择放置侧：默认 side，若该侧空间不足以放下 tooltip 则翻转到另一侧，
  // 避免 tooltip 被钳到视口边缘而盖住触发元素/鼠标（顶栏按钮上方空间不足时曾导致
  // 鼠标微动触发 pointerleave/enter 循环闪烁）。
  useLayoutEffect(() => {
    const m = mouseRef.current;
    const c = contentRef.current;
    if (!open || !m || !c) return;
    const w = c.offsetWidth;
    const h = c.offsetHeight;
    const spaceAbove = m.y - GAP - EDGE_MARGIN;
    const spaceBelow = window.innerHeight - m.y - GAP - EDGE_MARGIN;
    const actualSide = side === "top" ? (spaceAbove < h ? "bottom" : "top") : (spaceBelow < h ? "top" : "bottom");
    let x = m.x - w / 2;
    let y = actualSide === "top" ? m.y - h - GAP : m.y + GAP;
    x = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - w - EDGE_MARGIN));
    y = Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - h - EDGE_MARGIN));
    setPos({ x, y });
  }, [open, side]);

  // Radix Tooltip 只在 pointermove 时触发打开；鼠标静止悬停（无移动事件）会一直不弹，
  // 这里补 pointerenter 延迟打开，行为与原生 title 一致。打开完全由本组件负责。
  const scheduleOpen = (event: ReactPointerEvent) => {
    if (event.pointerType === "touch" || openRef.current) return;
    triggerRef.current = event.currentTarget;
    trackMouse(event);
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => handleOpenChange(true), OPEN_DELAY_MS);
  };

  const scheduleClose = (event: ReactPointerEvent) => {
    if (event.pointerType === "touch") return;
    window.clearTimeout(openTimerRef.current);
    if (openRef.current) handleOpenChange(false);
  };

  if (label == null || label === "") return <>{children}</>;
  return (
    // delayDuration 设极大：关闭 Radix 自己的 pointermove 延迟打开，避免与 scheduleOpen 竞争。
    <Tooltip.Root open={open} onOpenChange={handleOpenChange} delayDuration={60_000}>
      <Tooltip.Trigger
        asChild
        onFocus={(event) => {
          // 键盘聚焦无鼠标：锚定触发元素中心，让浮层显示在元素附近。
          triggerRef.current = event.currentTarget;
          if (!mouseRef.current) {
            const rect = event.currentTarget.getBoundingClientRect();
            mouseRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }}
        onPointerEnter={scheduleOpen}
        onPointerMove={trackMouse}
        onPointerLeave={scheduleClose}
        onPointerDown={(event) => {
          // 触控点按切换：Radix 不响应触控打开，这里在点按的下一个事件循环打开
          // （避开同一 tap 上 Radix 的 onPointerDown/onClick 处理）；再点按则关闭。
          if (event.pointerType === "touch") {
            triggerRef.current = event.currentTarget;
            trackMouse(event);
            if (openRef.current) handleOpenChange(false);
            else window.setTimeout(() => handleOpenChange(true), 0);
          }
        }}
      >
        {children}
      </Tooltip.Trigger>
      {open && pos && createPortal(
        <div ref={contentRef} id={contentId} role="tooltip" data-state="open" className="hint-popover" style={{ position: "fixed", left: pos.x, top: pos.y }}>
          {label}
        </div>,
        document.body
      )}
    </Tooltip.Root>
  );
}
