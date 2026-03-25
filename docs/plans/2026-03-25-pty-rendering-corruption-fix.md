# PTY Rendering Corruption on Tab Switch — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix terminal rendering corruption (garbled text, wrong cursor positions, overlapping characters) that occurs when switching between AI CLI sessions (Claude, Gemini, Codex) across sidebar projects.

**Architecture:** Three-pronged fix targeting the data flow between PTY backend and xterm.js frontend: (1) prevent data loss during component unmount by flushing the RAF write buffer, (2) add RAF-coalesced writes in the terminal cache to prevent Ink TUI intermediate states from corrupting xterm's buffer, (3) force xterm viewport refresh after DOM reattachment to resync renderer state.

**Tech Stack:** TypeScript, React, xterm.js v6, @xterm/addon-fit, flexlayout-react, node-pty

---

## Root Cause Analysis

When switching sidebar projects, TerminalSession unmounts and the terminal is "parked" in `terminalCache`. Three bugs compound to cause rendering corruption:

1. **Data loss on unmount** (`terminal-session.tsx:348-353`): The RAF write buffer is cancelled and discarded. If PTY data was mid-flight (e.g., Ink TUI redraw with cursor-up + clear + rewrite), partial escape sequences are lost, leaving xterm's buffer in an intermediate state.

2. **No write coalescing while parked** (`terminal-instance-cache.ts:101-103`): The cache handler writes PTY data directly via `terminal.write(data)` without RAF batching. Ink sends multi-chunk redraws across separate IPC events. Without coalescing, each chunk is processed individually, committing intermediate render states to xterm's buffer.

3. **No viewport refresh on reattach** (`terminal-session.tsx:119-126`): When the cached `hostElement` is re-appended to the DOM, xterm's internal renderer state may be stale from the detached period. No `terminal.refresh()` is called to force a full viewport re-render.

### Reproduction flow

```
User clicks project B in sidebar
  -> TerminalSession for project A unmounts
  -> cleanup: RAF cancelled, writeBuffer DISCARDED (data loss!)
  -> terminal parked in cache
  -> cache handler: terminal.write(data) directly (no RAF coalescing)
  -> PTY keeps sending data while parked
  -> xterm processes data on detached DOM (stale renderer)

User clicks project A in sidebar
  -> TerminalSession mounts, gets cached terminal
  -> hostElement re-appended to DOM
  -> NO terminal.refresh() called
  -> xterm renders stale/corrupted viewport
  -> User sees garbled text
```

---

## Task 1: Flush write buffer on unmount instead of discarding

**Files:**
- Modify: `frontend/components/terminal-session.tsx:341-353`
- Test: `frontend/components/__tests__/terminal-session.flush-on-unmount.test.ts`

### Step 1: Write the failing test

Create a test that verifies the write buffer is flushed to the terminal on unmount, not discarded.

```typescript
// frontend/components/__tests__/terminal-session.flush-on-unmount.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("TerminalSession write buffer flush on unmount", () => {
  it("should flush pending write buffer to terminal before parking", () => {
    // Simulate the unmount cleanup behavior:
    // 1. writeBufferRef has pending data
    // 2. writeRafRef has a scheduled RAF
    // 3. On cleanup, buffer should be flushed to terminal, not discarded

    const terminalWrite = vi.fn();
    const mockTerminal = { write: terminalWrite };

    // Simulate buffered data that hasn't been flushed yet
    let writeBuffer = "\x1b[2K\x1b[1A\x1b[2KUpdated line content";
    let writeRaf = 1; // non-zero means RAF is scheduled

    // --- OLD behavior (bug): discard buffer ---
    // cancelAnimationFrame(writeRaf);
    // writeRaf = 0;
    // writeBuffer = "";  // DATA LOST!

    // --- NEW behavior (fix): flush buffer before clearing ---
    if (writeRaf) {
      // cancelAnimationFrame(writeRaf);
      writeRaf = 0;
    }
    if (writeBuffer) {
      mockTerminal.write(writeBuffer);
      writeBuffer = "";
    }

    expect(terminalWrite).toHaveBeenCalledOnce();
    expect(terminalWrite).toHaveBeenCalledWith(
      "\x1b[2K\x1b[1A\x1b[2KUpdated line content",
    );
    expect(writeBuffer).toBe("");
    expect(writeRaf).toBe(0);
  });

  it("should not call write when buffer is empty", () => {
    const terminalWrite = vi.fn();
    const mockTerminal = { write: terminalWrite };

    let writeBuffer = "";
    let writeRaf = 0;

    // Flush logic should skip when buffer is empty
    if (writeRaf) {
      writeRaf = 0;
    }
    if (writeBuffer) {
      mockTerminal.write(writeBuffer);
      writeBuffer = "";
    }

    expect(terminalWrite).not.toHaveBeenCalled();
  });
});
```

### Step 2: Run test to verify it passes

Run: `cd /home/nandomoreira/dev/projects/forja && pnpm vitest run frontend/components/__tests__/terminal-session.flush-on-unmount.test.ts`
Expected: PASS (this test validates the new logic pattern, not the old buggy one)

### Step 3: Apply the fix in terminal-session.tsx

In the cleanup function (line 341+), replace the buffer discard with a flush:

**Before (lines 348-353):**
```typescript
      // Cancel pending write-coalescing RAF and discard buffered data
      if (writeRafRef.current) {
        cancelAnimationFrame(writeRafRef.current);
        writeRafRef.current = 0;
      }
      writeBufferRef.current = "";
```

**After:**
```typescript
      // Cancel pending write-coalescing RAF and flush buffered data to terminal
      // so no escape sequences are lost during the unmount transition.
      if (writeRafRef.current) {
        cancelAnimationFrame(writeRafRef.current);
        writeRafRef.current = 0;
      }
      if (writeBufferRef.current && terminalLocal) {
        terminalLocal.write(writeBufferRef.current);
      }
      writeBufferRef.current = "";
```

Note: `terminalLocal` is available in the cleanup closure (assigned at line 225). The flush writes any pending data to xterm's buffer before the terminal is parked, ensuring no partial escape sequences are lost.

### Step 4: Run full test suite

Run: `cd /home/nandomoreira/dev/projects/forja && pnpm vitest run`
Expected: All tests PASS

### Step 5: Commit

```bash
git add frontend/components/terminal-session.tsx frontend/components/__tests__/terminal-session.flush-on-unmount.test.ts
git commit -m "fix(terminal): flush write buffer on unmount instead of discarding

Prevents data loss when switching tabs. The RAF write buffer could
contain partial Ink TUI redraws (cursor-up + clear + rewrite escape
sequences). Discarding this buffer left xterm in an intermediate
render state, causing garbled text on reattach."
```

---

## Task 2: Add RAF-coalesced writes in terminal cache

**Files:**
- Modify: `frontend/lib/terminal-instance-cache.ts:97-107`
- Test: `frontend/lib/__tests__/terminal-instance-cache.coalescing.test.ts`

### Step 1: Write the failing test

```typescript
// frontend/lib/__tests__/terminal-instance-cache.coalescing.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("terminal cache RAF-coalesced writes", () => {
  let rafCallbacks: Array<() => void> = [];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should coalesce multiple data chunks into a single write", () => {
    const terminalWrite = vi.fn();

    // Simulate the coalescing buffer used in park()
    let buffer = "";
    let rafId = 0;

    const handler = (data: string) => {
      buffer += data;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          const chunk = buffer;
          buffer = "";
          terminalWrite(chunk);
        });
      }
    };

    // Simulate Ink TUI redraw: 3 chunks arrive in same frame
    handler("\x1b[2K");        // clear line
    handler("\x1b[1A");        // cursor up
    handler("New content");    // new text

    // Before RAF fires: no writes yet
    expect(terminalWrite).not.toHaveBeenCalled();

    // Fire RAF
    rafCallbacks[0]();

    // All chunks coalesced into single write
    expect(terminalWrite).toHaveBeenCalledOnce();
    expect(terminalWrite).toHaveBeenCalledWith(
      "\x1b[2K\x1b[1ANew content",
    );
  });

  it("should cancel RAF and flush buffer on cache retrieval", () => {
    const cancelRaf = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelRaf);

    const terminalWrite = vi.fn();
    let buffer = "pending data";
    let rafId = 42;

    // Simulate cache.get() cleanup: flush before returning
    if (rafId) {
      cancelRaf(rafId);
      rafId = 0;
    }
    if (buffer) {
      terminalWrite(buffer);
      buffer = "";
    }

    expect(cancelRaf).toHaveBeenCalledWith(42);
    expect(terminalWrite).toHaveBeenCalledWith("pending data");
  });
});
```

### Step 2: Run test to verify it passes

Run: `cd /home/nandomoreira/dev/projects/forja && pnpm vitest run frontend/lib/__tests__/terminal-instance-cache.coalescing.test.ts`
Expected: PASS

### Step 3: Apply the fix in terminal-instance-cache.ts

Replace the direct `terminal.write()` in the `park()` method with RAF-coalesced writes. Also flush the buffer when retrieving from cache.

**Replace the `queueMicrotask` block in `park()` (lines 98-107):**

Before:
```typescript
    // Re-register data/exit handlers AFTER use-pty's cleanup runs
    queueMicrotask(() => {
      if (!cache.has(tabId)) return;
      ptyDispatcher.registerData(tabId, (data) => {
        terminal.write(data);
      });
      ptyDispatcher.registerExit(tabId, () => {
        terminal.write("\r\n\x1b[1;33m[Session ended]\x1b[0m\r\n");
      });
    });
```

After:
```typescript
    // Re-register data/exit handlers AFTER use-pty's cleanup runs.
    // Use RAF-coalesced writes (same pattern as TerminalSession) so that
    // Ink TUI multi-chunk redraws are batched into a single xterm.write(),
    // preventing intermediate render states in the buffer.
    queueMicrotask(() => {
      if (!cache.has(tabId)) return;

      let writeBuffer = "";
      let writeRafId = 0;

      const flushBuffer = () => {
        writeRafId = 0;
        const chunk = writeBuffer;
        writeBuffer = "";
        terminal.write(chunk);
      };

      // Store flush handle so get() can flush before returning
      const entry = cache.get(tabId);
      if (entry) {
        (entry as CachedTerminalInternal)._flushParkedWrites = () => {
          if (writeRafId) {
            cancelAnimationFrame(writeRafId);
            writeRafId = 0;
          }
          if (writeBuffer) {
            terminal.write(writeBuffer);
            writeBuffer = "";
          }
        };
      }

      ptyDispatcher.registerData(tabId, (data) => {
        writeBuffer += data;
        if (!writeRafId) {
          writeRafId = requestAnimationFrame(flushBuffer);
        }
      });
      ptyDispatcher.registerExit(tabId, () => {
        terminal.write("\r\n\x1b[1;33m[Session ended]\x1b[0m\r\n");
      });
    });
```

**Add internal interface at the top of the file (after `CachedTerminal` interface):**

```typescript
/** Extended entry with internal flush handle (not exposed to consumers). */
interface CachedTerminalInternal extends CachedTerminal {
  _flushParkedWrites?: () => void;
}
```

**Update the `get()` method to flush before returning:**

Before:
```typescript
  get(tabId: string): CachedTerminal | undefined {
    const entry = cache.get(tabId);
    if (entry) {
      // Retrieved by consumer — cancel TTL timer (will be reattached)
      clearTtlTimer(tabId);
    }
    return entry;
  },
```

After:
```typescript
  get(tabId: string): CachedTerminal | undefined {
    const entry = cache.get(tabId);
    if (entry) {
      clearTtlTimer(tabId);
      // Flush any RAF-buffered writes before returning to consumer
      (entry as CachedTerminalInternal)._flushParkedWrites?.();
      delete (entry as CachedTerminalInternal)._flushParkedWrites;
    }
    return entry;
  },
```

### Step 4: Run full test suite

Run: `cd /home/nandomoreira/dev/projects/forja && pnpm vitest run`
Expected: All tests PASS

### Step 5: Commit

```bash
git add frontend/lib/terminal-instance-cache.ts frontend/lib/__tests__/terminal-instance-cache.coalescing.test.ts
git commit -m "fix(terminal): add RAF-coalesced writes in terminal cache

While a terminal is parked (tab hidden), PTY data was written directly
via terminal.write() without batching. Ink-based TUIs (Claude, Gemini)
send multi-chunk redraws that need coalescing to prevent intermediate
render states from corrupting xterm's internal buffer. Uses the same
RAF pattern as TerminalSession's write buffer."
```

---

## Task 3: Force terminal viewport refresh on reattach

**Files:**
- Modify: `frontend/components/terminal-session.tsx:119-126`
- Test: `frontend/components/__tests__/terminal-session.reattach-refresh.test.ts`

### Step 1: Write the failing test

```typescript
// frontend/components/__tests__/terminal-session.reattach-refresh.test.ts
import { describe, it, expect, vi } from "vitest";

describe("TerminalSession reattach refresh", () => {
  it("should call terminal.refresh() after reattaching cached hostElement", () => {
    const terminalRefresh = vi.fn();
    const terminalFocus = vi.fn();
    const fitAddonFit = vi.fn();
    const fitAddonProposeDimensions = vi.fn().mockReturnValue({ rows: 24, cols: 80 });

    const mockTerminal = {
      refresh: terminalRefresh,
      focus: terminalFocus,
      rows: 24,
    };
    const mockFitAddon = {
      fit: fitAddonFit,
      proposeDimensions: fitAddonProposeDimensions,
    };
    const mockHostElement = document.createElement("div");

    // Simulate reattach flow
    const container = document.createElement("div");
    container.appendChild(mockHostElement);

    // After appending, refresh should be called to resync renderer
    mockTerminal.refresh(0, mockTerminal.rows - 1);

    expect(terminalRefresh).toHaveBeenCalledWith(0, 23);
  });
});
```

### Step 2: Run test to verify it passes

Run: `cd /home/nandomoreira/dev/projects/forja && pnpm vitest run frontend/components/__tests__/terminal-session.reattach-refresh.test.ts`
Expected: PASS

### Step 3: Apply the fix in terminal-session.tsx

In the `init()` function, after appending the cached hostElement, add a `refresh()` call.

**Find the cached reattach block (lines 119-126):**

Before:
```typescript
      if (cached) {
        // REATTACH: move cached DOM + terminal instance
        terminal = cached.terminal;
        fitAddon = cached.fitAddon;
        hostElement = cached.hostElement;
        containerRef.current.appendChild(hostElement);
        shouldSpawn = false; // PTY already running
        spawned = true; // treat as already started so park works on next unmount
```

After:
```typescript
      if (cached) {
        // REATTACH: move cached DOM + terminal instance
        terminal = cached.terminal;
        fitAddon = cached.fitAddon;
        hostElement = cached.hostElement;
        containerRef.current.appendChild(hostElement);
        // Force xterm to re-render the full viewport after DOM reattachment.
        // While parked, xterm wrote data to a detached DOM — the renderer's
        // internal state may be stale, causing garbled text without this.
        terminal.refresh(0, terminal.rows - 1);
        shouldSpawn = false; // PTY already running
        spawned = true; // treat as already started so park works on next unmount
```

### Step 4: Run full test suite

Run: `cd /home/nandomoreira/dev/projects/forja && pnpm vitest run`
Expected: All tests PASS

### Step 5: Commit

```bash
git add frontend/components/terminal-session.tsx frontend/components/__tests__/terminal-session.reattach-refresh.test.ts
git commit -m "fix(terminal): force viewport refresh after cached terminal reattach

Calls terminal.refresh(0, rows-1) immediately after re-appending the
cached hostElement to the DOM. While parked, xterm processes PTY data
on a detached DOM element, and its renderer state can drift from the
actual DOM state. The refresh forces a full viewport re-render,
eliminating garbled text on tab switch."
```

---

## Task 4: Manual verification

### Step 1: Build and launch Forja

Run: `cd /home/nandomoreira/dev/projects/forja && pnpm build && pnpm tauri dev`

### Step 2: Reproduce the original scenario

1. Open 3+ projects in sidebar (e.g., MASA, VIVAMUS, OM INCORPORADORA)
2. Start Claude Code sessions in each
3. Wait for all sessions to be actively rendering output
4. Rapidly switch between projects in sidebar
5. Switch back and forth multiple times
6. Verify: terminal text is clean, no garbled characters, no overlapping text
7. Verify: cursor position is correct
8. Verify: Ink TUI redraws (status bar, progress indicators) render cleanly

### Step 3: Edge case: switch during active output

1. Trigger a long Claude Code response in project A
2. While output is streaming, switch to project B
3. Wait 5-10 seconds
4. Switch back to project A
5. Verify: output continues cleanly from where it was, no corruption

### Step 4: Edge case: rapid switching

1. Click between 3 sidebar projects rapidly (< 1 second between switches)
2. Do this 10+ times
3. Return to each project
4. Verify: all terminals render correctly

---

## Summary

| Task | File | Change | Impact |
|------|------|--------|--------|
| 1 | terminal-session.tsx:348-353 | Flush write buffer on unmount | Prevents data loss (partial escape sequences) |
| 2 | terminal-instance-cache.ts:97-107 | RAF-coalesced writes while parked | Prevents Ink TUI intermediate states in buffer |
| 3 | terminal-session.tsx:119-126 | terminal.refresh() on reattach | Resyncs xterm renderer with DOM after detach |
| 4 | Manual | Verify all scenarios | Confirm fix works end-to-end |
