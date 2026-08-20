import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/shell/app-shell";
import { AppErrorBoundary, AppRecoveryScreen } from "./app/error-boundary";
import { dbV7Ready } from "./lib/db/db-v7";
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

void dbV7Ready.then(() => {
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <AppShell />
      </AppErrorBoundary>
    </StrictMode>,
  );
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

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" }).catch(() => undefined);
}
