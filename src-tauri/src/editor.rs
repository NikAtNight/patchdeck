use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_EDITABLE_BYTES: u64 = 2 * 1024 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableFile {
    path: String,
    content: String,
    hash: String,
}

pub fn load(repository_path: &str, relative_path: &str) -> Result<EditableFile, String> {
    let target = contained_file(repository_path, relative_path)?;
    let metadata =
        fs::metadata(&target).map_err(|error| format!("Could not inspect file: {error}"))?;
    if metadata.len() > MAX_EDITABLE_BYTES {
        return Err("Files larger than 2 MB cannot be edited in this app".to_string());
    }
    let bytes = fs::read(&target).map_err(|error| format!("Could not read file: {error}"))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| "Binary or non-UTF-8 files cannot be edited in this app".to_string())?;
    Ok(EditableFile {
        path: relative_path.to_string(),
        content,
        hash: content_hash(&bytes),
    })
}

pub fn save(
    repository_path: &str,
    relative_path: &str,
    expected_hash: &str,
    content: &str,
) -> Result<EditableFile, String> {
    if content.len() as u64 > MAX_EDITABLE_BYTES {
        return Err("Files larger than 2 MB cannot be edited in this app".to_string());
    }
    let target = contained_file(repository_path, relative_path)?;
    let current =
        fs::read(&target).map_err(|error| format!("Could not read file before saving: {error}"))?;
    if content_hash(&current) != expected_hash {
        return Err(
            "This file changed on disk after it was opened. Reload it before saving.".to_string(),
        );
    }

    let parent = target
        .parent()
        .ok_or_else(|| "The file does not have a writable parent folder".to_string())?;
    let permissions = fs::metadata(&target)
        .map_err(|error| format!("Could not inspect file permissions: {error}"))?
        .permissions();
    let temp_path = unique_temp_path(
        parent,
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
    );
    let result = (|| {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Could not create atomic save file: {error}"))?;
        temp.set_permissions(permissions)
            .map_err(|error| format!("Could not preserve file permissions: {error}"))?;
        temp.write_all(content.as_bytes())
            .map_err(|error| format!("Could not write file: {error}"))?;
        temp.sync_all()
            .map_err(|error| format!("Could not finish writing file: {error}"))?;
        fs::rename(&temp_path, &target)
            .map_err(|error| format!("Could not replace file atomically: {error}"))?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result?;
    load(repository_path, relative_path)
}

fn contained_file(repository_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("File path must be a contained repository-relative path".to_string());
    }
    let requested_root = fs::canonicalize(repository_path)
        .map_err(|error| format!("Could not resolve repository root: {error}"))?;
    let git_root = crate::repository::resolve_root(repository_path)
        .map_err(|error| format!("Could not verify repository root: {error}"))?;
    let root = fs::canonicalize(&git_root)
        .map_err(|error| format!("Could not resolve Git repository root: {error}"))?;
    if requested_root != root {
        return Err("Editing requires the repository's exact Git working-tree root".to_string());
    }
    let target = fs::canonicalize(root.join(relative))
        .map_err(|error| format!("Could not resolve file: {error}"))?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err("The selected file is outside the repository".to_string());
    }
    Ok(target)
}

fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn unique_temp_path(parent: &Path, name: &str) -> PathBuf {
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".{name}.branch-diff-viewer-{}-{sequence}.tmp",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::{load, save, unique_temp_path};
    use std::fs;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        let root = unique_temp_path(&std::env::temp_dir(), "editor-test").with_extension("repo");
        fs::create_dir_all(root.join("src")).unwrap();
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(status.success());
        fs::write(root.join("src/example.txt"), "before\n").unwrap();
        root
    }

    #[test]
    fn saves_atomically_with_an_optimistic_hash() {
        let root = fixture();
        let opened = load(root.to_str().unwrap(), "src/example.txt").unwrap();
        let saved = save(
            root.to_str().unwrap(),
            "src/example.txt",
            &opened.hash,
            "after\n",
        )
        .unwrap();
        assert_eq!(saved.content, "after\n");
        assert_ne!(saved.hash, opened.hash);
        assert_eq!(
            fs::read_to_string(root.join("src/example.txt")).unwrap(),
            "after\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_stale_and_traversing_writes() {
        let root = fixture();
        let opened = load(root.to_str().unwrap(), "src/example.txt").unwrap();
        fs::write(root.join("src/example.txt"), "external\n").unwrap();
        assert!(save(
            root.to_str().unwrap(),
            "src/example.txt",
            &opened.hash,
            "mine\n"
        )
        .unwrap_err()
        .contains("changed on disk"));
        assert!(load(root.to_str().unwrap(), "../outside.txt").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let outside = root.with_extension("outside");
        fs::write(&outside, "secret\n").unwrap();
        symlink(&outside, root.join("src/outside.txt")).unwrap();
        assert!(load(root.to_str().unwrap(), "src/outside.txt").is_err());
        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
