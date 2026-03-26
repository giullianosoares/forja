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

const DEFAULT_ACTIONS: QuickAction[] = [
  { actionId: "open-files" },
  { actionId: "open-browser" },
];

async function persistActions(actions: QuickAction[]): Promise<void> {
  await invoke("save_quick_actions", { actions });
}

export const useQuickActionsStore = create<QuickActionsState>((set, get) => ({
  actions: [],
  loaded: false,

  loadActions: async () => {
    try {
      const raw = await invoke<QuickAction[] | null>("get_quick_actions");
      // null/undefined means never configured — use defaults
      const actions = raw && raw.length > 0 ? raw : DEFAULT_ACTIONS;
      set({ actions, loaded: true });
      // Persist defaults if first time
      if (!raw || raw.length === 0) {
        await persistActions(actions);
      }
    } catch {
      set({ actions: DEFAULT_ACTIONS, loaded: true });
    }
  },

  addAction: async (actionId: string) => {
    const { actions } = get();
    const alreadyPinned = actions.some((a) => a.actionId === actionId);
    if (alreadyPinned) return;
    const updated = [...actions, { actionId }];
    set({ actions: updated });
    await persistActions(updated);
  },

  removeAction: async (actionId: string) => {
    const { actions } = get();
    const updated = actions.filter((a) => a.actionId !== actionId);
    set({ actions: updated });
    await persistActions(updated);
  },

  moveAction: async (fromIndex: number, toIndex: number) => {
    const { actions } = get();
    const updated = [...actions];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    set({ actions: updated });
    await persistActions(updated);
  },

  isPinned: (actionId: string) => {
    return get().actions.some((a) => a.actionId === actionId);
  },
}));
