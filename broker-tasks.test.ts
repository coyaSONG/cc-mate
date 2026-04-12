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
