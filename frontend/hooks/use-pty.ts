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

/** Interval for lazy session ID detection polling (ms). */
const SESSION_DETECT_INTERVAL_MS = 10_000;

/**
 * Persists the current project UI state to disk after a session ID is detected.
 * This ensures the cliSessionId is available for resume on next app launch.
 */
async function persistSessionIdToDisk(projectPath: string): Promise<void> {
  try {
    const { saveCurrentProjectToDisk } = await import("@/stores/projects");
    await saveCurrentProjectToDisk(projectPath);
  } catch (err) {
    console.error("[session-detect] persistSessionIdToDisk failed:", err);
  }
}

/**
 * Resolves missing session IDs for tabs that use filesystem-based detection.
 * Called as a safety net before saving project state to disk.
 *
 * For each tab with sessionDirType and no cliSessionId, fetches the most
 * recent session from the filesystem and assigns it.
 */
export async function resolveMissingSessionIds(projectPath: string): Promise<void> {
  const store = useTerminalTabsStore.getState();
  const projectTabs = store.tabs.filter((t) => t.path === projectPath);

  for (const tab of projectTabs) {
    if (tab.cliSessionId) continue;
    if (tab.sessionType === "terminal") continue;

    const def = CLI_REGISTRY[tab.sessionType as CliId];
    if (!def?.sessionDirType) continue;

    try {
      const sessions = await invoke<CliSessionEntry[]>("get_cli_sessions", {
        projectPath,
        limit: 1,
      });
      if (sessions.length > 0) {
        store.setCliSessionId(tab.id, sessions[0].sessionId);
      }
    } catch {
      // Non-fatal: session detection is best-effort
    }
  }
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

    // Lazy session ID detection: periodically check the filesystem for CLIs
    // that use directory-based detection (e.g., Claude Code). This handles the
    // case where the CLI creates its session file well after spawn (after auth,
    // first user interaction, etc.).
    const intervalId = setInterval(async () => {
      const tab = useTerminalTabsStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab || tab.cliSessionId || tab.sessionType === "terminal") {
        return;
      }

      const def = CLI_REGISTRY[tab.sessionType as CliId];
      if (!def?.sessionDirType) return;

      try {
        const sessions = await invoke<CliSessionEntry[]>("get_cli_sessions", {
          projectPath: tab.path,
          limit: 1,
        });
        if (sessions.length > 0) {
          const store = useTerminalTabsStore.getState();
          // Re-check: another poll or PTY detection may have set it
          const freshTab = store.tabs.find((t) => t.id === tabId);
          if (freshTab && !freshTab.cliSessionId) {
            store.setCliSessionId(tabId, sessions[0].sessionId);
            persistSessionIdToDisk(tab.path);
          }
        }
      } catch {
        // Non-fatal: will retry on next interval
      }
    }, SESSION_DETECT_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      ptyDispatcher.unregisterData(tabId);
      ptyDispatcher.unregisterExit(tabId);
    };
  }, []);

  const spawn = useCallback(async (path: string, sessionType?: string, resumeArgs?: string[]): Promise<string> => {
    const tabId = tabIdRef.current;

    const resultTabId = await invoke<string>("spawn_pty", {
      tabId,
      path,
      sessionType,
      windowLabel: getCurrentWindow().label,
      ...(resumeArgs ? { resumeArgs } : {}),
    });
    setIsRunning(true);

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
