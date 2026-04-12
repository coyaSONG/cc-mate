import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import type { Subprocess } from "bun";
import { unlinkSync } from "node:fs";

const TEST_PORT = 17351;
const TEST_DB = `/tmp/cc-mate-cli-test-${Date.now()}.db`;
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;
const env = { ...process.env, CC_MATE_PORT: String(TEST_PORT) };

let broker: Subprocess;

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

/** Run CLI and capture stdout + stderr. */
async function runCli(...args: string[]) {
  const proc = Bun.spawn(["bun", "cli.ts", ...args], {
    env: { ...env, CC_MATE_DB: TEST_DB },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

beforeAll(async () => {
  broker = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CC_MATE_PORT: String(TEST_PORT), CC_MATE_DB: TEST_DB },
    stderr: "pipe",
  });

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/health`);
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

describe("no args / usage", () => {
  test("prints usage when no command given", async () => {
    const { stdout } = await runCli();
    expect(stdout).toContain("cc-mate CLI");
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("status");
    expect(stdout).toContain("mates");
    expect(stdout).toContain("send");
  });

  test("prints usage for unknown command", async () => {
    const { stdout } = await runCli("unknown-cmd");
    expect(stdout).toContain("Usage:");
  });
});

describe("status", () => {
  test("shows broker status", async () => {
    const { stdout } = await runCli("status");
    expect(stdout).toContain("Broker: ok");
    expect(stdout).toContain(`URL: ${BROKER_URL}`);
  });

  test("shows registered mates", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    const { id } = await brokerPost<{ id: string }>("/register", {
      pid: child.pid, cwd: "/tmp/status-test", git_root: null, tty: null, summary: "testing status",
    });

    try {
      const { stdout } = await runCli("status");
      expect(stdout).toContain(id);
      expect(stdout).toContain("PID:");
      expect(stdout).toContain("Last seen:");
    } finally {
      await brokerPost("/unregister", { id });
      child.kill();
    }
  });
});

describe("mates", () => {
  test("shows 'no mates' when empty", async () => {
    const { stdout } = await runCli("mates");
    expect(stdout).toContain("No mates registered");
  });

  test("lists registered mates with summary", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    const { id } = await brokerPost<{ id: string }>("/register", {
      pid: child.pid, cwd: "/tmp/mates-test", git_root: null, tty: null, summary: "hello world",
    });

    try {
      const { stdout } = await runCli("mates");
      expect(stdout).toContain(id);
      expect(stdout).toContain("hello world");
    } finally {
      await brokerPost("/unregister", { id });
      child.kill();
    }
  });
});

describe("send", () => {
  test("sends message to existing mate", async () => {
    // Register a "cli" sender (send uses from_id: "cli") and a target
    const child = Bun.spawn(["sleep", "30"]);
    const { id: targetId } = await brokerPost<{ id: string }>("/register", {
      pid: child.pid, cwd: "/tmp/send-test", git_root: null, tty: null, summary: "",
    });
    // cli.ts sends with from_id: "cli", so we need "cli" registered
    await brokerPost("/register", {
      pid: process.pid, cwd: "/tmp", git_root: null, tty: null, summary: "",
    });

    try {
      const { stdout } = await runCli("send", targetId, "hi", "there");
      expect(stdout).toContain(`Message sent to ${targetId}`);

      // Verify message arrived
      const poll = await brokerPost<{ messages: Array<{ text: string }> }>("/poll-messages", { id: targetId });
      expect(poll.messages).toHaveLength(1);
      expect(poll.messages[0].text).toBe("hi there");
    } finally {
      await brokerPost("/unregister", { id: targetId });
      child.kill();
    }
  });

  test("prints error for missing args", async () => {
    const { stderr, code } = await runCli("send");
    expect(stderr).toContain("Usage:");
    expect(code).toBe(1);
  });

  test("prints error for non-existent mate", async () => {
    // Register "cli" sender
    await brokerPost("/register", {
      pid: process.pid, cwd: "/tmp", git_root: null, tty: null, summary: "",
    });

    const { stderr } = await runCli("send", "zzzzzzzz", "nope");
    expect(stderr).toContain("Failed");
  });
});
