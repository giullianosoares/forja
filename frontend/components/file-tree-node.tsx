import { memo, useCallback, useRef, useState, useEffect } from "react";
import { ChevronRight, Pencil, Trash2, FolderMinus, FilePlus, FolderPlus, Scissors, Copy, Clipboard, Link, FolderOpen } from "lucide-react";
import { FileIcon } from "./file-icon";
import { cn } from "@/lib/utils";
import { useFileTreeStore, type FileNode } from "@/stores/file-tree";
import { useFilePreviewStore } from "@/stores/file-preview";
import { useGitStatusStore } from "@/stores/git-status";
import { useGitDiffStore } from "@/stores/git-diff";
import { useWorkspaceStore } from "@/stores/workspace";
import { getGitBadgeLetter, getGitStatusColor } from "@/lib/git-constants";
import { invoke } from "@/lib/ipc";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  projectPath?: string;
}

export const FileTreeNode = memo(function FileTreeNode({
  node,
  depth,
  projectPath,
}: FileTreeNodeProps) {
  const expanded = useFileTreeStore((s) => !!s.expandedPaths[node.path]);
  const isFocused = useFileTreeStore((s) => s.focusedPath === node.path);
  const isSelected = useFileTreeStore((s) => !!s.selectedPaths[node.path]);
  const toggleExpanded = useFileTreeStore((s) => s.toggleExpanded);
  const selectFile = useFileTreeStore((s) => s.selectFile);
  const pinFile = useFileTreeStore((s) => s.pinFile);
  const currentFile = useFilePreviewStore((s) => s.currentFile);
  const activeProjectPath = useFileTreeStore((s) => s.currentPath);
  const isActive = !node.isDir && currentFile === node.path;
  const effectiveProjectPath = projectPath ?? activeProjectPath;
  const projectCounters = useGitDiffStore((s) =>
    effectiveProjectPath ? s.projectCountersByPath[effectiveProjectPath] : undefined,
  );
  const isProjectRoot = Boolean(node.isDir && effectiveProjectPath && node.path === effectiveProjectPath);

  const relativePath = effectiveProjectPath
    ? node.path.substring(effectiveProjectPath.length + 1)
    : node.path;

  const fileStatus = useGitStatusStore((s) =>
    s.getFileStatus(relativePath, effectiveProjectPath ?? undefined),
  );
  const dirHasChanges = useGitStatusStore((s) =>
    node.isDir ? s.hasChangedChildren(relativePath, effectiveProjectPath ?? undefined) : false,
  );

  const statusColor = fileStatus ? getGitStatusColor(fileStatus) : null;
  const badgeLetter = fileStatus ? getGitBadgeLetter(fileStatus) : null;

  // Workspace state for "Remove from workspace"
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const removeProject = useWorkspaceStore((s) => s.removeProject);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const isInMultiProjectWorkspace = Boolean(
    activeWorkspace && activeWorkspace.projects.length > 1
  );

  // Rename inline state
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Inline new file/folder creation state
  const [creatingType, setCreatingType] = useState<"file" | "dir" | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  // Clipboard state from store
  const clipboard = useFileTreeStore((s) => s.clipboard);

  // Focus rename input when it appears
  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  // Focus create input when it appears
  useEffect(() => {
    if (creatingType && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [creatingType]);

  const loadSubdirectory = useFileTreeStore((s) => s.loadSubdirectory);

  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    if (renaming) return;
    useFileTreeStore.getState().setFocusedPath(node.path);
    if (node.isDir) {
      const wasExpanded = expanded;
      toggleExpanded(node.path);
      // Lazy-load children when expanding a directory with empty children (truncated by maxDepth)
      if (!wasExpanded && node.children && node.children.length === 0 && effectiveProjectPath) {
        loadSubdirectory(node.path, effectiveProjectPath);
      }
    } else {
      // Single click — preview mode (delayed to allow double-click to cancel)
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = setTimeout(() => {
        selectFile(node.path);
      }, 200);
    }
  }, [node.isDir, node.path, toggleExpanded, selectFile, renaming, expanded, node.children, effectiveProjectPath, loadSubdirectory]);

  const handleDoubleClick = useCallback(() => {
    if (renaming) return;
    if (node.isDir) return;
    // Cancel the pending single-click action
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
    // Double click — pin the file
    pinFile(node.path);
  }, [node.isDir, node.path, pinFile, renaming]);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(node.path);
  }, [node.path]);

  const handleCopyRelativePath = useCallback(() => {
    const projectPath = useFileTreeStore.getState().currentPath;
    const relative = projectPath
      ? node.path.replace(projectPath + "/", "")
      : node.path;
    navigator.clipboard.writeText(relative);
  }, [node.path]);

  const handleRevealInFinder = useCallback(() => {
    invoke("reveal_in_finder", { path: node.path });
  }, [node.path]);

  const handleCut = useCallback(() => {
    const store = useFileTreeStore.getState();
    if (!store.selectedPaths[node.path]) {
      store.clearSelection();
      store.toggleSelect(node.path);
    }
    store.cutToClipboard();
  }, [node.path]);

  const handleCopy = useCallback(() => {
    const store = useFileTreeStore.getState();
    if (!store.selectedPaths[node.path]) {
      store.clearSelection();
      store.toggleSelect(node.path);
    }
    store.copyToClipboard();
  }, [node.path]);

  const handlePaste = useCallback(() => {
    const targetDir = node.isDir
      ? node.path
      : node.path.substring(0, node.path.lastIndexOf("/"));
    useFileTreeStore.getState().pasteFromClipboard(targetDir);
  }, [node.isDir, node.path]);

  const handleCreateCommit = useCallback(async () => {
    const trimmed = creatingName.trim();
    if (!trimmed || !effectiveProjectPath || !creatingType) {
      setCreatingType(null);
      setCreatingName("");
      return;
    }

    // Target directory: current node if dir, else parent
    const targetDir = node.isDir
      ? node.path
      : node.path.substring(0, node.path.lastIndexOf("/"));
    const newPath = `${targetDir}/${trimmed}`;

    try {
      if (creatingType === "file") {
        await invoke("create_file", { projectPath: effectiveProjectPath, filePath: newPath });
      } else {
        await invoke("create_directory", { projectPath: effectiveProjectPath, dirPath: newPath });
      }
      await useFileTreeStore.getState().refreshTree(effectiveProjectPath);
    } catch (err) {
      console.error(`[file-tree] Create ${creatingType} failed:`, err);
    } finally {
      setCreatingType(null);
      setCreatingName("");
    }
  }, [creatingName, creatingType, effectiveProjectPath, node.isDir, node.path]);

  const handleCreateKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCreateCommit();
      } else if (e.key === "Escape") {
        setCreatingType(null);
        setCreatingName("");
      }
    },
    [handleCreateCommit]
  );

  const handleRenameStart = useCallback(() => {
    setRenameValue(node.name);
    setRenaming(true);
  }, [node.name]);

  const handleRenameCommit = useCallback(async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === node.name || !effectiveProjectPath) {
      setRenaming(false);
      return;
    }

    const parentDir = node.path.substring(0, node.path.lastIndexOf("/"));
    const newPath = `${parentDir}/${trimmed}`;

    try {
      await invoke("rename_file_or_dir", {
        projectPath: effectiveProjectPath,
        oldPath: node.path,
        newPath,
      });
      // Reload tree after rename
      const { loadProjectTree } = useFileTreeStore.getState();
      await loadProjectTree(effectiveProjectPath);
    } catch (err) {
      console.error("[file-tree] Rename failed:", err);
    } finally {
      setRenaming(false);
    }
  }, [renameValue, node.name, node.path, effectiveProjectPath]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleRenameCommit();
      } else if (e.key === "Escape") {
        setRenaming(false);
      }
    },
    [handleRenameCommit]
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!effectiveProjectPath) return;
    setIsDeleting(true);
    try {
      await invoke("delete_file_or_dir", {
        projectPath: effectiveProjectPath,
        targetPath: node.path,
      });
      // Reload tree after delete
      const { loadProjectTree } = useFileTreeStore.getState();
      await loadProjectTree(effectiveProjectPath);
    } catch (err) {
      console.error("[file-tree] Delete failed:", err);
    } finally {
      setIsDeleting(false);
      setDeleteDialogOpen(false);
    }
  }, [node.path, effectiveProjectPath]);

  const removeProjectTree = useFileTreeStore((s) => s.removeProjectTree);

  const handleRemoveFromWorkspace = useCallback(async () => {
    if (!activeWorkspaceId || !effectiveProjectPath) return;
    try {
      await removeProject(activeWorkspaceId, effectiveProjectPath);
      removeProjectTree(effectiveProjectPath);
    } catch (err) {
      console.error("[file-tree] Remove from workspace failed:", err);
    }
  }, [activeWorkspaceId, effectiveProjectPath, removeProject, removeProjectTree]);

  const nameColor = statusColor
    ? `${statusColor} group-hover:text-ctp-text`
    : isActive
      ? "text-ctp-text"
      : "text-ctp-subtext0 group-hover:text-ctp-text";
  const ignoredOpacity = node.ignored ? "opacity-50" : "";

  const nodeButton = (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors duration-100 hover:bg-ctp-surface0 group",
        ignoredOpacity,
        isActive && "bg-ctp-surface0",
        isFocused && "ring-1 ring-ctp-mauve/60 bg-ctp-surface0/50",
        isSelected && "bg-ctp-surface0/50",
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {node.isDir ? (
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-ctp-overlay1 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
          strokeWidth={1.5}
        />
      ) : (
        <div className="w-3 shrink-0" />
      )}

      <FileIcon
        isDir={node.isDir}
        extension={node.extension}
        isOpen={expanded}
        className="shrink-0"
      />

      {renaming ? (
        <input
          ref={renameInputRef}
          type="text"
          className="min-w-0 flex-1 rounded bg-ctp-surface1 px-1 py-0 text-app text-ctp-text outline-none ring-1 ring-ctp-mauve"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameCommit}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className={`truncate text-app ${nameColor}`}>
          {node.name}
        </span>
      )}

      {isProjectRoot && projectCounters && projectCounters.total > 0 && (
        <span
          className="ml-auto shrink-0 text-app-xs font-medium text-ctp-overlay1"
          aria-label={`Changes: M:${projectCounters.modified} A:${projectCounters.added} D:${projectCounters.deleted} U:${projectCounters.untracked}`}
        >
          M:{projectCounters.modified} A:{projectCounters.added} D:{projectCounters.deleted} U:{projectCounters.untracked}
        </span>
      )}

      {/* Git status badge for files */}
      {!node.isDir && badgeLetter && statusColor && !isProjectRoot && (
        <span
          className={`ml-auto shrink-0 text-app-sm font-medium ${statusColor}`}
          aria-label={`Git status: ${badgeLetter}`}
        >
          {badgeLetter}
        </span>
      )}

      {/* Yellow dot indicator for directories with changes */}
      {node.isDir && dirHasChanges && (
        <span
          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-ctp-yellow"
          aria-label="Directory has changes"
        />
      )}
    </button>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {nodeButton}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-48 border-ctp-surface1 bg-overlay-mantle">
          {/* New File / New Folder — directories only */}
          {node.isDir && (
            <>
              <ContextMenuItem
                className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
                onSelect={() => { setCreatingType("file"); setCreatingName(""); }}
              >
                <FilePlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                New File...
              </ContextMenuItem>
              <ContextMenuItem
                className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
                onSelect={() => { setCreatingType("dir"); setCreatingName(""); }}
              >
                <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                New Folder...
              </ContextMenuItem>
              <ContextMenuSeparator className="bg-ctp-surface0" />
            </>
          )}

          {/* Cut / Copy / Paste */}
          <ContextMenuItem
            className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
            onSelect={handleCut}
          >
            <Scissors className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span className="flex-1">Cut</span>
            <span className="text-ctp-overlay1">⌘X</span>
          </ContextMenuItem>
          <ContextMenuItem
            className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
            onSelect={handleCopy}
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span className="flex-1">Copy</span>
            <span className="text-ctp-overlay1">⌘C</span>
          </ContextMenuItem>
          {clipboard && (
            <ContextMenuItem
              className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
              onSelect={handlePaste}
            >
              <Clipboard className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span className="flex-1">Paste</span>
              <span className="text-ctp-overlay1">⌘V</span>
            </ContextMenuItem>
          )}

          <ContextMenuSeparator className="bg-ctp-surface0" />

          {/* Copy Path / Copy Relative Path */}
          <ContextMenuItem
            className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
            onSelect={handleCopyPath}
          >
            <Link className="h-3.5 w-3.5" strokeWidth={1.5} />
            Copy Path
          </ContextMenuItem>
          <ContextMenuItem
            className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
            onSelect={handleCopyRelativePath}
          >
            <Link className="h-3.5 w-3.5" strokeWidth={1.5} />
            Copy Relative Path
          </ContextMenuItem>

          <ContextMenuSeparator className="bg-ctp-surface0" />

          {/* Reveal in Finder */}
          <ContextMenuItem
            className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
            onSelect={handleRevealInFinder}
          >
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.5} />
            Reveal in Finder
          </ContextMenuItem>

          <ContextMenuSeparator className="bg-ctp-surface0" />

          {/* Rename / Delete */}
          <ContextMenuItem
            className="gap-2 text-app-sm text-ctp-subtext0 focus:bg-ctp-surface0 focus:text-ctp-text"
            onSelect={handleRenameStart}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
            Rename
          </ContextMenuItem>

          <ContextMenuItem
            className="gap-2 text-app-sm text-ctp-red focus:bg-ctp-surface0 focus:text-ctp-red"
            onSelect={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            Delete
          </ContextMenuItem>

          {/* Remove from workspace: shown only for project root in multi-project workspace */}
          {isProjectRoot && isInMultiProjectWorkspace && (
            <>
              <ContextMenuSeparator className="bg-ctp-surface0" />
              <ContextMenuItem
                className="gap-2 text-app-sm text-ctp-overlay1 focus:bg-ctp-surface0 focus:text-ctp-text"
                onSelect={handleRemoveFromWorkspace}
              >
                <FolderMinus className="h-3.5 w-3.5" strokeWidth={1.5} />
                Remove from workspace
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Inline new file/folder creation input */}
      {node.isDir && creatingType && (
        <div
          className="flex items-center gap-1.5 px-2 py-1"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
        >
          <div className="w-3 shrink-0" />
          <FileIcon isDir={creatingType === "dir"} className="shrink-0" />
          <input
            ref={createInputRef}
            type="text"
            placeholder={creatingType === "file" ? "filename..." : "foldername..."}
            className="min-w-0 flex-1 rounded bg-ctp-surface1 px-1 py-0 text-app text-ctp-text outline-none ring-1 ring-ctp-mauve"
            value={creatingName}
            onChange={(e) => setCreatingName(e.target.value)}
            onKeyDown={handleCreateKeyDown}
            onBlur={() => { setCreatingType(null); setCreatingName(""); }}
          />
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="border-ctp-surface1 bg-overlay-mantle sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-ctp-text">
              Delete {node.isDir ? "folder" : "file"}
            </DialogTitle>
            <DialogDescription className="text-ctp-subtext0">
              Are you sure you want to delete{" "}
              <span className="font-medium text-ctp-text">{node.name}</span>?
              {node.isDir && " This will delete all contents recursively."}
              {" "}This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteDialogOpen(false)}
              className="border-ctp-surface1 text-ctp-subtext0 hover:bg-ctp-surface0 hover:text-ctp-text"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-ctp-red text-ctp-base hover:bg-ctp-red/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
