"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { isNativeApp } from "@/platform/environment";
import { updateServiceWorkerWithinTimeout } from "../helpers";

export function PullToRefresh({ onBeforeReload }: { onBeforeReload?: () => void }) {
  const native = isNativeApp();
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const currentDistance = useRef(0);

  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".workspace");
    if (!scroller) return;
    let disposed = false;
    let inFlight = false;
    const reset = () => {
      start.current = null;
      currentDistance.current = 0;
      setPulling(false);
      setDistance(0);
    };
    const onStart = (event: TouchEvent) => {
      if (inFlight) return;
      const target = event.target instanceof Element ? event.target : null;
      reset();
      if (scroller.scrollTop > 0 || event.touches.length !== 1 || target?.closest("button, a, input, textarea, select, [role='dialog'], [data-no-pull-refresh], .search-results, .editor-backdrop, .overview-backdrop, .search-detail-backdrop, .simple-dialog-backdrop")) return;
      start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const onMove = (event: TouchEvent) => {
      if (!start.current) return;
      if (scroller.scrollTop > 0 || event.touches.length !== 1) { reset(); return; }
      const dx = event.touches[0].clientX - start.current.x;
      const dy = event.touches[0].clientY - start.current.y;
      if (dy <= 0 || Math.abs(dx) >= dy) {
        if (Math.abs(dx) > 10 || dy < -4) reset();
        return;
      }
      if (dy < 12) return;
      event.preventDefault();
      const next = Math.min(104, (dy - 12) * .42);
      currentDistance.current = next;
      setPulling(true);
      setDistance(next);
    };
    const onEnd = async () => {
      start.current = null;
      setPulling(false);
      if (currentDistance.current < 64 || inFlight) {
        reset();
        return;
      }
      inFlight = true;
      setRefreshing(true);
      setDistance(52);
      try {
        // Browser/PWA refresh also gives the service worker a best-effort
        // update opportunity. Native WKWebView has no service worker; reload
        // only the current React document and let persisted app data restore
        // the screen.
        if (!native) await updateServiceWorkerWithinTimeout();
      } finally {
        // Navigation into practice unmounts this component. A pending update
        // must not finish later and reload the newly started exercise.
        if (!disposed) {
          reset();
          setRefreshing(false);
          onBeforeReload?.();
          window.location.reload();
        }
      }
    };
    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: false });
    const handleEnd = () => { void onEnd(); };
    scroller.addEventListener("touchend", handleEnd, { passive: true });
    scroller.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      disposed = true;
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", handleEnd);
      scroller.removeEventListener("touchcancel", reset);
    };
  }, [native, onBeforeReload]);

  return <div role="status" aria-live="polite" className={`pull-refresh ${refreshing ? "refreshing" : ""} ${pulling ? "pulling" : ""} ${distance >= 64 ? "ready" : ""}`} style={{ transform: `translate(-50%, ${distance - 54}px)`, opacity: distance ? 1 : 0 }}><RefreshCw size={17} /><span>{refreshing ? "正在加载最新版…" : distance >= 64 ? "松开刷新" : "下拉刷新"}</span></div>;
}
