import type { TreeNode } from "./backend";
import { isInside } from "./paths";

const ROW_HEIGHT = 26;
const INDENT = 14;
const OVERSCAN = 10;

type Row = { node: TreeNode; depth: number };

export type TreeCallbacks = {
  onOpenFile(path: string): void;
  onToggleFolder(path: string, expanded: boolean): void;
  onContextMenu(path: string, x: number, y: number): void;
  onAllExpandedChange(allExpanded: boolean): void;
  /** Lowercase text of a Markdown file, if already loaded. */
  textOf(path: string): string | undefined;
};

export class VirtualizedTreeView {
  private rows: Row[] = [];
  private root: TreeNode | null = null;
  private expanded = new Set<string>();
  private selected: string | null = null;
  private focused: string | null = null;
  private filter = "";
  private pathsWithMatches = new Set<string>();
  private collapsedMatches = new Set<string>();
  private message = "";
  private readonly spacer = document.createElement("div");

  constructor(private readonly container: HTMLElement, private readonly callbacks: TreeCallbacks) {
    this.spacer.className = "tree-spacer";
    container.append(this.spacer);
    container.addEventListener("scroll", () => this.renderVisibleRows());
    new ResizeObserver(() => this.renderVisibleRows()).observe(container);
    container.addEventListener("click", (e) => {
      const row = this.rowOf(e.target);
      if (row) this.activate(row);
    });
    container.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const row = this.rowOf(e.target);
      if (row) this.callbacks.onContextMenu(row.node.path, e.clientX, e.clientY);
    });
    container.addEventListener("keydown", (e) => this.onKey(e));
  }

  show(root: TreeNode | null, expanded: Set<string>, selected: string | null, message = "") {
    this.root = root;
    this.expanded = expanded;
    this.selected = selected;
    this.focused = selected;
    this.message = message;
    this.refresh();
  }

  /** Expects the filter trimmed and lowercase. */
  setFilter(filter: string) {
    if (filter === this.filter) return;
    this.filter = filter;
    this.collapsedMatches.clear();
    this.container.scrollTop = 0;
    this.refresh();
  }

  /** Call when file texts changed, so the filter sees them. */
  refresh() {
    this.pathsWithMatches.clear();
    if (this.filter && this.root) this.collectMatches(this.root);
    this.rebuildRows();
  }

  select(path: string | null) {
    this.selected = path;
    this.focused = path;
    this.renderVisibleRows();
  }

  reveal(path: string) {
    this.rebuildRows();
    const index = this.rows.findIndex((r) => r.node.path === path);
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    const { scrollTop, clientHeight } = this.container;
    if (top < scrollTop || top + ROW_HEIGHT > scrollTop + clientHeight) {
      this.container.scrollTop = Math.max(0, top - clientHeight / 3);
    }
    this.renderVisibleRows();
  }

  private rebuildRows() {
    this.rows = [];
    const walk = (nodes: TreeNode[], depth: number, matchingBranch = false) => {
      for (const node of nodes) {
        if (this.filter && !matchingBranch && !this.pathsWithMatches.has(node.path)) continue;
        this.rows.push({ node, depth });
        if (node.children && this.isFolderExpanded(node.path)) walk(node.children, depth + 1, matchingBranch || this.nameMatches(node));
      }
    };
    if (this.root?.children) walk(this.root.children, 0);
    this.container.dataset.message = this.root && !this.root.children?.length ? "No Markdown files found."
      : this.filter && this.root && !this.rows.length ? "No matches." : this.message;
    this.spacer.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    this.callbacks.onAllExpandedChange(this.areAllFoldersExpanded());
    this.renderVisibleRows();
  }

  /** The files in the folder of the given file that the filter shows, in tree order, including the file itself. */
  filesBeside(path: string): string[] {
    const search = (nodes: TreeNode[], matchingBranch: boolean): string[] => {
      if (nodes.some((node) => node.path === path)) {
        const shown = (node: TreeNode) => !this.filter || matchingBranch || this.pathsWithMatches.has(node.path);
        return nodes.filter((node) => !node.children && (node.path === path || shown(node))).map((node) => node.path);
      }
      const folder = nodes.find((node) => node.children && isInside(path, node.path));
      return folder?.children ? search(folder.children, matchingBranch || (!!this.filter && this.nameMatches(folder))) : [];
    };
    return this.root?.children ? search(this.root.children, false) : [];
  }

  private nameMatches(node: TreeNode): boolean {
    return node.name.toLocaleLowerCase().includes(this.filter);
  }

  /** Collects every node that matches itself or contains a match, so that each file text is searched only once. */
  private collectMatches(node: TreeNode): boolean {
    let found = this.nameMatches(node) || (!node.children && !!this.callbacks.textOf(node.path)?.includes(this.filter));
    for (const child of node.children ?? []) if (this.collectMatches(child)) found = true;
    if (found) this.pathsWithMatches.add(node.path);
    return found;
  }

  private isFolderExpanded(path: string): boolean {
    return this.filter ? !this.collapsedMatches.has(path) : this.expanded.has(path);
  }

  private areAllFoldersExpanded(): boolean {
    const check = (node: TreeNode): boolean =>
      !node.children || node.children.every((child) => !child.children || (this.expanded.has(child.path) && check(child)));
    return !!this.root?.children?.some((child) => child.children) && check(this.root!);
  }

  private renderVisibleRows() {
    const { scrollTop, clientHeight } = this.container;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN);

    const elements: HTMLElement[] = [];
    for (let i = first; i < last; i++) elements.push(this.renderRow(this.rows[i], i));
    this.spacer.replaceChildren(...elements);
  }

  private renderRow({ node, depth }: Row, index: number): HTMLElement {
    const isFolder = node.children !== undefined;
    const el = document.createElement("div");
    el.className = "tree-row";
    el.dataset.index = String(index);
    el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    el.style.paddingLeft = `${8 + depth * INDENT}px`;
    el.title = node.path;
    el.setAttribute("role", "treeitem");
    if (node.path === this.selected) el.classList.add("selected");
    if (node.path === this.focused) el.classList.add("focused");

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    if (isFolder) {
      const open = this.isFolderExpanded(node.path);
      chevron.textContent = open ? "▾" : "▸";
      el.setAttribute("aria-expanded", String(open));
    }
    const label = document.createElement("span");
    label.className = isFolder ? "label folder" : "label file";
    label.textContent = node.name;
    el.append(chevron, label);
    return el;
  }

  private rowOf(target: EventTarget | null): Row | undefined {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>(".tree-row");
    return el ? this.rows[Number(el.dataset.index)] : undefined;
  }

  private activate(row: Row) {
    this.focused = row.node.path;
    if (row.node.children) {
      const open = !this.isFolderExpanded(row.node.path);
      if (this.filter) {
        if (open) this.collapsedMatches.delete(row.node.path);
        else this.collapsedMatches.add(row.node.path);
      } else this.callbacks.onToggleFolder(row.node.path, open);
      this.rebuildRows();
    } else {
      this.callbacks.onOpenFile(row.node.path);
    }
  }

  private onKey(e: KeyboardEvent) {
    const index = this.rows.findIndex((r) => r.node.path === this.focused);
    const row = this.rows[index];
    const moveTo = (i: number) => {
      const target = this.rows[Math.max(0, Math.min(this.rows.length - 1, i))];
      if (!target) return;
      this.focused = target.node.path;
      this.reveal(target.node.path);
    };
    switch (e.key) {
      case "ArrowDown":
        moveTo(index + 1);
        break;
      case "ArrowUp":
        moveTo(index < 0 ? 0 : index - 1);
        break;
      case "ArrowRight":
        if (row?.node.children && !this.isFolderExpanded(row.node.path)) this.activate(row);
        else moveTo(index + 1);
        break;
      case "ArrowLeft":
        if (row?.node.children && this.isFolderExpanded(row.node.path)) this.activate(row);
        else if (row) moveTo(this.rows.findLastIndex((r, i) => i < index && r.depth < row.depth));
        break;
      case "Enter":
      case " ":
        if (row) this.activate(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
