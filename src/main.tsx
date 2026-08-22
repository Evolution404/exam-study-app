import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/shell/app-shell";
import { AppErrorBoundary, AppRecoveryScreen } from "./app/error-boundary";
import { dbV7Ready } from "./lib/db/db-v7";
import { platformRuntime, registerServiceWorker } from "./platform/runtime";
import "./app/globals.css";
// 标题衬线中文字体：构建时由 scripts/tools/subset-title-font.mjs 扫描静态文案自动子集化，
// 只打包实际用到的字形（见 src/generated/，prebuild/predev 生成）。
import "./generated/title-font.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("应用根节点不存在");
const root = createRoot(rootElement);

function retryBootstrap() {
  window.location.reload();
}

const platformRuntimeReady = platformRuntime.initialize();

// registerServiceWorker preserves the existing `{ updateViaCache: "none" }`
// contract for Web/PWA while runtime.ts gates native WKWebView.
void dbV7Ready.then(() => platformRuntimeReady).then((environment) => {
  // Native-only layout fixes need an explicit runtime marker. Keeping this on
  // <html> avoids user-agent sniffing and leaves Web/PWA geometry untouched.
  document.documentElement.dataset.platform = environment.platform;
  document.documentElement.dataset.native = environment.native ? "true" : "false";

  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <AppShell />
      </AppErrorBoundary>
    </StrictMode>,
  );
  void registerServiceWorker(import.meta.env.PROD, environment, `${import.meta.env.BASE_URL}sw.js`);
}).catch((error: unknown) => {
  // A failed migration used to reject before React mounted, leaving a blank
  // page. Keep this fallback outside AppShell so the user can retry without
  // touching IndexedDB or localStorage.
  root.render(
    <StrictMode>
      <AppRecoveryScreen error={error} onRetry={retryBootstrap} />
    </StrictMode>,
  );
});
