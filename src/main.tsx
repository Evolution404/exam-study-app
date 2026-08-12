import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudyApp } from "../app/study-app";
import "../app/globals.css";
// 标题衬线中文字体：分片（unicode-range）+ 按需加载，让手机端与桌面标题字体一致。
import "@fontsource/noto-serif-sc/500.css";
import "@fontsource/noto-serif-sc/600.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudyApp />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" }).catch(() => undefined);
}
