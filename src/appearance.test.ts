import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("appearance", () => {
  let media: MediaQueryList;
  let changeListeners: Set<() => void>;

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete document.documentElement.dataset.appearance;
    changeListeners = new Set();
    media = {
      matches: false,
      addEventListener: vi.fn((_event: string, listener: () => void) => changeListeners.add(listener)),
      removeEventListener: vi.fn((_event: string, listener: () => void) => changeListeners.delete(listener)),
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(() => media));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function changeSystemAppearance(dark: boolean) {
    Object.defineProperty(media, "matches", { value: dark, configurable: true });
    changeListeners.forEach((listener) => listener());
  }

  it("follows the system immediately, follows changes, and removes its listener", async () => {
    const { initializeAppearance, getAppearancePreference } = await import("./appearance");
    const dispose = initializeAppearance();
    expect(getAppearancePreference()).toBe("system");
    expect(document.documentElement.dataset.appearance).toBe("light");

    changeSystemAppearance(true);
    expect(document.documentElement.dataset.appearance).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    dispose();
    expect(changeListeners.size).toBe(0);
    changeSystemAppearance(false);
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("keeps an explicit choice through OS changes and restores it on launch", async () => {
    const appearance = await import("./appearance");
    const dispose = appearance.initializeAppearance();
    appearance.setAppearancePreference("dark");
    changeSystemAppearance(false);
    expect(document.documentElement.dataset.appearance).toBe("dark");
    expect(localStorage.getItem("patchdeck.appearance")).toBe("dark");
    dispose();

    vi.resetModules();
    delete document.documentElement.dataset.appearance;
    const restored = await import("./appearance");
    const disposeRestored = restored.initializeAppearance();
    expect(restored.getAppearancePreference()).toBe("dark");
    expect(document.documentElement.dataset.appearance).toBe("dark");

    restored.setAppearancePreference("system");
    expect(document.documentElement.dataset.appearance).toBe("light");
    changeSystemAppearance(true);
    expect(document.documentElement.dataset.appearance).toBe("dark");
    disposeRestored();
  });

  it("uses the system for an unrecognized saved preference", async () => {
    localStorage.setItem("patchdeck.appearance", "invalid");
    const appearance = await import("./appearance");
    expect(appearance.getAppearancePreference()).toBe("system");
  });

  it("keeps the session choice when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    const appearance = await import("./appearance");
    const dispose = appearance.initializeAppearance();
    appearance.setAppearancePreference("dark");
    changeSystemAppearance(false);
    expect(appearance.getAppearancePreference()).toBe("dark");
    expect(document.documentElement.dataset.appearance).toBe("dark");
    dispose();
  });

  it("applies a usable appearance without matchMedia", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const appearance = await import("./appearance");
    const dispose = appearance.initializeAppearance();
    expect(document.documentElement.dataset.appearance).toBe("light");
    appearance.setAppearancePreference("dark");
    expect(document.documentElement.dataset.appearance).toBe("dark");
    dispose();
  });
});
