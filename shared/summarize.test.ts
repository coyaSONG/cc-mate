import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { generateSummary, getGitBranch, getRecentFiles } from "./summarize.ts";

// --- generateSummary (mocked fetch, no real API calls) ---

describe("generateSummary", () => {
  const originalFetch = globalThis.fetch;
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedKey !== undefined) {
      process.env.OPENAI_API_KEY = savedKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test("returns null when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await generateSummary({ cwd: "/tmp", git_root: null });
    expect(result).toBeNull();
  });

  test("returns summary on successful API response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "  Working on cc-mate project.  " } }],
      })))
    ) as typeof fetch;

    const result = await generateSummary({
      cwd: "/home/dev/cc-mate",
      git_root: "/home/dev/cc-mate",
      git_branch: "main",
      recent_files: ["broker.ts", "server.ts"],
    });

    expect(result).toBe("Working on cc-mate project.");

    // Verify the request was made correctly
    const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("gpt-5.4-nano");
    expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  test("includes context fields in the prompt", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "summary" } }],
      })))
    ) as typeof fetch;

    await generateSummary({
      cwd: "/projects/app",
      git_root: "/projects/app",
      git_branch: "feature/auth",
      recent_files: ["auth.ts", "login.tsx"],
    });

    const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    const userContent = body.messages[1].content as string;
    expect(userContent).toContain("/projects/app");
    expect(userContent).toContain("feature/auth");
    expect(userContent).toContain("auth.ts, login.tsx");
  });

  test("returns null on non-ok API response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("rate limited", { status: 429 }))
    ) as typeof fetch;

    const result = await generateSummary({ cwd: "/tmp", git_root: null });
    expect(result).toBeNull();
  });

  test("returns null on network/timeout error", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.reject(new DOMException("The operation was aborted", "AbortError"))
    ) as typeof fetch;

    const result = await generateSummary({ cwd: "/tmp", git_root: null });
    expect(result).toBeNull();
  });

  test("returns null when choices array is empty", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ choices: [] })))
    ) as typeof fetch;

    const result = await generateSummary({ cwd: "/tmp", git_root: null });
    expect(result).toBeNull();
  });
});

// --- getGitBranch (real git commands) ---

describe("getGitBranch", () => {
  test("returns branch name in a git repo", async () => {
    const branch = await getGitBranch(process.cwd());
    expect(branch).toBeString();
    expect(branch!.length).toBeGreaterThan(0);
  });

  test("returns null for non-git directory", async () => {
    const branch = await getGitBranch("/tmp");
    expect(branch).toBeNull();
  });
});

// --- getRecentFiles (real git commands) ---

describe("getRecentFiles", () => {
  test("returns an array of file names", async () => {
    const files = await getRecentFiles(process.cwd());
    expect(Array.isArray(files)).toBe(true);
    // This repo has commits, so there should be files
    expect(files.length).toBeGreaterThan(0);
  });

  test("respects limit parameter", async () => {
    const files = await getRecentFiles(process.cwd(), 2);
    expect(files.length).toBeLessThanOrEqual(2);
  });

  test("returns empty array for non-git directory", async () => {
    const files = await getRecentFiles("/tmp");
    expect(files).toEqual([]);
  });

  test("returns deduplicated file names", async () => {
    const files = await getRecentFiles(process.cwd());
    const unique = new Set(files);
    expect(files.length).toBe(unique.size);
  });
});
