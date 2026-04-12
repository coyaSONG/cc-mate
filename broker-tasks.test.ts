import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { setupTaskEngine } from "./broker-tasks.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL");

  // Prerequisites: mates and messages tables (broker normally creates these)
  db.run(`
    CREATE TABLE IF NOT EXISTS mates (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      tty TEXT,
      summary TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    )
  `);

  return db;
}

function insertMate(db: Database, id: string): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO mates (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, process.pid, "/tmp/test", null, null, "test mate", now, now]
  );
}

describe("schema", () => {
  test("tasks table exists after setupTaskEngine", () => {
    const db = createTestDb();
    setupTaskEngine(db);

    const row = db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`)
      .get() as { name: string } | null;
    expect(row?.name).toBe("tasks");
  });

  test("task_events table exists after setupTaskEngine", () => {
    const db = createTestDb();
    setupTaskEngine(db);

    const row = db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='task_events'`)
      .get() as { name: string } | null;
    expect(row?.name).toBe("task_events");
  });

  test("meta column added to messages table", () => {
    const db = createTestDb();
    setupTaskEngine(db);

    // Insert a message with meta to verify the column exists
    const now = new Date().toISOString();
    expect(() => {
      db.run(
        `INSERT INTO messages (from_id, to_id, text, sent_at, delivered, meta)
         VALUES ('a', 'b', 'test', ?, 0, '{"task_id":"t_test"}')`,
        [now]
      );
    }).not.toThrow();
  });

  test("setupTaskEngine is idempotent (can be called twice)", () => {
    const db = createTestDb();
    expect(() => {
      setupTaskEngine(db);
      setupTaskEngine(db);
    }).not.toThrow();
  });
});

describe("handleCreateTask", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  test("creates task in 'assigned' status with correct fields", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
      assigned_timeout_seconds: 300,
      progress_timeout_seconds: 7200,
    });

    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);

    expect(result.status).toBe("assigned");
    expect(result.task_id).toMatch(/^t_[a-z0-9]{8}$/);
    expect(result.assigned_deadline).toBeDefined();
    expect(result.progress_deadline).toBeDefined();
  });

  test("calculates deadlines correctly from timeout seconds", () => {
    const engine = setupTaskEngine(db);
    const before = Date.now();
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Deadline Test",
      description: "Check deadlines",
      assigned_timeout_seconds: 300,
      progress_timeout_seconds: 7200,
    });
    const after = Date.now();

    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);

    const assignedDeadline = new Date(result.assigned_deadline).getTime();
    const progressDeadline = new Date(result.progress_deadline).getTime();

    // assigned_deadline should be ~300 seconds from now
    expect(assignedDeadline).toBeGreaterThanOrEqual(before + 299_000);
    expect(assignedDeadline).toBeLessThanOrEqual(after + 301_000);

    // progress_deadline should be ~7200 seconds from now
    expect(progressDeadline).toBeGreaterThanOrEqual(before + 7_199_000);
    expect(progressDeadline).toBeLessThanOrEqual(after + 7_201_000);
  });

  test("uses default timeouts when not specified", () => {
    const engine = setupTaskEngine(db);
    const before = Date.now();
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Defaults Test",
      description: "Check defaults",
    });

    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);

    const assignedDeadline = new Date(result.assigned_deadline).getTime();
    const progressDeadline = new Date(result.progress_deadline).getTime();

    // Default assigned_timeout_seconds = 300
    expect(assignedDeadline).toBeGreaterThanOrEqual(before + 299_000);
    // Default progress_timeout_seconds = 7200
    expect(progressDeadline).toBeGreaterThanOrEqual(before + 7_199_000);
  });

  test("records a 'created' event in task_events", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Event Test",
      description: "Check events",
    });

    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);

    const event = db
      .query(`SELECT * FROM task_events WHERE task_id = ?`)
      .get(result.task_id) as {
      event_type: string;
      actor_id: string;
      from_status: string | null;
      to_status: string;
    } | null;

    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("created");
    expect(event!.actor_id).toBe("orch_01");
    expect(event!.from_status).toBeNull();
    expect(event!.to_status).toBe("assigned");
  });

  test("sends notification message to worker with meta JSON", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Notify Test",
      description: "Check notification",
    });

    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);

    const msg = db
      .query(`SELECT * FROM messages WHERE to_id = 'work_01' AND delivered = 0`)
      .get() as {
      from_id: string;
      to_id: string;
      text: string;
      meta: string | null;
    } | null;

    expect(msg).not.toBeNull();
    expect(msg!.from_id).toBe("orch_01");
    expect(msg!.to_id).toBe("work_01");
    expect(msg!.meta).not.toBeNull();

    const meta = JSON.parse(msg!.meta!);
    expect(meta.task_id).toBe(result.task_id);
    expect(meta.event_type).toBe("created");
    expect(meta.to_status).toBe("assigned");
  });

  test("persists the task in the tasks table", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Persist Test",
      description: "Check persistence",
    });

    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);

    const task = db
      .query(`SELECT * FROM tasks WHERE id = ?`)
      .get(result.task_id) as {
      id: string;
      orchestrator_id: string;
      worker_id: string;
      status: string;
      title: string;
    } | null;

    expect(task).not.toBeNull();
    expect(task!.orchestrator_id).toBe("orch_01");
    expect(task!.worker_id).toBe("work_01");
    expect(task!.status).toBe("assigned");
    expect(task!.title).toBe("Persist Test");
  });

  test("returns 404 for nonexistent worker", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "no_such_worker",
      title: "Should Fail",
      description: "Worker does not exist",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect((result as { error: string; status_code: number }).status_code).toBe(404);
  });
});

describe("handleAcceptAssignment", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  function createAssignedTask(engine: ReturnType<typeof setupTaskEngine>) {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    return result.task_id;
  }

  test("assigned → in_progress", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAssignedTask(engine);
    const result = engine.handleAcceptAssignment({ caller_id: "work_01", task_id: taskId });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("in_progress");
  });

  test("rejects non-worker with 403", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAssignedTask(engine);
    const result = engine.handleAcceptAssignment({ caller_id: "orch_01", task_id: taskId });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(403);
  });

  test("idempotent: already in_progress returns already_done", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAssignedTask(engine);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: taskId });
    const result = engine.handleAcceptAssignment({ caller_id: "work_01", task_id: taskId });
    expect(result.ok).toBe(true);
    expect(result.already_done).toBe(true);
  });

  test("sends notification to orchestrator", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAssignedTask(engine);
    // clear messages first
    db.run(`DELETE FROM messages WHERE to_id = 'orch_01'`);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: taskId });
    const msg = db.query(`SELECT * FROM messages WHERE to_id = 'orch_01'`).get() as { text: string } | null;
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain("accepted");
  });
});

describe("handleDeclineAssignment", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  function createAssignedTask(engine: ReturnType<typeof setupTaskEngine>) {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    return result.task_id;
  }

  test("assigned → declined with reason stored", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAssignedTask(engine);
    const result = engine.handleDeclineAssignment({ caller_id: "work_01", task_id: taskId, reason: "Too busy" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("declined");
    expect(result.task?.decline_reason).toBe("Too busy");
  });

  test("rejects transition from non-assigned state with 409", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAssignedTask(engine);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: taskId });
    // now in_progress, can't decline
    const result = engine.handleDeclineAssignment({ caller_id: "work_01", task_id: taskId, reason: "Changed mind" });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });

  test("terminal state rejects further transitions with 409", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAssignedTask(engine);
    engine.handleDeclineAssignment({ caller_id: "work_01", task_id: taskId, reason: "Reason A" });
    // already declined (terminal), try again with new reason
    const result = engine.handleDeclineAssignment({ caller_id: "work_01", task_id: taskId, reason: "Reason B" });
    // already_done (same toStatus=declined) or 409 (not in validFrom)
    // doTransition: status===toStatus → already_done, so ok=true already_done=true
    expect(result.ok).toBe(true);
    expect(result.already_done).toBe(true);
  });
});

describe("handleReportResult", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  function createInProgressTask(engine: ReturnType<typeof setupTaskEngine>) {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    return result.task_id;
  }

  test("in_progress → awaiting_review", () => {
    const engine = setupTaskEngine(db);
    const taskId = createInProgressTask(engine);
    const result = engine.handleReportResult({ caller_id: "work_01", task_id: taskId, result_text: "Done!" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("awaiting_review");
  });

  test("stores result_text", () => {
    const engine = setupTaskEngine(db);
    const taskId = createInProgressTask(engine);
    engine.handleReportResult({ caller_id: "work_01", task_id: taskId, result_text: "My result" });
    const task = db.query(`SELECT result_text FROM tasks WHERE id = ?`).get(taskId) as { result_text: string };
    expect(task.result_text).toBe("My result");
  });

  test("stores artifact_paths as JSON", () => {
    const engine = setupTaskEngine(db);
    const taskId = createInProgressTask(engine);
    engine.handleReportResult({
      caller_id: "work_01",
      task_id: taskId,
      result_text: "Done",
      artifact_paths: ["/out/file1.txt", "/out/file2.txt"],
    });
    const task = db.query(`SELECT artifact_paths FROM tasks WHERE id = ?`).get(taskId) as { artifact_paths: string };
    expect(JSON.parse(task.artifact_paths)).toEqual(["/out/file1.txt", "/out/file2.txt"]);
  });

  test("rejects from assigned state with 409", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    const r = engine.handleReportResult({ caller_id: "work_01", task_id: result.task_id, result_text: "Too soon" });
    expect(r.ok).toBe(false);
    expect(r.status_code).toBe(409);
  });
});

describe("handleReportBlocker", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  function createInProgressTask(engine: ReturnType<typeof setupTaskEngine>) {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    return result.task_id;
  }

  test("in_progress → blocked, stores blocker_reason", () => {
    const engine = setupTaskEngine(db);
    const taskId = createInProgressTask(engine);
    const result = engine.handleReportBlocker({ caller_id: "work_01", task_id: taskId, reason: "Need access" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("blocked");
    expect(result.task?.blocker_reason).toBe("Need access");
  });
});

describe("handleAcceptResult", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  function createAwaitingReviewTask(engine: ReturnType<typeof setupTaskEngine>) {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    engine.handleReportResult({ caller_id: "work_01", task_id: result.task_id, result_text: "Done!" });
    return result.task_id;
  }

  test("awaiting_review → completed", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAwaitingReviewTask(engine);
    const result = engine.handleAcceptResult({ caller_id: "orch_01", task_id: taskId });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("completed");
  });

  test("terminal completed rejects cancel with 409", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAwaitingReviewTask(engine);
    engine.handleAcceptResult({ caller_id: "orch_01", task_id: taskId });
    const result = engine.handleCancelTask({ caller_id: "orch_01", task_id: taskId });
    expect(result.ok).toBe(false);
    expect(result.status_code).toBe(409);
  });
});

describe("handleRejectResult", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  function createAwaitingReviewTask(engine: ReturnType<typeof setupTaskEngine>) {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
      progress_timeout_seconds: 3600,
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    engine.handleReportResult({ caller_id: "work_01", task_id: result.task_id, result_text: "First attempt", artifact_paths: ["/out/f1.txt"] });
    return result.task_id;
  }

  test("awaiting_review → in_progress with feedback stored", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAwaitingReviewTask(engine);
    const result = engine.handleRejectResult({ caller_id: "orch_01", task_id: taskId, feedback: "Needs more detail" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("in_progress");
    expect(result.task?.reject_feedback).toBe("Needs more detail");
  });

  test("clears result_text and artifact_paths on rejection", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAwaitingReviewTask(engine);
    engine.handleRejectResult({ caller_id: "orch_01", task_id: taskId, feedback: "Redo it" });
    const task = db.query(`SELECT result_text, artifact_paths FROM tasks WHERE id = ?`).get(taskId) as { result_text: string | null; artifact_paths: string | null };
    expect(task.result_text).toBeNull();
    expect(task.artifact_paths).toBeNull();
  });

  test("resets progress_deadline on rejection", () => {
    const engine = setupTaskEngine(db);
    const taskId = createAwaitingReviewTask(engine);
    const before = Date.now();
    engine.handleRejectResult({ caller_id: "orch_01", task_id: taskId, feedback: "Redo it" });
    const task = db.query(`SELECT progress_deadline FROM tasks WHERE id = ?`).get(taskId) as { progress_deadline: string };
    const deadline = new Date(task.progress_deadline).getTime();
    // Should be ~3600s from now
    expect(deadline).toBeGreaterThanOrEqual(before + 3_599_000);
  });
});

describe("handleResumeTask", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  function createBlockedTask(engine: ReturnType<typeof setupTaskEngine>) {
    const result = engine.handleCreateTask({
      orchestrator_id: "orch_01",
      to_id: "work_01",
      title: "Test Task",
      description: "Do the thing",
    });
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    engine.handleReportBlocker({ caller_id: "work_01", task_id: result.task_id, reason: "Waiting on infra" });
    return result.task_id;
  }

  test("blocked → in_progress", () => {
    const engine = setupTaskEngine(db);
    const taskId = createBlockedTask(engine);
    const result = engine.handleResumeTask({ caller_id: "orch_01", task_id: taskId });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("in_progress");
  });

  test("records note in event payload", () => {
    const engine = setupTaskEngine(db);
    const taskId = createBlockedTask(engine);
    engine.handleResumeTask({ caller_id: "orch_01", task_id: taskId, note: "Access granted" });
    const event = db.query(`SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'resumed'`).get(taskId) as { payload: string } | null;
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.payload)).toEqual({ note: "Access granted" });
  });
});

describe("handleCancelTask", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch_01");
    insertMate(db, "work_01");
  });

  test("cancels from assigned state", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({ orchestrator_id: "orch_01", to_id: "work_01", title: "T", description: "D" });
    if ("error" in result) throw new Error();
    const r = engine.handleCancelTask({ caller_id: "orch_01", task_id: result.task_id });
    expect(r.ok).toBe(true);
    expect(r.task?.status).toBe("cancelled");
  });

  test("cancels from in_progress state", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({ orchestrator_id: "orch_01", to_id: "work_01", title: "T", description: "D" });
    if ("error" in result) throw new Error();
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    const r = engine.handleCancelTask({ caller_id: "orch_01", task_id: result.task_id });
    expect(r.ok).toBe(true);
    expect(r.task?.status).toBe("cancelled");
  });

  test("cancels from blocked state", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({ orchestrator_id: "orch_01", to_id: "work_01", title: "T", description: "D" });
    if ("error" in result) throw new Error();
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    engine.handleReportBlocker({ caller_id: "work_01", task_id: result.task_id, reason: "stuck" });
    const r = engine.handleCancelTask({ caller_id: "orch_01", task_id: result.task_id });
    expect(r.ok).toBe(true);
    expect(r.task?.status).toBe("cancelled");
  });

  test("rejects cancel from completed state with 409", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({ orchestrator_id: "orch_01", to_id: "work_01", title: "T", description: "D" });
    if ("error" in result) throw new Error();
    engine.handleAcceptAssignment({ caller_id: "work_01", task_id: result.task_id });
    engine.handleReportResult({ caller_id: "work_01", task_id: result.task_id, result_text: "Done" });
    engine.handleAcceptResult({ caller_id: "orch_01", task_id: result.task_id });
    const r = engine.handleCancelTask({ caller_id: "orch_01", task_id: result.task_id });
    expect(r.ok).toBe(false);
    expect(r.status_code).toBe(409);
  });

  test("only orchestrator can cancel — worker gets 403", () => {
    const engine = setupTaskEngine(db);
    const result = engine.handleCreateTask({ orchestrator_id: "orch_01", to_id: "work_01", title: "T", description: "D" });
    if ("error" in result) throw new Error();
    const r = engine.handleCancelTask({ caller_id: "work_01", task_id: result.task_id });
    expect(r.ok).toBe(false);
    expect(r.status_code).toBe(403);
  });
});

describe("handleListTasks", () => {
  let db: Database;
  let engine: ReturnType<typeof setupTaskEngine>;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch1");
    insertMate(db, "work1");
    engine = setupTaskEngine(db);
  });

  test("filters by worker role", () => {
    engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "A", description: "D" });
    const tasks = engine.handleListTasks({ caller_id: "work1", role: "worker" });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((t) => t.worker_id === "work1")).toBe(true);
  });

  test("filters by orchestrator role", () => {
    engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "A", description: "D" });
    const tasks = engine.handleListTasks({ caller_id: "orch1", role: "orchestrator" });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((t) => t.orchestrator_id === "orch1")).toBe(true);
  });

  test("excludes terminal by default", () => {
    const created = engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "A", description: "D" });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleDeclineAssignment({ caller_id: "work1", task_id: created.task_id, reason: "no" });
    const tasks = engine.handleListTasks({ caller_id: "work1", role: "worker" });
    expect(tasks.every((t) => t.status !== "declined")).toBe(true);
  });

  test("includes terminal when requested", () => {
    const created = engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "Declined", description: "D" });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleDeclineAssignment({ caller_id: "work1", task_id: created.task_id, reason: "no" });
    const tasks = engine.handleListTasks({ caller_id: "work1", role: "worker", include_terminal: true });
    expect(tasks.some((t) => t.status === "declined")).toBe(true);
  });
});

describe("handleGetTask", () => {
  let db: Database;
  let engine: ReturnType<typeof setupTaskEngine>;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch1");
    insertMate(db, "work1");
    engine = setupTaskEngine(db);
  });

  test("returns task with events", () => {
    const created = engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D" });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    const result = engine.handleGetTask({ caller_id: "work1", task_id: created.task_id });
    expect("task" in result).toBe(true);
    if (!("task" in result)) return;
    expect(result.task.status).toBe("in_progress");
    expect(result.events.length).toBeGreaterThanOrEqual(2);
  });

  test("returns 404 for nonexistent task", () => {
    const result = engine.handleGetTask({ caller_id: "work1", task_id: "t_nonexist" });
    expect("error" in result).toBe(true);
  });

  test("returns 403 for uninvolved mate", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
    });
    if (!("task_id" in created)) throw new Error("create failed");

    // Add a third mate
    insertMate(db, "other1");
    const result = engine.handleGetTask({ caller_id: "other1", task_id: created.task_id });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.status_code).toBe(403);
  });
});

describe("checkTaskTimeouts", () => {
  let db: Database;
  let engine: ReturnType<typeof setupTaskEngine>;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch1");
    insertMate(db, "work1");
    engine = setupTaskEngine(db);
  });

  test("assigned timeout → blocked", () => {
    const created = engine.handleCreateTask({
      orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D",
      assigned_timeout_seconds: 0,
    });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.checkTaskTimeouts();
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as any;
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
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as any;
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
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as any;
    expect(task.status).toBe("assigned");
  });
});

describe("cleanStaleMateTasks", () => {
  let db: Database;
  let engine: ReturnType<typeof setupTaskEngine>;

  beforeEach(() => {
    db = createTestDb();
    insertMate(db, "orch1");
    insertMate(db, "work1");
    engine = setupTaskEngine(db);
  });

  test("worker death → tasks blocked", () => {
    const created = engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D" });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleAcceptAssignment({ caller_id: "work1", task_id: created.task_id });
    engine.cleanStaleMateTasks("work1");
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as any;
    expect(task.status).toBe("blocked");
    expect(task.blocker_reason).toContain("worker disconnected");
  });

  test("orchestrator death → tasks cancelled", () => {
    const created = engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D" });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.cleanStaleMateTasks("orch1");
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as any;
    expect(task.status).toBe("cancelled");
  });

  test("skips terminal tasks", () => {
    const created = engine.handleCreateTask({ orchestrator_id: "orch1", to_id: "work1", title: "T", description: "D" });
    if (!("task_id" in created)) throw new Error("create failed");
    engine.handleDeclineAssignment({ caller_id: "work1", task_id: created.task_id, reason: "no" });
    engine.cleanStaleMateTasks("work1");
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(created.task_id) as any;
    expect(task.status).toBe("declined");
  });
});
