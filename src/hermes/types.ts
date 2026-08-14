export type HermesTransportState = "disconnected" | "connecting" | "connected" | "degraded" | "error";

export interface HermesConnectionStatus {
  state: HermesTransportState;
  mode: "managed" | "attached" | null;
  url: string | null;
  version: string | null;
  activeWorkers: number;
  error: string | null;
}

export interface HermesSessionController {
  status: HermesConnectionStatus;
  connectDiscovered: () => Promise<boolean>;
  connectManaged: () => Promise<boolean>;
  connectExisting: (url: string, token: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  refresh: (board?: string) => Promise<void>;
}

export interface HermesBoardMeta {
  slug: string;
  name?: string | null;
  description?: string | null;
  is_current?: boolean;
  total?: number;
  default_workdir?: string | null;
  default_workspace_kind?: "scratch" | "worktree" | "dir" | null;
  project_name?: string | null;
}

export interface HermesBoardsResponse {
  boards: HermesBoardMeta[];
  current: string;
}

export interface HermesProfile {
  name: string;
  is_default: boolean;
  description: string;
  model?: string;
  provider?: string;
}

export interface HermesProfilesResponse {
  profiles: HermesProfile[];
}

export interface HermesTask {
  id: string;
  title: string;
  body?: string | null;
  status: string;
  assignee?: string | null;
  priority?: number;
  latest_summary?: string | null;
  comment_count?: number;
  progress?: { done: number; total: number } | null;
  warnings?: { count: number; highest_severity?: string | null } | null;
  started_at?: number | null;
  worker_pid?: number | null;
  last_heartbeat_at?: number | null;
  workspace_kind?: string | null;
  workspace_path?: string | null;
  branch_name?: string | null;
  skills?: string[] | null;
  created_by?: string | null;
  model_override?: string | null;
  provider_override?: string | null;
}

export interface HermesColumn {
  name: string;
  tasks: HermesTask[];
}

export interface HermesBoard {
  columns: HermesColumn[];
  tenants: string[];
  assignees: string[];
  latest_event_id: number;
  now: number;
}

export interface HermesComment {
  id: number | string;
  author: string;
  body: string;
  created_at: number;
}

export interface HermesEvent {
  id: number;
  kind: string;
  payload: unknown;
  created_at: number;
  run_id?: number | null;
}

export interface HermesRun {
  id: number | string;
  profile?: string | null;
  status: string;
  outcome?: string | null;
  summary?: string | null;
  error?: string | null;
  worker_pid?: number | null;
  started_at?: number | null;
  ended_at?: number | null;
}

export interface HermesTaskDetail {
  task: HermesTask & {
    result?: string | null;
    created_by?: string | null;
    completed_at?: number | null;
    last_failure_error?: string | null;
    diagnostics?: Array<{ severity: string; title: string; detail: string }>;
  };
  comments: HermesComment[];
  events: HermesEvent[];
  attachments: HermesAttachment[];
  runs: HermesRun[];
  links: { parents: string[]; children: string[] };
  child_results: HermesChildResult[];
}

export interface HermesAttachment {
  id: number;
  filename: string;
  size: number;
  content_type?: string | null;
  uploaded_by?: string | null;
  created_at?: number | null;
}

export interface HermesChildResult {
  id: string;
  title: string;
  status: string;
  latest_summary?: string | null;
  result?: string | null;
}

export interface HermesHomeChannel {
  platform: string;
  chat_id: string;
  thread_id: string;
  name: string;
  subscribed: boolean;
}

export interface CreateHermesTaskResponse {
  task: HermesTask | null;
  warning?: string;
}

export interface HermesWorkerLog {
  exists: boolean;
  size_bytes: number;
  content: string;
  truncated: boolean;
}

export interface CreateHermesTask {
  title: string;
  body?: string | null;
  assignee?: string | null;
  triage: boolean;
  priority: number;
  parents?: string[];
  skills?: string[];
  goal_mode?: boolean;
  goal_max_turns?: number | null;
  workspace_kind: "scratch" | "worktree" | "dir";
  workspace_path?: string | null;
}
