export type AppearancePreference = "system" | "light" | "dark";

const STORAGE_KEY = "patchdeck.appearance";
let currentPreference = readSavedPreference();

function readSavedPreference(): AppearancePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function getAppearancePreference() {
  return currentPreference;
}

export function setAppearancePreference(preference: AppearancePreference) {
  currentPreference = preference;
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // The choice still applies for this session if storage is unavailable.
  }
  applyAppearance(preference);
}

export function initializeAppearance() {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const update = () => applyAppearance(getAppearancePreference(), media?.matches);
  update();
  media?.addEventListener?.("change", update);
  return () => media?.removeEventListener?.("change", update);
}

function applyAppearance(preference: AppearancePreference, systemDark?: boolean) {
  const dark = systemDark ?? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const appearance = preference === "system" ? (dark ? "dark" : "light") : preference;
  document.documentElement.dataset.appearance = appearance;
  document.documentElement.style.colorScheme = appearance;
}
