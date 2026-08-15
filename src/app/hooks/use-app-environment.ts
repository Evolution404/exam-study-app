import { useEffect } from "react";

export type ThemeMode = "system" | "light" | "dark";

export function useAppTheme(mode: ThemeMode) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      const resolved = dark ? "dark" : "light";
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#111813" : "#203a2e");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
}

export function useAppViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const safeAreaProbe = document.createElement("div");
    safeAreaProbe.style.cssText = "position:fixed;left:-9999px;bottom:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none";
    document.body.appendChild(safeAreaProbe);
    const update = () => {
      const visualBottom = window.visualViewport ? window.visualViewport.height + window.visualViewport.offsetTop : 0;
      const regularHeight = Math.max(window.innerHeight, root.clientHeight, visualBottom);
      const screenHeight = window.screen.height;
      const standaloneHeight = standalone && screenHeight >= regularHeight && screenHeight - regularHeight < 180 ? screenHeight : regularHeight;
      const reportedSafeBottom = Number.parseFloat(getComputedStyle(safeAreaProbe).paddingBottom) || 0;
      const missingStandaloneArea = standalone ? Math.max(0, standaloneHeight - regularHeight) : 0;
      root.style.setProperty("--app-viewport-height", `${Math.round(Math.max(regularHeight, standaloneHeight))}px`);
      root.style.setProperty("--app-safe-bottom", `${Math.round(Math.max(reportedSafeBottom, Math.min(40, missingStandaloneArea)))}px`);
    };
    const timers = [0, 250, 800].map((delay) => window.setTimeout(update, delay));
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.addEventListener("pageshow", update);
    window.visualViewport?.addEventListener("resize", update);
    const onVisibilityChange = () => { if (document.visibilityState === "visible") update(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.removeEventListener("pageshow", update);
      window.visualViewport?.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      safeAreaProbe.remove();
    };
  }, []);
}
