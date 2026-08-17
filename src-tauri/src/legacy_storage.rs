use std::collections::HashMap;

const CURRENT_PREFIX: &str = "patchdeck";
const MAX_VALUE_BYTES: usize = 5 * 1024 * 1024;
const KNOWN_SUFFIXES: &[&str] = &[
    ".active-surface",
    ".hermes.selected-board",
    ".hermes.selected-boards",
    ".inline-review-comments.v1",
    ".project-views.v1",
    ".recent-repositories",
    ".review-store.v1",
    ".review-target.v1",
    ".reviewed-files.v1",
    ".session",
];

#[tauri::command]
pub fn load_pre_patchdeck_webkit_storage(
    app: tauri::AppHandle,
) -> Result<HashMap<String, String>, String> {
    load_platform_storage(&app)
}

#[cfg(not(target_os = "macos"))]
fn load_platform_storage(_app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    Ok(HashMap::new())
}

#[cfg(target_os = "macos")]
fn load_platform_storage(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    use rusqlite::{Connection, OpenFlags};
    use tauri::Manager;

    let current_identifier = &app.config().identifier;
    let suffix = current_identifier
        .strip_prefix("com.local.patchdeck")
        .unwrap_or_default();
    let old_product = ["branch", "diff", "viewer"].concat();
    let old_identifier = format!("com.local.{old_product}{suffix}");
    let root = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not find the home directory: {error}"))?
        .join("Library")
        .join("WebKit")
        .join(old_identifier)
        .join("WebsiteData")
        .join("Default");
    if !root.exists() {
        return Ok(HashMap::new());
    }

    let old_prefix = ["branch", "diff", "viewer"].join("-");
    let mut values = HashMap::new();
    for database in find_local_storage_databases(&root, 4) {
        let connection = match Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        let mut statement = match connection.prepare("SELECT key, value FROM ItemTable") {
            Ok(statement) => statement,
            Err(_) => continue,
        };
        let rows = match statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        }) {
            Ok(rows) => rows,
            Err(_) => continue,
        };
        for row in rows.flatten() {
            let (key, raw_value) = row;
            let Some(suffix) = key.strip_prefix(&old_prefix) else {
                continue;
            };
            if !KNOWN_SUFFIXES.contains(&suffix) || raw_value.len() > MAX_VALUE_BYTES {
                continue;
            }
            if let Some(value) = decode_webkit_value(&raw_value) {
                values
                    .entry(format!("{CURRENT_PREFIX}{suffix}"))
                    .or_insert(value);
            }
        }
    }
    Ok(values)
}

#[cfg(target_os = "macos")]
fn find_local_storage_databases(root: &std::path::Path, depth: usize) -> Vec<std::path::PathBuf> {
    if depth == 0 {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut databases = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file()
            && path.file_name().and_then(|name| name.to_str()) == Some("localstorage.sqlite3")
        {
            databases.push(path);
        } else if file_type.is_dir() {
            databases.extend(find_local_storage_databases(&path, depth - 1));
        }
    }
    databases
}

#[cfg(target_os = "macos")]
fn decode_webkit_value(value: &[u8]) -> Option<String> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    let words = value
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&words).ok()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::decode_webkit_value;

    #[test]
    fn decodes_webkit_utf16_local_storage_values() {
        let raw = "{\"version\":1}"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();

        assert_eq!(
            decode_webkit_value(&raw).as_deref(),
            Some("{\"version\":1}")
        );
        assert_eq!(decode_webkit_value(&[1]), None);
    }
}
