import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useModifierHeldStore } from "../modifier-held";

describe("modifier-held store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useModifierHeldStore.getState().cancelBadges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with null activeModifier and visible false", () => {
    const state = useModifierHeldStore.getState();
    expect(state.activeModifier).toBeNull();
    expect(state.visible).toBe(false);
  });

  it("sets activeModifier on setModifier", () => {
    useModifierHeldStore.getState().setModifier("cmd-shift");
    expect(useModifierHeldStore.getState().activeModifier).toBe("cmd-shift");
    expect(useModifierHeldStore.getState().visible).toBe(false);
  });

  it("becomes visible after 100ms delay", () => {
    useModifierHeldStore.getState().setModifier("cmd-shift");
    vi.advanceTimersByTime(99);
    expect(useModifierHeldStore.getState().visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(useModifierHeldStore.getState().visible).toBe(true);
  });

  it("clearModifier fades out: visible false immediately, activeModifier null after 150ms", () => {
    useModifierHeldStore.getState().setModifier("ctrl");
    vi.advanceTimersByTime(100);
    expect(useModifierHeldStore.getState().visible).toBe(true);
    useModifierHeldStore.getState().clearModifier();
    expect(useModifierHeldStore.getState().visible).toBe(false);
    expect(useModifierHeldStore.getState().activeModifier).toBe("ctrl");
    vi.advanceTimersByTime(150);
    expect(useModifierHeldStore.getState().activeModifier).toBeNull();
  });

  it("cancelBadges cancels pending timer", () => {
    useModifierHeldStore.getState().setModifier("alt");
    useModifierHeldStore.getState().cancelBadges();
    vi.advanceTimersByTime(200);
    expect(useModifierHeldStore.getState().visible).toBe(false);
    expect(useModifierHeldStore.getState().activeModifier).toBeNull();
  });

  it("changing modifier resets the timer", () => {
    useModifierHeldStore.getState().setModifier("cmd-shift");
    vi.advanceTimersByTime(50);
    useModifierHeldStore.getState().setModifier("ctrl");
    vi.advanceTimersByTime(50);
    expect(useModifierHeldStore.getState().visible).toBe(false);
    vi.advanceTimersByTime(50);
    expect(useModifierHeldStore.getState().visible).toBe(true);
    expect(useModifierHeldStore.getState().activeModifier).toBe("ctrl");
  });
});
