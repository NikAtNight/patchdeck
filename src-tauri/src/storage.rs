use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

const MAX_REVIEW_STORE_BYTES: usize = 5 * 1024 * 1024;
const REVIEW_STORE_FILE: &str = "review-store.json";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn load_review_store(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data folder: {error}"))?;
    load_review_store_from(&directory)
}

pub fn save_review_store(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data folder: {error}"))?;
    save_review_store_to(&directory, &content)
}

fn load_review_store_from(directory: &Path) -> Result<Option<String>, String> {
    let path = directory.join(REVIEW_STORE_FILE);
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_REVIEW_STORE_BYTES as u64 => {
            return Err("Review store file is larger than 5 MB and was ignored".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect review store: {error}")),
    }
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read review store: {error}")),
    }
}

fn save_review_store_to(directory: &Path, content: &str) -> Result<(), String> {
    if content.len() > MAX_REVIEW_STORE_BYTES {
        return Err("Review store data larger than 5 MB cannot be saved in this app".to_string());
    }
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the application data folder: {error}"))?;

    let target = directory.join(REVIEW_STORE_FILE);
    let temp_path = unique_temp_path(directory, REVIEW_STORE_FILE);
    let result = (|| {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Could not create atomic review store file: {error}"))?;
        temp.write_all(content.as_bytes())
            .map_err(|error| format!("Could not write review store: {error}"))?;
        temp.sync_all()
            .map_err(|error| format!("Could not finish writing review store: {error}"))?;
        fs::rename(&temp_path, &target)
            .map_err(|error| format!("Could not replace review store atomically: {error}"))?;
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
        ".{name}.branch-diff-viewer-{}-{sequence}.tmp",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        load_review_store_from, save_review_store_to, unique_temp_path, MAX_REVIEW_STORE_BYTES,
    };
    use std::fs;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        unique_temp_path(&std::env::temp_dir(), "review-store-test").with_extension("data")
    }

    #[test]
    fn saves_and_loads_the_review_store() {
        let directory = fixture();
        save_review_store_to(&directory, "{\"reviews\":[]}").unwrap();

        assert_eq!(
            load_review_store_from(&directory).unwrap().as_deref(),
            Some("{\"reviews\":[]}")
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn returns_none_when_the_review_store_is_missing() {
        let directory = fixture();

        assert_eq!(load_review_store_from(&directory).unwrap(), None);
    }

    #[test]
    fn rejects_review_store_content_over_the_size_limit() {
        let directory = fixture();
        let content = "x".repeat(MAX_REVIEW_STORE_BYTES + 1);

        assert!(save_review_store_to(&directory, &content)
            .unwrap_err()
            .contains("5 MB"));
    }
}
