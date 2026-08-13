import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StudyApp } from "../app/study-app";
import "../app/globals.css";
// 标题衬线中文字体：构建时由 scripts/subset-title-font.mjs 扫描静态文案自动子集化，
// 只打包实际用到的字形（见 src/generated/，prebuild/predev 生成）。
import "./generated/title-font.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudyApp />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" }).catch(() => undefined);
}
