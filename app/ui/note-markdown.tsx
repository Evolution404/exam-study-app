import { useEffect, useMemo, useState, type ReactNode } from "react";
import { loadKatex } from "@/app/ui/math-text";
import { parseNoteMarkdown, type NoteBlock, type NoteInline, type NoteListItem } from "@/lib/note-markdown";

type KatexRenderer = typeof import("katex")["default"];

/** Render one LaTeX formula with the same lazy katex loader the question text
 *  uses; until katex arrives the raw source stays visible. */
function Formula({ source, display }: { source: string; display: boolean }) {
  const [katex, setKatex] = useState<KatexRenderer>();
  useEffect(() => {
    let active = true;
    void loadKatex().then((renderer) => { if (active) setKatex(() => renderer); });
    return () => { active = false; };
  }, []);
  if (!katex) return <code className="note-md-formula-raw">{source}</code>;
  const html = katex.renderToString(source, { displayMode: display, throwOnError: false, strict: false, output: "html" });
  return <span className={display ? "latex-formula block" : "latex-formula"} dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderInline(nodes: readonly NoteInline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case "text": return <span key={key}>{node.text}</span>;
      case "code": return <code key={key}>{node.text}</code>;
      case "bold": return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "italic": return <em key={key}>{renderInline(node.children, key)}</em>;
      case "link": return <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">{renderInline(node.children, key)}</a>;
      case "formula": return <Formula key={key} source={node.source} display={node.display} />;
    }
  });
}

function renderItems(items: readonly NoteListItem[], keyPrefix: string): ReactNode[] {
  return items.map((item, index) => {
    const key = `${keyPrefix}-item-${index}`;
    return <li key={key}>{renderInline(item.inline, key)}{item.children.map((child, childIndex) => renderBlock(child, `${key}-child-${childIndex}`))}</li>;
  });
}

function renderBlock(block: NoteBlock, index: number | string): ReactNode {
  const key = `block-${index}`;
  switch (block.kind) {
    case "paragraph": return <p key={key}>{renderInline(block.children, key)}</p>;
    case "heading": {
      const content = renderInline(block.children, key);
      if (block.level === 1) return <h4 key={key}>{content}</h4>;
      if (block.level === 2) return <h5 key={key}>{content}</h5>;
      return <h6 key={key}>{content}</h6>;
    }
    case "list":
      if (block.ordered) return <ol key={key}>{renderItems(block.items, key)}</ol>;
      return <ul key={key}>{renderItems(block.items, key)}</ul>;
    case "quote": return <blockquote key={key}>{renderInline(block.children, key)}</blockquote>;
    case "code": return <pre key={key}><code>{block.text}</code></pre>;
    case "formula": return <div key={key} className="note-md-display-formula"><Formula source={block.source} display /></div>;
    case "divider": return <hr key={key} />;
  }
}

/**
 * Render a personal note (个人解析) as markdown with LaTeX formulas.  A note
 * with no markdown syntax parses into one plain paragraph, so existing notes
 * render exactly as before; an empty note renders nothing and the caller shows
 * its own empty-state copy.
 */
export function NoteMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseNoteMarkdown(text), [text]);
  if (!blocks.length) return null;
  return <div className="note-markdown">{blocks.map(renderBlock)}</div>;
}
