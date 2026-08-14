import { useEffect, useState, type ReactNode } from "react";
import { formatQuestionDisplayText, LATEX_PART } from "@/lib/display-typography";

type KatexRenderer = typeof import("katex")["default"];

let katexPromise: Promise<KatexRenderer> | undefined;

function loadKatex() {
  if (!katexPromise) {
    void import("katex/dist/katex.min.css");
    katexPromise = import("katex").then((module) => module.default);
  }
  return katexPromise;
}

export { loadKatex };

function formulaSource(value: string) {
  if (value.startsWith("$$")) return { source: value.slice(2, -2), displayMode: true };
  if (value.startsWith("\\[")) return { source: value.slice(2, -2), displayMode: true };
  if (value.startsWith("\\(")) return { source: value.slice(2, -2), displayMode: false };
  return { source: value.slice(1, -1), displayMode: false };
}

function containsFormula(value: string) {
  return new RegExp(LATEX_PART.source, LATEX_PART.flags.replace("g", "")).test(value);
}

export function MathText({ text, className, languageText }: { text: string; className?: string; languageText?: string }) {
  const displayText = formatQuestionDisplayText(text, languageText ?? text);
  const needsKatex = containsFormula(displayText);
  const [katex, setKatex] = useState<KatexRenderer>();

  useEffect(() => {
    if (!needsKatex || katex) return;
    let active = true;
    void loadKatex().then((renderer) => { if (active) setKatex(() => renderer); });
    return () => { active = false; };
  }, [katex, needsKatex]);

  if (!needsKatex || !katex) return <span className={`math-text${className ? ` ${className}` : ""}`}>{displayText}</span>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of displayText.matchAll(LATEX_PART)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(displayText.slice(cursor, index));
    const { source, displayMode } = formulaSource(match[0]);
    const html = katex.renderToString(source, { displayMode, throwOnError: false, strict: false, output: "html" });
    parts.push(<span className={displayMode ? "latex-formula block" : "latex-formula"} dangerouslySetInnerHTML={{ __html: html }} key={`${index}-${match[0]}`} />);
    cursor = index + match[0].length;
  }
  if (cursor < displayText.length) parts.push(displayText.slice(cursor));
  return <span className={`math-text${className ? ` ${className}` : ""}`}>{parts}</span>;
}
