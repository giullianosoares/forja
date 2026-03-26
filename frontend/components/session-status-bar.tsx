import { invoke } from "@/lib/ipc";
import { CLI_REGISTRY, type SessionType } from "@/lib/cli-registry";
import { useSessionStateStore } from "@/stores/session-state";
import { useTerminalTabsStore } from "@/stores/terminal-tabs";
import { memo, useEffect, useState } from "react";

interface SessionStatusBarProps {
  tabId: string;
  path: string;
  sessionType: SessionType;
}

interface GitInfo {
  branch: string;
  modified_count: number;
}

interface HostInfo {
  hostname: string;
  username: string;
}

function formatElapsed(createdAt: number | undefined): string | null {
  if (!createdAt) return null;
  const diff = Math.floor((Date.now() - createdAt) / 1000);
  if (diff < 60) return "<1m";
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  return `${minutes}m`;
}

function shortenPath(fullPath: string, username: string | null): string {
  if (!username) return fullPath;
  const homeDir = `/home/${username}`;
  if (fullPath.startsWith(homeDir)) {
    return `~${fullPath.slice(homeDir.length)}`;
  }
  return fullPath;
}

function Separator() {
  return <span className="text-ctp-surface1">|</span>;
}

const SESSION_STATE_STYLES: Record<string, string> = {
  idle: "text-ctp-overlay1",
  thinking: "text-ctp-yellow",
  ready: "text-ctp-green",
  exited: "text-ctp-overlay0",
};

export const SessionStatusBar = memo(function SessionStatusBar({
  tabId,
  path,
  sessionType,
}: SessionStatusBarProps) {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [elapsed, setElapsed] = useState<string | null>(null);

  const sessionState = useSessionStateStore((s) => s.getState(tabId));
  const tab = useTerminalTabsStore((s) => s.tabs.find((t: { id: string }) => t.id === tabId));

  const isTerminal = sessionType === "terminal";
  const isAiCli = !isTerminal;

  // Fetch git info
  useEffect(() => {
    let cancelled = false;
    invoke<GitInfo>("get_git_info_command", { path }).then((info) => {
      if (!cancelled && info) setGitInfo(info);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [path]);

  // Fetch host info (only for terminal sessions)
  useEffect(() => {
    if (!isTerminal) return;
    let cancelled = false;
    invoke<HostInfo>("get_session_host_info").then((info) => {
      if (!cancelled && info) setHostInfo(info);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [isTerminal]);

  // Elapsed time ticker (only for AI sessions)
  useEffect(() => {
    if (!isAiCli || !tab?.createdAt) return;
    setElapsed(formatElapsed(tab.createdAt));
    const interval = setInterval(() => {
      setElapsed(formatElapsed(tab.createdAt));
    }, 60_000);
    return () => clearInterval(interval);
  }, [isAiCli, tab?.createdAt]);

  const projectName = path.split("/").pop() ?? path;
  const branchDisplay = gitInfo
    ? `${gitInfo.branch}${gitInfo.modified_count > 0 ? "*" : ""}`
    : null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-t border-ctp-surface0 px-3 font-mono text-app-xs text-ctp-overlay1">
      {isAiCli && (
        <>
          {/* CLI name */}
          <span className={CLI_REGISTRY[sessionType as keyof typeof CLI_REGISTRY]?.iconColor ?? "text-ctp-overlay1"}>
            {CLI_REGISTRY[sessionType as keyof typeof CLI_REGISTRY]?.displayName ?? sessionType}
          </span>

          {/* Session state */}
          <Separator />
          <span className={SESSION_STATE_STYLES[sessionState] ?? "text-ctp-overlay1"}>
            {sessionState}
          </span>

          {/* Session ID (truncated) */}
          {tab?.cliSessionId && (
            <>
              <Separator />
              <span>{tab.cliSessionId.slice(0, 8)}</span>
            </>
          )}

          {/* Project + git branch */}
          {branchDisplay && (
            <>
              <Separator />
              <span>
                {projectName} git:({branchDisplay})
              </span>
            </>
          )}

          {/* Elapsed time */}
          {elapsed && (
            <>
              <Separator />
              <span>{elapsed}</span>
            </>
          )}
        </>
      )}

      {isTerminal && (
        <>
          {/* user@hostname */}
          {hostInfo && (
            <span>{hostInfo.username}@{hostInfo.hostname}</span>
          )}

          {/* Project path (shortened) */}
          {hostInfo ? <Separator /> : null}
          <span>{shortenPath(path, hostInfo?.username ?? null)}</span>

          {/* Git branch */}
          {branchDisplay && (
            <>
              <Separator />
              <span>git:({branchDisplay})</span>
            </>
          )}
        </>
      )}
    </div>
  );
});
