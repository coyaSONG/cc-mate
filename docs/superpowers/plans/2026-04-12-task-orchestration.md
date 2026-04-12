# Task Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add task-based orchestration to cc-mate so one Claude Code instance can assign structured tasks to another, track progress, review results, and handle failures.

**Architecture:** New `broker-tasks.ts` module exports a `setupTaskEngine(db)` factory that encapsulates all task DB schema, state machine logic, and handlers. `broker.ts` imports it, wires routes, and hooks into existing intervals. `server.ts` adds 11 new MCP tools and updates channel push to distinguish task events.

**Tech Stack:** Bun, bun:sqlite, @modelcontextprotocol/sdk, bun:test

**Spec:** `docs/superpowers/specs/2026-04-12-cc-mate-task-orchestration-design.md`

---

## File Structure

**Create:**
- `broker-tasks.ts` — Task engine: DB schema, state machine (`doTransition`), 11 handlers, timeout watch, disconnect cleanup. ~350 lines.
- `broker-tasks.test.ts` — Unit tests with in-memory SQLite. Direct function calls, no subprocess.

**Modify:**
- `shared/types.ts` — Add `TaskStatus`, `Task`, `TaskEvent`, and 10 request/response interfaces (~80 lines appended)
- `broker.ts:31-59` — Import `setupTaskEngine`, wire up timeout interval in existing `setInterval` block
- `broker.ts:228-270` — Add 11 new route cases in HTTP switch
- `broker.ts:62-74` — Extend `cleanStaleMates` to call `taskEngine.cleanStaleMateTasks`
- `server.ts:28-33` — Add task type imports
- `server.ts:151-163` — Update MCP instructions string
- `server.ts:169-230` — Add 11 tool definitions to TOOLS array
- `server.ts:238-399` — Add 11 tool handler cases in CallToolRequestSchema switch
- `server.ts:404-449` — Update `pollAndPushMessages` for task event format + retry

**Test:**
- `broker-tasks.test.ts` — Unit: state machine transitions, auth, timeout, idempotency, disconnect
- `broker.test.ts` — Integration: add full task flow tests via HTTP (existing test infrastructure)

---

### Task 1: Add task types to shared/types.ts

**Files:**
- Modify: `shared/types.ts:14-68` (append after existing types)

- [ ] **Step 1: Add task type definitions**

Append to `shared/types.ts` after the existing `PollMessagesResponse` interface:

```ts
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
  orchestrator_id: MateId;
  worker_id: MateId;
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
  orchestrator_id: MateId;
  to_id: MateId;
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
  caller_id: MateId;
  role: "orchestrator" | "worker" | "both";
  status?: TaskStatus;
  include_terminal?: boolean;
}

export interface GetTaskRequest {
  caller_id: MateId;
  task_id: string;
}

export interface GetTaskResponse {
  task: Task;
  events: TaskEvent[];
}

export interface TaskTransitionRequest {
  caller_id: MateId;
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
```

- [ ] **Step 2: Add meta field to Message interface**

In `shared/types.ts`, update the existing `Message` interface:

```ts
export interface Message {
  id: number;
  from_id: MateId;
  to_id: MateId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  meta: string | null; // JSON — null for free chat, {task_id, event_type, to_status} for task events
}
```

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add task orchestration types to shared/types.ts"
```

---

### Task 2: Create broker-tasks.ts — schema + core transition

**Files:**
- Create: `broker-tasks.ts`
- Create: `broker-tasks.test.ts`

- [ ] **Step 1: Write the failing test — schema setup and doTransition**

Create `broker-tasks.test.ts`:

```ts
import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { setupTaskEngine, type TaskEngine } from "./broker-tasks.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE mates (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL,
      git_root TEXT, tty TEXT, summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT NOT NULL,
      sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function addMate(db: Database, id: string, pid = process.pid): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO mates (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, '/tmp/test', NULL, NULL, '', ?, ?)`,
    [id, pid, now, now]
  );
}

let db: Database;
let engine: TaskEngine;

beforeEach(() => {
  db = createTestDb();
  engine = setupTaskEngine(db);
  addMate(db, "orch1");
  addMate(db, "work1");
});

describe("schema setup", () => {
  test("creates tasks table", () => {
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  test("creates task_events table", () => {
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_events'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  test("adds meta column to messages", () => {
    const cols = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "meta")).toBe(true);
  });
});

describe("handleCreateTask", () => {
  test("creates task in assigned status with deadlines", () => {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch1",
      to_id: "work1",
      title: "Fix bug",
      description: "Fix the login bug",
    });
    expect("task_id" in result).toBe(true);
    if (!("task_id" in result)) return;
    expect(result.status).toBe("assigned");
    expect(result.task_id).toMatch(/^t_[a-z0-9]{8}$/);
    expect(result.assigned_deadline).toBeDefined();
    expect(result.progress_deadline).toBeDefined();
  });

  test("records created event", () => {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch1",
      to_id: "work1",
      title: "Fix bug",
      description: "desc",
    });
    if (!("task_id" in result)) return;
    const events = db.query("SELECT * FROM task_events WHERE task_id = ?").all(result.task_id) as Array<{ event_type: string; to_status: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("created");
    expect(events[0].to_status).toBe("assigned");
  });

  test("sends notification message to worker", () => {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch1",
      to_id: "work1",
      title: "Fix bug",
      description: "desc",
    });
    if (!("task_id" in result)) return;
    const msgs = db.query("SELECT * FROM messages WHERE to_id = 'work1'").all() as Array<{ meta: string }>;
    expect(msgs).toHaveLength(1);
    const meta = JSON.parse(msgs[0].meta);
    expect(meta.task_id).toBe(result.task_id);
    expect(meta.event_type).toBe("created");
  });

  test("returns 404 for nonexistent worker", () => {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch1",
      to_id: "nonexistent",
      title: "X",
      description: "Y",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.status_code).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test broker-tasks.test.ts
```

Expected: FAIL — `broker-tasks.ts` does not exist yet.

- [ ] **Step 3: Implement broker-tasks.ts — schema + helpers + handleCreateTask**

Create `broker-tasks.ts`:

```ts
import { Database } from "bun:sqlite";
import type {
  Task,
  TaskEvent,
  TaskStatus,
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
  TransitionResponse,
} from "./shared/types.ts";

function generateTaskId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "t_";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

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

export function setupTaskEngine(db: Database): TaskEngine {
  // --- Schema ---

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

  // Add meta column to messages (idempotent)
  try {
    db.run(`ALTER TABLE messages ADD COLUMN meta TEXT`);
  } catch {
    // Column already exists
  }

  // --- Prepared statements ---

  const selectTask = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
  const selectTaskEvents = db.prepare(
    `SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC`
  );
  const insertTask = db.prepare(`
    INSERT INTO tasks (id, orchestrator_id, worker_id, title, description, status,
      assigned_timeout_seconds, progress_timeout_seconds,
      assigned_deadline, progress_deadline, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?)
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

  function getTaskOrError(
    taskId: string
  ): { task: Task } | { error: string; status_code: number } {
    const task = selectTask.get(taskId) as Task | null;
    if (!task) return { error: "task not found", status_code: 404 };
    return { task };
  }

  function checkAuth(
    task: Task,
    callerId: string,
    role: "worker" | "orchestrator"
  ): string | null {
    if (role === "worker" && task.worker_id !== callerId) return "not authorized";
    if (role === "orchestrator" && task.orchestrator_id !== callerId) return "not authorized";
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
    if ((task.status as TaskStatus) === toStatus) {
      return { ok: true, already_done: true };
    }

    if (!validFromStatuses.includes(task.status as TaskStatus)) {
      return {
        ok: false,
        error: `invalid transition from ${task.status} to ${toStatus}`,
        status_code: 409,
      };
    }

    const now = new Date().toISOString();

    db.transaction(() => {
      let sql = `UPDATE tasks SET status = ?, updated_at = ?`;
      const params: unknown[] = [toStatus, now];

      if (opts.additionalSql) {
        sql += `, ${opts.additionalSql}`;
        params.push(...(opts.additionalParams ?? []));
      }

      sql += ` WHERE id = ? AND status = ?`;
      params.push(task.id, task.status);

      const result = db.run(sql, params);
      if (result.changes === 0) {
        throw new Error("concurrent modification");
      }

      insertTaskEvent.run(
        task.id,
        eventType,
        actorId,
        task.status,
        toStatus,
        opts.eventPayload ? JSON.stringify(opts.eventPayload) : null,
        now
      );

      const meta = JSON.stringify({
        task_id: task.id,
        event_type: eventType,
        to_status: toStatus,
      });
      insertTaskMessage.run(actorId, opts.notifyToId, opts.notifyText, now, meta);
    })();

    const updated = selectTask.get(task.id) as Task;
    return { ok: true, task: updated };
  }

  // --- Handlers ---

  function handleCreateTask(
    body: CreateTaskRequest
  ): CreateTaskResponse | { error: string; status_code: number } {
    const worker = db
      .query("SELECT id FROM mates WHERE id = ?")
      .get(body.to_id) as { id: string } | null;
    if (!worker) return { error: `Mate ${body.to_id} not found`, status_code: 404 };

    const id = generateTaskId();
    const now = new Date().toISOString();
    const assignedTimeout = body.assigned_timeout_seconds ?? 300;
    const progressTimeout = body.progress_timeout_seconds ?? 7200;
    const assignedDeadline = new Date(
      Date.now() + assignedTimeout * 1000
    ).toISOString();
    const progressDeadline = new Date(
      Date.now() + progressTimeout * 1000
    ).toISOString();

    db.transaction(() => {
      insertTask.run(
        id,
        body.orchestrator_id,
        body.to_id,
        body.title,
        body.description,
        assignedTimeout,
        progressTimeout,
        assignedDeadline,
        progressDeadline,
        now,
        now
      );

      insertTaskEvent.run(
        id,
        "created",
        body.orchestrator_id,
        null,
        "assigned",
        null,
        now
      );

      const meta = JSON.stringify({
        task_id: id,
        event_type: "created",
        to_status: "assigned",
      });
      const notifyText = [
        `New task assigned: "${body.title}"`,
        `Description: ${body.description}`,
        `Accept by: ${assignedDeadline}`,
        `Complete by: ${progressDeadline}`,
        `Use accept_assignment to take it, or decline_assignment with a reason.`,
      ].join("\n");
      insertTaskMessage.run(body.orchestrator_id, body.to_id, notifyText, now, meta);
    })();

    return {
      task_id: id,
      status: "assigned",
      assigned_deadline: assignedDeadline,
      progress_deadline: progressDeadline,
    };
  }

  // Placeholder handlers — implemented in Tasks 3-6
  function handleAcceptAssignment(body: TaskTransitionRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleDeclineAssignment(body: DeclineAssignmentRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleReportResult(body: ReportResultRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleReportBlocker(body: ReportBlockerRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleAcceptResult(body: TaskTransitionRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleRejectResult(body: RejectResultRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleResumeTask(body: ResumeTaskRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleCancelTask(body: TaskTransitionRequest): TransitionResponse {
    return { ok: false, error: "not implemented", status_code: 501 };
  }
  function handleListTasks(body: ListTasksRequest): Task[] {
    return [];
  }
  function handleGetTask(
    body: GetTaskRequest
  ): GetTaskResponse | { error: string; status_code: number } {
    return { error: "not implemented", status_code: 501 };
  }
  function checkTaskTimeouts(): void {}
  function cleanStaleMateTasks(deadMateId: string): void {}

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test broker-tasks.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add broker-tasks.ts broker-tasks.test.ts
git commit -m "feat: task engine core — schema, doTransition, handleCreateTask"
```

---

### Task 3: Worker transition handlers — accept, decline

**Files:**
- Modify: `broker-tasks.test.ts`
- Modify: `broker-tasks.ts`

- [ ] **Step 1: Write the failing tests**

Append to `broker-tasks.test.ts`:

```ts
describe("handleAcceptAssignment", () => {
  test("assigned → in_progress", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    const result = engine.handleAcceptAssignment({
      caller_id: "work1", task_id: created.task_id,
    });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("in_progress");
  });

  test("rejects if caller is not the worker", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    const result = engine.handleAcceptAssignment({
      caller_id: "orch1", task_id: created.task_id,
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(403);
  });

  test("idempotent — already in_progress returns already_done", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    const result = engine.handleAcceptAssignment({
      caller_id: "work1", task_id: created.task_id,
    });
    expect(result.ok).toBe(true);
    expect(result.already_done).toBe(true);
  });

  test("sends notification to orchestrator", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });

    const msgs = db.query(
      "SELECT * FROM messages WHERE to_id = 'orch1' AND meta IS NOT NULL"
    ).all() as Array<{ meta: string }>;
    const taskMsgs = msgs.filter((m) => {
      const meta = JSON.parse(m.meta);
      return meta.task_id === created.task_id && meta.event_type === "accepted";
    });
    expect(taskMsgs).toHaveLength(1);
  });
});

describe("handleDeclineAssignment", () => {
  test("assigned → declined with reason", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    const result = engine.handleDeclineAssignment({
      caller_id: "work1", task_id: created.task_id, reason: "too busy",
    });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("declined");

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.decline_reason).toBe("too busy");
  });

  test("rejects from non-assigned state", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    const result = engine.handleDeclineAssignment({
      caller_id: "work1", task_id: created.task_id, reason: "nope",
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });

  test("terminal state rejects further transitions", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    engine.handleDeclineAssignment({ caller_id: "work1", task_id: created.task_id, reason: "no" });
    const result = engine.handleAcceptAssignment({
      caller_id: "work1", task_id: created.task_id,
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test broker-tasks.test.ts
```

Expected: New tests FAIL with "not implemented".

- [ ] **Step 3: Implement handleAcceptAssignment and handleDeclineAssignment**

In `broker-tasks.ts`, replace the placeholder `handleAcceptAssignment`:

```ts
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
```

Replace the placeholder `handleDeclineAssignment`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test broker-tasks.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add broker-tasks.ts broker-tasks.test.ts
git commit -m "feat: accept_assignment and decline_assignment handlers"
```

---

### Task 4: Worker action handlers — report_result, report_blocker

**Files:**
- Modify: `broker-tasks.test.ts`
- Modify: `broker-tasks.ts`

- [ ] **Step 1: Write the failing tests**

Append to `broker-tasks.test.ts`:

```ts
describe("handleReportResult", () => {
  function createAndAccept(): string {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    return created.task_id;
  }

  test("in_progress → awaiting_review", () => {
    const taskId = createAndAccept();
    const result = engine.handleReportResult({
      caller_id: "work1", task_id: taskId, result_text: "Done. Fixed the bug.",
    });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("awaiting_review");

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task;
    expect(task.result_text).toBe("Done. Fixed the bug.");
  });

  test("stores artifact_paths as JSON", () => {
    const taskId = createAndAccept();
    engine.handleReportResult({
      caller_id: "work1", task_id: taskId,
      result_text: "Done", artifact_paths: ["src/fix.ts", "tests/fix.test.ts"],
    });
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task;
    expect(JSON.parse(task.artifact_paths!)).toEqual(["src/fix.ts", "tests/fix.test.ts"]);
  });

  test("rejects from assigned state", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    const result = engine.handleReportResult({
      caller_id: "work1", task_id: created.task_id, result_text: "Done",
    });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });
});

describe("handleReportBlocker", () => {
  test("in_progress → blocked", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });

    const result = engine.handleReportBlocker({
      caller_id: "work1", task_id: created.task_id, reason: "Need API key",
    });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("blocked");

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.blocker_reason).toBe("Need API key");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test broker-tasks.test.ts
```

Expected: New tests FAIL.

- [ ] **Step 3: Implement handleReportResult and handleReportBlocker**

In `broker-tasks.ts`, replace the placeholders:

```ts
  function handleReportResult(body: ReportResultRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;

    const authErr = checkAuth(task, body.caller_id, "worker");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };

    return doTransition(task, ["in_progress"], "awaiting_review", body.caller_id, "result_reported", {
      additionalSql: "result_text = ?, artifact_paths = ?",
      additionalParams: [
        body.result_text,
        body.artifact_paths ? JSON.stringify(body.artifact_paths) : null,
      ],
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test broker-tasks.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add broker-tasks.ts broker-tasks.test.ts
git commit -m "feat: report_result and report_blocker handlers"
```

---

### Task 5: Orchestrator action handlers — accept_result, reject_result, resume, cancel

**Files:**
- Modify: `broker-tasks.test.ts`
- Modify: `broker-tasks.ts`

- [ ] **Step 1: Write the failing tests**

Append to `broker-tasks.test.ts`:

```ts
describe("handleAcceptResult", () => {
  function createAcceptReport(): string {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    engine.handleReportResult({
      caller_id: "work1", task_id: created.task_id, result_text: "Done",
    });
    return created.task_id;
  }

  test("awaiting_review → completed", () => {
    const taskId = createAcceptReport();
    const result = engine.handleAcceptResult({ caller_id: "orch1", task_id: taskId });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("completed");
  });

  test("completed is terminal — cannot cancel", () => {
    const taskId = createAcceptReport();
    engine.handleAcceptResult({ caller_id: "orch1", task_id: taskId });
    const result = engine.handleCancelTask({ caller_id: "orch1", task_id: taskId });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });
});

describe("handleRejectResult", () => {
  function createAcceptReport(): string {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
      progress_timeout_seconds: 7200,
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    engine.handleReportResult({
      caller_id: "work1", task_id: created.task_id, result_text: "Draft",
    });
    return created.task_id;
  }

  test("awaiting_review → in_progress with feedback, clears result, resets deadline", () => {
    const taskId = createAcceptReport();
    const before = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task;

    const result = engine.handleRejectResult({
      caller_id: "orch1", task_id: taskId, feedback: "Need more tests",
    });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("in_progress");

    const after = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task;
    expect(after.reject_feedback).toBe("Need more tests");
    expect(after.result_text).toBeNull();
    expect(after.artifact_paths).toBeNull();
    expect(after.progress_deadline > before.progress_deadline).toBe(true);
  });
});

describe("handleResumeTask", () => {
  test("blocked → in_progress, resets progress_deadline", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    engine.handleReportBlocker({
      caller_id: "work1", task_id: created.task_id, reason: "stuck",
    });

    const result = engine.handleResumeTask({
      caller_id: "orch1", task_id: created.task_id, note: "Try approach B",
    });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("in_progress");

    const events = db.query(
      "SELECT * FROM task_events WHERE task_id = ? AND event_type = 'resumed'"
    ).all(created.task_id) as TaskEvent[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload!);
    expect(payload.note).toBe("Try approach B");
  });
});

describe("handleCancelTask", () => {
  test("cancels from assigned", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    const result = engine.handleCancelTask({ caller_id: "orch1", task_id: created.task_id });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("cancelled");
  });

  test("cancels from in_progress", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    const result = engine.handleCancelTask({ caller_id: "orch1", task_id: created.task_id });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("cancelled");
  });

  test("cancels from blocked", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    engine.handleReportBlocker({ caller_id: "work1", task_id: created.task_id, reason: "x" });
    const result = engine.handleCancelTask({ caller_id: "orch1", task_id: created.task_id });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("cancelled");
  });

  test("rejects from completed (terminal)", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    engine.handleReportResult({ caller_id: "work1", task_id: created.task_id, result_text: "X" });
    engine.handleAcceptResult({ caller_id: "orch1", task_id: created.task_id });

    const result = engine.handleCancelTask({ caller_id: "orch1", task_id: created.task_id });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });

  test("only orchestrator can cancel", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    const result = engine.handleCancelTask({ caller_id: "work1", task_id: created.task_id });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test broker-tasks.test.ts
```

Expected: New tests FAIL.

- [ ] **Step 3: Implement all four orchestrator handlers**

In `broker-tasks.ts`, replace the four placeholders:

```ts
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

    const newDeadline = new Date(
      Date.now() + task.progress_timeout_seconds * 1000
    ).toISOString();

    return doTransition(task, ["awaiting_review"], "in_progress", body.caller_id, "result_rejected", {
      additionalSql:
        "reject_feedback = ?, result_text = NULL, artifact_paths = NULL, progress_deadline = ?",
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

    const newDeadline = new Date(
      Date.now() + task.progress_timeout_seconds * 1000
    ).toISOString();

    return doTransition(task, ["blocked"], "in_progress", body.caller_id, "resumed", {
      additionalSql: "blocker_reason = NULL, progress_deadline = ?",
      additionalParams: [newDeadline],
      eventPayload: body.note ? { note: body.note } : undefined,
      notifyToId: task.worker_id,
      notifyText: body.note
        ? `Task resumed: "${task.title}" — ${body.note}`
        : `Task resumed: "${task.title}"`,
    });
  }

  function handleCancelTask(body: TaskTransitionRequest): TransitionResponse {
    const lookup = getTaskOrError(body.task_id);
    if ("error" in lookup) return { ok: false, ...lookup };
    const { task } = lookup;

    const authErr = checkAuth(task, body.caller_id, "orchestrator");
    if (authErr) return { ok: false, error: authErr, status_code: 403 };

    const nonTerminal: TaskStatus[] = [
      "assigned", "in_progress", "awaiting_review", "blocked",
    ];

    return doTransition(task, nonTerminal, "cancelled", body.caller_id, "cancelled", {
      notifyToId: task.worker_id,
      notifyText: `Task cancelled: "${task.title}"`,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test broker-tasks.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add broker-tasks.ts broker-tasks.test.ts
git commit -m "feat: orchestrator handlers — accept/reject result, resume, cancel"
```

---

### Task 6: Query handlers + timeout + disconnect

**Files:**
- Modify: `broker-tasks.test.ts`
- Modify: `broker-tasks.ts`

- [ ] **Step 1: Write the failing tests**

Append to `broker-tasks.test.ts`:

```ts
describe("handleListTasks", () => {
  test("filters by worker role", () => {
    engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "A", description: "D",
    });
    const tasks = engine.handleListTasks({
      caller_id: "work1", role: "worker",
    });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((t) => t.worker_id === "work1")).toBe(true);
  });

  test("filters by orchestrator role", () => {
    engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "A", description: "D",
    });
    const tasks = engine.handleListTasks({
      caller_id: "orch1", role: "orchestrator",
    });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((t) => t.orchestrator_id === "orch1")).toBe(true);
  });

  test("excludes terminal by default", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "A", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleDeclineAssignment({ caller_id: "work1", task_id: created.task_id, reason: "no" });

    const tasks = engine.handleListTasks({ caller_id: "work1", role: "worker" });
    expect(tasks.every((t) => t.status !== "declined")).toBe(true);
  });

  test("includes terminal when requested", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "Declined", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleDeclineAssignment({ caller_id: "work1", task_id: created.task_id, reason: "no" });

    const tasks = engine.handleListTasks({
      caller_id: "work1", role: "worker", include_terminal: true,
    });
    expect(tasks.some((t) => t.status === "declined")).toBe(true);
  });
});

describe("handleGetTask", () => {
  test("returns task with events", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });

    const result = engine.handleGetTask({ caller_id: "work1", task_id: created.task_id });
    expect("task" in result).toBe(true);
    if (!("task" in result)) return;
    expect(result.task.status).toBe("in_progress");
    expect(result.events.length).toBeGreaterThanOrEqual(2); // created + accepted
  });

  test("returns 404 for nonexistent task", () => {
    const result = engine.handleGetTask({ caller_id: "work1", task_id: "t_nonexist" });
    expect("error" in result).toBe(true);
  });
});

describe("checkTaskTimeouts", () => {
  test("assigned timeout → blocked", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
      assigned_timeout_seconds: 0, // expires immediately
    });
    if (!("task_id" in created)) throw new Error("create failed");

    engine.checkTaskTimeouts();

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.status).toBe("blocked");
    expect(task.blocker_reason).toBe("assigned timeout");
  });

  test("progress timeout → blocked", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
      progress_timeout_seconds: 0,
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });

    engine.checkTaskTimeouts();

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.status).toBe("blocked");
    expect(task.blocker_reason).toBe("progress timeout");
  });

  test("does not affect non-expired tasks", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
      assigned_timeout_seconds: 99999,
    });
    if (!("task_id" in created)) throw new Error("create failed");

    engine.checkTaskTimeouts();

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.status).toBe("assigned");
  });
});

describe("cleanStaleMateTasks", () => {
  test("worker death → tasks blocked", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });

    engine.cleanStaleMateTasks("work1");

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.status).toBe("blocked");
    expect(task.blocker_reason).toContain("worker disconnected");
  });

  test("orchestrator death → tasks cancelled", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    engine.cleanStaleMateTasks("orch1");

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.status).toBe("cancelled");
  });

  test("skips terminal tasks", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleDeclineAssignment({ caller_id: "work1", task_id: created.task_id, reason: "no" });

    // Should not throw or change anything
    engine.cleanStaleMateTasks("work1");

    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as Task;
    expect(task.status).toBe("declined"); // unchanged
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test broker-tasks.test.ts
```

Expected: New tests FAIL.

- [ ] **Step 3: Implement query handlers, timeout, and disconnect**

In `broker-tasks.ts`, replace the remaining placeholders:

```ts
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
    return db.query(sql).all(...params) as Task[];
  }

  function handleGetTask(
    body: GetTaskRequest
  ): GetTaskResponse | { error: string; status_code: number } {
    const task = selectTask.get(body.task_id) as Task | null;
    if (!task) return { error: "task not found", status_code: 404 };

    const events = selectTaskEvents.all(body.task_id) as TaskEvent[];
    return { task, events };
  }

  function checkTaskTimeouts(): void {
    const now = new Date().toISOString();

    const expiredAssigned = db
      .query(`SELECT * FROM tasks WHERE status = 'assigned' AND assigned_deadline < ?`)
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
      .query(`SELECT * FROM tasks WHERE status = 'in_progress' AND progress_deadline < ?`)
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
      .query(
        `SELECT * FROM tasks WHERE worker_id = ? AND status NOT IN ('completed', 'declined', 'cancelled')`
      )
      .all(deadMateId) as Task[];

    for (const task of workerTasks) {
      doTransition(
        task,
        ["assigned", "in_progress", "awaiting_review", "blocked"],
        "blocked",
        "broker",
        "worker_disconnected",
        {
          additionalSql: "blocker_reason = ?",
          additionalParams: ["worker disconnected (PID gone)"],
          notifyToId: task.orchestrator_id,
          notifyText: `Worker disconnected for task: "${task.title}"`,
        }
      );
    }

    // Orchestrator tasks → cancelled
    const orchTasks = db
      .query(
        `SELECT * FROM tasks WHERE orchestrator_id = ? AND status NOT IN ('completed', 'declined', 'cancelled')`
      )
      .all(deadMateId) as Task[];

    for (const task of orchTasks) {
      doTransition(
        task,
        ["assigned", "in_progress", "awaiting_review", "blocked"],
        "cancelled",
        "broker",
        "orchestrator_disconnected",
        {
          notifyToId: task.worker_id,
          notifyText: `Task cancelled (orchestrator disconnected): "${task.title}"`,
        }
      );
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test broker-tasks.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add broker-tasks.ts broker-tasks.test.ts
git commit -m "feat: list/get tasks, timeout watch, disconnect cleanup"
```

---

### Task 7: Wire broker routes

**Files:**
- Modify: `broker.ts`

- [ ] **Step 1: Add import and setup at top of broker.ts**

After the existing `import type { ... } from "./shared/types.ts";` line (line 13-24), add:

```ts
import { setupTaskEngine } from "./broker-tasks.ts";
```

After `cleanStaleMates();` (line 76), add:

```ts
const taskEngine = setupTaskEngine(db);
```

- [ ] **Step 2: Extend cleanStaleMates to handle task cleanup**

In the `cleanStaleMates` function (lines 62-74), before the `db.run("DELETE FROM mates ...")` line, add task cleanup:

```ts
function cleanStaleMates() {
  const mates = db.query("SELECT id, pid FROM mates").all() as { id: string; pid: number }[];
  for (const mate of mates) {
    try {
      process.kill(mate.pid, 0);
    } catch {
      // Process doesn't exist — clean up tasks before removing mate
      taskEngine.cleanStaleMateTasks(mate.id);
      db.run("DELETE FROM mates WHERE id = ?", [mate.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [mate.id]);
    }
  }
}
```

Note: `taskEngine` is referenced before its declaration here. Move `const taskEngine = setupTaskEngine(db);` to BEFORE `cleanStaleMates()` call, and move the function declaration before it too. The result:

```ts
const taskEngine = setupTaskEngine(db);

function cleanStaleMates() { /* with taskEngine.cleanStaleMateTasks */ }
cleanStaleMates();
setInterval(cleanStaleMates, 30_000);
```

- [ ] **Step 3: Add timeout interval**

After the existing `setInterval(cleanStaleMates, 30_000);` line, add:

```ts
setInterval(() => taskEngine.checkTaskTimeouts(), 30_000);
```

- [ ] **Step 4: Add 11 task routes to the HTTP switch**

In the `Bun.serve` fetch handler's switch statement (lines 245-264), before `default:`, add:

```ts
        case "/create-task": {
          const result = taskEngine.handleCreateTask(body);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status_code });
          }
          return Response.json(result);
        }
        case "/list-tasks":
          return Response.json(taskEngine.handleListTasks(body));
        case "/get-task": {
          const result = taskEngine.handleGetTask(body);
          if ("error" in result) {
            return Response.json({ error: result.error }, { status: result.status_code });
          }
          return Response.json(result);
        }
        case "/accept-assignment": {
          const result = taskEngine.handleAcceptAssignment(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
        case "/decline-assignment": {
          const result = taskEngine.handleDeclineAssignment(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
        case "/report-result": {
          const result = taskEngine.handleReportResult(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
        case "/report-blocker": {
          const result = taskEngine.handleReportBlocker(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
        case "/accept-result": {
          const result = taskEngine.handleAcceptResult(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
        case "/reject-result": {
          const result = taskEngine.handleRejectResult(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
        case "/resume-task": {
          const result = taskEngine.handleResumeTask(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
        case "/cancel-task": {
          const result = taskEngine.handleCancelTask(body);
          if (!result.ok) {
            return Response.json({ error: result.error }, { status: result.status_code ?? 500 });
          }
          return Response.json(result);
        }
```

- [ ] **Step 5: Run existing + new tests**

```bash
bun test broker.test.ts
```

Expected: All existing tests still PASS. (Task-specific integration tests added in next step.)

- [ ] **Step 6: Add integration test — happy path via HTTP**

Append to `broker.test.ts`:

```ts
describe("task orchestration — happy path", () => {
  test("create → accept → report → accept_result → completed", async () => {
    const orch = await register({ pid: process.pid, cwd: "/tmp/orch" });
    const child = Bun.spawn(["sleep", "30"]);
    const worker = await register({ pid: child.pid, cwd: "/tmp/worker" });

    try {
      // Create task
      const created = await post("/create-task", {
        orchestrator_id: orch.id,
        to_id: worker.id,
        title: "Fix bug",
        description: "Fix the login bug",
      }) as { task_id: string; status: string };
      expect(created.task_id).toMatch(/^t_/);
      expect(created.status).toBe("assigned");

      // Worker accepts
      const accepted = await post("/accept-assignment", {
        caller_id: worker.id,
        task_id: created.task_id,
      }) as { ok: boolean; task: { status: string } };
      expect(accepted.ok).toBe(true);
      expect(accepted.task.status).toBe("in_progress");

      // Worker reports result
      const reported = await post("/report-result", {
        caller_id: worker.id,
        task_id: created.task_id,
        result_text: "Bug fixed in login.ts",
      }) as { ok: boolean; task: { status: string } };
      expect(reported.ok).toBe(true);
      expect(reported.task.status).toBe("awaiting_review");

      // Orchestrator accepts result
      const completed = await post("/accept-result", {
        caller_id: orch.id,
        task_id: created.task_id,
      }) as { ok: boolean; task: { status: string } };
      expect(completed.ok).toBe(true);
      expect(completed.task.status).toBe("completed");

      // Notification messages were sent
      const workerMsgs = await post("/poll-messages", { id: worker.id }) as { messages: Array<{ meta: string }> };
      const taskMsgs = workerMsgs.messages.filter((m) => m.meta);
      expect(taskMsgs.length).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill();
    }
  });
});

describe("task orchestration — error cases", () => {
  test("403 when wrong role calls endpoint", async () => {
    const orch = await register({ pid: process.pid, cwd: "/tmp/orch" });
    const child = Bun.spawn(["sleep", "30"]);
    const worker = await register({ pid: child.pid, cwd: "/tmp/worker" });

    try {
      const created = await post("/create-task", {
        orchestrator_id: orch.id, to_id: worker.id,
        title: "T", description: "D",
      }) as { task_id: string };

      const res = await fetch(`${BASE}/accept-assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caller_id: orch.id, task_id: created.task_id }),
      });
      expect(res.status).toBe(403);
    } finally {
      child.kill();
    }
  });
});
```

- [ ] **Step 7: Run integration tests**

```bash
bun test broker.test.ts
```

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add broker.ts broker.test.ts
git commit -m "feat: wire 11 task routes in broker + integration tests"
```

---

### Task 8: Add MCP tools to server.ts

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add task type imports**

At the top of `server.ts`, update the import from `./shared/types.ts` (line 28):

```ts
import type {
  MateId,
  Mate,
  RegisterResponse,
  PollMessagesResponse,
  Message,
  Task,
  TransitionResponse,
  CreateTaskResponse,
  GetTaskResponse,
} from "./shared/types.ts";
```

- [ ] **Step 2: Add 11 tool definitions to TOOLS array**

After the existing `check_messages` tool definition in the TOOLS array (before `];` on line 230), add:

```ts
  {
    name: "create_task",
    description:
      "Assign a task to another Claude Code instance. You become the orchestrator for this task. The worker receives it immediately via channel push.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "The mate ID of the worker" },
        title: { type: "string" as const, description: "Short title for the task" },
        description: { type: "string" as const, description: "Detailed description of what needs to be done" },
        assigned_timeout_seconds: { type: "number" as const, description: "Seconds to accept (default: 300)" },
        progress_timeout_seconds: { type: "number" as const, description: "Seconds to complete (default: 7200)" },
      },
      required: ["to_id", "title", "description"],
    },
  },
  {
    name: "list_my_tasks",
    description:
      "List tasks you are involved in. Filter by your role (orchestrator, worker, or both) and optionally by status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        role: { type: "string" as const, enum: ["orchestrator", "worker", "both"], description: "Your role in the tasks" },
        status: { type: "string" as const, description: "Filter by status (optional)" },
        include_terminal: { type: "boolean" as const, description: "Include completed/declined/cancelled (default: false)" },
      },
      required: ["role"],
    },
  },
  {
    name: "get_task",
    description: "Get full details and event history for a specific task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "accept_assignment",
    description: "Accept a task that was assigned to you. Transitions the task to in_progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID to accept" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "decline_assignment",
    description: "Decline a task that was assigned to you. The orchestrator will be notified with your reason.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID to decline" },
        reason: { type: "string" as const, description: "Why you are declining this task" },
      },
      required: ["task_id", "reason"],
    },
  },
  {
    name: "report_result",
    description: "Submit the result of your work on a task for the orchestrator to review.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID" },
        result_text: { type: "string" as const, description: "Description of what you did and the outcome" },
        artifact_paths: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "File paths created or modified (optional)",
        },
      },
      required: ["task_id", "result_text"],
    },
  },
  {
    name: "report_blocker",
    description: "Report that you are blocked on a task and need help from the orchestrator.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID" },
        reason: { type: "string" as const, description: "What is blocking you" },
      },
      required: ["task_id", "reason"],
    },
  },
  {
    name: "accept_result",
    description: "Accept the worker's result and mark the task as completed. Only the orchestrator can call this.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "reject_result",
    description: "Reject the worker's result with feedback. The task returns to in_progress for the worker to try again.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID" },
        feedback: { type: "string" as const, description: "What needs to be improved or fixed" },
      },
      required: ["task_id", "feedback"],
    },
  },
  {
    name: "resume_blocked_task",
    description: "Resume a blocked task. Provides optional guidance to the worker. Only the orchestrator can call this.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID" },
        note: { type: "string" as const, description: "Guidance or context for the worker (optional)" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "cancel_task",
    description: "Cancel a task. The worker will be notified. Only the orchestrator can call this.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const, description: "The task ID to cancel" },
      },
      required: ["task_id"],
    },
  },
```

- [ ] **Step 3: Add tool handlers in CallToolRequestSchema switch**

In the switch statement inside `CallToolRequestSchema` handler, before `default:`, add:

```ts
    case "create_task": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      const { to_id, title, description, assigned_timeout_seconds, progress_timeout_seconds } = args as {
        to_id: string; title: string; description: string;
        assigned_timeout_seconds?: number; progress_timeout_seconds?: number;
      };
      try {
        const result = await brokerFetch<CreateTaskResponse | { error: string }>("/create-task", {
          orchestrator_id: myId, to_id, title, description,
          assigned_timeout_seconds, progress_timeout_seconds,
        });
        if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Task created: ${result.task_id}\nStatus: ${result.status}\nAccept deadline: ${result.assigned_deadline}\nProgress deadline: ${result.progress_deadline}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "list_my_tasks": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      const { role, status, include_terminal } = args as { role: string; status?: string; include_terminal?: boolean };
      try {
        const tasks = await brokerFetch<Task[]>("/list-tasks", { caller_id: myId, role, status, include_terminal });
        if (tasks.length === 0) return { content: [{ type: "text" as const, text: "No tasks found." }] };
        const lines = tasks.map((t) =>
          `[${t.status}] ${t.id}: "${t.title}" (${t.orchestrator_id === myId ? "orchestrator" : "worker"})`
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "get_task": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      const { task_id } = args as { task_id: string };
      try {
        const result = await brokerFetch<GetTaskResponse | { error: string }>("/get-task", { caller_id: myId, task_id });
        if ("error" in result) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        const t = result.task;
        const parts = [
          `Task: ${t.id}`, `Title: ${t.title}`, `Status: ${t.status}`,
          `Orchestrator: ${t.orchestrator_id}`, `Worker: ${t.worker_id}`,
          `Description: ${t.description}`,
        ];
        if (t.result_text) parts.push(`Result: ${t.result_text}`);
        if (t.blocker_reason) parts.push(`Blocker: ${t.blocker_reason}`);
        if (t.reject_feedback) parts.push(`Feedback: ${t.reject_feedback}`);
        parts.push(`\nEvents (${result.events.length}):`);
        for (const ev of result.events) {
          parts.push(`  ${ev.created_at} [${ev.event_type}] ${ev.from_status ?? "(new)"} → ${ev.to_status} by ${ev.actor_id}`);
        }
        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "accept_assignment":
    case "decline_assignment":
    case "report_result":
    case "report_blocker":
    case "accept_result":
    case "reject_result":
    case "resume_blocked_task":
    case "cancel_task": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };

      const endpointMap: Record<string, string> = {
        accept_assignment: "/accept-assignment",
        decline_assignment: "/decline-assignment",
        report_result: "/report-result",
        report_blocker: "/report-blocker",
        accept_result: "/accept-result",
        reject_result: "/reject-result",
        resume_blocked_task: "/resume-task",
        cancel_task: "/cancel-task",
      };

      try {
        const result = await brokerFetch<TransitionResponse>(endpointMap[name], {
          caller_id: myId,
          ...args,
        });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        if (result.already_done) return { content: [{ type: "text" as const, text: `Already done (idempotent).` }] };
        return { content: [{ type: "text" as const, text: `OK — task ${(args as { task_id: string }).task_id} is now ${result.task?.status}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
```

- [ ] **Step 4: Update MCP instructions string**

In the `instructions` field of the Server constructor (line 151), update to include task tools:

```ts
    instructions: `You are connected to the cc-mate network. Other Claude Code instances on this machine can see you and send you messages.

IMPORTANT: When you receive a <channel source="cc-mate" ...> message, RESPOND IMMEDIATELY. Do not wait until your current task is finished. Pause what you are doing, reply to the message using send_message, then resume your work. Treat incoming mate messages like a coworker tapping you on the shoulder — answer right away, even if you're in the middle of something.

Read the from_id, from_summary, and from_cwd attributes to understand who sent the message. Reply by calling send_message with their from_id.

When you receive a task event (kind="task_event"), respond using the appropriate task tool:
- As a worker: accept_assignment, decline_assignment, report_result, report_blocker
- As an orchestrator: accept_result, reject_result, resume_blocked_task, cancel_task

Available tools:
- list_mates: Discover other Claude Code instances (scope: machine/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to other mates)
- check_messages: Manually check for new messages
- create_task: Assign a task to another instance (you become orchestrator)
- list_my_tasks: List tasks you're involved in (as orchestrator or worker)
- get_task: Get full task details and event history
- accept_assignment: Accept a task assigned to you
- decline_assignment: Decline a task with a reason
- report_result: Submit your work for review
- report_blocker: Report you're stuck on a task
- accept_result: Approve worker's result (task complete)
- reject_result: Reject result with feedback (worker retries)
- resume_blocked_task: Unblock a task with guidance
- cancel_task: Cancel a task

When you start, proactively call set_summary to describe what you're working on. This helps other instances understand your context.`,
```

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat: add 11 task MCP tools to server.ts"
```

---

### Task 9: Update channel push for task events + retry

**Files:**
- Modify: `server.ts` (the `pollAndPushMessages` function and `brokerFetch`)

- [ ] **Step 1: Update brokerFetch with retry logic**

Replace the existing `brokerFetch` function (lines 45-56) in `server.ts`:

```ts
async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const isCreate = path === "/create-task";
  const maxRetries = isCreate ? 0 : 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${BROKER_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        const err = await res.text();
        // Don't retry 4xx
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`Broker error (${path}): ${res.status} ${err}`);
        }
        // Retry 5xx
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`Broker error (${path}): ${res.status} ${err}`);
      }

      return res.json() as Promise<T>;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Broker error")) throw e;
      // Network/timeout error — retry with backoff
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }

  throw new Error(`Broker fetch failed after retries: ${path}`);
}
```

- [ ] **Step 2: Update pollAndPushMessages for task events**

Replace the `pollAndPushMessages` function (lines 404-449):

```ts
async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      // Determine if this is a task event or a free message
      const taskMeta = msg.meta ? JSON.parse(msg.meta) as {
        task_id: string; event_type: string; to_status: string;
      } : null;

      // Look up sender info (skip for broker-generated events)
      let fromSummary = "";
      let fromCwd = "";
      if (msg.from_id !== "broker") {
        try {
          const mates = await brokerFetch<Mate[]>("/list-mates", {
            scope: "machine",
            cwd: myCwd,
            git_root: myGitRoot,
          });
          const sender = mates.find((p) => p.id === msg.from_id);
          if (sender) {
            fromSummary = sender.summary;
            fromCwd = sender.cwd;
          }
        } catch {
          // Non-critical
        }
      }

      const meta: Record<string, string> = {
        from_id: msg.from_id,
        from_summary: fromSummary,
        from_cwd: fromCwd,
        sent_at: msg.sent_at,
      };

      if (taskMeta) {
        meta.kind = "task_event";
        meta.task_id = taskMeta.task_id;
        meta.event_type = taskMeta.event_type;
        meta.to_status = taskMeta.to_status;
      }

      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content: msg.text, meta },
      });

      log(
        taskMeta
          ? `Pushed task event [${taskMeta.event_type}] for ${taskMeta.task_id}`
          : `Pushed message from ${msg.from_id}: ${msg.text.slice(0, 80)}`
      );
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 3: Run all tests**

```bash
bun test
```

Expected: All tests (broker.test.ts + broker-tasks.test.ts) PASS.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat: task event channel push + retry logic in brokerFetch"
```

---

## Self-Review Checklist

After completing all tasks, verify:

1. **Spec coverage:** All 14 spec sections have corresponding implementation tasks.
   - Sections 1-3 (overview/decisions/architecture): structural, no code needed
   - Section 4 (data model): Task 2
   - Section 5 (state machine): Tasks 2-5
   - Section 6 (MCP tools): Task 8
   - Section 7 (HTTP endpoints): Task 7
   - Section 8 (channel payloads): Task 9
   - Section 9 (timeout): Task 6
   - Section 10 (retry/backoff): Task 9
   - Section 11 (idempotency): Task 2 (doTransition core)
   - Section 12 (disconnect recovery): Task 6
   - Section 13 (test plan): Tasks 2-7

2. **Type consistency:** `TransitionResponse` and `TaskEngine` interface used consistently across broker-tasks.ts, broker.ts, and server.ts.

3. **No placeholders:** Every step has complete code. No TBD/TODO items.
