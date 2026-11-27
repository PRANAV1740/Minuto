/**
 * The handful of choices the user gets, kept in `chrome.storage.local` so the
 * content script and the side panel agree without passing messages about it.
 *
 * Both default to on, which is the whole feature: captions get switched on
 * because Minuto needs them, and hidden because nobody wants a band of
 * subtitles across their call for an hour.
 */

export type Settings = {
  /** Switch Meet's captions on by itself when they are off. */
  autoCaptions: boolean;
  /** Keep the caption panel out of view while it keeps updating. */
  hideCaptions: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  autoCaptions: true,
  hideCaptions: true,
};

const STORAGE_KEY = 'minuto:settings';

/**
 * Reads stored settings defensively.
 *
 * Anything missing, misshapen or left over from an older version falls back to
 * the default rather than being trusted — a string where a boolean belongs
 * would otherwise make `if (settings.hideCaptions)` quietly true.
 */
export function withDefaults(stored: unknown): Settings {
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_SETTINGS };

  const source = stored as Record<string, unknown>;
  const pick = (key: keyof Settings): boolean =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : DEFAULT_SETTINGS[key];

  return {
    autoCaptions: pick('autoCaptions'),
    hideCaptions: pick('hideCaptions'),
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const bag = await chrome.storage.local.get(STORAGE_KEY);
    return withDefaults(bag[STORAGE_KEY]);
  } catch {
    // A storage failure should not stop the extension working; the defaults
    // are the behaviour we want anyway.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

/** Calls back whenever the settings change, including from the other context. */
export function onSettingsChange(listener: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    listener(withDefaults(change.newValue));
  });
}
