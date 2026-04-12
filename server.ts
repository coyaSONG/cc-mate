#!/usr/bin/env bun
/**
 * cc-mate MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for mate discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:cc-mate
 *
 * With .mcp.json:
 *   { "cc-mate": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  MateId,
  Mate,
  RegisterResponse,
  PollMessagesResponse,
  Task,
  TransitionResponse,
  CreateTaskResponse,
  GetTaskResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "./shared/summarize.ts";

// --- Configuration ---

const BROKER_PORT = parseInt(process.env.CC_MATE_PORT ?? "7349", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = new URL("./broker.ts", import.meta.url).pathname;

// --- Broker communication ---

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
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`Broker error (${path}): ${res.status} ${err}`);
        }
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`Broker error (${path}): ${res.status} ${err}`);
      }

      return res.json() as Promise<T>;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Broker error")) throw e;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }

  throw new Error(`Broker fetch failed after retries: ${path}`);
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log("Starting broker daemon...");
  const proc = Bun.spawn(["bun", BROKER_SCRIPT], {
    stdio: ["ignore", "ignore", "inherit"],
    // Detach so the broker survives if this MCP server exits
    // On macOS/Linux, the broker will keep running
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[cc-mate] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

function getTty(): string | null {
  try {
    // Try to get the parent's tty from the process tree
    const ppid = process.ppid;
    if (ppid) {
      const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
      const tty = new TextDecoder().decode(proc.stdout).trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- State ---

let myId: MateId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "cc-mate", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
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
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_mates",
    description:
      "List other Claude Code instances running on this machine. Returns their ID, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of mate discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by mate ID. The message will be pushed into their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "The mate ID of the target Claude Code instance (from list_mates)",
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are currently working on. This is visible to other Claude Code instances when they list mates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Manually check for new messages from other Claude Code instances. Messages are normally pushed automatically via channel notifications, but you can use this as a fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "create_task",
    description: "Assign a task to another Claude Code instance. You become the orchestrator for this task. The worker receives it immediately via channel push.",
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
    description: "List tasks you are involved in. Filter by your role (orchestrator, worker, or both) and optionally by status.",
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
      properties: { task_id: { type: "string" as const, description: "The task ID" } },
      required: ["task_id"],
    },
  },
  {
    name: "accept_assignment",
    description: "Accept a task that was assigned to you. Transitions the task to in_progress.",
    inputSchema: {
      type: "object" as const,
      properties: { task_id: { type: "string" as const, description: "The task ID to accept" } },
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
        artifact_paths: { type: "array" as const, items: { type: "string" as const }, description: "File paths created or modified (optional)" },
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
      properties: { task_id: { type: "string" as const, description: "The task ID" } },
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
      properties: { task_id: { type: "string" as const, description: "The task ID to cancel" } },
      required: ["task_id"],
    },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_mates": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const mates = await brokerFetch<Mate[]>("/list-mates", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        if (mates.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).`,
              },
            ],
          };
        }

        const lines = mates.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `PID: ${p.pid}`,
            `CWD: ${p.cwd}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.tty) parts.push(`TTY: ${p.tty}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${mates.length} mate(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing mates: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Message sent to mate ${to_id}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return {
          content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "check_messages": {
      if (!myId) {
        return {
          content: [{ type: "text" as const, text: "Not registered with broker yet" }],
          isError: true,
        };
      }
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }
        const lines = result.messages.map(
          (m) => `From ${m.from_id} (${m.sent_at}):\n${m.text}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "create_task": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      const { to_id, title, description, assigned_timeout_seconds, progress_timeout_seconds } = args as {
        to_id: string; title: string; description: string;
        assigned_timeout_seconds?: number; progress_timeout_seconds?: number;
      };
      try {
        const result = await brokerFetch<CreateTaskResponse | { error: string }>("/create-task", {
          orchestrator_id: myId, to_id, title, description, assigned_timeout_seconds, progress_timeout_seconds,
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
        const result = await brokerFetch<TransitionResponse>(endpointMap[name]!, { caller_id: myId, ...args });
        if (!result.ok) return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
        if (result.already_done) return { content: [{ type: "text" as const, text: `Already done (idempotent).` }] };
        return { content: [{ type: "text" as const, text: `OK — task ${(args as { task_id: string }).task_id} is now ${result.task?.status}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) return;

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    for (const msg of result.messages) {
      const taskMeta = msg.meta ? JSON.parse(msg.meta) as {
        task_id: string; event_type: string; to_status: string;
      } : null;

      let fromSummary = "";
      let fromCwd = "";
      if (msg.from_id !== "broker") {
        try {
          const mates = await brokerFetch<Mate[]>("/list-mates", {
            scope: "machine", cwd: myCwd, git_root: myGitRoot,
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

// --- Startup ---

async function main() {
  // 1. Ensure broker is running
  await ensureBroker();

  // 2. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 3. Generate initial summary via gpt-5.4-nano (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  // 4. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
  });
  myId = reg.id;
  log(`Registered as mate ${myId}`);

  // If summary generation is still running, update it when done
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId) {
        try {
          await brokerFetch("/set-summary", { id: myId, summary: initialSummary });
          log(`Late auto-summary applied: ${initialSummary}`);
        } catch {
          // Non-critical
        }
      }
    });
  }

  // 5. Connect MCP over stdio
  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 6. Start polling for inbound messages
  const pollTimer = setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  // 7. Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    if (myId) {
      try {
        await brokerFetch("/heartbeat", { id: myId });
      } catch {
        // Non-critical
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Clean up on exit
  const cleanup = async () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
