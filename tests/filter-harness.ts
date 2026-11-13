import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const root = "/workspace";
let scans = 0;
Object.assign(window, { filterScans: () => scans });

const texts: Record<string, string> = {
  [`${root}/README.md`]: "# README\n\nSee the install notes.",
  [`${root}/docs/guide.md`]: "# Guide",
  [`${root}/docs/design.md`]: "# Design\n\nInstall the layers.",
  [`${root}/archive/old.md`]: "# Old\n\nOld install notes.",
};

mockWindows("main");
mockIPC((command, args) => {
  switch (command) {
    case "load_session": return JSON.stringify({
      tabs: [{ root, selected: `${root}/README.md`, expanded: [root], showIgnored: true }],
      activeRoot: root, theme: "midnight", mode: "preview", sidebarWidth: 280,
    });
    case "open_folder":
      scans++;
      return { name: "workspace", path: root, children: [
        { name: "README.md", path: `${root}/README.md` },
        { name: "docs", path: `${root}/docs`, children: [
          { name: "guide.md", path: `${root}/docs/guide.md` },
          { name: "design.md", path: `${root}/docs/design.md` },
        ] },
        { name: "archive", path: `${root}/archive`, children: [
          { name: "old.md", path: `${root}/archive/old.md` },
        ] },
      ] };
    case "git_branch": return "main";
    case "read_file": return texts[(args as { path: string }).path];
    case "read_files": return Object.fromEntries((args as { paths: string[] }).paths.map((path) => [path, texts[path]]));
    case "save_session": return null;
    default: throw Error(`Unexpected backend command: ${command}`);
  }
}, { shouldMockEvents: true });

await import("/src/main.ts");
