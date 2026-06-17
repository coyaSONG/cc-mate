import { test, expect, beforeAll, afterAll, beforeEach, describe } from "bun:test";
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

interface TestMessage {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  meta: string | null;
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

function spawnCli(...args: string[]): Subprocess {
  return Bun.spawn(["bun", "cli.ts", ...args], {
    env: { ...env, CC_MATE_DB: TEST_DB },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collectCli(proc: Subprocess) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function registerTestMate(overrides: Partial<{ cwd: string; git_root: string | null; summary: string }> = {}) {
  const child = Bun.spawn(["sleep", "30"]);
  const { id } = await brokerPost<{ id: string }>("/register", {
    pid: child.pid,
    cwd: overrides.cwd ?? "/tmp/call-target",
    git_root: overrides.git_root ?? null,
    tty: null,
    summary: overrides.summary ?? "test target",
  });
  return { id, child };
}

async function listAllMates() {
  return brokerPost<Array<{ id: string; pid: number; summary: string }>>("/list-mates", {
    scope: "machine",
    cwd: "/",
    git_root: null,
  });
}

async function cleanupParentProcessMates() {
  const mates = await listAllMates();
  for (const mate of mates) {
    if (mate.pid === process.pid || mate.summary.startsWith("cc-mate cli")) {
      await brokerPost("/unregister", { id: mate.id });
    }
  }
}

async function waitForMessage(
  mateId: string,
  predicate: (msg: TestMessage) => boolean = () => true,
  timeoutMs = 2500
): Promise<TestMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const poll = await brokerPost<{ messages: TestMessage[] }>("/poll-messages", { id: mateId });
    const found = poll.messages.find(predicate);
    if (found) return found;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for message to ${mateId}`);
}

async function sendCallResponse(args: {
  fromId: string;
  toId: string;
  requestId: string;
  text: string;
  final?: boolean;
  status?: "ok" | "error";
}) {
  await brokerPost("/send-message", {
    from_id: args.fromId,
    to_id: args.toId,
    text: args.text,
    meta: {
      kind: "call_response",
      schema_version: 1,
      request_id: args.requestId,
      status: args.status ?? "ok",
      final: args.final ?? true,
      created_at: new Date().toISOString(),
    },
  });
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
      expect(poll.messages[0]!.text).toBe("hi there");
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

describe("doctor", () => {
  test("emits JSON diagnostics", async () => {
    const { stdout, code } = await runCli("doctor", "--json");
    const data = JSON.parse(stdout) as { ok: boolean; command: string; checks: Array<{ name: string }> };
    expect(code).toBe(0);
    expect(data.ok).toBe(true);
    expect(data.command).toBe("doctor");
    expect(data.checks.some((check) => check.name === "broker")).toBe(true);
  });
});

describe("call", () => {
  beforeEach(async () => {
    await cleanupParentProcessMates();
  });

  test("sends request from a temporary caller and prints only the final response", async () => {
    const target = await registerTestMate();
    try {
      const proc = spawnCli("call", "--to", target.id, "--timeout-ms", "3000", "hello", "claude");
      const prompt = await waitForMessage(target.id);
      const meta = JSON.parse(prompt.meta!);
      expect(meta.kind).toBe("call_request");
      expect(meta.request_id).toMatch(/^ccmate_/);
      expect(meta.reply_to).toBe(prompt.from_id);
      expect(prompt.from_id).not.toBe("cli");

      await sendCallResponse({
        fromId: target.id,
        toId: prompt.from_id,
        requestId: meta.request_id,
        text: "Acknowledged, working on it...",
        final: false,
      });
      await sendCallResponse({
        fromId: target.id,
        toId: prompt.from_id,
        requestId: meta.request_id,
        text: "final answer",
      });

      const { stdout, stderr, code } = await collectCli(proc);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("final answer");
      expect(stderr).toBe("");

      const mates = await listAllMates();
      expect(mates.some((mate) => mate.id === prompt.from_id)).toBe(false);
    } finally {
      await brokerPost("/unregister", { id: target.id });
      target.child.kill();
    }
  });

  test("JSON mode returns a stable success envelope", async () => {
    const target = await registerTestMate();
    try {
      const proc = spawnCli("call", "--to", target.id, "--json", "--timeout-ms", "3000", "return", "json");
      const prompt = await waitForMessage(target.id);
      const meta = JSON.parse(prompt.meta!);
      await sendCallResponse({
        fromId: target.id,
        toId: prompt.from_id,
        requestId: meta.request_id,
        text: '{"value":42}',
      });

      const { stdout, code } = await collectCli(proc);
      const data = JSON.parse(stdout) as {
        ok: boolean;
        command: string;
        target_id: string;
        request_id: string;
        response: string;
      };
      expect(code).toBe(0);
      expect(data.ok).toBe(true);
      expect(data.command).toBe("call");
      expect(data.target_id).toBe(target.id);
      expect(data.request_id).toBe(meta.request_id);
      expect(data.response).toBe('{"value":42}');
    } finally {
      await brokerPost("/unregister", { id: target.id });
      target.child.kill();
    }
  });

  test("accepts legacy reply responses without call_response metadata", async () => {
    const target = await registerTestMate();
    try {
      const proc = spawnCli("call", "--to", target.id, "--timeout-ms", "3000", "legacy", "reply");
      const prompt = await waitForMessage(target.id);

      await brokerPost("/send-message", {
        from_id: target.id,
        to_id: prompt.from_id,
        text: "Acknowledged, working on it...",
      });
      await brokerPost("/send-message", {
        from_id: target.id,
        to_id: prompt.from_id,
        text: "legacy final answer",
      });

      const { stdout, code } = await collectCli(proc);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("legacy final answer");
    } finally {
      await brokerPost("/unregister", { id: target.id });
      target.child.kill();
    }
  });

  test("explicit target receives the prompt when multiple mates exist", async () => {
    const target = await registerTestMate({ summary: "target" });
    const other = await registerTestMate({ summary: "other" });
    try {
      const proc = spawnCli("call", "--to", target.id, "--timeout-ms", "3000", "specific");
      const prompt = await waitForMessage(target.id);
      const otherPoll = await brokerPost<{ messages: TestMessage[] }>("/poll-messages", { id: other.id });
      const meta = JSON.parse(prompt.meta!);
      await sendCallResponse({
        fromId: target.id,
        toId: prompt.from_id,
        requestId: meta.request_id,
        text: "target answered",
      });

      const { stdout, code } = await collectCli(proc);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("target answered");
      expect(otherPoll.messages).toHaveLength(0);
    } finally {
      await brokerPost("/unregister", { id: target.id });
      await brokerPost("/unregister", { id: other.id });
      target.child.kill();
      other.child.kill();
    }
  });

  test("ambiguous target fails before registering a temporary caller", async () => {
    const first = await registerTestMate({ summary: "first" });
    const second = await registerTestMate({ summary: "second" });
    try {
      const before = await listAllMates();
      const { stderr, code } = await runCli("call", "--timeout-ms", "500", "hello");
      const after = await listAllMates();
      expect(code).toBe(1);
      expect(stderr).toContain("Multiple mates found");
      expect(after.map((mate) => mate.id).sort()).toEqual(before.map((mate) => mate.id).sort());
    } finally {
      await brokerPost("/unregister", { id: first.id });
      await brokerPost("/unregister", { id: second.id });
      first.child.kill();
      second.child.kill();
    }
  });

  test("timeout exits nonzero, emits JSON failure, and unregisters caller", async () => {
    const target = await registerTestMate();
    try {
      const proc = spawnCli("call", "--to", target.id, "--json", "--timeout-ms", "200", "no", "reply");
      const prompt = await waitForMessage(target.id);
      const { stdout, code } = await collectCli(proc);
      const data = JSON.parse(stdout) as { ok: boolean; command: string; error: string };
      expect(code).toBe(124);
      expect(data.ok).toBe(false);
      expect(data.command).toBe("call");
      expect(data.error).toContain("Timed out waiting for response");

      const mates = await listAllMates();
      expect(mates.some((mate) => mate.id === prompt.from_id)).toBe(false);
    } finally {
      await brokerPost("/unregister", { id: target.id });
      target.child.kill();
    }
  });
});

describe("chat", () => {
  beforeEach(async () => {
    await cleanupParentProcessMates();
  });

  test("sends multiple turns over one conversation id", async () => {
    const target = await registerTestMate();
    try {
      const proc = spawnCli(
        "chat",
        "--to",
        target.id,
        "--timeout-ms",
        "3000",
        "--turn",
        "first question",
        "--turn",
        "second question"
      );

      const firstPrompt = await waitForMessage(target.id, (msg) => msg.text.includes("first question"));
      const firstMeta = JSON.parse(firstPrompt.meta!);
      await sendCallResponse({
        fromId: target.id,
        toId: firstPrompt.from_id,
        requestId: firstMeta.request_id,
        text: "first answer",
      });

      const secondPrompt = await waitForMessage(target.id, (msg) => msg.text.includes("second question"));
      const secondMeta = JSON.parse(secondPrompt.meta!);
      await sendCallResponse({
        fromId: target.id,
        toId: secondPrompt.from_id,
        requestId: secondMeta.request_id,
        text: "second answer",
      });

      const { stdout, code } = await collectCli(proc);
      expect(code).toBe(0);
      expect(stdout).toContain("first answer");
      expect(stdout).toContain("second answer");
      expect(firstMeta.conversation_id).toBe(secondMeta.conversation_id);
      expect(firstPrompt.from_id).toBe(secondPrompt.from_id);
    } finally {
      await brokerPost("/unregister", { id: target.id });
      target.child.kill();
    }
  });
});
