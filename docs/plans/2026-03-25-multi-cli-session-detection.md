# Multi-CLI Filesystem Session Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add filesystem-based session detection for Gemini CLI, Codex CLI, and Cursor Agent (similar to what Claude Code uses), and define a clear no-op fallback for GitHub Copilot which has no local session persistence.

**Architecture:** Each CLI that stores session files on disk gets a new `sessionDirType` value in the CLI registry and a corresponding backend reader function in `electron/cli-sessions.ts`. The `get_cli_sessions` IPC handler in `electron/main.ts` is generalized to dispatch based on `cliId`. The `resolveMissingSessionIds` function in `frontend/hooks/use-pty.ts` already passes `cliId` implicitly through the tab's `sessionType` — it needs to forward it explicitly to the backend.

**Tech Stack:** TypeScript (Node.js Electron main process), Vitest (electron test project, node environment), React (frontend), Zustand (state), `fs`/`path`/`os` (Node.js built-ins).

---

## Research Findings

### Gemini CLI (`gemini`)

**Session directory:** `~/.gemini/tmp/<project-name>/chats/`

**Project name mapping:** `~/.gemini/projects.json` maps absolute path → short name.
```json
{ "projects": { "/home/user/myproject": "myproject" } }
```

**Session file format:** `session-<ISO8601>-<uuid[:8]>.json`
- Example: `session-2026-03-23T21-51-bd268c2c.json`
- The 8-char suffix is the first 8 characters of the full UUID.
- File contents include: `sessionId` (full UUID), `startTime`, `lastUpdated`, `messages[]`.

**Resume flag:** `--resume <index>` where index is 1-based position in the list sorted by filename (chronological ascending), or `--resume latest`.
- **We store the full UUID as `cliSessionId`**. On resume, we look up the session's position in the sorted list and pass `--resume <index>`.

**What to implement:** `getGeminiSessions(projectPath)` → reads `projects.json` to find project name, lists files in `~/.gemini/tmp/<name>/chats/`, parses each JSON for `sessionId`/`lastUpdated`/first user message as `firstPrompt`.

---

### Codex CLI (`codex`)

**Session directory:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl`

**Project path:** Embedded in the JSONL file's first line (type `session_meta`):
```json
{ "timestamp": "...", "type": "session_meta", "payload": { "id": "<UUID>", "cwd": "/home/user/project", ... } }
```

**Session index:** `~/.codex/session_index.jsonl` — global index with `id`, `thread_name`, `updated_at` (no project path — lookup must scan session files or use cwd from session_meta).

**Resume flag:** `codex resume <UUID>` (positional argument to `codex resume` subcommand).
- The Forja `resumeFlag` for Codex is currently `--resume`. This needs to change: Codex uses `codex resume <UUID>` not `codex --resume <UUID>`.
- **Action required:** Update Codex `resumeFlag` and `extraArgs` handling — OR keep `resumeFlag: "resume"` and handle the fact that it goes before the session id as a positional.
- **Simpler approach:** Keep the existing resume invocation if it works, or document the discrepancy. The actual spawn call in `terminal-session.tsx` builds `[resumeFlag, sessionId]` — this would produce `["--resume", "<UUID>"]` which is wrong for Codex. We need to fix the Codex resumeFlag to use the subcommand pattern.

**What to implement:** `getCodexSessions(projectPath)` → scans `~/.codex/sessions/` recursively for `.jsonl` files, reads first line of each (the `session_meta`), filters by `payload.cwd === projectPath`, returns sorted by date.

---

### Cursor Agent (`cursor-agent`)

**Session directory:** `~/.cursor/projects/<encoded-path>/agent-transcripts/`

**Path encoding:** Same approach as Claude Code but without the leading dash:
- Claude: `/home/user/project` → `-home-user-project`
- Cursor: `/home/user/project` → `home-user-project` (leading `/` becomes empty before first segment)

**Session files:** Each session is either:
- A flat file: `<UUID>.jsonl`
- A subdirectory: `<UUID>/<UUID>.jsonl`

**Session file format:** JSONL of `{ role, message }` objects — the session ID is the UUID from the filename, not embedded in content.

**Resume flag:** `--resume <UUID>` (matches existing `resumeFlag: "--resume="` pattern — but wait, the existing registry has `resumeFlag: "--resume="` which would produce `--resume=<UUID>`, need to verify this is correct for cursor-agent).

**What to implement:** `getCursorSessions(projectPath)` → encodes path (drop leading slash, replace `/` with `-`), lists `~/.cursor/projects/<encoded>/agent-transcripts/`, finds `.jsonl` files in both flat and subdirectory formats, session ID = UUID from filename.

---

### GitHub Copilot (`gh-copilot`)

**No local session files found.** The `gh copilot` CLI (binary: `copilot`) does not persist session history on disk in any inspected location (`~/.config/github-copilot/`, `~/.config/gh/`, `~/.local/share/`). Sessions are server-side only.

**Action:** No `sessionDirType` added. `chatSupported: false` already set. The IPC handler returns `[]` for this CLI. Document this as intentional.

---

## Task Structure

---

### Task 1: Add `getGeminiSessions` to `electron/cli-sessions.ts`

**Files:**
- Modify: `electron/cli-sessions.ts`
- Create: `electron/__tests__/cli-sessions.test.ts`

**Step 1: Create the test file and write a failing test for `getGeminiSessions`**

Create `electron/__tests__/cli-sessions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";

vi.mock("fs");
vi.mock("os");

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);

describe("cli-sessions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockOs.homedir.mockReturnValue("/home/testuser");
  });

  describe("getGeminiSessions", () => {
    it("returns empty array when projects.json does not exist", async () => {
      mockFs.readFileSync.mockImplementation((p) => {
        throw new Error("ENOENT");
      });
      mockFs.readdirSync.mockReturnValue([]);

      const { getGeminiSessions } = await import("../cli-sessions");
      const result = getGeminiSessions("/home/user/myproject");
      expect(result).toEqual([]);
    });

    it("returns empty array when project is not in projects.json", async () => {
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        if (String(p).endsWith("projects.json")) {
          return JSON.stringify({ projects: { "/other/project": "other" } });
        }
        throw new Error("ENOENT");
      });
      mockFs.readdirSync.mockReturnValue([]);

      const { getGeminiSessions } = await import("../cli-sessions");
      const result = getGeminiSessions("/home/user/myproject");
      expect(result).toEqual([]);
    });

    it("returns sessions sorted newest first", async () => {
      const session1 = {
        sessionId: "aaaabbbb-0000-0000-0000-000000000001",
        startTime: "2026-03-01T10:00:00.000Z",
        lastUpdated: "2026-03-01T10:05:00.000Z",
        messages: [{ type: "user", content: [{ text: "first prompt" }] }],
      };
      const session2 = {
        sessionId: "ccccdddd-0000-0000-0000-000000000002",
        startTime: "2026-03-02T10:00:00.000Z",
        lastUpdated: "2026-03-02T10:05:00.000Z",
        messages: [{ type: "user", content: [{ text: "second prompt" }] }],
      };

      mockFs.readFileSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.endsWith("projects.json")) {
          return JSON.stringify({ projects: { "/home/user/myproject": "myproject" } });
        }
        if (ps.includes("session-2026-03-01")) return JSON.stringify(session1);
        if (ps.includes("session-2026-03-02")) return JSON.stringify(session2);
        throw new Error("ENOENT");
      });
      mockFs.readdirSync.mockReturnValue([
        "session-2026-03-01T10-00-aaaabbbb.json",
        "session-2026-03-02T10-00-ccccdddd.json",
      ] as unknown as fs.Dirent[]);

      const { getGeminiSessions } = await import("../cli-sessions");
      const result = getGeminiSessions("/home/user/myproject");

      expect(result).toHaveLength(2);
      // Newest first
      expect(result[0].sessionId).toBe("ccccdddd-0000-0000-0000-000000000002");
      expect(result[1].sessionId).toBe("aaaabbbb-0000-0000-0000-000000000001");
    });

    it("extracts firstPrompt from first user message", async () => {
      const session = {
        sessionId: "aaaabbbb-0000-0000-0000-000000000001",
        startTime: "2026-03-01T10:00:00.000Z",
        lastUpdated: "2026-03-01T10:05:00.000Z",
        messages: [
          { type: "user", content: [{ text: "hello world" }] },
          { type: "gemini", content: "response" },
        ],
      };

      mockFs.readFileSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.endsWith("projects.json")) {
          return JSON.stringify({ projects: { "/home/user/myproject": "myproject" } });
        }
        return JSON.stringify(session);
      });
      mockFs.readdirSync.mockReturnValue([
        "session-2026-03-01T10-00-aaaabbbb.json",
      ] as unknown as fs.Dirent[]);

      const { getGeminiSessions } = await import("../cli-sessions");
      const result = getGeminiSessions("/home/user/myproject");

      expect(result[0].firstPrompt).toBe("hello world");
    });

    it("respects the limit parameter", async () => {
      const makeSession = (id: string, date: string) => ({
        sessionId: `${id}-0000-0000-0000-000000000000`,
        startTime: `${date}T10:00:00.000Z`,
        lastUpdated: `${date}T10:05:00.000Z`,
        messages: [],
      });

      const sessions = [
        ["aaaa1111", "2026-03-01"],
        ["bbbb2222", "2026-03-02"],
        ["cccc3333", "2026-03-03"],
      ];

      mockFs.readFileSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.endsWith("projects.json")) {
          return JSON.stringify({ projects: { "/home/user/myproject": "myproject" } });
        }
        const found = sessions.find(([id, date]) => ps.includes(id.slice(0, 8)));
        if (found) return JSON.stringify(makeSession(found[0], found[1]));
        throw new Error("ENOENT");
      });
      mockFs.readdirSync.mockReturnValue(
        sessions.map(([id, date]) => `session-${date}T10-00-${id.slice(0, 8)}.json`) as unknown as fs.Dirent[]
      );

      const { getGeminiSessions } = await import("../cli-sessions");
      const result = getGeminiSessions("/home/user/myproject", 2);
      expect(result).toHaveLength(2);
    });

    it("skips malformed session files gracefully", async () => {
      mockFs.readFileSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.endsWith("projects.json")) {
          return JSON.stringify({ projects: { "/home/user/myproject": "myproject" } });
        }
        if (ps.includes("good")) {
          return JSON.stringify({
            sessionId: "goodgood-0000-0000-0000-000000000001",
            startTime: "2026-03-01T10:00:00.000Z",
            lastUpdated: "2026-03-01T10:05:00.000Z",
            messages: [],
          });
        }
        return "not valid json {{{";
      });
      mockFs.readdirSync.mockReturnValue([
        "session-2026-03-01T10-00-goodgood.json",
        "session-2026-03-01T11-00-badbadba.json",
      ] as unknown as fs.Dirent[]);

      const { getGeminiSessions } = await import("../cli-sessions");
      const result = getGeminiSessions("/home/user/myproject");
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe("goodgood-0000-0000-0000-000000000001");
    });
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd /home/nandomoreira/dev/projects/forja
pnpm test electron/__tests__/cli-sessions.test.ts --project electron --reporter=verbose
```

Expected: FAIL — `getGeminiSessions is not a function` (export doesn't exist yet).

**Step 3: Implement `getGeminiSessions` in `electron/cli-sessions.ts`**

Add after the existing `getMostRecentClaudeSession` function:

```typescript
/**
 * Reads the Gemini projects.json and returns the project name for a given path.
 * Returns null if the path is not registered in projects.json.
 */
function getGeminiProjectName(projectPath: string): string | null {
  const projectsJsonPath = path.join(os.homedir(), ".gemini", "projects.json");
  try {
    const raw = fs.readFileSync(projectsJsonPath, "utf-8");
    const data = JSON.parse(raw) as { projects?: Record<string, string> };
    return data.projects?.[projectPath] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extracts the first user text prompt from a Gemini session's messages array.
 */
function extractGeminiFirstPrompt(
  messages: Array<{ type: string; content: unknown }>
): string | undefined {
  const firstUser = messages.find((m) => m.type === "user");
  if (!firstUser) return undefined;
  const content = firstUser.content;
  if (Array.isArray(content)) {
    const textPart = (content as Array<{ text?: string }>).find((c) => c.text);
    return textPart?.text;
  }
  return undefined;
}

/**
 * Lists Gemini CLI sessions for a project by scanning session JSON files in
 * ~/.gemini/tmp/<project-name>/chats/.
 *
 * Requires the project path to be registered in ~/.gemini/projects.json.
 * Returns entries sorted by lastUpdated (newest first).
 */
export function getGeminiSessions(projectPath: string, limit = 20): CliSessionEntry[] {
  const projectName = getGeminiProjectName(projectPath);
  if (!projectName) return [];

  const chatsDir = path.join(os.homedir(), ".gemini", "tmp", projectName, "chats");

  let files: string[];
  try {
    files = (fs.readdirSync(chatsDir) as unknown as string[]).filter(
      (f) => f.endsWith(".json") && f.startsWith("session-")
    );
  } catch {
    return [];
  }

  const entries: CliSessionEntry[] = [];

  for (const filename of files) {
    const fullPath = path.join(chatsDir, filename);
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const data = JSON.parse(raw) as {
        sessionId?: string;
        startTime?: string;
        lastUpdated?: string;
        messages?: Array<{ type: string; content: unknown }>;
      };

      if (!data.sessionId || !data.lastUpdated) continue;

      entries.push({
        sessionId: data.sessionId,
        firstPrompt: extractGeminiFirstPrompt(data.messages ?? []),
        modified: data.lastUpdated,
        created: data.startTime,
      });
    } catch {
      // Skip malformed files
    }
  }

  entries.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
  );

  return entries.slice(0, limit);
}

/**
 * Finds the most recently modified Gemini session for a project.
 */
export function getMostRecentGeminiSession(projectPath: string): CliSessionEntry | null {
  const sessions = getGeminiSessions(projectPath, 1);
  return sessions[0] ?? null;
}
```

**Step 4: Run the tests and verify they pass**

```bash
pnpm test electron/__tests__/cli-sessions.test.ts --project electron --reporter=verbose
```

Expected: All `getGeminiSessions` tests pass.

---

### Task 2: Add `getCodexSessions` to `electron/cli-sessions.ts`

**Files:**
- Modify: `electron/cli-sessions.ts`
- Modify: `electron/__tests__/cli-sessions.test.ts` (add tests)

**Step 1: Add failing tests for `getCodexSessions`**

Append to the `describe("cli-sessions")` block in `electron/__tests__/cli-sessions.test.ts`:

```typescript
  describe("getCodexSessions", () => {
    it("returns empty array when sessions directory does not exist", async () => {
      mockFs.readdirSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const { getCodexSessions } = await import("../cli-sessions");
      const result = getCodexSessions("/home/user/myproject");
      expect(result).toEqual([]);
    });

    it("filters sessions by cwd matching projectPath", async () => {
      const sessionMeta = JSON.stringify({
        timestamp: "2026-03-01T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "019cb48b-8579-7c50-bd3f-e19aeec78140",
          timestamp: "2026-03-01T10:00:00.000Z",
          cwd: "/home/user/myproject",
        },
      });
      const otherMeta = JSON.stringify({
        timestamp: "2026-03-01T09:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "deadbeef-0000-0000-0000-000000000000",
          timestamp: "2026-03-01T09:00:00.000Z",
          cwd: "/home/user/otherproject",
        },
      });

      // Simulate directory tree: ~/.codex/sessions/2026/03/01/
      mockFs.readdirSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.endsWith("sessions")) return ["2026"] as unknown as fs.Dirent[];
        if (ps.endsWith("2026")) return ["03"] as unknown as fs.Dirent[];
        if (ps.endsWith("03")) return ["01"] as unknown as fs.Dirent[];
        if (ps.endsWith("01")) {
          return [
            "rollout-2026-03-01T10-00-00-019cb48b-8579-7c50-bd3f-e19aeec78140.jsonl",
            "rollout-2026-03-01T09-00-00-deadbeef-0000-0000-0000-000000000000.jsonl",
          ] as unknown as fs.Dirent[];
        }
        return [] as unknown as fs.Dirent[];
      });

      mockFs.statSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        // Return isFile for .jsonl, isDirectory for directories
        if (ps.endsWith(".jsonl")) {
          return { isDirectory: () => false, isFile: () => true, mtime: new Date("2026-03-01T10:00:00Z") } as unknown as fs.Stats;
        }
        return { isDirectory: () => true, isFile: () => false, mtime: new Date() } as unknown as fs.Stats;
      });

      mockFs.readFileSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.includes("019cb48b")) return sessionMeta + "\n";
        if (ps.includes("deadbeef")) return otherMeta + "\n";
        throw new Error("ENOENT");
      });

      const { getCodexSessions } = await import("../cli-sessions");
      const result = getCodexSessions("/home/user/myproject");

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe("019cb48b-8579-7c50-bd3f-e19aeec78140");
    });

    it("returns sessions sorted newest first by timestamp", async () => {
      const makeMeta = (id: string, cwd: string, ts: string) =>
        JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, cwd, timestamp: ts } });

      mockFs.readdirSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.endsWith("sessions")) return ["2026"] as unknown as fs.Dirent[];
        if (ps.endsWith("2026")) return ["03"] as unknown as fs.Dirent[];
        if (ps.endsWith("03")) return ["01"] as unknown as fs.Dirent[];
        if (ps.endsWith("01")) {
          return [
            "rollout-2026-03-01T08-00-00-aaaaaaaa-0000-0000-0000-000000000001.jsonl",
            "rollout-2026-03-01T09-00-00-bbbbbbbb-0000-0000-0000-000000000002.jsonl",
          ] as unknown as fs.Dirent[];
        }
        return [] as unknown as fs.Dirent[];
      });

      mockFs.statSync.mockImplementation(() => ({
        isDirectory: () => false,
        isFile: () => true,
        mtime: new Date(),
      }) as unknown as fs.Stats);

      mockFs.readFileSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.includes("aaaaaaaa")) {
          return makeMeta("aaaaaaaa-0000-0000-0000-000000000001", "/home/user/myproject", "2026-03-01T08:00:00.000Z") + "\n";
        }
        if (ps.includes("bbbbbbbb")) {
          return makeMeta("bbbbbbbb-0000-0000-0000-000000000002", "/home/user/myproject", "2026-03-01T09:00:00.000Z") + "\n";
        }
        throw new Error("ENOENT");
      });

      const { getCodexSessions } = await import("../cli-sessions");
      const result = getCodexSessions("/home/user/myproject");

      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe("bbbbbbbb-0000-0000-0000-000000000002");
    });

    it("skips files with missing or malformed session_meta", async () => {
      mockFs.readdirSync.mockImplementation((p: unknown) => {
        const ps = String(p);
        if (ps.endsWith("sessions")) return ["2026"] as unknown as fs.Dirent[];
        if (ps.endsWith("2026")) return ["03"] as unknown as fs.Dirent[];
        if (ps.endsWith("03")) return ["01"] as unknown as fs.Dirent[];
        if (ps.endsWith("01")) return ["rollout-bad.jsonl"] as unknown as fs.Dirent[];
        return [] as unknown as fs.Dirent[];
      });
      mockFs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true, mtime: new Date() } as unknown as fs.Stats);
      mockFs.readFileSync.mockReturnValue("not-json-at-all\n");

      const { getCodexSessions } = await import("../cli-sessions");
      const result = getCodexSessions("/home/user/myproject");
      expect(result).toEqual([]);
    });
  });
```

**Step 2: Run to verify they fail**

```bash
pnpm test electron/__tests__/cli-sessions.test.ts --project electron --reporter=verbose
```

Expected: FAIL — `getCodexSessions is not a function`.

**Step 3: Implement `getCodexSessions` in `electron/cli-sessions.ts`**

Add after `getMostRecentGeminiSession`:

```typescript
/**
 * Recursively finds all .jsonl files under a directory, walking up to maxDepth
 * levels deep. Used to scan ~/.codex/sessions/YYYY/MM/DD/ structure.
 */
function findJsonlFilesRecursive(dir: string, maxDepth = 4): string[] {
  const results: string[] = [];

  function walk(current: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(current) as unknown as string[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (stat.isFile() && entry.endsWith(".jsonl")) {
          results.push(fullPath);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Reads the first line of a JSONL file and parses it as the Codex session_meta record.
 * Returns null if the file does not start with a valid session_meta entry.
 */
function readCodexSessionMeta(
  filePath: string
): { id: string; cwd: string; timestamp: string } | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const firstLine = raw.split("\n")[0];
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: string; cwd?: string; timestamp?: string };
    };

    if (parsed.type !== "session_meta") return null;
    const { id, cwd, timestamp } = parsed.payload ?? {};
    if (!id || !cwd || !timestamp) return null;

    return { id, cwd, timestamp };
  } catch {
    return null;
  }
}

/**
 * Lists Codex CLI sessions for a project by scanning ~/.codex/sessions/ recursively
 * and filtering by the cwd embedded in each session's session_meta record.
 *
 * Returns entries sorted by session timestamp (newest first).
 */
export function getCodexSessions(projectPath: string, limit = 20): CliSessionEntry[] {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  const allFiles = findJsonlFilesRecursive(sessionsDir, 4);

  const entries: CliSessionEntry[] = [];

  for (const filePath of allFiles) {
    const meta = readCodexSessionMeta(filePath);
    if (!meta) continue;
    if (meta.cwd !== projectPath) continue;

    entries.push({
      sessionId: meta.id,
      modified: meta.timestamp,
      created: meta.timestamp,
    });
  }

  entries.sort(
    (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
  );

  return entries.slice(0, limit);
}

/**
 * Finds the most recently modified Codex session for a project.
 */
export function getMostRecentCodexSession(projectPath: string): CliSessionEntry | null {
  const sessions = getCodexSessions(projectPath, 1);
  return sessions[0] ?? null;
}
```

**Step 4: Run the tests and verify they pass**

```bash
pnpm test electron/__tests__/cli-sessions.test.ts --project electron --reporter=verbose
```

Expected: All `getCodexSessions` tests pass.

---

### Task 3: Add `getCursorSessions` to `electron/cli-sessions.ts`

**Files:**
- Modify: `electron/cli-sessions.ts`
- Modify: `electron/__tests__/cli-sessions.test.ts` (add tests)

**Step 1: Add failing tests for `getCursorSessions`**

Append to `electron/__tests__/cli-sessions.test.ts`:

```typescript
  describe("getCursorSessions", () => {
    it("returns empty array when project directory does not exist", async () => {
      mockFs.readdirSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const { getCursorSessions } = await import("../cli-sessions");
      const result = getCursorSessions("/home/user/myproject");
      expect(result).toEqual([]);
    });

    it("encodes project path by replacing slashes with dashes (no leading dash)", async () => {
      // "/home/user/myproject" -> "home-user-myproject"
      mockFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);

      const { getCursorSessions } = await import("../cli-sessions");
      getCursorSessions("/home/testuser/myproject");

      // Should have attempted to read "~/.cursor/projects/home-testuser-myproject/agent-transcripts"
      const calls = (mockFs.readdirSync as ReturnType<typeof vi.fn>).mock.calls;
      const attemptedPath = calls[0][0] as string;
      expect(attemptedPath).toContain("home-testuser-myproject");
      expect(attemptedPath).not.toMatch(/^-/); // no leading dash
      expect(attemptedPath).toContain("agent-transcripts");
    });

    it("detects flat .jsonl sessions (UUID.jsonl)", async () => {
      const uuid = "446f350e-3232-409a-b688-d49af7d93cb2";
      const filename = `${uuid}.jsonl`;

      mockFs.readdirSync.mockReturnValue([filename] as unknown as fs.Dirent[]);
      mockFs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        mtime: new Date("2026-03-10T12:00:00Z"),
      } as unknown as fs.Stats);

      const { getCursorSessions } = await import("../cli-sessions");
      const result = getCursorSessions("/home/testuser/myproject");

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe(uuid);
    });

    it("detects subdirectory sessions (UUID/UUID.jsonl)", async () => {
      const uuid = "82503306-320f-4f37-be38-1633828d8ed8";

      // First readdirSync returns the subdirectory, second returns the file inside
      mockFs.readdirSync
        .mockReturnValueOnce([uuid] as unknown as fs.Dirent[])
        .mockReturnValueOnce([`${uuid}.jsonl`] as unknown as fs.Dirent[]);

      mockFs.statSync
        .mockReturnValueOnce({ isDirectory: () => true, isFile: () => false, mtime: new Date() } as unknown as fs.Stats)
        .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true, mtime: new Date("2026-03-11T12:00:00Z") } as unknown as fs.Stats);

      const { getCursorSessions } = await import("../cli-sessions");
      const result = getCursorSessions("/home/testuser/myproject");

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe(uuid);
    });

    it("returns sessions sorted newest first by mtime", async () => {
      const uuid1 = "11111111-0000-0000-0000-000000000001";
      const uuid2 = "22222222-0000-0000-0000-000000000002";

      mockFs.readdirSync.mockReturnValue([
        `${uuid1}.jsonl`,
        `${uuid2}.jsonl`,
      ] as unknown as fs.Dirent[]);

      mockFs.statSync
        .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true, mtime: new Date("2026-03-01T10:00:00Z") } as unknown as fs.Stats)
        .mockReturnValueOnce({ isDirectory: () => false, isFile: () => true, mtime: new Date("2026-03-05T10:00:00Z") } as unknown as fs.Stats);

      const { getCursorSessions } = await import("../cli-sessions");
      const result = getCursorSessions("/home/testuser/myproject");

      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe(uuid2); // newer
    });

    it("skips non-UUID filenames", async () => {
      mockFs.readdirSync.mockReturnValue([
        "not-a-uuid.jsonl",
        "some-other-file.txt",
      ] as unknown as fs.Dirent[]);
      mockFs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true, mtime: new Date() } as unknown as fs.Stats);

      const { getCursorSessions } = await import("../cli-sessions");
      const result = getCursorSessions("/home/testuser/myproject");

      expect(result).toEqual([]);
    });

    it("respects the limit parameter", async () => {
      const uuids = Array.from({ length: 5 }, (_, i) =>
        `${String(i + 1).padStart(8, "0")}-0000-0000-0000-000000000000`
      );
      mockFs.readdirSync.mockReturnValue(
        uuids.map((u) => `${u}.jsonl`) as unknown as fs.Dirent[]
      );
      mockFs.statSync.mockReturnValue({ isDirectory: () => false, isFile: () => true, mtime: new Date() } as unknown as fs.Stats);

      const { getCursorSessions } = await import("../cli-sessions");
      const result = getCursorSessions("/home/testuser/myproject", 3);
      expect(result).toHaveLength(3);
    });
  });
```

**Step 2: Run to verify they fail**

```bash
pnpm test electron/__tests__/cli-sessions.test.ts --project electron --reporter=verbose
```

Expected: FAIL — `getCursorSessions is not a function`.

**Step 3: Implement `getCursorSessions` in `electron/cli-sessions.ts`**

Add after `getMostRecentCodexSession`:

```typescript
/** UUID v4 pattern for validating session filenames from Cursor. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encodes a project path the same way Cursor Agent does:
 * strips the leading "/" and replaces remaining "/" with "-".
 * e.g. "/home/user/project" → "home-user-project"
 */
function encodeCursorProjectPath(projectPath: string): string {
  return projectPath.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * Returns the Cursor Agent project directory for a given project path.
 * e.g. ~/.cursor/projects/home-user-project/
 */
function getCursorProjectDir(projectPath: string): string {
  return path.join(
    os.homedir(),
    ".cursor",
    "projects",
    encodeCursorProjectPath(projectPath)
  );
}

/**
 * Lists Cursor Agent sessions for a project by scanning
 * ~/.cursor/projects/<encoded-path>/agent-transcripts/.
 *
 * Sessions may be flat files (<UUID>.jsonl) or subdirectories (<UUID>/<UUID>.jsonl).
 * The session ID is the UUID extracted from the filename.
 *
 * Returns entries sorted by modification time (newest first).
 */
export function getCursorSessions(projectPath: string, limit = 20): CliSessionEntry[] {
  const transcriptsDir = path.join(
    getCursorProjectDir(projectPath),
    "agent-transcripts"
  );

  let entries: string[];
  try {
    entries = fs.readdirSync(transcriptsDir) as unknown as string[];
  } catch {
    return [];
  }

  const sessions: Array<{ sessionId: string; mtime: Date }> = [];

  for (const entry of entries) {
    const entryPath = path.join(transcriptsDir, entry);

    try {
      const stat = fs.statSync(entryPath);

      if (stat.isFile() && entry.endsWith(".jsonl")) {
        // Flat format: <UUID>.jsonl
        const sessionId = entry.replace(/\.jsonl$/, "");
        if (!UUID_PATTERN.test(sessionId)) continue;
        sessions.push({ sessionId, mtime: stat.mtime });
      } else if (stat.isDirectory() && UUID_PATTERN.test(entry)) {
        // Subdirectory format: <UUID>/<UUID>.jsonl
        const innerFile = path.join(entryPath, `${entry}.jsonl`);
        try {
          const innerStat = fs.statSync(innerFile);
          sessions.push({ sessionId: entry, mtime: innerStat.mtime });
        } catch {
          // Inner file missing — skip
        }
      }
    } catch {
      // Skip inaccessible entries
    }
  }

  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  return sessions.slice(0, limit).map(({ sessionId, mtime }) => ({
    sessionId,
    modified: mtime.toISOString(),
  }));
}

/**
 * Finds the most recently modified Cursor Agent session for a project.
 */
export function getMostRecentCursorSession(projectPath: string): CliSessionEntry | null {
  const sessions = getCursorSessions(projectPath, 1);
  return sessions[0] ?? null;
}
```

**Step 4: Run the tests and verify they pass**

```bash
pnpm test electron/__tests__/cli-sessions.test.ts --project electron --reporter=verbose
```

Expected: All `getCursorSessions` tests pass.

---

### Task 4: Generalize the `get_cli_sessions` IPC handler and fix Codex resume flag

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/cli-sessions.ts` (export a unified dispatcher)
- Modify: `frontend/lib/cli-registry.ts` (update Codex resumeFlag)

**Step 1: Add a unified `getCliSessions` dispatcher to `electron/cli-sessions.ts`**

This avoids a long switch statement in `main.ts`. Add at the end of `cli-sessions.ts`:

```typescript
/**
 * Unified session reader: dispatches to the correct per-CLI implementation
 * based on the cliId provided.
 *
 * Returns an empty array for CLIs that do not support filesystem session detection
 * (e.g., gh-copilot).
 */
export function getCliSessions(
  cliId: string,
  projectPath: string,
  limit = 20
): CliSessionEntry[] {
  switch (cliId) {
    case "claude":
      return getClaudeSessions(projectPath, limit);
    case "gemini":
      return getGeminiSessions(projectPath, limit);
    case "codex":
      return getCodexSessions(projectPath, limit);
    case "cursor-agent":
      return getCursorSessions(projectPath, limit);
    default:
      return [];
  }
}
```

**Step 2: Update the `get_cli_sessions` IPC handler in `electron/main.ts`**

Replace the existing handler:

```typescript
// Before (line ~507):
ipcMain.handle("get_cli_sessions", (_event, args: { projectPath: string; limit?: number }) => {
  return getClaudeSessions(args.projectPath, args.limit);
});
```

With:

```typescript
// After:
ipcMain.handle("get_cli_sessions", (_event, args: { cliId: string; projectPath: string; limit?: number }) => {
  return getCliSessions(args.cliId, args.projectPath, args.limit);
});
```

Update the import at line 36:

```typescript
// Before:
import { getClaudeSessions } from "./cli-sessions.js";

// After:
import { getCliSessions } from "./cli-sessions.js";
```

**Step 3: Fix Codex `resumeFlag` in `frontend/lib/cli-registry.ts`**

Codex uses a subcommand-style resume: `codex resume <UUID>`. The current `resumeFlag: "--resume"` produces `codex --resume <UUID>` which is incorrect.

The existing resume args builder in `terminal-session.tsx` builds:
```typescript
resumeArgs = [def.resumeFlag, cliSessionId]; // → ["--resume", "<UUID>"]
```

For Codex we need: `["resume", "<UUID>"]`

Update the Codex entry in the registry:

```typescript
codex: {
  // ...existing fields...
  resumeFlag: "resume",   // positional subcommand, not a flag
  sessionIdPattern: /session[:\s]+([a-zA-Z0-9_-]+)/i,
  sessionDirType: "codex-dir",  // NEW: filesystem detection
},
```

> **Note:** `resumeFlag: "resume"` will produce `["resume", "<UUID>"]` which Electron's PTY spawn will pass as args array to the `codex` binary — resulting in `codex resume <UUID>`. This is the correct invocation.

**Step 4: Run existing CLI registry tests to verify no regressions**

```bash
pnpm test frontend/lib/__tests__/cli-registry.test.ts --project frontend --reporter=verbose
```

Expected: All existing tests pass.

---

### Task 5: Update CLI registry `sessionDirType` for Gemini and Cursor Agent

**Files:**
- Modify: `frontend/lib/cli-registry.ts`
- Modify: `frontend/lib/__tests__/cli-registry.test.ts` (add assertions)

**Step 1: Add assertions for new `sessionDirType` values**

Add to the test file `frontend/lib/__tests__/cli-registry.test.ts`:

```typescript
  describe("sessionDirType values", () => {
    it("claude has sessionDirType claude-dir", () => {
      expect(CLI_REGISTRY.claude.sessionDirType).toBe("claude-dir");
    });

    it("gemini has sessionDirType gemini-dir", () => {
      expect(CLI_REGISTRY.gemini.sessionDirType).toBe("gemini-dir");
    });

    it("codex has sessionDirType codex-dir", () => {
      expect(CLI_REGISTRY.codex.sessionDirType).toBe("codex-dir");
    });

    it("cursor-agent has sessionDirType cursor-dir", () => {
      expect(CLI_REGISTRY["cursor-agent"].sessionDirType).toBe("cursor-dir");
    });

    it("gh-copilot has no sessionDirType", () => {
      expect(CLI_REGISTRY["gh-copilot"].sessionDirType).toBeUndefined();
    });
  });
```

**Step 2: Run to verify they fail**

```bash
pnpm test frontend/lib/__tests__/cli-registry.test.ts --project frontend --reporter=verbose
```

Expected: FAIL — gemini, codex, cursor-agent don't have `sessionDirType` yet.

**Step 3: Update the `CliDefinition` interface and `sessionDirType` values**

In `frontend/lib/cli-registry.ts`, update the type union:

```typescript
/** When set, session IDs are detected from the filesystem instead of PTY output. */
sessionDirType?: "claude-dir" | "gemini-dir" | "codex-dir" | "cursor-dir";
```

Then add `sessionDirType` to each CLI entry:

```typescript
gemini: {
  // ...existing fields...
  resumeFlag: "--resume",
  sessionIdPattern: /session[:\s]+([a-zA-Z0-9_-]+)/i,
  sessionDirType: "gemini-dir",  // NEW
},
codex: {
  // ...existing fields...
  resumeFlag: "resume",          // UPDATED from "--resume"
  sessionIdPattern: /session[:\s]+([a-zA-Z0-9_-]+)/i,
  sessionDirType: "codex-dir",  // NEW
},
"cursor-agent": {
  // ...existing fields...
  resumeFlag: "--resume=",
  sessionIdPattern: /chat[:\s]+([a-zA-Z0-9_-]+)/i,
  sessionDirType: "cursor-dir", // NEW
},
```

**Step 4: Run the tests and verify they pass**

```bash
pnpm test frontend/lib/__tests__/cli-registry.test.ts --project frontend --reporter=verbose
```

Expected: All tests pass including new `sessionDirType` assertions.

---

### Task 6: Update frontend `use-pty.ts` to pass `cliId` to the IPC call

The `get_cli_sessions` IPC call now requires a `cliId` argument. Both call sites in `use-pty.ts` need updating.

**Files:**
- Modify: `frontend/hooks/use-pty.ts`
- Modify: `frontend/hooks/__tests__/use-pty.test.ts` (add/update tests)

**Step 1: Add a failing test that verifies `cliId` is passed**

In `frontend/hooks/__tests__/use-pty.test.ts`, find the tests that check `get_cli_sessions` invocation and add:

```typescript
  describe("resolveMissingSessionIds", () => {
    it("passes cliId to get_cli_sessions IPC call", async () => {
      // Set up a tab with sessionDirType but no cliSessionId
      const store = useTerminalTabsStore.getState();
      store.addTab({ id: "tab-gemini", sessionType: "gemini", path: "/proj" });

      mockInvoke.mockResolvedValueOnce([{ sessionId: "gem-session-1", modified: "2026-01-01T00:00:00Z" }]);

      await resolveMissingSessionIds("/proj");

      expect(mockInvoke).toHaveBeenCalledWith("get_cli_sessions", {
        cliId: "gemini",
        projectPath: "/proj",
        limit: 1,
      });
    });
  });
```

**Step 2: Run to verify it fails**

```bash
pnpm test frontend/hooks/__tests__/use-pty.test.ts --project frontend --reporter=verbose
```

Expected: FAIL — `cliId` is not currently passed.

**Step 3: Update both call sites in `frontend/hooks/use-pty.ts`**

In `resolveMissingSessionIds` (around line 57):

```typescript
// Before:
const sessions = await invoke<CliSessionEntry[]>("get_cli_sessions", {
  projectPath,
  limit: 1,
});

// After:
const sessions = await invoke<CliSessionEntry[]>("get_cli_sessions", {
  cliId: tab.sessionType,
  projectPath,
  limit: 1,
});
```

In the `setInterval` polling block (around line 128):

```typescript
// Before:
const sessions = await invoke<CliSessionEntry[]>("get_cli_sessions", {
  projectPath: tab.path,
  limit: 1,
});

// After:
const sessions = await invoke<CliSessionEntry[]>("get_cli_sessions", {
  cliId: tab.sessionType,
  projectPath: tab.path,
  limit: 1,
});
```

**Step 4: Run the tests**

```bash
pnpm test frontend/hooks/__tests__/use-pty.test.ts --project frontend --reporter=verbose
```

Expected: All tests pass.

---

### Task 7: Handle Gemini index-based resume

Gemini's `--resume` flag takes an index (1-based, ascending by date) or `"latest"`, not a UUID. This means we need special handling when building resume args for Gemini.

**Files:**
- Modify: `frontend/components/terminal-session.tsx`
- Modify: `frontend/hooks/use-pty.ts` (pass session metadata for index lookup)
- Modify: `frontend/lib/cli-registry.ts` (add `resumeIdType` metadata)

**Decision:** The simplest correct approach is to always use `--resume latest` for Gemini, since Forja already stores the most recent session ID. When a user resumes Forja's saved session, it will almost always be the most recent Gemini session anyway. This avoids the complexity of computing a 1-based index.

**Step 1: Add `resumeIdType` to `CliDefinition`**

In `frontend/lib/cli-registry.ts`:

```typescript
export interface CliDefinition {
  // ...existing fields...
  /**
   * Controls how the session ID is passed to --resume:
   * - "id" (default): pass the session ID directly (Claude, Codex, Cursor)
   * - "latest": always pass "latest" regardless of stored session ID (Gemini)
   */
  resumeIdType?: "id" | "latest";
}
```

Update the Gemini entry:

```typescript
gemini: {
  // ...existing fields...
  resumeFlag: "--resume",
  sessionDirType: "gemini-dir",
  resumeIdType: "latest",  // Gemini uses index-based resume; "latest" is always safe
},
```

**Step 2: Add a failing test for Gemini resume args in `frontend/lib/__tests__/cli-registry.test.ts`**

```typescript
  describe("Gemini resumeIdType", () => {
    it("gemini has resumeIdType latest", () => {
      expect(CLI_REGISTRY.gemini.resumeIdType).toBe("latest");
    });

    it("claude has no resumeIdType (defaults to id)", () => {
      expect(CLI_REGISTRY.claude.resumeIdType).toBeUndefined();
    });
  });
```

**Step 3: Run to verify it fails**

```bash
pnpm test frontend/lib/__tests__/cli-registry.test.ts --project frontend --reporter=verbose
```

Expected: FAIL — `resumeIdType` doesn't exist on the type yet.

**Step 4: Update resume args logic in `frontend/components/terminal-session.tsx`**

Find the `resumeArgs` construction block (around line 282) and update it:

```typescript
// Before:
if (def.resumeFlag.endsWith("=")) {
  resumeArgs = [`${def.resumeFlag}${cliSessionId}`];
} else {
  resumeArgs = [def.resumeFlag, cliSessionId];
}

// After:
const resumeValue =
  def.resumeIdType === "latest" ? "latest" : cliSessionId;
if (def.resumeFlag.endsWith("=")) {
  resumeArgs = [`${def.resumeFlag}${resumeValue}`];
} else {
  resumeArgs = [def.resumeFlag, resumeValue];
}
```

**Step 5: Add tests for the Gemini resume path in `frontend/components/__tests__/terminal-session.test.tsx`**

Search for existing tests that cover resume args and add a Gemini-specific case:

```typescript
it("passes --resume latest for Gemini when cliSessionId is set", async () => {
  // Set up a Gemini tab with a cliSessionId
  // Verify spawn is called with ["--resume", "latest"]
  // ... (follow existing resume test pattern in this file)
});
```

> **Note:** Look at the existing resume test pattern in `terminal-session.test.tsx` before adding — match the setup style (mock `invoke`, set up store state, trigger spawn, assert `spawn_pty` args).

**Step 6: Run all frontend tests**

```bash
pnpm test --project frontend --reporter=verbose
```

Expected: All tests pass.

---

### Task 8: Add `getCliSessions` dispatcher tests to the electron test suite

**Files:**
- Modify: `electron/__tests__/cli-sessions.test.ts` (add dispatcher tests)

**Step 1: Add tests for the unified `getCliSessions` dispatcher**

Append to `electron/__tests__/cli-sessions.test.ts`:

```typescript
  describe("getCliSessions (unified dispatcher)", () => {
    it("dispatches to getClaudeSessions for cliId=claude", async () => {
      mockFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);

      const { getCliSessions } = await import("../cli-sessions");
      const result = getCliSessions("claude", "/some/project");
      expect(result).toEqual([]);
    });

    it("dispatches to getGeminiSessions for cliId=gemini", async () => {
      // projects.json not found -> empty
      mockFs.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
      mockFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);

      const { getCliSessions } = await import("../cli-sessions");
      const result = getCliSessions("gemini", "/some/project");
      expect(result).toEqual([]);
    });

    it("dispatches to getCodexSessions for cliId=codex", async () => {
      mockFs.readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });

      const { getCliSessions } = await import("../cli-sessions");
      const result = getCliSessions("codex", "/some/project");
      expect(result).toEqual([]);
    });

    it("dispatches to getCursorSessions for cliId=cursor-agent", async () => {
      mockFs.readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });

      const { getCliSessions } = await import("../cli-sessions");
      const result = getCliSessions("cursor-agent", "/some/project");
      expect(result).toEqual([]);
    });

    it("returns empty array for unknown cliId (gh-copilot)", async () => {
      const { getCliSessions } = await import("../cli-sessions");
      const result = getCliSessions("gh-copilot", "/some/project");
      expect(result).toEqual([]);
    });

    it("returns empty array for completely unknown cliId", async () => {
      const { getCliSessions } = await import("../cli-sessions");
      const result = getCliSessions("unknown-cli-xyz", "/some/project");
      expect(result).toEqual([]);
    });
  });
```

**Step 2: Run and verify**

```bash
pnpm test electron/__tests__/cli-sessions.test.ts --project electron --reporter=verbose
```

Expected: All dispatcher tests pass.

---

### Task 9: Run the full test suite and verify no regressions

**Step 1: Run all tests**

```bash
cd /home/nandomoreira/dev/projects/forja
pnpm test --reporter=verbose 2>&1 | tail -30
```

Expected: All 1498+ tests pass plus the new tests added in this plan.

**Step 2: If any tests fail, fix them**

Common failure causes:
- The `cliId` parameter now required in `get_cli_sessions` IPC calls — check if there are other test files that mock this call without `cliId`.
- The Codex `resumeFlag` change from `"--resume"` to `"resume"` — check if any test asserts on the old value.

Search for tests that may be affected:

```bash
grep -r "get_cli_sessions" frontend --include="*.test.*" -n
grep -r "resumeFlag\|codex.*resume" frontend --include="*.test.*" -n
```

Fix any test that asserts `cliId` is absent from the IPC call, or that asserts Codex's old resumeFlag value.

**Step 3: Run the full suite again to confirm green**

```bash
pnpm test 2>&1 | grep -E "Tests|passed|failed|error" | tail -10
```

Expected: `N tests passed, 0 failed`.

---

## Summary of Changes

| File | Change |
|------|--------|
| `electron/cli-sessions.ts` | Add `getGeminiSessions`, `getCodexSessions`, `getCursorSessions`, `getCliSessions` dispatcher |
| `electron/__tests__/cli-sessions.test.ts` | New file with tests for all 4 new functions |
| `electron/main.ts` | Generalize `get_cli_sessions` handler to accept `cliId`, update import |
| `frontend/lib/cli-registry.ts` | Add `sessionDirType` to gemini/codex/cursor-agent; add `resumeIdType: "latest"` to gemini; fix Codex `resumeFlag: "resume"` |
| `frontend/lib/__tests__/cli-registry.test.ts` | Add assertions for `sessionDirType` and `resumeIdType` |
| `frontend/hooks/use-pty.ts` | Pass `cliId: tab.sessionType` in both `get_cli_sessions` invocations |
| `frontend/hooks/__tests__/use-pty.test.ts` | Add test asserting `cliId` is forwarded |
| `frontend/components/terminal-session.tsx` | Update resume value selection to use `resumeIdType` |
| `frontend/components/__tests__/terminal-session.test.tsx` | Add Gemini `--resume latest` test |

## CLI Support Matrix After Implementation

| CLI | Session Storage | Resume Method | `sessionDirType` |
|-----|----------------|---------------|-----------------|
| claude | `~/.claude/projects/<encoded>/` | `--resume <UUID>` | `"claude-dir"` |
| gemini | `~/.gemini/tmp/<name>/chats/` | `--resume latest` | `"gemini-dir"` |
| codex | `~/.codex/sessions/YYYY/MM/DD/` | `codex resume <UUID>` | `"codex-dir"` |
| cursor-agent | `~/.cursor/projects/<encoded>/agent-transcripts/` | `--resume=<UUID>` | `"cursor-dir"` |
| gh-copilot | No local storage | N/A | none |
