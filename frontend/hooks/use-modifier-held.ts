import { useEffect } from "react";
import { useModifierHeldStore, type ModifierCombo } from "@/stores/modifier-held";

export function detectModifierCombo(e: KeyboardEvent): ModifierCombo | null {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && !e.altKey) return "cmd-shift";
  if (mod && e.altKey && !e.shiftKey) return "cmd-alt";
  if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) return "ctrl";
  if (e.altKey && !e.metaKey && !e.shiftKey && !e.ctrlKey) return "alt";
  return null;
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "select") return true;
  // Textarea: allow xterm.js and read-only Monaco (both use hidden textareas)
  if (tag === "textarea") {
    if (el.closest(".xterm")) return false; // xterm — allow badges
    if ((el as HTMLTextAreaElement).readOnly) return false; // read-only Monaco — allow badges
    return true; // editable textarea — block badges
  }
  if ((el as HTMLElement).isContentEditable) return true;
  // Monaco in edit mode: block badges. Read-only Monaco handled above via readonly textarea.
  if (el.closest(".monaco-editor") && !(el as HTMLTextAreaElement).readOnly) return true;
  return false;
}

function isModifierKey(key: string): boolean {
  return key === "Shift" || key === "Control" || key === "Meta" || key === "Alt";
}

export function useModifierHeld(): void {
  useEffect(() => {
    const store = useModifierHeldStore.getState;

    function handleKeyDown(e: KeyboardEvent) {
      if (isInputFocused()) return;
      if (!isModifierKey(e.key)) {
        // A non-modifier key was pressed (e.g., Arrow, digit, letter).
        // Check if modifier combo is still held — if so, keep badges visible.
        const combo = detectModifierCombo(e);
        if (combo && store().activeModifier === combo) {
          // Modifier still held (e.g., Cmd+Shift+Arrow) — don't cancel
          return;
        }
        // Modifier released or changed — cancel
        if (store().activeModifier) {
          store().cancelBadges();
        }
        return;
      }
      const combo = detectModifierCombo(e);
      if (!combo) return;
      if (store().activeModifier !== combo) {
        useModifierHeldStore.getState().setModifier(combo);
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (isModifierKey(e.key) && store().activeModifier) {
        store().clearModifier();
      }
    }

    function handleBlur() {
      store().cancelBadges();
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        store().cancelBadges();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      store().cancelBadges();
    };
  }, []);
}
