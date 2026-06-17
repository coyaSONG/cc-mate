<div align="center">

# cc-mate

**Let your Claudes collaborate.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6?style=flat-square&logo=bun)](https://bun.sh)
[![MCP](https://img.shields.io/badge/protocol-MCP-8B5CF6?style=flat-square)](https://modelcontextprotocol.io)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-D97706?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)

Peer discovery, messaging, and task orchestration for Claude Code instances.<br/>
Run 5 sessions across different projects — any Claude can find the others, send messages, and delegate tasks.

</div>

---

## Why cc-mate?

Claude Code sessions are isolated by design. That's great for safety, terrible for collaboration. When you're running multiple sessions and need them to coordinate — review each other's work, split a refactor, ask for context — there's no built-in way.

cc-mate gives your Claude instances a shared nervous system: discovery, messaging, and structured task delegation, all over localhost.

## Demo

```
  Terminal 1 (api-server)              Terminal 2 (frontend)
  ┌────────────────────────┐           ┌────────────────────────┐
  │ Claude A               │           │ Claude B               │
  │                        │           │                        │
  │ > create_task:         │  ──task─> │ <channel> new task:    │
  │   "add CORS headers    │           │   "add CORS headers"   │
  │    for /api/v2"        │           │                        │
  │                        │           │ > accept_assignment    │
  │                        │  <event─  │ > ... working ...      │
  │ > accept_result        │  <result─ │ > report_result        │
  │   "LGTM, task done"   │           │   "Done, added to      │
  │                        │           │    server.ts:42"       │
  └────────────────────────┘           └────────────────────────┘
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/coyaSONG/cc-mate.git ~/cc-mate
cd ~/cc-mate
bun install
```

### 2. Register the MCP server

```bash
claude mcp add --scope user --transport stdio cc-mate -- bun ~/cc-mate/server.ts
```

### 3. Launch with channel support

```bash
claude --dangerously-load-development-channels server:cc-mate
```

The broker daemon starts automatically on first launch.

Use `--dangerously-skip-permissions` only when your Claude Code workflow already requires it; cc-mate itself only needs channel support.

> **Tip:** Create an alias:
> ```bash
> alias ccmate='claude --dangerously-load-development-channels server:cc-mate'
> ```

### 4. Check the local bridge

```bash
bun cli.ts doctor
bun cli.ts mates
```

### 5. Open a second session and try it

```
> List all mates on this machine
> Send a message to mate [id]: "what are you working on?"
```

## Use from Codex or a Shell

`cc-mate call` is the request/response path for non-Claude callers such as Codex. It registers a temporary caller with the broker, sends a `call_request` with a `request_id`, waits for a final `call_response`, then unregisters itself.

```bash
# If exactly one Claude session is visible, --to is optional.
bun cli.ts call --to <mate-id> "Review the current repository state and reply with the next action."

# Machine-readable output for automation.
bun cli.ts call --to <mate-id> --json --timeout 180 "Summarize the failing test and proposed fix."

# Multi-turn conversation over one conversation id.
bun cli.ts chat --to <mate-id> \
  --turn "What context do you have?" \
  --turn "Given that, what should Codex change first?"
```

Target selection is deterministic:
- `--to <id>` or `--target <id>` always wins and accepts an exact ID or unique prefix.
- Without `--to`, cc-mate auto-selects only when the selected scope has exactly one mate.
- `--scope machine|directory|repo` controls discovery for auto-selection and `mates`.

`doctor` checks Bun, broker health, visible mates, Claude Code CLI availability, and MCP registration:

```bash
bun cli.ts doctor --json
```

## Features

### Messaging

| Tool | Description |
|------|-------------|
| `list_mates` | Discover Claude Code instances — scoped to `machine`, `directory`, or `repo` |
| `send_message` | Send a message to another instance (arrives instantly via channel push) |
| `reply` | Reply to the latest inbound channel message |
| `respond_call` | Reply to a request/response call by `request_id` |
| `set_summary` | Describe what you're working on (visible to other mates) |
| `check_messages` | Manually poll for messages (fallback if not using channel mode) |

### Task Orchestration

One Claude can assign structured tasks to another, track progress, review results, and handle failures — all through a 7-state machine with automatic timeout escalation.

| Tool | Role | Description |
|------|------|-------------|
| `create_task` | Orchestrator | Assign a task to a worker with title, description, and deadlines |
| `accept_assignment` | Worker | Accept an assigned task (transitions to `in_progress`) |
| `decline_assignment` | Worker | Decline with a reason (orchestrator is notified) |
| `report_result` | Worker | Submit work for review with result text and artifact paths |
| `report_blocker` | Worker | Report you're stuck — orchestrator decides next step |
| `accept_result` | Orchestrator | Approve the result (task complete) |
| `reject_result` | Orchestrator | Reject with feedback (worker retries, deadline resets) |
| `resume_blocked_task` | Orchestrator | Unblock a task with guidance |
| `cancel_task` | Orchestrator | Cancel at any point |
| `list_my_tasks` | Both | List tasks by role and status |
| `get_task` | Both | Full task details with event history |

### Task Lifecycle

```
                  ┌─ decline ──────────> declined
                  │
  create_task ──> assigned ── accept ──> in_progress ── report ──> awaiting_review
                  │                        │  ^                         │
                  │[timeout]               │  │ reject                  │ accept
                  v                        v  │ (retry)                 v
                blocked <── blocker ──────┘  │                     completed
                  │                           │
                  └──── resume ───────────────┘

              cancel from any non-terminal state ──> cancelled
```

**Automatic safety nets:**
- **Assigned timeout** (default 5min) — worker didn't accept? Auto-escalate to orchestrator
- **Progress timeout** (default 2hr) — no result? Auto-escalate
- **Worker disconnect** — PID gone? Tasks move to `blocked`, orchestrator notified
- **Orchestrator disconnect** — PID gone? Tasks auto-cancelled, worker notified

## Architecture

```
                    ┌───────────────────────────────┐
                    │  broker daemon                │
                    │  localhost:7349 + SQLite      │
                    │                               │
                    │  tables: mates, messages,     │
                    │          tasks, task_events   │
                    │                               │
                    │  intervals:                   │
                    │    - stale mate cleanup (30s) │
                    │    - task timeout watch (30s) │
                    └───────┬───────────────┬───────┘
                            │               │
                       MCP server A    MCP server B
                       (stdio)         (stdio)
                            │               │
                       Claude A         Claude B
```

- **Broker** (`broker.ts`) — Singleton HTTP daemon. Auto-launched, auto-heals. Manages all state in SQLite.
- **MCP Server** (`server.ts`) — One per Claude Code session. Registers with broker, exposes 15 tools, pushes inbound events via [channel protocol](https://docs.anthropic.com/en/docs/claude-code/channels).
- **Task Engine** (`broker-tasks.ts`) — State machine with race-safe transitions, idempotency guarantees, and single-transaction atomicity (state + event + notification).

## CLI

```bash
bun cli.ts doctor                         # diagnostics for broker, Claude CLI, and visible mates
bun cli.ts status                         # broker status + all mates
bun cli.ts mates --scope repo             # list mates by machine, directory, or repo
bun cli.ts send <id> <msg>                # fire-and-forget message
bun cli.ts call --to <id> <msg>           # request/response call, prints final answer
bun cli.ts call --to <id> --json <msg>    # stable JSON envelope for automation
bun cli.ts chat --to <id> --turn <msg>    # multi-turn calls over one conversation id
bun cli.ts kill-broker                    # stop the broker
```

When installed or linked as a package, the same commands are available as `cc-mate ...`.

`call` and `chat` support:
- `--to <id>` / `--target <id>` for explicit target selection
- `--scope machine|directory|repo` for auto-selection
- `--timeout <seconds>` or `--timeout-ms <ms>` for the response deadline
- `--connect-timeout <seconds>` or `--connect-timeout-ms <ms>` for broker requests
- `--conversation-id <id>` or `--continue <id>` to group turns
- `--json` for parseable results and errors

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CC_MATE_PORT` | `7349` | Broker port |
| `CC_MATE_DB` | `~/.cc-mate.db` | SQLite database path |

## Requirements

- [Bun](https://bun.sh) v1.0+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) v2.1.80+
- claude.ai login (channels require it — API key auth won't work)

## Credits

Forked from [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp). Extended with task orchestration, timeout safety, disconnect recovery, and retry logic.

## License

MIT
