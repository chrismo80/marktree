use std::fs;
use std::path::{Path, PathBuf};

pub fn find_git_directory(folder: &Path) -> Option<PathBuf> {
    folder.ancestors().find_map(|dir| {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        let content = fs::read_to_string(&dot_git).ok()?;
        let target = content.strip_prefix("gitdir:")?.trim();
        Some(dir.join(target))
    })
}

pub fn branch_or_commit(git_dir: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    match head.strip_prefix("ref:") {
        Some(reference) => {
            let reference = reference.trim();
            Some(reference.strip_prefix("refs/heads/").unwrap_or(reference).to_string())
        }
        None => Some(head.chars().take(7).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_is_read_from_head_of_repository_or_worktree() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("docs/guide")).unwrap();
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feature/tabs\n").unwrap();

        let worktree = root.path().join("worktree");
        fs::create_dir_all(repo.join(".git/worktrees/worktree")).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".git"), "gitdir: ../repo/.git/worktrees/worktree\n").unwrap();
        fs::write(repo.join(".git/worktrees/worktree/HEAD"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();

        let plain = root.path().join("plain");
        fs::create_dir_all(&plain).unwrap();

        let branch_of = |folder: &Path| find_git_directory(folder).and_then(|dir| branch_or_commit(&dir));
        assert_eq!(branch_of(&repo.join("docs/guide")).as_deref(), Some("feature/tabs"));
        assert_eq!(branch_of(&worktree).as_deref(), Some("0123456"));
        assert_eq!(branch_of(&plain), None);
    }
}
