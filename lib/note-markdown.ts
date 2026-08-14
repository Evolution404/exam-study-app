/**
 * Minimal markdown parser for personal notes (个人解析).
 *
 * Notes are free-form user text, so the grammar is the common working subset:
 * headings, nested ordered/unordered lists (by indentation), block quotes,
 * fenced code, dividers, standalone display formulas, and inline emphasis /
 * code / links — with inline LaTeX ($…$, $$…$$) lifted out unchanged for the
 * katex renderer.  Parsing is a pure function returning a block tree; the
 * React renderer lives in `app/note-markdown.tsx`.  Anything the grammar does
 * not recognise stays literal — a note must never silently lose text.
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

export interface NoteListItem {
  inline: NoteInline[];
  /** Nested lists under this item, keyed by deeper indentation. */
  children: NoteBlock[];
}

export type NoteBlock =
  | { kind: "paragraph"; children: NoteInline[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: NoteInline[] }
  | { kind: "list"; ordered: boolean; items: NoteListItem[] }
  | { kind: "quote"; children: NoteInline[] }
  | { kind: "code"; text: string }
  | { kind: "formula"; source: string }
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
// A whole line that is exactly a display formula becomes its own block, so
// the surrounding paragraph never grows spurious blank lines around it.
const DISPLAY_FORMULA_LINE = /^\$\$([\s\S]+)\$\$$|^\\\[([\s\S]+)\\]$/;

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

function indentWidth(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].replace(/\t/g, "  ").length : 0;
}

interface ListParse {
  block: { kind: "list"; ordered: boolean; items: NoteListItem[] };
  nextIndex: number;
}

/**
 * Parse a whole list region (the item at `lines[start]` and every following
 * line that belongs to it) with an indentation-stack recursion:
 * - a MARKED line at the same indent continues this level (different marker
 *   type at the same indent ends the region instead of breaking numbering);
 * - a marked line at a DEEPER indent opens a nested list under the previous
 *   item (either marker type — an ordered child inside an unordered parent
 *   nests, it does not split the parent);
 * - an unmarked indented line is a continuation of the previous item;
 * - a dedent below this level ends the region.
 */
function parseListRegion(lines: string[], start: number): ListParse {
  const rootMatch = lines[start].match(LIST_ITEM)!;
  const rootIndent = indentWidth(lines[start]);
  const rootOrdered = rootMatch[3] !== undefined;
  let index = start;

  const buildLevel = (indent: number, ordered: boolean): NoteListItem[] => {
    const items: NoteListItem[] = [];
    let current: NoteListItem | undefined;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) break;
      const lineIndent = indentWidth(line);
      const item = line.match(LIST_ITEM);
      if (!item) {
        // Continuation line of the current item; anything shallower or with
        // no open item ends the level.
        if (current && lineIndent >= indent) {
          const extracted = extractInline(line.trim());
          current.inline.push(...parseNoteInline(`\n${extracted.text}`, extracted));
          index += 1;
          continue;
        }
        break;
      }
      const itemOrdered = item[3] !== undefined;
      if (lineIndent > indent + 1) {
        // Deeper item: child list under the previous item.
        const child = buildLevel(lineIndent, itemOrdered);
        if (!current) break;
        current.children.push({ kind: "list", ordered: itemOrdered, items: child });
        continue;
      }
      if (lineIndent < indent - 1) break; // dedent: parent level resumes
      if (itemOrdered !== ordered) break; // same level, other marker type: end region
      const extracted = extractInline(item[4].trim());
      current = { inline: parseNoteInline(extracted.text, extracted), children: [] };
      items.push(current);
      index += 1;
    }
    return items;
  };

  const items = buildLevel(rootIndent, rootOrdered);
  return { block: { kind: "list", ordered: rootOrdered, items }, nextIndex: index };
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
    // A line that is exactly a display formula becomes its own block.
    const displayFormula = line.trim().match(DISPLAY_FORMULA_LINE);
    if (displayFormula) {
      blocks.push({ kind: "formula", source: (displayFormula[1] ?? displayFormula[2]).trim() });
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
    if (LIST_ITEM.test(line)) {
      const parsed = parseListRegion(lines, index);
      blocks.push(parsed.block);
      index = parsed.nextIndex;
      continue;
    }
    // Paragraph: consecutive non-blank lines that start another block type.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !PARAGRAPH_BREAK.test(lines[index]) && !DIVIDER.test(lines[index].trim()) && !DISPLAY_FORMULA_LINE.test(lines[index].trim())) {
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
