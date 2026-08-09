const HAN_TEXT = /\p{Script=Han}/u;
const ASCII_WORD = /[A-Za-z0-9_]/;

export const LATEX_PART = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:\\.|[^$\\])+?\$)/g;

function isAsciiWord(value?: string) {
  return Boolean(value && ASCII_WORD.test(value));
}

function formatPlainText(value: string, quoteState: { doubleOpen: boolean; singleOpen: boolean }) {
  const output: string[] = [];
  const parenthesisStyle: boolean[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const previous = value[index - 1];
    const next = value[index + 1];

    if (value.startsWith("...", index)) {
      output.push("……");
      index += 2;
      continue;
    }
    if (character === ",") {
      output.push(/\d/.test(previous ?? "") && /\d/.test(next ?? "") ? character : "，");
      continue;
    }
    if (character === ".") {
      const optionLabel = /^[A-Z]$/.test(previous ?? "") && /\s/.test(next ?? "") && (index === 1 || /\s/.test(value[index - 2] ?? ""));
      const technicalDot = isAsciiWord(previous) && isAsciiWord(next);
      output.push(optionLabel || technicalDot ? character : "。");
      continue;
    }
    if (character === ":") {
      const technicalColon = (next === "/" && value[index + 2] === "/")
        || (/\d/.test(previous ?? "") && /\d/.test(next ?? ""))
        || (isAsciiWord(previous) && isAsciiWord(next));
      output.push(technicalColon ? character : "：");
      continue;
    }
    if (character === ";") { output.push("；"); continue; }
    if (character === "?") { output.push("？"); continue; }
    if (character === "!") { output.push(next === "=" ? character : "！"); continue; }
    if (character === "(") {
      const closingIndex = value.indexOf(")", index + 1);
      const chineseParenthesis = closingIndex > index && HAN_TEXT.test(value.slice(index + 1, closingIndex));
      parenthesisStyle.push(chineseParenthesis);
      output.push(chineseParenthesis ? "（" : character);
      continue;
    }
    if (character === ")") {
      output.push(parenthesisStyle.pop() ? "）" : character);
      continue;
    }
    if (character === '"') {
      output.push(quoteState.doubleOpen ? "“" : "”");
      quoteState.doubleOpen = !quoteState.doubleOpen;
      continue;
    }
    if (character === "'") {
      if (isAsciiWord(previous) && isAsciiWord(next)) output.push(character);
      else {
        output.push(quoteState.singleOpen ? "‘" : "’");
        quoteState.singleOpen = !quoteState.singleOpen;
      }
      continue;
    }
    output.push(character);
  }

  return output.join("")
    .replace(/[ \t]+([，。；：？！）])/g, "$1")
    .replace(/（[ \t]+/g, "（")
    .replace(/([，。；：？！])[ \t]+/g, "$1");
}

export function hasChineseText(value: string) {
  return HAN_TEXT.test(value);
}

export function formatQuestionDisplayText(value: string, languageReference = value) {
  if (!hasChineseText(languageReference)) return value;
  const quoteState = { doubleOpen: true, singleOpen: true };
  const output: string[] = [];
  let cursor = 0;

  for (const match of value.matchAll(LATEX_PART)) {
    const index = match.index ?? 0;
    if (index > cursor) output.push(formatPlainText(value.slice(cursor, index), quoteState));
    output.push(match[0]);
    cursor = index + match[0].length;
  }
  if (cursor < value.length) output.push(formatPlainText(value.slice(cursor), quoteState));
  return output.join("");
}
