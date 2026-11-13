const MARKDOWN = /\.(md|markdown|mdown|mkd|mkdn)$/i;

export const isMarkdown = (path: string) => MARKDOWN.test(path);

export const separatorOf = (path: string) => (path.includes("\\") ? "\\" : "/");

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i < 0) return path;
  return i === 0 ? path.slice(0, 1) : path.slice(0, i);
}

export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(separatorOf(root)) ? root : root + separatorOf(root));
}

export function relative(path: string, root: string): string {
  return isInside(path, root) ? path.slice(root.length).replace(/^[\\/]/, "") : path;
}

export function ancestorFoldersWithinRoot(path: string, root: string): string[] {
  const result: string[] = [];
  for (let dir = dirname(path); isInside(dir, root); dir = dirname(dir)) {
    result.push(dir);
    if (dir === root) break;
  }
  return result;
}

export function resolveMarkdownLink(documentDir: string, link: string, root: string): string {
  const sep = separatorOf(documentDir);
  if (/^[a-zA-Z]:[\\/]/.test(link)) return link.replace(/[\\/]/g, sep);
  const base = link.startsWith("/") ? root : documentDir;
  const parts = base.split(/[\\/]/);
  const fixed = parts[0] === "" || /^[a-zA-Z]:$/.test(parts[0]) ? 1 : 0;
  for (const segment of link.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > fixed + 1) parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join(sep);
}
