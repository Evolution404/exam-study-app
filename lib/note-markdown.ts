/**
 * Minimal markdown parser for personal notes (个人解析).
 *
 * Notes are free-form user text, so the grammar is the common working subset:
 * headings, ordered/unordered lists, block quotes, fenced code, dividers, and
 * inline emphasis / code / links — with LaTeX formulas ($…$, $$…$$) lifted out
 * unchanged for the katex renderer.  Parsing is a pure function returning a
 * block tree; the React renderer lives in `app/note-markdown.tsx`.  Anything
 * the grammar does not recognise stays literal — a note must never silently
 * lose text.
 */
import { LATEX_PART } from "./display-typography";

export interface NoteFormulaToken {
  kind: "formula";
  source: string;
  display: boolean;
}

export type NoteInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: NoteInline[] }
  | { kind: "italic"; children: NoteInline[] }
  | { kind: "link"; href: string; children: NoteInline[] }
  | NoteFormulaToken;

export type NoteBlock =
  | { kind: "paragraph"; children: NoteInline[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: NoteInline[] }
  | { kind: "list"; ordered: boolean; items: NoteInline[][] }
  | { kind: "quote"; children: NoteInline[] }
  | { kind: "code"; text: string }
  | { kind: "divider" };

// Rare single-byte sentinels fence extracted tokens (code spans, formulas) so
// markdown emphasis can never eat them; they are resolved at inline-parse
// time.  Built with fromCharCode so the source holds no literal control bytes.
const FORMULA_MARK = String.fromCharCode(1);
const CODE_MARK = String.fromCharCode(2);
const INLINE_PATTERN = new RegExp(
  `(${CODE_MARK}[0-9]+${CODE_MARK})`
  + "|(`[^`\\n]+`)"
  + "|(\\*\\*(?:[^*]|\\*(?!\\*))+?\\*\\*)"
  + "|(\\*[^*\\n]+\\*)"
  + "|(_[^_\\n]+_)"
  + "|(\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^\\s)]+\\))",
  "g",
);
const FORMULA_SENTINEL = new RegExp(`${FORMULA_MARK}([0-9]+)${FORMULA_MARK}`);
// Bullets need a space after the marker (so "-3" stays text); the Chinese
// ordinal "1、" is written without one, so ordered markers take \s*.
const LIST_ITEM = /^(\s*)(?:([-*])\s+|(\d+)[.、]\s*)(.*)$/;
const DIVIDER = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?/;
const PARAGRAPH_BREAK = /^(#{1,3}\s|```|\s*>|\s*(?:[-*]\s|\d+[.、]))/;
// A line that matches PARAGRAPH_BREAK but not LIST_ITEM must still advance the
// paragraph scanner, so the two patterns stay consistent by construction.

function formulaToken(match: string): NoteFormulaToken {
  if (match.startsWith("$$")) return { kind: "formula", source: match.slice(2, -2), display: true };
  if (match.startsWith("\\[")) return { kind: "formula", source: match.slice(2, -2), display: true };
  if (match.startsWith("\\(")) return { kind: "formula", source: match.slice(2, -2), display: false };
  return { kind: "formula", source: match.slice(1, -1), display: false };
}

interface ExtractedInline {
  text: string;
  formulas: NoteFormulaToken[];
  codes: string[];
}

/** Code spans are extracted FIRST so formulas inside backticks stay literal
 *  code; formulas are extracted second so emphasis can never touch math. */
function extractInline(text: string): ExtractedInline {
  const codes: string[] = [];
  let stripped = text.replace(/`[^`\n]+`/g, (match) => {
    codes.push(match.slice(1, -1));
    return `${CODE_MARK}${codes.length - 1}${CODE_MARK}`;
  });
  const formulas: NoteFormulaToken[] = [];
  stripped = stripped.replace(new RegExp(LATEX_PART.source, "g"), (match) => {
    formulas.push(formulaToken(match));
    return `${FORMULA_MARK}${formulas.length - 1}${FORMULA_MARK}`;
  });
  return { text: stripped, formulas, codes };
}

export function parseNoteInline(text: string, extracted: ExtractedInline): NoteInline[] {
  const result: NoteInline[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) result.push(...plainRuns(text.slice(cursor, index), extracted));
    const [full, codeSentinel, codeSpan, bold, star, underscore, link] = match;
    if (codeSentinel) {
      const code = extracted.codes[Number(codeSentinel.slice(1, -1))];
      if (code !== undefined) result.push({ kind: "code", text: code });
      else result.push({ kind: "text", text: codeSentinel });
    } else if (codeSpan) {
      result.push({ kind: "code", text: codeSpan.slice(1, -1) });
    } else if (bold) {
      result.push({ kind: "bold", children: parseNoteInline(bold.slice(2, -2), extracted) });
    } else if (star) {
      result.push({ kind: "italic", children: parseNoteInline(star.slice(1, -1), extracted) });
    } else if (underscore) {
      result.push({ kind: "italic", children: parseNoteInline(underscore.slice(1, -1), extracted) });
    } else if (link) {
      const split = link.indexOf("](");
      const label = link.slice(1, split);
      const href = link.slice(split + 2, -1);
      result.push({ kind: "link", href, children: parseNoteInline(label, extracted) });
    }
    cursor = index + full.length;
  }
  if (cursor < text.length) result.push(...plainRuns(text.slice(cursor), extracted));
  return result;
}

/** Split a plain run on formula sentinels, keeping untouched text as text. */
function plainRuns(text: string, extracted: ExtractedInline): NoteInline[] {
  const runs: NoteInline[] = [];
  let cursor = 0;
  for (const match of text.matchAll(new RegExp(FORMULA_SENTINEL.source, "g"))) {
    const index = match.index ?? 0;
    if (index > cursor) runs.push({ kind: "text", text: text.slice(cursor, index) });
    const token = extracted.formulas[Number(match[1])];
    if (token) runs.push(token);
    else runs.push({ kind: "text", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) runs.push({ kind: "text", text: text.slice(cursor) });
  return runs;
}

/** Parse a note into blocks.  An all-whitespace note yields no blocks. */
export function parseNoteMarkdown(source: string): NoteBlock[] {
  const text = source.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n");
  const blocks: NoteBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    // Fenced code: the closing fence is optional at the end of a note.
    if (FENCE.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (DIVIDER.test(line.trim())) {
      blocks.push({ kind: "divider" });
      index += 1;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const extracted = extractInline(heading[2].trim());
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, children: parseNoteInline(extracted.text, extracted) });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(lines[index].replace(QUOTE, ""));
        index += 1;
      }
      const extracted = extractInline(body.join("\n"));
      blocks.push({ kind: "quote", children: parseNoteInline(extracted.text, extracted) });
      continue;
    }
    const listMatch = line.match(LIST_ITEM);
    if (listMatch) {
      // "-" / "*" are bullets (group 2), "1." / "1、" are ordered (group 3);
      // the two never mix inside one list block.
      const ordered = listMatch[3] !== undefined;
      const items: NoteInline[][] = [];
      while (index < lines.length) {
        const item = lines[index].match(LIST_ITEM);
        if (!item || (item[3] !== undefined) !== ordered) break;
        const extracted = extractInline(item[4].trim());
        items.push(parseNoteInline(extracted.text, extracted));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    // Paragraph: consecutive non-blank lines that start another block type.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !PARAGRAPH_BREAK.test(lines[index]) && !DIVIDER.test(lines[index].trim())) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (!paragraph.length) {
      // Invariant backstop: a line that broke the paragraph scan without being
      // consumed by its own branch must still advance — never loop forever.
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const extracted = extractInline(paragraph.join("\n"));
    blocks.push({ kind: "paragraph", children: parseNoteInline(extracted.text, extracted) });
  }
  return blocks;
}
