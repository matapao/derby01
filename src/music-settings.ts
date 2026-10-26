export type SoundMode = 'both' | 'effects' | 'music' | 'muted';
export interface SoundSettings {
  mode: SoundMode;
  effects: number;
  music: number;
  source: 'host' | 'personal';
  playlist: string;
}
export const SOUND_KEY = 'derby01:sound:v1';
export const DEFAULT_SOUND: Readonly<SoundSettings> = {
  mode: 'both',
  effects: 0.55,
  music: 0.22,
  source: 'host',
  playlist: 'random',
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function volume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}
export function readSoundSettings(value: unknown): SoundSettings {
  const o = object(value);
  return {
    mode:
      o['mode'] === undefined || o['mode'] === 'both'
        ? 'both'
        : o['mode'] === 'effects' || o['mode'] === 'music' || o['mode'] === 'muted'
          ? o['mode']
          : 'muted',
    effects: volume(o['effects'], DEFAULT_SOUND.effects),
    music: volume(o['music'], DEFAULT_SOUND.music),
    source: o['source'] === 'personal' ? 'personal' : 'host',
    playlist:
      typeof o['playlist'] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(o['playlist'])
        ? o['playlist']
        : 'random',
  };
}
export function soundLevels(settings: SoundSettings): { effects: number; music: number } {
  return {
    effects: settings.mode === 'both' || settings.mode === 'effects' ? volume(settings.effects, 0.55) : 0,
    music: settings.mode === 'both' || settings.mode === 'music' ? volume(settings.music, 0.22) : 0,
  };
}
export function loadSoundSettings(store: Pick<Storage, 'getItem'>): SoundSettings {
  try {
    return readSoundSettings(JSON.parse(store.getItem(SOUND_KEY) ?? 'null') as unknown);
  } catch {
    return { ...DEFAULT_SOUND };
  }
}
