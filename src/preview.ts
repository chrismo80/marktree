import markdownit, { type MarkdownIt } from "markdown-it";
import { full as emoji } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { MermaidConfig } from "mermaid";
import { dirname, resolveMarkdownLink } from "./paths";
import { highlightCSharp } from "./csharp";

const md: MarkdownIt = markdownit({
  html: true,
  linkify: true,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    let html: string;
    if (language && hljs.getLanguage(language) === hljs.getLanguage("csharp")) html = highlightCSharp(code);
    else html = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : md.utils.escapeHtml(code);
    return `<pre class="code"><code class="hljs">${html}</code></pre>`;
  },
})
  .use(footnote)
  .use(emoji);

const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

/** GitHub's alerts such as "> [!NOTE]" become a titled box instead of a quote that shows the marker. */
md.core.ruler.push("github_alerts", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const inline = tokens[i + 2];
    if (tokens[i].type !== "blockquote_open" || tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const marker = ALERT_MARKER.exec(inline.content);
    if (!marker) continue;
    const kind = marker[1].toLowerCase();
    tokens[i].attrJoin("class", `alert alert-${kind}`);
    inline.content = inline.content.slice(marker[0].length);
    inline.children = [];
    state.md.inline.parse(inline.content, state.md, state.env, inline.children);
    // With the marker on a line of its own, the first paragraph is now empty.
    if (!inline.content.trim()) tokens.splice(i + 1, 3);
    const title = new state.Token("html_block", "", 0);
    title.content = `<p class="alert-title">${kind[0].toUpperCase()}${kind.slice(1)}</p>\n`;
    tokens.splice(i + 1, 0, title);
  }
});

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim().toLowerCase() === "mermaid") {
    return `<div class="mermaid">${md.utils.escapeHtml(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

md.core.ruler.push("heading_ids", (state) => {
  const used = new Map<string, number>();
  state.tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    const text = state.tokens[i + 1]?.children?.map((t) => t.content).join("") ?? "";
    const base = headingAnchor(text);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    token.attrSet("id", count ? `${base}-${count}` : base);
  });
});

function headingAnchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export type LinkTarget = { kind: "anchor"; id: string } | { kind: "external"; url: string } | { kind: "file"; path: string; id: string };

let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
let renderCount = 0;

export async function renderMarkdown(target: HTMLElement, source: string, documentPath: string, root: string, dark: boolean) {
  const run = ++renderCount;
  target.innerHTML = sanitizedMarkdown(source);
  const documentDir = dirname(documentPath);

  for (const img of target.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (src && !hasScheme(src)) img.src = convertFileSrc(resolveMarkdownLink(documentDir, decodeURIComponent(src), root));
  }
  markTaskLists(target);
  addCopyButtons(target);

  const diagrams = [...target.querySelectorAll<HTMLElement>("div.mermaid")];
  if (!diagrams.length) return;
  mermaidLoader ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidLoader;
  if (run !== renderCount) return;
  mermaid.initialize(themeMermaidConfig(dark));
  for (const [index, el] of diagrams.entries()) {
    const id = `mermaid-${run}-${index}`;
    try {
      // render() draws outside the preview; inside it, the zoom would distort text measurement.
      const { svg, bindFunctions } = await mermaid.render(id, el.textContent ?? "");
      el.innerHTML = svg;
      bindFunctions?.(el);
      keepLabelsReadable(el);
    } catch (error) {
      removeFailedMermaidRender(id);
      el.classList.add("mermaid-error");
      el.textContent = `Invalid Mermaid diagram: ${error instanceof Error ? error.message : error}`;
    }
    if (run !== renderCount) return;
  }
}

// WCAG's minimum for large text; below it, a label is hard to read rather than just low-key.
const MIN_LABEL_CONTRAST = 3;

type Rgb = [number, number, number];

const DARK_LABEL: Rgb = [31, 35, 40];
const LIGHT_LABEL: Rgb = [246, 248, 250];

/**
 * Authors often fill nodes with light colors without setting a text color, which leaves the
 * theme's light text unreadable on them in dark themes, and dark text on dark fills in light ones.
 * Only such labels change; a readable color the author chose stays.
 */
function keepLabelsReadable(diagram: HTMLElement) {
  for (const group of diagram.querySelectorAll("g.node, g.cluster")) {
    const shape = group.querySelector("rect, polygon, path, circle, ellipse");
    const fill = shape && parseRgb(getComputedStyle(shape).fill);
    if (!fill) continue;
    for (const label of group.querySelectorAll<HTMLElement | SVGElement>(".nodeLabel, text")) {
      const property = label instanceof SVGElement ? "fill" : "color";
      const color = parseRgb(getComputedStyle(label)[property]);
      if (!color || contrast(fill, color) >= MIN_LABEL_CONTRAST) continue;
      const readable = contrast(fill, DARK_LABEL) >= contrast(fill, LIGHT_LABEL) ? DARK_LABEL : LIGHT_LABEL;
      label.style.setProperty(property, `rgb(${readable.join(", ")})`, "important");
    }
  }
}

/** Transparent colors count as missing, because what shows through is unknown. */
function parseRgb(color: string): Rgb | null {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color);
  if (!match || match[4] === "0" || match[4] === "0%") return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: Rgb): number {
  const linear = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function removeFailedMermaidRender(id: string) {
  document.getElementById(`d${id}`)?.remove();
}

type MermaidCurve = NonNullable<NonNullable<MermaidConfig["flowchart"]>["curve"]>;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Raw HTML is sanitized so that foreign repositories cannot run scripts in the app. */
function sanitizedMarkdown(source: string): string {
  const frontMatter = FRONT_MATTER.exec(source);
  const body = frontMatter ? source.slice(frontMatter[0].length) : source;
  const html = (frontMatter ? frontMatterHtml(frontMatter[1]) : "") + md.render(body);
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/** Metadata for site generators, folded away because it is not part of the text. */
function frontMatterHtml(yaml: string): string {
  const code = hljs.highlight(yaml, { language: "yaml", ignoreIllegals: true }).value;
  return `<details class="front-matter"><summary>Front matter</summary><pre class="code"><code class="hljs">${code}</code></pre></details>`;
}

const COPY_ICON = `<svg class="copy" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>`;
const COPIED_ICON = `<svg class="copied" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

function addCopyButtons(root: HTMLElement) {
  for (const pre of root.querySelectorAll<HTMLElement>("pre.code")) {
    // The wrapper keeps the button in place while a wide code block scrolls sideways.
    const block = document.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    const button = document.createElement("button");
    button.className = "copy-code";
    button.title = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.innerHTML = COPY_ICON + COPIED_ICON;
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent ?? "");
      } catch {
        return;
      }
      button.classList.add("done");
      setTimeout(() => button.classList.remove("done"), 1500);
    };
    block.append(pre, button);
  }
}

function themeMermaidConfig(dark: boolean): MermaidConfig {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const curve = (v("--mermaid-curve") || "rounded") as MermaidCurve;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    // ELK always draws right angles with rounded corners; only dagre respects other curve styles.
    layout: curve === "rounded" ? "elk" : "dagre",
    flowchart: { curve },
    themeVariables: mermaidColors(v, dark),
  };
}

function mermaidColors(v: (name: string) => string, dark: boolean) {
  return {
    darkMode: dark,
    background: v("--bg"),
    mainBkg: v("--code-bg"),
    primaryColor: v("--code-bg"),
    secondaryColor: v("--code-bg"),
    tertiaryColor: v("--bg"),
    primaryTextColor: v("--text"),
    textColor: v("--text"),
    primaryBorderColor: v("--muted"),
    nodeBorder: v("--muted"),
    lineColor: v("--muted"),
    clusterBkg: v("--bg"),
    edgeLabelBackground: v("--bg"),
    fontFamily: v("--font-body"),
  };
}

export function linkTarget(href: string, documentPath: string, root: string): LinkTarget {
  if (href.startsWith("#")) return { kind: "anchor", id: decodeURIComponent(href.slice(1)) };
  if (hasScheme(href)) return { kind: "external", url: href };
  const [file, id = ""] = href.split("#");
  return { kind: "file", path: resolveMarkdownLink(dirname(documentPath), decodeURIComponent(file), root), id: decodeURIComponent(id) };
}

const hasScheme = (url: string) => /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) && !/^[a-zA-Z]:[\\/]/.test(url);

/** Expects the query trimmed and lowercase; an empty query only removes the previous marks of this class. */
export function markMatches(target: HTMLElement, query: string, className = "search-match") {
  for (const mark of target.querySelectorAll(`mark.${className}`)) mark.replaceWith(...mark.childNodes);
  target.normalize();
  if (!query) return;
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
    // An HTML element inside an SVG diagram would not render.
    acceptNode: (node) => (node.parentElement?.closest("svg, .mermaid") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    const text = node.data;
    const lower = text.toLocaleLowerCase();
    // Lowercasing changes the length of a few characters, so offsets in lower would not fit text.
    if (lower.length !== text.length) continue;
    let index = lower.indexOf(query);
    if (index < 0) continue;
    const parts = document.createDocumentFragment();
    let start = 0;
    while (index >= 0) {
      const mark = document.createElement("mark");
      mark.className = className;
      mark.textContent = text.slice(index, index + query.length);
      parts.append(text.slice(start, index), mark);
      start = index + query.length;
      index = lower.indexOf(query, start);
    }
    parts.append(text.slice(start));
    node.replaceWith(parts);
  }
}

function markTaskLists(root: HTMLElement) {
  for (const li of root.querySelectorAll("li")) {
    const first = li.firstChild?.nodeName === "P" ? li.firstChild.firstChild : li.firstChild;
    if (first?.nodeType !== Node.TEXT_NODE) continue;
    const match = /^\[([ xX])\]\s/.exec(first.textContent ?? "");
    if (!match) continue;
    first.textContent = first.textContent!.slice(match[0].length);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.disabled = true;
    box.checked = match[1] !== " ";
    first.parentNode!.insertBefore(box, first);
    li.classList.add("task");
  }
}
