use crate::git;
use crate::scan::{is_in_git_dir, is_markdown, scan, Node};
use notify_debouncer_full::notify::event::ModifyKind;
use notify_debouncer_full::notify::{self, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct Watches(Mutex<HashMap<String, Debouncer<RecommendedWatcher, NoCache>>>);

#[derive(Serialize, Clone)]
struct TreeChanged {
    root: String,
    tree: Node,
}

#[derive(Serialize, Clone)]
struct FilesChanged {
    root: String,
    paths: Vec<String>,
}

#[derive(Serialize, Clone)]
struct BranchChanged {
    root: String,
    branch: Option<String>,
}

pub fn open(app: AppHandle, watches: &Watches, root: &str, show_ignored: bool) -> Result<Node, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err(format!("Folder not found: {root}"));
    }
    let tree = scan(&root_path, show_ignored);
    let last_tree = Arc::new(Mutex::new(tree.clone()));
    let git_dir = git::find_git_directory(&root_path);
    let last_branch = Mutex::new(git_dir.as_deref().and_then(git::branch_or_commit));
    let branch_git_dir = git_dir.clone();

    let root_key = root.to_string();
    let scan_root = root_path.clone();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, _>(
        Duration::from_millis(250),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let (structure_changed, changed_files) = classify(events.iter().map(|e| (&e.kind, &e.paths)));

            let head_changed = events.iter().flat_map(|e| &e.paths).any(|p| is_head(p));
            if let (true, Some(dir)) = (head_changed, &branch_git_dir) {
                let branch = git::branch_or_commit(dir);
                let mut last = last_branch.lock().unwrap();
                if *last != branch {
                    *last = branch.clone();
                    let _ = app.emit("branch-changed", BranchChanged { root: root_key.clone(), branch });
                }
            }

            if structure_changed {
                let tree = scan(&scan_root, show_ignored);
                let mut last = last_tree.lock().unwrap();
                if *last != tree {
                    *last = tree.clone();
                    let _ = app.emit("tree-changed", TreeChanged { root: root_key.clone(), tree });
                }
            }
            if !changed_files.is_empty() {
                let paths = changed_files.into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
                let _ = app.emit("files-changed", FilesChanged { root: root_key.clone(), paths });
            }
        },
        // On Windows a file ID cache would walk the whole folder, including node_modules
        // and build output, at startup. The rescan detects renames anyway.
        NoCache,
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // The git directory may lie outside the folder (subfolder of a repository, worktree).
    if let Some(dir) = &git_dir {
        let _ = debouncer.watch(dir, RecursiveMode::NonRecursive);
    }

    watches.0.lock().unwrap().insert(root.to_string(), debouncer);
    Ok(tree)
}

pub fn close(watches: &Watches, root: &str) {
    watches.0.lock().unwrap().remove(root);
}

fn is_head(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == "HEAD") && is_in_git_dir(path)
}

fn classify<'a>(
    events: impl Iterator<Item = (&'a EventKind, &'a Vec<PathBuf>)>,
) -> (bool, BTreeSet<PathBuf>) {
    let mut structure_changed = false;
    let mut changed_files = BTreeSet::new();
    for (kind, paths) in events {
        for path in paths.iter().filter(|p| !is_in_git_dir(p)) {
            match kind {
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => {
                    // Deleted or renamed folders no longer exist as files,
                    // whereas new non-Markdown files never change the tree.
                    if is_markdown(path) || !path.is_file() {
                        structure_changed = true;
                    }
                    if is_markdown(path) {
                        changed_files.insert(path.clone());
                    }
                }
                EventKind::Modify(_) if is_markdown(path) => {
                    changed_files.insert(path.clone());
                }
                _ => {}
            }
        }
    }
    (structure_changed, changed_files)
}
