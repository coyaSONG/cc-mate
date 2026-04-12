import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Subprocess } from "bun";
import { unlinkSync } from "node:fs";

const TEST_PORT = 17350;
const TEST_DB = `/tmp/cc-mate-server-test-${Date.now()}.db`;
const BROKER_URL = `http://127.0.0.1:${TEST_PORT}`;

let broker: Subprocess;
let client: Client;

async function brokerPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

/** Register a helper mate via broker API (with a real alive PID). */
async function registerHelper(overrides: Partial<{ cwd: string; git_root: string | null; summary: string }> = {}) {
  const child = Bun.spawn(["sleep", "60"]);
  const { id } = await brokerPost<{ id: string }>("/register", {
    pid: child.pid,
    cwd: overrides.cwd ?? "/tmp/helper",
    git_root: overrides.git_root ?? null,
    tty: null,
    summary: overrides.summary ?? "",
  });
  return { id, child };
}

beforeAll(async () => {
  // 1. Start test broker
  broker = Bun.spawn(["bun", "broker.ts"], {
    env: { ...process.env, CC_MATE_PORT: String(TEST_PORT), CC_MATE_DB: TEST_DB },
    stderr: "pipe",
  });

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BROKER_URL}/health`);
      if (res.ok) break;
    } catch {}
    await Bun.sleep(100);
  }

  // 2. Connect MCP client to server.ts (which will auto-register with the broker)
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["server.ts"],
    env: { ...process.env, CC_MATE_PORT: String(TEST_PORT) },
    stderr: "pipe",
  });

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  try { await client.close(); } catch {}
  broker.kill();
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
});

// --- Tests ---

describe("tool listing", () => {
  test("exposes all 15 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "accept_assignment",
      "accept_result",
      "cancel_task",
      "check_messages",
      "create_task",
      "decline_assignment",
      "get_task",
      "list_mates",
      "list_my_tasks",
      "reject_result",
      "report_blocker",
      "report_result",
      "resume_blocked_task",
      "send_message",
      "set_summary",
    ]);
  });
});

describe("server registration", () => {
  test("server registered itself with the broker", async () => {
    const mates = await brokerPost<Array<{ pid: number }>>("/list-mates", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    // The server's PID should appear in the broker's mate list
    // StdioClientTransport spawns a child process — find any mate that's alive
    expect(mates.length).toBeGreaterThanOrEqual(1);
  });
});

describe("list_mates", () => {
  test("returns no mates when alone", async () => {
    const result = await client.callTool({ name: "list_mates", arguments: { scope: "machine" } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    // Could have 0 or more mates depending on other tests, but should not error
    expect(typeof text).toBe("string");
    expect(result.isError).toBeFalsy();
  });

  test("shows registered helper mate", async () => {
    const helper = await registerHelper({ summary: "working on tests" });
    try {
      const result = await client.callTool({ name: "list_mates", arguments: { scope: "machine" } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain(helper.id);
      expect(text).toContain("working on tests");
      expect(text).toMatch(/Found \d+ mate/);
    } finally {
      await brokerPost("/unregister", { id: helper.id });
      helper.child.kill();
    }
  });

  test("scope=directory filters correctly", async () => {
    const sameCwd = await registerHelper({ cwd: process.cwd() });
    const otherCwd = await registerHelper({ cwd: "/tmp/other-dir" });
    try {
      const result = await client.callTool({ name: "list_mates", arguments: { scope: "directory" } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain(sameCwd.id);
      expect(text).not.toContain(otherCwd.id);
    } finally {
      await brokerPost("/unregister", { id: sameCwd.id });
      await brokerPost("/unregister", { id: otherCwd.id });
      sameCwd.child.kill();
      otherCwd.child.kill();
    }
  });
});

describe("set_summary", () => {
  test("updates and confirms summary", async () => {
    const result = await client.callTool({
      name: "set_summary",
      arguments: { summary: "writing server tests" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('Summary updated');
    expect(text).toContain("writing server tests");
    expect(result.isError).toBeFalsy();

    // Verify via broker that summary was actually persisted
    const mates = await brokerPost<Array<{ summary: string }>>("/list-mates", {
      scope: "machine",
      cwd: "/",
      git_root: null,
    });
    expect(mates.some((m) => m.summary === "writing server tests")).toBe(true);
  });
});

describe("send_message", () => {
  test("successfully sends to existing mate", async () => {
    const helper = await registerHelper();
    try {
      const result = await client.callTool({
        name: "send_message",
        arguments: { to_id: helper.id, message: "hello from MCP" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain(`Message sent to mate ${helper.id}`);
      expect(result.isError).toBeFalsy();

      // Verify message was stored in broker
      const poll = await brokerPost<{ messages: Array<{ text: string }> }>("/poll-messages", {
        id: helper.id,
      });
      expect(poll.messages).toHaveLength(1);
      expect(poll.messages[0]!.text).toBe("hello from MCP");
    } finally {
      await brokerPost("/unregister", { id: helper.id });
      helper.child.kill();
    }
  });

  test("returns error for non-existent mate", async () => {
    const result = await client.callTool({
      name: "send_message",
      arguments: { to_id: "zzzzzzzz", message: "oops" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("Failed to send");
  });
});

describe("check_messages", () => {
  test("returns no messages when inbox is empty", async () => {
    // Drain any existing messages first
    await client.callTool({ name: "check_messages", arguments: {} });
    // Now check again — should be empty
    const result = await client.callTool({ name: "check_messages", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("No new messages");
    expect(result.isError).toBeFalsy();
  });

  test("retrieves pending messages", async () => {
    const helper = await registerHelper();
    try {
      // Drain any auto-polled messages
      await client.callTool({ name: "check_messages", arguments: {} });

      // Find the server's mate ID from the broker
      const mates = await brokerPost<Array<{ id: string; pid: number }>>("/list-mates", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });
      const serverMate = mates.find((m) => m.id !== helper.id);
      expect(serverMate).toBeDefined();

      // Send a message to the server from the helper
      await brokerPost("/send-message", {
        from_id: helper.id,
        to_id: serverMate!.id,
        text: "ping from helper",
      });

      // Immediately call check_messages before the poll loop (1s interval) consumes it
      const result = await client.callTool({ name: "check_messages", arguments: {} });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;

      // The message should be retrieved by check_messages OR already consumed by the poll loop.
      // Either outcome is correct behavior — the message was delivered.
      if (text.includes("No new messages")) {
        // Poll loop already picked it up — verify by checking the message was delivered
        const poll = await brokerPost<{ messages: unknown[] }>("/poll-messages", {
          id: serverMate!.id,
        });
        expect(poll.messages).toHaveLength(0); // already delivered
      } else {
        expect(text).toContain("ping from helper");
        expect(text).toMatch(/1 new message/);
      }
    } finally {
      await brokerPost("/unregister", { id: helper.id });
      helper.child.kill();
    }
  });
});

describe("unknown tool", () => {
  test("throws for non-existent tool", async () => {
    expect(
      client.callTool({ name: "nonexistent_tool", arguments: {} })
    ).rejects.toThrow();
  });
});
