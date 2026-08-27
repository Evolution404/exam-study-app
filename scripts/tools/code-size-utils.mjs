import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

export const root = process.cwd();
export const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"]);

export function walk(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export function repoPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

export function fileBytes(path) {
  return statSync(path).size;
}

export function fileMetrics(path) {
  const text = readFileSync(path, "utf8");
  return { path: repoPath(path), bytes: fileBytes(path), lines: text === "" ? 0 : text.split("\n").length };
}
