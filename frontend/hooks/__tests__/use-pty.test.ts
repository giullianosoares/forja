import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePty } from "../use-pty";
import { ptyDispatcher } from "@/lib/pty-dispatcher";
import { useTerminalTabsStore } from "@/stores/terminal-tabs";

const mockInvoke = vi.fn();

vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  getCurrentWindow: () => ({ label: "main" }),
}));

vi.mock("@/lib/pty-dispatcher", () => {
  const dataHandlers = new Map<string, (data: string) => void>();
  const exitHandlers = new Map<string, (code: number) => void>();
  return {
    ptyDispatcher: {
      registerData: vi.fn((tabId: string, handler: (data: string) => void) => {
        dataHandlers.set(tabId, handler);
      }),
      unregisterData: vi.fn((tabId: string) => {
        dataHandlers.delete(tabId);
      }),
      registerExit: vi.fn((tabId: string, handler: (code: number) => void) => {
        exitHandlers.set(tabId, handler);
      }),
      unregisterExit: vi.fn((tabId: string) => {
        exitHandlers.delete(tabId);
      }),
      // Test helpers to simulate dispatching
      _simulateData: (tabId: string, data: string) => {
        dataHandlers.get(tabId)?.(data);
      },
      _simulateExit: (tabId: string, code: number) => {
        exitHandlers.get(tabId)?.(code);
      },
    },
  };
});

const mockDispatcher = vi.mocked(ptyDispatcher) as typeof ptyDispatcher & {
  _simulateData: (tabId: string, data: string) => void;
  _simulateExit: (tabId: string, code: number) => void;
};

describe("usePty", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    vi.mocked(ptyDispatcher.registerData).mockClear();
    vi.mocked(ptyDispatcher.unregisterData).mockClear();
    vi.mocked(ptyDispatcher.registerExit).mockClear();
    vi.mocked(ptyDispatcher.unregisterExit).mockClear();
    mockInvoke.mockResolvedValue(undefined);
  });

  it("starts with isRunning as false", () => {
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));
    expect(result.current.isRunning).toBe(false);
  });

  it("calls write_pty with tabId when write is called", async () => {
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));

    await act(async () => {
      await result.current.write("hello");
    });

    expect(mockInvoke).toHaveBeenCalledWith("write_pty", {
      tabId: "tab-1",
      data: "hello",
    });
  });

  it("calls resize_pty with tabId when resize is called", async () => {
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));

    await act(async () => {
      await result.current.resize(48, 120);
    });

    expect(mockInvoke).toHaveBeenCalledWith("resize_pty", {
      tabId: "tab-1",
      rows: 48,
      cols: 120,
    });
  });

  it("calls close_pty with tabId when close is called", async () => {
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));

    await act(async () => {
      await result.current.close();
    });

    expect(mockInvoke).toHaveBeenCalledWith("close_pty", {
      tabId: "tab-1",
    });
    expect(result.current.isRunning).toBe(false);
  });

  it("registers with ptyDispatcher on mount", () => {
    renderHook(() => usePty({ tabId: "tab-1" }));

    expect(ptyDispatcher.registerData).toHaveBeenCalledWith("tab-1", expect.any(Function));
    expect(ptyDispatcher.registerExit).toHaveBeenCalledWith("tab-1", expect.any(Function));
  });

  it("unregisters from ptyDispatcher on unmount", () => {
    const { unmount } = renderHook(() => usePty({ tabId: "tab-1" }));

    unmount();

    expect(ptyDispatcher.unregisterData).toHaveBeenCalledWith("tab-1");
    expect(ptyDispatcher.unregisterExit).toHaveBeenCalledWith("tab-1");
  });

  it("calls onData callback when dispatcher routes data to this tab", () => {
    const onData = vi.fn();
    renderHook(() => usePty({ tabId: "tab-1", onData }));

    act(() => {
      mockDispatcher._simulateData("tab-1", "hello");
    });

    expect(onData).toHaveBeenCalledWith("hello");
  });

  it("does not receive data for other tabs (dispatcher handles routing)", () => {
    const onData = vi.fn();
    renderHook(() => usePty({ tabId: "tab-1", onData }));

    act(() => {
      // Simulate data for a different tab — dispatcher won't route it here
      mockDispatcher._simulateData("tab-2", "world");
    });

    expect(onData).not.toHaveBeenCalled();
  });

  it("calls onExit and sets isRunning false on exit", async () => {
    const onExit = vi.fn();
    const { result } = renderHook(() => usePty({ tabId: "tab-1", onExit }));

    // Simulate spawn to set isRunning
    mockInvoke.mockResolvedValueOnce("tab-1");
    await act(async () => {
      await result.current.spawn("/test/path");
    });
    expect(result.current.isRunning).toBe(true);

    // Simulate exit via dispatcher
    act(() => {
      mockDispatcher._simulateExit("tab-1", 0);
    });

    expect(result.current.isRunning).toBe(false);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("calls spawn_pty and returns tab_id from spawn", async () => {
    mockInvoke.mockResolvedValueOnce("tab-1");
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));

    let tabId: string | undefined;
    await act(async () => {
      tabId = await result.current.spawn("/test/path");
    });

    expect(mockInvoke).toHaveBeenCalledWith("spawn_pty", {
      tabId: "tab-1",
      path: "/test/path",
      windowLabel: "main",
    });
    expect(tabId).toBe("tab-1");
    expect(result.current.isRunning).toBe(true);
  });

  it("passes sessionType to spawn_pty", async () => {
    mockInvoke.mockResolvedValueOnce("tab-1");
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));

    await act(async () => {
      await result.current.spawn("/test/path", "gemini");
    });

    expect(mockInvoke).toHaveBeenCalledWith("spawn_pty", {
      tabId: "tab-1",
      path: "/test/path",
      sessionType: "gemini",
      windowLabel: "main",
    });
  });

  it("spawn passes resumeArgs to spawn_pty IPC when provided", async () => {
    mockInvoke.mockResolvedValueOnce("tab-1");
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));

    await act(async () => {
      await result.current.spawn("/test/path", "claude", ["--resume", "abc-def-123"]);
    });

    expect(mockInvoke).toHaveBeenCalledWith("spawn_pty", {
      tabId: "tab-1",
      path: "/test/path",
      sessionType: "claude",
      windowLabel: "main",
      resumeArgs: ["--resume", "abc-def-123"],
    });
  });

  it("spawn works without resumeArgs — invoke does not include resumeArgs field", async () => {
    mockInvoke.mockResolvedValueOnce("tab-1");
    const { result } = renderHook(() => usePty({ tabId: "tab-1" }));

    await act(async () => {
      await result.current.spawn("/test/path", "claude");
    });

    const callArgs = mockInvoke.mock.calls[0];
    expect(callArgs[1]).not.toHaveProperty("resumeArgs");
  });

  describe("session ID detection via PTY regex (CLIs without filesystem detection)", () => {
    beforeEach(() => {
      // Use gemini (has sessionIdPattern but NO sessionDirType) to test regex detection
      useTerminalTabsStore.setState({
        tabs: [
          {
            id: "tab-gemini",
            name: "Gemini CLI",
            path: "/test",
            isRunning: true,
            sessionType: "gemini",
          },
        ],
        activeTabId: "tab-gemini",
      });
    });

    it("detects session ID from ANSI-wrapped PTY output", () => {
      renderHook(() => usePty({ tabId: "tab-gemini" }));

      act(() => {
        mockDispatcher._simulateData(
          "tab-gemini",
          "\x1b[2msession:\x1b[0m \x1b[33mabc-def-123\x1b[0m"
        );
      });

      const tab = useTerminalTabsStore.getState().tabs.find(
        (t) => t.id === "tab-gemini"
      );
      expect(tab?.cliSessionId).toBe("abc-def-123");
    });

    it("detects session ID from plain text PTY output", () => {
      renderHook(() => usePty({ tabId: "tab-gemini" }));

      act(() => {
        mockDispatcher._simulateData("tab-gemini", "session: deadbeef-1234");
      });

      const tab = useTerminalTabsStore.getState().tabs.find(
        (t) => t.id === "tab-gemini"
      );
      expect(tab?.cliSessionId).toBe("deadbeef-1234");
    });
  });

  describe("session ID detection skips PTY regex for CLIs with filesystem detection", () => {
    beforeEach(() => {
      // Claude has sessionDirType: "claude-dir" — PTY regex should be skipped
      useTerminalTabsStore.setState({
        tabs: [
          {
            id: "tab-claude",
            name: "Claude Code",
            path: "/test",
            isRunning: true,
            sessionType: "claude",
          },
        ],
        activeTabId: "tab-claude",
      });
    });

    it("does NOT set cliSessionId from PTY output for Claude (uses filesystem instead)", () => {
      renderHook(() => usePty({ tabId: "tab-claude" }));

      act(() => {
        mockDispatcher._simulateData("tab-claude", "session: abc-def-123");
      });

      const tab = useTerminalTabsStore.getState().tabs.find(
        (t) => t.id === "tab-claude"
      );
      // Should remain undefined because Claude uses filesystem-based detection
      expect(tab?.cliSessionId).toBeUndefined();
    });
  });

  describe("spawn triggers filesystem session detection for Claude", () => {
    beforeEach(() => {
      useTerminalTabsStore.setState({
        tabs: [
          {
            id: "tab-fs",
            name: "Claude Code",
            path: "/test/project",
            isRunning: true,
            sessionType: "claude",
          },
        ],
        activeTabId: "tab-fs",
      });
    });

    it("calls get_cli_sessions before and polls after spawn for Claude", async () => {
      // First call: get_cli_sessions to snapshot existing sessions (before spawn)
      mockInvoke
        .mockResolvedValueOnce([{ sessionId: "old-session-1", modified: "2024-01-01" }]) // get_cli_sessions (snapshot)
        .mockResolvedValueOnce("tab-fs") // spawn_pty
        .mockResolvedValueOnce([ // get_cli_sessions (poll — returns new session)
          { sessionId: "new-session-abc", modified: "2024-01-02" },
          { sessionId: "old-session-1", modified: "2024-01-01" },
        ]);

      const { result } = renderHook(() => usePty({ tabId: "tab-fs" }));

      await act(async () => {
        await result.current.spawn("/test/project", "claude");
      });

      // Wait for the async filesystem detection to complete
      await act(async () => {
        await vi.waitFor(() => {
          const tab = useTerminalTabsStore.getState().tabs.find((t) => t.id === "tab-fs");
          expect(tab?.cliSessionId).toBe("new-session-abc");
        }, { timeout: 5000 });
      });
    });

    it("skips filesystem detection when resumeArgs are provided", async () => {
      mockInvoke.mockResolvedValueOnce("tab-fs"); // spawn_pty only — no get_cli_sessions calls

      const { result } = renderHook(() => usePty({ tabId: "tab-fs" }));

      await act(async () => {
        await result.current.spawn("/test/project", "claude", ["--resume", "existing-id"]);
      });

      // Should NOT have called get_cli_sessions
      const cliSessionsCalls = mockInvoke.mock.calls.filter(
        (c) => c[0] === "get_cli_sessions"
      );
      expect(cliSessionsCalls).toHaveLength(0);
    });
  });
});
