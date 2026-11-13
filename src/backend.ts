import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type TreeNode =
  | { name: string; path: string; children: TreeNode[] }
  | { name: string; path: string; children?: never };

export type SavedTab = { root: string; selected: string | null; expanded: string[]; showIgnored?: boolean /* missing = true */; scroll?: number };
export type Session = {
  tabs: SavedTab[];
  activeRoot: string | null;
  theme: string;
  mode: "preview" | "source";
  sidebarWidth: number;
  sidebarHidden?: boolean;
  zoom?: number;
  outline?: boolean;
};

export const openFolder = (root: string, showIgnored: boolean) => invoke<TreeNode>("open_folder", { root, showIgnored });
export const closeFolder = (root: string) => invoke<void>("close_folder", { root });
export const gitBranch = (root: string) => invoke<string | null>("git_branch", { root });
export const readFile = (path: string) => invoke<string>("read_file", { path });
export const readFiles = (paths: string[]) => invoke<Record<string, string>>("read_files", { paths });
export const writeFile = (path: string, content: string) => invoke<void>("write_file", { path, content });

export type OpenablePath = { path: string; isDir: boolean };
export const openablePaths = (paths: string[]) => invoke<OpenablePath[]>("openable_paths", { paths });
export const launchPaths = () => invoke<OpenablePath[]>("launch_paths");

export async function loadSession(): Promise<Partial<Session> | null> {
  const json = await invoke<string | null>("load_session");
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const saveSession = (session: Session) =>
  invoke<void>("save_session", { json: JSON.stringify(session, null, 2) });

export type CustomTheme = { name: string; css: string };
export const loadCustomThemes = () => invoke<CustomTheme[]>("load_custom_themes");
export const saveCustomTheme = (name: string, css: string) => invoke<void>("save_custom_theme", { name, css });
export const deleteCustomTheme = (name: string) => invoke<void>("delete_custom_theme", { name });

export const onTreeChanged = (handler: (e: { root: string; tree: TreeNode }) => void) =>
  listen<{ root: string; tree: TreeNode }>("tree-changed", (e) => handler(e.payload));

export const onBranchChanged = (handler: (e: { root: string; branch: string | null }) => void) =>
  listen<{ root: string; branch: string | null }>("branch-changed", (e) => handler(e.payload));

export const onFilesChanged = (handler: (e: { root: string; paths: string[] }) => void) =>
  listen<{ root: string; paths: string[] }>("files-changed", (e) => handler(e.payload));

/** Paths of a second launch, which hands them over instead of starting another app. */
export const onOpenPaths = (handler: (paths: OpenablePath[]) => void) =>
  listen<OpenablePath[]>("open-paths", (e) => handler(e.payload));
