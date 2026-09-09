use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

const EVENT_NAME: &str = "agent-runtime-event";
const MAX_PROMPT_BYTES: usize = 100_000;
const MAX_INSTRUCTIONS_BYTES: usize = 100_000;
const MAX_PROTOCOL_LINE_BYTES: usize = 2_000_000;
const CODEX_INTERRUPT_REQUEST_ID: i64 = 9_000;
const CODEX_INTERRUPT_ACK_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeId {
    Codex,
    Claude,
}

impl RuntimeId {
    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
        }
    }

    fn binary_name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AgentSandbox {
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    runtime_id: RuntimeId,
    run_id: String,
    repository_path: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    sandbox: AgentSandbox,
    instructions: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    id: RuntimeId,
    label: &'static str,
    installed: bool,
    authenticated: Option<bool>,
    ready: bool,
    version: Option<String>,
    path: Option<String>,
    auth_mode: Option<String>,
    account_label: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionResult {
    status: RuntimeStatus,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    session_id: String,
    turn_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum CompletionStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RuntimeEventType {
    AgentDelta,
    Activity,
    Completed,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEvent {
    runtime_id: RuntimeId,
    run_id: String,
    #[serde(rename = "type")]
    event_type: RuntimeEventType,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<CompletionStatus>,
}

impl RuntimeEvent {
    fn delta(runtime_id: RuntimeId, run_id: &str, delta: String) -> Self {
        Self {
            runtime_id,
            run_id: run_id.to_string(),
            event_type: RuntimeEventType::AgentDelta,
            delta: Some(delta),
            message: None,
            status: None,
        }
    }

    fn activity(runtime_id: RuntimeId, run_id: &str, message: impl Into<String>) -> Self {
        Self {
            runtime_id,
            run_id: run_id.to_string(),
            event_type: RuntimeEventType::Activity,
            delta: None,
            message: Some(message.into()),
            status: None,
        }
    }

    fn completed(
        runtime_id: RuntimeId,
        run_id: &str,
        status: CompletionStatus,
        message: Option<String>,
    ) -> Self {
        Self {
            runtime_id,
            run_id: run_id.to_string(),
            event_type: RuntimeEventType::Completed,
            delta: None,
            message,
            status: Some(status),
        }
    }

    fn error(runtime_id: RuntimeId, run_id: &str, message: impl Into<String>) -> Self {
        Self {
            runtime_id,
            run_id: run_id.to_string(),
            event_type: RuntimeEventType::Error,
            delta: None,
            message: Some(message.into()),
            status: Some(CompletionStatus::Failed),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RunKey {
    runtime_id: RuntimeId,
    run_id: String,
}

#[derive(Clone)]
enum RunControl {
    Codex {
        stdin: Arc<Mutex<ChildStdin>>,
        process: Arc<Mutex<Child>>,
        interrupt: Arc<CodexInterruptSignal>,
        thread_id: Option<String>,
        turn_id: Option<String>,
    },
    Claude {
        process: Arc<Mutex<Child>>,
    },
}

struct ActiveRun {
    cancelled: Arc<AtomicBool>,
    control: RunControl,
}

#[derive(Default)]
struct CodexInterruptSignal {
    outcome: Mutex<Option<bool>>,
    ready: Condvar,
}

impl CodexInterruptSignal {
    fn resolve(&self, acknowledged: bool) {
        if let Ok(mut outcome) = self.outcome.lock() {
            if outcome.is_none() {
                *outcome = Some(acknowledged);
            }
            self.ready.notify_all();
        }
    }

    fn wait(&self, timeout: Duration) -> bool {
        let Ok(outcome) = self.outcome.lock() else {
            return false;
        };
        let Ok((outcome, _)) = self
            .ready
            .wait_timeout_while(outcome, timeout, |outcome| outcome.is_none())
        else {
            return false;
        };
        *outcome == Some(true)
    }
}

#[derive(Default)]
pub struct AgentRuntimeState {
    registry: Mutex<RuntimeRegistry>,
}

#[derive(Default)]
struct RuntimeRegistry {
    active: HashMap<RunKey, ActiveRun>,
    starting: HashMap<RunKey, Option<RunControl>>,
    disconnecting: HashSet<RuntimeId>,
}

#[derive(Default)]
struct AuthInspection {
    authenticated: Option<bool>,
    auth_mode: Option<String>,
    account_label: Option<String>,
    error: Option<String>,
}

pub fn list(app: &tauri::AppHandle) -> Vec<RuntimeStatus> {
    [RuntimeId::Codex, RuntimeId::Claude]
        .into_iter()
        .map(|runtime_id| runtime_status(app, runtime_id))
        .collect()
}

pub fn connect(app: &tauri::AppHandle, runtime_id: RuntimeId) -> Result<ConnectionResult, String> {
    let status = runtime_status(app, runtime_id);
    if !status.installed {
        return Err(status
            .error
            .unwrap_or_else(|| format!("{} is not installed", runtime_id.label())));
    }
    if status.authenticated == Some(true) {
        return Ok(ConnectionResult {
            status,
            message: Some(format!("{} is already connected.", runtime_id.label())),
        });
    }

    let command = match runtime_id {
        RuntimeId::Codex => "codex login --device-auth",
        RuntimeId::Claude => "claude auth login",
    };
    Err(format!(
        "{} sign-in requires an interactive browser flow that Patchdeck cannot safely host yet. Run `{command}` in Terminal, complete sign-in, then refresh Providers.",
        runtime_id.label()
    ))
}

pub fn disconnect(
    app: &tauri::AppHandle,
    state: &AgentRuntimeState,
    runtime_id: RuntimeId,
) -> Result<RuntimeStatus, String> {
    reserve_disconnect(state, runtime_id)?;
    let result = (|| {
        let binary = resolve_binary(app, runtime_id)?;
        let mut command = Command::new(&binary);
        match runtime_id {
            RuntimeId::Codex => {
                command.arg("logout");
            }
            RuntimeId::Claude => {
                command.args(["auth", "logout"]);
            }
        }
        let status = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| {
                format!(
                    "Could not disconnect {} at {}: {error}",
                    runtime_id.label(),
                    binary.display()
                )
            })?;
        if !status.success() {
            return Err(format!(
                "{} did not complete its supported logout command.",
                runtime_id.label()
            ));
        }
        Ok(runtime_status(app, runtime_id))
    })();
    release_disconnect(state, runtime_id);
    result
}

pub fn start(
    app: tauri::AppHandle,
    state: &AgentRuntimeState,
    request: StartRequest,
) -> Result<StartResult, String> {
    validate_request(&request)?;
    let repository = canonical_repository(&request.repository_path)?;
    let key = RunKey {
        runtime_id: request.runtime_id,
        run_id: request.run_id.clone(),
    };
    let reservation_key = key.clone();
    let runtime_id = request.runtime_id;
    reserve_start(state, reservation_key.clone())?;
    let result = match resolve_binary(&app, runtime_id) {
        Ok(binary) => match runtime_id {
            RuntimeId::Codex => start_codex(app, state, key, binary, repository, request),
            RuntimeId::Claude => start_claude(app, state, key, binary, repository, request),
        },
        Err(error) => Err(error),
    };
    if result.is_err() {
        release_start(state, &reservation_key);
    }
    result
}

pub fn stop(state: &AgentRuntimeState, runtime_id: RuntimeId, run_id: &str) -> Result<(), String> {
    validate_run_id(run_id)?;
    let key = RunKey {
        runtime_id,
        run_id: run_id.to_string(),
    };
    enum StopTarget {
        Active {
            cancelled: Arc<AtomicBool>,
            control: RunControl,
        },
        Starting(Option<RunControl>),
    }

    let target = {
        let mut registry = state
            .registry
            .lock()
            .map_err(|_| "Agent runtime state is unavailable".to_string())?;
        if let Some(run) = registry.active.get(&key) {
            StopTarget::Active {
                cancelled: run.cancelled.clone(),
                control: run.control.clone(),
            }
        } else if let Some(control) = registry.starting.remove(&key) {
            StopTarget::Starting(control)
        } else {
            return Err(format!(
                "This run does not have an active {} turn.",
                runtime_id.label()
            ));
        }
    };

    let (cancelled, control) = match target {
        StopTarget::Active { cancelled, control } => (cancelled, control),
        StopTarget::Starting(control) => {
            if let Some(control) = control {
                terminate_control(&control);
            }
            return Ok(());
        }
    };
    cancelled.store(true, Ordering::SeqCst);

    match control {
        RunControl::Codex {
            stdin,
            process,
            interrupt,
            thread_id,
            turn_id,
        } => {
            let interrupted = match (thread_id, turn_id) {
                (Some(thread_id), Some(turn_id)) => {
                    send_codex(
                        &stdin,
                        &json!({
                            "method": "turn/interrupt",
                            "id": CODEX_INTERRUPT_REQUEST_ID,
                            "params": { "threadId": thread_id, "turnId": turn_id }
                        }),
                    )
                    .is_ok()
                        && interrupt.wait(CODEX_INTERRUPT_ACK_TIMEOUT)
                }
                _ => false,
            };
            if !interrupted {
                terminate_process(&process);
            }
            Ok(())
        }
        RunControl::Claude { process } => {
            terminate_process(&process);
            Ok(())
        }
    }
}

fn runtime_status(app: &tauri::AppHandle, runtime_id: RuntimeId) -> RuntimeStatus {
    let binary = match resolve_binary(app, runtime_id) {
        Ok(binary) => binary,
        Err(error) => {
            return RuntimeStatus {
                id: runtime_id,
                label: runtime_id.label(),
                installed: false,
                authenticated: None,
                ready: false,
                version: None,
                path: None,
                auth_mode: None,
                account_label: None,
                error: Some(error),
            }
        }
    };
    let path = Some(binary.to_string_lossy().into_owned());
    let (version, version_error) = inspect_version(&binary, runtime_id);
    let auth = match runtime_id {
        RuntimeId::Codex => inspect_codex_auth(&binary),
        RuntimeId::Claude => inspect_claude_auth(&binary),
    };
    let ready = version.is_some() && auth.authenticated == Some(true);
    RuntimeStatus {
        id: runtime_id,
        label: runtime_id.label(),
        installed: true,
        authenticated: auth.authenticated,
        ready,
        version,
        path,
        auth_mode: auth.auth_mode,
        account_label: auth.account_label,
        error: version_error.or(auth.error),
    }
}

fn inspect_version(path: &Path, runtime_id: RuntimeId) -> (Option<String>, Option<String>) {
    let output = match Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return (
                None,
                Some(format!(
                    "Could not inspect {} at {}: {error}",
                    runtime_id.label(),
                    path.display()
                )),
            )
        }
    };
    if !output.status.success() {
        return (
            None,
            Some(format!(
                "{} is installed but its version command failed.",
                runtime_id.label()
            )),
        );
    }
    let version = first_safe_line(&output.stdout);
    if version.is_empty() {
        (
            None,
            Some(format!(
                "{} is installed but did not report a version.",
                runtime_id.label()
            )),
        )
    } else {
        (Some(version), None)
    }
}

fn inspect_codex_auth(path: &Path) -> AuthInspection {
    let output = match Command::new(path)
        .args(["login", "status"])
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(_) => {
            return AuthInspection {
                error: Some("Codex authentication status could not be verified.".to_string()),
                ..AuthInspection::default()
            }
        }
    };
    parse_codex_auth_status(output.status.success(), &output.stdout, &output.stderr)
}

fn parse_codex_auth_status(success: bool, stdout: &[u8], stderr: &[u8]) -> AuthInspection {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    let combined = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if success {
        let mode = if combined.contains("chatgpt") {
            Some("ChatGPT".to_string())
        } else if combined.contains("api key") || combined.contains("apikey") {
            Some("API key".to_string())
        } else if combined.contains("access token") {
            Some("Access token".to_string())
        } else {
            Some("Codex credentials".to_string())
        };
        return AuthInspection {
            authenticated: Some(true),
            auth_mode: mode.clone(),
            account_label: mode,
            error: None,
        };
    }
    if combined.contains("not logged in") || combined.contains("not authenticated") {
        return AuthInspection {
            authenticated: Some(false),
            ..AuthInspection::default()
        };
    }
    AuthInspection {
        error: Some("Codex authentication status could not be verified.".to_string()),
        ..AuthInspection::default()
    }
}

fn inspect_claude_auth(path: &Path) -> AuthInspection {
    let output = match Command::new(path)
        .args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(_) => {
            return AuthInspection {
                error: Some("Claude Code authentication status could not be verified.".to_string()),
                ..AuthInspection::default()
            }
        }
    };
    parse_claude_auth_status(&output.stdout)
}

fn parse_claude_auth_status(stdout: &[u8]) -> AuthInspection {
    let value: Value = match serde_json::from_slice(stdout) {
        Ok(value) => value,
        Err(_) => {
            return AuthInspection {
                error: Some("Claude Code authentication status could not be verified.".to_string()),
                ..AuthInspection::default()
            }
        }
    };
    let Some(authenticated) = value.get("loggedIn").and_then(Value::as_bool) else {
        return AuthInspection {
            error: Some("Claude Code authentication status could not be verified.".to_string()),
            ..AuthInspection::default()
        };
    };
    let auth_mode = value
        .get("authMethod")
        .and_then(Value::as_str)
        .and_then(safe_label);
    let account_label = value
        .get("subscriptionType")
        .and_then(Value::as_str)
        .and_then(safe_label)
        .or_else(|| {
            value
                .get("apiProvider")
                .and_then(Value::as_str)
                .and_then(safe_label)
        });
    AuthInspection {
        authenticated: Some(authenticated),
        auth_mode,
        account_label,
        error: None,
    }
}

fn start_codex(
    app: tauri::AppHandle,
    state: &AgentRuntimeState,
    key: RunKey,
    binary: PathBuf,
    repository: PathBuf,
    request: StartRequest,
) -> Result<StartResult, String> {
    let mut command = Command::new(&binary);
    command
        .args(["app-server", "--listen", "stdio://"])
        .current_dir(&repository)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_provider_process(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Codex at {}: {error}", binary.display()))?;
    let stdin = match child.stdin.take() {
        Some(stdin) => Arc::new(Mutex::new(stdin)),
        None => {
            terminate_child(&mut child);
            return Err("Could not open Codex input.".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err("Could not open Codex output.".to_string());
        }
    };
    let process = Arc::new(Mutex::new(child));
    let interrupt = Arc::new(CodexInterruptSignal::default());
    let mut reader = BufReader::new(stdout);
    if let Err(error) = attach_starting_control(
        state,
        &key,
        RunControl::Codex {
            stdin: stdin.clone(),
            process: process.clone(),
            interrupt: interrupt.clone(),
            thread_id: None,
            turn_id: None,
        },
    ) {
        terminate_process(&process);
        return Err(error);
    }
    let startup = start_codex_protocol(
        &app,
        &key.run_id,
        &stdin,
        &mut reader,
        &repository,
        &request,
    );
    let (thread_id, turn_id) = match startup {
        Ok(ids) => ids,
        Err(error) => {
            terminate_process(&process);
            return Err(error);
        }
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Err(error) = insert_active(
        state,
        key.clone(),
        ActiveRun {
            cancelled: cancelled.clone(),
            control: RunControl::Codex {
                stdin: stdin.clone(),
                process: process.clone(),
                interrupt: interrupt.clone(),
                thread_id: Some(thread_id.clone()),
                turn_id: Some(turn_id.clone()),
            },
        },
    ) {
        terminate_process(&process);
        return Err(error);
    }

    let reader_app = app.clone();
    std::thread::spawn(move || {
        run_codex_reader(
            &reader_app,
            &key,
            &stdin,
            &process,
            &interrupt,
            &cancelled,
            &mut reader,
        );
        remove_active(&reader_app, &key);
    });

    Ok(StartResult {
        session_id: thread_id,
        turn_id: Some(turn_id),
    })
}

fn start_codex_protocol(
    app: &tauri::AppHandle,
    run_id: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    reader: &mut BufReader<std::process::ChildStdout>,
    repository: &Path,
    request: &StartRequest,
) -> Result<(String, String), String> {
    send_codex(
        stdin,
        &json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "patchdeck_dev",
                    "title": "Patchdeck (Dev)",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;
    read_codex_response(app, run_id, reader, 0)?;
    send_codex(stdin, &json!({ "method": "initialized", "params": {} }))?;

    let thread_request = codex_thread_request(repository, request);
    send_codex(stdin, &thread_request)?;
    let thread_response = read_codex_response(app, run_id, reader, 1)?;
    let thread_id = thread_response
        .pointer("/result/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex did not return a thread ID.".to_string())?
        .to_string();

    send_codex(
        stdin,
        &json!({
            "method": "turn/start",
            "id": 2,
            "params": {
                "threadId": thread_id,
                "input": [{ "type": "text", "text": request.prompt }],
                "cwd": repository.to_string_lossy()
            }
        }),
    )?;
    let turn_response = read_codex_response(app, run_id, reader, 2)?;
    let turn_id = turn_response
        .pointer("/result/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex did not return a turn ID.".to_string())?
        .to_string();
    Ok((thread_id, turn_id))
}

fn codex_thread_request(repository: &Path, request: &StartRequest) -> Value {
    let sandbox = match request.sandbox {
        AgentSandbox::ReadOnly => "read-only",
        AgentSandbox::WorkspaceWrite => "workspace-write",
    };
    let mut params = Map::new();
    params.insert(
        "cwd".to_string(),
        Value::String(repository.to_string_lossy().into_owned()),
    );
    params.insert(
        "approvalPolicy".to_string(),
        Value::String("never".to_string()),
    );
    params.insert("sandbox".to_string(), Value::String(sandbox.to_string()));
    params.insert(
        "serviceName".to_string(),
        Value::String("patchdeck".to_string()),
    );
    if let Some(model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        params.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(instructions) = request
        .instructions
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        params.insert(
            "developerInstructions".to_string(),
            Value::String(instructions.to_string()),
        );
    }
    if let Some(thread_id) = request.session_id.as_deref() {
        params.insert("threadId".to_string(), Value::String(thread_id.to_string()));
        json!({ "method": "thread/resume", "id": 1, "params": params })
    } else {
        json!({ "method": "thread/start", "id": 1, "params": params })
    }
}

fn read_codex_response(
    app: &tauri::AppHandle,
    run_id: &str,
    reader: &mut BufReader<std::process::ChildStdout>,
    expected_id: i64,
) -> Result<Value, String> {
    loop {
        let message = read_protocol_line(reader, "Codex startup")?;
        if message.get("id").and_then(Value::as_i64) == Some(expected_id) {
            if let Some(error) = message.get("error") {
                return Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(safe_provider_message)
                    .unwrap_or_else(|| "Codex returned an unknown startup error.".to_string()));
            }
            return Ok(message);
        }
        emit_codex_message(app, run_id, &message);
    }
}

fn run_codex_reader(
    app: &tauri::AppHandle,
    key: &RunKey,
    stdin: &Arc<Mutex<ChildStdin>>,
    process: &Arc<Mutex<Child>>,
    interrupt: &Arc<CodexInterruptSignal>,
    cancelled: &Arc<AtomicBool>,
    reader: &mut BufReader<std::process::ChildStdout>,
) {
    let mut terminal = false;
    let mut protocol_failed = false;
    loop {
        match read_protocol_line(reader, "Codex") {
            Ok(message) => {
                resolve_codex_interrupt(interrupt, &message);
                if message.get("id").is_some() && message.get("method").is_some() {
                    let _ = reject_codex_server_request(stdin, &message);
                }
                let events = normalize_codex_message(&key.run_id, &message);
                terminal = events.iter().any(|event| {
                    event.event_type == RuntimeEventType::Completed
                        || event.event_type == RuntimeEventType::Error
                });
                for event in events {
                    emit_event(app, event);
                }
                if terminal {
                    break;
                }
            }
            Err(error) if error == "Codex stopped before returning a protocol message." => break,
            Err(error) => {
                emit_event(
                    app,
                    RuntimeEvent::error(RuntimeId::Codex, &key.run_id, error),
                );
                protocol_failed = true;
                break;
            }
        }
    }
    interrupt.resolve(true);
    terminate_process(process);
    if !terminal && !protocol_failed {
        if cancelled.load(Ordering::SeqCst) {
            emit_event(
                app,
                RuntimeEvent::completed(
                    RuntimeId::Codex,
                    &key.run_id,
                    CompletionStatus::Cancelled,
                    None,
                ),
            );
        } else {
            emit_event(
                app,
                RuntimeEvent::error(
                    RuntimeId::Codex,
                    &key.run_id,
                    "Codex stopped before the turn completed.",
                ),
            );
        }
    }
}

fn resolve_codex_interrupt(interrupt: &CodexInterruptSignal, message: &Value) {
    if message.get("method").is_none()
        && message.get("id").and_then(Value::as_i64) == Some(CODEX_INTERRUPT_REQUEST_ID)
    {
        interrupt.resolve(message.get("error").is_none());
    }
}

fn normalize_codex_message(run_id: &str, message: &Value) -> Vec<RuntimeEvent> {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Vec::new();
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    match method {
        "item/agentMessage/delta" => params
            .get("delta")
            .and_then(Value::as_str)
            .filter(|delta| !delta.is_empty())
            .map(|delta| RuntimeEvent::delta(RuntimeId::Codex, run_id, delta.to_string()))
            .into_iter()
            .collect(),
        "item/started" | "item/completed" => codex_item_activity(method, params)
            .map(|activity| RuntimeEvent::activity(RuntimeId::Codex, run_id, activity))
            .into_iter()
            .collect(),
        "turn/completed" => {
            let status = match params.pointer("/turn/status").and_then(Value::as_str) {
                Some("completed") => CompletionStatus::Completed,
                Some("interrupted") | Some("cancelled") => CompletionStatus::Cancelled,
                _ => CompletionStatus::Failed,
            };
            let message = params
                .pointer("/turn/error/message")
                .and_then(Value::as_str)
                .map(safe_provider_message);
            vec![RuntimeEvent::completed(
                RuntimeId::Codex,
                run_id,
                status,
                message,
            )]
        }
        "error" => {
            let will_retry = params.get("willRetry").and_then(Value::as_bool) == Some(true);
            let message = params
                .pointer("/error/message")
                .or_else(|| params.get("message"))
                .and_then(Value::as_str)
                .map(safe_provider_message)
                .unwrap_or_else(|| "Codex reported a provider error.".to_string());
            if will_retry {
                vec![RuntimeEvent::activity(RuntimeId::Codex, run_id, message)]
            } else {
                vec![RuntimeEvent::error(RuntimeId::Codex, run_id, message)]
            }
        }
        "warning" | "configWarning" => vec![RuntimeEvent::activity(
            RuntimeId::Codex,
            run_id,
            "Codex reported a configuration warning.",
        )],
        _ => Vec::new(),
    }
}

fn codex_item_activity(method: &str, params: &Value) -> Option<&'static str> {
    let item_type = params.pointer("/item/type").and_then(Value::as_str)?;
    match (method, item_type) {
        ("item/started", "commandExecution") => Some("Running a command"),
        ("item/completed", "commandExecution") => Some("Command completed"),
        ("item/started", "fileChange") => Some("Updating files"),
        ("item/completed", "fileChange") => Some("File changes completed"),
        ("item/started", "mcpToolCall") => Some("Using a tool"),
        ("item/completed", "mcpToolCall") => Some("Tool call completed"),
        _ => None,
    }
}

fn send_codex(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut input = stdin
        .lock()
        .map_err(|_| "Codex input is unavailable.".to_string())?;
    serde_json::to_writer(&mut *input, message)
        .map_err(|error| format!("Could not encode a Codex request: {error}"))?;
    input
        .write_all(b"\n")
        .and_then(|_| input.flush())
        .map_err(|error| format!("Could not send a request to Codex: {error}"))
}

fn reject_codex_server_request(
    stdin: &Arc<Mutex<ChildStdin>>,
    message: &Value,
) -> Result<(), String> {
    let Some(id) = message.get("id") else {
        return Ok(());
    };
    send_codex(
        stdin,
        &json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": "Patchdeck does not support interactive provider requests for this run"
            }
        }),
    )
}

fn start_claude(
    app: tauri::AppHandle,
    state: &AgentRuntimeState,
    key: RunKey,
    binary: PathBuf,
    repository: PathBuf,
    request: StartRequest,
) -> Result<StartResult, String> {
    let session_id = match request.session_id.as_deref() {
        Some(session_id) => session_id.to_string(),
        None => new_uuid()?,
    };
    let args = claude_args(&request, &session_id);
    let mut command = Command::new(&binary);
    command
        .args(args)
        .current_dir(&repository)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_provider_process(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Could not start Claude Code at {}: {error}",
            binary.display()
        )
    })?;
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            terminate_child(&mut child);
            return Err("Could not open Claude Code input.".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err("Could not open Claude Code output.".to_string());
        }
    };
    let process = Arc::new(Mutex::new(child));
    if let Err(error) = attach_starting_control(
        state,
        &key,
        RunControl::Claude {
            process: process.clone(),
        },
    ) {
        terminate_process(&process);
        return Err(error);
    }
    if let Err(error) = stdin
        .write_all(request.prompt.as_bytes())
        .and_then(|_| stdin.flush())
    {
        terminate_process(&process);
        return Err(format!("Could not send the prompt to Claude Code: {error}"));
    }
    drop(stdin);
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Err(error) = insert_active(
        state,
        key.clone(),
        ActiveRun {
            cancelled: cancelled.clone(),
            control: RunControl::Claude {
                process: process.clone(),
            },
        },
    ) {
        terminate_process(&process);
        return Err(error);
    }

    let reader_app = app.clone();
    std::thread::spawn(move || {
        run_claude_reader(
            &reader_app,
            &key,
            &process,
            &cancelled,
            BufReader::new(stdout),
        );
        remove_active(&reader_app, &key);
    });

    Ok(StartResult {
        session_id,
        turn_id: None,
    })
}

fn claude_args(request: &StartRequest, session_id: &str) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("--print"),
        OsString::from("--input-format"),
        OsString::from("text"),
        OsString::from("--output-format"),
        OsString::from("stream-json"),
        OsString::from("--include-partial-messages"),
        OsString::from("--verbose"),
        OsString::from("--no-chrome"),
        OsString::from("--permission-mode"),
    ];
    match request.sandbox {
        AgentSandbox::ReadOnly => {
            args.push(OsString::from("plan"));
            args.push(OsString::from("--tools"));
            args.push(OsString::from("Read,Glob,Grep"));
            args.push(OsString::from("--disallowedTools"));
            args.push(OsString::from("mcp__*"));
        }
        AgentSandbox::WorkspaceWrite => {
            args.push(OsString::from("acceptEdits"));
        }
    }
    if request.session_id.is_some() {
        args.push(OsString::from("--resume"));
    } else {
        args.push(OsString::from("--session-id"));
    }
    args.push(OsString::from(session_id));
    if let Some(model) = request.model.as_deref().filter(|value| !value.is_empty()) {
        args.push(OsString::from("--model"));
        args.push(OsString::from(model));
    }
    if let Some(instructions) = request
        .instructions
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        args.push(OsString::from("--append-system-prompt"));
        args.push(OsString::from(instructions));
    }
    args
}

fn run_claude_reader(
    app: &tauri::AppHandle,
    key: &RunKey,
    process: &Arc<Mutex<Child>>,
    cancelled: &Arc<AtomicBool>,
    mut reader: BufReader<std::process::ChildStdout>,
) {
    let mut parser = ClaudeParser::default();
    let mut terminal = false;
    let mut protocol_failed = false;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.len() > MAX_PROTOCOL_LINE_BYTES {
                    emit_event(
                        app,
                        RuntimeEvent::error(
                            RuntimeId::Claude,
                            &key.run_id,
                            "Claude Code returned an oversized protocol message.",
                        ),
                    );
                    protocol_failed = true;
                    break;
                }
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(_) => {
                        emit_event(
                            app,
                            RuntimeEvent::error(
                                RuntimeId::Claude,
                                &key.run_id,
                                "Claude Code returned invalid stream data.",
                            ),
                        );
                        protocol_failed = true;
                        break;
                    }
                };
                let events = parser.parse(&key.run_id, &message);
                terminal = events.iter().any(|event| {
                    event.event_type == RuntimeEventType::Completed
                        || event.event_type == RuntimeEventType::Error
                });
                for event in events {
                    emit_event(app, event);
                }
                if terminal {
                    break;
                }
            }
            Err(_) => {
                emit_event(
                    app,
                    RuntimeEvent::error(
                        RuntimeId::Claude,
                        &key.run_id,
                        "Could not read Claude Code output.",
                    ),
                );
                protocol_failed = true;
                break;
            }
        }
    }
    drop(reader);
    let exit_status = if terminal || protocol_failed {
        terminate_process(process);
        None
    } else {
        finish_process(process)
    };
    if !terminal && !protocol_failed {
        if cancelled.load(Ordering::SeqCst) {
            emit_event(
                app,
                RuntimeEvent::completed(
                    RuntimeId::Claude,
                    &key.run_id,
                    CompletionStatus::Cancelled,
                    None,
                ),
            );
        } else {
            let message = exit_status
                .map(claude_exit_message)
                .unwrap_or_else(|| "Claude Code stopped before the turn completed.".to_string());
            emit_event(
                app,
                RuntimeEvent::error(RuntimeId::Claude, &key.run_id, message),
            );
        }
    }
}

#[derive(Default)]
struct ClaudeParser {
    saw_text_delta: bool,
}

impl ClaudeParser {
    fn parse(&mut self, run_id: &str, message: &Value) -> Vec<RuntimeEvent> {
        match message.get("type").and_then(Value::as_str) {
            Some("stream_event") => self.parse_stream_event(run_id, message),
            Some("assistant") => self.parse_assistant(run_id, message),
            Some("result") => self.parse_result(run_id, message),
            _ => Vec::new(),
        }
    }

    fn parse_stream_event(&mut self, run_id: &str, message: &Value) -> Vec<RuntimeEvent> {
        let event = message.get("event").unwrap_or(&Value::Null);
        match event.get("type").and_then(Value::as_str) {
            Some("content_block_delta") => {
                let delta = event
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .filter(|delta| !delta.is_empty());
                if let Some(delta) = delta {
                    self.saw_text_delta = true;
                    vec![RuntimeEvent::delta(
                        RuntimeId::Claude,
                        run_id,
                        delta.to_string(),
                    )]
                } else {
                    Vec::new()
                }
            }
            Some("content_block_start")
                if event.pointer("/content_block/type").and_then(Value::as_str)
                    == Some("tool_use") =>
            {
                vec![RuntimeEvent::activity(
                    RuntimeId::Claude,
                    run_id,
                    "Claude Code is using a tool",
                )]
            }
            _ => Vec::new(),
        }
    }

    fn parse_assistant(&mut self, run_id: &str, message: &Value) -> Vec<RuntimeEvent> {
        if self.saw_text_delta {
            return Vec::new();
        }
        message
            .pointer("/message/content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .map(|text| RuntimeEvent::delta(RuntimeId::Claude, run_id, text.to_string()))
            .collect()
    }

    fn parse_result(&self, run_id: &str, message: &Value) -> Vec<RuntimeEvent> {
        let is_error = message.get("is_error").and_then(Value::as_bool) == Some(true)
            || message.get("subtype").and_then(Value::as_str) != Some("success");
        let status = if is_error {
            CompletionStatus::Failed
        } else {
            CompletionStatus::Completed
        };
        let result_message = if is_error {
            message
                .get("result")
                .and_then(Value::as_str)
                .map(safe_provider_message)
                .or_else(|| Some("Claude Code could not complete the turn.".to_string()))
        } else {
            None
        };
        vec![RuntimeEvent::completed(
            RuntimeId::Claude,
            run_id,
            status,
            result_message,
        )]
    }
}

fn read_protocol_line<R: BufRead>(reader: &mut R, provider: &str) -> Result<Value, String> {
    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .map_err(|_| format!("Could not read {provider} protocol output."))?;
    if bytes == 0 {
        return Err(format!(
            "{provider} stopped before returning a protocol message."
        ));
    }
    if line.len() > MAX_PROTOCOL_LINE_BYTES {
        return Err(format!(
            "{provider} returned an oversized protocol message."
        ));
    }
    serde_json::from_str(&line).map_err(|_| format!("{provider} returned invalid protocol data."))
}

fn validate_request(request: &StartRequest) -> Result<(), String> {
    validate_run_id(&request.run_id)?;
    if request.prompt.trim().is_empty() {
        return Err(format!(
            "The {} prompt cannot be empty.",
            request.runtime_id.label()
        ));
    }
    if request.prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "The {} prompt is larger than 100 KB.",
            request.runtime_id.label()
        ));
    }
    if request.prompt.contains('\0') {
        return Err("The agent prompt contains an invalid null character.".to_string());
    }
    if let Some(instructions) = request.instructions.as_deref() {
        if instructions.len() > MAX_INSTRUCTIONS_BYTES {
            return Err("The execution profile instructions are larger than 100 KB.".to_string());
        }
        if instructions.contains('\0') {
            return Err(
                "The execution profile instructions contain an invalid null character.".to_string(),
            );
        }
    }
    if let Some(model) = request.model.as_deref() {
        validate_model(model)?;
    }
    if let Some(session_id) = request.session_id.as_deref() {
        match request.runtime_id {
            RuntimeId::Codex => validate_codex_session_id(session_id)?,
            RuntimeId::Claude => validate_uuid(session_id)?,
        }
    }
    Ok(())
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("The agent run ID is invalid.".to_string());
    }
    Ok(())
}

fn validate_model(model: &str) -> Result<(), String> {
    if model.len() > 128
        || model.bytes().any(|byte| {
            !(byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/' | b'@'))
        })
    {
        return Err("The agent model identifier is invalid.".to_string());
    }
    Ok(())
}

fn validate_codex_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 512 || session_id.chars().any(char::is_control) {
        return Err("The Codex session ID is invalid.".to_string());
    }
    Ok(())
}

fn validate_uuid(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if valid {
        Ok(())
    } else {
        Err("The Claude Code session ID must be a UUID.".to_string())
    }
}

fn canonical_repository(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || !Path::new(path).is_absolute() {
        return Err("The agent workspace path must be absolute.".to_string());
    }
    let repository = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not open the agent workspace: {error}"))?;
    if !repository.is_dir() {
        return Err("The agent workspace is not a directory.".to_string());
    }
    let repository_path = repository
        .to_str()
        .ok_or_else(|| "The agent workspace path cannot be represented safely.".to_string())?;
    let resolved_root = crate::repository::resolve_root(repository_path)
        .map_err(|error| format!("Could not verify the agent workspace: {error}"))?;
    let resolved_root = std::fs::canonicalize(resolved_root)
        .map_err(|error| format!("Could not verify the agent workspace root: {error}"))?;
    if repository != resolved_root {
        return Err(
            "The agent workspace must be the Git working-tree root selected in Patchdeck."
                .to_string(),
        );
    }
    Ok(resolved_root)
}

fn new_uuid() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_random(&mut bytes).map_err(|error| format!("Could not create a session ID: {error}"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}

fn resolve_binary(app: &tauri::AppHandle, runtime_id: RuntimeId) -> Result<PathBuf, String> {
    let name = runtime_id.binary_name();
    let mut candidates = Vec::new();
    if let Ok(user_home) = app.path().home_dir() {
        candidates.push(user_home.join(".local/bin").join(name));
        candidates.push(user_home.join(".npm-global/bin").join(name));
        candidates.push(user_home.join(".bun/bin").join(name));
        candidates.push(user_home.join("Library/pnpm").join(name));
        match runtime_id {
            RuntimeId::Codex => {
                candidates.push(user_home.join(".codex/packages/standalone/current/bin/codex"))
            }
            RuntimeId::Claude => candidates.push(user_home.join(".claude/local/claude")),
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin").join(name),
        PathBuf::from("/usr/local/bin").join(name),
    ]);
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Ok(path);
    }
    if let Some(path) = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
    {
        return Ok(path);
    }
    Err(format!(
        "{} CLI was not found. Install it or add `{name}` to ~/.local/bin or PATH.",
        runtime_id.label()
    ))
}

fn reserve_start(state: &AgentRuntimeState, key: RunKey) -> Result<(), String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "Agent runtime state is unavailable".to_string())?;
    if registry.disconnecting.contains(&key.runtime_id) {
        return Err(format!(
            "{} is currently disconnecting.",
            key.runtime_id.label()
        ));
    }
    if registry.active.contains_key(&key) || registry.starting.contains_key(&key) {
        return Err(format!(
            "This run already has an active {} turn.",
            key.runtime_id.label()
        ));
    }
    registry.starting.insert(key, None);
    Ok(())
}

fn release_start(state: &AgentRuntimeState, key: &RunKey) {
    if let Ok(mut registry) = state.registry.lock() {
        registry.starting.remove(key);
    }
}

fn attach_starting_control(
    state: &AgentRuntimeState,
    key: &RunKey,
    control: RunControl,
) -> Result<(), String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "Agent runtime state is unavailable".to_string())?;
    let slot = registry
        .starting
        .get_mut(key)
        .ok_or_else(|| "This agent run was cancelled while it was starting.".to_string())?;
    if slot.is_some() {
        return Err("This agent run already has a starting process.".to_string());
    }
    *slot = Some(control);
    Ok(())
}

fn insert_active(state: &AgentRuntimeState, key: RunKey, run: ActiveRun) -> Result<(), String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "Agent runtime state is unavailable".to_string())?;
    if registry.active.contains_key(&key) || registry.starting.remove(&key).is_none() {
        return Err("This agent run changed state while it was starting.".to_string());
    }
    registry.active.insert(key, run);
    Ok(())
}

fn remove_active(app: &tauri::AppHandle, key: &RunKey) {
    if let Ok(mut registry) = app.state::<AgentRuntimeState>().registry.lock() {
        registry.active.remove(key);
    }
}

#[cfg(test)]
fn has_active_run(state: &AgentRuntimeState, runtime_id: RuntimeId) -> Result<bool, String> {
    let registry = state
        .registry
        .lock()
        .map_err(|_| "Agent runtime state is unavailable".to_string())?;
    Ok(registry
        .active
        .keys()
        .chain(registry.starting.keys())
        .any(|key| key.runtime_id == runtime_id))
}

fn reserve_disconnect(state: &AgentRuntimeState, runtime_id: RuntimeId) -> Result<(), String> {
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "Agent runtime state is unavailable".to_string())?;
    if registry.disconnecting.contains(&runtime_id) {
        return Err(format!("{} is already disconnecting.", runtime_id.label()));
    }
    if registry
        .active
        .keys()
        .chain(registry.starting.keys())
        .any(|key| key.runtime_id == runtime_id)
    {
        return Err(format!(
            "Stop active {} runs before disconnecting.",
            runtime_id.label()
        ));
    }
    registry.disconnecting.insert(runtime_id);
    Ok(())
}

fn release_disconnect(state: &AgentRuntimeState, runtime_id: RuntimeId) {
    if let Ok(mut registry) = state.registry.lock() {
        registry.disconnecting.remove(&runtime_id);
    }
}

pub fn shutdown(state: &AgentRuntimeState) {
    let controls = state
        .registry
        .lock()
        .map(|mut registry| drain_registry(&mut registry))
        .unwrap_or_default();
    for control in controls {
        terminate_control(&control);
    }
}

impl Drop for AgentRuntimeState {
    fn drop(&mut self) {
        let controls = self
            .registry
            .get_mut()
            .map(drain_registry)
            .unwrap_or_default();
        for control in controls {
            terminate_control(&control);
        }
    }
}

fn drain_registry(registry: &mut RuntimeRegistry) -> Vec<RunControl> {
    registry.disconnecting.clear();
    let mut controls = registry
        .starting
        .drain()
        .filter_map(|(_, control)| control)
        .collect::<Vec<_>>();
    controls.extend(registry.active.drain().map(|(_, run)| {
        run.cancelled.store(true, Ordering::SeqCst);
        run.control
    }));
    controls
}

fn terminate_control(control: &RunControl) {
    match control {
        RunControl::Codex { process, .. } | RunControl::Claude { process } => {
            terminate_process(process)
        }
    }
}

fn configure_provider_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn terminate_process(process: &Arc<Mutex<Child>>) {
    if let Ok(mut process) = process.lock() {
        terminate_child(&mut process);
    }
}

fn terminate_child(process: &mut Child) {
    #[cfg(unix)]
    {
        let process_group = process.id() as libc::pid_t;
        // SAFETY: provider commands are spawned into a process group whose ID is
        // the direct child's PID. A missing group simply returns ESRCH.
        unsafe {
            libc::killpg(process_group, libc::SIGKILL);
        }
    }
    if process.try_wait().ok().flatten().is_none() {
        let _ = process.kill();
    }
    let _ = process.wait();
}

fn finish_process(process: &Arc<Mutex<Child>>) -> Option<ExitStatus> {
    process.lock().ok()?.wait().ok()
}

fn claude_exit_message(status: ExitStatus) -> String {
    if status.success() {
        "Claude Code stopped before returning a result event.".to_string()
    } else {
        "Claude Code exited before completing the turn.".to_string()
    }
}

fn emit_codex_message(app: &tauri::AppHandle, run_id: &str, message: &Value) {
    for event in normalize_codex_message(run_id, message) {
        emit_event(app, event);
    }
}

fn emit_event(app: &tauri::AppHandle, event: RuntimeEvent) {
    let _ = app.emit(EVENT_NAME, event);
}

fn first_safe_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .next()
        .and_then(safe_label)
        .unwrap_or_default()
}

fn safe_label(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    Some(trimmed.chars().take(160).collect())
}

fn safe_provider_message(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if [
        "api_key",
        "apikey",
        "api key",
        "access_token",
        "access token",
        "authorization:",
        "bearer ",
        "sk-",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return "The provider reported an error containing sensitive authentication details."
            .to_string();
    }
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(1_000)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    static NEXT_REPOSITORY_FIXTURE_ID: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);

    struct RepositoryPathFixture {
        path: PathBuf,
        repository: PathBuf,
        worktree: PathBuf,
    }

    impl RepositoryPathFixture {
        fn new() -> Self {
            let fixture_id = NEXT_REPOSITORY_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "patchdeck-agent-runtime-repository-{}-{timestamp}-{fixture_id}",
                std::process::id()
            ));
            let repository = path.join("repository");
            let worktree = path.join("linked-worktree");
            std::fs::create_dir_all(repository.join("nested")).unwrap();
            std::fs::create_dir_all(path.join("ordinary-directory")).unwrap();

            Self::git(&repository, &["init", "--quiet"]);
            Self::git(&repository, &["config", "user.name", "Patchdeck Tests"]);
            Self::git(
                &repository,
                &["config", "user.email", "tests@example.invalid"],
            );
            std::fs::write(repository.join("README.md"), "fixture\n").unwrap();
            Self::git(&repository, &["add", "README.md"]);
            Self::git(&repository, &["commit", "--quiet", "-m", "fixture"]);
            Self::git(
                &repository,
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "-b",
                    "linked-fixture",
                    worktree.to_str().unwrap(),
                ],
            );

            Self {
                path,
                repository,
                worktree,
            }
        }

        fn git(repository: &Path, args: &[&str]) {
            let output = Command::new("git")
                .arg("--literal-pathspecs")
                .arg("-C")
                .arg(repository)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    impl Drop for RepositoryPathFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[cfg(unix)]
    fn child_is_running(process: &Arc<Mutex<Child>>) -> bool {
        process.lock().unwrap().try_wait().unwrap().is_none()
    }

    #[cfg(unix)]
    fn pid_is_running(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn kill_pid(pid: u32) {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    fn request(runtime_id: RuntimeId, sandbox: AgentSandbox) -> StartRequest {
        StartRequest {
            runtime_id,
            run_id: "run-1234_abcd".to_string(),
            repository_path: "/tmp/project".to_string(),
            prompt: "Implement the card".to_string(),
            session_id: None,
            model: None,
            sandbox,
            instructions: None,
        }
    }

    #[test]
    fn serializes_the_frontend_runtime_contract_in_camel_case() {
        let status = RuntimeStatus {
            id: RuntimeId::Claude,
            label: "Claude Code",
            installed: true,
            authenticated: Some(true),
            ready: true,
            version: Some("2.1.233".to_string()),
            path: Some("/usr/local/bin/claude".to_string()),
            auth_mode: Some("claude.ai".to_string()),
            account_label: Some("max".to_string()),
            error: None,
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["id"], "claude");
        assert_eq!(value["authMode"], "claude.ai");
        assert_eq!(value["accountLabel"], "max");
        assert!(value.get("auth_mode").is_none());

        let event =
            RuntimeEvent::completed(RuntimeId::Codex, "run-1", CompletionStatus::Cancelled, None);
        let event = serde_json::to_value(event).unwrap();
        assert_eq!(event["runtimeId"], "codex");
        assert_eq!(event["type"], "completed");
        assert_eq!(event["status"], "cancelled");
    }

    #[test]
    fn deserializes_and_validates_runtime_requests() {
        let request: StartRequest = serde_json::from_value(json!({
            "runtimeId": "codex",
            "runId": "run-4",
            "repositoryPath": "/tmp/project",
            "prompt": "Review this",
            "sessionId": "thr_123",
            "model": "gpt-5.6-terra",
            "sandbox": "readOnly",
            "instructions": "Do not edit."
        }))
        .unwrap();
        assert_eq!(request.runtime_id, RuntimeId::Codex);
        assert_eq!(request.sandbox, AgentSandbox::ReadOnly);
        assert!(validate_request(&request).is_ok());

        assert!(validate_run_id("../escape").is_err());
        assert!(validate_model("--danger flag").is_err());
        assert!(validate_uuid("not-a-session").is_err());
    }

    #[test]
    fn canonical_repository_rejects_an_ordinary_directory() {
        let fixture = RepositoryPathFixture::new();
        let ordinary = fixture.path.join("ordinary-directory");

        assert!(canonical_repository(ordinary.to_str().unwrap()).is_err());
    }

    #[test]
    fn canonical_repository_rejects_a_git_subdirectory() {
        let fixture = RepositoryPathFixture::new();
        let nested = fixture.repository.join("nested");

        assert!(canonical_repository(nested.to_str().unwrap()).is_err());
    }

    #[test]
    fn canonical_repository_accepts_repository_and_worktree_roots() {
        let fixture = RepositoryPathFixture::new();
        let repository = std::fs::canonicalize(&fixture.repository).unwrap();
        let worktree = std::fs::canonicalize(&fixture.worktree).unwrap();

        assert_eq!(
            canonical_repository(fixture.repository.to_str().unwrap()).unwrap(),
            repository
        );
        assert_eq!(
            canonical_repository(fixture.worktree.to_str().unwrap()).unwrap(),
            worktree
        );
    }

    #[test]
    fn codex_request_preserves_history_model_instructions_and_sandbox() {
        let mut request = request(RuntimeId::Codex, AgentSandbox::ReadOnly);
        request.session_id = Some("thr_existing".to_string());
        request.model = Some("gpt-5.6-terra".to_string());
        request.instructions = Some("Review only.".to_string());
        let message = codex_thread_request(Path::new("/tmp/project"), &request);
        assert_eq!(message["method"], "thread/resume");
        assert_eq!(message["params"]["threadId"], "thr_existing");
        assert_eq!(message["params"]["sandbox"], "read-only");
        assert_eq!(message["params"]["approvalPolicy"], "never");
        assert_eq!(message["params"]["model"], "gpt-5.6-terra");
        assert_eq!(message["params"]["developerInstructions"], "Review only.");
    }

    #[test]
    fn codex_parser_normalizes_deltas_activity_and_completion() {
        let delta = normalize_codex_message(
            "run-1",
            &json!({
                "method": "item/agentMessage/delta",
                "params": { "delta": "Hello" }
            }),
        );
        assert_eq!(delta[0].event_type, RuntimeEventType::AgentDelta);
        assert_eq!(delta[0].delta.as_deref(), Some("Hello"));

        let activity = normalize_codex_message(
            "run-1",
            &json!({
                "method": "item/started",
                "params": { "item": { "type": "commandExecution", "command": "secret" } }
            }),
        );
        assert_eq!(activity[0].message.as_deref(), Some("Running a command"));

        let completed = normalize_codex_message(
            "run-1",
            &json!({
                "method": "turn/completed",
                "params": { "turn": { "status": "interrupted" } }
            }),
        );
        assert_eq!(completed[0].status, Some(CompletionStatus::Cancelled));
    }

    #[test]
    fn claude_args_resume_sessions_and_apply_safe_permission_modes() {
        let mut readonly = request(RuntimeId::Claude, AgentSandbox::ReadOnly);
        readonly.session_id = Some("123e4567-e89b-12d3-a456-426614174000".to_string());
        readonly.model = Some("sonnet".to_string());
        let args = claude_args(&readonly, readonly.session_id.as_deref().unwrap());
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--resume", "123e4567-e89b-12d3-a456-426614174000"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "plan"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--tools", "Read,Glob,Grep"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--disallowedTools", "mcp__*"]));
        assert!(args.windows(2).any(|pair| pair == ["--model", "sonnet"]));

        let writable = request(RuntimeId::Claude, AgentSandbox::WorkspaceWrite);
        let args = claude_args(&writable, "123e4567-e89b-42d3-a456-426614174000");
        let args = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "acceptEdits"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--session-id", "123e4567-e89b-42d3-a456-426614174000"]));
    }

    #[test]
    fn claude_parser_normalizes_stream_events_without_repeating_final_text() {
        let mut parser = ClaudeParser::default();
        let delta = parser.parse(
            "run-2",
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "Working" }
                }
            }),
        );
        assert_eq!(delta[0].delta.as_deref(), Some("Working"));
        let duplicate = parser.parse(
            "run-2",
            &json!({
                "type": "assistant",
                "message": { "content": [{ "type": "text", "text": "Working" }] }
            }),
        );
        assert!(duplicate.is_empty());
        let tool = parser.parse(
            "run-2",
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "content_block": { "type": "tool_use", "name": "Bash" }
                }
            }),
        );
        assert_eq!(tool[0].event_type, RuntimeEventType::Activity);
        let result = parser.parse(
            "run-2",
            &json!({ "type": "result", "subtype": "success", "is_error": false }),
        );
        assert_eq!(result[0].status, Some(CompletionStatus::Completed));
    }

    #[test]
    fn auth_parsers_do_not_return_account_email_or_raw_secrets() {
        let auth = parse_claude_auth_status(
            br#"{"loggedIn":true,"authMethod":"claude.ai","email":"person@example.com","subscriptionType":"max"}"#,
        );
        assert_eq!(auth.authenticated, Some(true));
        assert_eq!(auth.account_label.as_deref(), Some("max"));
        assert_ne!(auth.account_label.as_deref(), Some("person@example.com"));

        let message = safe_provider_message("Authorization: Bearer secret-value");
        assert!(!message.contains("secret-value"));
    }

    #[test]
    fn generated_session_ids_are_valid_v4_uuids() {
        let session_id = new_uuid().unwrap();
        assert!(validate_uuid(&session_id).is_ok());
        assert_eq!(&session_id[14..15], "4");
        assert!(matches!(&session_id[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn startup_reservations_block_duplicate_runs_and_disconnects() {
        let state = AgentRuntimeState::default();
        let key = RunKey {
            runtime_id: RuntimeId::Claude,
            run_id: "run-starting".to_string(),
        };
        assert!(reserve_start(&state, key.clone()).is_ok());
        assert!(reserve_start(&state, key.clone()).is_err());
        assert!(has_active_run(&state, RuntimeId::Claude).unwrap());

        release_start(&state, &key);
        assert!(!has_active_run(&state, RuntimeId::Claude).unwrap());

        assert!(reserve_disconnect(&state, RuntimeId::Claude).is_ok());
        assert!(reserve_start(&state, key.clone()).is_err());
        release_disconnect(&state, RuntimeId::Claude);
        assert!(reserve_start(&state, key.clone()).is_ok());
        release_start(&state, &key);
    }

    #[cfg(unix)]
    #[test]
    fn stop_cancels_a_run_while_its_process_is_still_starting() {
        let state = AgentRuntimeState::default();
        let key = RunKey {
            runtime_id: RuntimeId::Claude,
            run_id: "run-starting-stop".to_string(),
        };
        let child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let process = Arc::new(Mutex::new(child));
        reserve_start(&state, key.clone()).unwrap();
        attach_starting_control(
            &state,
            &key,
            RunControl::Claude {
                process: process.clone(),
            },
        )
        .unwrap();

        let result = stop(&state, RuntimeId::Claude, &key.run_id);
        let still_running = child_is_running(&process);
        terminate_process(&process);

        assert!(
            result.is_ok(),
            "starting run should be stoppable: {result:?}"
        );
        assert!(!still_running, "starting provider process survived stop");
        assert!(!has_active_run(&state, RuntimeId::Claude).unwrap());

        let reserved_key = RunKey {
            runtime_id: RuntimeId::Claude,
            run_id: "run-reserved-stop".to_string(),
        };
        reserve_start(&state, reserved_key.clone()).unwrap();
        assert!(stop(&state, RuntimeId::Claude, &reserved_key.run_id).is_ok());
        assert!(attach_starting_control(
            &state,
            &reserved_key,
            RunControl::Claude {
                process: process.clone(),
            },
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn codex_stop_terminates_when_interrupt_is_never_acknowledged() {
        let state = AgentRuntimeState::default();
        let key = RunKey {
            runtime_id: RuntimeId::Codex,
            run_id: "run-unacknowledged-interrupt".to_string(),
        };
        let mut child = Command::new("sh")
            .args(["-c", "cat >/dev/null"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let process = Arc::new(Mutex::new(child));
        let interrupt = Arc::new(CodexInterruptSignal::default());
        state.registry.lock().unwrap().active.insert(
            key.clone(),
            ActiveRun {
                cancelled: Arc::new(AtomicBool::new(false)),
                control: RunControl::Codex {
                    stdin,
                    process: process.clone(),
                    interrupt,
                    thread_id: Some("thread-1".to_string()),
                    turn_id: Some("turn-1".to_string()),
                },
            },
        );

        let result = stop(&state, RuntimeId::Codex, &key.run_id);
        let still_running = child_is_running(&process);
        terminate_process(&process);

        assert!(result.is_ok(), "Codex stop should succeed: {result:?}");
        assert!(
            !still_running,
            "Codex process survived an unacknowledged interrupt"
        );
    }

    #[test]
    fn codex_interrupt_signal_accepts_only_a_successful_matching_response() {
        let acknowledged = CodexInterruptSignal::default();
        resolve_codex_interrupt(
            &acknowledged,
            &json!({ "id": CODEX_INTERRUPT_REQUEST_ID, "result": {} }),
        );
        assert!(acknowledged.wait(Duration::ZERO));

        let rejected = CodexInterruptSignal::default();
        resolve_codex_interrupt(
            &rejected,
            &json!({ "id": CODEX_INTERRUPT_REQUEST_ID, "error": { "code": -1 } }),
        );
        assert!(!rejected.wait(Duration::ZERO));

        let unrelated = CodexInterruptSignal::default();
        resolve_codex_interrupt(&unrelated, &json!({ "id": 42, "result": {} }));
        assert!(!unrelated.wait(Duration::ZERO));
    }

    #[cfg(unix)]
    #[test]
    fn terminate_process_stops_the_provider_process_group() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_provider_process(&mut command);
        let mut child = command.spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut pid_line = String::new();
        output.read_line(&mut pid_line).unwrap();
        let descendant_pid = pid_line.trim().parse::<u32>().unwrap();
        let process = Arc::new(Mutex::new(child));

        terminate_process(&process);
        let descendant_survived = pid_is_running(descendant_pid);
        if descendant_survived {
            kill_pid(descendant_pid);
        }

        assert!(
            !descendant_survived,
            "provider descendant {descendant_pid} survived cleanup"
        );
    }
}
