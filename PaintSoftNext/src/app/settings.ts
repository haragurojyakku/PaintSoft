import type { BrushSettings, StabilizerSettings } from '../engine/StrokeBuilder';

export interface BrushPreset {
  name: string;
  brush: BrushSettings;
}

export interface GlobalSettings {
  stabilizer: StabilizerSettings;
  pressureEnabled: boolean;
  color: string;
  bgColor: string;
}

export const DEFAULT_BRUSH: BrushSettings = {
  size: 24,
  sizeMinPercent: 10,
  sizeMaxPercent: 100,
  sizePressureEnabled: true,
  opacity: 100,
  opacityMinPercent: 0,
  opacityMaxPercent: 100,
  opacityPressureEnabled: true,
  blur: 0,
  spacingPercent: 15,
  sizeUnit: 'document',
  buildup: false,
};

export const DEFAULT_GLOBAL: GlobalSettings = {
  stabilizer: { positionStrength: 0, pressureStrength: 0 },
  pressureEnabled: true,
  color: '#111111',
  bgColor: '#ffffff',
};

const BRUSH_KEY = 'paintsoft.v2.brush';
const PRESETS_KEY = 'paintsoft.v2.presets';
const GLOBAL_KEY = 'paintsoft.v2.global';

/**
 * Settings persistence, keyed separately from v1's storage so both versions can be run on
 * the same machine without one stomping the other's preferences.
 *
 * Everything read back is merged onto the defaults rather than trusted as-is: stored
 * settings outlive code changes, and a field this build added would otherwise come back
 * undefined and quietly break the brush maths.
 */
export function loadBrush(): BrushSettings {
  return { ...DEFAULT_BRUSH, ...readJson<Partial<BrushSettings>>(BRUSH_KEY) };
}

export function saveBrush(brush: BrushSettings): void {
  writeJson(BRUSH_KEY, brush);
}

export function loadGlobal(): GlobalSettings {
  const stored = readJson<Partial<GlobalSettings>>(GLOBAL_KEY);
  return {
    ...DEFAULT_GLOBAL,
    ...stored,
    stabilizer: { ...DEFAULT_GLOBAL.stabilizer, ...stored?.stabilizer },
  };
}

export function saveGlobal(global: GlobalSettings): void {
  writeJson(GLOBAL_KEY, global);
}

export function loadPresets(): BrushPreset[] {
  const stored = readJson<BrushPreset[]>(PRESETS_KEY);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((preset) => preset && typeof preset.name === 'string')
    .map((preset) => ({ name: preset.name, brush: { ...DEFAULT_BRUSH, ...preset.brush } }));
}

export function savePresets(presets: readonly BrushPreset[]): void {
  writeJson(PRESETS_KEY, presets);
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    // Private-browsing modes and corrupt entries both land here; defaults are fine.
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage being unavailable or full must never interrupt drawing.
  }
}
