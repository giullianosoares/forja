# Single Source of Truth for Per-Project UI State

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the dual-state architecture (in-memory cache + disk config.json) that causes UI flicker when switching projects. Make `.forja/config.json` the single source of truth for per-project UI state.

**Architecture:** Remove all `*ByProject` in-memory caches from Zustand stores that hold UI state (layout, tabs, panels, sidebar, preview, plugins, browser). On project switch, save outgoing state to disk (awaited IPC), reset stores to defaults, then load incoming state from disk. Git data caches (`changedFilesByProject`, `statusesByProject`) stay as-is because they're fetched data, not user configuration.

**Tech Stack:** React 19, Zustand 5, Electron IPC, FlexLayout (flexlayout-react), Vitest

---

## Background

### Current Architecture (Dual-State)

```
Switch away from Project A:
  1. Save A's state to in-memory cache (sync)
  2. Fire-and-forget save A's state to disk (async IPC)

Switch to Project B:
  1. Restore B from in-memory cache (sync → renders stale state)
  2. If no cache, load B from disk (async → re-renders with correct state)
```

**Problem:** Step 1 of "Switch to" shows the in-memory cache instantly, which may contain stale state from a previous session. Then step 2 loads the correct state from disk and re-renders, causing visible flicker.

### Target Architecture (Single Source of Truth)

```
Switch away from Project A:
  1. Save A's state to disk (await IPC)

Switch to Project B:
  1. Reset stores to clean defaults (no stale flash)
  2. Load B from disk (await IPC)
  3. Apply loaded state
```

**Result:** User sees a clean/default state briefly while disk loads, never another project's stale state.

### Stores Affected

**UI State caches (REMOVE):**

| Store | Cache fields | Save/Restore methods |
|-------|-------------|---------------------|
| `tiling-layout.ts` | `layoutByProject` | `saveLayoutForProject`, `restoreLayoutForProject` |
| `terminal-tabs.ts` | `activeTabIdByProject`, `isFullscreenByProject` | `saveActiveTabForProject`, `restoreActiveTabForProject`, `saveFullscreenForProject`, `restoreFullscreenForProject` |
| `right-panel.ts` | `isOpenByProject`, `activeViewByProject` | `saveStateForProject`, `restoreStateForProject` |
| `file-tree.ts` | `isOpenByProject` | `saveSidebarStateForProject`, `restoreSidebarStateForProject` |
| `file-preview.ts` | `previewByProject` | `savePreviewForProject`, `restorePreviewForProject` |
| `plugins.ts` | `activePluginNameByProject` | `saveActivePluginForProject`, `restoreActivePluginForProject` |
| `browser-pane.ts` | `browserStateByProject` | `saveBrowserStateForProject`, `restoreBrowserStateForProject` |

**Data caches (KEEP as-is):**

| Store | Cache fields | Reason |
|-------|-------------|--------|
| `git-diff.ts` | `changedFilesByProject`, `diffByProject`, `_lastFetchByProject` | Fetched data with TTL, not user config |
| `git-status.ts` | `statusesByProject`, `_changedDirsByProject`, `_lastFetchByProject` | Fetched data with TTL, not user config |

### Key Files

| File | Role |
|------|------|
| `frontend/stores/projects.ts` | `switchToProject()` — main orchestrator |
| `frontend/stores/tiling-layout.ts` | Layout cache + save/restore |
| `frontend/stores/terminal-tabs.ts` | Tab cache + save/restore |
| `frontend/stores/right-panel.ts` | Right panel cache + save/restore |
| `frontend/stores/file-tree.ts` | Sidebar cache + save/restore |
| `frontend/stores/file-preview.ts` | Preview cache + save/restore |
| `frontend/stores/plugins.ts` | Plugin cache + save/restore |
| `frontend/stores/browser-pane.ts` | Browser cache + save/restore |
| `frontend/App.tsx` | Persist effect + beforeunload handler |
| `frontend/components/project-sidebar.tsx` | Remove project handler |
| `electron/project-config.ts` | `ForjaProjectConfig` type + disk read/write |
| `electron/config.ts` | `ProjectUiState` type + `get/saveProjectUiState` |

---

## Task 1: Expand `ProjectUiState` to cover all per-project UI fields

Currently `ProjectUiState` is missing some fields that are cached in-memory but not persisted. We need to add them so all UI state can be saved/loaded from disk.

**Files:**
- Modify: `electron/config.ts:40-59` (`ProjectUiState` interface)
- Modify: `electron/project-config.ts:7-24` (`ForjaProjectConfig.ui` interface)
- Test: `electron/__tests__/config.test.ts`

**Step 1: Write failing test**

Add test to `electron/__tests__/config.test.ts`:

```typescript
it("should persist and retrieve expanded ProjectUiState fields", () => {
  const state: ProjectUiState = {
    sidebarOpen: true,
    rightPanelOpen: true,
    rightPanelActiveView: "plugin",
    terminalFullscreen: false,
    previewFile: "/path/to/file.ts",
    browserOpen: true,
    browserUrl: "http://localhost:3000",
    activePluginName: "my-plugin",
    tabs: [{ sessionType: "claude", customName: "Main" }],
    activeTabIndex: 0,
    layoutJson: { global: {}, layout: { type: "row", children: [] } },
  };
  saveProjectUiState("ws-1", tmpProjectPath, state);
  const loaded = getProjectUiState("ws-1", tmpProjectPath);
  expect(loaded).toMatchObject(state);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/__tests__/config.test.ts -- -t "expanded ProjectUiState"`
Expected: FAIL — `rightPanelActiveView` and `activePluginName` not in type

**Step 3: Implement — expand both interfaces**

In `electron/config.ts:40-59`, add to `ProjectUiState`:

```typescript
export interface ProjectUiState {
  sidebarOpen?: boolean;
  rightPanelOpen?: boolean;
  rightPanelActiveView?: string;        // NEW
  terminalFullscreen?: boolean;
  previewFile?: string | null;
  browserOpen?: boolean;
  browserUrl?: string;
  activePluginName?: string | null;     // NEW
  sidebarSize?: number;
  previewSize?: number;
  tabs?: Array<{
    id?: string;
    path?: string;
    sessionType: string;
    cliSessionId?: string;
    exited?: boolean;
    customName?: string;
  }>;
  activeTabIndex?: number;
  layoutJson?: Record<string, unknown>;
}
```

In `electron/project-config.ts:11-23`, mirror the same fields in `ForjaProjectConfig.ui`.

**Step 4: Run test to verify it passes**

Run: `pnpm test electron/__tests__/config.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(config): expand ProjectUiState with rightPanelActiveView and activePluginName
```

---

## Task 2: Remove in-memory caches from `tiling-layout.ts`

**Files:**
- Modify: `frontend/stores/tiling-layout.ts`
- Test: `frontend/stores/__tests__/tiling-layout.test.ts` (existing tests — may need adjustments)

**Step 1: Write failing test**

Add test that verifies the store no longer has `layoutByProject`:

```typescript
it("should not have layoutByProject field", () => {
  const state = useTilingLayoutStore.getState();
  expect(state).not.toHaveProperty("layoutByProject");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test frontend/stores/__tests__/tiling-layout.test.ts -- -t "layoutByProject"`
Expected: FAIL

**Step 3: Implement**

In `frontend/stores/tiling-layout.ts`:

1. Remove `layoutByProject: Record<string, IJsonModel>` from interface and initial state
2. Remove `saveLayoutForProject` method
3. Remove `restoreLayoutForProject` method
4. Keep `loadFromJson` (still needed for loading from disk)
5. Update interface to remove the method signatures

**Step 4: Fix compilation errors and update affected tests**

Any test or code referencing `layoutByProject`, `saveLayoutForProject`, or `restoreLayoutForProject` will break. These will be fixed in Tasks 7-8 when `switchToProject` and `App.tsx` are refactored.

For now, temporarily comment out the calls in `switchToProject` and `App.tsx` to get the build passing. Mark with `// TODO: Task 7/8 will restructure this`.

**Step 5: Run tests**

Run: `pnpm test frontend/stores/__tests__/tiling-layout.test.ts`
Expected: PASS

**Step 6: Commit**

```
refactor(tiling-layout): remove layoutByProject in-memory cache
```

---

## Task 3: Remove in-memory caches from `terminal-tabs.ts`

**Files:**
- Modify: `frontend/stores/terminal-tabs.ts`
- Test: `frontend/stores/__tests__/terminal-tabs.test.ts`

**Step 1: Write failing test**

```typescript
it("should not have per-project cache fields", () => {
  const state = useTerminalTabsStore.getState();
  expect(state).not.toHaveProperty("activeTabIdByProject");
  expect(state).not.toHaveProperty("isFullscreenByProject");
});
```

**Step 2: Run test to verify it fails**

**Step 3: Implement**

Remove from interface and store:
- `activeTabIdByProject: Record<string, string>`
- `isFullscreenByProject: Record<string, boolean>`
- `saveActiveTabForProject()`
- `restoreActiveTabForProject()`
- `saveFullscreenForProject()`
- `restoreFullscreenForProject()`

Keep: `cleanupProjectState()` — but simplify it to only remove tabs for the project path (no cache cleanup needed).

**Step 4: Run tests and fix**

Run: `pnpm test frontend/stores/__tests__/terminal-tabs.test.ts`

**Step 5: Commit**

```
refactor(terminal-tabs): remove per-project in-memory caches
```

---

## Task 4: Remove in-memory caches from `right-panel.ts`, `file-tree.ts`, `file-preview.ts`

**Files:**
- Modify: `frontend/stores/right-panel.ts`
- Modify: `frontend/stores/file-tree.ts`
- Modify: `frontend/stores/file-preview.ts`
- Test: relevant `__tests__/` files

**Step 1: Write failing tests**

One test per store verifying cache fields don't exist.

**Step 2: Implement for each store**

`right-panel.ts` — Remove:
- `isOpenByProject`, `activeViewByProject`
- `saveStateForProject()`, `restoreStateForProject()`

`file-tree.ts` — Remove:
- `isOpenByProject`
- `saveSidebarStateForProject()`, `restoreSidebarStateForProject()`

`file-preview.ts` — Remove:
- `previewByProject`
- `savePreviewForProject()`, `restorePreviewForProject()`

**Step 3: Run tests**

Run: `pnpm test frontend/stores/__tests__/`

**Step 4: Commit**

```
refactor(stores): remove per-project caches from right-panel, file-tree, file-preview
```

---

## Task 5: Remove in-memory caches from `plugins.ts` and `browser-pane.ts`

**Files:**
- Modify: `frontend/stores/plugins.ts`
- Modify: `frontend/stores/browser-pane.ts`
- Test: relevant `__tests__/` files

**Step 1: Implement**

`plugins.ts` — Remove:
- `activePluginNameByProject: Record<string, string | null>`
- `saveActivePluginForProject()`, `restoreActivePluginForProject()`

`browser-pane.ts` — Remove:
- `browserStateByProject: Record<string, PerProjectBrowserState>`
- `saveBrowserStateForProject()`, `restoreBrowserStateForProject()`

**Step 2: Run tests**

**Step 3: Commit**

```
refactor(stores): remove per-project caches from plugins and browser-pane
```

---

## Task 6: Create `saveCurrentProjectToDisk` and `loadProjectFromDisk` helpers

These are the two core functions that replace all the individual save/restore methods. They consolidate all per-project UI state into a single disk write/read.

**Files:**
- Modify: `frontend/stores/projects.ts` (add helper functions)
- Test: `frontend/stores/__tests__/projects.test.ts`

**Step 1: Write failing test**

```typescript
describe("saveCurrentProjectToDisk", () => {
  it("should invoke save_project_ui_state with full UI state", async () => {
    // Setup: add project, set as active, set up stores with known state
    // Call saveCurrentProjectToDisk
    // Assert invoke was called with the right shape
  });
});

describe("loadProjectFromDisk", () => {
  it("should load UI state from disk and apply to stores", async () => {
    // Setup: mock invoke to return saved state
    // Call loadProjectFromDisk
    // Assert stores were updated correctly
  });
});
```

**Step 2: Implement `saveCurrentProjectToDisk`**

This function collects UI state from ALL stores and writes to disk in one IPC call:

```typescript
async function saveCurrentProjectToDisk(projectPath: string): Promise<void> {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!wsId) return;

  const tabsStore = useTerminalTabsStore.getState();
  const tilingStore = useTilingLayoutStore.getState();
  const fileTreeStore = useFileTreeStore.getState();
  const rightPanelStore = useRightPanelStore.getState();
  const previewStore = useFilePreviewStore.getState();
  const pluginsStore = usePluginsStore.getState();

  await invoke("save_project_ui_state", {
    workspaceId: wsId,
    path: projectPath,
    state: {
      sidebarOpen: fileTreeStore.isOpen,
      rightPanelOpen: rightPanelStore.isOpen,
      rightPanelActiveView: rightPanelStore.activeView,
      terminalFullscreen: tabsStore.isTerminalFullscreen,
      previewFile: previewStore.currentFile,
      activePluginName: pluginsStore.activePluginName,
      layoutJson: tilingStore.getModelJson() as Record<string, unknown>,
      ...tabsStore.serializeTabsForSave(projectPath),
    },
  });
}
```

**Step 3: Implement `loadProjectFromDisk`**

This loads state from disk and applies it to all stores:

```typescript
async function loadProjectFromDisk(projectPath: string): Promise<void> {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!wsId) return;

  const savedState = await invoke<ProjectUiState | null>(
    "get_project_ui_state",
    { workspaceId: wsId, path: projectPath },
  );

  if (!savedState) return;

  // Apply to stores
  if (savedState.sidebarOpen !== undefined) {
    useFileTreeStore.setState({ isOpen: savedState.sidebarOpen });
  }
  if (savedState.rightPanelOpen !== undefined) {
    const hasPlugin = usePluginsStore.getState().activePluginName !== null;
    useRightPanelStore.setState({
      isOpen: savedState.rightPanelOpen && hasPlugin,
      activeView: (savedState.rightPanelActiveView as any) ?? "empty",
    });
  }
  if (savedState.terminalFullscreen !== undefined) {
    useTerminalTabsStore.setState({
      isTerminalFullscreen: savedState.terminalFullscreen,
    });
  }
  if (savedState.activePluginName !== undefined) {
    usePluginsStore.getState().setActivePlugin(savedState.activePluginName);
  }

  // Restore tiling layout
  if (savedState.layoutJson) {
    const { parseLayoutJson } = await import("@/lib/layout-migration");
    let layout = parseLayoutJson(savedState.layoutJson);

    const projectTabs = useTerminalTabsStore.getState().getTabsForProject(projectPath);
    if (projectTabs.length === 0) {
      const { stripProjectBlocksFromJson } = await import("./tiling-layout");
      layout = stripProjectBlocksFromJson(layout);
    }

    useTilingLayoutStore.getState().loadFromJson(layout);
  }

  // Restore tabs
  if (savedState.tabs?.length) {
    const existingTabs = useTerminalTabsStore.getState().getTabsForProject(projectPath);
    if (existingTabs.length === 0) {
      const tabsStore = useTerminalTabsStore.getState();
      for (const tab of savedState.tabs) {
        const id = tab.id || tabsStore.nextTabId();
        tabsStore.registerTab(id, projectPath, tab.sessionType as SessionType, tab.customName);
        if (tab.cliSessionId) tabsStore.setCliSessionId(id, tab.cliSessionId);
        if (tab.exited) tabsStore.markTabExited(id);
      }
    }
  }
}
```

**Step 4: Run tests**

Run: `pnpm test frontend/stores/__tests__/projects.test.ts`

**Step 5: Commit**

```
feat(projects): add saveCurrentProjectToDisk and loadProjectFromDisk helpers
```

---

## Task 7: Refactor `switchToProject` to use disk as single source of truth

This is the core change. Replace all in-memory save/restore calls with the new disk-based helpers.

**Files:**
- Modify: `frontend/stores/projects.ts` (lines 162-375)
- Test: `frontend/stores/__tests__/projects.test.ts`

**Step 1: Write failing test**

```typescript
describe("switchToProject (single source of truth)", () => {
  it("should save outgoing project to disk before switching", async () => {
    // Setup two projects, switch between them
    // Assert invoke("save_project_ui_state") was called for outgoing project
  });

  it("should load incoming project from disk", async () => {
    // Mock get_project_ui_state to return saved state
    // Switch to project
    // Assert stores reflect the loaded state
  });

  it("should not use any *ByProject cache", async () => {
    // Verify switchToProject doesn't access any *ByProject field
  });
});
```

**Step 2: Implement refactored `switchToProject`**

The new flow:

```typescript
switchToProject: async (projectPath: string) => {
  const previousPath = get().activeProjectPath;
  if (previousPath === projectPath) return;

  set({ isSwitchingProject: true });
  try {
    // --- Pre-resolve dynamic imports ---
    const [
      { useTilingLayoutStore },
      { useFilePreviewStore },
      { useGitDiffStore },
      { useTerminalTabsStore },
      { useRightPanelStore },
      { usePluginsStore },
      { useFileTreeStore },
      { useFocusModeStore },
    ] = await Promise.all([...]);

    // Exit focus mode for correct save
    const wasFocusMode = useFocusModeStore.getState().isActive;
    if (wasFocusMode) useFocusModeStore.getState().exitFocusMode();

    // 1. SAVE outgoing project to disk (AWAITED, not fire-and-forget)
    if (previousPath) {
      await saveCurrentProjectToDisk(previousPath);
    }

    // 2. Set new active project
    set({ activeProjectPath: projectPath });
    get().markProjectAsRead(projectPath);
    get().clearProjectNotified(projectPath);

    // 3. Reset stores to defaults (prevents stale flash)
    useFilePreviewStore.setState({
      currentFile: null, content: null, error: null,
      isEditing: false, editContent: null, editDirty: false,
    });
    useGitDiffStore.getState().clearSelection();
    useTerminalTabsStore.setState({ isTerminalFullscreen: false });
    useRightPanelStore.setState({ isOpen: false, activeView: "empty" });

    // 4. Pinned plugin override
    const { pinnedPluginName } = usePluginsStore.getState();
    if (pinnedPluginName) {
      usePluginsStore.getState().setActivePlugin(pinnedPluginName);
      useRightPanelStore.setState({ isOpen: true, activeView: "plugin" });
    }

    // 5. Load file tree
    await useFileTreeStore.getState().openProjectPath(projectPath);
    const updatedTree = useFileTreeStore.getState().tree;
    if (updatedTree?.root.name) {
      useTilingLayoutStore.getState().updateFileTreeTabName(updatedTree.root.name);
    }

    // 6. Load UI state from disk (single source of truth)
    await loadProjectFromDisk(projectPath);

    // 7. Ensure terminal blocks exist for loaded tabs
    useTerminalTabsStore.getState().ensureBlocksForProjectTabs(projectPath);

    // 8. Restore active tab for this project
    const projectTabs = useTerminalTabsStore.getState().getTabsForProject(projectPath);
    if (projectTabs.length > 0) {
      const activeTabId = useTerminalTabsStore.getState().activeTabId;
      if (!activeTabId || !projectTabs.some(t => t.id === activeTabId)) {
        useTerminalTabsStore.setState({ activeTabId: projectTabs[0].id });
      }
    }

    // Re-enter focus mode
    if (wasFocusMode) useFocusModeStore.getState().enterFocusMode();

    // Load icon if needed
    const project = get().projects.find(p => p.path === projectPath);
    if (project && project.iconPath === null) {
      await get().loadProjectIcon(projectPath);
    }
  } finally {
    set({ isSwitchingProject: false });
  }
},
```

**Step 3: Run all tests**

Run: `pnpm test`

**Step 4: Commit**

```
refactor(projects): switchToProject uses disk as single source of truth
```

---

## Task 8: Update `App.tsx` persist effect and `beforeunload` handler

**Files:**
- Modify: `frontend/App.tsx` (lines 700-769)

**Step 1: Write failing test (or verify manually)**

The `beforeunload` handler currently accesses `layoutByProject` which no longer exists.

**Step 2: Implement**

**Persist effect (lines 700-733):** No structural changes needed — it already saves the active project to disk. Just ensure it uses the consolidated `saveCurrentProjectToDisk` or the same inline shape.

**`beforeunload` handler (lines 738-769):** Simplify to only save the active project:

```typescript
const handler = () => {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!wsId) return;

  const activeProjectPath = useProjectsStore.getState().activeProjectPath;
  if (!activeProjectPath) return;

  const tabsStore = useTerminalTabsStore.getState();
  const tilingStore = useTilingLayoutStore.getState();

  invoke("save_project_ui_state", {
    workspaceId: wsId,
    path: activeProjectPath,
    state: {
      ...tabsStore.serializeTabsForSave(activeProjectPath),
      layoutJson: tilingStore.getModelJson() as Record<string, unknown>,
    },
  }).catch(() => {});
};
```

Non-active projects' state was already saved to disk when the user switched away from them (Task 7). No need to re-save them on `beforeunload`.

**Step 3: Run tests**

Run: `pnpm test`

**Step 4: Commit**

```
refactor(app): simplify beforeunload to save only active project
```

---

## Task 9: Update `project-sidebar.tsx` remove handler

**Files:**
- Modify: `frontend/components/project-sidebar.tsx`
- Test: `frontend/components/__tests__/project-sidebar.test.tsx`

**Step 1: Implement**

Simplify `handleRemoveConfirm` — no more `layoutByProject` cleanup or per-project cache cleanup needed:

```typescript
const handleRemoveConfirm = useCallback(async () => {
  if (!removingProject) return;
  const removedPath = removingProject.path;
  const wasActive = removedPath === activeProjectPath;
  const remaining = projects.filter(p => p.path !== removedPath);
  const nextActive = wasActive ? (remaining[0]?.path ?? null) : null;

  removeProject(removedPath);
  useFileTreeStore.getState().removeProjectTree(removedPath);
  setRemovingProject(null);

  // Clean up terminal tabs for removed project
  const { useTerminalTabsStore } = await import("@/stores/terminal-tabs");
  useTerminalTabsStore.getState().cleanupProjectState(removedPath);

  if (wasActive && nextActive) {
    await switchToProject(nextActive);
  }
}, [removingProject, removeProject, activeProjectPath, projects, switchToProject]);
```

**Step 2: Update tests**

Remove mocks for `@/stores/tiling-layout` `layoutByProject` access since it no longer exists.

**Step 3: Run tests**

Run: `pnpm test frontend/components/__tests__/project-sidebar.test.tsx`

**Step 4: Commit**

```
refactor(project-sidebar): simplify remove handler without in-memory caches
```

---

## Task 10: Full integration test and cleanup

**Files:**
- All modified files
- Test: Full test suite

**Step 1: Run full test suite**

Run: `pnpm test`

Fix any remaining compilation errors or test failures from removed fields.

**Step 2: Search for stale references**

Search the entire codebase for any remaining references to removed fields:
- `layoutByProject`
- `activeTabIdByProject`
- `isFullscreenByProject`
- `isOpenByProject` (right-panel and file-tree variants)
- `activeViewByProject`
- `previewByProject`
- `activePluginNameByProject`
- `browserStateByProject`
- `saveLayoutForProject`
- `restoreLayoutForProject`
- `saveActiveTabForProject`
- `restoreActiveTabForProject`
- `saveFullscreenForProject`
- `restoreFullscreenForProject`
- `saveStateForProject`
- `restoreStateForProject`
- `saveSidebarStateForProject`
- `restoreSidebarStateForProject`
- `savePreviewForProject`
- `restorePreviewForProject`
- `saveActivePluginForProject`
- `restoreActivePluginForProject`
- `saveBrowserStateForProject`
- `restoreBrowserStateForProject`

**Step 3: Build check**

Run: `pnpm build`

**Step 4: Commit**

```
refactor(stores): complete removal of per-project in-memory caches
```

---

## Execution Order

| Task | Dependency | Description |
|------|-----------|-------------|
| 1 | None | Expand `ProjectUiState` backend types |
| 2 | None | Remove cache from `tiling-layout.ts` |
| 3 | None | Remove cache from `terminal-tabs.ts` |
| 4 | None | Remove cache from `right-panel.ts`, `file-tree.ts`, `file-preview.ts` |
| 5 | None | Remove cache from `plugins.ts`, `browser-pane.ts` |
| 6 | 1 | Create `saveCurrentProjectToDisk` / `loadProjectFromDisk` |
| 7 | 2-6 | Refactor `switchToProject` |
| 8 | 7 | Update `App.tsx` persist/beforeunload |
| 9 | 7 | Update `project-sidebar.tsx` |
| 10 | 7-9 | Full integration test + cleanup |

Tasks 2-5 can run in parallel. Task 6 depends on Task 1. Tasks 7-9 depend on all prior tasks.

## Risk Notes

1. **`beforeunload` is synchronous** — `invoke()` is async (IPC). The current code already uses fire-and-forget here. This is unchanged.
2. **Disk read latency** — loading from disk on every switch adds ~5-15ms IPC overhead. This is negligible vs the 16ms frame budget and eliminates the flicker.
3. **Session restore on startup** — `App.tsx` restore logic already loads from disk. No changes needed there since it never used in-memory caches (first load).
4. **Git data caches preserved** — `changedFilesByProject` and `statusesByProject` stay in memory for performance. They're TTL-based fetched data, not user configuration.
