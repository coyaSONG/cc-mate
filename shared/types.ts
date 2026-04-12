// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  meta: string | null; // JSON — null for free chat, {task_id, event_type, to_status} for task events
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// --- Task orchestration types ---

export type TaskStatus =
  | "assigned"
  | "in_progress"
  | "awaiting_review"
  | "blocked"
  | "completed"
  | "declined"
  | "cancelled";

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "declined",
  "cancelled",
];

export interface Task {
  id: string;
  orchestrator_id: PeerId;
  worker_id: PeerId;
  title: string;
  description: string;
  status: TaskStatus;
  result_text: string | null;
  artifact_paths: string | null;
  blocker_reason: string | null;
  decline_reason: string | null;
  reject_feedback: string | null;
  assigned_timeout_seconds: number;
  progress_timeout_seconds: number;
  assigned_deadline: string;
  progress_deadline: string;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  id: number;
  task_id: string;
  event_type: string;
  actor_id: string;
  from_status: string | null;
  to_status: string;
  payload: string | null;
  created_at: string;
}

export interface CreateTaskRequest {
  orchestrator_id: PeerId;
  to_id: PeerId;
  title: string;
  description: string;
  assigned_timeout_seconds?: number;
  progress_timeout_seconds?: number;
}

export interface CreateTaskResponse {
  task_id: string;
  status: TaskStatus;
  assigned_deadline: string;
  progress_deadline: string;
}

export interface ListTasksRequest {
  caller_id: PeerId;
  role: "orchestrator" | "worker" | "both";
  status?: TaskStatus;
  include_terminal?: boolean;
}

export interface GetTaskRequest {
  caller_id: PeerId;
  task_id: string;
}

export interface GetTaskResponse {
  task: Task;
  events: TaskEvent[];
}

export interface TaskTransitionRequest {
  caller_id: PeerId;
  task_id: string;
}

export interface DeclineAssignmentRequest extends TaskTransitionRequest {
  reason: string;
}

export interface ReportResultRequest extends TaskTransitionRequest {
  result_text: string;
  artifact_paths?: string[];
}

export interface ReportBlockerRequest extends TaskTransitionRequest {
  reason: string;
}

export interface RejectResultRequest extends TaskTransitionRequest {
  feedback: string;
}

export interface ResumeTaskRequest extends TaskTransitionRequest {
  note?: string;
}

export interface TransitionResponse {
  ok: boolean;
  already_done?: boolean;
  error?: string;
  status_code?: number;
  task?: Task;
}
