import katex from "katex";
import type { ReactNode } from "react";

const LATEX_PART = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:\\.|[^$\\])+?\$)/g;

function formulaSource(value: string) {
  if (value.startsWith("$$")) return { source: value.slice(2, -2), displayMode: true };
  if (value.startsWith("\\[")) return { source: value.slice(2, -2), displayMode: true };
  if (value.startsWith("\\(")) return { source: value.slice(2, -2), displayMode: false };
  return { source: value.slice(1, -1), displayMode: false };
}

export function MathText({ text, className }: { text: string; className?: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LATEX_PART)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(text.slice(cursor, index));
    const { source, displayMode } = formulaSource(match[0]);
    const html = katex.renderToString(source, { displayMode, throwOnError: false, strict: false, output: "html" });
    parts.push(<span className={displayMode ? "latex-formula block" : "latex-formula"} dangerouslySetInnerHTML={{ __html: html }} key={`${index}-${match[0]}`} />);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <span className={`math-text${className ? ` ${className}` : ""}`}>{parts.length ? parts : text}</span>;
}
