import { test, expect, describe } from "bun:test";
import { getGitBranch, getRecentFiles } from "./summarize.ts";

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
