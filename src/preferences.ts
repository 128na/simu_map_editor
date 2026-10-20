/** Map-independent preferences only; terrain and compatibility settings belong to the map. */
export interface Preferences {
  version: 1;
  tool: 'raise' | 'lower' | 'flatten' | 'smooth';
  radius: number;
  amount: number;
  view: 'oblique' | 'top';
  grid?: boolean;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  version: 1, tool: 'raise', radius: 8, amount: 1, view: 'oblique',
});
const STORAGE_KEY = 'simu-map-editor.preferences';

function normalize(value: unknown): Preferences {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) {
    return {...DEFAULT_PREFERENCES};
  }
  const candidate = value as Record<string, unknown>;
  const integer = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    version: 1,
    tool: candidate.tool === 'raise' || candidate.tool === 'lower' || candidate.tool === 'flatten' || candidate.tool === 'smooth'
      ? candidate.tool : DEFAULT_PREFERENCES.tool,
    radius: integer(candidate.radius, 1, 40, DEFAULT_PREFERENCES.radius),
    amount: integer(candidate.amount, 1, 8, DEFAULT_PREFERENCES.amount),
    ...(typeof candidate.grid==='boolean'?{grid:candidate.grid}:{}),
    view: candidate.view === 'oblique' || candidate.view === 'top' ? candidate.view : DEFAULT_PREFERENCES.view,
  };
}

/** Missing, inaccessible or corrupt browser storage never prevents editing. */
export function loadPreferences(storage?: Pick<Storage, 'getItem'>): Preferences {
  try {
    const serialized = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
    return serialized === null ? {...DEFAULT_PREFERENCES} : normalize(JSON.parse(serialized));
  } catch {
    return {...DEFAULT_PREFERENCES};
  }
}

export function savePreferences(preferences: Preferences, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify(normalize(preferences)));
  } catch {
    // Preference retention is optional, including when the storage quota is exhausted.
  }
}
