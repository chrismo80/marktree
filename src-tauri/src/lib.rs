mod git;
mod scan;
mod session;
mod themes;
mod watch;

use scan::Node;
use session::DataDir;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use themes::CustomTheme;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(debug_assertions))]
use tauri::Emitter;
use watch::Watches;

#[tauri::command]
async fn open_folder(
    app: AppHandle,
    watches: State<'_, Watches>,
    root: String,
    show_ignored: bool,
) -> Result<Node, String> {
    watch::open(app, &watches, &root, show_ignored)
}

#[tauri::command]
fn close_folder(watches: State<'_, Watches>, root: String) {
    watch::close(&watches, &root);
}

#[tauri::command]
fn git_branch(root: String) -> Option<String> {
    git::find_git_directory(std::path::Path::new(&root)).and_then(|dir| git::branch_or_commit(&dir))
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
async fn read_files(paths: Vec<String>) -> HashMap<String, String> {
    paths
        .into_iter()
        .filter_map(|path| {
            let bytes = std::fs::read(&path).ok()?;
            Some((path, String::from_utf8_lossy(&bytes).into_owned()))
        })
        .collect()
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct OpenablePath {
    path: String,
    is_dir: bool,
}

/// Folders and Markdown files, made absolute, because relative command line arguments refer to the working directory.
fn openable(path: &Path) -> Option<OpenablePath> {
    let path: PathBuf = std::path::absolute(path).ok()?.components().collect();
    let is_dir = path.is_dir();
    (is_dir || (path.is_file() && scan::is_markdown(&path))).then(|| OpenablePath {
        path: path.to_string_lossy().into_owned(),
        is_dir,
    })
}

#[tauri::command]
fn openable_paths(paths: Vec<String>) -> Vec<OpenablePath> {
    paths.iter().filter_map(|p| openable(Path::new(p))).collect()
}

#[tauri::command]
fn launch_paths() -> Vec<OpenablePath> {
    std::env::args_os().skip(1).filter_map(|a| openable(Path::new(&a))).collect()
}

#[tauri::command]
fn load_session(data_dir: State<'_, DataDir>) -> Option<String> {
    session::load(&data_dir.0)
}

#[tauri::command]
fn save_session(data_dir: State<'_, DataDir>, json: String) -> Result<(), String> {
    session::save(&data_dir.0, &json)
}

#[tauri::command]
fn load_custom_themes(data_dir: State<'_, DataDir>) -> Vec<CustomTheme> {
    themes::load(&data_dir.0)
}

#[tauri::command]
fn save_custom_theme(data_dir: State<'_, DataDir>, name: String, css: String) -> Result<(), String> {
    themes::save(&data_dir.0, &name, &css)
}

#[tauri::command]
fn delete_custom_theme(data_dir: State<'_, DataDir>, name: String) -> Result<(), String> {
    themes::delete(&data_dir.0, &name)
}

/// A second launch, such as "Open with", hands its paths to the running app instead of starting
/// another one, which would overwrite the session of the first when closed.
#[cfg(not(debug_assertions))]
fn forward_to_running_app(app: &AppHandle, args: Vec<String>, cwd: String) {
    let paths: Vec<OpenablePath> = args.iter().skip(1).filter_map(|a| openable(&Path::new(&cwd).join(a))).collect();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit("open-paths", paths);
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Development builds run beside an installed marktree instead of handing their arguments to it.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(forward_to_running_app));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Watches::default())
        .invoke_handler(tauri::generate_handler![
            open_folder,
            close_folder,
            git_branch,
            read_file,
            read_files,
            openable_paths,
            launch_paths,
            write_file,
            load_session,
            save_session,
            load_custom_themes,
            save_custom_theme,
            delete_custom_theme
        ])
        .setup(|app| {
            let data_dir = session::resolve_data_dir(app.path().data_dir().ok());
            // Register before the window, otherwise the frontend may request the session too early.
            app.manage(DataDir(data_dir.clone()));

            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("marktree")
                .inner_size(1200.0, 800.0)
                .min_inner_size(640.0, 400.0);
            // Otherwise WebView2 puts its cache and profile under %LOCALAPPDATA%.
            #[cfg(windows)]
            let builder = builder.data_directory(data_dir.join("webview"));
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Failed to start the app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_folders_and_markdown_files_by_their_plain_absolute_path() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes.md"), "").unwrap();
        std::fs::write(root.path().join("image.png"), "").unwrap();
        let folder = root.path().to_string_lossy().into_owned();

        assert_eq!(openable(&root.path().join("")), Some(OpenablePath { path: folder.clone(), is_dir: true }));
        assert_eq!(openable(&root.path().join("notes.md")).map(|o| o.is_dir), Some(false));
        assert_eq!(openable(&root.path().join("image.png")), None);
        assert_eq!(openable(&root.path().join("missing.md")), None);
    }
}
