#!/usr/bin/env bun
/**
 * cc-mate CLI
 *
 * Utility commands for managing the broker and inspecting mates.
 *
 * Usage:
 *   bun cli.ts status          — Show broker status and all mates
 *   bun cli.ts mates           — List all mates
 *   bun cli.ts send <id> <msg> — Send a message to a mate
 *   bun cli.ts kill-broker     — Stop the broker daemon
 */

const BROKER_PORT = parseInt(process.env.CC_MATE_PORT ?? "7349", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

async function brokerFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

const cmd = process.argv[2];

switch (cmd) {
  case "status": {
    try {
      const health = await brokerFetch<{ status: string; mates: number }>("/health");
      console.log(`Broker: ${health.status} (${health.mates} mate(s) registered)`);
      console.log(`URL: ${BROKER_URL}`);

      if (health.mates > 0) {
        const mates = await brokerFetch<
          Array<{
            id: string;
            pid: number;
            cwd: string;
            git_root: string | null;
            tty: string | null;
            summary: string;
            last_seen: string;
          }>
        >("/list-mates", {
          scope: "machine",
          cwd: "/",
          git_root: null,
        });

        console.log("\nMates:");
        for (const p of mates) {
          console.log(`  ${p.id}  PID:${p.pid}  ${p.cwd}`);
          if (p.summary) console.log(`         ${p.summary}`);
          if (p.tty) console.log(`         TTY: ${p.tty}`);
          console.log(`         Last seen: ${p.last_seen}`);
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "mates": {
    try {
      const mates = await brokerFetch<
        Array<{
          id: string;
          pid: number;
          cwd: string;
          git_root: string | null;
          tty: string | null;
          summary: string;
          last_seen: string;
        }>
      >("/list-mates", {
        scope: "machine",
        cwd: "/",
        git_root: null,
      });

      if (mates.length === 0) {
        console.log("No mates registered.");
      } else {
        for (const p of mates) {
          const parts = [`${p.id}  PID:${p.pid}  ${p.cwd}`];
          if (p.summary) parts.push(`  Summary: ${p.summary}`);
          console.log(parts.join("\n"));
        }
      }
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  case "send": {
    const toId = process.argv[3];
    const msg = process.argv.slice(4).join(" ");
    if (!toId || !msg) {
      console.error("Usage: bun cli.ts send <mate-id> <message>");
      process.exit(1);
    }
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: toId,
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${toId}`);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    break;
  }

  case "kill-broker": {
    try {
      const health = await brokerFetch<{ status: string; mates: number }>("/health");
      console.log(`Broker has ${health.mates} mate(s). Shutting down...`);
      // Find and kill the broker process on the port
      const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
      const pids = new TextDecoder()
        .decode(proc.stdout)
        .trim()
        .split("\n")
        .filter((p) => p);
      for (const pid of pids) {
        process.kill(parseInt(pid), "SIGTERM");
      }
      console.log("Broker stopped.");
    } catch {
      console.log("Broker is not running.");
    }
    break;
  }

  default:
    console.log(`cc-mate CLI

Usage:
  bun cli.ts status          Show broker status and all mates
  bun cli.ts mates           List all mates
  bun cli.ts send <id> <msg> Send a message to a mate
  bun cli.ts kill-broker     Stop the broker daemon`);
}
