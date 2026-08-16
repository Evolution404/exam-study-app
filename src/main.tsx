import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/shell/app-shell";
import { dbV7Ready } from "./lib/db/db-v7";
import "./app/globals.css";
// 标题衬线中文字体：构建时由 scripts/tools/subset-title-font.mjs 扫描静态文案自动子集化，
// 只打包实际用到的字形（见 src/generated/，prebuild/predev 生成）。
import "./generated/title-font.css";

async function bootstrap() {
  await dbV7Ready;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppShell />
    </StrictMode>,
  );
}

void bootstrap();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" }).catch(() => undefined);
}
