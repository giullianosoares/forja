import { create } from "zustand";

export type ModifierCombo = "cmd" | "cmd-shift" | "ctrl" | "alt" | "cmd-alt";

interface ModifierHeldState {
  activeModifier: ModifierCombo | null;
  visible: boolean;
  setModifier: (combo: ModifierCombo) => void;
  clearModifier: () => void;
  cancelBadges: () => void;
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

const ACTIVATION_DELAY = 100;
const FADEOUT_DURATION = 150;

export const useModifierHeldStore = create<ModifierHeldState>((set) => ({
  activeModifier: null,
  visible: false,

  setModifier: (combo) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    set({ activeModifier: combo, visible: false });
    pendingTimer = setTimeout(() => {
      set({ visible: true });
      pendingTimer = null;
    }, ACTIVATION_DELAY);
  },

  clearModifier: () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    set({ visible: false });
    pendingTimer = setTimeout(() => {
      set({ activeModifier: null });
      pendingTimer = null;
    }, FADEOUT_DURATION);
  },

  cancelBadges: () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    set({ activeModifier: null, visible: false });
  },
}));
