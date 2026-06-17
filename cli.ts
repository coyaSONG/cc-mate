#!/usr/bin/env bun
/**
 * cc-mate CLI
 *
 * Utility commands for inspecting the broker and making request/response calls
 * to Claude Code sessions connected through the cc-mate channel.
 */

type Scope = "machine" | "directory" | "repo";
type CheckStatus = "ok" | "warn" | "fail";

interface Mate {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
}

interface Message {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
  delivered: boolean | number;
  meta: string | null;
}

interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

interface RuntimeContext {
  cwd: string;
  gitRoot: string | null;
}

interface CallTurnResult {
  ok: boolean;
  status: "ok" | "error";
  target_id: string;
  caller_id: string;
  request_id: string;
  conversation_id: string;
  answer: string;
  elapsed_ms: number;
  interim_messages: Array<{ text: string; sent_at: string }>;
}

class CliError extends Error {
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

const BROKER_PORT = parseInt(process.env.CC_MATE_PORT ?? "7349", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

function usage(): string {
  return `cc-mate CLI

Usage:
  bun cli.ts doctor [--json]
  bun cli.ts status [--json]
  bun cli.ts mates [--scope machine|directory|repo] [--json]
  bun cli.ts send <id> <msg>
  bun cli.ts call [--to <id>] [--scope machine|directory|repo] [--timeout <sec>] [--timeout-ms <ms>] [--json] <msg>
  bun cli.ts chat [--to <id>] [--scope machine|directory|repo] [--turn <msg> ...] [--json]
  bun cli.ts kill-broker

Examples:
  bun cli.ts doctor
  bun cli.ts call --to abc123xy "Review the current failure and reply with next steps"
  bun cli.ts chat --to abc123xy --turn "What is the current state?" --turn "What should Codex do next?"
`;
}

function parseArgs(
  raw: string[],
  opts: {
    boolean?: string[];
    value?: string[];
    repeat?: string[];
  } = {}
): ParsedArgs {
  const booleanFlags = new Set([...(opts.boolean ?? []), "help"]);
  const valueFlags = new Set(opts.value ?? []);
  const repeatFlags = new Set(opts.repeat ?? []);
  const flags: ParsedArgs["flags"] = {};
  const positionals: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    if (arg === "--") {
      positionals.push(...raw.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const name = arg.slice(2, eqIndex === -1 ? undefined : eqIndex);
    const inlineValue = eqIndex === -1 ? null : arg.slice(eqIndex + 1);

    if (booleanFlags.has(name)) {
      if (inlineValue !== null) throw new CliError(`Flag --${name} does not take a value`);
      flags[name] = true;
      continue;
    }

    if (!valueFlags.has(name) && !repeatFlags.has(name)) {
      throw new CliError(`Unknown flag --${name}`);
    }

    const value = inlineValue ?? raw[++i];
    if (value == null) throw new CliError(`Missing value for --${name}`);

    if (repeatFlags.has(name)) {
      const existing = flags[name];
      flags[name] = Array.isArray(existing) ? [...existing, value] : [value];
    } else {
      flags[name] = value;
    }
  }

  return { flags, positionals };
}

function flagString(parsed: ParsedArgs, ...names: string[]): string | null {
  for (const name of names) {
    const value = parsed.flags[name];
    if (typeof value === "string") return value;
  }
  return null;
}

function flagBoolean(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

function flagStrings(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags[name];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

function parseScope(value: string | null): Scope {
  if (!value) return "machine";
  if (value === "machine" || value === "directory" || value === "repo") return value;
  throw new CliError(`Invalid scope "${value}". Use machine, directory, or repo.`);
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliError(`${label} must be a positive number`);
  }
  return Math.ceil(parsed);
}

function parseTimeoutMs(parsed: ParsedArgs): number {
  const timeoutMs = flagString(parsed, "timeout-ms");
  if (timeoutMs) return parsePositiveInt(timeoutMs, "--timeout-ms");

  const timeoutSeconds = flagString(parsed, "timeout");
  if (timeoutSeconds) return parsePositiveInt(String(Number(timeoutSeconds) * 1000), "--timeout");

  return DEFAULT_CALL_TIMEOUT_MS;
}

function parseConnectTimeoutMs(parsed: ParsedArgs): number {
  const timeoutMs = flagString(parsed, "connect-timeout-ms");
  if (timeoutMs) return parsePositiveInt(timeoutMs, "--connect-timeout-ms");

  const timeoutSeconds = flagString(parsed, "connect-timeout");
  if (timeoutSeconds) return parsePositiveInt(String(Number(timeoutSeconds) * 1000), "--connect-timeout");

  return DEFAULT_CONNECT_TIMEOUT_MS;
}

async function brokerFetch<T>(
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new CliError(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function getGitRoot(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) {
      return new TextDecoder().decode(proc.stdout).trim() || null;
    }
  } catch {
    // not a git repo or git unavailable
  }
  return null;
}

function getContext(): RuntimeContext {
  const cwd = process.cwd();
  return { cwd, gitRoot: getGitRoot(cwd) };
}

async function listMates(scope: Scope, context: RuntimeContext, excludeId?: string): Promise<Mate[]> {
  return brokerFetch<Mate[]>("/list-mates", {
    scope,
    cwd: context.cwd,
    git_root: context.gitRoot,
    exclude_id: excludeId,
  });
}

function parseMeta(meta: string | null): Record<string, unknown> | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function makeRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `ccmate_${Date.now()}_${random}`;
}

function writeJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printCliError(command: string, err: unknown, json: boolean): number {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof CliError ? err.code : 1;
  if (json) {
    writeJson({ ok: false, command, error: message });
  } else {
    console.error(`Error: ${message}`);
  }
  return code;
}

function formatMate(mate: Mate): string {
  const parts = [`${mate.id}  PID:${mate.pid}  ${mate.cwd}`];
  if (mate.summary) parts.push(`Summary: ${mate.summary}`);
  if (mate.git_root) parts.push(`Repo: ${mate.git_root}`);
  if (mate.tty) parts.push(`TTY: ${mate.tty}`);
  parts.push(`Last seen: ${mate.last_seen}`);
  return parts.join("\n         ");
}

async function registerCaller(context: RuntimeContext, summary: string): Promise<string> {
  const reg = await brokerFetch<{ id: string }>("/register", {
    pid: process.pid,
    cwd: context.cwd,
    git_root: context.gitRoot,
    tty: null,
    summary,
  });
  return reg.id;
}

async function unregisterCaller(id: string, timeoutMs: number): Promise<void> {
  try {
    await brokerFetch("/unregister", { id }, timeoutMs);
  } catch {
    // Best effort cleanup.
  }
}

async function resolveTarget(parsed: ParsedArgs, context: RuntimeContext): Promise<Mate> {
  const explicitTarget = flagString(parsed, "to", "target");
  const scope = parseScope(flagString(parsed, "scope"));

  if (explicitTarget) {
    const mates = await listMates("machine", context);
    const exact = mates.find((mate) => mate.id === explicitTarget);
    if (exact) return exact;

    const prefixMatches = mates.filter((mate) => mate.id.startsWith(explicitTarget));
    if (prefixMatches.length === 1) return prefixMatches[0]!;
    if (prefixMatches.length > 1) {
      throw new CliError(
        `Target "${explicitTarget}" is ambiguous. Matching mates: ${prefixMatches.map((m) => m.id).join(", ")}`
      );
    }
    throw new CliError(`Mate ${explicitTarget} not found`);
  }

  const mates = await listMates(scope, context);
  if (mates.length === 0) {
    throw new CliError(`No mates found for scope "${scope}". Start Claude Code with cc-mate channel support first.`);
  }
  if (mates.length > 1) {
    throw new CliError(
      `Multiple mates found for scope "${scope}". Choose one with --to: ${mates.map((m) => m.id).join(", ")}`
    );
  }
  return mates[0]!;
}

function callPromptText(requestId: string, prompt: string): string {
  return [
    "[cc-mate call_request]",
    `request_id: ${requestId}`,
    `Use respond_call(request_id="${requestId}", message="Acknowledged, working on it...", final=false) immediately.`,
    `Use respond_call(request_id="${requestId}", message="your full response", final=true) for the final answer.`,
    "",
    "Prompt:",
    prompt,
  ].join("\n");
}

async function sendCallCancelled(args: {
  callerId: string;
  targetId: string;
  requestId: string;
  conversationId: string;
  timeoutMs: number;
}) {
  try {
    await brokerFetch("/send-message", {
      from_id: args.callerId,
      to_id: args.targetId,
      text: `Call request ${args.requestId} timed out on the caller side. Ignore any late response.`,
      meta: {
        kind: "call_cancelled",
        schema_version: 1,
        request_id: args.requestId,
        conversation_id: args.conversationId,
        created_at: new Date().toISOString(),
      },
    }, args.timeoutMs);
  } catch {
    // Advisory cancellation only.
  }
}

async function runCallTurn(args: {
  callerId: string;
  target: Mate;
  prompt: string;
  timeoutMs: number;
  connectTimeoutMs: number;
  conversationId: string;
  context: RuntimeContext;
}): Promise<CallTurnResult> {
  const requestId = makeRequestId();
  const startedAt = Date.now();
  const deadline = startedAt + args.timeoutMs;
  const interimMessages: CallTurnResult["interim_messages"] = [];

  const sendResult = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
    from_id: args.callerId,
    to_id: args.target.id,
    text: callPromptText(requestId, args.prompt),
    meta: {
      kind: "call_request",
      schema_version: 1,
      request_id: requestId,
      conversation_id: args.conversationId,
      reply_to: args.callerId,
      origin: "cc-mate-cli",
      created_at: new Date(startedAt).toISOString(),
      timeout_ms: args.timeoutMs,
      cwd: args.context.cwd,
      git_root: args.context.gitRoot,
    },
  }, args.connectTimeoutMs);

  if (!sendResult.ok) {
    throw new CliError(sendResult.error ?? "Failed to send call request");
  }

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const poll = await brokerFetch<{ messages: Message[] }>(
      "/poll-messages",
      { id: args.callerId },
      Math.min(args.connectTimeoutMs, remainingMs)
    );

    for (const msg of poll.messages) {
      if (msg.from_id !== args.target.id) continue;
      const meta = parseMeta(msg.meta);
      if (!meta || meta.kind !== "call_response" || meta.request_id !== requestId) continue;

      const final = meta.final !== false;
      const status = meta.status === "error" ? "error" : "ok";
      if (!final) {
        interimMessages.push({ text: msg.text, sent_at: msg.sent_at });
        continue;
      }

      const elapsedMs = Date.now() - startedAt;
      return {
        ok: status === "ok",
        status,
        target_id: args.target.id,
        caller_id: args.callerId,
        request_id: requestId,
        conversation_id: args.conversationId,
        answer: msg.text,
        elapsed_ms: elapsedMs,
        interim_messages: interimMessages,
      };
    }

    await Bun.sleep(Math.min(250, Math.max(25, deadline - Date.now())));
  }

  await sendCallCancelled({
    callerId: args.callerId,
    targetId: args.target.id,
    requestId,
    conversationId: args.conversationId,
    timeoutMs: args.connectTimeoutMs,
  });
  throw new CliError(`Timed out waiting for response from ${args.target.id} (${requestId})`, 124);
}

async function cmdDoctor(rawArgs: string[]): Promise<number> {
  const parsed = parseArgs(rawArgs, { boolean: ["json"] });
  if (flagBoolean(parsed, "help")) {
    console.log(usage());
    return 0;
  }
  const json = flagBoolean(parsed, "json");
  const checks: Array<{ name: string; status: CheckStatus; details: string; fix?: string }> = [];

  checks.push({ name: "bun", status: "ok", details: `Bun ${Bun.version}` });

  let health: { status: string; mates: number } | null = null;
  try {
    health = await brokerFetch<{ status: string; mates: number }>("/health");
    checks.push({ name: "broker", status: "ok", details: `${health.status} at ${BROKER_URL}` });
  } catch {
    checks.push({
      name: "broker",
      status: "fail",
      details: `No broker response at ${BROKER_URL}`,
      fix: "Launch Claude Code with the cc-mate MCP server, or run `bun broker.ts`.",
    });
  }

  if (health) {
    const context = getContext();
    try {
      const mates = await listMates("machine", context);
      checks.push({
        name: "mates",
        status: mates.length > 0 ? "ok" : "warn",
        details: `${mates.length} visible mate(s)`,
        fix: mates.length > 0 ? undefined : "Open a Claude Code session with channel support.",
      });
    } catch (e) {
      checks.push({
        name: "mates",
        status: "warn",
        details: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const claudeVersion = runCommand(["claude", "--version"]);
  if (claudeVersion.ok) {
    checks.push({ name: "claude", status: "ok", details: claudeVersion.output });
    const mcp = runCommand(["claude", "mcp", "get", "cc-mate"]);
    checks.push({
      name: "mcp",
      status: mcp.ok ? "ok" : "warn",
      details: mcp.ok ? "cc-mate MCP registration found" : "cc-mate MCP registration not confirmed",
      fix: mcp.ok ? undefined : "Run `claude mcp add --scope user --transport stdio cc-mate -- bun /path/to/cc-mate/server.ts`.",
    });
  } else {
    checks.push({
      name: "claude",
      status: "warn",
      details: "Claude Code CLI not found or not runnable",
      fix: "Install or log in to Claude Code before using channel calls.",
    });
  }

  const ok = checks.every((check) => check.status !== "fail");
  if (json) {
    writeJson({ ok, command: "doctor", broker_url: BROKER_URL, checks });
  } else {
    console.log(`cc-mate doctor (${BROKER_URL})`);
    for (const check of checks) {
      const label = check.status.toUpperCase().padEnd(4);
      console.log(`${label} ${check.name}: ${check.details}`);
      if (check.fix) console.log(`     fix: ${check.fix}`);
    }
  }
  return ok ? 0 : 1;
}

function runCommand(command: string[]): { ok: boolean; output: string } {
  try {
    const proc = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const output = stdout || stderr || `exit ${proc.exitCode}`;
    return { ok: proc.exitCode === 0, output };
  } catch {
    return { ok: false, output: "not found" };
  }
}

async function cmdStatus(rawArgs: string[]): Promise<number> {
  const parsed = parseArgs(rawArgs, { boolean: ["json"] });
  if (flagBoolean(parsed, "help")) {
    console.log(usage());
    return 0;
  }
  const json = flagBoolean(parsed, "json");
  try {
    const health = await brokerFetch<{ status: string; mates: number }>("/health");
    const context = getContext();
    const mates = await listMates("machine", context);
    if (json) {
      writeJson({ ok: true, command: "status", broker_url: BROKER_URL, health, mates });
    } else {
      console.log(`Broker: ${health.status} (${health.mates} mate(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);
      if (mates.length > 0) {
        console.log("\nMates:");
        for (const mate of mates) {
          console.log(`  ${formatMate(mate)}`);
        }
      }
    }
    return 0;
  } catch {
    if (json) writeJson({ ok: false, command: "status", broker_url: BROKER_URL, error: "Broker is not running." });
    else console.log("Broker is not running.");
    return 0;
  }
}

async function cmdMates(rawArgs: string[]): Promise<number> {
  const parsed = parseArgs(rawArgs, {
    boolean: ["json"],
    value: ["scope"],
  });
  if (flagBoolean(parsed, "help")) {
    console.log(usage());
    return 0;
  }
  const json = flagBoolean(parsed, "json");
  try {
    const context = getContext();
    const scope = parseScope(flagString(parsed, "scope"));
    const mates = await listMates(scope, context);
    if (json) {
      writeJson({ ok: true, command: "mates", scope, mates });
    } else if (mates.length === 0) {
      console.log("No mates registered.");
    } else {
      for (const mate of mates) {
        console.log(formatMate(mate));
      }
    }
    return 0;
  } catch (e) {
    return printCliError("mates", e instanceof Error ? e : new CliError("Broker is not running."), json);
  }
}

async function cmdSend(rawArgs: string[]): Promise<number> {
  const toId = rawArgs[0];
  const msg = rawArgs.slice(1).join(" ");
  if (!toId || !msg) {
    console.error("Usage: bun cli.ts send <mate-id> <message>");
    return 1;
  }
  try {
    const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
      from_id: "cli",
      to_id: toId,
      text: msg,
    });
    if (result.ok) {
      console.log(`Message sent to ${toId}`);
      return 0;
    }
    console.error(`Failed: ${result.error}`);
    return 1;
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function cmdCall(rawArgs: string[]): Promise<number> {
  const parsed = parseArgs(rawArgs, {
    boolean: ["json"],
    value: ["to", "target", "scope", "timeout", "timeout-ms", "connect-timeout", "connect-timeout-ms", "conversation-id", "continue"],
  });
  if (flagBoolean(parsed, "help")) {
    console.log(usage());
    return 0;
  }

  const json = flagBoolean(parsed, "json");
  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt) {
    return printCliError("call", new CliError("Usage: bun cli.ts call [--to <id>] <message>"), json);
  }

  let callerId: string | null = null;
  const connectTimeoutMs = parseConnectTimeoutMs(parsed);
  try {
    const context = getContext();
    const target = await resolveTarget(parsed, context);
    const timeoutMs = parseTimeoutMs(parsed);
    const conversationId = flagString(parsed, "conversation-id", "continue") ?? makeRequestId();
    callerId = await registerCaller(context, `cc-mate cli call to ${target.id}`);

    const result = await runCallTurn({
      callerId,
      target,
      prompt,
      timeoutMs,
      connectTimeoutMs,
      conversationId,
      context,
    });

    if (json) {
      writeJson({ ...result, command: "call", response: result.answer });
    } else {
      console.log(result.answer);
    }
    return result.ok ? 0 : 2;
  } catch (e) {
    return printCliError("call", e, json);
  } finally {
    if (callerId) await unregisterCaller(callerId, connectTimeoutMs);
  }
}

async function cmdChat(rawArgs: string[]): Promise<number> {
  const parsed = parseArgs(rawArgs, {
    boolean: ["json"],
    value: ["to", "target", "scope", "timeout", "timeout-ms", "connect-timeout", "connect-timeout-ms", "conversation-id", "continue"],
    repeat: ["turn"],
  });
  if (flagBoolean(parsed, "help")) {
    console.log(usage());
    return 0;
  }

  const json = flagBoolean(parsed, "json");
  const turns = flagStrings(parsed, "turn");
  if (turns.length === 0 && parsed.positionals.length > 0) {
    turns.push(parsed.positionals.join(" "));
  }
  if (turns.length === 0) {
    return printCliError("chat", new CliError("Usage: bun cli.ts chat [--to <id>] --turn <message> [--turn <message>]"), json);
  }

  let callerId: string | null = null;
  const connectTimeoutMs = parseConnectTimeoutMs(parsed);
  try {
    const context = getContext();
    const target = await resolveTarget(parsed, context);
    const timeoutMs = parseTimeoutMs(parsed);
    const conversationId = flagString(parsed, "conversation-id", "continue") ?? makeRequestId();
    callerId = await registerCaller(context, `cc-mate cli chat with ${target.id}`);
    const results: CallTurnResult[] = [];

    for (const turn of turns) {
      results.push(await runCallTurn({
        callerId,
        target,
        prompt: turn,
        timeoutMs,
        connectTimeoutMs,
        conversationId,
        context,
      }));
    }

    const ok = results.every((result) => result.ok);
    if (json) {
      writeJson({ ok, command: "chat", target_id: target.id, caller_id: callerId, conversation_id: conversationId, turns: results });
    } else {
      results.forEach((result, index) => {
        if (index > 0) console.log("\n---\n");
        console.log(result.answer);
      });
    }
    return ok ? 0 : 2;
  } catch (e) {
    return printCliError("chat", e, json);
  } finally {
    if (callerId) await unregisterCaller(callerId, connectTimeoutMs);
  }
}

async function cmdKillBroker(): Promise<number> {
  try {
    const health = await brokerFetch<{ status: string; mates: number }>("/health");
    console.log(`Broker has ${health.mates} mate(s). Shutting down...`);
    const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
    const pids = new TextDecoder()
      .decode(proc.stdout)
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of pids) {
      process.kill(parseInt(pid, 10), "SIGTERM");
    }
    console.log("Broker stopped.");
  } catch {
    console.log("Broker is not running.");
  }
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(usage());
      return 0;
    case "doctor":
      return cmdDoctor(args);
    case "status":
      return cmdStatus(args);
    case "mates":
      return cmdMates(args);
    case "send":
      return cmdSend(args);
    case "call":
      return cmdCall(args);
    case "chat":
      return cmdChat(args);
    case "kill-broker":
      return cmdKillBroker();
    default:
      console.log(usage());
      return 0;
  }
}

process.exit(await main());
