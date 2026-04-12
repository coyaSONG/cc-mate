# cc-mate Task Orchestration — Design Spec

**Date**: 2026-04-12
**Scope**: 1st spec — orchestrator + task protocol + blocking/timeout
**Status**: Draft

---

## 1. Overview

Extend cc-mate from a messaging-only system into a task-based orchestration platform. One Claude Code instance (orchestrator) can assign structured tasks to another (worker), track progress, review results, and handle failures — all through the existing broker + channel infrastructure.

### Out of scope (2nd spec)

- Parallel task distribution (fan-out to multiple workers)
- Room-based group discussion (broker fan-out)
- Hierarchical/sub-task structure
- Broker-level idempotency keys for create_task
- Automatic reassignment on block/timeout

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Assignment model | Push | Orchestrator selects worker via list_mates, assigns directly |
| Completion process | Review included | Worker reports result, orchestrator accepts or rejects |
| Escalation on block/timeout | Return to orchestrator | Broker transitions to blocked, orchestrator decides next step |
| Task hierarchy | Flat | No parent/child. Orchestrator creates separate tasks for decomposition |
| Worker accept/decline | Required | Worker must explicitly accept or decline (strict mode) |
| Declined state | Terminal | Reassignment requires a new create_task call |
| Tool granularity | Separate tools | 11 individual tools; LLM follows distinct action names more reliably than decision enums |
| Channel event format | Existing `<channel>` tag with extra attributes | No new XML tags; `kind="task_event"` attribute distinguishes from free messages |

## 3. Architecture

No new services or processes. The task layer is added on top of the existing broker daemon, MCP stdio server, SQLite database, and channel push infrastructure.

```
┌──────────────────────────────────────────────┐
│  broker (localhost:7349 + SQLite)            │
│                                              │
│  Existing: mates, messages                   │
│  New:      tasks, task_events                │
│  New:      timeout watch (30s interval)      │
│                                              │
│  New endpoints (11):                         │
│    /create-task, /list-tasks, /get-task,     │
│    /accept-assignment, /decline-assignment,  │
│    /report-result, /report-blocker,          │
│    /accept-result, /reject-result,           │
│    /resume-task, /cancel-task                │
└──────────┬──────────────────┬────────────────┘
           │                  │
     MCP server A        MCP server B
     (orchestrator)      (worker)
           │                  │
       Claude A           Claude B
```

### Data flow (happy path)

1. Orchestrator calls `create_task(to_id, title, desc)` via MCP tool
2. MCP server A → `POST /create-task` → broker
3. Broker: `tasks` INSERT (status=assigned) + `task_events` INSERT (created) + `messages` INSERT (to worker) — single transaction
4. Worker's poll picks up message → channel push → Claude B sees task immediately
5. Claude B calls `accept_assignment(task_id)` → broker: assigned → in_progress + event + message to orchestrator
6. Claude B works, then calls `report_result(task_id, result_text, artifact_paths)`
7. Broker: in_progress → awaiting_review + event + message to orchestrator
8. Orchestrator calls `accept_result(task_id)` → completed (terminal)

### Escalation paths

- Worker stuck → `report_blocker` → blocked + orchestrator notified
- Result rejected → `reject_result(feedback)` → back to in_progress (deadline reset)
- Accept timeout → `assigned_deadline` expires → broker auto-transitions to blocked
- Progress timeout → `progress_deadline` expires → broker auto-transitions to blocked
- Orchestrator cancels → `cancel_task` → cancelled (terminal)

## 4. Data Model

### New table: `tasks`

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                        -- 't_' + 8 random chars
  orchestrator_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,                       -- see state machine
  result_text TEXT,                           -- set on report_result
  artifact_paths TEXT,                        -- JSON array, optional
  blocker_reason TEXT,                        -- set on blocked
  decline_reason TEXT,                        -- set on declined
  reject_feedback TEXT,                       -- set on reject_result
  assigned_timeout_seconds INTEGER NOT NULL DEFAULT 300,
  progress_timeout_seconds INTEGER NOT NULL DEFAULT 7200,
  assigned_deadline TEXT NOT NULL,            -- ISO timestamp
  progress_deadline TEXT NOT NULL,            -- ISO timestamp
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (orchestrator_id) REFERENCES mates(id),
  FOREIGN KEY (worker_id) REFERENCES mates(id)
);

CREATE INDEX idx_tasks_worker_status
  ON tasks(worker_id, status);
CREATE INDEX idx_tasks_orchestrator_status
  ON tasks(orchestrator_id, status);
CREATE INDEX idx_tasks_assigned_deadline
  ON tasks(assigned_deadline)
  WHERE status = 'assigned';
CREATE INDEX idx_tasks_progress_deadline
  ON tasks(progress_deadline)
  WHERE status = 'in_progress';
```

### New table: `task_events`

```sql
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,                   -- see event types below
  actor_id TEXT NOT NULL,                     -- mate id or 'broker'
  from_status TEXT,                           -- state before transition
  to_status TEXT NOT NULL,                    -- state after transition
  payload TEXT,                               -- JSON, event-specific
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_task_events_task
  ON task_events(task_id, created_at);
```

Event types: `created`, `accepted`, `declined`, `blocked`, `resumed`, `result_reported`, `result_accepted`, `result_rejected`, `cancelled`, `timeout_assigned`, `timeout_progress`, `worker_disconnected`, `orchestrator_disconnected`

### Existing table: `messages` — add `meta` column

```sql
ALTER TABLE messages ADD COLUMN meta TEXT;
-- JSON or NULL
-- Free chat: meta IS NULL
-- Task event: { "task_id": "t_...", "event_type": "...", "to_status": "..." }
```

## 5. State Machine

### States (7)

| State | Terminal | Description |
|---|---|---|
| `assigned` | No | Task created, waiting for worker to accept |
| `in_progress` | No | Worker accepted, working |
| `awaiting_review` | No | Worker reported result, waiting for orchestrator review |
| `blocked` | No | Worker reported blocker, timeout fired, or worker disconnected |
| `completed` | Yes | Orchestrator accepted result |
| `declined` | Yes | Worker declined assignment |
| `cancelled` | Yes | Orchestrator cancelled, or orchestrator disconnected |

### Transitions (11)

| Transition | Actor | From | To | Side effects |
|---|---|---|---|---|
| `create_task` | Orchestrator | (new) | `assigned` | Set both deadlines; push to worker |
| `accept_assignment` | Worker | `assigned` | `in_progress` | Push to orchestrator |
| `decline_assignment` | Worker | `assigned` | `declined` | Store decline_reason; push to orchestrator |
| `timeout_assigned` | Broker | `assigned` | `blocked` | blocker_reason="assigned timeout"; push to orchestrator |
| `report_result` | Worker | `in_progress` | `awaiting_review` | Store result_text, artifact_paths; push to orchestrator |
| `report_blocker` | Worker | `in_progress` | `blocked` | Store blocker_reason; push to orchestrator |
| `timeout_progress` | Broker | `in_progress` | `blocked` | blocker_reason="progress timeout"; push to orchestrator |
| `accept_result` | Orchestrator | `awaiting_review` | `completed` | Push to worker |
| `reject_result` | Orchestrator | `awaiting_review` | `in_progress` | Overwrite reject_feedback; clear result_text/artifact_paths; reset progress_deadline; push to worker |
| `resume_blocked_task` | Orchestrator | `blocked` | `in_progress` | Optional note; reset progress_deadline; push to worker |
| `cancel_task` | Orchestrator | Any non-terminal | `cancelled` | Push to worker (if still registered) |

### Invariants

- Every transition is recorded in `task_events`
- Worker actions require `worker_id == caller`
- Orchestrator actions require `orchestrator_id == caller`
- Transitions from terminal states return `409 Conflict`
- State transition + messages INSERT + task_events INSERT run in a single SQLite transaction

## 6. MCP Tools (11 new)

Existing tools (`list_mates`, `send_message`, `set_summary`, `check_messages`) are unchanged.

| Tool | Caller | Parameters | Returns |
|---|---|---|---|
| `create_task` | Anyone | `to_id`, `title`, `description`, `assigned_timeout_seconds?` (300), `progress_timeout_seconds?` (7200) | `{ task_id, status, assigned_deadline, progress_deadline }` |
| `list_my_tasks` | Anyone | `role: "orchestrator"\|"worker"\|"both"`, `status?`, `include_terminal?` (false) | `Task[]` |
| `get_task` | Anyone | `task_id` | `Task` with events history |
| `accept_assignment` | Worker | `task_id` | `{ status: "in_progress" }` |
| `decline_assignment` | Worker | `task_id`, `reason` | `{ status: "declined" }` |
| `report_result` | Worker | `task_id`, `result_text`, `artifact_paths?` | `{ status: "awaiting_review" }` |
| `report_blocker` | Worker | `task_id`, `reason` | `{ status: "blocked" }` |
| `accept_result` | Orchestrator | `task_id` | `{ status: "completed" }` |
| `reject_result` | Orchestrator | `task_id`, `feedback` | `{ status: "in_progress", progress_deadline }` |
| `resume_blocked_task` | Orchestrator | `task_id`, `note?` | `{ status: "in_progress", progress_deadline }` |
| `cancel_task` | Orchestrator | `task_id` | `{ status: "cancelled" }` |

Authorization: Each tool passes the calling mate's `id` as `caller_id`. Broker checks against `orchestrator_id`/`worker_id`. Mismatch returns `403`.

## 7. Broker HTTP Endpoints (11 new)

All POST + JSON body. 1:1 mapping with MCP tools.

```
POST /create-task          { orchestrator_id, to_id, title, description,
                             assigned_timeout_seconds?, progress_timeout_seconds? }
POST /list-tasks           { caller_id, role, status?, include_terminal? }
POST /get-task             { caller_id, task_id }
POST /accept-assignment    { caller_id, task_id }
POST /decline-assignment   { caller_id, task_id, reason }
POST /report-result        { caller_id, task_id, result_text, artifact_paths? }
POST /report-blocker       { caller_id, task_id, reason }
POST /accept-result        { caller_id, task_id }
POST /reject-result        { caller_id, task_id, feedback }
POST /resume-task          { caller_id, task_id, note? }
POST /cancel-task          { caller_id, task_id }
```

### Error responses

| Code | Body | When |
|---|---|---|
| `403` | `{ error: "not authorized" }` | Caller is not the task's orchestrator/worker |
| `404` | `{ error: "task not found" }` | Invalid task_id |
| `409` | `{ error: "invalid transition", from_status, required_statuses }` | Terminal state or wrong source state |

## 8. Channel Event Payloads

Task events reuse the existing `<channel>` tag with additional attributes:

```xml
<channel source="cc-mate" from_id="abc12345" from_summary="..." from_cwd="..."
         kind="task_event" task_id="t_xyz98765"
         event_type="created" to_status="assigned">
New task assigned: "Fix login bug"
Description: The login form throws a 500 error on empty email...
Accept by: 2026-04-12T12:05:00Z
Complete by: 2026-04-12T14:00:00Z
Use accept_assignment to take it, or decline_assignment with a reason.
</channel>
```

Free-text messages have no `kind` attribute (unchanged).

### Event body templates

| event_type | To | Body summary |
|---|---|---|
| `created` | Worker | "New task assigned: {title}" + description + deadlines + action hint |
| `accepted` | Orchestrator | "Task accepted by {worker}" |
| `declined` | Orchestrator | "Task declined: {reason}" |
| `result_reported` | Orchestrator | "Result ready for review" + result_text preview |
| `result_accepted` | Worker | "Task completed" |
| `result_rejected` | Worker | "Result rejected: {feedback}" |
| `blocked` | Orchestrator | "Task blocked: {reason}" |
| `resumed` | Worker | "Task resumed" + optional note |
| `cancelled` | Other side | "Task cancelled" |
| `timeout_assigned` | Orchestrator | "Task timed out (worker did not accept in 5m)" |
| `timeout_progress` | Orchestrator | "Task timed out (no result in 2h)" |
| `worker_disconnected` | Orchestrator | "Worker disconnected (PID gone)" |
| `orchestrator_disconnected` | Worker | "Task cancelled (orchestrator disconnected)" |

## 9. Timeout Handling

### Ownership

Broker is the sole timeout owner. MCP servers do not monitor deadlines.

Broker runs `checkTaskTimeouts()` on a 30-second interval (same cycle as `cleanStaleMates`).

```
checkTaskTimeouts():
  now = ISO timestamp

  // Assigned timeout
  SELECT * FROM tasks WHERE status = 'assigned' AND assigned_deadline < now
  → transitionTask(id, 'assigned', 'blocked', actor='broker',
                   blocker_reason="assigned timeout")

  // Progress timeout
  SELECT * FROM tasks WHERE status = 'in_progress' AND progress_deadline < now
  → transitionTask(id, 'in_progress', 'blocked', actor='broker',
                   blocker_reason="progress timeout")
```

### Race freedom

SQLite single-writer + single broker process. `transitionTask` uses `UPDATE ... WHERE status = :from_status`, yielding 0 rows if already transitioned. No additional locking needed.

### Deadline reset

`reject_result` and `resume_blocked_task` reset `progress_deadline` to `now + progress_timeout_seconds`. The original `progress_timeout_seconds` value is preserved in the tasks row for reuse.

### Broker restart

Interval re-registers immediately. Max delay: 30 seconds. Task state is durable in SQLite.

## 10. Retry and Backoff

MCP server → broker HTTP call failure policy:

| Failure | Retries | Strategy |
|---|---|---|
| Network error (ECONNREFUSED, ETIMEDOUT) | Up to 2 | Exponential backoff: 1s, 2s |
| 4xx (403, 404, 409) | None | Return error to MCP tool immediately |
| 5xx (500, 502, 503) | Up to 2 | Fixed 1s interval |
| Response timeout (>5s) | Up to 1 | Immediate retry |

**Exception**: `/create-task` is never retried. Duplicate creation risk. On failure, return error → Claude checks `list_my_tasks` before retrying.

State transition calls are safe to retry due to idempotency guarantees (below).

## 11. Idempotency

### State transition idempotency (broker)

Core pattern in `transitionTask`:

```sql
UPDATE tasks SET status = :to, updated_at = :now, ...
WHERE id = :task_id AND status = :from
```

- 0 rows affected + current status == to_status → already done. Return `200 { ok: true, already_done: true }`.
- 0 rows affected + current status != to_status → conflict. Return `409`.
- 1 row affected → normal transition. Return `200 { ok: true }` + insert event/message.

Duplicate calls produce side effects (events, messages) exactly once.

### Message delivery (existing)

`messages.delivered` flag ensures at-most-once delivery via `/poll-messages`. No change needed.

### Channel push gap

If MCP server crashes between poll (delivered=1) and channel push, the event is lost. Acceptable trade-off for 1st spec. Workers/orchestrators can always call `list_my_tasks`/`get_task` to query current state.

## 12. Disconnect Recovery

`cleanStaleMates` (30s interval) is extended:

### Worker PID gone

```
For each non-terminal task where worker_id = dead mate:
  transitionTask(task.id, task.status, 'blocked', actor='broker',
                 blocker_reason="worker disconnected (PID gone)")
  → orchestrator gets channel push
```

### Orchestrator PID gone

```
For each non-terminal task where orchestrator_id = dead mate:
  transitionTask(task.id, task.status, 'cancelled', actor='broker')
  → worker gets channel push (if still alive)
```

**Order**: Task cleanup before mate deletion. Prevents FK constraint violations on messages INSERT.

**Rationale**:
- Worker death → `blocked`: gives orchestrator choice (create new task for another mate)
- Orchestrator death → `cancelled`: no reviewer means task is pointless; prevents worker from doing wasted work

## 13. Test Plan

### Unit tests (broker logic)

| Case | Verification |
|---|---|
| All 11 valid transitions | Each succeeds with correct state change |
| Invalid transitions | Terminal state → 409; wrong source state → 409 |
| Authorization | Worker calling orchestrator action → 403; vice versa |
| Timeout watch | Expired assigned_deadline → blocked; expired progress_deadline → blocked |
| Idempotent retry | Same transition twice → first succeeds, second returns already_done |
| Deadline reset | reject_result/resume → progress_deadline = now + timeout |

### Integration tests (broker + MCP server)

| Scenario | Flow |
|---|---|
| Happy path | create → accept → report_result → accept_result → completed |
| Decline path | create → decline → orchestrator notified |
| Block/resume | create → accept → report_blocker → resume → report_result → accept_result |
| Reject loop | report_result → reject(feedback) → report_result → accept → completed |
| Timeout assigned | create → 5m elapsed → auto blocked + orchestrator notified |
| Timeout progress | accept → 2h elapsed → auto blocked |
| Worker disconnect | kill worker PID → non-terminal tasks → blocked |
| Orchestrator disconnect | kill orchestrator PID → non-terminal tasks → cancelled |

### E2E tests

Real broker process + two MCP servers (or direct HTTP clients). Full happy path including channel push verification. Use short timeouts (assigned: 2s, progress: 5s) for real-time testing.

## 14. Future Work (2nd Spec)

- Parallel task distribution (fan-out to multiple workers simultaneously)
- Room-based group discussion (broker fan-out with room_id)
- Broker-level idempotency keys for create_task
- Automatic reassignment on block/timeout
- Task priority and tags
- Task hierarchy (parent/sub-task)
