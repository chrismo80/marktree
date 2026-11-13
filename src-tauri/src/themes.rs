use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const THEMES_DIR: &str = "themes";

#[derive(Serialize, Debug, PartialEq)]
pub struct CustomTheme {
    pub name: String,
    pub css: String,
}

pub fn load(data_dir: &Path) -> Vec<CustomTheme> {
    let Ok(entries) = fs::read_dir(data_dir.join(THEMES_DIR)) else {
        return Vec::new();
    };
    let mut themes: Vec<CustomTheme> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("css")))
        .filter_map(|path| {
            Some(CustomTheme {
                name: path.file_stem()?.to_str()?.to_owned(),
                css: fs::read_to_string(&path).ok()?,
            })
        })
        .collect();
    themes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    themes
}

/// Overwrites a theme of the same name, so importing an edited file again updates it.
pub fn save(data_dir: &Path, name: &str, css: &str) -> Result<(), String> {
    let file = theme_file(data_dir, name)?;
    fs::create_dir_all(data_dir.join(THEMES_DIR)).map_err(|e| e.to_string())?;
    fs::write(file, css).map_err(|e| e.to_string())
}

pub fn delete(data_dir: &Path, name: &str) -> Result<(), String> {
    fs::remove_file(theme_file(data_dir, name)?).map_err(|e| e.to_string())
}

fn theme_file(data_dir: &Path, name: &str) -> Result<PathBuf, String> {
    // The name comes from a file the user picked; it must not lead out of the themes folder.
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err(format!("Invalid theme name: {name}"));
    }
    Ok(data_dir.join(THEMES_DIR).join(format!("{name}.css")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_themes_are_loaded_sorted_by_name() {
        let data_dir = tempfile::tempdir().unwrap();
        save(data_dir.path(), "zebra", "z").unwrap();
        save(data_dir.path(), "Alpha", "a").unwrap();

        let names: Vec<_> = load(data_dir.path()).into_iter().map(|t| t.name).collect();

        assert_eq!(names, ["Alpha", "zebra"]);
    }

    #[test]
    fn saving_under_an_existing_name_replaces_the_theme() {
        let data_dir = tempfile::tempdir().unwrap();
        save(data_dir.path(), "mine", "old").unwrap();
        save(data_dir.path(), "mine", "new").unwrap();

        assert_eq!(load(data_dir.path()), [CustomTheme { name: "mine".into(), css: "new".into() }]);
    }

    #[test]
    fn files_that_are_not_css_are_ignored() {
        let data_dir = tempfile::tempdir().unwrap();
        save(data_dir.path(), "mine", "css").unwrap();
        fs::write(data_dir.path().join(THEMES_DIR).join("notes.txt"), "text").unwrap();

        assert_eq!(load(data_dir.path()).len(), 1);
    }

    #[test]
    fn without_a_themes_folder_there_are_no_custom_themes() {
        let data_dir = tempfile::tempdir().unwrap();

        assert!(load(data_dir.path()).is_empty());
    }

    #[test]
    fn a_deleted_theme_is_no_longer_loaded() {
        let data_dir = tempfile::tempdir().unwrap();
        save(data_dir.path(), "keep", "k").unwrap();
        save(data_dir.path(), "drop", "d").unwrap();

        delete(data_dir.path(), "drop").unwrap();

        let names: Vec<_> = load(data_dir.path()).into_iter().map(|t| t.name).collect();
        assert_eq!(names, ["keep"]);
    }

    #[test]
    fn names_that_leave_the_themes_folder_are_rejected() {
        let data_dir = tempfile::tempdir().unwrap();
        fs::write(data_dir.path().join("evil.css"), "outside").unwrap();

        for name in ["", "..", "../evil", "a/b", "a\\b", "C:evil"] {
            assert!(save(data_dir.path(), name, "css").is_err(), "save {name}");
            assert!(delete(data_dir.path(), name).is_err(), "delete {name}");
        }
        assert!(data_dir.path().join("evil.css").exists());
    }
}
