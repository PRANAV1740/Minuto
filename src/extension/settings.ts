/**
 * The handful of choices the user gets, kept in `chrome.storage.local` so the
 * content script and the side panel agree without passing messages about it.
 *
 * Auto-enabling captions defaults to **off**.
 *
 * It was on, on the reasoning that Minuto needs captions for speaker names.
 * Tried in a real call, Meet's captions turned out to be too inaccurate on
 * Hinglish to be worth switching on at all — and a tool that reaches into
 * someone's meeting to turn on a feature they do not want is wrong even when
 * the feature is local to them. Minuto transcribes the call's audio itself;
 * captions are now an optional extra that only adds speaker names.
 *
 * Hiding stays on, because it costs nothing and only acts when a caption
 * region exists — which, with auto-enable off, is only when the user has
 * switched captions on themselves.
 */

export type Settings = {
  /**
   * Switch Meet's captions on by itself when they are off.
   *
   * Off by default. Minuto does not need captions — it transcribes the audio
   * — and they only add speaker names, at the cost of a feature the user did
   * not ask for being switched on in their meeting.
   */
  autoCaptions: boolean;
  /** Keep the caption panel out of view while it keeps updating. */
  hideCaptions: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  autoCaptions: false,
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
