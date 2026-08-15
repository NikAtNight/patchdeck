use getrandom::fill as fill_random;
use reqwest::blocking::multipart::Form;
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use reqwest::{Method, Url};
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

const API_PREFIX: &str = "/api/plugins/kanban";
const SESSION_HEADER: &str = "X-Hermes-Session-Token";
const READY_PREFIX: &str = "HERMES_BACKEND_READY port=";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(900);
const DISCOVERY_HTML_LIMIT: u64 = 1024 * 1024;
const DISCOVERY_ORIGINS: [&str; 2] = ["http://127.0.0.1:9119", "http://127.0.0.1:8000"];

const EVENT_CHANNEL: &str = "hermes-events";
const EVENT_LIVE_CHANNEL: &str = "hermes-events-live";
const EVENT_READ_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Default)]
pub struct HermesState {
    connection: Mutex<Option<HermesConnection>>,
    events: Mutex<Option<EventStream>>,
}

// Handle to the background thread tailing the Hermes event WebSocket. The
// thread checks the flag on every read timeout, so dropping the handle after
// setting it lets the thread wind down on its own.
struct EventStream {
    stop: Arc<AtomicBool>,
}

struct HermesConnection {
    session: HermesSession,
    child: Option<Child>,
}

// The cloneable half of a connection. Commands clone this out of the mutex and
// release the lock before sending HTTP requests, so one slow request cannot
// stall every other Hermes command behind the connection lock.
#[derive(Clone)]
struct HermesSession {
    base_url: String,
    token: String,
    version: String,
    mode: ConnectionMode,
    client: Client,
}

impl Drop for HermesConnection {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ConnectionMode {
    Managed,
    Attached,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    state: &'static str,
    mode: Option<ConnectionMode>,
    url: Option<String>,
    version: Option<String>,
    active_workers: usize,
    error: Option<String>,
}

impl ConnectionStatus {
    fn disconnected() -> Self {
        Self {
            state: "disconnected",
            mode: None,
            url: None,
            version: None,
            active_workers: 0,
            error: None,
        }
    }
}

#[derive(serde::Deserialize)]
struct HealthResponse {
    ok: bool,
    version: String,
}

pub fn connect_managed(state: &HermesState) -> Result<ConnectionStatus, String> {
    let token = new_session_token()?;
    let client = hermes_client()?;
    let hermes = find_hermes_binary();
    let child = Command::new(&hermes)
        .args([
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--skip-build",
        ])
        .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
        .env("HERMES_DESKTOP", "1")
        .env("HERMES_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start Hermes at {}: {error}. Install Hermes Agent or set HERMES_BINARY.",
                hermes.display()
            )
        })?;

    // Put the child under the connection's kill-on-drop guard immediately so
    // every readiness and probe failure cleans up the server this app started.
    let mut connection = HermesConnection {
        session: HermesSession {
            base_url: String::new(),
            token,
            version: String::new(),
            mode: ConnectionMode::Managed,
            client,
        },
        child: Some(child),
    };
    let child = connection
        .child
        .as_mut()
        .expect("managed connections always own their child during startup");

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Hermes did not provide a stdout stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Hermes did not provide a stderr stream".to_string())?;
    let (sender, receiver) = mpsc::channel::<OutputLine>();
    drain_output(stdout, sender.clone(), false);
    drain_output(stderr, sender, true);

    let started = Instant::now();
    let mut recent_errors = Vec::new();
    let port = loop {
        let remaining = CONNECT_TIMEOUT.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            let suffix = recent_output_suffix(&recent_errors);
            return Err(format!(
                "Hermes did not become ready within 20 seconds{suffix}"
            ));
        }

        match receiver.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(line) => {
                if let Some(port) = parse_ready_port(&line.text) {
                    break port;
                }
                if line.is_error && !line.text.trim().is_empty() {
                    recent_errors.push(line.text);
                    if recent_errors.len() > 8 {
                        recent_errors.remove(0);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                    let suffix = recent_output_suffix(&recent_errors);
                    return Err(format!(
                        "Hermes exited before it was ready ({status}){suffix}"
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = child.try_wait().ok().flatten();
                let suffix = recent_output_suffix(&recent_errors);
                return Err(format!(
                    "Hermes stopped before it was ready ({status:?}){suffix}"
                ));
            }
        }
    };

    connection.session.base_url = format!("http://127.0.0.1:{port}");
    let health = probe_health(
        &connection.session.client,
        &connection.session.base_url,
        REQUEST_TIMEOUT,
    )?;
    if !health.ok {
        return Err("Hermes health probe returned an unhealthy response".to_string());
    }
    connection.session.version = health.version;
    authenticated_json(&connection.session, Method::GET, "/boards", &[], None)?;
    replace_connection(state, connection)?;
    connection_status(state, None)
}

pub fn connect_existing(
    state: &HermesState,
    url: String,
    token: String,
) -> Result<ConnectionStatus, String> {
    let base_url = validate_loopback_url(&url)?;
    if token.trim().is_empty() {
        return Err("A Hermes session token is required".to_string());
    }
    let client = hermes_client()?;
    let health = probe_health(&client, &base_url, REQUEST_TIMEOUT)?;
    if !health.ok {
        return Err("Hermes health probe returned an unhealthy response".to_string());
    }
    connect_attached(state, client, base_url, token, health)
}

pub fn connect_discovered(state: &HermesState) -> Result<ConnectionStatus, String> {
    let client = hermes_client()?;
    let mut running_without_token = Vec::new();
    let mut rejected = None;

    for origin in DISCOVERY_ORIGINS {
        let Ok(health) = probe_health(&client, origin, DISCOVERY_TIMEOUT) else {
            continue;
        };
        if !health.ok {
            continue;
        }
        let Some(token) = discover_dashboard_token(&client, origin)? else {
            running_without_token.push(origin);
            continue;
        };
        match connect_attached(state, client.clone(), origin.to_string(), token, health) {
            Ok(status) => return Ok(status),
            Err(error) => rejected = Some(error),
        }
    }

    if !running_without_token.is_empty() {
        return Err(format!(
            "Found Hermes at {}, but it did not expose a local dashboard session. Use Attach existing with its server URL and session token.",
            running_without_token.join(" and ")
        ));
    }
    if let Some(error) = rejected {
        return Err(format!(
            "Found a local Hermes dashboard, but could not attach: {error}"
        ));
    }
    Err(
        "No running Hermes dashboard was found on the standard local ports 9119 or 8000."
            .to_string(),
    )
}

fn connect_attached(
    state: &HermesState,
    client: Client,
    base_url: String,
    token: String,
    health: HealthResponse,
) -> Result<ConnectionStatus, String> {
    let connection = HermesConnection {
        session: HermesSession {
            base_url,
            token,
            version: health.version,
            mode: ConnectionMode::Attached,
            client,
        },
        child: None,
    };
    authenticated_json(&connection.session, Method::GET, "/boards", &[], None)?;
    replace_connection(state, connection)?;
    connection_status(state, None)
}

pub fn disconnect(state: &HermesState) -> Result<ConnectionStatus, String> {
    stop_event_stream(state);
    state
        .connection
        .lock()
        .map_err(|_| "Hermes connection state is unavailable".to_string())?
        .take();
    Ok(ConnectionStatus::disconnected())
}

pub fn subscribe_events(
    app: tauri::AppHandle,
    state: &HermesState,
    board: String,
    since: u64,
) -> Result<(), String> {
    if board.trim().is_empty() {
        return Err("A board is required to stream Hermes events".to_string());
    }
    let session = session(state)?;
    let stop = Arc::new(AtomicBool::new(false));
    let mut guard = state
        .events
        .lock()
        .map_err(|_| "Hermes event state is unavailable".to_string())?;
    if let Some(stream) = guard.take() {
        stream.stop.store(true, Ordering::Relaxed);
    }
    *guard = Some(EventStream { stop: stop.clone() });
    drop(guard);
    thread::spawn(move || run_event_stream(app, session, board, since, stop));
    Ok(())
}

pub fn unsubscribe_events(app: tauri::AppHandle, state: &HermesState) -> Result<(), String> {
    stop_event_stream(state);
    let _ = app.emit(EVENT_LIVE_CHANNEL, false);
    Ok(())
}

fn stop_event_stream(state: &HermesState) {
    if let Ok(mut guard) = state.events.lock() {
        if let Some(stream) = guard.take() {
            stream.stop.store(true, Ordering::Relaxed);
        }
    }
}

fn run_event_stream(
    app: tauri::AppHandle,
    session: HermesSession,
    board: String,
    mut since: u64,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Relaxed) {
        if let Ok(mut socket) = open_event_socket(&session, &board, since) {
            let _ = app.emit(EVENT_LIVE_CHANNEL, true);
            pump_event_socket(&mut socket, &stop, |batch| {
                if let Some(cursor) = batch.get("cursor").and_then(Value::as_u64) {
                    since = cursor;
                }
                let _ = app.emit(EVENT_CHANNEL, batch);
            });
            let _ = socket.close(None);
            let _ = app.emit(EVENT_LIVE_CHANNEL, false);
        }
        // Reconnect with a short backoff that still notices a stop quickly.
        for _ in 0..6 {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
    }
}

// Reads batches until the socket fails, the server closes, or stop is set.
fn pump_event_socket(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    stop: &AtomicBool,
    mut on_batch: impl FnMut(Value),
) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    on_batch(value);
                }
            }
            Ok(Message::Close(_)) => return,
            // Pings are answered by tungstenite during read/write flushes.
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
}

fn open_event_socket(
    session: &HermesSession,
    board: &str,
    since: u64,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let url = event_socket_url(&session.base_url, board, since, &session.token)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| format!("Invalid Hermes event socket request: {error}"))?;
    if let Ok(header) = session.token.parse() {
        request.headers_mut().insert(SESSION_HEADER, header);
    }
    let (socket, _response) = tungstenite::connect(request)
        .map_err(|error| format!("Could not open the Hermes event socket: {error}"))?;
    if let MaybeTlsStream::Plain(stream) = socket.get_ref() {
        let _ = stream.set_read_timeout(Some(EVENT_READ_TIMEOUT));
    }
    Ok(socket)
}

// Loopback WebSocket auth uses the query token; the session header is also
// sent on the handshake for servers that accept it there.
fn event_socket_url(base_url: &str, board: &str, since: u64, token: &str) -> Result<Url, String> {
    let ws_base = base_url
        .strip_prefix("http://")
        .map(|rest| format!("ws://{rest}"))
        .ok_or_else(|| "Hermes event streaming requires a local HTTP connection".to_string())?;
    let mut url = Url::parse(&format!("{ws_base}{API_PREFIX}/events"))
        .map_err(|error| format!("Could not build the Hermes event socket URL: {error}"))?;
    url.query_pairs_mut()
        .append_pair("board", board)
        .append_pair("since", &since.to_string())
        .append_pair("token", token);
    Ok(url)
}

pub fn connection_status(
    state: &HermesState,
    board: Option<String>,
) -> Result<ConnectionStatus, String> {
    // Only the liveness check on the managed child needs the lock; the worker
    // probe below runs on a cloned session so it never blocks other commands.
    let session = {
        let mut guard = state
            .connection
            .lock()
            .map_err(|_| "Hermes connection state is unavailable".to_string())?;
        let Some(connection) = guard.as_mut() else {
            return Ok(ConnectionStatus::disconnected());
        };

        if let Some(child) = connection.child.as_mut() {
            if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
                guard.take();
                return Ok(ConnectionStatus {
                    state: "disconnected",
                    mode: None,
                    url: None,
                    version: None,
                    active_workers: 0,
                    error: Some(format!("Managed Hermes exited ({exit})")),
                });
            }
        }
        connection.session.clone()
    };

    let query = board
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| vec![("board", value)])
        .unwrap_or_default();
    let worker_result = authenticated_json(&session, Method::GET, "/workers/active", &query, None);
    let (state_name, active_workers, error) = match worker_result {
        Ok(value) => (
            "connected",
            value.get("count").and_then(Value::as_u64).unwrap_or(0) as usize,
            None,
        ),
        Err(error) => ("degraded", 0, Some(error)),
    };

    Ok(ConnectionStatus {
        state: state_name,
        mode: Some(session.mode),
        url: Some(session.base_url),
        version: Some(session.version),
        active_workers,
        error,
    })
}

pub fn list_boards(state: &HermesState) -> Result<Value, String> {
    let session = session(state)?;
    authenticated_json(&session, Method::GET, "/boards", &[], None)
}

pub fn list_profiles(state: &HermesState) -> Result<Value, String> {
    let session = session(state)?;
    authenticated_json(&session, Method::GET, "/profiles", &[], None)
}

pub fn get_board(
    state: &HermesState,
    board: String,
    include_archived: bool,
) -> Result<Value, String> {
    let session = session(state)?;
    let archived = if include_archived { "true" } else { "false" };
    authenticated_json(
        &session,
        Method::GET,
        "/board",
        &[("board", board.as_str()), ("include_archived", archived)],
        None,
    )
}

pub fn get_task(state: &HermesState, board: String, task_id: String) -> Result<Value, String> {
    validate_path_segment(&task_id, "task id")?;
    let session = session(state)?;
    authenticated_json(
        &session,
        Method::GET,
        &format!("/tasks/{task_id}"),
        &[("board", board.as_str())],
        None,
    )
}

pub fn get_task_log(state: &HermesState, board: String, task_id: String) -> Result<Value, String> {
    validate_path_segment(&task_id, "task id")?;
    let session = session(state)?;
    authenticated_json(
        &session,
        Method::GET,
        &format!("/tasks/{task_id}/log"),
        &[("board", board.as_str()), ("tail", "16384")],
        None,
    )
}

pub fn add_comment(
    state: &HermesState,
    board: String,
    task_id: String,
    body: String,
) -> Result<Value, String> {
    validate_path_segment(&task_id, "task id")?;
    if body.trim().is_empty() {
        return Err("Comment body is required".to_string());
    }
    let session = session(state)?;
    authenticated_json(
        &session,
        Method::POST,
        &format!("/tasks/{task_id}/comments"),
        &[("board", board.as_str())],
        Some(json!({ "author": "human-review", "body": body })),
    )
}

pub fn create_task(
    state: &HermesState,
    board: String,
    payload: Value,
    target_status: String,
) -> Result<Value, String> {
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if title.is_empty() {
        return Err("Task title is required".to_string());
    }
    validate_create_target(&target_status)?;
    let payload = prepare_create_payload(payload, &target_status)?;
    let session = session(state)?;
    let mut result = authenticated_json(
        &session,
        Method::POST,
        "/tasks",
        &[("board", board.as_str())],
        Some(payload),
    )?;
    let task = result.get("task");
    let task_id = task
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let created_status = task
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);
    let mut status_update_succeeded = true;
    if let Some(task_id) = task_id.filter(|_| created_status != Some(target_status.as_str())) {
        validate_path_segment(&task_id, "task id")?;
        let patched = authenticated_json(
            &session,
            Method::PATCH,
            &format!("/tasks/{task_id}"),
            &[("board", board.as_str())],
            Some(json!({ "status": target_status.clone() })),
        );
        status_update_succeeded = patched.is_ok();
        result = combine_task_creation_result(result, &target_status, patched);
    }
    // A failed transition may leave the new task ready. Do not dispatch it
    // when the user explicitly requested a non-ready status.
    if status_update_succeeded {
        let _ = authenticated_json(
            &session,
            Method::POST,
            "/dispatch",
            &[("board", board.as_str())],
            Some(json!({})),
        );
    }
    Ok(result)
}

fn prepare_create_payload(mut payload: Value, target_status: &str) -> Result<Value, String> {
    let fields = payload
        .as_object_mut()
        .ok_or_else(|| "Task payload must be a JSON object".to_string())?;
    // Hermes exposes triage as a create-time flag. Its other user-controlled
    // columns use lifecycle transitions after creation.
    fields.insert("triage".to_string(), Value::Bool(target_status == "triage"));
    Ok(payload)
}

fn combine_task_creation_result(
    mut created: Value,
    target_status: &str,
    patched: Result<Value, String>,
) -> Value {
    let Some(created_fields) = created.as_object_mut() else {
        return created;
    };
    match patched {
        Ok(patched) => {
            if let Some(task) = patched.get("task") {
                created_fields.insert("task".to_string(), task.clone());
            }
            created
        }
        Err(error) => {
            let warning = format!(
                "Task was created, but it could not be moved to '{target_status}': {error}"
            );
            let warning = created_fields
                .get("warning")
                .and_then(Value::as_str)
                .map(|existing| format!("{existing} {warning}"))
                .unwrap_or(warning);
            created_fields.insert("warning".to_string(), Value::String(warning));
            created_fields.insert("partialSuccess".to_string(), Value::Bool(true));
            created_fields.insert(
                "requestedStatus".to_string(),
                Value::String(target_status.to_string()),
            );
            created
        }
    }
}

fn validate_create_target(status: &str) -> Result<(), String> {
    if matches!(
        status,
        "triage" | "todo" | "ready" | "blocked" | "done" | "archived"
    ) {
        Ok(())
    } else {
        Err("Tasks cannot be created directly in this Hermes column".to_string())
    }
}

pub fn add_task_link(
    state: &HermesState,
    board: String,
    parent_id: String,
    child_id: String,
) -> Result<Value, String> {
    validate_path_segment(&parent_id, "parent task id")?;
    validate_path_segment(&child_id, "child task id")?;
    let session = session(state)?;
    authenticated_json(
        &session,
        Method::POST,
        "/links",
        &[("board", board.as_str())],
        Some(json!({ "parent_id": parent_id, "child_id": child_id })),
    )
}

pub fn remove_task_link(
    state: &HermesState,
    board: String,
    parent_id: String,
    child_id: String,
) -> Result<Value, String> {
    validate_path_segment(&parent_id, "parent task id")?;
    validate_path_segment(&child_id, "child task id")?;
    let session = session(state)?;
    authenticated_json(
        &session,
        Method::DELETE,
        "/links",
        &[
            ("board", board.as_str()),
            ("parent_id", parent_id.as_str()),
            ("child_id", child_id.as_str()),
        ],
        None,
    )
}

pub fn home_channels(state: &HermesState, board: String, task_id: String) -> Result<Value, String> {
    validate_path_segment(&task_id, "task id")?;
    let session = session(state)?;
    authenticated_json(
        &session,
        Method::GET,
        "/home-channels",
        &[("board", board.as_str()), ("task_id", task_id.as_str())],
        None,
    )
}

pub fn set_home_subscription(
    state: &HermesState,
    board: String,
    task_id: String,
    platform: String,
    subscribed: bool,
) -> Result<Value, String> {
    validate_path_segment(&task_id, "task id")?;
    validate_path_segment(&platform, "notification platform")?;
    let session = session(state)?;
    authenticated_json(
        &session,
        if subscribed {
            Method::POST
        } else {
            Method::DELETE
        },
        &format!("/tasks/{task_id}/home-subscribe/{platform}"),
        &[("board", board.as_str())],
        if subscribed { Some(json!({})) } else { None },
    )
}

pub fn upload_attachment(
    state: &HermesState,
    board: String,
    task_id: String,
    path: String,
) -> Result<Value, String> {
    validate_path_segment(&task_id, "task id")?;
    let path = Path::new(&path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Choose an existing local file to attach".to_string());
    }
    let form = Form::new()
        .file("file", path)
        .map_err(|error| format!("Could not read attachment: {error}"))?
        .text("uploaded_by", "human-review");
    let session = session(state)?;
    let url = format!(
        "{}{API_PREFIX}/tasks/{task_id}/attachments",
        session.base_url
    );
    let response = session
        .client
        .post(url)
        .header(SESSION_HEADER, &session.token)
        .query(&[("board", board.as_str())])
        .multipart(form)
        .send()
        .map_err(|error| format!("Hermes attachment upload failed: {error}"))?;
    decode_response(response)
}

pub fn download_attachment(
    state: &HermesState,
    board: String,
    attachment_id: u64,
    destination: String,
) -> Result<(), String> {
    let destination = Path::new(&destination);
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err("Choose a valid destination for the attachment".to_string());
    }
    let session = session(state)?;
    let url = format!(
        "{}{API_PREFIX}/attachments/{attachment_id}",
        session.base_url
    );
    let response = session
        .client
        .get(url)
        .header(SESSION_HEADER, &session.token)
        .query(&[("board", board.as_str())])
        .send()
        .map_err(|error| format!("Hermes attachment download failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return decode_response(response).map(|_| ());
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("Could not read Hermes attachment: {error}"))?;
    fs::write(destination, bytes).map_err(|error| format!("Could not save attachment: {error}"))
}

pub fn delete_attachment(
    state: &HermesState,
    board: String,
    attachment_id: u64,
) -> Result<Value, String> {
    let session = session(state)?;
    authenticated_json(
        &session,
        Method::DELETE,
        &format!("/attachments/{attachment_id}"),
        &[("board", board.as_str())],
        None,
    )
}

pub fn patch_task_status(
    state: &HermesState,
    board: String,
    task_id: String,
    status: String,
) -> Result<Value, String> {
    validate_path_segment(&task_id, "task id")?;
    if !matches!(
        status.as_str(),
        "triage" | "todo" | "scheduled" | "ready" | "blocked" | "review" | "done" | "archived"
    ) {
        return Err("Unsupported Hermes task status transition".to_string());
    }
    let detail = get_task(state, board.clone(), task_id.clone())?;
    let current = detail
        .get("task")
        .and_then(|task| task.get("status"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Hermes task response did not include its current status".to_string())?;
    validate_status_transition(current, &status)?;
    let session = session(state)?;
    let result = authenticated_json(
        &session,
        Method::PATCH,
        &format!("/tasks/{task_id}"),
        &[("board", board.as_str())],
        Some(json!({ "status": status })),
    )?;
    let _ = authenticated_json(
        &session,
        Method::POST,
        "/dispatch",
        &[("board", board.as_str())],
        Some(json!({})),
    );
    Ok(result)
}

fn validate_status_transition(current: &str, target: &str) -> Result<(), String> {
    let allowed = match current {
        "triage" => matches!(target, "todo" | "ready" | "archived"),
        "todo" => matches!(target, "ready" | "blocked" | "archived"),
        "scheduled" => matches!(target, "blocked" | "archived"),
        "ready" => matches!(target, "blocked" | "archived"),
        "running" => target == "blocked",
        "blocked" => matches!(target, "ready" | "archived"),
        "review" => matches!(target, "ready" | "done"),
        "done" => target == "archived",
        "archived" => false,
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(format!(
            "Unsupported Hermes task status transition from {current} to {target}"
        ))
    }
}

fn replace_connection(state: &HermesState, connection: HermesConnection) -> Result<(), String> {
    // An event stream from a previous connection would retry with stale
    // credentials forever; the frontend re-subscribes after connecting.
    stop_event_stream(state);
    let mut guard = state
        .connection
        .lock()
        .map_err(|_| "Hermes connection state is unavailable".to_string())?;
    *guard = Some(connection);
    Ok(())
}

fn session(state: &HermesState) -> Result<HermesSession, String> {
    let guard = state
        .connection
        .lock()
        .map_err(|_| "Hermes connection state is unavailable".to_string())?;
    guard
        .as_ref()
        .map(|connection| connection.session.clone())
        .ok_or_else(|| "Connect Hermes before opening the agent board".to_string())
}

fn authenticated_json(
    session: &HermesSession,
    method: Method,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{}{}{}", session.base_url, API_PREFIX, path);
    let mut request = session
        .client
        .request(method, url)
        .header(SESSION_HEADER, &session.token)
        .query(query);
    if let Some(body) = body {
        request = request.json(&body);
    }
    decode_response(
        request
            .send()
            .map_err(|error| format!("Hermes request failed: {error}"))?,
    )
}

fn decode_response(response: Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Could not read Hermes response: {error}"))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("detail")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| body.chars().take(500).collect());
        return Err(format!("Hermes returned {status}: {detail}"));
    }
    serde_json::from_str(&body).map_err(|error| format!("Hermes returned invalid JSON: {error}"))
}

fn probe_health(
    client: &Client,
    base_url: &str,
    timeout: Duration,
) -> Result<HealthResponse, String> {
    let response = client
        .get(format!("{base_url}/api/health"))
        .timeout(timeout)
        .send()
        .map_err(|error| format!("Could not reach Hermes at {base_url}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Hermes health probe returned {status}"));
    }
    response
        .json()
        .map_err(|error| format!("Hermes health response was invalid: {error}"))
}

fn discover_dashboard_token(client: &Client, base_url: &str) -> Result<Option<String>, String> {
    let response = client
        .get(format!("{base_url}/"))
        .timeout(DISCOVERY_TIMEOUT)
        .send()
        .map_err(|error| format!("Could not inspect the local Hermes dashboard: {error}"))?;
    if !response.status().is_success() {
        return Ok(None);
    }
    if response
        .content_length()
        .is_some_and(|size| size > DISCOVERY_HTML_LIMIT)
    {
        return Err("The local Hermes dashboard page was unexpectedly large".to_string());
    }
    let mut html = String::new();
    response
        .take(DISCOVERY_HTML_LIMIT + 1)
        .read_to_string(&mut html)
        .map_err(|error| format!("Could not read the local Hermes dashboard: {error}"))?;
    if html.len() as u64 > DISCOVERY_HTML_LIMIT {
        return Err("The local Hermes dashboard page was unexpectedly large".to_string());
    }
    Ok(extract_dashboard_token(&html))
}

fn extract_dashboard_token(html: &str) -> Option<String> {
    let value = html
        .split_once("window.__HERMES_SESSION_TOKEN__=")?
        .1
        .split_once(';')?
        .0
        .trim();
    serde_json::from_str::<String>(value)
        .ok()
        .filter(|token| !token.is_empty())
}

// One client per connection: requests reuse its connection pool instead of
// paying a fresh TCP handshake on every poll.
fn hermes_client() -> Result<Client, String> {
    // The updater and reqwest share rustls. Select one provider explicitly so
    // constructing the Hermes client is stable regardless of feature unification.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("Could not create Hermes client: {error}"))
}

fn validate_loopback_url(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "Enter a valid Hermes URL".to_string())?;
    if url.scheme() != "http" {
        return Err("The first release supports local HTTP Hermes connections only".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Hermes URL must include a host".to_string())?;
    if !is_loopback_host(host) {
        return Err("Hermes connections are limited to this machine".to_string());
    }
    if url.port().is_none() {
        return Err("Hermes URL must include its local port".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Do not put credentials in the Hermes URL".to_string());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Use the Hermes server origin without a path, query, or fragment".to_string());
    }
    url.set_path("");
    Ok(url.as_str().trim_end_matches('/').to_string())
}

// IPv6 hosts come out of Url::host_str with their brackets ("[::1]").
fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    let bare = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    bare.parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

fn validate_path_segment(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
    {
        return Err(format!("Invalid {label}"));
    }
    Ok(())
}

fn find_hermes_binary() -> PathBuf {
    if let Some(path) = env::var_os("HERMES_BINARY").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    if let Some(home) = env::var_os("HOME") {
        let local = PathBuf::from(home).join(".local/bin/hermes");
        if local.is_file() {
            return local;
        }
    }
    PathBuf::from("hermes")
}

fn new_session_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    fill_random(&mut bytes)
        .map_err(|error| format!("Could not generate a Hermes session token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

struct OutputLine {
    text: String,
    is_error: bool,
}

fn drain_output(
    reader: impl std::io::Read + Send + 'static,
    sender: mpsc::Sender<OutputLine>,
    is_error: bool,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = sender.send(OutputLine {
                text: line,
                is_error,
            });
        }
    });
}

fn parse_ready_port(line: &str) -> Option<u16> {
    line.trim()
        .strip_prefix(READY_PREFIX)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
}

fn recent_output_suffix(lines: &[String]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!(". Recent output: {}", lines.join(" | "))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        authenticated_json, combine_task_creation_result, event_socket_url,
        extract_dashboard_token, hermes_client, parse_ready_port, patch_task_status,
        prepare_create_payload, pump_event_socket, validate_create_target, validate_loopback_url,
        validate_path_segment, validate_status_transition, ConnectionMode, HermesSession,
        HermesState,
    };
    use reqwest::Method;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parses_the_managed_server_ready_sentinel() {
        assert_eq!(
            parse_ready_port("HERMES_BACKEND_READY port=43117"),
            Some(43117)
        );
        assert_eq!(parse_ready_port("HERMES_DASHBOARD_READY port=43117"), None);
        assert_eq!(parse_ready_port("HERMES_BACKEND_READY port=0"), None);
    }

    #[test]
    fn attached_connections_are_loopback_http_only() {
        assert_eq!(
            validate_loopback_url("http://127.0.0.1:43117").unwrap(),
            "http://127.0.0.1:43117"
        );
        assert_eq!(
            validate_loopback_url("http://localhost:43117/").unwrap(),
            "http://localhost:43117"
        );
        assert_eq!(
            validate_loopback_url("http://[::1]:43117").unwrap(),
            "http://[::1]:43117"
        );
        assert!(validate_loopback_url("https://127.0.0.1:43117").is_err());
        assert!(validate_loopback_url("http://[2001:db8::1]:43117").is_err());
        assert!(validate_loopback_url("http://192.168.1.10:43117").is_err());
        assert!(validate_loopback_url("http://localhost:43117/api").is_err());
        assert!(validate_loopback_url("http://localhost").is_err());
    }

    #[test]
    fn task_ids_cannot_escape_the_scoped_endpoint() {
        assert!(validate_path_segment("task-123", "task id").is_ok());
        assert!(validate_path_segment("../boards", "task id").is_err());
        assert!(validate_path_segment("task/123", "task id").is_err());
    }

    #[test]
    fn extracts_only_a_json_string_dashboard_token() {
        assert_eq!(
            extract_dashboard_token(
                r#"<script>window.__HERMES_SESSION_TOKEN__="served\\token\"quoted";window.ready=true</script>"#
            ),
            Some("served\\token\"quoted".to_string())
        );
        assert_eq!(
            extract_dashboard_token(
                "<script>window.__HERMES_SESSION_TOKEN__={token:'unsafe'};</script>"
            ),
            None
        );
        assert_eq!(
            extract_dashboard_token("<html>No session token</html>"),
            None
        );
    }

    #[test]
    fn task_status_command_rejects_direct_running_transitions() {
        let error = patch_task_status(
            &HermesState::default(),
            "default".to_string(),
            "task-123".to_string(),
            "running".to_string(),
        )
        .unwrap_err();
        assert!(error.contains("Unsupported Hermes task status"));
    }

    #[test]
    fn task_status_transitions_follow_the_review_workflow() {
        assert!(validate_status_transition("review", "done").is_ok());
        assert!(validate_status_transition("review", "ready").is_ok());
        assert!(validate_status_transition("running", "done").is_err());
        assert!(validate_status_transition("done", "ready").is_err());
        assert!(validate_status_transition("archived", "ready").is_err());
    }

    #[test]
    fn task_creation_excludes_dispatcher_owned_columns() {
        for status in ["triage", "todo", "ready", "blocked", "done", "archived"] {
            assert!(validate_create_target(status).is_ok());
        }
        for status in ["scheduled", "running", "review"] {
            assert!(validate_create_target(status).is_err());
        }
    }

    #[test]
    fn triage_task_creation_uses_the_atomic_create_flag() {
        let payload = prepare_create_payload(json!({ "title": "Investigate" }), "triage").unwrap();
        assert_eq!(payload["triage"], true);
    }

    #[test]
    fn failed_post_create_status_change_is_returned_as_partial_success() {
        let created = json!({
            "task": { "id": "task-123", "title": "Build it", "status": "ready" }
        });
        let result = combine_task_creation_result(
            created,
            "blocked",
            Err("Hermes returned 409 Conflict: transition rejected".to_string()),
        );

        assert_eq!(result["task"]["id"], "task-123");
        assert_eq!(result["task"]["status"], "ready");
        assert_eq!(result["partialSuccess"], true);
        assert_eq!(result["requestedStatus"], "blocked");
        assert!(result["warning"]
            .as_str()
            .unwrap()
            .contains("transition rejected"));
    }

    #[test]
    fn successful_post_create_status_change_returns_the_updated_task() {
        let created = json!({
            "task": { "id": "task-123", "title": "Build it", "status": "ready" }
        });
        let patched = json!({
            "task": { "id": "task-123", "title": "Build it", "status": "blocked" }
        });

        let result = combine_task_creation_result(created, "blocked", Ok(patched));

        assert_eq!(result["task"]["status"], "blocked");
        assert!(result.get("partialSuccess").is_none());
    }

    #[test]
    fn authenticated_requests_do_not_follow_redirects() {
        let redirector = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirector_address = redirector.local_addr().unwrap();
        let receiver = TcpListener::bind("127.0.0.1:0").unwrap();
        let receiver_address = receiver.local_addr().unwrap();
        receiver.set_nonblocking(true).unwrap();

        let server = thread::spawn(move || {
            let (mut stream, _) = redirector.accept().unwrap();
            let mut request = [0_u8; 2048];
            let size = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..size])
                .to_ascii_lowercase()
                .contains("x-hermes-session-token: private-token"));
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: http://{receiver_address}/capture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });

        let session = HermesSession {
            base_url: format!("http://{redirector_address}"),
            token: "private-token".to_string(),
            version: "test".to_string(),
            mode: ConnectionMode::Attached,
            client: hermes_client().unwrap(),
        };
        let error = authenticated_json(&session, Method::GET, "/boards", &[], None).unwrap_err();
        assert!(error.contains("302"));
        server.join().unwrap();
        assert!(matches!(
            receiver.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn event_socket_url_is_loopback_ws_with_board_cursor_and_token() {
        let url =
            event_socket_url("http://127.0.0.1:43117", "product board", 42, "secret").unwrap();
        assert_eq!(
            url.as_str(),
            "ws://127.0.0.1:43117/api/plugins/kanban/events?board=product+board&since=42&token=secret"
        );
        assert!(event_socket_url("https://127.0.0.1:43117", "product", 0, "secret").is_err());
    }

    #[test]
    fn event_socket_pump_forwards_batches_and_honors_stop() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            socket
                .send(tungstenite::Message::Text(
                    "{\"events\":[{\"id\":7}],\"cursor\":7}".into(),
                ))
                .unwrap();
            // Initiate the close and drop the socket; the TCP FIN ends the
            // client's pump even if the close handshake never completes.
            let _ = socket.close(None);
            let _ = socket.flush();
        });

        let (mut client, _) = tungstenite::connect(format!("ws://{address}")).unwrap();
        let stop = AtomicBool::new(false);
        let mut batches = Vec::new();
        pump_event_socket(&mut client, &stop, |batch| batches.push(batch));
        drop(client);

        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0]["cursor"], 7);
        server.join().unwrap();

        stop.store(true, Ordering::Relaxed);
    }

    #[test]
    #[ignore = "requires a local Hermes Agent installation"]
    fn managed_connection_starts_and_stops_installed_hermes() {
        let state = super::HermesState::default();
        let status = super::connect_managed(&state).expect("managed Hermes should connect");
        assert_eq!(status.state, "connected");
        assert!(status
            .url
            .as_deref()
            .unwrap_or_default()
            .starts_with("http://127.0.0.1:"));
        let disconnected = super::disconnect(&state).expect("managed Hermes should disconnect");
        assert_eq!(disconnected.state, "disconnected");
    }

    #[test]
    #[ignore = "requires a running local Hermes dashboard on a standard port"]
    fn discovers_a_running_local_hermes_dashboard() {
        let state = super::HermesState::default();
        let status =
            super::connect_discovered(&state).expect("running Hermes should be discovered");
        assert_eq!(status.state, "connected");
        assert!(matches!(status.mode, Some(super::ConnectionMode::Attached)));
        super::disconnect(&state).unwrap();
    }
}
