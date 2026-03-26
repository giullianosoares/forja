import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
}));

// Must reset the store between tests since Zustand persists state
let useQuickActionsStore: typeof import("@/stores/quick-actions").useQuickActionsStore;

describe("useQuickActionsStore", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("@/stores/quick-actions");
    useQuickActionsStore = mod.useQuickActionsStore;
  });

  it("starts with empty actions and loaded=false", () => {
    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([]);
    expect(state.loaded).toBe(false);
  });

  it("loadActions fetches and sets state", async () => {
    const mockActions = [{ actionId: "action-1" }, { actionId: "action-2" }];
    vi.mocked(invoke).mockResolvedValue(mockActions);

    await useQuickActionsStore.getState().loadActions();

    expect(invoke).toHaveBeenCalledWith("get_quick_actions");
    expect(useQuickActionsStore.getState().actions).toEqual(mockActions);
    expect(useQuickActionsStore.getState().loaded).toBe(true);
  });

  it("loadActions uses default actions on error", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("IPC error"));

    await useQuickActionsStore.getState().loadActions();

    expect(useQuickActionsStore.getState().actions).toEqual([
      { actionId: "open-files" },
      { actionId: "open-browser" },
    ]);
    expect(useQuickActionsStore.getState().loaded).toBe(true);
  });

  it("addAction adds and persists via save_quick_actions", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await useQuickActionsStore.getState().addAction("action-1");

    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([{ actionId: "action-1" }]);
    expect(invoke).toHaveBeenCalledWith("save_quick_actions", {
      actions: [{ actionId: "action-1" }],
    });
  });

  it("addAction skips duplicates", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await useQuickActionsStore.getState().addAction("action-1");
    await useQuickActionsStore.getState().addAction("action-1");

    const state = useQuickActionsStore.getState();
    expect(state.actions).toHaveLength(1);
    expect(state.actions).toEqual([{ actionId: "action-1" }]);
  });

  it("removeAction removes and persists", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await useQuickActionsStore.getState().addAction("action-1");
    await useQuickActionsStore.getState().addAction("action-2");
    await useQuickActionsStore.getState().removeAction("action-1");

    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([{ actionId: "action-2" }]);
    expect(invoke).toHaveBeenLastCalledWith("save_quick_actions", {
      actions: [{ actionId: "action-2" }],
    });
  });

  it("moveAction reorders correctly", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await useQuickActionsStore.getState().addAction("action-1");
    await useQuickActionsStore.getState().addAction("action-2");
    await useQuickActionsStore.getState().addAction("action-3");

    await useQuickActionsStore.getState().moveAction(0, 2);

    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([
      { actionId: "action-2" },
      { actionId: "action-3" },
      { actionId: "action-1" },
    ]);
    expect(invoke).toHaveBeenLastCalledWith("save_quick_actions", {
      actions: [
        { actionId: "action-2" },
        { actionId: "action-3" },
        { actionId: "action-1" },
      ],
    });
  });

  it("isPinned returns true when action exists", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await useQuickActionsStore.getState().addAction("action-1");

    expect(useQuickActionsStore.getState().isPinned("action-1")).toBe(true);
  });

  it("isPinned returns false when action does not exist", () => {
    expect(useQuickActionsStore.getState().isPinned("nonexistent")).toBe(false);
  });
});
