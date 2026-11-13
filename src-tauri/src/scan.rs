use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Node {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Node>>,
}

pub fn is_markdown(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "mkdn"
    )
}

pub fn is_in_git_dir(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".git")
}

pub fn scan(root: &Path, show_ignored: bool) -> Node {
    build_tree(root, markdown_files(root, show_ignored))
}

fn markdown_files(root: &Path, show_ignored: bool) -> Vec<PathBuf> {
    let (tx, rx) = mpsc::channel();
    WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .git_global(false)
        .git_ignore(!show_ignored)
        .git_exclude(!show_ignored)
        .ignore(!show_ignored)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build_parallel()
        .run(|| {
            let tx = tx.clone();
            Box::new(move |entry| {
                if let Ok(entry) = entry {
                    let is_file = entry.file_type().is_some_and(|t| t.is_file());
                    if is_file && is_markdown(entry.path()) {
                        let _ = tx.send(entry.into_path());
                    }
                }
                WalkState::Continue
            })
        });
    drop(tx);
    rx.into_iter().collect()
}

#[derive(Default)]
struct MarkdownDirectory {
    dirs: HashMap<String, MarkdownDirectory>,
    files: Vec<String>,
}

fn build_tree(root: &Path, files: Vec<PathBuf>) -> Node {
    let mut top = MarkdownDirectory::default();
    for file in files {
        let Ok(relative) = file.strip_prefix(root) else {
            continue;
        };
        let names: Vec<String> = relative
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let Some((file_name, dir_names)) = names.split_last() else {
            continue;
        };
        let mut dir = &mut top;
        for name in dir_names {
            dir = dir.dirs.entry(name.clone()).or_default();
        }
        dir.files.push(file_name.clone());
    }
    let root_name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    into_node(root, root_name, top)
}

fn into_node(path: &Path, name: String, dir: MarkdownDirectory) -> Node {
    let mut dirs: Vec<(String, MarkdownDirectory)> = dir.dirs.into_iter().collect();
    dirs.sort_by_cached_key(|(name, _)| natural_key(name));
    let mut files = dir.files;
    files.sort_by_cached_key(|name| natural_key(name));

    let mut children = Vec::with_capacity(dirs.len() + files.len());
    for (dir_name, sub) in dirs {
        children.push(into_node(&path.join(&dir_name), dir_name, sub));
    }
    for file_name in files {
        children.push(Node {
            path: path.join(&file_name).to_string_lossy().into_owned(),
            name: file_name,
            children: None,
        });
    }
    Node {
        name,
        path: path.to_string_lossy().into_owned(),
        children: Some(children),
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum KeyPart {
    Number(usize, String),
    Text(String),
}

fn natural_key(name: &str) -> Vec<KeyPart> {
    let mut parts = Vec::new();
    let mut chars = name.chars().peekable();
    while let Some(&first) = chars.peek() {
        let is_digit = first.is_ascii_digit();
        let mut run = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_ascii_digit() != is_digit {
                break;
            }
            run.push(c);
            chars.next();
        }
        parts.push(if is_digit {
            let significant_digits = run.trim_start_matches('0').to_string();
            KeyPart::Number(significant_digits.len(), significant_digits)
        } else {
            KeyPart::Text(run.to_lowercase())
        });
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn outline(node: &Node, depth: usize, out: &mut String) {
        for child in node.children.as_deref().unwrap_or_default() {
            out.push_str(&"  ".repeat(depth));
            out.push_str(&child.name);
            out.push_str(if child.children.is_some() { "/\n" } else { "\n" });
            outline(child, depth + 1, out);
        }
    }

    #[test]
    fn tree_shows_only_markdown_and_folders_containing_markdown_unless_ignored() {
        let root = tempfile::tempdir().unwrap();
        for file in [
            "README.md",
            "b.markdown",
            "docs/10-betrieb.md",
            "docs/2-setup.md",
            "image.png",
            "docs/Guide.md",
            "docs/assets/logo.svg",
            "src/main.rs",
            "deep/x/y/Notes.MD",
            ".github/CONTRIBUTING.md",
            ".git/info.md",
            "build/output.md",
            "notes/todo.md",
            ".gitignore",
        ] {
            let path = root.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "").unwrap();
        }
        fs::write(root.path().join(".gitignore"), "build/\n").unwrap();
        fs::create_dir_all(root.path().join(".git/info")).unwrap();
        fs::write(root.path().join(".git/info/exclude"), "notes/\n").unwrap();
        fs::create_dir_all(root.path().join("empty")).unwrap();

        let mut text = String::new();
        outline(&scan(root.path(), false), 0, &mut text);

        assert_eq!(
            text,
            "\
.github/
  CONTRIBUTING.md
deep/
  x/
    y/
      Notes.MD
docs/
  2-setup.md
  10-betrieb.md
  Guide.md
b.markdown
README.md
"
        );

        let mut text = String::new();
        outline(&scan(root.path(), true), 0, &mut text);

        assert_eq!(
            text,
            "\
.github/
  CONTRIBUTING.md
build/
  output.md
deep/
  x/
    y/
      Notes.MD
docs/
  2-setup.md
  10-betrieb.md
  Guide.md
notes/
  todo.md
b.markdown
README.md
"
        );
    }
}
