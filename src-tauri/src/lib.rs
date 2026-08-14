mod repository;
mod workspace;

use repository::{Comparison, FileDiff, RepositoryInfo};
use tauri::Manager;
use workspace::WorkspaceProject;

fn should_hide_instead_of_close(window_label: &str) -> bool {
    cfg!(target_os = "macos") && window_label == "main"
}

#[tauri::command]
fn open_repository(path: String) -> Result<RepositoryInfo, String> {
    repository::open(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_workspace(path: String) -> Result<Vec<WorkspaceProject>, String> {
    workspace::open(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_workspace_project(path: String) -> Result<RepositoryInfo, String> {
    workspace::open_project(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn compare_branches(
    repository_path: String,
    base_branch: String,
    compare_branch: String,
) -> Result<Comparison, String> {
    repository::compare(&repository_path, &base_branch, &compare_branch)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_file_diff(
    repository_path: String,
    merge_base: String,
    compare_commit: String,
    path: String,
    old_path: Option<String>,
) -> Result<FileDiff, String> {
    repository::file_diff(
        &repository_path,
        &merge_base,
        &compare_commit,
        &path,
        old_path.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_repository,
            open_workspace,
            open_workspace_project,
            compare_branches,
            load_file_diff
        ])
        .on_window_event(|window, event| {
            if should_hide_instead_of_close(window.label()) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Branch Diff Viewer");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}

#[cfg(test)]
mod lifecycle_tests {
    use super::should_hide_instead_of_close;

    #[test]
    fn closing_the_main_window_keeps_the_app_running() {
        assert_eq!(
            should_hide_instead_of_close("main"),
            cfg!(target_os = "macos")
        );
        assert!(!should_hide_instead_of_close("secondary"));
    }
}
