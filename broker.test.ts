import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import type { Subprocess } from "bun";
import { unlinkSync } from "node:fs";

const TEST_PORT = 17349;
const TEST_DB = `/tmp/cc-mate-test-${Date.now()}.db`;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let broker: Subprocess;

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function register(overrides: Partial<{ pid: number; cwd: string; git_root: string | null; summary: string }> = {}) {
  return post("/register", {
    pid: overrides.pid ?? process.pid,
    cwd: overrides.cwd ?? "/tmp/test",
    git_root: overrides.git_root ?? null,
    tty: null,
    summary: overrides.summary ?? "",
  }) as Promise<{ id: string }>;
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CC_MATE_PORT: String(TEST_PORT), CC_MATE_DB: TEST_DB },
    stderr: "pipe",
  });

  // Wait for broker to be ready
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Broker did not start in time");
});

afterAll(() => {
  broker.kill();
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
});

// --- Tests ---

describe("health", () => {
  test("GET /health returns ok", async () => {
    const res = await fetch(`${BASE}/health`);
    const data = (await res.json()) as { status: string; mates: number };
    expect(data.status).toBe("ok");
    expect(typeof data.mates).toBe("number");
  });
});

describe("register", () => {
  test("returns an 8-char id", async () => {
    const { id } = await register();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  test("re-register with same PID replaces old entry", async () => {
    const { id: first } = await register();
    const { id: second } = await register(); // same PID
    expect(second).not.toBe(first);

    const mates = await post("/list-mates", {
      scope: "machine", cwd: "/tmp/test", git_root: null,
    }) as Array<{ id: string }>;

    const ids = mates.map((m) => m.id);
    expect(ids).not.toContain(first);
    expect(ids).toContain(second);
  });
});

describe("list-mates", () => {
  test("scope=machine returns all mates", async () => {
    const { id } = await register();
    const mates = await post("/list-mates", {
      scope: "machine", cwd: "/anywhere", git_root: null,
    }) as Array<{ id: string }>;

    expect(mates.some((m) => m.id === id)).toBe(true);
  });

  test("scope=directory filters by cwd", async () => {
    const { id: a } = await register({ pid: process.pid, cwd: "/dir/a" });
    // Register a different "mate" — use a child process PID so it's alive
    const child = Bun.spawn(["sleep", "30"]);
    const { id: b } = await register({ pid: child.pid, cwd: "/dir/b" });

    try {
      const mates = await post("/list-mates", {
        scope: "directory", cwd: "/dir/a", git_root: null,
      }) as Array<{ id: string }>;

      const ids = mates.map((m) => m.id);
      expect(ids).toContain(a);
      expect(ids).not.toContain(b);
    } finally {
      child.kill();
    }
  });

  test("scope=repo filters by git_root", async () => {
    const { id: a } = await register({ pid: process.pid, cwd: "/x", git_root: "/repo1" });
    const child = Bun.spawn(["sleep", "30"]);
    const { id: b } = await register({ pid: child.pid, cwd: "/y", git_root: "/repo2" });

    try {
      const mates = await post("/list-mates", {
        scope: "repo", cwd: "/x", git_root: "/repo1",
      }) as Array<{ id: string }>;

      const ids = mates.map((m) => m.id);
      expect(ids).toContain(a);
      expect(ids).not.toContain(b);
    } finally {
      child.kill();
    }
  });

  test("exclude_id filters out self", async () => {
    const { id } = await register();
    const mates = await post("/list-mates", {
      scope: "machine", cwd: "/tmp/test", git_root: null, exclude_id: id,
    }) as Array<{ id: string }>;

    expect(mates.every((m) => m.id !== id)).toBe(true);
  });
});

describe("send-message & poll-messages", () => {
  test("full message flow: send → poll → delivered", async () => {
    // Register sender and receiver as separate "mates"
    const { id: sender } = await register({ pid: process.pid, cwd: "/tmp/s" });
    const child = Bun.spawn(["sleep", "30"]);
    const { id: receiver } = await register({ pid: child.pid, cwd: "/tmp/r" });

    try {
      // Send a message
      const sendRes = await post("/send-message", {
        from_id: sender, to_id: receiver, text: "hello mate!",
      });
      expect(sendRes).toEqual({ ok: true });

      // Poll — should get the message
      const poll1 = await post("/poll-messages", { id: receiver }) as { messages: Array<{ from_id: string; text: string }> };
      expect(poll1.messages).toHaveLength(1);
      expect(poll1.messages[0]!.from_id).toBe(sender);
      expect(poll1.messages[0]!.text).toBe("hello mate!");

      // Poll again — already delivered, should be empty
      const poll2 = await post("/poll-messages", { id: receiver }) as { messages: unknown[] };
      expect(poll2.messages).toHaveLength(0);
    } finally {
      child.kill();
    }
  });

  test("send to non-existent mate returns error", async () => {
    const { id: sender } = await register();
    const res = await post("/send-message", {
      from_id: sender, to_id: "zzzzzzzz", text: "oops",
    });
    expect(res).toEqual({ ok: false, error: "Mate zzzzzzzz not found" });
  });

  test("multiple messages arrive in order", async () => {
    const { id: sender } = await register({ pid: process.pid, cwd: "/tmp/s" });
    const child = Bun.spawn(["sleep", "30"]);
    const { id: receiver } = await register({ pid: child.pid, cwd: "/tmp/r" });

    try {
      await post("/send-message", { from_id: sender, to_id: receiver, text: "first" });
      await post("/send-message", { from_id: sender, to_id: receiver, text: "second" });
      await post("/send-message", { from_id: sender, to_id: receiver, text: "third" });

      const poll = await post("/poll-messages", { id: receiver }) as { messages: Array<{ text: string }> };
      expect(poll.messages.map((m) => m.text)).toEqual(["first", "second", "third"]);
    } finally {
      child.kill();
    }
  });

  test("stores optional metadata for normal messages", async () => {
    const { id: sender } = await register({ pid: process.pid, cwd: "/tmp/s" });
    const child = Bun.spawn(["sleep", "30"]);
    const { id: receiver } = await register({ pid: child.pid, cwd: "/tmp/r" });

    try {
      const sendRes = await post("/send-message", {
        from_id: sender,
        to_id: receiver,
        text: "call prompt",
        meta: {
          kind: "call_request",
          request_id: "req_123",
          schema_version: 1,
        },
      });
      expect(sendRes).toEqual({ ok: true });

      const poll = await post("/poll-messages", { id: receiver }) as { messages: Array<{ meta: string | null; text: string }> };
      expect(poll.messages).toHaveLength(1);
      expect(poll.messages[0]!.text).toBe("call prompt");
      expect(JSON.parse(poll.messages[0]!.meta!)).toEqual({
        kind: "call_request",
        request_id: "req_123",
        schema_version: 1,
      });
    } finally {
      child.kill();
    }
  });

  test("unregister removes pending messages for the mate", async () => {
    const { id: sender } = await register({ pid: process.pid, cwd: "/tmp/s" });
    const child = Bun.spawn(["sleep", "30"]);
    const { id: receiver } = await register({ pid: child.pid, cwd: "/tmp/r" });

    try {
      await post("/send-message", { from_id: sender, to_id: receiver, text: "pending" });
      await post("/unregister", { id: receiver });

      const poll = await post("/poll-messages", { id: receiver }) as { messages: unknown[] };
      expect(poll.messages).toHaveLength(0);
    } finally {
      child.kill();
    }
  });
});

describe("set-summary & heartbeat", () => {
  test("set-summary updates the mate's summary", async () => {
    const { id } = await register({ summary: "initial" });
    await post("/set-summary", { id, summary: "updated summary" });

    const mates = await post("/list-mates", {
      scope: "machine", cwd: "/tmp/test", git_root: null,
    }) as Array<{ id: string; summary: string }>;

    const mate = mates.find((m) => m.id === id);
    expect(mate?.summary).toBe("updated summary");
  });

  test("heartbeat updates last_seen", async () => {
    const { id } = await register();

    const matesBefore = (await post("/list-mates", {
      scope: "machine", cwd: "/tmp/test", git_root: null,
    }) as Array<{ id: string; last_seen: string }>);
    const before = matesBefore.find((m) => m.id === id);
    expect(before).toBeDefined();

    await Bun.sleep(50);
    await post("/heartbeat", { id });

    const matesAfter = (await post("/list-mates", {
      scope: "machine", cwd: "/tmp/test", git_root: null,
    }) as Array<{ id: string; last_seen: string }>);
    const after = matesAfter.find((m) => m.id === id);
    expect(after).toBeDefined();

    expect(after!.last_seen >= before!.last_seen).toBe(true);
  });
});

describe("unregister", () => {
  test("removes the mate", async () => {
    const { id } = await register();
    await post("/unregister", { id });

    const mates = await post("/list-mates", {
      scope: "machine", cwd: "/tmp/test", git_root: null,
    }) as Array<{ id: string }>;

    expect(mates.every((m) => m.id !== id)).toBe(true);
  });
});

describe("task orchestration — happy path", () => {
  test("create → accept → report → accept_result → completed", async () => {
    const orch = await register({ pid: process.pid, cwd: "/tmp/orch" });
    const child = Bun.spawn(["sleep", "30"]);
    const worker = await register({ pid: child.pid, cwd: "/tmp/worker" });

    try {
      const created = await post("/create-task", {
        orchestrator_id: orch.id, to_id: worker.id,
        title: "Fix bug", description: "Fix the login bug",
      }) as { task_id: string; status: string };
      expect(created.task_id).toMatch(/^t_/);
      expect(created.status).toBe("assigned");

      const accepted = await post("/accept-assignment", {
        caller_id: worker.id, task_id: created.task_id,
      }) as { ok: boolean; task: { status: string } };
      expect(accepted.ok).toBe(true);
      expect(accepted.task.status).toBe("in_progress");

      const reported = await post("/report-result", {
        caller_id: worker.id, task_id: created.task_id,
        result_text: "Bug fixed in login.ts",
      }) as { ok: boolean; task: { status: string } };
      expect(reported.ok).toBe(true);
      expect(reported.task.status).toBe("awaiting_review");

      const completed = await post("/accept-result", {
        caller_id: orch.id, task_id: created.task_id,
      }) as { ok: boolean; task: { status: string } };
      expect(completed.ok).toBe(true);
      expect(completed.task.status).toBe("completed");
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

      // Orchestrator tries to accept (should be worker-only)
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

  test("409 for invalid state transition", async () => {
    const orch = await register({ pid: process.pid, cwd: "/tmp/orch" });
    const child = Bun.spawn(["sleep", "30"]);
    const worker = await register({ pid: child.pid, cwd: "/tmp/worker" });

    try {
      const created = await post("/create-task", {
        orchestrator_id: orch.id, to_id: worker.id,
        title: "T", description: "D",
      }) as { task_id: string };

      // Try to report result before accepting (should be 409)
      const res = await fetch(`${BASE}/report-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caller_id: worker.id, task_id: created.task_id, result_text: "X" }),
      });
      expect(res.status).toBe(409);
    } finally {
      child.kill();
    }
  });

  test("notification messages delivered to worker via poll", async () => {
    const orch = await register({ pid: process.pid, cwd: "/tmp/orch" });
    const child = Bun.spawn(["sleep", "30"]);
    const worker = await register({ pid: child.pid, cwd: "/tmp/worker" });

    try {
      await post("/create-task", {
        orchestrator_id: orch.id, to_id: worker.id,
        title: "Test task", description: "Desc",
      });

      const poll = await post("/poll-messages", { id: worker.id }) as { messages: Array<{ meta: string; text: string }> };
      expect(poll.messages.length).toBeGreaterThanOrEqual(1);
      const taskMsg = poll.messages.find((m) => m.meta);
      expect(taskMsg).toBeDefined();
      const meta = JSON.parse(taskMsg!.meta);
      expect(meta.event_type).toBe("created");
      expect(meta.to_status).toBe("assigned");
    } finally {
      child.kill();
    }
  });
});
