import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, getCurrentWindow } from "@/lib/ipc";
import { ptyDispatcher } from "@/lib/pty-dispatcher";
import { CLI_REGISTRY } from "@/lib/cli-registry";
import type { CliId } from "@/lib/cli-registry";
import { stripAnsi } from "@/lib/strip-ansi";
import { useTerminalTabsStore } from "@/stores/terminal-tabs";

interface CliSessionEntry {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  modified: string;
}

interface UsePtyOptions {
  tabId: string;
  onData?: (data: string) => void;
  onExit?: (code: number) => void;
}

/**
 * Persists the current project UI state to disk after a session ID is detected.
 * This ensures the cliSessionId is available for resume on next app launch.
 */
async function persistSessionIdToDisk(projectPath: string): Promise<void> {
  try {
    const { saveCurrentProjectToDisk } = await import("@/stores/projects");
    await saveCurrentProjectToDisk(projectPath);
  } catch {
    // Non-fatal: session will still work, just won't persist for resume
  }
}

/**
 * Polls the filesystem to detect a new CLI session ID that appeared after spawn.
 * Compares against a set of known session IDs to find the newly created one.
 */
async function detectSessionFromFilesystem(
  projectPath: string,
  knownSessionIds: Set<string>,
  maxAttempts = 15,
  intervalMs = 2000,
): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const sessions = await invoke<CliSessionEntry[]>("get_cli_sessions", {
        projectPath,
        limit: 5,
      });
      // The most recent session that wasn't in our known set is the new one
      const newSession = sessions.find((s) => !knownSessionIds.has(s.sessionId));
      if (newSession) return newSession.sessionId;
    } catch {
      // IPC call failed — keep trying
    }
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return null;
}

export function usePty(options: UsePtyOptions) {
  const [isRunning, setIsRunning] = useState(false);
  const onDataRef = useRef(options.onData);
  const onExitRef = useRef(options.onExit);
  const tabIdRef = useRef(options.tabId);

  onDataRef.current = options.onData;
  onExitRef.current = options.onExit;
  tabIdRef.current = options.tabId;

  useEffect(() => {
    const tabId = tabIdRef.current;
    let sessionIdFound = false;
    let chunkCount = 0;

    // Register with centralized dispatcher — O(1) routing, no per-session IPC listener
    ptyDispatcher.registerData(tabId, (data) => {
      onDataRef.current?.(data);

      // Try to detect session ID from early output (fallback for CLIs without
      // filesystem-based detection — sessionDirType takes priority when available)
      if (!sessionIdFound && chunkCount < 100) {
        chunkCount++;
        const tab = useTerminalTabsStore.getState().tabs.find((t) => t.id === tabId);
        if (tab && tab.sessionType !== "terminal") {
          const def = CLI_REGISTRY[tab.sessionType];
          // Skip PTY regex detection if this CLI uses filesystem detection
          if (def?.sessionIdPattern && !def.sessionDirType) {
            const match = stripAnsi(data).match(def.sessionIdPattern);
            if (match?.[1]) {
              sessionIdFound = true;
              useTerminalTabsStore.getState().setCliSessionId(tabId, match[1]);
              persistSessionIdToDisk(tab.path);
            }
          }
        }
      }
    });

    ptyDispatcher.registerExit(tabId, (code) => {
      setIsRunning(false);
      onExitRef.current?.(code);
    });

    return () => {
      ptyDispatcher.unregisterData(tabId);
      ptyDispatcher.unregisterExit(tabId);
    };
  }, []);

  const spawn = useCallback(async (path: string, sessionType?: string, resumeArgs?: string[]): Promise<string> => {
    const tabId = tabIdRef.current;

    // Snapshot existing sessions BEFORE spawn so we can detect the new one
    let knownSessionIds: Set<string> | null = null;
    const cliDef = sessionType && sessionType !== "terminal"
      ? CLI_REGISTRY[sessionType as CliId]
      : null;

    if (cliDef?.sessionDirType === "claude-dir" && !resumeArgs) {
      try {
        const existing = await invoke<CliSessionEntry[]>("get_cli_sessions", {
          projectPath: path,
          limit: 50,
        });
        knownSessionIds = new Set(existing.map((s) => s.sessionId));
      } catch {
        // Non-fatal: filesystem detection will still work, just may pick up an old session
      }
    }

    const resultTabId = await invoke<string>("spawn_pty", {
      tabId,
      path,
      sessionType,
      windowLabel: getCurrentWindow().label,
      ...(resumeArgs ? { resumeArgs } : {}),
    });
    setIsRunning(true);

    // Start filesystem-based session detection after spawn (async, non-blocking)
    if (cliDef?.sessionDirType === "claude-dir" && !resumeArgs && knownSessionIds) {
      detectSessionFromFilesystem(path, knownSessionIds).then((newSessionId) => {
        if (newSessionId) {
          useTerminalTabsStore.getState().setCliSessionId(tabId, newSessionId);
          persistSessionIdToDisk(path);
        }
      });
    }

    // If resuming, the session ID is already stored on the tab
    return resultTabId;
  }, []);

  const write = useCallback(
    async (data: string) => {
      await invoke("write_pty", { tabId: tabIdRef.current, data });
    },
    [],
  );

  const resize = useCallback(
    async (rows: number, cols: number) => {
      await invoke("resize_pty", {
        tabId: tabIdRef.current,
        rows,
        cols,
      });
    },
    [],
  );

  const close = useCallback(async () => {
    await invoke("close_pty", { tabId: tabIdRef.current });
    setIsRunning(false);
  }, []);

  return { isRunning, spawn, write, resize, close };
}
