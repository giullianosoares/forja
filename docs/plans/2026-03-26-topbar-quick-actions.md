# Topbar Quick Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a user-customizable "quick actions" bar to the titlebar, letting users pin favorite commands from the command palette as one-click icon buttons, with a "+" button that opens a dedicated picker command bar ("Add Quick Action").

**Architecture:** New Zustand store (`quick-actions.ts`) manages the list of pinned actions, persisted in `electron-store` config. A new `<QuickActions />` component renders pinned icon buttons + the "+" add button between the workspace switcher and the centered title. The "+" opens the existing `CommandDialog` in a new `"quick-actions"` mode that lists available actions. Actions are identified by a string ID and mapped to their handler + icon via a new `action-registry.ts` module that centralizes what is currently hardcoded in `command-palette.tsx`.

**Tech Stack:** React, Zustand, Lucide icons, cmdk (CommandDialog), electron-store (persistence via IPC), Vitest + RTL

---

## Concepts

### Quick Action Definition

```typescript
// A quick action is a reference to a registered action
interface QuickAction {
  actionId: string; // unique key, e.g. "open-files", "plugin:git-graph", "session:claude"
}
```

### Action Registry Entry

```typescript
interface ActionRegistryEntry {
  id: string;
  label: string;
  icon: string;        // lucide icon name
  group: string;       // "Session" | "Panels & View" | "Git" | "Terminal" | "Plugins" | "Settings"
  shortcut?: string;   // display shortcut, e.g. "Ctrl+Shift+E"
  requiresProject?: boolean; // only available when a project is open
}
```

### Persistence Shape (in electron-store config)

```typescript
// Added to ConfigSchema
quickActions: QuickAction[];
```

---

## Task 1: Create the Action Registry

**Files:**
- Create: `frontend/lib/action-registry.ts`
- Test: `frontend/lib/__tests__/action-registry.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import {
  getAction,
  getAllActions,
  getActionsByGroup,
  type ActionRegistryEntry,
} from "../action-registry";

describe("action-registry", () => {
  it("returns all registered actions", () => {
    const actions = getAllActions();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0]).toHaveProperty("id");
    expect(actions[0]).toHaveProperty("label");
    expect(actions[0]).toHaveProperty("icon");
    expect(actions[0]).toHaveProperty("group");
  });

  it("finds an action by id", () => {
    const action = getAction("open-files");
    expect(action).toBeDefined();
    expect(action!.label).toBe("Open Files");
  });

  it("returns undefined for unknown id", () => {
    expect(getAction("nonexistent")).toBeUndefined();
  });

  it("groups actions by group name", () => {
    const groups = getActionsByGroup();
    expect(groups).toHaveProperty("Session");
    expect(groups).toHaveProperty("Panels & View");
    expect(Array.isArray(groups["Session"])).toBe(true);
  });

  it("includes plugin-type actions with plugin: prefix", () => {
    // Plugin actions are dynamic, but the helper should handle them
    const all = getAllActions();
    const panelActions = all.filter((a) => a.group === "Panels & View");
    expect(panelActions.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/lib/__tests__/action-registry.test.ts --reporter=verbose`
Expected: FAIL - module not found

**Step 3: Write minimal implementation**

```typescript
// frontend/lib/action-registry.ts

export interface ActionRegistryEntry {
  id: string;
  label: string;
  icon: string;
  group: string;
  shortcut?: string;
  requiresProject?: boolean;
}

const STATIC_ACTIONS: ActionRegistryEntry[] = [
  // Session
  { id: "new-session", label: "New Session", icon: "plus", group: "Session", shortcut: "Ctrl+Shift+T", requiresProject: true },
  { id: "go-to-project", label: "Go to Project", icon: "folder-open", group: "Session", shortcut: "Ctrl+Shift+L" },
  { id: "open-project", label: "Add Project", icon: "plus", group: "Session", shortcut: "Ctrl+Shift+O" },

  // Panels & View
  { id: "open-files", label: "Open Files", icon: "folder-tree", group: "Panels & View", shortcut: "Ctrl+Shift+E", requiresProject: true },
  { id: "open-browser", label: "Open Browser", icon: "globe", group: "Panels & View", shortcut: "Ctrl+Shift+B" },
  { id: "toggle-focus-mode", label: "Toggle Focus Mode", icon: "minimize-2", group: "Panels & View", shortcut: "Ctrl+Alt+F" },

  // Terminal
  { id: "zoom-in", label: "Zoom In", icon: "zoom-in", group: "Terminal", shortcut: "Ctrl+Alt+=" },
  { id: "zoom-out", label: "Zoom Out", icon: "zoom-out", group: "Terminal", shortcut: "Ctrl+Alt+-" },
  { id: "zoom-reset", label: "Reset Zoom", icon: "rotate-ccw", group: "Terminal", shortcut: "Ctrl+Alt+0" },

  // Git
  { id: "git-changes", label: "View Git Changes", icon: "git-compare-arrows", group: "Git", shortcut: "Ctrl+Shift+G", requiresProject: true },
  { id: "toggle-diff-mode", label: "Toggle Diff Mode", icon: "split-square-horizontal", group: "Git", requiresProject: true },
  { id: "refresh-git", label: "Refresh Git Status", icon: "refresh-cw", group: "Git", requiresProject: true },

  // Settings
  { id: "change-theme", label: "Change Theme", icon: "palette", group: "Settings" },
  { id: "open-settings", label: "Open Settings", icon: "settings", group: "Settings", shortcut: "Ctrl+," },
  { id: "keyboard-shortcuts", label: "Keyboard Shortcuts", icon: "keyboard", group: "Settings", shortcut: "Ctrl+?" },
];

export function getAllActions(): ActionRegistryEntry[] {
  return [...STATIC_ACTIONS];
}

export function getAction(id: string): ActionRegistryEntry | undefined {
  return STATIC_ACTIONS.find((a) => a.id === id);
}

export function getActionsByGroup(): Record<string, ActionRegistryEntry[]> {
  const groups: Record<string, ActionRegistryEntry[]> = {};
  for (const action of STATIC_ACTIONS) {
    if (!groups[action.group]) groups[action.group] = [];
    groups[action.group].push(action);
  }
  return groups;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/lib/__tests__/action-registry.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/lib/action-registry.ts frontend/lib/__tests__/action-registry.test.ts
git commit -m "feat(quick-actions): add action registry for topbar quick actions"
```

---

## Task 2: Create the Quick Actions Zustand Store

**Files:**
- Create: `frontend/stores/quick-actions.ts`
- Test: `frontend/stores/__tests__/quick-actions.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
}));

import { useQuickActionsStore } from "../quick-actions";
import { invoke } from "@/lib/ipc";

const mockedInvoke = vi.mocked(invoke);

describe("quick-actions store", () => {
  beforeEach(() => {
    useQuickActionsStore.setState({
      actions: [],
      loaded: false,
    });
    vi.clearAllMocks();
  });

  it("starts with empty actions", () => {
    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([]);
    expect(state.loaded).toBe(false);
  });

  it("loads actions from config", async () => {
    mockedInvoke.mockResolvedValueOnce([
      { actionId: "open-files" },
      { actionId: "open-browser" },
    ]);

    await useQuickActionsStore.getState().loadActions();

    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([
      { actionId: "open-files" },
      { actionId: "open-browser" },
    ]);
    expect(state.loaded).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("get_quick_actions");
  });

  it("adds a quick action and persists", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    useQuickActionsStore.setState({ actions: [], loaded: true });

    await useQuickActionsStore.getState().addAction("open-files");

    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([{ actionId: "open-files" }]);
    expect(mockedInvoke).toHaveBeenCalledWith("save_quick_actions", {
      actions: [{ actionId: "open-files" }],
    });
  });

  it("does not add duplicate action", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    useQuickActionsStore.setState({
      actions: [{ actionId: "open-files" }],
      loaded: true,
    });

    await useQuickActionsStore.getState().addAction("open-files");

    expect(useQuickActionsStore.getState().actions).toHaveLength(1);
  });

  it("removes a quick action and persists", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    useQuickActionsStore.setState({
      actions: [{ actionId: "open-files" }, { actionId: "open-browser" }],
      loaded: true,
    });

    await useQuickActionsStore.getState().removeAction("open-files");

    const state = useQuickActionsStore.getState();
    expect(state.actions).toEqual([{ actionId: "open-browser" }]);
    expect(mockedInvoke).toHaveBeenCalledWith("save_quick_actions", {
      actions: [{ actionId: "open-browser" }],
    });
  });

  it("reorders actions via moveAction", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    useQuickActionsStore.setState({
      actions: [
        { actionId: "open-files" },
        { actionId: "open-browser" },
        { actionId: "zoom-in" },
      ],
      loaded: true,
    });

    await useQuickActionsStore.getState().moveAction(2, 0);

    expect(useQuickActionsStore.getState().actions.map((a) => a.actionId)).toEqual([
      "zoom-in",
      "open-files",
      "open-browser",
    ]);
  });

  it("checks if an action is pinned", () => {
    useQuickActionsStore.setState({
      actions: [{ actionId: "open-files" }],
      loaded: true,
    });

    expect(useQuickActionsStore.getState().isPinned("open-files")).toBe(true);
    expect(useQuickActionsStore.getState().isPinned("zoom-in")).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/stores/__tests__/quick-actions.test.ts --reporter=verbose`
Expected: FAIL - module not found

**Step 3: Write minimal implementation**

```typescript
// frontend/stores/quick-actions.ts
import { create } from "zustand";
import { invoke } from "@/lib/ipc";

export interface QuickAction {
  actionId: string;
}

interface QuickActionsState {
  actions: QuickAction[];
  loaded: boolean;

  loadActions: () => Promise<void>;
  addAction: (actionId: string) => Promise<void>;
  removeAction: (actionId: string) => Promise<void>;
  moveAction: (fromIndex: number, toIndex: number) => Promise<void>;
  isPinned: (actionId: string) => boolean;
}

export const useQuickActionsStore = create<QuickActionsState>((set, get) => ({
  actions: [],
  loaded: false,

  loadActions: async () => {
    try {
      const actions = await invoke<QuickAction[]>("get_quick_actions");
      set({ actions: actions ?? [], loaded: true });
    } catch {
      set({ actions: [], loaded: true });
    }
  },

  addAction: async (actionId: string) => {
    const { actions } = get();
    if (actions.some((a) => a.actionId === actionId)) return;

    const updated = [...actions, { actionId }];
    set({ actions: updated });
    await invoke("save_quick_actions", { actions: updated }).catch(() => {});
  },

  removeAction: async (actionId: string) => {
    const { actions } = get();
    const updated = actions.filter((a) => a.actionId !== actionId);
    set({ actions: updated });
    await invoke("save_quick_actions", { actions: updated }).catch(() => {});
  },

  moveAction: async (fromIndex: number, toIndex: number) => {
    const { actions } = get();
    const updated = [...actions];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    set({ actions: updated });
    await invoke("save_quick_actions", { actions: updated }).catch(() => {});
  },

  isPinned: (actionId: string) => {
    return get().actions.some((a) => a.actionId === actionId);
  },
}));
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/stores/__tests__/quick-actions.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/stores/quick-actions.ts frontend/stores/__tests__/quick-actions.test.ts
git commit -m "feat(quick-actions): add Zustand store with persistence via IPC"
```

---

## Task 3: Add IPC Handlers for Quick Actions Persistence

**Files:**
- Modify: `electron/config.ts` (add `quickActions` to ConfigSchema + helpers)
- Modify: `electron/main.ts` (add `get_quick_actions` and `save_quick_actions` IPC handlers)
- Test: `electron/__tests__/quick-actions-ipc.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron-store
const mockGet = vi.fn();
const mockSet = vi.fn();
vi.mock("electron-store", () => ({
  default: vi.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
  })),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), getName: vi.fn(() => "forja"), getVersion: vi.fn(() => "1.0.0") },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: vi.fn(),
}));

import { getQuickActions, saveQuickActions } from "../config";

describe("quick-actions config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getQuickActions returns empty array when not set", () => {
    mockGet.mockReturnValue(undefined);
    const result = getQuickActions();
    expect(result).toEqual([]);
  });

  it("getQuickActions returns stored actions", () => {
    mockGet.mockReturnValue([{ actionId: "open-files" }]);
    const result = getQuickActions();
    expect(result).toEqual([{ actionId: "open-files" }]);
  });

  it("saveQuickActions persists actions", () => {
    const actions = [{ actionId: "open-files" }, { actionId: "zoom-in" }];
    saveQuickActions(actions);
    expect(mockSet).toHaveBeenCalledWith("quickActions", actions);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/__tests__/quick-actions-ipc.test.ts --reporter=verbose`
Expected: FAIL - `getQuickActions` not exported

**Step 3: Write minimal implementation**

Add to `electron/config.ts`:

```typescript
// Near the ConfigSchema interface, add:
//   quickActions: Array<{ actionId: string }>;

// Add these exported functions:
export function getQuickActions(): Array<{ actionId: string }> {
  const raw = store.get("quickActions" as keyof ConfigSchema);
  return Array.isArray(raw) ? raw : [];
}

export function saveQuickActions(actions: Array<{ actionId: string }>): void {
  store.set("quickActions" as keyof ConfigSchema, actions);
}
```

Add to `electron/main.ts` (near existing IPC handlers):

```typescript
import { getQuickActions, saveQuickActions } from "./config.js";

ipcMain.handle("get_quick_actions", () => {
  return getQuickActions();
});

ipcMain.handle("save_quick_actions", (_event, { actions }) => {
  saveQuickActions(actions);
});
```

Add to `electron/preload.ts` (in the `contextBridge.exposeInMainWorld` invoke map):

```typescript
// Add these to the channel allowlist
"get_quick_actions",
"save_quick_actions",
```

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/__tests__/quick-actions-ipc.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add electron/config.ts electron/main.ts electron/preload.ts electron/__tests__/quick-actions-ipc.test.ts
git commit -m "feat(quick-actions): add IPC handlers for quick actions persistence"
```

---

## Task 4: Create the Action Executor Module

**Files:**
- Create: `frontend/lib/action-executor.ts`
- Test: `frontend/lib/__tests__/action-executor.test.ts`

This module centralizes the `handleCommand` logic that is currently hardcoded inside `command-palette.tsx`, so both the command palette and quick action buttons can trigger the same actions.

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
}));

// Mock stores
vi.mock("@/stores/file-tree", () => ({
  useFileTreeStore: {
    getState: vi.fn(() => ({
      currentPath: "/test/project",
      openProject: vi.fn(),
      collapseAll: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/command-palette", () => ({
  useCommandPaletteStore: {
    getState: vi.fn(() => ({
      open: vi.fn(),
      close: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/tiling-layout", () => ({
  useTilingLayoutStore: {
    getState: vi.fn(() => ({
      addBlock: vi.fn(),
      hasBlock: vi.fn(() => false),
    })),
  },
}));

vi.mock("@/stores/app-dialogs", () => ({
  useAppDialogsStore: {
    getState: vi.fn(() => ({
      setShortcutsOpen: vi.fn(),
      setAboutOpen: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/terminal-zoom", () => ({
  useTerminalZoomStore: {
    getState: vi.fn(() => ({
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      resetZoom: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/focus-mode", () => ({
  useFocusModeStore: {
    getState: vi.fn(() => ({
      toggleFocusMode: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/user-settings", () => ({
  useUserSettingsStore: {
    getState: vi.fn(() => ({
      openSettingsEditor: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/file-preview", () => ({
  useFilePreviewStore: {
    getState: vi.fn(() => ({
      openPreview: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/git-diff", () => ({
  useGitDiffStore: {
    getState: vi.fn(() => ({
      changedFilesByProject: {},
      selectedProjectPath: null,
      selectedPath: null,
      selectChangedFile: vi.fn(),
      diffMode: "unified",
      setDiffMode: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/git-status", () => ({
  useGitStatusStore: {
    getState: vi.fn(() => ({
      forceFetchStatuses: vi.fn(),
    })),
  },
}));

vi.mock("@/stores/theme", () => ({
  useThemeStore: {
    getState: vi.fn(() => ({
      setActiveTheme: vi.fn(),
    })),
  },
}));

import { executeAction } from "../action-executor";

describe("action-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes zoom-in action", () => {
    const { useTerminalZoomStore } = require("@/stores/terminal-zoom");
    executeAction("zoom-in");
    expect(useTerminalZoomStore.getState().zoomIn).toHaveBeenCalled();
  });

  it("executes open-files action", () => {
    const { useTilingLayoutStore } = require("@/stores/tiling-layout");
    executeAction("open-files");
    expect(useTilingLayoutStore.getState().addBlock).toHaveBeenCalled();
  });

  it("executes toggle-focus-mode action", () => {
    const { useFocusModeStore } = require("@/stores/focus-mode");
    executeAction("toggle-focus-mode");
    expect(useFocusModeStore.getState().toggleFocusMode).toHaveBeenCalled();
  });

  it("returns false for unknown action", () => {
    const result = executeAction("nonexistent-action");
    expect(result).toBe(false);
  });

  it("returns true for known action", () => {
    const result = executeAction("zoom-in");
    expect(result).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/lib/__tests__/action-executor.test.ts --reporter=verbose`
Expected: FAIL - module not found

**Step 3: Write minimal implementation**

```typescript
// frontend/lib/action-executor.ts
import { useFileTreeStore } from "@/stores/file-tree";
import { useCommandPaletteStore } from "@/stores/command-palette";
import { useTilingLayoutStore } from "@/stores/tiling-layout";
import { useAppDialogsStore } from "@/stores/app-dialogs";
import { useTerminalZoomStore } from "@/stores/terminal-zoom";
import { useFocusModeStore } from "@/stores/focus-mode";
import { useUserSettingsStore } from "@/stores/user-settings";
import { useFilePreviewStore } from "@/stores/file-preview";
import { useGitDiffStore } from "@/stores/git-diff";
import { useGitStatusStore } from "@/stores/git-status";
import { useTerminalTabsStore } from "@/stores/terminal-tabs";
import { usePluginsStore, getOrderedEnabledPlugins } from "@/stores/plugins";
import { invoke } from "@/lib/ipc";
import type { SessionType } from "@/lib/cli-registry";

let browserCounter = 0;

/**
 * Execute a registered action by ID.
 * Returns true if action was found and executed, false otherwise.
 */
export function executeAction(actionId: string): boolean {
  // Handle dynamic plugin actions: "plugin:<name>"
  if (actionId.startsWith("plugin:")) {
    const pluginName = actionId.slice("plugin:".length);
    const { plugins, pluginOrder } = usePluginsStore.getState();
    const enabled = getOrderedEnabledPlugins({ plugins, pluginOrder });
    const plugin = enabled.find((p) => p.manifest.name === pluginName);
    if (!plugin) return false;
    const tilingStore = useTilingLayoutStore.getState();
    tilingStore.addBlock(
      {
        type: "plugin",
        pluginName: plugin.manifest.name,
        pluginDisplayName: plugin.manifest.displayName,
        pluginIcon: plugin.manifest.icon,
      },
      undefined,
      `plugin-${pluginName}`,
    );
    return true;
  }

  // Handle dynamic session actions: "session:<type>"
  if (actionId.startsWith("session:")) {
    const sessionType = actionId.slice("session:".length) as SessionType;
    const cp = useFileTreeStore.getState().currentPath;
    if (!cp) return false;
    const tabStore = useTerminalTabsStore.getState();
    const id = tabStore.nextTabId();
    tabStore.addTab(id, cp, sessionType);
    return true;
  }

  switch (actionId) {
    case "new-session":
      if (!useFileTreeStore.getState().currentPath) return false;
      useCommandPaletteStore.getState().open("sessions");
      return true;

    case "go-to-project":
      useCommandPaletteStore.getState().open("projects");
      return true;

    case "open-project":
      useFileTreeStore.getState().openProject();
      return true;

    case "open-files": {
      const tilingStore = useTilingLayoutStore.getState();
      if (!tilingStore.hasBlock("tab-file-tree")) {
        const tree = useFileTreeStore.getState().tree;
        const projectName = tree?.root.name;
        tilingStore.addBlock(
          { type: "file-tree", projectName },
          undefined,
          "tab-file-tree",
        );
      }
      return true;
    }

    case "open-browser": {
      const tilingStore = useTilingLayoutStore.getState();
      browserCounter += 1;
      const blockId = `browser-${Date.now().toString(36)}-${browserCounter}`;
      tilingStore.addBlock(
        { type: "browser", url: "https://github.com" },
        undefined,
        blockId,
      );
      return true;
    }

    case "toggle-focus-mode":
      useFocusModeStore.getState().toggleFocusMode();
      return true;

    case "zoom-in":
      useTerminalZoomStore.getState().zoomIn();
      return true;

    case "zoom-out":
      useTerminalZoomStore.getState().zoomOut();
      return true;

    case "zoom-reset":
      useTerminalZoomStore.getState().resetZoom();
      return true;

    case "git-changes": {
      const projectPath = useFileTreeStore.getState().currentPath;
      if (!projectPath) return false;
      const diffState = useGitDiffStore.getState();
      const files = diffState.changedFilesByProject[projectPath] ?? [];
      if (files.length === 0) return false;
      useFilePreviewStore.getState().openPreview();
      const targetPath =
        diffState.selectedProjectPath === projectPath && diffState.selectedPath
          ? diffState.selectedPath
          : files[0].path;
      diffState.selectChangedFile(projectPath, targetPath);
      return true;
    }

    case "toggle-diff-mode": {
      const diff = useGitDiffStore.getState();
      diff.setDiffMode(diff.diffMode === "split" ? "unified" : "split");
      return true;
    }

    case "refresh-git": {
      const path = useFileTreeStore.getState().currentPath;
      if (path) useGitStatusStore.getState().forceFetchStatuses(path);
      return true;
    }

    case "change-theme":
      useCommandPaletteStore.getState().open("themes");
      return true;

    case "open-settings":
      useUserSettingsStore.getState().openSettingsEditor();
      useFilePreviewStore.getState().openPreview();
      return true;

    case "keyboard-shortcuts":
      useAppDialogsStore.getState().setShortcutsOpen(true);
      return true;

    case "about":
      useAppDialogsStore.getState().setAboutOpen(true);
      return true;

    case "dev-reload":
      window.location.reload();
      return true;

    case "dev-clear-cache":
      invoke("app:clearCache").catch(() => {});
      return true;

    case "collapse-all":
      useFileTreeStore.getState().collapseAll();
      return true;

    default:
      return false;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/lib/__tests__/action-executor.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/lib/action-executor.ts frontend/lib/__tests__/action-executor.test.ts
git commit -m "feat(quick-actions): add centralized action executor module"
```

---

## Task 5: Create the QuickActions Titlebar Component

**Files:**
- Create: `frontend/components/quick-actions.tsx`
- Test: `frontend/components/__tests__/quick-actions.test.tsx`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
}));

vi.mock("@/lib/action-executor", () => ({
  executeAction: vi.fn(() => true),
}));

vi.mock("@/lib/action-registry", () => ({
  getAction: vi.fn((id: string) => {
    const actions: Record<string, { id: string; label: string; icon: string; group: string }> = {
      "open-files": { id: "open-files", label: "Open Files", icon: "folder-tree", group: "Panels & View" },
      "zoom-in": { id: "zoom-in", label: "Zoom In", icon: "zoom-in", group: "Terminal" },
    };
    return actions[id];
  }),
}));

vi.mock("@/stores/quick-actions", () => {
  const store = {
    actions: [
      { actionId: "open-files" },
      { actionId: "zoom-in" },
    ],
    loaded: true,
    loadActions: vi.fn(),
    removeAction: vi.fn(),
  };
  return {
    useQuickActionsStore: Object.assign(
      (selector: (s: typeof store) => unknown) => selector(store),
      { getState: () => store, setState: vi.fn(), subscribe: vi.fn() },
    ),
  };
});

vi.mock("@/stores/command-palette", () => ({
  useCommandPaletteStore: {
    getState: vi.fn(() => ({
      open: vi.fn(),
    })),
  },
}));

import { QuickActions } from "../quick-actions";
import { executeAction } from "@/lib/action-executor";

describe("QuickActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders pinned action buttons", () => {
    render(<QuickActions />);
    expect(screen.getByLabelText("Open Files")).toBeDefined();
    expect(screen.getByLabelText("Zoom In")).toBeDefined();
  });

  it("renders the add button", () => {
    render(<QuickActions />);
    expect(screen.getByLabelText("Add quick action")).toBeDefined();
  });

  it("executes action on button click", () => {
    render(<QuickActions />);
    fireEvent.click(screen.getByLabelText("Open Files"));
    expect(executeAction).toHaveBeenCalledWith("open-files");
  });

  it("opens picker when add button is clicked", () => {
    const { useCommandPaletteStore } = require("@/stores/command-palette");
    render(<QuickActions />);
    fireEvent.click(screen.getByLabelText("Add quick action"));
    expect(useCommandPaletteStore.getState().open).toHaveBeenCalledWith("quick-actions");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/components/__tests__/quick-actions.test.tsx --reporter=verbose`
Expected: FAIL - module not found

**Step 3: Write minimal implementation**

```tsx
// frontend/components/quick-actions.tsx
import { useEffect } from "react";
import { Plus } from "lucide-react";
import * as icons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuickActionsStore } from "@/stores/quick-actions";
import { useCommandPaletteStore } from "@/stores/command-palette";
import { getAction } from "@/lib/action-registry";
import { executeAction } from "@/lib/action-executor";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";

function getIconComponent(iconName: string): LucideIcon {
  const pascalCase = iconName
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (icons as Record<string, LucideIcon>)[pascalCase] ?? icons.CircleDot;
}

export function QuickActions() {
  const actions = useQuickActionsStore((s) => s.actions);
  const loaded = useQuickActionsStore((s) => s.loaded);
  const loadActions = useQuickActionsStore((s) => s.loadActions);

  useEffect(() => {
    if (!loaded) loadActions();
  }, [loaded, loadActions]);

  const handleAdd = () => {
    useCommandPaletteStore.getState().open("quick-actions");
  };

  if (!loaded) return null;

  return (
    <div className="flex items-center gap-0.5">
      {actions.map((qa) => {
        const entry = getAction(qa.actionId);
        if (!entry) return null;
        const Icon = getIconComponent(entry.icon);

        return (
          <Tooltip key={qa.actionId}>
            <TooltipTrigger asChild>
              <button
                onClick={() => executeAction(qa.actionId)}
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-md",
                  "text-ctp-overlay1 transition-colors",
                  "hover:bg-ctp-surface0 hover:text-ctp-text",
                )}
                aria-label={entry.label}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-app-xs">
              {entry.label}
              {entry.shortcut && (
                <span className="ml-2 text-ctp-overlay0">{entry.shortcut}</span>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleAdd}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md",
              "text-ctp-overlay0 transition-colors",
              "hover:bg-ctp-surface0 hover:text-ctp-text",
            )}
            aria-label="Add quick action"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-app-xs">
          Add quick action
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/components/__tests__/quick-actions.test.tsx --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/components/quick-actions.tsx frontend/components/__tests__/quick-actions.test.tsx
git commit -m "feat(quick-actions): add QuickActions titlebar component"
```

---

## Task 6: Add "quick-actions" Mode to Command Palette

**Files:**
- Modify: `frontend/stores/command-palette.ts` (add `"quick-actions"` to mode union)
- Modify: `frontend/components/command-palette.tsx` (add `quick-actions` rendering mode)
- Test: `frontend/components/__tests__/command-palette-quick-actions.test.tsx`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
}));

vi.mock("@/hooks/use-installed-clis", () => ({
  useInstalledClis: () => ({
    installedClis: [{ id: "claude", displayName: "Claude" }],
    loading: false,
  }),
}));

vi.mock("@/stores/command-palette", () => {
  const store = {
    isOpen: true,
    mode: "quick-actions" as const,
    open: vi.fn(),
    close: vi.fn(),
  };
  return {
    useCommandPaletteStore: Object.assign(
      (selector: (s: typeof store) => unknown) => selector(store),
      { getState: () => store, setState: vi.fn(), subscribe: vi.fn() },
    ),
  };
});

vi.mock("@/stores/quick-actions", () => {
  const store = {
    actions: [{ actionId: "open-files" }],
    isPinned: (id: string) => id === "open-files",
    addAction: vi.fn(),
    removeAction: vi.fn(),
  };
  return {
    useQuickActionsStore: Object.assign(
      (selector: (s: typeof store) => unknown) => selector(store),
      { getState: () => store },
    ),
  };
});

vi.mock("@/lib/action-registry", () => ({
  getAllActions: () => [
    { id: "open-files", label: "Open Files", icon: "folder-tree", group: "Panels & View" },
    { id: "open-browser", label: "Open Browser", icon: "globe", group: "Panels & View" },
    { id: "zoom-in", label: "Zoom In", icon: "zoom-in", group: "Terminal" },
  ],
  getActionsByGroup: () => ({
    "Panels & View": [
      { id: "open-files", label: "Open Files", icon: "folder-tree", group: "Panels & View" },
      { id: "open-browser", label: "Open Browser", icon: "globe", group: "Panels & View" },
    ],
    Terminal: [
      { id: "zoom-in", label: "Zoom In", icon: "zoom-in", group: "Terminal" },
    ],
  }),
}));

// Mock remaining stores that command-palette.tsx imports
vi.mock("@/stores/file-tree", () => ({
  useFileTreeStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ tree: null, currentPath: "/test" }),
    { getState: () => ({ tree: null, currentPath: "/test" }) },
  ),
}));
vi.mock("@/stores/user-settings", () => ({ useUserSettingsStore: { getState: () => ({}) } }));
vi.mock("@/stores/file-preview", () => ({ useFilePreviewStore: { getState: () => ({}) } }));
vi.mock("@/stores/terminal-tabs", () => ({ useTerminalTabsStore: { getState: () => ({}) } }));
vi.mock("@/stores/terminal-zoom", () => ({ useTerminalZoomStore: { getState: () => ({}) } }));
vi.mock("@/stores/git-diff", () => ({ useGitDiffStore: { getState: () => ({}) } }));
vi.mock("@/stores/git-status", () => ({ useGitStatusStore: { getState: () => ({}) } }));
vi.mock("@/stores/theme", () => ({
  useThemeStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ customThemes: [] }),
    { getState: () => ({ getAllThemes: () => [] }) },
  ),
}));
vi.mock("@/stores/tiling-layout", () => ({
  useTilingLayoutStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({}),
    { getState: () => ({}) },
  ),
}));
vi.mock("@/stores/projects", () => ({
  useProjectsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ projects: [], activeProjectPath: null }),
    { getState: () => ({}) },
  ),
}));
vi.mock("@/stores/focus-mode", () => ({ useFocusModeStore: { getState: () => ({}) } }));
vi.mock("@/stores/plugins", () => ({
  usePluginsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ plugins: {}, pluginOrder: [] }),
    { getState: () => ({}) },
  ),
  getOrderedEnabledPlugins: () => [],
}));
vi.mock("@/stores/app-dialogs", () => ({ useAppDialogsStore: { getState: () => ({}) } }));

import { CommandPalette } from "../command-palette";

describe("CommandPalette quick-actions mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with 'Add Quick Action' placeholder", () => {
    render(<CommandPalette />);
    expect(screen.getByPlaceholderText("Add quick action...")).toBeDefined();
  });

  it("shows action groups", () => {
    render(<CommandPalette />);
    expect(screen.getByText("Panels & View")).toBeDefined();
    expect(screen.getByText("Terminal")).toBeDefined();
  });

  it("shows pinned indicator for already-pinned actions", () => {
    render(<CommandPalette />);
    // open-files is pinned, so it should show a check or "Pinned" indicator
    const openFilesItem = screen.getByText("Open Files");
    expect(openFilesItem).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/components/__tests__/command-palette-quick-actions.test.tsx --reporter=verbose`
Expected: FAIL - `"quick-actions"` not a valid mode

**Step 3: Write minimal implementation**

Update `frontend/stores/command-palette.ts`:

```typescript
export type CommandPaletteMode = "files" | "commands" | "sessions" | "themes" | "projects" | "quick-actions";
```

Add to `frontend/components/command-palette.tsx` (in the placeholder switch):

```typescript
// In the CommandInput placeholder:
: mode === "quick-actions"
  ? "Add quick action..."

// In the CommandEmpty:
: mode === "quick-actions"
  ? "No actions found."

// Add the quick-actions mode rendering block (after mode === "commands" block):
{mode === "quick-actions" && (
  <QuickActionsPicker />
)}
```

Create an inline `QuickActionsPicker` component inside `command-palette.tsx` (or export from a separate file):

```tsx
function QuickActionsPicker() {
  const { close } = useCommandPaletteStore();
  const { isPinned, addAction, removeAction } = useQuickActionsStore.getState();
  const groups = getActionsByGroup();

  const handleToggle = async (actionId: string) => {
    if (isPinned(actionId)) {
      await removeAction(actionId);
    } else {
      await addAction(actionId);
    }
    close();
  };

  return (
    <>
      {Object.entries(groups).map(([groupName, actions]) => (
        <CommandGroup key={groupName} heading={groupName}>
          {actions.map((action) => {
            const Icon = getIconComponent(action.icon);
            const pinned = isPinned(action.id);
            return (
              <CommandItem
                key={action.id}
                value={action.label}
                onSelect={() => handleToggle(action.id)}
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} />
                {action.label}
                {pinned && (
                  <Check className="ml-auto h-3.5 w-3.5 text-ctp-green" strokeWidth={1.5} />
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      ))}

      {/* Dynamic: installed CLI sessions */}
      <CommandGroup heading="Sessions">
        {installedClis.map((cli) => {
          const pinned = isPinned(`session:${cli.id}`);
          return (
            <CommandItem
              key={cli.id}
              value={`Session ${cli.displayName}`}
              onSelect={() => handleToggle(`session:${cli.id}`)}
            >
              <CliIcon sessionType={cli.id as SessionType} className="h-4 w-4" />
              {cli.displayName}
              {pinned && (
                <Check className="ml-auto h-3.5 w-3.5 text-ctp-green" strokeWidth={1.5} />
              )}
            </CommandItem>
          );
        })}
      </CommandGroup>

      {/* Dynamic: enabled plugins */}
      {enabledPlugins.length > 0 && (
        <CommandGroup heading="Plugins">
          {enabledPlugins.map((plugin) => {
            const Icon = getPluginIcon(plugin.manifest.icon) ?? Puzzle;
            const pinned = isPinned(`plugin:${plugin.manifest.name}`);
            return (
              <CommandItem
                key={plugin.manifest.name}
                value={`Plugin ${plugin.manifest.displayName}`}
                onSelect={() => handleToggle(`plugin:${plugin.manifest.name}`)}
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} />
                {plugin.manifest.displayName}
                {pinned && (
                  <Check className="ml-auto h-3.5 w-3.5 text-ctp-green" strokeWidth={1.5} />
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      )}
    </>
  );
}
```

New imports needed in command-palette.tsx:

```typescript
import { Check } from "lucide-react";
import { useQuickActionsStore } from "@/stores/quick-actions";
import { getActionsByGroup } from "@/lib/action-registry";
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/components/__tests__/command-palette-quick-actions.test.tsx --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/stores/command-palette.ts frontend/components/command-palette.tsx frontend/components/__tests__/command-palette-quick-actions.test.tsx
git commit -m "feat(quick-actions): add quick-actions picker mode to command palette"
```

---

## Task 7: Integrate QuickActions into Titlebar

**Files:**
- Modify: `frontend/components/titlebar.tsx`
- Test: `frontend/components/__tests__/titlebar-quick-actions.test.tsx`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
  getCurrentWindow: vi.fn(() => ({
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
  })),
  isDev: vi.fn(() => Promise.resolve(false)),
  isTilingDesktop: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@/stores/app-dialogs", () => {
  const store = { aboutOpen: false, setAboutOpen: vi.fn(), shortcutsOpen: false, setShortcutsOpen: vi.fn(), settingsOpen: false, setSettingsOpen: vi.fn() };
  return {
    useAppDialogsStore: Object.assign(
      (sel: (s: typeof store) => unknown) => sel(store),
      { getState: () => store },
    ),
  };
});

vi.mock("@/stores/command-palette", () => ({
  useCommandPaletteStore: { getState: vi.fn(() => ({ open: vi.fn() })) },
}));

vi.mock("@/stores/file-tree", () => ({
  APP_NAME: "Forja",
  useFileTreeStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ tree: null, openProject: vi.fn() }),
    { getState: () => ({}) },
  ),
}));

vi.mock("@/stores/performance", () => ({
  usePerformanceStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ isLite: false, toggleLiteMode: vi.fn() }),
    { getState: () => ({}) },
  ),
}));

vi.mock("@/lib/platform", () => ({
  IS_MAC: false,
  MOD_KEY: "Ctrl",
}));

// Mock the QuickActions component to verify it's rendered
vi.mock("../quick-actions", () => ({
  QuickActions: () => <div data-testid="quick-actions" />,
}));

vi.mock("../workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-testid="workspace-switcher" />,
}));

vi.mock("../about-dialog", () => ({
  AboutDialog: () => null,
}));

vi.mock("../keyboard-shortcuts-dialog", () => ({
  KeyboardShortcutsDialog: () => null,
}));

vi.mock("../settings-dialog", () => ({
  SettingsDialog: () => null,
}));

vi.mock("../resource-usage-popover", () => ({
  ResourceUsagePopover: () => null,
}));

import { Titlebar } from "../titlebar";

describe("Titlebar with QuickActions", () => {
  it("renders the QuickActions component", () => {
    render(<Titlebar />);
    expect(screen.getByTestId("quick-actions")).toBeDefined();
  });

  it("places QuickActions after the workspace switcher", () => {
    render(<Titlebar />);
    const ws = screen.getByTestId("workspace-switcher");
    const qa = screen.getByTestId("quick-actions");
    // Both should be in the left section
    expect(ws.compareDocumentPosition(qa) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/components/__tests__/titlebar-quick-actions.test.tsx --reporter=verbose`
Expected: FAIL - QuickActions not rendered

**Step 3: Write minimal implementation**

Modify `frontend/components/titlebar.tsx`:

Add import:
```typescript
import { QuickActions } from "./quick-actions";
```

Add `<QuickActions />` after `<WorkspaceSwitcher />` (line 140):

```tsx
<WorkspaceSwitcher />
<QuickActions />
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/components/__tests__/titlebar-quick-actions.test.tsx --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/components/titlebar.tsx frontend/components/__tests__/titlebar-quick-actions.test.tsx
git commit -m "feat(quick-actions): integrate QuickActions into titlebar"
```

---

## Task 8: Add Right-Click Context Menu to Quick Action Buttons

**Files:**
- Modify: `frontend/components/quick-actions.tsx` (add context menu for remove/reorder)
- Test: `frontend/components/__tests__/quick-actions-context-menu.test.tsx`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => () => {}),
}));

vi.mock("@/lib/action-executor", () => ({
  executeAction: vi.fn(() => true),
}));

vi.mock("@/lib/action-registry", () => ({
  getAction: vi.fn((id: string) => ({
    id,
    label: id === "open-files" ? "Open Files" : "Zoom In",
    icon: "folder-tree",
    group: "test",
  })),
}));

const mockRemoveAction = vi.fn();
vi.mock("@/stores/quick-actions", () => {
  const store = {
    actions: [{ actionId: "open-files" }, { actionId: "zoom-in" }],
    loaded: true,
    loadActions: vi.fn(),
    removeAction: mockRemoveAction,
  };
  return {
    useQuickActionsStore: Object.assign(
      (selector: (s: typeof store) => unknown) => selector(store),
      { getState: () => store, setState: vi.fn(), subscribe: vi.fn() },
    ),
  };
});

vi.mock("@/stores/command-palette", () => ({
  useCommandPaletteStore: { getState: vi.fn(() => ({ open: vi.fn() })) },
}));

import { QuickActions } from "../quick-actions";

describe("QuickActions context menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows context menu on right-click", () => {
    render(<QuickActions />);
    const button = screen.getByLabelText("Open Files");
    fireEvent.contextMenu(button);
    expect(screen.getByText("Remove from quick actions")).toBeDefined();
  });

  it("calls removeAction when remove is clicked", () => {
    render(<QuickActions />);
    const button = screen.getByLabelText("Open Files");
    fireEvent.contextMenu(button);
    fireEvent.click(screen.getByText("Remove from quick actions"));
    expect(mockRemoveAction).toHaveBeenCalledWith("open-files");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/components/__tests__/quick-actions-context-menu.test.tsx --reporter=verbose`
Expected: FAIL - "Remove from quick actions" not found

**Step 3: Write minimal implementation**

Update `frontend/components/quick-actions.tsx` to wrap each action button with a `ContextMenu` from shadcn/ui:

```tsx
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Trash2 } from "lucide-react";

// In the actions.map(), wrap the Tooltip in a ContextMenu:
<ContextMenu key={qa.actionId}>
  <ContextMenuTrigger asChild>
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => executeAction(qa.actionId)}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md",
            "text-ctp-overlay1 transition-colors",
            "hover:bg-ctp-surface0 hover:text-ctp-text",
          )}
          aria-label={entry.label}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-app-xs">
        {entry.label}
        {entry.shortcut && (
          <span className="ml-2 text-ctp-overlay0">{entry.shortcut}</span>
        )}
      </TooltipContent>
    </Tooltip>
  </ContextMenuTrigger>
  <ContextMenuContent>
    <ContextMenuItem
      onClick={() => useQuickActionsStore.getState().removeAction(qa.actionId)}
      className="text-ctp-red"
    >
      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
      Remove from quick actions
    </ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/components/__tests__/quick-actions-context-menu.test.tsx --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/components/quick-actions.tsx frontend/components/__tests__/quick-actions-context-menu.test.tsx
git commit -m "feat(quick-actions): add right-click context menu to remove pinned actions"
```

---

## Task 9: Refactor Command Palette to Use Action Executor

**Files:**
- Modify: `frontend/components/command-palette.tsx` (replace hardcoded `handleCommand` with `executeAction`)
- Test: Run existing tests to ensure no regressions

**Step 1: Refactor handleCommand**

Replace the `handleCommand` function body in `command-palette.tsx` with:

```typescript
const handleCommand = (command: string) => {
  // Special cases that change command palette mode (don't close)
  if (command === "new-session") {
    if (!useFileTreeStore.getState().currentPath) {
      close();
      return;
    }
    open("sessions");
    return;
  }
  if (command === "go-to-project") {
    open("projects");
    return;
  }

  // Delegate to centralized executor
  executeAction(command);
  close();
};
```

Add import:
```typescript
import { executeAction } from "@/lib/action-executor";
```

**Step 2: Run all tests to verify no regressions**

Run: `pnpm test --reporter=verbose`
Expected: All existing tests PASS

**Step 3: Commit**

```bash
git add frontend/components/command-palette.tsx
git commit -m "refactor(command-palette): delegate command execution to action-executor"
```

---

## Task 10: Add Dynamic Plugin and Session Actions to Registry

**Files:**
- Modify: `frontend/lib/action-registry.ts` (add `getDynamicActions()` that includes plugins + CLIs)
- Modify: `frontend/lib/__tests__/action-registry.test.ts` (add tests for dynamic actions)

**Step 1: Write the failing test**

Add to the existing test file:

```typescript
import { getDynamicActions } from "../action-registry";

describe("dynamic actions", () => {
  it("returns session actions for installed CLIs", () => {
    // getDynamicActions accepts installed CLIs and enabled plugins
    const actions = getDynamicActions(
      [{ id: "claude", displayName: "Claude" }],
      [],
    );
    const sessionAction = actions.find((a) => a.id === "session:claude");
    expect(sessionAction).toBeDefined();
    expect(sessionAction!.group).toBe("Sessions");
  });

  it("returns plugin actions for enabled plugins", () => {
    const actions = getDynamicActions(
      [],
      [{ name: "git-graph", displayName: "Git Graph", icon: "git-branch" }],
    );
    const pluginAction = actions.find((a) => a.id === "plugin:git-graph");
    expect(pluginAction).toBeDefined();
    expect(pluginAction!.group).toBe("Plugins");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/lib/__tests__/action-registry.test.ts --reporter=verbose`
Expected: FAIL - `getDynamicActions` not exported

**Step 3: Write minimal implementation**

Add to `frontend/lib/action-registry.ts`:

```typescript
interface CliInfo {
  id: string;
  displayName: string;
}

interface PluginInfo {
  name: string;
  displayName: string;
  icon: string;
}

export function getDynamicActions(
  installedClis: CliInfo[],
  enabledPlugins: PluginInfo[],
): ActionRegistryEntry[] {
  const actions: ActionRegistryEntry[] = [];

  for (const cli of installedClis) {
    actions.push({
      id: `session:${cli.id}`,
      label: cli.displayName,
      icon: "terminal-square",
      group: "Sessions",
      requiresProject: true,
    });
  }

  // Always include terminal session
  actions.push({
    id: "session:terminal",
    label: "Terminal",
    icon: "terminal-square",
    group: "Sessions",
    requiresProject: true,
  });

  for (const plugin of enabledPlugins) {
    actions.push({
      id: `plugin:${plugin.name}`,
      label: plugin.displayName,
      icon: plugin.icon || "puzzle",
      group: "Plugins",
    });
  }

  return actions;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test frontend/lib/__tests__/action-registry.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add frontend/lib/action-registry.ts frontend/lib/__tests__/action-registry.test.ts
git commit -m "feat(quick-actions): add dynamic session and plugin actions to registry"
```

---

## Task 11: Load Quick Actions on App Startup

**Files:**
- Modify: `frontend/components/app.tsx` or the root component that initializes stores
- Test: Verify manually that quick actions load on startup

**Step 1: Find the root initialization point**

Search for where `loadSettings` or other store initialization happens (likely in `App.tsx` or a top-level `useEffect`).

**Step 2: Add quick actions loading**

```typescript
import { useQuickActionsStore } from "@/stores/quick-actions";

// In the root useEffect that loads initial data:
useQuickActionsStore.getState().loadActions();
```

**Step 3: Run all tests**

Run: `pnpm test --reporter=verbose`
Expected: All PASS

**Step 4: Commit**

```bash
git add frontend/components/app.tsx
git commit -m "feat(quick-actions): load quick actions on app startup"
```

---

## Task 12: Final Integration Test and Polish

**Files:**
- Run full test suite
- Manual testing checklist

**Step 1: Run full test suite**

Run: `pnpm test --reporter=verbose`
Expected: All tests PASS

**Step 2: Manual testing checklist**

```
[ ] App starts, titlebar shows (no quick actions initially, just the "+" button)
[ ] Click "+" opens command palette in "Add Quick Action" mode
[ ] Selecting an action pins it to the titlebar
[ ] Pinned action appears as icon button between workspace switcher and title
[ ] Clicking pinned action executes the command
[ ] Right-clicking pinned action shows "Remove from quick actions"
[ ] Removing action removes the icon from titlebar
[ ] Quick actions persist across app restarts
[ ] Already-pinned actions show a check mark in the picker
[ ] Plugin actions appear in the picker when plugins are enabled
[ ] Session actions appear in the picker when CLIs are installed
[ ] Tooltip shows action name and shortcut on hover
```

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(quick-actions): complete topbar quick actions feature"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Action Registry | `frontend/lib/action-registry.ts` |
| 2 | Quick Actions Store | `frontend/stores/quick-actions.ts` |
| 3 | IPC Persistence | `electron/config.ts`, `electron/main.ts`, `electron/preload.ts` |
| 4 | Action Executor | `frontend/lib/action-executor.ts` |
| 5 | QuickActions Component | `frontend/components/quick-actions.tsx` |
| 6 | Command Palette Mode | `frontend/stores/command-palette.ts`, `frontend/components/command-palette.tsx` |
| 7 | Titlebar Integration | `frontend/components/titlebar.tsx` |
| 8 | Context Menu (remove) | `frontend/components/quick-actions.tsx` |
| 9 | Refactor Command Palette | `frontend/components/command-palette.tsx` |
| 10 | Dynamic Actions | `frontend/lib/action-registry.ts` |
| 11 | Startup Loading | Root component |
| 12 | Integration Testing | Full suite |
