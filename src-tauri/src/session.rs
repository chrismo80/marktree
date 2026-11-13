use std::fs;
use std::path::{Path, PathBuf};

const PORTABLE_DIR_NAME: &str = "marktree-data";
const USER_DIR_NAME: &str = "marktree";
const SESSION_FILE: &str = "session.json";

pub struct DataDir(pub PathBuf);

pub fn resolve_data_dir(user_data_dir: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = portable_data_dir().filter(|d| d.is_dir() && is_writable(d)) {
        return dir;
    }
    let dir = user_data_dir.unwrap_or_else(std::env::temp_dir).join(USER_DIR_NAME);
    let _ = fs::create_dir_all(&dir);
    dir
}

/// macOS: next to the `.app` bundle, never inside it, because writing into the bundle breaks its signature.
fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let app_bundle = exe_dir
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"));
    let directory_next_to_app = match app_bundle {
        Some(bundle) => bundle.parent()?,
        None => exe_dir,
    };
    Some(directory_next_to_app.join(PORTABLE_DIR_NAME))
}

fn is_writable(dir: &Path) -> bool {
    let write_probe = dir.join(".write-test");
    let writable = fs::write(&write_probe, b"").is_ok();
    let _ = fs::remove_file(write_probe);
    writable
}

pub fn load(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(SESSION_FILE)).ok()
}

pub fn save(dir: &Path, json: &str) -> Result<(), String> {
    let temporary_session_file = dir.join(format!("{SESSION_FILE}.tmp"));
    fs::write(&temporary_session_file, json).map_err(|e| e.to_string())?;
    fs::rename(&temporary_session_file, dir.join(SESSION_FILE)).map_err(|e| e.to_string())
}
