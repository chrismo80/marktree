import { ask, message, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  closeFolder,
  deleteCustomTheme,
  gitBranch,
  launchPaths,
  loadCustomThemes,
  loadSession,
  onBranchChanged,
  onFilesChanged,
  onOpenPaths,
  onTreeChanged,
  openablePaths,
  openFolder,
  readFile,
  readFiles,
  saveCustomTheme,
  saveSession,
  writeFile,
  type CustomTheme,
  type OpenablePath,
  type Session,
  type TreeNode,
} from "./backend";
import { ancestorFoldersWithinRoot, dirname, isInside, isMarkdown, relative } from "./paths";
import { linkTarget, markMatches, renderMarkdown } from "./preview";
import { Outline } from "./outline";
import { FindBar } from "./find";
import { SourceEditor } from "./editor";
import { VirtualizedTreeView } from "./tree";
import logoUrl from "../app-icon.svg?url";
import stylesSource from "./styles.css?raw";

type Tab = {
  root: string;
  tree: TreeNode | null;
  error: string;
  expanded: Set<string>;
  selected: string | null;
  showIgnored: boolean;
  branch: string | null;
  /** Lowercase file texts for the search. */
  texts: Map<string, string>;
  /** Scroll position of the selected document in the preview. */
  scroll: number;
};

type Mode = "preview" | "source";

// Imported as text: Vite drops side-effect-only imports from import.meta.glob in the build.
const THEME_CSS = import.meta.glob<string>("./themes/*.css", { eager: true, query: "?inline", import: "default" });
// An export hands out the source as written, because the build minifies THEME_CSS into one line.
const THEME_SOURCE = import.meta.glob<string>("./themes/*.css", { eager: true, query: "?raw", import: "default" });
const themeStyle = document.createElement("style");
themeStyle.textContent = Object.values(THEME_CSS).join("\n");
const customThemeStyle = document.createElement("style");
document.head.append(themeStyle, customThemeStyle);
const THEME_IDS = Object.keys(THEME_CSS).map((path) => path.slice("./themes/".length, -".css".length));
const CUSTOM_THEME_PREFIX = "custom:";
let customThemes: CustomTheme[] = [];
const themeLabel = (id: string) =>
  id.startsWith(CUSTOM_THEME_PREFIX)
    ? id.slice(CUSTOM_THEME_PREFIX.length)
    : id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
const hasDarkColorScheme = (element: Element) => getComputedStyle(element).colorScheme === "dark";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isMac = navigator.userAgent.includes("Mac");
const fileManager = isMac ? "Finder" : "Explorer";

const ui = {
  tabs: $("tabs"),
  addTab: $("add-tab"),
  branch: $("branch"),
  sidebar: $("sidebar"),
  search: $<HTMLInputElement>("search"),
  splitter: $("splitter"),
  docPath: $("doc-path"),
  dirtyMark: $("dirty-mark"),
  editToggle: $("edit-toggle"),
  sidebarToggle: $("sidebar-toggle"),
  expandToggle: $("expand-toggle"),
  theme: $<HTMLSelectElement>("theme"),
  notice: $("notice"),
  previewScroll: $("preview-scroll"),
  preview: $("preview"),
  editor: $("editor"),
  placeholder: $("placeholder"),
  contextMenu: $("context-menu"),
  gitFilter: $("git-filter"),
  themeMenu: $("theme-menu"),
  zoomLevel: $("zoom-level"),
  outline: $("outline"),
  outlineToggle: $("outline-toggle"),
  fullscreenToggle: $("fullscreen-toggle"),
  position: $("position"),
};

let tabs: Tab[] = [];
let activeTab: Tab | null = null;
let mode: Mode = "preview";
let theme = "midnight";
let sidebarWidth = 280;
let sidebarHidden = false;
let zoom = 1;
let outlineOpen = false;

const doc = { path: null as string | null, root: "", savedText: "", text: "" };
const isDirty = () => doc.path !== null && doc.text !== doc.savedText;

const tree = new VirtualizedTreeView($("tree"), {
  onOpenFile: (path) => void selectFile(path),
  onToggleFolder(path, expanded) {
    if (!activeTab) return;
    if (expanded) activeTab.expanded.add(path);
    else activeTab.expanded.delete(path);
    scheduleSessionSave();
  },
  onContextMenu: (path, x, y) =>
    showMenu([{ label: `Show in ${fileManager}`, run: () => revealItemInDir(path).catch(() => undefined) }], x, y),
  onAllExpandedChange(allExpanded) {
    ui.expandToggle.setAttribute("aria-pressed", String(allExpanded));
    ui.expandToggle.title = allExpanded ? "Collapse all folders" : "Expand all folders";
  },
  textOf: (path) => activeTab?.texts.get(path),
});

const editor = new SourceEditor(ui.editor, (text) => {
  doc.text = text;
  updateToolbar();
});

function newTab(root: string, selected: string | null = null, expanded: string[] = [], showIgnored = true, scroll = 0): Tab {
  return { root, tree: null, error: "", expanded: new Set(expanded), selected, showIgnored, branch: null, texts: new Map(), scroll };
}

async function loadTree(tab: Tab) {
  try {
    tab.tree = await openFolder(tab.root, tab.showIgnored);
    tab.branch = await gitBranch(tab.root);
    tab.error = "";
    pruneExpandedFolders(tab);
    void loadTexts(tab);
  } catch (error) {
    tab.tree = null;
    tab.error = String(error);
  }
}

/** Reads the files that are new in the tree and forgets the ones that are gone. */
async function loadTexts(tab: Tab) {
  if (!tab.tree) return;
  const files = new Set(filePaths(tab.tree));
  for (const path of tab.texts.keys()) if (!files.has(path)) tab.texts.delete(path);
  const missing = [...files].filter((path) => !tab.texts.has(path));
  if (missing.length) await storeTexts(tab, missing);
}

async function storeTexts(tab: Tab, paths: string[]) {
  const texts = await readFiles(paths).catch(() => ({}));
  for (const [path, text] of Object.entries(texts)) tab.texts.set(path, text.toLocaleLowerCase());
  if (tab === activeTab) tree.refresh();
}

function renderTabs() {
  ui.tabs.replaceChildren(
    ...tabs.map((tab) => {
      const el = document.createElement("div");
      el.className = "tab" + (tab === activeTab ? " active" : "");
      el.setAttribute("role", "tab");
      el.title = tab.root;
      el.onclick = () => void switchTab(tab);
      el.onauxclick = (e) => e.button === 1 && void closeTab(tab);

      const label = tab.root.split(/[\\/]/).filter(Boolean).pop() ?? tab.root;
      const name = document.createElement("span");
      name.className = "tab-name";
      name.dataset.name = label;
      const text = document.createElement("span");
      text.textContent = label;
      name.append(text);
      const close = document.createElement("button");
      close.className = "tab-close";
      close.title = "Close tab";
      close.textContent = "×";
      close.onclick = (e) => {
        e.stopPropagation();
        void closeTab(tab);
      };
      el.append(name, close);
      return el;
    }),
  );
  document.body.classList.toggle("no-tabs", tabs.length === 0);
  renderBranch();
}

function renderBranch() {
  const branch = activeTab?.branch;
  ui.branch.hidden = !branch;
  ui.branch.title = activeTab?.root ?? "";
  ui.branch.querySelector("span")!.textContent = branch ?? "";
}

async function addFolders() {
  const picked = await open({ directory: true, multiple: true, title: "Open folder" });
  if (!picked) return;
  const roots = Array.isArray(picked) ? picked : [picked];
  let last: Tab | null = null;
  for (const root of roots) last = await tabFor(root);
  if (last) await switchTab(last);
  else renderTabs();
}

async function tabFor(root: string): Promise<Tab> {
  let tab = tabs.find((t) => t.root === root);
  if (!tab) {
    tab = newTab(root);
    await loadTree(tab);
    tabs.push(tab);
  }
  return tab;
}

/** Folders become tabs; a Markdown file opens in a tab that contains it, otherwise in a new tab of its folder. */
async function openPaths(paths: OpenablePath[]) {
  const last = paths.at(-1);
  if (!last) return;
  for (const { path, isDir } of paths) {
    if (isDir) await tabFor(path);
    else if (!tabs.some((t) => isInside(path, t.root))) await tabFor(dirname(path));
  }
  if (last.isDir) await switchTab(tabs.find((t) => t.root === last.path)!);
  else await openLinkedDocument(last.path, "");
  renderTabs();
}

void onOpenPaths((paths) => void openPaths(paths));

void getCurrentWebview().onDragDropEvent(async ({ payload }) => {
  document.body.classList.toggle("dropping", payload.type === "enter" || payload.type === "over");
  if (payload.type === "drop") await openPaths(await openablePaths(payload.paths));
});

async function switchTab(tab: Tab | null) {
  if (tab === activeTab) return;
  if (!(await saveBeforeLeaving())) return;
  await showTab(tab);
}

async function showTab(tab: Tab | null) {
  activeTab = tab;
  renderTabs();
  if (tab?.error) await loadTree(tab);
  updateGitFilter();
  tree.show(tab?.tree ?? null, tab?.expanded ?? new Set(), tab?.selected ?? null, tab?.error);
  await openDocument(tab?.selected ?? null, tab?.scroll);
  scheduleSessionSave();
}

async function closeTab(tab: Tab) {
  if (tab === activeTab && !(await saveBeforeLeaving())) return;
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  void closeFolder(tab.root);
  if (tab === activeTab) await showTab(tabs[Math.min(index, tabs.length - 1)] ?? null);
  else {
    renderTabs();
    scheduleSessionSave();
  }
}

async function saveBeforeLeaving(): Promise<boolean> {
  if (!isDirty()) return true;
  if (!ui.notice.hidden) {
    const overwrite = await ask("The file was changed outside the app. Overwrite it with your changes?", {
      title: "File changed",
      kind: "warning",
      okLabel: "Overwrite",
      cancelLabel: "Cancel",
    });
    if (!overwrite) return false;
  }
  return save();
}

async function selectFile(path: string, anchor = "") {
  if (!activeTab) return;
  if (path !== doc.path) {
    if (!(await saveBeforeLeaving())) return;
    activeTab.selected = path;
    await openDocument(path);
    scheduleSessionSave();
  }
  if (anchor) scrollToAnchor(anchor);
}

async function openDocument(path: string | null, scroll = 0) {
  ui.notice.hidden = true;
  doc.path = null;
  if (!activeTab) return showStartPlaceholder();
  if (activeTab.error) return showMessagePlaceholder(activeTab.error);
  if (!path) return showMessagePlaceholder("Select a document on the left.");

  for (const dir of ancestorFoldersWithinRoot(path, activeTab.root)) activeTab.expanded.add(dir);
  tree.select(path);
  tree.reveal(path);

  let text: string;
  try {
    text = await readFile(path);
  } catch {
    return showMessagePlaceholder(`Document not found:\n${relative(path, activeTab.root)}`);
  }
  const otherDocumentSelectedWhileReading = activeTab.selected !== path;
  if (otherDocumentSelectedWhileReading) return;
  Object.assign(doc, { path, root: activeTab.root, savedText: text, text });
  editor.replaceDocument(text);
  ui.previewScroll.scrollTop = 0;
  await showMode();
  if (mode !== "preview") return;
  if (scroll) ui.previewScroll.scrollTop = scroll;
  else ui.preview.querySelector("mark.search-match")?.scrollIntoView({ block: "center" });
}

ui.previewScroll.addEventListener(
  "scroll",
  () => {
    if (activeTab && doc.path === activeTab.selected) activeTab.scroll = ui.previewScroll.scrollTop;
  },
  { passive: true },
);

function showPlaceholder(...content: (Node | string)[]) {
  find.close();
  doc.path = null;
  ui.previewScroll.hidden = true;
  ui.editor.hidden = true;
  ui.placeholder.hidden = false;
  ui.placeholder.replaceChildren(...content);
  updateToolbar();
  updateOutline();
}

function showStartPlaceholder() {
  const logo = document.createElement("img");
  logo.className = "start-logo";
  logo.src = logoUrl;
  logo.alt = "marktree";
  const button = document.createElement("button");
  button.className = "primary";
  button.textContent = "Open folder";
  button.onclick = () => void addFolders();
  const hint = document.createElement("p");
  hint.textContent = "You can open several folders side by side in tabs.";
  showPlaceholder(logo, button, hint);
}

function showMessagePlaceholder(message: string) {
  showPlaceholder(message);
}

async function showMode() {
  if (!doc.path) return updateToolbar();
  ui.placeholder.hidden = true;
  ui.previewScroll.hidden = mode !== "preview";
  ui.editor.hidden = mode !== "source";
  updateToolbar();
  if (mode === "preview") await renderPreview();
  else {
    updateOutline();
    editor.focus();
  }
}

async function renderPreview() {
  if (!doc.path) return;
  await renderMarkdown(ui.preview, doc.text, doc.path, doc.root, hasDarkColorScheme(document.documentElement));
  markPreview();
  updateOutline();
}

// While Ctrl+F is open, its marks replace those of the tree search: marks split the text,
// so a find query longer than a search mark would no longer match.
const find = new FindBar($("find"), ui.preview, ui.previewScroll, () => markPreview());

function markPreview() {
  if (find.isOpen) find.refresh();
  else markMatches(ui.preview, searchQuery());
}

function openFind() {
  markMatches(ui.preview, "");
  find.open(getSelection()?.toString().trim() ?? "");
}

const outline = new Outline(ui.outline, ui.previewScroll, (id) => scrollToAnchor(id));

function updateOutline() {
  const worthShowing = outline.update(doc.path !== null && mode === "preview" ? ui.preview : null);
  ui.outline.hidden = !(outlineOpen && worthShowing);
}

function applyOutlineOpen(open: boolean) {
  outlineOpen = open;
  ui.outlineToggle.setAttribute("aria-pressed", String(open));
  ui.outlineToggle.title = open ? "Hide outline (Ctrl/⌘+J)" : "Show outline (Ctrl/⌘+J)";
  updateOutline();
}

function toggleOutline() {
  applyOutlineOpen(!outlineOpen);
  if (outlineOpen && sidebarHidden) applySidebarHidden(false);
  scheduleSessionSave();
}

ui.outlineToggle.onclick = toggleOutline;

let fullscreen = false;

/** Full screen shows only the preview; editing is left to the normal window. */
async function setFullscreen(on: boolean) {
  if (on && (doc.path === null || mode !== "preview")) return;
  if (on === fullscreen) return;
  fullscreen = on;
  document.body.classList.toggle("fullscreen", on);
  hideContextMenu();
  ui.fullscreenToggle.setAttribute("aria-pressed", String(on));
  // The hidden tree would otherwise keep the focus and act on the arrow keys too.
  if (on) ui.previewScroll.focus();
  await getCurrentWindow().setFullscreen(on).catch(() => undefined);
}

ui.fullscreenToggle.title = `Full screen, Esc to leave (${isMac ? "⌃⌘F" : "F11"})`;
ui.fullscreenToggle.onclick = () => void setFullscreen(!fullscreen);

/** Left and right turn to the documents of the same folder, up and down to the chapters of this one. */
function navigateInFullscreen(key: string): boolean {
  if (key === "ArrowLeft" || key === "ArrowRight") void turnDocument(key === "ArrowLeft" ? -1 : 1);
  else if (key === "ArrowUp" || key === "ArrowDown") jumpToChapter(key === "ArrowUp" ? -1 : 1);
  else return false;
  return true;
}

async function turnDocument(direction: 1 | -1) {
  if (!doc.path) return;
  const files = tree.filesBeside(doc.path);
  const index = files.indexOf(doc.path) + direction;
  const target = files[Math.max(0, Math.min(files.length - 1, index))];
  if (target !== doc.path) await selectFile(target);
  showPosition(`${target.split(/[\\/]/).pop()}  ·  ${files.indexOf(target) + 1} / ${files.length}`);
}

// Scroll positions are fractional with zoom.
const SCROLL_TOLERANCE = 2;

/** A chapter starts with the same space above its heading as the document above its first line. */
function jumpToChapter(direction: 1 | -1) {
  const scroller = ui.previewScroll;
  const top = scroller.getBoundingClientRect().top;
  const space = parseFloat(getComputedStyle(ui.preview).paddingTop) * zoom;
  const maxScroll = scroller.scrollHeight - scroller.clientHeight;
  const chapterStarts = [...ui.preview.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id]")].map((heading) =>
    Math.max(0, Math.min(maxScroll, scroller.scrollTop + heading.getBoundingClientRect().top - top - space)),
  );
  const target =
    direction === 1
      ? chapterStarts.find((start) => start > scroller.scrollTop + SCROLL_TOLERANCE)
      : chapterStarts.findLast((start) => start < scroller.scrollTop - SCROLL_TOLERANCE);
  scroller.scrollTop = target ?? (direction === 1 ? maxScroll : 0);
}

let positionTimer: number | undefined;

function showPosition(text: string) {
  ui.position.textContent = text;
  ui.position.classList.add("visible");
  clearTimeout(positionTimer);
  positionTimer = window.setTimeout(() => ui.position.classList.remove("visible"), 1500);
}

async function setMode(next: Mode) {
  if (mode === next) return;
  if (next === "preview" && !(await saveBeforeLeaving())) return;
  if (next === "source") {
    await setFullscreen(false);
    find.close();
  }
  mode = next;
  scheduleSessionSave();
  await showMode();
}

async function save(): Promise<boolean> {
  if (!doc.path || !isDirty()) return true;
  try {
    await writeFile(doc.path, doc.text);
    doc.savedText = doc.text;
    ui.notice.hidden = true;
    updateToolbar();
    return true;
  } catch (error) {
    await message(`Saving failed:\n${error}`, { title: "Error", kind: "error" });
    return false;
  }
}

function updateToolbar() {
  const hasDoc = doc.path !== null;
  document.body.classList.toggle("has-doc", hasDoc);
  ui.docPath.textContent = hasDoc ? relative(doc.path!, doc.root) : "";
  ui.docPath.title = doc.path ?? "";
  ui.dirtyMark.hidden = !isDirty();
  const editing = mode === "source";
  ui.editToggle.setAttribute("aria-pressed", String(editing));
  ui.editToggle.title = editing ? "Back to preview, saves changes (Ctrl/⌘+E)" : "Edit source (Ctrl/⌘+E)";
  ui.fullscreenToggle.toggleAttribute("disabled", editing);
}

function scrollToAnchor(id: string) {
  if (mode !== "preview") return;
  ui.preview.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: "start" });
}

ui.preview.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest("a");
  const href = link?.getAttribute("href");
  if (!href || !doc.path) return;
  e.preventDefault();
  const target = linkTarget(href, doc.path, doc.root);
  if (target.kind === "anchor") return scrollToAnchor(target.id);
  if (target.kind === "external") return void openUrl(target.url).catch(() => undefined);
  if (!isMarkdown(target.path)) return void revealItemInDir(target.path).catch(() => undefined);
  void openLinkedDocument(target.path, target.id);
});

async function openLinkedDocument(path: string, anchor: string) {
  const owner = activeTab && isInside(path, activeTab.root) ? activeTab : tabs.find((t) => isInside(path, t.root));
  if (!owner) return void revealItemInDir(path).catch(() => undefined);
  if (owner !== activeTab) {
    if (!(await saveBeforeLeaving())) return;
    if (owner.selected !== path) owner.scroll = 0;
    owner.selected = path;
    await showTab(owner);
    if (anchor) scrollToAnchor(anchor);
    return;
  }
  await selectFile(path, anchor);
}

function folderPaths(root: TreeNode): string[] {
  const folders: string[] = [];
  const walk = (node: TreeNode) => {
    if (!node.children) return;
    folders.push(node.path);
    node.children.forEach(walk);
  };
  walk(root);
  return folders;
}

function filePaths(root: TreeNode): string[] {
  const files: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.children) node.children.forEach(walk);
    else files.push(node.path);
  };
  walk(root);
  return files;
}

function pruneExpandedFolders(tab: Tab) {
  if (!tab.tree) return;
  const existingFolders = new Set(folderPaths(tab.tree));
  for (const path of tab.expanded) if (!existingFolders.has(path)) tab.expanded.delete(path);
}

function containsPath(node: TreeNode, path: string): boolean {
  if (node.path === path) return true;
  return !!node.children?.some((child) => isInside(path, child.path) && containsPath(child, path));
}

void onTreeChanged(async ({ root, tree: newTree }) => {
  const tab = tabs.find((t) => t.root === root);
  if (!tab) return;
  tab.tree = newTree;
  pruneExpandedFolders(tab);
  void loadTexts(tab);
  if (tab !== activeTab) return;
  tree.show(newTree, tab.expanded, tab.selected);
  if (tab.selected && !containsPath(newTree, tab.selected) && !isDirty()) {
    const path = tab.selected;
    tab.selected = null;
    showMessagePlaceholder(`The document was moved or deleted:\n${relative(path, root)}`);
    scheduleSessionSave();
  }
});

void onBranchChanged(({ root, branch }) => {
  const tab = tabs.find((t) => t.root === root);
  if (!tab) return;
  tab.branch = branch;
  if (tab === activeTab) renderBranch();
});

void onFilesChanged(async ({ root, paths }) => {
  const tab = tabs.find((t) => t.root === root);
  // New files are read when their tree change arrives.
  if (tab) void storeTexts(tab, paths.filter((p) => tab.texts.has(p)));
  const path = doc.path;
  if (!path || !paths.includes(path)) return;
  let text: string;
  try {
    text = await readFile(path);
  } catch {
    return;
  }
  if (doc.path !== path || text === doc.savedText) return;
  if (isDirty()) {
    ui.notice.hidden = false;
    return;
  }
  doc.savedText = doc.text = text;
  const scroll = ui.previewScroll.scrollTop;
  if (mode === "source") editor.replaceDocument(text);
  else {
    await renderPreview();
    ui.previewScroll.scrollTop = scroll;
  }
});

$("notice-reload").onclick = async () => {
  if (!doc.path) return;
  const text = await readFile(doc.path);
  doc.savedText = doc.text = text;
  editor.replaceDocument(text);
  ui.notice.hidden = true;
  await showMode();
};
$("notice-keep").onclick = () => (ui.notice.hidden = true);

type MenuItem = { label: string; run: () => Promise<unknown> };

/** With `above`, the menu ends at y instead of starting there, for buttons at the bottom of the window. */
function showMenu(items: MenuItem[], x: number, y: number, above = false) {
  const buttons = items.map(({ label, run }) => {
    const button = document.createElement("button");
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.onclick = () => {
      hideContextMenu();
      void run();
    };
    return button;
  });
  ui.contextMenu.replaceChildren(...buttons);
  ui.contextMenu.hidden = false;
  const { offsetWidth: w, offsetHeight: h } = ui.contextMenu;
  ui.contextMenu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  ui.contextMenu.style.top = `${Math.max(4, above ? y - h : Math.min(y, innerHeight - h - 4))}px`;
  buttons[0]?.focus();
}

const hideContextMenu = () => (ui.contextMenu.hidden = true);
document.addEventListener("mousedown", (e) => {
  if (!ui.contextMenu.contains(e.target as Node)) hideContextMenu();
});
ui.contextMenu.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideContextMenu();
});
window.addEventListener("blur", hideContextMenu);
$("tree").addEventListener("scroll", hideContextMenu);

const isCustomTheme = (id: string) => id.startsWith(CUSTOM_THEME_PREFIX);

ui.themeMenu.onclick = () => {
  const items: MenuItem[] = [
    { label: "Export current theme…", run: exportTheme },
    { label: "Import theme…", run: importTheme },
  ];
  if (isCustomTheme(theme)) items.push({ label: `Remove "${themeLabel(theme)}"…`, run: removeTheme });
  const button = ui.themeMenu.getBoundingClientRect();
  showMenu(items, button.right, button.top - 4, true);
};

function fillThemeSelect() {
  const probe = document.body.appendChild(document.createElement("div"));
  const dark = new Map<string, boolean>();
  for (const id of THEME_IDS) {
    probe.dataset.theme = id;
    dark.set(id, hasDarkColorScheme(probe));
  }
  probe.remove();
  ui.theme.replaceChildren();
  for (const [label, groupDark] of [["Dark", true], ["Light", false]] as const) {
    const ids = THEME_IDS.filter((id) => dark.get(id) === groupDark);
    appendThemeGroup(label, ids.map((id) => new Option(themeLabel(id), id)));
  }
  const customIds = customThemes.map((t) => CUSTOM_THEME_PREFIX + t.name);
  appendThemeGroup("Custom", customIds.map((id) => new Option(themeLabel(id), id)));
}

function appendThemeGroup(label: string, options: HTMLOptionElement[]) {
  if (!options.length) return;
  const group = document.createElement("optgroup");
  group.label = label;
  group.append(...options);
  ui.theme.append(group);
}

function useCustomThemes(themes: CustomTheme[]) {
  customThemes = themes;
  customThemeStyle.textContent = themes.map(customThemeCss).join("\n");
  fillThemeSelect();
}

// The theme answers to its file name whatever its selector says, so renaming the file just works.
function customThemeCss({ name, css }: CustomTheme): string {
  const selector = `[data-theme="${CSS.escape(CUSTOM_THEME_PREFIX + name)}"]`;
  return css.replace(/@import[^;]*;/g, "").replace(/\[data-theme(?:=(["']?)[^\]"']*\1)?\]/g, selector);
}

// The second comment of styles.css documents the theme variables.
const THEME_VARIABLES_DOC = [...stylesSource.matchAll(/\/\*([\s\S]*?)\*\//g)][1]?.[1].trim() ?? "";
const THEME_FILE_GUIDE = `/* A marktree theme. Change the values, then load the file with "Import theme…" in the menu
   next to the theme list. The file name becomes the theme's name; importing a file of the same name
   again replaces the theme.

   ${THEME_VARIABLES_DOC} */`;

function exportedThemeCss(id: string): string {
  const custom = customThemes.find((t) => CUSTOM_THEME_PREFIX + t.name === id);
  if (custom) return custom.css;
  // Fonts imported by a built-in theme are loaded by the app anyway, and the package paths would not resolve.
  const source = THEME_SOURCE[`./themes/${id}.css`].replace(/^@import[^;]*;\r?\n/gm, "");
  return `${THEME_FILE_GUIDE}\n\n${source.trimStart()}`;
}

async function exportTheme() {
  const fileName = isCustomTheme(theme) ? `${themeLabel(theme)}.css` : `${theme}-custom.css`;
  const path = await saveDialog({ title: "Export theme", defaultPath: fileName, filters: [{ name: "Theme", extensions: ["css"] }] });
  if (!path) return;
  try {
    await writeFile(path, exportedThemeCss(theme));
  } catch (error) {
    await message(`Exporting the theme failed:\n${error}`, { title: "Error", kind: "error" });
  }
}

async function importTheme() {
  const path = await open({ title: "Import theme", filters: [{ name: "Theme", extensions: ["css"] }] });
  if (typeof path !== "string") return;
  try {
    const css = await readFile(path);
    if (!css.includes("[data-theme")) {
      await message("This file is not a marktree theme: it has no [data-theme] rule.", { title: "Import theme", kind: "error" });
      return;
    }
    const name = path.split(/[\\/]/).pop()!.replace(/\.css$/i, "");
    await saveCustomTheme(name, css);
    useCustomThemes(await loadCustomThemes());
    await switchTheme(CUSTOM_THEME_PREFIX + name);
  } catch (error) {
    await message(`Importing the theme failed:\n${error}`, { title: "Error", kind: "error" });
  }
}

async function removeTheme() {
  const name = themeLabel(theme);
  const confirmed = await ask(`Remove the custom theme "${name}"? This cannot be undone.`, {
    title: "Remove theme",
    kind: "warning",
    okLabel: "Remove",
  });
  if (!confirmed) return;
  // Stay as light or dark as before, so the screen does not flash to the opposite.
  const fallback = hasDarkColorScheme(document.documentElement) ? "midnight" : "paper";
  try {
    await deleteCustomTheme(name);
    useCustomThemes(await loadCustomThemes());
    await switchTheme(fallback);
  } catch (error) {
    await message(`Removing the theme failed:\n${error}`, { title: "Error", kind: "error" });
  }
}

const LEGACY_THEME_IDS: Record<string, string> = {
  hell: "paper", rider: "dev", nord: "midnight",
  lavender: "glacier", mint: "glacier", latte: "sepia",
  slate: "midnight", orchid: "midnight", abyss: "midnight",
  manuscript: "noir", ember: "noir", forest: "noir",
};

function applyTheme(next: string) {
  next = LEGACY_THEME_IDS[next] ?? next;
  theme = [...ui.theme.options].some((o) => o.value === next) ? next : "midnight";
  document.documentElement.dataset.theme = theme;
  ui.theme.value = theme;
}

ui.theme.onchange = () => switchTheme(ui.theme.value);

async function switchTheme(id: string) {
  applyTheme(id);
  scheduleSessionSave();
  if (doc.path && mode === "preview") {
    const scroll = ui.previewScroll.scrollTop;
    await renderPreview();
    ui.previewScroll.scrollTop = scroll;
  }
}

function applySidebarHidden(hidden: boolean) {
  sidebarHidden = hidden;
  document.body.classList.toggle("sidebar-hidden", hidden);
  ui.sidebarToggle.setAttribute("aria-pressed", String(!hidden));
  ui.sidebarToggle.title = hidden ? "Show sidebar (Ctrl/⌘+B)" : "Hide sidebar (Ctrl/⌘+B)";
}

function toggleSidebar() {
  applySidebarHidden(!sidebarHidden);
  scheduleSessionSave();
}

const ZOOM_LEVELS = [0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function applyZoom(next: number) {
  zoom = ZOOM_LEVELS.includes(next) ? next : 1;
  document.documentElement.style.setProperty("--zoom", String(zoom));
  ui.zoomLevel.hidden = zoom === 1;
  ui.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(next: number) {
  applyZoom(next);
  scheduleSessionSave();
}

function stepZoom(direction: 1 | -1) {
  const index = ZOOM_LEVELS.indexOf(zoom) + direction;
  setZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index))]);
}

// A mouse wheel notch is about 100 pixels; a pinch on a touchpad arrives as many small Ctrl+wheel events.
const WHEEL_PIXELS_PER_ZOOM_STEP = 50;
let wheelZoomDelta = 0;
document.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    // Ctrl+wheel belongs to this zoom alone, neither to scrolling nor to the webview's own zoom.
    e.preventDefault();
    wheelZoomDelta += e.deltaY;
    if (Math.abs(wheelZoomDelta) < WHEEL_PIXELS_PER_ZOOM_STEP) return;
    stepZoom(wheelZoomDelta < 0 ? 1 : -1);
    wheelZoomDelta = 0;
  },
  { passive: false },
);

ui.zoomLevel.onclick = () => setZoom(1);

ui.sidebarToggle.onclick = toggleSidebar;
const searchQuery = () => ui.search.value.trim().toLocaleLowerCase();
ui.search.oninput = () => {
  tree.setFilter(searchQuery());
  markPreview();
  ui.expandToggle.toggleAttribute("disabled", !!ui.search.value.trim());
};
ui.search.onkeydown = (e) => {
  if (e.key !== "Escape") return;
  ui.search.value = "";
  ui.search.dispatchEvent(new Event("input"));
  e.preventDefault();
};

ui.expandToggle.onclick = () => {
  const tab = activeTab;
  if (!tab?.tree) return;
  const folders = folderPaths(tab.tree);
  if (folders.every((path) => tab.expanded.has(path))) tab.expanded.clear();
  else folders.forEach((path) => tab.expanded.add(path));
  tree.show(tab.tree, tab.expanded, tab.selected, tab.error);
  scheduleSessionSave();
};

function applySidebarWidth(width: number) {
  sidebarWidth = Math.round(Math.max(160, Math.min(640, width)));
  ui.sidebar.style.width = `${sidebarWidth}px`;
}

ui.splitter.addEventListener("pointerdown", (e) => {
  ui.splitter.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => applySidebarWidth(ev.clientX - ui.sidebar.getBoundingClientRect().left);
  const up = () => {
    ui.splitter.removeEventListener("pointermove", move);
    scheduleSessionSave();
  };
  ui.splitter.addEventListener("pointermove", move);
  ui.splitter.addEventListener("pointerup", up, { once: true });
});

function updateGitFilter() {
  const filtering = activeTab ? !activeTab.showIgnored : false;
  ui.gitFilter.setAttribute("aria-pressed", String(filtering));
  ui.gitFilter.title = filtering
    ? "Files ignored by Git are hidden, click to show all Markdown files"
    : "All Markdown files are visible, click to hide files ignored by Git";
}

ui.gitFilter.onclick = async () => {
  const tab = activeTab;
  if (!tab) return;
  tab.showIgnored = !tab.showIgnored;
  updateGitFilter();
  await loadTree(tab);
  if (tab !== activeTab) return;
  tree.show(tab.tree, tab.expanded, tab.selected, tab.error);
  if (tab.selected && tab.tree && !containsPath(tab.tree, tab.selected) && !isDirty()) {
    tab.selected = null;
    await openDocument(null);
  }
  scheduleSessionSave();
};

ui.addTab.onclick = () => void addFolders();
ui.editToggle.onclick = () => void setMode(mode === "preview" ? "source" : "preview");

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideContextMenu();
    void setFullscreen(false);
  }
  if (e.key === "F11" || (isMac && e.ctrlKey && e.metaKey && e.key.toLowerCase() === "f")) {
    void setFullscreen(!fullscreen);
    e.preventDefault();
    return;
  }
  const modified = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;
  const typing = e.target instanceof HTMLInputElement;
  if (fullscreen && !modified && !typing && navigateInFullscreen(e.key)) {
    e.preventDefault();
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  // These act on the hidden sidebar, so they would otherwise change what cannot be seen.
  if (["p", "b", "j"].includes(key)) void setFullscreen(false);
  if (key === "s") void save();
  else if (key === "p") {
    if (sidebarHidden) {
      applySidebarHidden(false);
      scheduleSessionSave();
    }
    ui.search.focus();
    ui.search.select();
  }
  else if (key === "e" && doc.path) void setMode(mode === "preview" ? "source" : "preview");
  else if (key === "o") void addFolders();
  else if (key === "b") toggleSidebar();
  else if (key === "j") toggleOutline();
  // In the source view, the editor brings its own search.
  else if (key === "f" && doc.path && mode === "preview") openFind();
  else if (key === "+" || key === "=") stepZoom(1);
  else if (key === "-") stepZoom(-1);
  else if (key === "0") setZoom(1);
  else return;
  e.preventDefault();
});

let saveTimer: number | undefined;
/** Only save after a successful load, so a startup error cannot overwrite the session. */
let sessionReadyToSave = false;

function sessionSnapshot(): Session {
  return {
    tabs: tabs.map((t) => ({ root: t.root, selected: t.selected, expanded: [...t.expanded], showIgnored: t.showIgnored, scroll: Math.round(t.scroll) })),
    activeRoot: activeTab?.root ?? null,
    theme,
    mode,
    sidebarWidth,
    sidebarHidden,
    zoom,
    outline: outlineOpen,
  };
}

function scheduleSessionSave() {
  if (!sessionReadyToSave) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveSession(sessionSnapshot()).catch(() => undefined), 400);
}

void getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await saveBeforeLeaving())) {
    event.preventDefault();
    return;
  }
  if (!sessionReadyToSave) return;
  clearTimeout(saveTimer);
  await saveSession(sessionSnapshot()).catch(() => undefined);
});

async function start() {
  useCustomThemes(await loadCustomThemes().catch(() => []));
  const session = (await loadSession()) ?? {};
  sessionReadyToSave = true;
  applyTheme(session.theme ?? "midnight");
  mode = session.mode === "source" ? "source" : "preview";
  applySidebarWidth(session.sidebarWidth ?? 280);
  applySidebarHidden(session.sidebarHidden === true);
  applyZoom(session.zoom ?? 1);
  applyOutlineOpen(session.outline === true);

  tabs = (session.tabs ?? []).map((t) => newTab(t.root, t.selected, t.expanded, t.showIgnored !== false, t.scroll));
  await Promise.all(tabs.map(loadTree));
  await showTab(tabs.find((t) => t.root === session.activeRoot) ?? tabs[0] ?? null);
  await openPaths(await launchPaths().catch(() => []));
}

void start();
