#!/usr/bin/env bun
/**
 * cc-mate broker daemon
 *
 * A singleton HTTP server on localhost:7349 backed by SQLite.
 * Tracks all registered Claude Code mates and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListMatesRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Mate,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CC_MATE_PORT ?? "7349", 10);
const DB_PATH = process.env.CC_MATE_DB ?? `${process.env.HOME}/.cc-mate.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

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
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES mates(id),
    FOREIGN KEY (to_id) REFERENCES mates(id)
  )
`);

// Clean up stale mates (PIDs that no longer exist) on startup
function cleanStaleMates() {
  const mates = db.query("SELECT id, pid FROM mates").all() as { id: string; pid: number }[];
  for (const mate of mates) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(mate.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM mates WHERE id = ?", [mate.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [mate.id]);
    }
  }
}

cleanStaleMates();

// Periodically clean stale mates (every 30s)
setInterval(cleanStaleMates, 30_000);

// --- Prepared statements ---

const insertMate = db.prepare(`
  INSERT INTO mates (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE mates SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE mates SET summary = ? WHERE id = ?
`);

const deleteMate = db.prepare(`
  DELETE FROM mates WHERE id = ?
`);

const selectAllMates = db.prepare(`
  SELECT * FROM mates
`);

const selectMatesByDirectory = db.prepare(`
  SELECT * FROM mates WHERE cwd = ?
`);

const selectMatesByGitRoot = db.prepare(`
  SELECT * FROM mates WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate mate ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = db.query("SELECT id FROM mates WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deleteMate.run(existing.id);
  }

  insertMate.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListMates(body: ListMatesRequest): Mate[] {
  let mates: Mate[];

  switch (body.scope) {
    case "machine":
      mates = selectAllMates.all() as Mate[];
      break;
    case "directory":
      mates = selectMatesByDirectory.all(body.cwd) as Mate[];
      break;
    case "repo":
      if (body.git_root) {
        mates = selectMatesByGitRoot.all(body.git_root) as Mate[];
      } else {
        // No git root, fall back to directory
        mates = selectMatesByDirectory.all(body.cwd) as Mate[];
      }
      break;
    default:
      mates = selectAllMates.all() as Mate[];
  }

  // Exclude the requesting mate
  if (body.exclude_id) {
    mates = mates.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each mate's process is still alive
  return mates.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead mate
      deleteMate.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM mates WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Mate ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deleteMate.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", mates: (selectAllMates.all() as Mate[]).length });
      }
      return new Response("cc-mate broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-mates":
          return Response.json(handleListMates(body as ListMatesRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[cc-mate broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
