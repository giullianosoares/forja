import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilePreviewStore } from "@/stores/file-preview";

// Mock IPC layer
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
}));

const mockAddBlock = vi.fn();
const mockRemoveBlock = vi.fn();
const mockHasBlock = vi.fn(() => false);
const mockGetNodeById = vi.fn();
const mockUpdateFilePreviewTabName = vi.fn();

vi.mock("@/stores/tiling-layout", () => ({
  useTilingLayoutStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = {
        hasBlock: mockHasBlock,
        addBlock: mockAddBlock,
        removeBlock: mockRemoveBlock,
        updateFilePreviewTabName: mockUpdateFilePreviewTabName,
        model: { getNodeById: mockGetNodeById },
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        hasBlock: mockHasBlock,
        addBlock: mockAddBlock,
        removeBlock: mockRemoveBlock,
        updateFilePreviewTabName: mockUpdateFilePreviewTabName,
        model: { getNodeById: mockGetNodeById },
      }),
      setState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
  ),
}));

describe("useFilePreviewStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useFilePreviewStore.setState({
      isOpen: false,
      currentFile: null,
      content: null,
      isLoading: false,
      error: null,
    });
    mockAddBlock.mockClear();
    mockRemoveBlock.mockClear();
    mockHasBlock.mockReset().mockReturnValue(false);
    mockGetNodeById.mockReset();
    mockUpdateFilePreviewTabName.mockClear();
    vi.clearAllMocks();
  });

  describe("togglePreview", () => {
    it("should toggle isOpen from false to true", () => {
      const { togglePreview, isOpen: initialIsOpen } =
        useFilePreviewStore.getState();
      expect(initialIsOpen).toBe(false);

      togglePreview();

      const { isOpen: newIsOpen } = useFilePreviewStore.getState();
      expect(newIsOpen).toBe(true);
    });

    it("should toggle isOpen from true to false", () => {
      useFilePreviewStore.setState({ isOpen: true });

      const { togglePreview } = useFilePreviewStore.getState();
      togglePreview();

      const { isOpen } = useFilePreviewStore.getState();
      expect(isOpen).toBe(false);
    });
  });

  describe("openPreview", () => {
    it("should set isOpen to true", () => {
      const { openPreview } = useFilePreviewStore.getState();
      openPreview();

      const { isOpen } = useFilePreviewStore.getState();
      expect(isOpen).toBe(true);
    });
  });

  describe("closePreview", () => {
    it("should clear file content and close panel", () => {
      // Set non-default state
      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/test/file.ts",
        content: {
          path: "/test/file.ts",
          content: "test content",
          size: 100,
        },
        isLoading: false,
        error: "some error",
      });

      const { closePreview } = useFilePreviewStore.getState();
      closePreview();

      const state = useFilePreviewStore.getState();
      expect(state.isOpen).toBe(false);
      expect(state.currentFile).toBeNull();
      expect(state.content).toBeNull();
      expect(state.error).toBeNull();
      expect(state.isLoading).toBe(false);
    });
  });

  describe("loadFile", () => {
    it("should set loading state initially", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  path: "/test/file.ts",
                  content: "test content",
                  size: 100,
                }),
              50,
            );
          }),
      );

      const { loadFile } = useFilePreviewStore.getState();
      const promise = loadFile("/test/file.ts");

      // Check loading state immediately
      const { isLoading, currentFile } = useFilePreviewStore.getState();
      expect(isLoading).toBe(true);
      expect(currentFile).toBe("/test/file.ts");

      await promise;
    });

    it("should load file content successfully", async () => {
      const { invoke } = await import("@/lib/ipc");
      const mockContent = {
        path: "/test/file.ts",
        content: "test content",
        size: 100,
      };
      vi.mocked(invoke).mockResolvedValue(mockContent);

      const { loadFile } = useFilePreviewStore.getState();
      await loadFile("/test/file.ts");

      const state = useFilePreviewStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.isOpen).toBe(true);
      expect(state.currentFile).toBe("/test/file.ts");
      expect(state.content).toEqual(mockContent);
      expect(state.error).toBeNull();

      expect(invoke).toHaveBeenCalledWith("read_file_command", {
        path: "/test/file.ts",
        maxSizeMb: 10,
      });
    });

    it("should handle errors when loading file", async () => {
      const { invoke } = await import("@/lib/ipc");
      const errorMessage = "File not found";
      vi.mocked(invoke).mockRejectedValue(new Error(errorMessage));

      const { loadFile } = useFilePreviewStore.getState();
      await loadFile("/test/nonexistent.ts");

      const state = useFilePreviewStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.content).toBeNull();
      expect(state.error).toBe(errorMessage);
    });

    it("should handle string errors when loading file", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockRejectedValue("String error message");

      const { loadFile } = useFilePreviewStore.getState();
      await loadFile("/test/file.ts");

      const state = useFilePreviewStore.getState();
      expect(state.error).toBe("String error message");
    });

    it("calls updateFilePreviewTabName when block already exists (tab name updates on file switch)", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockResolvedValue({
        path: "/test/new-file.ts",
        content: "new content",
        size: 11,
      });

      // Block already exists — should update name, not add again
      mockHasBlock.mockReturnValue(true);

      await useFilePreviewStore.getState().loadFile("/test/new-file.ts");

      expect(mockAddBlock).not.toHaveBeenCalled();
      expect(mockUpdateFilePreviewTabName).toHaveBeenCalledWith("/test/new-file.ts");
    });

    it("does NOT call updateFilePreviewTabName when block is newly created", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockResolvedValue({
        path: "/test/file.ts",
        content: "content",
        size: 7,
      });

      // Block does not exist — should add, not update name
      mockHasBlock.mockReturnValue(false);

      await useFilePreviewStore.getState().loadFile("/test/file.ts");

      expect(mockAddBlock).toHaveBeenCalled();
      expect(mockUpdateFilePreviewTabName).not.toHaveBeenCalled();
    });

    it("docks preview in CENTER when file-tree panel is not open", async () => {
      const { invoke } = await import("@/lib/ipc");
      const { DockLocation } = await import("flexlayout-react");
      vi.mocked(invoke).mockResolvedValue({
        path: "/test/file.ts",
        content: "test content",
        size: 12,
      });

      // file-tree does NOT exist in the model
      mockGetNodeById.mockReturnValue(undefined);
      mockHasBlock.mockReturnValue(false);

      await useFilePreviewStore.getState().loadFile("/test/file.ts");

      expect(mockAddBlock).toHaveBeenCalledWith(
        { type: "file-preview", filePath: "/test/file.ts" },
        undefined,
        "block-file-preview",
        DockLocation.CENTER,
      );
    });

    it("places preview block to the RIGHT of the file-tree tabset", async () => {
      const { invoke } = await import("@/lib/ipc");
      const { DockLocation } = await import("flexlayout-react");
      vi.mocked(invoke).mockResolvedValue({
        path: "/test/file.ts",
        content: "test content",
        size: 12,
      });

      // Simulate file-tree node existing in the model
      const mockParent = { getId: () => "tabset-sidebar" };
      mockGetNodeById.mockImplementation((id: string) => {
        if (id === "tab-file-tree") return { getParent: () => mockParent };
        return undefined;
      });
      mockHasBlock.mockReturnValue(false);

      await useFilePreviewStore.getState().loadFile("/test/file.ts");

      expect(mockAddBlock).toHaveBeenCalledWith(
        { type: "file-preview", filePath: "/test/file.ts" },
        "tabset-sidebar",
        "block-file-preview",
        DockLocation.RIGHT,
      );
    });

    it("should handle unknown errors when loading file", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockRejectedValue({ custom: "error object" });

      const { loadFile } = useFilePreviewStore.getState();
      await loadFile("/test/file.ts");

      const state = useFilePreviewStore.getState();
      expect(state.error).toBe("Failed to load file");
    });
  });

  describe("reloadCurrentFile", () => {
    it("reloads the currently previewed file via IPC", async () => {
      const { invoke } = await import("@/lib/ipc");
      const freshContent = {
        path: "/test/file.ts",
        content: "updated content",
        size: 15,
      };
      vi.mocked(invoke).mockResolvedValue(freshContent);

      // Set up a file already loaded in preview
      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/test/file.ts",
        content: {
          path: "/test/file.ts",
          content: "old content",
          size: 11,
        },
        isLoading: false,
        error: null,
      });

      await useFilePreviewStore.getState().reloadCurrentFile();

      const state = useFilePreviewStore.getState();
      expect(state.content).toEqual(freshContent);
      expect(invoke).toHaveBeenCalledWith("read_file_command", {
        path: "/test/file.ts",
        maxSizeMb: 10,
        skipCache: true,
      });
    });

    it("does nothing when no file is currently open", async () => {
      const { invoke } = await import("@/lib/ipc");

      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: null,
        content: null,
      });

      await useFilePreviewStore.getState().reloadCurrentFile();

      expect(invoke).not.toHaveBeenCalled();
    });

    it("does not reset editing state when reloading", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockResolvedValue({
        path: "/test/file.ts",
        content: "new",
        size: 3,
      });

      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/test/file.ts",
        content: { path: "/test/file.ts", content: "old", size: 3 },
        isEditing: true,
        editContent: "user edits",
        editDirty: true,
      });

      await useFilePreviewStore.getState().reloadCurrentFile();

      const state = useFilePreviewStore.getState();
      // Should not touch editing state
      expect(state.isEditing).toBe(true);
      expect(state.editContent).toBe("user edits");
      expect(state.editDirty).toBe(true);
    });

    it("reloads only when the open file belongs to the changed project", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockResolvedValue({
        path: "/project-a/src/file.ts",
        content: "updated",
        size: 7,
      });

      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/project-a/src/file.ts",
        content: {
          path: "/project-a/src/file.ts",
          content: "old",
          size: 3,
        },
      });

      await useFilePreviewStore.getState().reloadCurrentFileForProject("/project-b");
      expect(invoke).not.toHaveBeenCalled();

      await useFilePreviewStore.getState().reloadCurrentFileForProject("/project-a");
      expect(invoke).toHaveBeenCalledWith("read_file_command", {
        path: "/project-a/src/file.ts",
        maxSizeMb: 10,
        skipCache: true,
      });
    });
  });

  describe("reloadCurrentFileIfChanged", () => {
    it("reloads the file when its path is in changedPaths", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockResolvedValue({
        path: "/project-a/src/file.ts",
        content: "updated",
        size: 7,
      });

      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/project-a/src/file.ts",
        content: { path: "/project-a/src/file.ts", content: "old", size: 3 },
      });

      await useFilePreviewStore.getState().reloadCurrentFileIfChanged(
        "/project-a",
        ["src/file.ts", "src/other.ts"],
      );

      expect(invoke).toHaveBeenCalledWith("read_file_command", {
        path: "/project-a/src/file.ts",
        maxSizeMb: 10,
        skipCache: true,
      });
      const state = useFilePreviewStore.getState();
      expect(state.content?.content).toBe("updated");
    });

    it("does NOT reload when changedPaths does not include the current file", async () => {
      const { invoke } = await import("@/lib/ipc");

      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/project-a/src/file.ts",
        content: { path: "/project-a/src/file.ts", content: "original", size: 8 },
      });

      await useFilePreviewStore.getState().reloadCurrentFileIfChanged(
        "/project-a",
        ["src/other.ts", "package.json"],
      );

      expect(invoke).not.toHaveBeenCalled();
    });

    it("does NOT reload when the current file belongs to a different project", async () => {
      const { invoke } = await import("@/lib/ipc");

      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/project-b/src/file.ts",
        content: { path: "/project-b/src/file.ts", content: "original", size: 8 },
      });

      await useFilePreviewStore.getState().reloadCurrentFileIfChanged(
        "/project-a",
        ["src/file.ts"],
      );

      expect(invoke).not.toHaveBeenCalled();
    });

    it("does nothing when no file is currently open", async () => {
      const { invoke } = await import("@/lib/ipc");

      useFilePreviewStore.setState({ currentFile: null });

      await useFilePreviewStore.getState().reloadCurrentFileIfChanged(
        "/project-a",
        ["src/file.ts"],
      );

      expect(invoke).not.toHaveBeenCalled();
    });

    it("falls back to reloading when changedPaths is empty (full project refresh)", async () => {
      const { invoke } = await import("@/lib/ipc");
      vi.mocked(invoke).mockResolvedValue({
        path: "/project-a/src/file.ts",
        content: "refreshed",
        size: 9,
      });

      useFilePreviewStore.setState({
        isOpen: true,
        currentFile: "/project-a/src/file.ts",
        content: { path: "/project-a/src/file.ts", content: "old", size: 3 },
      });

      await useFilePreviewStore.getState().reloadCurrentFileIfChanged(
        "/project-a",
        [],
      );

      expect(invoke).toHaveBeenCalledWith("read_file_command", {
        path: "/project-a/src/file.ts",
        maxSizeMb: 10,
        skipCache: true,
      });
    });
  });

  describe("clearError", () => {
    it("should clear error state", () => {
      useFilePreviewStore.setState({ error: "some error" });

      const { clearError } = useFilePreviewStore.getState();
      clearError();

      const { error } = useFilePreviewStore.getState();
      expect(error).toBeNull();
    });
  });

});

