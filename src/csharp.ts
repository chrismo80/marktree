const KEYWORDS = new Set(
  (
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum " +
    "event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace " +
    "new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc " +
    "static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while " +
    "async await var dynamic nameof partial record get set init yield when where required global and or not with nint nuint"
  ).split(" "),
);
const TYPE_DECLARATIONS = new Set(["class", "struct", "interface", "enum", "record"]);

type TokenKind = "space" | "comment" | "string" | "number" | "pre" | "ident" | "punct" | "html";
type Token = { kind: TokenKind; text: string };

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const highlightedSpan = (className: string, text: string) => `<span class="${className}">${escapeHtml(text)}</span>`;

export function highlightCSharp(code: string): string {
  const tokens = tokenize(code);
  const classes = classifyTokens(tokens);
  return tokens
    .map((t, i) => {
      if (t.kind === "html") return t.text;
      const cls = classes[i];
      return cls ? highlightedSpan(cls, t.text) : escapeHtml(t.text);
    })
    .join("");
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, end: number) => {
    tokens.push({ kind, text: code.slice(i, end) });
    i = end;
  };
  const lineEnd = (from: number) => {
    const n = code.indexOf("\n", from);
    return n < 0 ? code.length : n;
  };
  let lineStart = true;

  while (i < code.length) {
    const c = code[i];
    const rest = code.slice(i);
    let m: RegExpExecArray | null;
    if (/\s/.test(c)) {
      m = /^\s+/.exec(rest)!;
      if (m[0].includes("\n")) lineStart = true;
      push("space", i + m[0].length);
      continue;
    }
    const atLineStart = lineStart;
    lineStart = false;
    if (rest.startsWith("//")) push("comment", lineEnd(i));
    else if (rest.startsWith("/*")) {
      const end = code.indexOf("*/", i + 2);
      push("comment", end < 0 ? code.length : end + 2);
    } else if (c === "#" && atLineStart) push("pre", lineEnd(i));
    else if ((m = /^(\$+|@)?(\$+|@)?("{3,})/.exec(rest))) push("string", rawStringEnd(code, i + m[0].length, m[3].length));
    else if ((m = /^(\$@|@\$|@|\$)?"/.exec(rest))) {
      const prefix = m[1] ?? "";
      if (prefix.includes("$")) {
        const interpolation = tokenizeInterpolatedString(code, i, prefix.includes("@"));
        tokens.push(...interpolation.tokens);
        i = interpolation.end;
      } else push("string", stringEnd(code, i + m[0].length, prefix === "@"));
    } else if (c === "'") push("string", stringEnd(code, i + 1, false, "'"));
    else if ((m = /^(0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)[uUlLfFdDmM]{0,2}/.exec(rest))) push("number", i + m[0].length);
    else if ((m = /^@?[\p{L}_][\p{L}\p{N}_]*/u.exec(rest))) push("ident", i + m[0].length);
    else push("punct", i + 1);
  }
  return tokens;
}

function stringEnd(code: string, from: number, verbatim: boolean, quote = '"'): number {
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (!verbatim && c === "\\") i++;
    else if (verbatim && c === quote && code[i + 1] === quote) i++;
    else if (c === quote) return i + 1;
    else if (c === "\n" && !verbatim) return i;
  }
  return code.length;
}

function rawStringEnd(code: string, from: number, quotes: number): number {
  const end = code.indexOf('"'.repeat(quotes), from);
  return end < 0 ? code.length : end + quotes;
}

function tokenizeInterpolatedString(code: string, start: number, verbatim: boolean): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let i = code.indexOf('"', start) + 1;
  let textStart = start;
  const text = (end: number) => {
    if (end > textStart) tokens.push({ kind: "string", text: code.slice(textStart, end) });
  };
  while (i < code.length) {
    const c = code[i];
    if (!verbatim && c === "\\") i += 2;
    else if (c === '"' && verbatim && code[i + 1] === '"') i += 2;
    else if (c === '"') {
      i++;
      break;
    } else if (c === "\n" && !verbatim) break;
    else if (c === "{" && code[i + 1] === "{") i += 2;
    else if (c === "{") {
      text(i + 1);
      const close = matchingBrace(code, i + 1);
      tokens.push({ kind: "html", text: highlightCSharp(code.slice(i + 1, close)) });
      textStart = close;
      i = close + 1;
    } else i++;
  }
  text(i);
  return { tokens, end: i };
}

function matchingBrace(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '"') i = stringEnd(code, i + 1, false) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && depth-- === 0) return i;
    else if (c === "\n") return i;
  }
  return code.length;
}

const TOKEN_CLASSES: Record<TokenKind, string> = {
  space: "",
  comment: "hljs-comment",
  string: "hljs-string",
  number: "hljs-number",
  pre: "hljs-meta",
  ident: "",
  punct: "",
  html: "",
};
const TYPE_CLASS = "hljs-title class_";
const METHOD_CLASS = "hljs-title function_";
const LOCAL_CLASS = "cs-local";

function classifyTokens(tokens: Token[]): string[] {
  const classes = tokens.map((t) => TOKEN_CLASSES[t.kind]);
  const significantTokenIndices = tokens.map((_, i) => i).filter((i) => tokens[i].kind !== "space" && tokens[i].kind !== "comment");
  const text = (k: number) => (k >= 0 && k < significantTokenIndices.length ? tokens[significantTokenIndices[k]].text : "");
  const isIdent = (k: number) => k >= 0 && k < significantTokenIndices.length && tokens[significantTokenIndices[k]].kind === "ident" && !KEYWORDS.has(text(k));
  const isUpper = (s: string) => /^@?[\p{Lu}]/u.test(s);
  const forced = new Map<number, string>();

  let inNamespaceOrUsing = false;
  let inTypeDeclaration = false;
  let declarationParentheses = 0;
  let attributeDepth = 0;

  for (let k = 0; k < significantTokenIndices.length; k++) {
    const i = significantTokenIndices[k];
    const t = tokens[i];
    const s = t.text;

    if (t.kind === "punct") {
      if (s === ";" || s === "{" || s === "=") inNamespaceOrUsing = false;
      if (s === "{" || s === ";") inTypeDeclaration = false;
      if (inTypeDeclaration && s === "(") declarationParentheses++;
      if (inTypeDeclaration && s === ")") declarationParentheses--;
      if (s === "[" && attributeDepth === 0 && (k === 0 || ["{", "}", ";", "]"].includes(text(k - 1)))) attributeDepth = 1;
      else if (s === "[" && attributeDepth > 0) attributeDepth++;
      else if (s === "]" && attributeDepth > 0) attributeDepth--;
      continue;
    }
    if (t.kind !== "ident") continue;

    if (KEYWORDS.has(s)) {
      classes[i] = "hljs-keyword";
      if ((s === "namespace" || s === "using") && (isIdent(k + 1) || ["static", "global"].includes(text(k + 1)))) inNamespaceOrUsing = true;
      if (TYPE_DECLARATIONS.has(s)) {
        inTypeDeclaration = true;
        declarationParentheses = 0;
      }
      continue;
    }
    if (forced.has(k)) {
      classes[i] = forced.get(k)!;
      continue;
    }
    if (inNamespaceOrUsing) continue;

    const prev = text(k - 1);
    const next = text(k + 1);
    const generic = next === "<" ? findGenericArgumentEnd(k + 1) : -1;
    if (generic >= 0) for (let g = k + 2; g < generic; g++) if (isIdent(g)) forced.set(g, TYPE_CLASS);
    const afterName = generic >= 0 ? generic + 1 : k + 1;

    if (inTypeDeclaration && declarationParentheses === 0) classes[i] = TYPE_CLASS;
    else if (attributeDepth > 0 && (prev === "[" || prev === "," || prev === ":") && text(k - 2) !== "(") classes[i] = TYPE_CLASS;
    else if (["new", "typeof", "is", "as"].includes(prev) || (prev === "(" && next === ")" && isUpper(s) && isIdent(k + 2))) classes[i] = TYPE_CLASS;
    else if (text(afterName) === "(") classes[i] = METHOD_CLASS;
    else if (generic >= 0) classes[i] = TYPE_CLASS;
    else if (prev === ".") continue;
    else if (isUpper(s) && (next === "." || isIdent(afterTypeSuffix(k + 1)))) classes[i] = TYPE_CLASS;
    else if (/^@?\p{Ll}/u.test(s)) classes[i] = LOCAL_CLASS;
  }
  return classes;

  function findGenericArgumentEnd(open: number): number {
    let depth = 0;
    for (let k = open; k < significantTokenIndices.length; k++) {
      const s = text(k);
      const t = tokens[significantTokenIndices[k]];
      if (s === "<") depth++;
      else if (s === ">" && --depth === 0) return k;
      else if (!(t.kind === "ident" || [",", ".", "?", "[", "]", "(", ")"].includes(s))) return -1;
    }
    return -1;
  }

  function afterTypeSuffix(k: number): number {
    while (text(k) === "?" || (text(k) === "[" && text(k + 1) === "]")) k += text(k) === "?" ? 1 : 2;
    return k;
  }
}
