use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

const MAX_REVIEW_STORE_BYTES: usize = 5 * 1024 * 1024;
const MAX_LOCAL_BOARD_STORE_BYTES: usize = 20 * 1024 * 1024;
const REVIEW_STORE_FILE: &str = "review-store.json";
const LOCAL_BOARD_STORE_FILE: &str = "local-board.json";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn load_review_store(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data folder: {error}"))?;
    load_store_with_legacy(
        &directory,
        REVIEW_STORE_FILE,
        MAX_REVIEW_STORE_BYTES,
        "Review",
    )
}

pub fn save_review_store(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data folder: {error}"))?;
    save_store_to(
        &directory,
        REVIEW_STORE_FILE,
        MAX_REVIEW_STORE_BYTES,
        "review",
        &content,
    )
}

pub fn load_local_board_store(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data folder: {error}"))?;
    load_store_with_legacy(
        &directory,
        LOCAL_BOARD_STORE_FILE,
        MAX_LOCAL_BOARD_STORE_BYTES,
        "Local board",
    )
}

pub fn save_local_board_store(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data folder: {error}"))?;
    save_store_to(
        &directory,
        LOCAL_BOARD_STORE_FILE,
        MAX_LOCAL_BOARD_STORE_BYTES,
        "local board",
        &content,
    )
}

fn load_store_from(
    directory: &Path,
    filename: &str,
    max_bytes: usize,
    label: &str,
) -> Result<Option<String>, String> {
    let path = directory.join(filename);
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > max_bytes as u64 => {
            return Err(format!("{label} store file is too large and was ignored"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not inspect {} store: {error}",
                label.to_lowercase()
            ))
        }
    }
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Could not read {} store: {error}",
            label.to_lowercase()
        )),
    }
}

fn load_store_with_legacy(
    directory: &Path,
    filename: &str,
    max_bytes: usize,
    label: &str,
) -> Result<Option<String>, String> {
    if let Some(content) = load_store_from(directory, filename, max_bytes, label)? {
        return Ok(Some(content));
    }
    let Some(legacy_directory) = pre_patchdeck_data_directory(directory) else {
        return Ok(None);
    };
    let Some(content) = load_store_from(&legacy_directory, filename, max_bytes, label)? else {
        return Ok(None);
    };
    save_store_to(
        directory,
        filename,
        max_bytes,
        &label.to_lowercase(),
        &content,
    )?;
    Ok(Some(content))
}

fn pre_patchdeck_data_directory(directory: &Path) -> Option<PathBuf> {
    let name = directory.file_name()?.to_str()?;
    let suffix = name.strip_prefix("com.local.patchdeck")?;
    let old_product = ["branch", "diff", "viewer"].concat();
    Some(directory.with_file_name(format!("com.local.{old_product}{suffix}")))
}

fn save_store_to(
    directory: &Path,
    filename: &str,
    max_bytes: usize,
    label: &str,
    content: &str,
) -> Result<(), String> {
    if content.len() > max_bytes {
        return Err(format!("{label} store data is too large to save"));
    }
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the application data folder: {error}"))?;

    let target = directory.join(filename);
    let temp_path = unique_temp_path(directory, filename);
    let result = (|| {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Could not create atomic {label} store file: {error}"))?;
        temp.write_all(content.as_bytes())
            .map_err(|error| format!("Could not write {label} store: {error}"))?;
        temp.sync_all()
            .map_err(|error| format!("Could not finish writing {label} store: {error}"))?;
        fs::rename(&temp_path, &target)
            .map_err(|error| format!("Could not replace {label} store atomically: {error}"))?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn unique_temp_path(directory: &Path, name: &str) -> PathBuf {
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    directory.join(format!(
        ".{name}.patchdeck-{}-{sequence}.tmp",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        load_store_from, load_store_with_legacy, save_store_to, unique_temp_path,
        MAX_REVIEW_STORE_BYTES, REVIEW_STORE_FILE,
    };
    use std::fs;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        unique_temp_path(&std::env::temp_dir(), "review-store-test").with_extension("data")
    }

    #[test]
    fn saves_and_loads_the_review_store() {
        let directory = fixture();
        save_store_to(
            &directory,
            REVIEW_STORE_FILE,
            MAX_REVIEW_STORE_BYTES,
            "review",
            "{\"reviews\":[]}",
        )
        .unwrap();

        assert_eq!(
            load_store_from(
                &directory,
                REVIEW_STORE_FILE,
                MAX_REVIEW_STORE_BYTES,
                "Review"
            )
            .unwrap()
            .as_deref(),
            Some("{\"reviews\":[]}")
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn returns_none_when_the_review_store_is_missing() {
        let directory = fixture();

        assert_eq!(
            load_store_from(
                &directory,
                REVIEW_STORE_FILE,
                MAX_REVIEW_STORE_BYTES,
                "Review"
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn rejects_review_store_content_over_the_size_limit() {
        let directory = fixture();
        let content = "x".repeat(MAX_REVIEW_STORE_BYTES + 1);

        assert!(save_store_to(
            &directory,
            REVIEW_STORE_FILE,
            MAX_REVIEW_STORE_BYTES,
            "review",
            &content
        )
        .unwrap_err()
        .contains("too large"));
    }

    #[test]
    fn copies_a_pre_patchdeck_store_into_the_current_data_directory() {
        let root = fixture();
        let current = root.join("com.local.patchdeck");
        let legacy = root.join(format!(
            "com.local.{}",
            ["branch", "diff", "viewer"].concat()
        ));
        save_store_to(
            &legacy,
            REVIEW_STORE_FILE,
            MAX_REVIEW_STORE_BYTES,
            "review",
            "{\"reviews\":[\"preserved\"]}",
        )
        .unwrap();

        assert_eq!(
            load_store_with_legacy(
                &current,
                REVIEW_STORE_FILE,
                MAX_REVIEW_STORE_BYTES,
                "Review"
            )
            .unwrap()
            .as_deref(),
            Some("{\"reviews\":[\"preserved\"]}")
        );
        assert!(current.join(REVIEW_STORE_FILE).exists());

        fs::remove_dir_all(root).unwrap();
    }
}
