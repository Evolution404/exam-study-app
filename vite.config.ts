import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const commitSha = process.env.GITHUB_SHA?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const commitTime = execFileSync("git", ["show", "-s", "--format=%cI", commitSha], { cwd: root, encoding: "utf8" }).trim();

// Cloudflare Pages 构建环境注入 CF_PAGES=1，部署到根路径；GitHub Pages 用 /exam-study-app/ 子路径。
// Capacitor copies the built files into a local WKWebView, so its asset base
// must be relative to the bundled index.html rather than either web deploy
// path. Keep this decision at build time; runtime URL rewriting breaks the
// static PWA and Pages deployments.
export function resolveBuildBase(env: { APP_TARGET?: string; CF_PAGES?: string } = process.env) {
  if (env.APP_TARGET === "ios") return "./";
  return env.CF_PAGES ? "/" : "/exam-study-app/";
}

const deployBase = resolveBuildBase();

export default defineConfig({
  base: deployBase,
  plugins: [react()],
  define: {
    __APP_COMMIT_SHA__: JSON.stringify(commitSha),
    __APP_COMMIT_TIME__: JSON.stringify(commitTime),
  },
  resolve: {
    alias: { "@": path.join(root, "src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react-vendor", test: /node_modules[/](react|react-dom|scheduler)[/]/ },
            { name: "dexie-vendor", test: /node_modules[/](dexie|dexie-react-hooks)[/]/ },
            { name: "katex-vendor", test: /node_modules[/]katex[/]/ },
            { name: "lucide-vendor", test: /node_modules[/]lucide-react[/]/ },
          ],
        },
      },
    },
  },
});
