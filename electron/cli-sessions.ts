import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface CliSessionEntry {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  modified: string;
  created?: string;
  projectPath?: string;
}

/**
 * Encodes a project path the same way Claude Code does:
 * replace all "/" with "-".
 * e.g. "/home/user/project" → "-home-user-project"
 */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

/**
 * Returns the Claude Code project directory for a given project path.
 * e.g. ~/.claude/projects/-home-user-project/
 */
function getClaudeProjectDir(projectPath: string): string {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectPath(projectPath));
}

/**
 * Reads sessions-index.json if it exists and returns entries as a map
 * keyed by sessionId for quick lookup of summary/firstPrompt.
 */
function readSessionsIndex(projectDir: string): Map<string, { summary?: string; firstPrompt?: string }> {
  const indexPath = path.join(projectDir, "sessions-index.json");
  const map = new Map<string, { summary?: string; firstPrompt?: string }>();
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const data = JSON.parse(raw);
    if (data?.entries && Array.isArray(data.entries)) {
      for (const entry of data.entries) {
        if (entry.sessionId) {
          map.set(entry.sessionId, {
            summary: entry.summary,
            firstPrompt: entry.firstPrompt,
          });
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — that's fine
  }
  return map;
}

/**
 * Lists Claude Code sessions for a project by scanning .jsonl files
 * in ~/.claude/projects/<encoded-path>/.
 *
 * Returns entries sorted by modification time (newest first).
 * Enriches with summary/firstPrompt from sessions-index.json when available.
 */
export function getClaudeSessions(projectPath: string, limit = 20): CliSessionEntry[] {
  const projectDir = getClaudeProjectDir(projectPath);

  let files: string[];
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  // Get modification times and sort newest first
  const withStats = files
    .map((filename) => {
      const fullPath = path.join(projectDir, filename);
      try {
        const stat = fs.statSync(fullPath);
        return {
          sessionId: filename.replace(".jsonl", ""),
          modified: stat.mtime,
          fullPath,
        };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  withStats.sort((a, b) => b.modified.getTime() - a.modified.getTime());

  // Enrich with sessions-index.json metadata (summary from /rename)
  const indexMap = readSessionsIndex(projectDir);

  return withStats.slice(0, limit).map((entry) => {
    const indexed = indexMap.get(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      summary: indexed?.summary,
      firstPrompt: indexed?.firstPrompt,
      modified: entry.modified.toISOString(),
    };
  });
}

/**
 * Finds the most recently modified Claude session for a project.
 * Returns the sessionId or null if no sessions exist.
 */
export function getMostRecentClaudeSession(projectPath: string): CliSessionEntry | null {
  const sessions = getClaudeSessions(projectPath, 1);
  return sessions[0] ?? null;
}
