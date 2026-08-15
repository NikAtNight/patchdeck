mod editor;
mod hermes;
mod repository;
mod storage;
mod workspace;

use repository::{CommitInfo, Comparison, FileDiff, RepositoryInfo};
use tauri::Manager;
use workspace::WorkspaceProject;

#[tauri::command]
fn load_editable_file(
    repository_path: String,
    path: String,
) -> Result<editor::EditableFile, String> {
    editor::load(&repository_path, &path)
}

#[tauri::command]
fn save_editable_file(
    repository_path: String,
    path: String,
    expected_hash: String,
    content: String,
) -> Result<editor::EditableFile, String> {
    editor::save(&repository_path, &path, &expected_hash, &content)
}

#[tauri::command]
async fn hermes_connect_managed(app: tauri::AppHandle) -> Result<hermes::ConnectionStatus, String> {
    run_hermes_blocking(app, hermes::connect_managed).await
}

#[tauri::command]
async fn hermes_connect_discovered(
    app: tauri::AppHandle,
) -> Result<hermes::ConnectionStatus, String> {
    run_hermes_blocking(app, hermes::connect_discovered).await
}

#[tauri::command]
async fn hermes_connect_existing(
    app: tauri::AppHandle,
    url: String,
    token: String,
) -> Result<hermes::ConnectionStatus, String> {
    run_hermes_blocking(app, move |state| {
        hermes::connect_existing(state, url, token)
    })
    .await
}

#[tauri::command]
async fn hermes_disconnect(app: tauri::AppHandle) -> Result<hermes::ConnectionStatus, String> {
    run_hermes_blocking(app, hermes::disconnect).await
}

#[tauri::command]
async fn hermes_subscribe_events(
    app: tauri::AppHandle,
    board: String,
    since: Option<u64>,
) -> Result<(), String> {
    let emitter = app.clone();
    run_hermes_blocking(app, move |state| {
        hermes::subscribe_events(emitter, state, board, since.unwrap_or(0))
    })
    .await
}

#[tauri::command]
async fn hermes_unsubscribe_events(app: tauri::AppHandle) -> Result<(), String> {
    let emitter = app.clone();
    run_hermes_blocking(app, move |state| hermes::unsubscribe_events(emitter, state)).await
}

#[tauri::command]
async fn hermes_connection_status(
    app: tauri::AppHandle,
    board: Option<String>,
) -> Result<hermes::ConnectionStatus, String> {
    run_hermes_blocking(app, move |state| hermes::connection_status(state, board)).await
}

#[tauri::command]
async fn hermes_list_boards(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, hermes::list_boards).await
}

#[tauri::command]
async fn hermes_list_profiles(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, hermes::list_profiles).await
}

#[tauri::command]
async fn hermes_get_board(
    app: tauri::AppHandle,
    board: String,
    include_archived: bool,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::get_board(state, board, include_archived)
    })
    .await
}

#[tauri::command]
async fn hermes_get_task(
    app: tauri::AppHandle,
    board: String,
    task_id: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| hermes::get_task(state, board, task_id)).await
}

#[tauri::command]
async fn hermes_get_task_log(
    app: tauri::AppHandle,
    board: String,
    task_id: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::get_task_log(state, board, task_id)
    })
    .await
}

#[tauri::command]
async fn hermes_add_comment(
    app: tauri::AppHandle,
    board: String,
    task_id: String,
    body: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::add_comment(state, board, task_id, body)
    })
    .await
}

#[tauri::command]
async fn hermes_create_task(
    app: tauri::AppHandle,
    board: String,
    payload: serde_json::Value,
    target_status: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::create_task(state, board, payload, target_status)
    })
    .await
}

#[tauri::command]
async fn hermes_patch_task(
    app: tauri::AppHandle,
    board: String,
    task_id: String,
    status: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::patch_task_status(state, board, task_id, status)
    })
    .await
}

#[tauri::command]
async fn hermes_add_task_link(
    app: tauri::AppHandle,
    board: String,
    parent_id: String,
    child_id: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::add_task_link(state, board, parent_id, child_id)
    })
    .await
}

#[tauri::command]
async fn hermes_remove_task_link(
    app: tauri::AppHandle,
    board: String,
    parent_id: String,
    child_id: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::remove_task_link(state, board, parent_id, child_id)
    })
    .await
}

#[tauri::command]
async fn hermes_home_channels(
    app: tauri::AppHandle,
    board: String,
    task_id: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::home_channels(state, board, task_id)
    })
    .await
}

#[tauri::command]
async fn hermes_set_home_subscription(
    app: tauri::AppHandle,
    board: String,
    task_id: String,
    platform: String,
    subscribed: bool,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::set_home_subscription(state, board, task_id, platform, subscribed)
    })
    .await
}

#[tauri::command]
async fn hermes_upload_attachment(
    app: tauri::AppHandle,
    board: String,
    task_id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::upload_attachment(state, board, task_id, path)
    })
    .await
}

#[tauri::command]
async fn hermes_download_attachment(
    app: tauri::AppHandle,
    board: String,
    attachment_id: u64,
    destination: String,
) -> Result<(), String> {
    run_hermes_blocking(app, move |state| {
        hermes::download_attachment(state, board, attachment_id, destination)
    })
    .await
}

#[tauri::command]
async fn hermes_delete_attachment(
    app: tauri::AppHandle,
    board: String,
    attachment_id: u64,
) -> Result<serde_json::Value, String> {
    run_hermes_blocking(app, move |state| {
        hermes::delete_attachment(state, board, attachment_id)
    })
    .await
}

async fn run_hermes_blocking<T, F>(app: tauri::AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&hermes::HermesState) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<hermes::HermesState>();
        operation(&state)
    })
    .await
    .map_err(|error| format!("Hermes background operation failed: {error}"))?
}

fn should_hide_instead_of_close(window_label: &str) -> bool {
    cfg!(target_os = "macos") && window_label == "main"
}

#[tauri::command]
fn open_repository(path: String) -> Result<RepositoryInfo, String> {
    repository::open(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_commits(
    repository_path: String,
    merge_base: String,
    compare_commit: String,
) -> Result<Vec<CommitInfo>, String> {
    repository::commits(&repository_path, &merge_base, &compare_commit)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_review_store(app: tauri::AppHandle) -> Result<Option<String>, String> {
    storage::load_review_store(app)
}

#[tauri::command]
fn save_review_store(app: tauri::AppHandle, content: String) -> Result<(), String> {
    storage::save_review_store(app, content)
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

#[tauri::command]
fn load_working_tree_file_diff(
    repository_path: String,
    merge_base: String,
    path: String,
    old_path: Option<String>,
) -> Result<FileDiff, String> {
    repository::working_tree_file_diff(&repository_path, &merge_base, &path, old_path.as_deref())
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(hermes::HermesState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            hermes_connect_managed,
            hermes_connect_discovered,
            hermes_connect_existing,
            hermes_disconnect,
            hermes_subscribe_events,
            hermes_unsubscribe_events,
            hermes_connection_status,
            hermes_list_boards,
            hermes_list_profiles,
            hermes_get_board,
            hermes_get_task,
            hermes_get_task_log,
            hermes_add_comment,
            hermes_create_task,
            hermes_patch_task,
            hermes_add_task_link,
            hermes_remove_task_link,
            hermes_home_channels,
            hermes_set_home_subscription,
            hermes_upload_attachment,
            hermes_download_attachment,
            hermes_delete_attachment,
            load_editable_file,
            save_editable_file,
            open_repository,
            list_commits,
            load_review_store,
            save_review_store,
            open_workspace,
            open_workspace_project,
            compare_branches,
            load_file_diff,
            load_working_tree_file_diff
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
        .expect("error while building Patchdeck");

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
