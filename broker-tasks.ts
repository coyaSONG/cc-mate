/**
 * cc-mate task engine
 *
 * Provides setupTaskEngine(db) which sets up schema and returns a TaskEngine.
 * Designed to be imported by broker.ts.
 */

import { Database } from "bun:sqlite";
import type {
  MateId,
  Task,
  TaskStatus,
  TaskEvent,
  TransitionResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  ListTasksRequest,
  GetTaskRequest,
  GetTaskResponse,
  TaskTransitionRequest,
  DeclineAssignmentRequest,
  ReportResultRequest,
  ReportBlockerRequest,
  RejectResultRequest,
  ResumeTaskRequest,
} from "./shared/types.ts";

// --- TaskEngine interface ---

export interface TaskEngine {
  handleCreateTask(body: CreateTaskRequest): CreateTaskResponse | { error: string; status_code: number };
  handleListTasks(body: ListTasksRequest): Task[];
  handleGetTask(body: GetTaskRequest): GetTaskResponse | { error: string; status_code: number };
  handleAcceptAssignment(body: TaskTransitionRequest): TransitionResponse;
  handleDeclineAssignment(body: DeclineAssignmentRequest): TransitionResponse;
  handleReportResult(body: ReportResultRequest): TransitionResponse;
  handleReportBlocker(body: ReportBlockerRequest): TransitionResponse;
  handleAcceptResult(body: TaskTransitionRequest): TransitionResponse;
  handleRejectResult(body: RejectResultRequest): TransitionResponse;
  handleResumeTask(body: ResumeTaskRequest): TransitionResponse;
  handleCancelTask(body: TaskTransitionRequest): TransitionResponse;
  checkTaskTimeouts(): void;
  cleanStaleMateTasks(deadMateId: string): void;
}

// --- Setup ---

export function setupTaskEngine(db: Database): TaskEngine {
  // Schema — all idempotent
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      orchestrator_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      result_text TEXT,
      artifact_paths TEXT,
      blocker_reason TEXT,
      decline_reason TEXT,
      reject_feedback TEXT,
      assigned_timeout_seconds INTEGER NOT NULL DEFAULT 300,
      progress_timeout_seconds INTEGER NOT NULL DEFAULT 7200,
      assigned_deadline TEXT NOT NULL,
      progress_deadline TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_worker_status ON tasks(worker_id, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_orchestrator_status ON tasks(orchestrator_id, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_deadline ON tasks(assigned_deadline) WHERE status = 'assigned'`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_progress_deadline ON tasks(progress_deadline) WHERE status = 'in_progress'`);

  db.run(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at)`);

  // Add meta column to messages (idempotent via try-catch)
  try {
    db.run(`ALTER TABLE messages ADD COLUMN meta TEXT`);
  } catch {
    // Column already exists — that's fine
  }

  // --- Prepared statements ---

  const selectTask = db.prepare<Task, [string]>(
    `SELECT * FROM tasks WHERE id = ?`
  );

  const selectTaskEvents = db.prepare<TaskEvent, [string]>(
    `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC`
  );

  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, orchestrator_id, worker_id, title, description, status,
      result_text, artifact_paths, blocker_reason, decline_reason, reject_feedback,
      assigned_timeout_seconds, progress_timeout_seconds,
      assigned_deadline, progress_deadline, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
  `);

  const insertTaskEvent = db.prepare(`
    INSERT INTO task_events (task_id, event_type, actor_id, from_status, to_status, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTaskMessage = db.prepare(`
    INSERT INTO messages (from_id, to_id, text, sent_at, delivered, meta)
    VALUES (?, ?, ?, ?, 0, ?)
  `);

  // --- Helpers ---

  function generateTaskId(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let id = "t_";
    for (let i = 0; i < 8; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
  }

  function getTaskOrError(taskId: string): { task: Task } | { error: string; status_code: 404 } {
    const task = selectTask.get(taskId);
    if (!task) {
      return { error: `Task ${taskId} not found`, status_code: 404 };
    }
    return { task };
  }

  function checkAuth(task: Task, callerId: MateId, role: "orchestrator" | "worker"): string | null {
    if (role === "orchestrator" && task.orchestrator_id !== callerId) {
      return `Caller ${callerId} is not the orchestrator of task ${task.id}`;
    }
    if (role === "worker" && task.worker_id !== callerId) {
      return `Caller ${callerId} is not the worker of task ${task.id}`;
    }
    return null;
  }

  function doTransition(
    task: Task,
    validFromStatuses: TaskStatus[],
    toStatus: TaskStatus,
    actorId: string,
    eventType: string,
    opts: {
      additionalSql?: string;
      additionalParams?: unknown[];
      eventPayload?: Record<string, unknown>;
      notifyToId: string;
      notifyText: string;
    }
  ): TransitionResponse {
    // Idempotency
    if (task.status === toStatus) {
      return { ok: true, already_done: true };
    }

    // Validate from status
    if (!validFromStatuses.includes(task.status as TaskStatus)) {
      return {
        ok: false,
        error: `Cannot transition task ${task.id} from '${task.status}' to '${toStatus}'. Valid from: ${validFromStatuses.join(", ")}`,
        status_code: 409,
      };
    }

    const now = new Date().toISOString();
    const fromStatus = task.status;

    // Build UPDATE sql
    let updateSql = `UPDATE tasks SET status = ?, updated_at = ?`;
    const updateParams: unknown[] = [toStatus, now];

    if (opts.additionalSql) {
      updateSql += `, ${opts.additionalSql}`;
      updateParams.push(...(opts.additionalParams ?? []));
    }

    // WHERE with race-safe status check
    updateSql += ` WHERE id = ? AND status = ?`;
    updateParams.push(task.id, fromStatus);

    const meta = JSON.stringify({
      task_id: task.id,
      event_type: eventType,
      to_status: toStatus,
    });

    const payloadJson = opts.eventPayload ? JSON.stringify(opts.eventPayload) : null;

    // Execute in a single transaction
    try {
      db.transaction(() => {
        const result = db.run(updateSql, updateParams as import("bun:sqlite").SQLQueryBindings[]);
        if (result.changes === 0) {
          throw new Error("concurrent_modification");
        }
        insertTaskEvent.run(task.id, eventType, actorId, fromStatus, toStatus, payloadJson, now);
        insertTaskMessage.run(actorId, opts.notifyToId, opts.notifyText, now, meta);
      })();
    } catch (err) {
      if (err instanceof Error && err.message === "concurrent_modification") {
        return {
          ok: false,
          error: `Concurrent modification detected for task ${task.id}`,
          status_code: 409,
        };
      }
      throw err;
    }

    const updated = selectTask.get(task.id);
    return { ok: true, task: updated! };
  }

  // --- Handlers ---

  function handleCreateTask(
    body: CreateTaskRequest
  ): CreateTaskResponse | { error: string; status_code: number } {
    // Verify worker exists
    const worker = db.query(`SELECT id FROM mates WHERE id = ?`).get(body.to_id) as { id: string } | null;
    if (!worker) {
      return { error: `Worker ${body.to_id} not found`, status_code: 404 };
    }

    const assignedTimeoutSeconds = body.assigned_timeout_seconds ?? 300;
    const progressTimeoutSeconds = body.progress_timeout_seconds ?? 7200;

    const now = new Date();
    const assignedDeadline = new Date(now.getTime() + assignedTimeoutSeconds * 1000).toISOString();
    const progressDeadline = new Date(now.getTime() + progressTimeoutSeconds * 1000).toISOString();
    const nowIso = now.toISOString();

    const taskId = generateTaskId();
    const meta = JSON.stringify({
      task_id: taskId,
      event_type: "created",
      to_status: "assigned",
    });

    const txn = db.transaction(() => {
      insertTask.run(
        taskId,
        body.orchestrator_id,
        body.to_id,
        body.title,
        body.description,
        "assigned",
        assignedTimeoutSeconds,
        progressTimeoutSeconds,
        assignedDeadline,
        progressDeadline,
        nowIso,
        nowIso
      );

      insertTaskEvent.run(
        taskId,
        "created",
        body.orchestrator_id,
        null,        // from_status
        "assigned",  // to_status
        null,        // payload
        nowIso
      );

      const notifyText = [
        `New task assigned: "${body.title}"`,
        `Description: ${body.description}`,
        `Accept by: ${assignedDeadline}`,
        `Complete by: ${progressDeadline}`,
        `Use accept_assignment to take it, or decline_assignment with a reason.`,
      ].join("\n");

      insertTaskMessage.run(
        body.orchestrator_id,
        body.to_id,
        notifyText,
        nowIso,
        meta
      );
    });

    txn();

    return {
      task_id: taskId,
      status: "assigned",
      assigned_deadline: assignedDeadline,
      progress_deadline: progressDeadline,
    };
  }

  function handleListTasks(body: ListTasksRequest): Task[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: unknown[] = [];

    if (body.role === "worker") {
      sql += " AND worker_id = ?";
      params.push(body.caller_id);
    } else if (body.role === "orchestrator") {
      sql += " AND orchestrator_id = ?";
      params.push(body.caller_id);
    } else {
      sql += " AND (worker_id = ? OR orchestrator_id = ?)";
      params.push(body.caller_id, body.caller_id);
    }

    if (body.status) {
      sql += " AND status = ?";
      params.push(body.status);
    } else if (!body.include_terminal) {
      sql += " AND status NOT IN ('completed', 'declined', 'cancelled')";
    }

    sql += " ORDER BY created_at DESC";
    return db.query(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Task[];
  }

  function handleGetTask(
    body: GetTaskRequest
  ): GetTaskResponse | { error: string; status_code: number } {
    const task = selectTask.get(body.task_id);
    if (!task) return { error: "task not found", status_code: 404 };
    const events = selectTaskEvents.all(body.task_id) as TaskEvent[];
    return { task, events };
  }

  function handleAcceptAssignment(body: TaskTransitionRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "worker");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    return doTransition(task, ["assigned"], "in_progress", body.caller_id, "accepted", {
      notifyToId: task.orchestrator_id,
      notifyText: `Task accepted: "${task.title}"`,
    });
  }

  function handleDeclineAssignment(body: DeclineAssignmentRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "worker");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    return doTransition(task, ["assigned"], "declined", body.caller_id, "declined", {
      additionalSql: "decline_reason = ?",
      additionalParams: [body.reason],
      eventPayload: { reason: body.reason },
      notifyToId: task.orchestrator_id,
      notifyText: `Task declined: "${task.title}" — ${body.reason}`,
    });
  }

  function handleReportResult(body: ReportResultRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "worker");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    return doTransition(task, ["in_progress"], "awaiting_review", body.caller_id, "result_reported", {
      additionalSql: "result_text = ?, artifact_paths = ?",
      additionalParams: [body.result_text, body.artifact_paths ? JSON.stringify(body.artifact_paths) : null],
      eventPayload: { result_text: body.result_text },
      notifyToId: task.orchestrator_id,
      notifyText: `Result ready for review on task "${task.title}":\n${body.result_text}`,
    });
  }

  function handleReportBlocker(body: ReportBlockerRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "worker");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    return doTransition(task, ["in_progress"], "blocked", body.caller_id, "blocked", {
      additionalSql: "blocker_reason = ?",
      additionalParams: [body.reason],
      eventPayload: { reason: body.reason },
      notifyToId: task.orchestrator_id,
      notifyText: `Task blocked: "${task.title}" — ${body.reason}`,
    });
  }

  function handleAcceptResult(body: TaskTransitionRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "orchestrator");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    return doTransition(task, ["awaiting_review"], "completed", body.caller_id, "result_accepted", {
      notifyToId: task.worker_id,
      notifyText: `Task completed: "${task.title}"`,
    });
  }

  function handleRejectResult(body: RejectResultRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "orchestrator");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    const newDeadline = new Date(Date.now() + task.progress_timeout_seconds * 1000).toISOString();
    return doTransition(task, ["awaiting_review"], "in_progress", body.caller_id, "result_rejected", {
      additionalSql: "reject_feedback = ?, result_text = NULL, artifact_paths = NULL, progress_deadline = ?",
      additionalParams: [body.feedback, newDeadline],
      eventPayload: { feedback: body.feedback },
      notifyToId: task.worker_id,
      notifyText: `Result rejected for task "${task.title}": ${body.feedback}`,
    });
  }

  function handleResumeTask(body: ResumeTaskRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "orchestrator");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    const newDeadline = new Date(Date.now() + task.progress_timeout_seconds * 1000).toISOString();
    return doTransition(task, ["blocked"], "in_progress", body.caller_id, "resumed", {
      additionalSql: "blocker_reason = NULL, progress_deadline = ?",
      additionalParams: [newDeadline],
      eventPayload: body.note ? { note: body.note } : undefined,
      notifyToId: task.worker_id,
      notifyText: body.note ? `Task resumed: "${task.title}" — ${body.note}` : `Task resumed: "${task.title}"`,
    });
  }

  function handleCancelTask(body: TaskTransitionRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;
    const authErr = checkAuth(task, body.caller_id, "orchestrator");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };
    const nonTerminal: TaskStatus[] = ["assigned", "in_progress", "awaiting_review", "blocked"];
    return doTransition(task, nonTerminal, "cancelled", body.caller_id, "cancelled", {
      notifyToId: task.worker_id,
      notifyText: `Task cancelled: "${task.title}"`,
    });
  }

  function checkTaskTimeouts(): void {
    const now = new Date().toISOString();

    const expiredAssigned = db
      .query(`SELECT * FROM tasks WHERE status = 'assigned' AND assigned_deadline <= ?`)
      .all(now) as Task[];

    for (const task of expiredAssigned) {
      doTransition(task, ["assigned"], "blocked", "broker", "timeout_assigned", {
        additionalSql: "blocker_reason = ?",
        additionalParams: ["assigned timeout"],
        notifyToId: task.orchestrator_id,
        notifyText: `Task timed out (worker did not accept): "${task.title}"`,
      });
    }

    const expiredProgress = db
      .query(`SELECT * FROM tasks WHERE status = 'in_progress' AND progress_deadline <= ?`)
      .all(now) as Task[];

    for (const task of expiredProgress) {
      doTransition(task, ["in_progress"], "blocked", "broker", "timeout_progress", {
        additionalSql: "blocker_reason = ?",
        additionalParams: ["progress timeout"],
        notifyToId: task.orchestrator_id,
        notifyText: `Task timed out (no result): "${task.title}"`,
      });
    }
  }

  function cleanStaleMateTasks(deadMateId: string): void {
    // Worker tasks → blocked
    const workerTasks = db
      .query(`SELECT * FROM tasks WHERE worker_id = ? AND status NOT IN ('completed', 'declined', 'cancelled')`)
      .all(deadMateId) as Task[];

    for (const task of workerTasks) {
      doTransition(task, ["assigned", "in_progress", "awaiting_review", "blocked"], "blocked", "broker", "worker_disconnected", {
        additionalSql: "blocker_reason = ?",
        additionalParams: ["worker disconnected (PID gone)"],
        notifyToId: task.orchestrator_id,
        notifyText: `Worker disconnected for task: "${task.title}"`,
      });
    }

    // Orchestrator tasks → cancelled
    const orchTasks = db
      .query(`SELECT * FROM tasks WHERE orchestrator_id = ? AND status NOT IN ('completed', 'declined', 'cancelled')`)
      .all(deadMateId) as Task[];

    for (const task of orchTasks) {
      doTransition(task, ["assigned", "in_progress", "awaiting_review", "blocked"], "cancelled", "broker", "orchestrator_disconnected", {
        notifyToId: task.worker_id,
        notifyText: `Task cancelled (orchestrator disconnected): "${task.title}"`,
      });
    }
  }

  return {
    handleCreateTask,
    handleListTasks,
    handleGetTask,
    handleAcceptAssignment,
    handleDeclineAssignment,
    handleReportResult,
    handleReportBlocker,
    handleAcceptResult,
    handleRejectResult,
    handleResumeTask,
    handleCancelTask,
    checkTaskTimeouts,
    cleanStaleMateTasks,
  };
}
